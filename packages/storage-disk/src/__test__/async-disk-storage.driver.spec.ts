import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
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

function interactiveChild(
  script: string,
  args: readonly string[],
): {
  readonly process: ChildProcessWithoutNullStreams;
  readonly firstLine: Promise<string>;
  readonly exit: Promise<{ code: number | null; stderr: string }>;
} {
  const childProcess = spawn(process.execPath, ["--input-type=module", "--eval", script, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  childProcess.stdout.setEncoding("utf8");
  childProcess.stderr.setEncoding("utf8");
  childProcess.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const firstLine = new Promise<string>((resolveLine, reject) => {
    const onData = (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      childProcess.stdout.off("data", onData);
      resolveLine(stdout.slice(0, newline));
    };
    childProcess.stdout.on("data", onData);
    childProcess.on("error", reject);
    childProcess.on("close", () => {
      if (!stdout.includes("\n"))
        reject(new Error(`Child exited before reporting ownership: ${stderr}`));
    });
  });
  const exit = new Promise<{ code: number | null; stderr: string }>((resolveExit, reject) => {
    childProcess.on("error", reject);
    childProcess.on("close", (code) => resolveExit({ code, stderr }));
  });
  return { process: childProcess, firstLine, exit };
}

function ownerLock(
  overrides: Partial<{
    ownerId: string;
    pid: number;
    hostname: string;
    createdAt: number;
    applicationId: string | null;
    processIdentity: string;
  }> = {},
): string {
  const payload = {
    format: 2 as const,
    ownerId: overrides.ownerId ?? randomUUID(),
    pid: overrides.pid ?? 2_147_483_647,
    hostname: overrides.hostname ?? hostname(),
    createdAt: overrides.createdAt ?? Date.now(),
    applicationId: overrides.applicationId ?? "duraxis-tests",
    processIdentity: overrides.processIdentity ?? "linux:pid:[invalid]",
  };
  return JSON.stringify({
    ...payload,
    checksum: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  });
}

async function linuxProcessIdentity(): Promise<string> {
  const { readlink } = await import("node:fs/promises");
  return `linux:${await readlink("/proc/self/ns/pid")}`;
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

  it("validates ownership recovery application identifiers", async () => {
    const path = await directory();
    await expect(
      AsyncDiskStorageDriver.open({
        directory: path,
        ownershipRecovery: { mode: "manual", applicationId: "invalid application id" },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it.skipIf(process.platform == "linux")(
    "fails closed when dead-process recovery is unsupported",
    async () => {
      const path = await directory();
      await expect(
        AsyncDiskStorageDriver.open({
          directory: path,
          ownershipRecovery: { mode: "dead-process", applicationId: "duraxis-tests" },
        }),
      ).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
    },
  );

  it.skipIf(process.platform != "linux")(
    "automatically recovers a terminated owner and preserves database integrity",
    async () => {
      const path = await directory();
      const script = `
        const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
        const { DuraxisDatabase } = await import(${JSON.stringify(coreBuiltModuleUrl())});
        const storage = await AsyncDiskStorageDriver.open({
          directory: process.argv[1],
          ownershipRecovery: { mode: "dead-process", applicationId: "duraxis-tests" },
        });
        const database = new DuraxisDatabase({ storage });
        await database.defineCollection({
          name: "automatic_recovery",
          fields: { value: { type: "string", required: true } },
          indexes: [],
        });
        await database.transaction((transaction) => {
          transaction.putDocument("automatic_recovery", "1", { value: "persisted" });
        });
        process.kill(process.pid, "SIGKILL");
      `;
      expect((await child(script, [path])).code).not.toBe(0);

      const storage = await AsyncDiskStorageDriver.open({
        directory: path,
        ownershipRecovery: { mode: "dead-process", applicationId: "duraxis-tests" },
      });
      const database = new DuraxisDatabase({ storage });
      expect((await database.getDocument("automatic_recovery", "1"))?.value).toBe("persisted");
      await expect(database.verifyIntegrity()).resolves.toBeDefined();
      await storage.close();
    },
  );

  it.skipIf(process.platform != "linux")(
    "never displaces a live owner with the same application identity",
    async () => {
      const path = await directory();
      const first = await AsyncDiskStorageDriver.open({
        directory: path,
        ownershipRecovery: { mode: "dead-process", applicationId: "duraxis-tests" },
      });
      const script = `
        const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
        try {
          await AsyncDiskStorageDriver.open({
            directory: process.argv[1],
            ownershipRecovery: { mode: "dead-process", applicationId: "duraxis-tests" },
          });
          process.exit(2);
        } catch (error) {
          process.exit(error?.code === "OWNERSHIP_CONFLICT" ? 0 : 3);
        }
      `;
      expect((await child(script, [path])).code).toBe(0);
      await first.close();
    },
  );

  it.skipIf(process.platform != "linux")(
    "rejects a dead lock from a different application identity",
    async () => {
      const path = await directory();
      const script = `
        const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
        await AsyncDiskStorageDriver.open({
          directory: process.argv[1],
          ownershipRecovery: { mode: "dead-process", applicationId: "application-a" },
        });
        process.kill(process.pid, "SIGKILL");
      `;
      await child(script, [path]);
      await expect(
        AsyncDiskStorageDriver.open({
          directory: path,
          ownershipRecovery: { mode: "dead-process", applicationId: "application-b" },
        }),
      ).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
      await AsyncDiskStorageDriver.recoverAbandonedOwnership({
        directory: path,
        confirmation: "I_HAVE_VERIFIED_EXCLUSIVE_ACCESS",
      });
    },
  );

  it.skipIf(process.platform != "linux")(
    "allows exactly one simultaneous automatic recovery attempt to acquire ownership",
    async () => {
      const path = await directory();
      const crash = `
        const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
        await AsyncDiskStorageDriver.open({
          directory: process.argv[1],
          ownershipRecovery: { mode: "dead-process", applicationId: "duraxis-tests" },
        });
        process.kill(process.pid, "SIGKILL");
      `;
      await child(crash, [path]);
      const contender = `
        const { AsyncDiskStorageDriver } = await import(${JSON.stringify(builtModuleUrl())});
        try {
          const storage = await AsyncDiskStorageDriver.open({
            directory: process.argv[1],
            ownershipRecovery: { mode: "dead-process", applicationId: "duraxis-tests" },
          });
          process.stdout.write("acquired\\n");
          await new Promise((resolve) => process.stdin.once("data", resolve));
          await storage.close();
          process.exit(0);
        } catch (error) {
          process.stdout.write("conflict:" + (error?.code ?? "unknown") + "\\n");
          process.exit(error?.code === "OWNERSHIP_CONFLICT" ? 2 : 3);
        }
      `;
      const first = interactiveChild(contender, [path]);
      const second = interactiveChild(contender, [path]);
      const contenders = [first, second];
      try {
        const lines = await Promise.all(contenders.map((contender) => contender.firstLine));
        expect(lines.filter((line) => line == "acquired")).toHaveLength(1);
        expect(lines.filter((line) => line == "conflict:OWNERSHIP_CONFLICT")).toHaveLength(1);
        // Only the owner waits for input; the rejected contender exits without reading stdin.
        for (const [index, contender] of contenders.entries()) {
          if (lines[index] == "acquired") contender.process.stdin.end("release\n");
        }
        const exits = await Promise.all(contenders.map((contender) => contender.exit));
        expect(exits.map(({ code }) => code).sort()).toEqual([0, 2]);
      } finally {
        for (const contender of contenders) {
          if (contender.process.exitCode == null && contender.process.signalCode == null)
            contender.process.kill();
        }
        await Promise.all(contenders.map((contender) => contender.exit));
      }

      const reopened = await AsyncDiskStorageDriver.open({
        directory: path,
        ownershipRecovery: { mode: "dead-process", applicationId: "duraxis-tests" },
      });
      await reopened.close();
    },
  );

  it.skipIf(process.platform != "linux")(
    "fails closed for invalid, corrupted, live-PID, foreign-host, and foreign-namespace locks",
    async () => {
      const identity = await linuxProcessIdentity();
      const corruptedRecord = JSON.parse(ownerLock({ processIdentity: identity })) as {
        checksum: string;
      };
      corruptedRecord.checksum = `${corruptedRecord.checksum.startsWith("0") ? "1" : "0"}${corruptedRecord.checksum.slice(1)}`;
      const cases = [
        '{"format":2',
        JSON.stringify(corruptedRecord),
        ownerLock({ pid: process.pid, processIdentity: identity }),
        ownerLock({ hostname: "different-host.invalid", processIdentity: identity }),
        ownerLock({ processIdentity: "linux:pid:[1]" }),
      ];
      for (const contents of cases) {
        const path = await directory();
        const lockPath = join(path, ".duraxis-owner.lock");
        await writeFile(lockPath, contents);
        await expect(
          AsyncDiskStorageDriver.open({
            directory: path,
            ownershipRecovery: { mode: "dead-process", applicationId: "duraxis-tests" },
          }),
        ).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
        expect(await readFile(lockPath, "utf8")).toBe(contents);
      }
    },
  );

  it("does not reclaim an existing recovery guard", async () => {
    const path = await directory();
    const guard = join(path, ".duraxis-owner.recovery");
    await writeFile(guard, "incomplete recovery");
    await expect(AsyncDiskStorageDriver.open({ directory: path })).rejects.toMatchObject({
      code: "OWNERSHIP_CONFLICT",
    });
    expect(await readFile(guard, "utf8")).toBe("incomplete recovery");
  });

  it("keeps legacy format locks manual-only", async () => {
    const path = await directory();
    const payload = {
      format: 1 as const,
      ownerId: randomUUID(),
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: Date.now(),
    };
    await writeFile(
      join(path, ".duraxis-owner.lock"),
      JSON.stringify({
        ...payload,
        checksum: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      }),
    );
    await expect(AsyncDiskStorageDriver.open({ directory: path })).rejects.toMatchObject({
      code: "OWNERSHIP_CONFLICT",
    });
    if (process.platform == "linux")
      await expect(
        AsyncDiskStorageDriver.open({
          directory: path,
          ownershipRecovery: { mode: "dead-process", applicationId: "duraxis-tests" },
        }),
      ).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
    await AsyncDiskStorageDriver.recoverAbandonedOwnership({
      directory: path,
      confirmation: "I_HAVE_VERIFIED_EXCLUSIVE_ACCESS",
    });
    const storage = await AsyncDiskStorageDriver.open({ directory: path });
    await storage.close();
  });

  it("shares concurrent close attempts and permits a safe release retry", async () => {
    const path = await directory();
    const storage = await AsyncDiskStorageDriver.open({ directory: path });
    const lockPath = join(path, ".duraxis-owner.lock");
    const validLock = await readFile(lockPath, "utf8");
    await writeFile(lockPath, `${validLock.slice(0, -1)}0`);
    const results = await Promise.allSettled([storage.close(), storage.close()]);
    expect(results.every((result) => result.status == "rejected")).toBe(true);
    await writeFile(lockPath, validLock);
    await expect(storage.close()).resolves.toBeUndefined();
    await expect(storage.close()).resolves.toBeUndefined();
    const reopened = await AsyncDiskStorageDriver.open({ directory: path });
    await Promise.all([reopened.close(), reopened.close(), reopened.close()]);
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
    await expect(readFile(join(path, ".duraxis-owner.lock"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
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
