import type { StorageDriver } from "@duraxis/storage";
import { StorageKeyManager } from "../security/storage-key-manager.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface CommitRecord {
  readonly format: 1;
  readonly transactionId: string;
  readonly previous: string | null;
}

export function encodeCommitRecord(record: CommitRecord): Uint8Array {
  return encoder.encode(JSON.stringify(record));
}

export async function readCommitRecord(
  storage: StorageDriver,
  keys: StorageKeyManager,
  key: string,
): Promise<CommitRecord> {
  keys.validateCommitKey(key);

  const object = await storage.get(key);

  if (!object) throw new Error(`Missing commit record: ${key}`);

  keys.verifyCommit(key, object.data);

  if (object.data.byteLength > 2048) throw new Error("Commit record too large");

  const value: unknown = JSON.parse(decoder.decode(object.data));

  if (typeof value != "object" || value == null || Array.isArray(value))
    throw new Error("Invalid commit record");

  const record = value as Record<string, unknown>;

  if (
    Object.keys(record).sort().join() != "format,previous,transactionId" ||
    record.format != 1 ||
    typeof record.transactionId != "string" ||
    (record.previous != null && typeof record.previous != "string")
  )
    throw new Error("Invalid commit record");

  if (record.previous) keys.validateCommitKey(record.previous);

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      record.transactionId,
    )
  )
    throw new Error("Invalid commit transaction ID");

  return record as unknown as CommitRecord;
}
