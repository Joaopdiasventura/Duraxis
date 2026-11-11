import { createHash } from "node:crypto";
import { StorageError } from "@duraxis/storage";

const OBJECT_MAGIC = Buffer.from("DXOBJ001", "ascii");
const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_JOURNAL_FRAME_BYTES = 64 * 1024;

export interface StoredMetadata {
  readonly version: string;
  readonly createdAt: number;
  readonly size: number;
  readonly digest: string;
}

export type JournalPayload =
  | ({
      readonly format: 1;
      readonly sequence: number;
      readonly op: "put";
      readonly key: string;
    } & StoredMetadata)
  | { readonly format: 1; readonly sequence: number; readonly op: "delete"; readonly key: string };

export interface DecodedJournal {
  readonly frames: readonly JournalPayload[];
  readonly validBytes: number;
  readonly incompleteTail: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function corruption(message: string, cause?: unknown): StorageError {
  return new StorageError(message, "CORRUPTION", cause == null ? undefined : { cause });
}

function parseRecord(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!value || typeof value != "object" || Array.isArray(value))
      throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (cause) {
    throw corruption(`Invalid ${label}`, cause);
  }
}

function validDigest(value: unknown): value is string {
  return typeof value == "string" && /^[0-9a-f]{64}$/.test(value);
}

function validateMetadata(
  value: Record<string, unknown>,
): asserts value is Record<string, unknown> & StoredMetadata {
  if (
    typeof value.version != "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.version,
    ) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    !validDigest(value.digest)
  )
    throw corruption("Invalid physical object metadata");
}

export function encodePhysicalObject(
  key: string,
  metadata: StoredMetadata,
  data: Uint8Array,
): Uint8Array {
  const headerPayload = {
    format: 1 as const,
    key,
    version: metadata.version,
    createdAt: metadata.createdAt,
    size: metadata.size,
    digest: metadata.digest,
  };
  const canonical = JSON.stringify(headerPayload);
  const header = encoder.encode(JSON.stringify({ ...headerPayload, checksum: sha256(canonical) }));
  if (header.byteLength > MAX_HEADER_BYTES)
    throw new StorageError("Object metadata is too large", "RESOURCE_LIMIT");
  const result = new Uint8Array(OBJECT_MAGIC.length + 4 + header.length + data.length);
  result.set(OBJECT_MAGIC, 0);
  new DataView(result.buffer).setUint32(OBJECT_MAGIC.length, header.length, false);
  result.set(header, OBJECT_MAGIC.length + 4);
  result.set(data, OBJECT_MAGIC.length + 4 + header.length);
  return result;
}

export function decodePhysicalObject(
  bytes: Uint8Array,
  expectedKey: string,
  expected: StoredMetadata,
): Uint8Array {
  if (
    bytes.byteLength < OBJECT_MAGIC.length + 4 ||
    !Buffer.from(bytes.subarray(0, OBJECT_MAGIC.length)).equals(OBJECT_MAGIC)
  )
    throw corruption("Invalid physical object magic");
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    OBJECT_MAGIC.length,
    false,
  );
  if (
    headerLength == 0 ||
    headerLength > MAX_HEADER_BYTES ||
    OBJECT_MAGIC.length + 4 + headerLength > bytes.byteLength
  )
    throw corruption("Invalid physical object header length");
  const header = parseRecord(
    bytes.subarray(OBJECT_MAGIC.length + 4, OBJECT_MAGIC.length + 4 + headerLength),
    "physical object header",
  );
  const fields = Object.keys(header).sort().join(",");
  if (
    fields != "checksum,createdAt,digest,format,key,size,version" ||
    header.format != 1 ||
    typeof header.key != "string" ||
    typeof header.checksum != "string"
  )
    throw corruption("Invalid physical object header");
  validateMetadata(header);
  const canonical = JSON.stringify({
    format: 1,
    key: header.key,
    version: header.version,
    createdAt: header.createdAt,
    size: header.size,
    digest: header.digest,
  });
  if (sha256(canonical) != header.checksum)
    throw corruption("Physical metadata integrity check failed");
  if (
    header.key != expectedKey ||
    header.version != expected.version ||
    header.createdAt != expected.createdAt ||
    header.size != expected.size ||
    header.digest != expected.digest
  )
    throw corruption("Physical object does not match journal metadata");
  const data = bytes.subarray(OBJECT_MAGIC.length + 4 + headerLength);
  if (data.byteLength != expected.size || sha256(data) != expected.digest)
    throw corruption("Physical object payload integrity check failed");
  return new Uint8Array(data);
}

export function encodeJournalFrame(payload: JournalPayload): Uint8Array {
  const canonical = JSON.stringify(payload);
  const body = encoder.encode(JSON.stringify({ ...payload, checksum: sha256(canonical) }));
  if (body.byteLength > MAX_JOURNAL_FRAME_BYTES)
    throw new StorageError("Journal frame is too large", "RESOURCE_LIMIT");
  const result = new Uint8Array(4 + body.byteLength);
  new DataView(result.buffer).setUint32(0, body.byteLength, false);
  result.set(body, 4);
  return result;
}

function decodeFrame(bytes: Uint8Array, expectedSequence: number): JournalPayload {
  const record = parseRecord(bytes, "storage journal frame");
  if (
    record.format != 1 ||
    record.sequence != expectedSequence ||
    (record.op != "put" && record.op != "delete") ||
    typeof record.key != "string" ||
    typeof record.checksum != "string"
  )
    throw corruption("Invalid storage journal frame");
  let payload: JournalPayload;
  if (record.op == "put") {
    if (
      Object.keys(record).sort().join(",") !=
      "checksum,createdAt,digest,format,key,op,sequence,size,version"
    )
      throw corruption("Invalid put journal frame layout");
    validateMetadata(record);
    payload = {
      format: 1,
      sequence: expectedSequence,
      op: "put",
      key: record.key,
      version: record.version,
      createdAt: record.createdAt,
      size: record.size,
      digest: record.digest,
    };
  } else {
    if (Object.keys(record).sort().join(",") != "checksum,format,key,op,sequence")
      throw corruption("Invalid delete journal frame layout");
    payload = { format: 1, sequence: expectedSequence, op: "delete", key: record.key };
  }
  if (sha256(JSON.stringify(payload)) != record.checksum)
    throw corruption("Storage journal integrity check failed");
  return payload;
}

export function decodeJournal(bytes: Uint8Array): DecodedJournal {
  const frames: JournalPayload[] = [];
  let offset = 0;
  let sequence = 1;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 4) return { frames, validBytes: offset, incompleteTail: true };
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    if (length == 0 || length > MAX_JOURNAL_FRAME_BYTES)
      throw corruption("Invalid storage journal frame length");
    if (bytes.byteLength - offset - 4 < length)
      return { frames, validBytes: offset, incompleteTail: true };
    frames.push(decodeFrame(bytes.subarray(offset + 4, offset + 4 + length), sequence++));
    offset += 4 + length;
  }
  return { frames, validBytes: offset, incompleteTail: false };
}
