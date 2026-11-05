import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "../memory-storage.driver.js";

describe("MemoryStorageDriver", () => {
  let driver: MemoryStorageDriver;

  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

  const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

  beforeEach(() => {
    driver = new MemoryStorageDriver();
  });

  describe("get", () => {
    it("returns null for missing objects", async () => {
      expect(await driver.get("missing")).toBeNull();
    });

    it("returns the stored object", async () => {
      const result = await driver.put("users/1", encode("Joao"), {
        condition: { type: "if-absent" },
      });

      expect(result.success).toBe(true);

      const stored = await driver.get("users/1");

      expect(stored).not.toBeNull();
      expect(decode(stored!.data)).toBe("Joao");

      if (result.success) expect(stored!.version).toBe(result.version);
    });

    it("rejects invalid keys", async () => {
      await expect(driver.get("")).rejects.toMatchObject({
        code: "INVALID_KEY",
      });
    });
  });

  describe("put", () => {
    it("creates an object when the key is absent", async () => {
      const result = await driver.put("users/1", encode("first"), {
        condition: { type: "if-absent" },
      });

      expect(result.success).toBe(true);
    });

    it("rejects duplicate creation", async () => {
      const options = {
        condition: { type: "if-absent" as const },
      };

      await driver.put("users/1", encode("first"), options);

      const result = await driver.put("users/1", encode("second"), options);

      expect(result).toEqual({
        success: false,
        reason: "conflict",
      });

      const stored = await driver.get("users/1");
      expect(decode(stored!.data)).toBe("first");
    });

    it("updates an object with the correct version", async () => {
      const initial = await driver.put("users/1", encode("first"), {
        condition: { type: "if-absent" },
      });

      if (!initial.success) throw new Error("Initial write failed");

      const updated = await driver.put("users/1", encode("second"), {
        condition: {
          type: "if-version",
          version: initial.version,
        },
      });

      expect(updated.success).toBe(true);

      const stored = await driver.get("users/1");
      expect(decode(stored!.data)).toBe("second");

      if (updated.success) expect(updated.version).not.toBe(initial.version);
    });

    it("rejects stale versions", async () => {
      const initial = await driver.put("users/1", encode("first"), {
        condition: { type: "if-absent" },
      });

      if (!initial.success) throw new Error("Initial write failed");

      const options = {
        condition: {
          type: "if-version" as const,
          version: initial.version,
        },
      };

      await driver.put("users/1", encode("second"), options);

      const result = await driver.put("users/1", encode("third"), options);

      expect(result).toEqual({
        success: false,
        reason: "conflict",
      });
    });

    it("does not reuse versions after deletion", async () => {
      const first = await driver.put("users/1", encode("first"), {
        condition: { type: "if-absent" },
      });

      if (!first.success) throw new Error("Initial write failed");

      await driver.delete("users/1", {
        condition: {
          type: "if-version",
          version: first.version,
        },
      });

      const second = await driver.put("users/1", encode("second"), {
        condition: { type: "if-absent" },
      });

      expect(second.success).toBe(true);

      if (second.success) expect(second.version).not.toBe(first.version);
    });
  });

  describe("delete", () => {
    it("deletes an object with the correct version", async () => {
      const initial = await driver.put("users/1", encode("first"), {
        condition: { type: "if-absent" },
      });

      if (!initial.success) throw new Error("Initial write failed");

      const result = await driver.delete("users/1", {
        condition: {
          type: "if-version",
          version: initial.version,
        },
      });

      expect(result).toEqual({ success: true });
      expect(await driver.get("users/1")).toBeNull();
    });

    it("rejects deletion with a stale version", async () => {
      await driver.put("users/1", encode("first"), { condition: { type: "if-absent" } });

      const result = await driver.delete("users/1", {
        condition: {
          type: "if-version",
          version: "invalid-version",
        },
      });

      expect(result).toEqual({
        success: false,
        reason: "conflict",
      });

      expect(await driver.get("users/1")).not.toBeNull();
    });

    it("accepts if-absent when the key is missing", async () => {
      const result = await driver.delete("missing", {
        condition: { type: "if-absent" },
      });

      expect(result).toEqual({ success: true });
    });

    it("rejects if-absent when the key exists", async () => {
      await driver.put("users/1", encode("first"), { condition: { type: "if-absent" } });

      const result = await driver.delete("users/1", {
        condition: { type: "if-absent" },
      });

      expect(result).toEqual({
        success: false,
        reason: "conflict",
      });
    });
  });

  describe("data isolation", () => {
    it("copies input bytes before storing", async () => {
      const input = encode("hello");

      await driver.put("data", input, {
        condition: { type: "if-absent" },
      });

      input[0] = 0;

      const stored = await driver.get("data");

      expect(decode(stored!.data)).toBe("hello");
    });

    it("returns independent copies of stored bytes", async () => {
      await driver.put("data", encode("hello"), {
        condition: { type: "if-absent" },
      });

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
          driver.put("shared", encode(`value-${index}`), {
            condition: { type: "if-absent" },
          }),
        ),
      );

      expect(results.filter((r) => r.success)).toHaveLength(1);

      expect(results.filter((r) => !r.success)).toHaveLength(99);
    });

    it("allows only one update for the same version", async () => {
      const initial = await driver.put("shared", encode("initial"), {
        condition: { type: "if-absent" },
      });

      if (!initial.success) throw new Error("Initial write failed");

      const results = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          driver.put("shared", encode(`update-${index}`), {
            condition: {
              type: "if-version",
              version: initial.version,
            },
          }),
        ),
      );

      expect(results.filter((r) => r.success)).toHaveLength(1);

      expect(results.filter((r) => !r.success)).toHaveLength(99);
    });
  });
});
