import { describe, expect, it } from "vitest";
import { StorageError } from "../../errors/storage.error.js";
import { assertStorageKey } from "../assert-storage-key.js";

describe("assertStorageKey", () => {
  it("accepts a valid key", () => {
    expect(() => assertStorageKey("users/123.json")).not.toThrow();
  });

  it.each(["", " ", "   ", "\0", "users/\0/data"])("rejects invalid key %j", (key) => {
    expect(() => assertStorageKey(key)).toThrow(StorageError);
  });

  it("uses INVALID_KEY as error code", () => {
    expect(() => assertStorageKey("")).toThrow(
      expect.objectContaining({
        code: "INVALID_KEY",
      }),
    );
  });
});
