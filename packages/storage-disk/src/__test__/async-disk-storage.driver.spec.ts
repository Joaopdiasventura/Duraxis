import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defineStorageConformanceSuite } from "@duraxis/storage-testkit";
import { AsyncDiskStorageDriver, type DiskFaultPoint } from "../async-disk-storage.driver.js";
import { DuraxisDatabase } from "@duraxis/core";

const directories: string[] = [];
const driverDirectories = new WeakMap<object, string>();
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "duraxis-disk-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

defineStorageConformanceSuite({
  name: "AsyncDiskStorageDriver",
  async createDriver() {
    const path = await directory();
    const driver = await AsyncDiskStorageDriver.open({ directory: path });
    driverDirectories.set(driver, path);
    return driver;
  },
  async destroyDriver(driver) {
    await driver.close?.();
    const path = driverDirectories.get(driver);
    if (path) await rm(path, { recursive: true, force: true });
  },
});

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (path: string) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else result.push(target);
    }
  };
  await walk(root);
  return result;
}

async function child(
  script: string,
  args: readonly string[],
): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolveChild, reject) => {
    const childProcess = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script, ...args],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    childProcess.stderr.setEncoding("utf8");
    childProcess.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    childProcess.on("error", reject);
    childProcess.on("exit", (code, signal) => resolveChild({ code, signal, stderr }));
  });
}

function builtModuleUrl(): string {
  return pathToFileURL(resolve(import.meta.dirname, "../../dist/index.js")).href;
}

function coreBuiltModuleUrl(): string {
  return pathToFileURL(resolve(import.meta.dirname, "../../../core/dist/index.js")).href;
}

