import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { StorageError } from "@duraxis/storage";

const MAGIC = Buffer.from("DRXS3v1\0");
const HEADER_BYTES = 72;

export function encodeObject(data: Uint8Array): Uint8Array {
  const physical = new Uint8Array(HEADER_BYTES + data.byteLength);

  physical.set(MAGIC);
  physical.set(randomBytes(32), 8);
  physical.set(createHash("sha256").update(data).digest(), 40);
  physical.set(data, HEADER_BYTES);

  return physical;
}

export function decodeObject(physical: Uint8Array): Uint8Array {
  if (physical.byteLength < HEADER_BYTES || !MAGIC.equals(physical.subarray(0, 8)))
    throw new StorageError("Invalid S3 storage object envelope", "CORRUPTION");

  const data = physical.slice(HEADER_BYTES);

  const digest = createHash("sha256").update(data).digest();

  if (!timingSafeEqual(digest, physical.subarray(40, HEADER_BYTES)))
    throw new StorageError("S3 storage object integrity check failed", "CORRUPTION");

  return data;
}

export function isVersion(version: unknown): version is string {
  return typeof version == "string" && /^"[\x21\x23-\x7e]{1,256}"$/.test(version);
}

export function requireVersion(version: unknown): string {
  if (!isVersion(version)) throw new StorageError("Missing or invalid S3 ETag", "CORRUPTION");
  return version;
}

export function objectState(metadata: Record<string, string> | undefined): "live" | "deleted" {
  if (
    metadata?.["duraxis-format"] != "1" ||
    !["live", "deleted"].includes(metadata["duraxis-state"])
  )
    throw new StorageError("Unrecognized S3 object metadata in Duraxis namespace", "CORRUPTION");

  return metadata["duraxis-state"] == "live" ? "live" : "deleted";
}
