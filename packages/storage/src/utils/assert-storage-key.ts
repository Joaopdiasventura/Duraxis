import { StorageError } from "../errors/storage.error.js";

export function assertStorageKey(key: string): void {
  if (typeof key != "string" || key.length == 0 || key.trim().length == 0 || key.includes("\0")) {
    throw new StorageError(
      "Storage key must be a non-empty string without null bytes",
      "INVALID_KEY",
    );
  }
}