describe("AsyncDiskStorageDriver persistence", () => {
  it("preserves binary objects, versions and timestamps after reopen", async () => {
    const path = await directory();
    let storage = await AsyncDiskStorageDriver.open({ directory: path });
    const binary = Uint8Array.from([0, 1, 2, 127, 128, 255]);
    const first = await storage.put("binary/value", binary, { condition: { type: "if-absent" } });
    expect(first.success).toBe(true);
    const listed = await storage.list("binary/");
    await storage.close();

    storage = await AsyncDiskStorageDriver.open({ directory: path });
    expect([...(await storage.get("binary/value"))!.data]).toEqual([...binary]);
    expect((await storage.get("binary/value"))!.version).toBe(first.success && first.version);
    expect((await storage.list("binary/"))[0]!.createdAt).toBe(listed[0]!.createdAt);
    await storage.close();
  });

  it("rejects a second owner in the same process", async () => {
    const path = await directory();
    const first = await AsyncDiskStorageDriver.open({ directory: path });
    await expect(AsyncDiskStorageDriver.open({ directory: path })).rejects.toMatchObject({
      code: "OWNERSHIP_CONFLICT",
    });
    await first.close();
  });

  it("rejects a second owner in another process", async () => {
    const path = await directory();
    const first = await AsyncDiskStorageDriver.open({ directory: path });
    const script = `
      const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
      try { await AsyncDiskStorageDriver.open({ directory: process.argv[1] }); process.exit(2); }
      catch (error) { process.exit(error?.code === "OWNERSHIP_CONFLICT" ? 0 : 3); }
    `;
    expect((await child(script, [path])).code).toBe(0);
    await first.close();
  });

  it("requires explicit recovery for an abandoned process lock", async () => {
    const path = await directory();
    const script = `
      const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
      await AsyncDiskStorageDriver.open({ directory: process.argv[1] });
      process.kill(process.pid, "SIGKILL");
    `;
    await child(script, [path]);
    await expect(AsyncDiskStorageDriver.open({ directory: path })).rejects.toMatchObject({
      code: "OWNERSHIP_CONFLICT",
    });
    await AsyncDiskStorageDriver.recoverAbandonedOwnership({
      directory: path,
      confirmation: "I_HAVE_VERIFIED_EXCLUSIVE_ACCESS",
    });
    const reopened = await AsyncDiskStorageDriver.open({ directory: path });
    await reopened.close();
  });

  it("detects physical payload corruption", async () => {
    const path = await directory();
    const storage = await AsyncDiskStorageDriver.open({ directory: path });
    await storage.put("object", encode("untampered"), { condition: { type: "if-absent" } });
    await storage.close();
    const object = (await files(join(path, "objects"))).find((file) => file.endsWith(".obj"))!;
    const bytes = await readFile(object);
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(object, bytes);
    const reopened = await AsyncDiskStorageDriver.open({ directory: path });
    await expect(reopened.get("object")).rejects.toMatchObject({ code: "CORRUPTION" });
    await reopened.close();
  });

  it("detects journal metadata corruption", async () => {
    const path = await directory();
    const storage = await AsyncDiskStorageDriver.open({ directory: path });
    await storage.put("object", encode("value"), { condition: { type: "if-absent" } });
    await storage.close();
    const journal = join(path, "journal.log");
    const bytes = await readFile(journal);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    await writeFile(journal, bytes);
    await expect(AsyncDiskStorageDriver.open({ directory: path })).rejects.toMatchObject({
      code: "CORRUPTION",
    });
  });

  it("removes incomplete temporary files during recovery", async () => {
    const path = await directory();
    const temporary = join(path, "objects", "aa", "fake", ".incomplete.tmp");
    await mkdir(dirname(temporary), { recursive: true });
    await writeFile(temporary, encode("partial"));
    const storage = await AsyncDiskStorageDriver.open({ directory: path });
    expect((await files(join(path, "objects"))).some((file) => file.endsWith(".tmp"))).toBe(false);
    await storage.close();
  });

  it("leaves no visible value when publication fails before the journal", async () => {
    const path = await directory();
    let failed = false;
    const storage = await AsyncDiskStorageDriver.open({
      directory: path,
      faultInjector(point) {
        if (!failed && point == "after-object-publish") {
          failed = true;
          throw new Error("publish fault");
        }
      },
    });
    await expect(
      storage.put("object", encode("value"), { condition: { type: "if-absent" } }),
    ).rejects.toThrow("publish fault");
    expect(await storage.get("object")).toBeNull();
    await storage.close();
    const reopened = await AsyncDiskStorageDriver.open({ directory: path });
    expect(await reopened.get("object")).toBeNull();
    await reopened.close();
  });

  it.each([
    ["after-object-sync", false],
    ["after-object-publish", false],
    ["after-object-directory-sync", false],
    ["after-journal-write", null],
    ["after-journal-sync", true],
  ] as const)(
    "recovers a real child-process crash at %s",
    async (point: DiskFaultPoint, committed: boolean | null) => {
      const path = await directory();
      const script = `
      const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
      const target = process.argv[2];
      const storage = await AsyncDiskStorageDriver.open({
        directory: process.argv[1],
        faultInjector(point) { if (point === target) process.kill(process.pid, "SIGKILL"); }
      });
      await storage.put("crash/value", new TextEncoder().encode("durable"), { condition: { type: "if-absent" } });
    `;
      const result = await child(script, [path, point]);
      expect(result.code == 0).toBe(false);
      await AsyncDiskStorageDriver.recoverAbandonedOwnership({
        directory: path,
        confirmation: "I_HAVE_VERIFIED_EXCLUSIVE_ACCESS",
      });
      const reopened = await AsyncDiskStorageDriver.open({ directory: path });
      const value = await reopened.get("crash/value");
      const recovered = value == null ? null : decode(value.data);
      if (committed == null) expect([null, "durable"]).toContain(recovered);
      else expect(recovered).toBe(committed ? "durable" : null);
      await reopened.close();
    },
  );

  it("compacts the journal without changing versions", async () => {
    const path = await directory();
    const storage = await AsyncDiskStorageDriver.open({ directory: path });
    const first = await storage.put("a", encode("1"), { condition: { type: "if-absent" } });
    if (!first.success) throw new Error("unexpected conflict");
    const second = await storage.put("a", encode("2"), {
      condition: { type: "if-version", version: first.version },
    });
    if (!second.success) throw new Error("unexpected conflict");
    await storage.compact();
    expect((await storage.get("a"))!.version).toBe(second.version);
    await storage.close();
    const reopened = await AsyncDiskStorageDriver.open({ directory: path });
    expect(decode((await reopened.get("a"))!.data)).toBe("2");
    expect((await reopened.get("a"))!.version).toBe(second.version);
    await reopened.close();
  });

  it("recovers a real child-process crash during journal rotation", async () => {
    const path = await directory();
    const setup = await AsyncDiskStorageDriver.open({ directory: path });
    await setup.put("a", encode("durable"), { condition: { type: "if-absent" } });
    await setup.close();
    const script = `
      const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
      const storage = await AsyncDiskStorageDriver.open({
        directory: process.argv[1],
        faultInjector(point) {
          if (point === "after-journal-rotation") process.kill(process.pid, "SIGKILL");
        }
      });
      await storage.compact();
    `;
    const result = await child(script, [path]);
    expect(result.code == 0).toBe(false);
    await AsyncDiskStorageDriver.recoverAbandonedOwnership({
      directory: path,
      confirmation: "I_HAVE_VERIFIED_EXCLUSIVE_ACCESS",
    });
    const reopened = await AsyncDiskStorageDriver.open({ directory: path });
    expect(decode((await reopened.get("a"))!.data)).toBe("durable");
    await reopened.close();
  });

  it("reopens a complete Duraxis database with documents and indexes", async () => {
    const path = await directory();
    let storage = await AsyncDiskStorageDriver.open({ directory: path });
    let db = new DuraxisDatabase({ storage, cursorSigningKey: new Uint8Array(32).fill(7) });
    await db.defineCollection({
      name: "users",
      fields: { email: { type: "string", required: true }, age: { type: "number" } },
      indexes: [
        { name: "email", unique: true, fields: [{ field: "email", order: "ASC" }] },
        { name: "age", unique: false, fields: [{ field: "age", order: "ASC" }] },
      ],
    });
    await db.transaction((tx) => {
      tx.putDocument("users", "1", { email: "a@example.com", age: 30 });
      tx.putDocument("users", "2", { email: "b@example.com", age: 30 });
    });
    await storage.close();

    storage = await AsyncDiskStorageDriver.open({ directory: path });
    db = new DuraxisDatabase({ storage, cursorSigningKey: new Uint8Array(32).fill(7) });
    expect((await db.getDocument("users", "1"))?.email).toBe("a@example.com");
    expect((await db.findByIndex("users", "age", 30)).map((row) => row.id)).toEqual(["1", "2"]);
    await expect(db.verifyIntegrity()).resolves.toMatchObject({ indexes: 2 });
    await storage.close();
  });

  it.each([
    ["/objects/", false],
    ["/indexes/nodes/", false],
    ["/commits/", false],
    ["/manifest", true],
  ] as const)(
    "recovers database commit crash after durable key %s",
    async (keyFragment, committed) => {
      const path = await directory();
      const setupStorage = await AsyncDiskStorageDriver.open({ directory: path });
      const setup = new DuraxisDatabase({
        storage: setupStorage,
        cursorSigningKey: new Uint8Array(32).fill(9),
      });
      await setup.defineCollection({
        name: "records",
        fields: { value: { type: "string", required: true } },
        indexes: [{ name: "value", unique: false, fields: [{ field: "value", order: "ASC" }] }],
      });
      await setupStorage.close();

      const script = `
      const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
      const { DuraxisDatabase } = await import(${JSON.stringify(coreBuiltModuleUrl())});
      const fragment = process.argv[2];
      let crashed = false;
      const storage = await AsyncDiskStorageDriver.open({
        directory: process.argv[1],
        faultInjector(point, context) {
          if (!crashed && point === "after-journal-sync" && context.key?.includes(fragment)) {
            crashed = true;
            process.kill(process.pid, "SIGKILL");
          }
        }
      });
      const db = new DuraxisDatabase({ storage, cursorSigningKey: new Uint8Array(32).fill(9) });
      await db.transaction((tx) => tx.putDocument("records", "crash", { value: "published" }));
      await storage.close();
    `;
      const result = await child(script, [path, keyFragment]);
      expect(result.code == 0).toBe(false);
      await AsyncDiskStorageDriver.recoverAbandonedOwnership({
        directory: path,
        confirmation: "I_HAVE_VERIFIED_EXCLUSIVE_ACCESS",
      });
      const storage = await AsyncDiskStorageDriver.open({ directory: path });
      const db = new DuraxisDatabase({ storage, cursorSigningKey: new Uint8Array(32).fill(9) });
      const document = await db.getDocument("records", "crash");
      expect(document?.value ?? null).toBe(committed ? "published" : null);
      await expect(db.verifyIntegrity()).resolves.toBeDefined();
      await storage.close();
    },
  );

  it("recovers a real child-process crash while GC publishes a deletion", async () => {
    const path = await directory();
    const setupStorage = await AsyncDiskStorageDriver.open({ directory: path });
    const bytes = encode("unreachable");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const orphanKey = `__duraxis/v1/objects/${randomUUID()}-${digest}`;
    const stored = await setupStorage.put(orphanKey, bytes, {
      condition: { type: "if-absent" },
    });
    expect(stored.success).toBe(true);
    await setupStorage.close();

    const script = `
      const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
      const { DuraxisDatabase } = await import(${JSON.stringify(coreBuiltModuleUrl())});
      let crashed = false;
      const storage = await AsyncDiskStorageDriver.open({
        directory: process.argv[1],
        faultInjector(point, context) {
          if (!crashed && point === "after-journal-sync" && context.operation === "delete") {
            crashed = true;
            process.kill(process.pid, "SIGKILL");
          }
        }
      });
      const db = new DuraxisDatabase({ storage });
      await db.collectGarbage(storage, {
        dryRun: false,
        exclusiveMaintenance: true,
        olderThanMs: 0,
      });
    `;
    const result = await child(script, [path]);
    expect(result.code == 0).toBe(false);

    await AsyncDiskStorageDriver.recoverAbandonedOwnership({
      directory: path,
      confirmation: "I_HAVE_VERIFIED_EXCLUSIVE_ACCESS",
    });
    const storage = await AsyncDiskStorageDriver.open({ directory: path });
    const db = new DuraxisDatabase({ storage });
    expect(await storage.get(orphanKey)).toBeNull();
    await expect(db.verifyIntegrity()).resolves.toBeDefined();
    await expect(
      db.collectGarbage(storage, {
        dryRun: false,
        exclusiveMaintenance: true,
        olderThanMs: 0,
      }),
    ).resolves.toMatchObject({ failed: 0 });
    await storage.close();
  });
});
