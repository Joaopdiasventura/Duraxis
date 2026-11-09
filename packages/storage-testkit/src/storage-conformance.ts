import { StorageDriver, WriteResult } from "@duraxis/storage";
import { beforeEach, describe, expect, it } from "vitest";

export type StorageDriverFactory = () => StorageDriver | Promise<StorageDriver>;

export interface ConformanceOptions {
  name: string;
  createDriver: StorageDriverFactory;
}

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

const createOnly = () => ({
  condition: { type: "if-absent" as const },
});

const ifVersion = (version: string) => ({
  condition: {
    type: "if-version" as const,
    version,
  },
});

function requireSuccess(result: WriteResult): string {
  if (!result.success) throw new Error(`Expected successful write: ${result.reason}`);

  expect(result.version.length).toBeGreaterThan(0);

  return result.version;
}

export function defineStorageConformanceSuite(options: ConformanceOptions): void {
  describe(`Storage conformance: ${options.name}`, () => {
    let driver: StorageDriver;

    beforeEach(async () => {
      driver = await options.createDriver();
    });

    describe("key validation", () => {
      it.each(["", " ", "\0", "users/\0/data"])("rejects invalid key %j", async (key) => {
        await expect(driver.get(key)).rejects.toMatchObject({
          code: "INVALID_KEY",
        });

        await expect(driver.put(key, encode("value"), createOnly())).rejects.toMatchObject({
          code: "INVALID_KEY",
        });

        await expect(driver.delete(key, createOnly())).rejects.toMatchObject({
          code: "INVALID_KEY",
        });
      });
    });

    describe("read operations", () => {
      it("returns null for missing objects", async () => {
        expect(await driver.get("missing")).toBeNull();
      });

      it("returns stored data and version", async () => {
        const version = requireSuccess(await driver.put("users/1", encode("Joao"), createOnly()));

        const stored = await driver.get("users/1");

        expect(stored).not.toBeNull();
        expect(decode(stored!.data)).toBe("Joao");
        expect(stored!.version).toBe(version);
      });

      it("supports empty binary values", async () => {
        await driver.put("empty", new Uint8Array(0), createOnly());

        const stored = await driver.get("empty");

        expect(stored?.data.byteLength).toBe(0);
      });
    });

    describe("conditional creation", () => {
      it("creates an absent object", async () => {
        const result = await driver.put("users/1", encode("first"), createOnly());

        expect(result.success).toBe(true);
      });

      it("rejects duplicate creation", async () => {
        await driver.put("users/1", encode("first"), createOnly());

        const result = await driver.put("users/1", encode("second"), createOnly());

        expect(result).toEqual({
          success: false,
          reason: "conflict",
        });

        const stored = await driver.get("users/1");

        expect(decode(stored!.data)).toBe("first");
      });
    });

    describe("compare-and-swap", () => {
      it("updates using the current version", async () => {
        const version = requireSuccess(await driver.put("users/1", encode("first"), createOnly()));

        const updated = await driver.put("users/1", encode("second"), ifVersion(version));

        const newVersion = requireSuccess(updated);

        expect(newVersion).not.toBe(version);

        const stored = await driver.get("users/1");

        expect(decode(stored!.data)).toBe("second");
        expect(stored!.version).toBe(newVersion);
      });

      it("rejects stale versions", async () => {
        const version = requireSuccess(await driver.put("users/1", encode("first"), createOnly()));

        requireSuccess(await driver.put("users/1", encode("second"), ifVersion(version)));

        const result = await driver.put("users/1", encode("third"), ifVersion(version));

        expect(result).toEqual({
          success: false,
          reason: "conflict",
        });

        const stored = await driver.get("users/1");

        expect(decode(stored!.data)).toBe("second");
      });

      it("rejects updates of missing objects", async () => {
        const result = await driver.put("missing", encode("value"), ifVersion("unknown"));

        expect(result).toEqual({
          success: false,
          reason: "conflict",
        });
      });
    });

    describe("conditional deletion", () => {
      it("deletes using the current version", async () => {
        const version = requireSuccess(await driver.put("users/1", encode("value"), createOnly()));

        const result = await driver.delete("users/1", ifVersion(version));

        expect(result).toEqual({ success: true });
        expect(await driver.get("users/1")).toBeNull();
      });

      it("rejects stale deletion", async () => {
        await driver.put("users/1", encode("value"), createOnly());

        const result = await driver.delete("users/1", ifVersion("invalid"));

        expect(result).toEqual({
          success: false,
          reason: "conflict",
        });

        expect(await driver.get("users/1")).not.toBeNull();
      });

      it("supports if-absent deletion semantics", async () => {
        expect(await driver.delete("missing", createOnly())).toEqual({ success: true });

        await driver.put("existing", encode("value"), createOnly());

        expect(await driver.delete("existing", createOnly())).toEqual({
          success: false,
          reason: "conflict",
        });
      });

      it("does not reuse a deleted version", async () => {
        const oldVersion = requireSuccess(await driver.put("object", encode("old"), createOnly()));

        await driver.delete("object", ifVersion(oldVersion));

        const newVersion = requireSuccess(await driver.put("object", encode("new"), createOnly()));

        expect(newVersion).not.toBe(oldVersion);

        const staleUpdate = await driver.put("object", encode("corrupted"), ifVersion(oldVersion));

        expect(staleUpdate.success).toBe(false);
        expect(decode((await driver.get("object"))!.data)).toBe("new");
      });
    });

    describe("binary isolation", () => {
      it("copies input data", async () => {
        const input = encode("hello");

        await driver.put("data", input, createOnly());

        input[0] = 0;

        const stored = await driver.get("data");

        expect(decode(stored!.data)).toBe("hello");
      });

      it("returns independent byte arrays", async () => {
        await driver.put("data", encode("hello"), createOnly());

        const first = await driver.get("data");

        first!.data[0] = 0;

        const second = await driver.get("data");

        expect(decode(second!.data)).toBe("hello");
      });
    });

    describe("concurrency", () => {
      it("allows only one concurrent creation", async () => {
        const results = await Promise.all(
          Array.from({ length: 100 }, (_, index) =>
            driver.put("shared", encode(`value-${index}`), createOnly()),
          ),
        );

        const successful = results.filter((r) => r.success);

        expect(successful).toHaveLength(1);
        expect(results).toHaveLength(100);
        expect(results.filter((r) => !r.success)).toHaveLength(99);

        const stored = await driver.get("shared");

        expect(stored).not.toBeNull();
        expect(stored!.version).toBe(successful[0]!.version);
      });

      it("allows only one concurrent CAS", async () => {
        const version = requireSuccess(await driver.put("shared", encode("initial"), createOnly()));

        const results = await Promise.all(
          Array.from({ length: 100 }, (_, index) =>
            driver.put("shared", encode(`update-${index}`), ifVersion(version)),
          ),
        );

        expect(results.filter((r) => r.success)).toHaveLength(1);

        expect(results.filter((r) => !r.success)).toHaveLength(99);

        const stored = await driver.get("shared");

        expect(stored).not.toBeNull();
        expect(decode(stored!.data)).toMatch(/^update-\d+$/);
      });

      it("allows only one CAS or deletion", async () => {
        const version = requireSuccess(await driver.put("shared", encode("initial"), createOnly()));

        const [update, deletion] = await Promise.all([
          driver.put("shared", encode("updated"), ifVersion(version)),
          driver.delete("shared", ifVersion(version)),
        ]);

        expect(Number(update.success) + Number(deletion.success)).toBe(1);

        const stored = await driver.get("shared");

        if (update.success) {
          expect(decode(stored!.data)).toBe("updated");
          expect(stored!.version).toBe(update.version);
        } else expect(stored).toBeNull();
      });
    });

    describe("object listing", () => {
      it("returns an empty list for unmatched prefixes", async () => {
        expect(await driver.list("missing/")).toEqual([]);
      });

      it("lists only objects matching the prefix", async () => {
        await driver.put("users/1", encode("first"), createOnly());

        await driver.put("users/2", encode("second"), createOnly());

        await driver.put("accounts/1", encode("third"), createOnly());

        const objects = await driver.list("users/");

        expect(objects.map((item) => item.key)).toEqual(["users/1", "users/2"]);
      });

      it("returns object versions and creation timestamps", async () => {
        const result = await driver.put("records/1", encode("value"), createOnly());

        if (!result.success) {
          throw new Error("Unexpected creation conflict");
        }

        const objects = await driver.list("records/");

        expect(objects).toHaveLength(1);
        expect(objects[0]!.version).toBe(result.version);

        expect(Number.isSafeInteger(objects[0]!.createdAt)).toBe(true);
      });

      it("does not return binary payloads", async () => {
        await driver.put("users/1", encode("secret"), createOnly());

        const objects = await driver.list("users/");

        expect(Object.keys(objects[0]!).sort()).toEqual(["createdAt", "key", "version"]);
      });

      it("does not list deleted objects", async () => {
        const version = requireSuccess(
          await driver.put("records/1", encode("value"), createOnly()),
        );

        await driver.delete("records/1", ifVersion(version));

        expect(await driver.list("records/")).toEqual([]);
      });

      it("returns the latest object version", async () => {
        const first = requireSuccess(await driver.put("records/1", encode("first"), createOnly()));

        const second = requireSuccess(
          await driver.put("records/1", encode("second"), ifVersion(first)),
        );

        const objects = await driver.list("records/");

        expect(objects[0]!.version).toBe(second);
      });

      it("supports listing all objects", async () => {
        await driver.put("a", encode("1"), createOnly());
        await driver.put("b", encode("2"), createOnly());

        const objects = await driver.list("");

        expect(objects.map((item) => item.key)).toEqual(["a", "b"]);
      });

      it("rejects prefixes containing null bytes", async () => {
        await expect(driver.list("records/\0")).rejects.toThrow();
      });
    });
  });
}
