import { sha256, assertDigest } from "../integrity/integrity.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";

export const MANIFEST_KEY = "__duraxis/v1/manifest";

export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_ENTRIES = 250_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {
  fatal: true,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface Manifest {
  readonly format: 1;
  readonly transactionId: string;
  readonly entries: ReadonlyMap<string, string>;
  readonly commitHead?: string | null;
}

export interface Snapshot {
  readonly manifest: Manifest;
  readonly storageVersion: string | null;
}

export function emptyManifest(): Manifest {
  return {
    format: 1,
    transactionId: "",
    entries: new Map(),
    commitHead: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value == "object" && value != null && !Array.isArray(value);
}

function entriesPayload(entries: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function payload(manifest: Manifest) {
  return {
    format: 1 as const,
    transactionId: manifest.transactionId,
    commitHead: manifest.commitHead ?? null,
    entries: entriesPayload(manifest.entries),
  };
}

export function encodeManifest(manifest: Manifest): Uint8Array {
  const data = payload(manifest);

  const bytes = encoder.encode(
    JSON.stringify({
      ...data,
      checksum: sha256(encoder.encode(JSON.stringify(data))),
    }),
  );

  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Duraxis manifest exceeds size limit");

  return bytes;
}

export function decodeManifest(bytes: Uint8Array, keys = new StorageKeyManager()): Manifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Duraxis manifest exceeds size limit");

  const parsed: unknown = JSON.parse(decoder.decode(bytes));

  if (
    !isRecord(parsed) ||
    parsed.format != 1 ||
    typeof parsed.transactionId != "string" ||
    !isRecord(parsed.entries)
  )
    throw new Error("Invalid Duraxis manifest");

  const properties = Object.keys(parsed).sort().join();

  const legacy = properties == "entries,format,transactionId";

  const current = properties == "checksum,commitHead,entries,format,transactionId";

  if (!legacy && !current) throw new Error("Invalid Duraxis manifest");

  if (parsed.transactionId != "" && !UUID.test(parsed.transactionId))
    throw new Error("Invalid manifest transaction ID");

  const rows = Object.entries(parsed.entries);

  if (rows.length > MAX_MANIFEST_ENTRIES) throw new Error("Too many manifest entries");

  const entries = new Map<string, string>();

  for (const [logicalKey, physicalKey] of rows) {
    keys.validateLogicalKey(logicalKey);

    if (typeof physicalKey != "string") throw new Error("Invalid manifest object reference");

    keys.validateObjectKey(physicalKey);
    entries.set(logicalKey, physicalKey);
  }

  if (legacy) {
    return {
      format: 1,
      transactionId: parsed.transactionId,
      entries,
      commitHead: null,
    };
  }

  if (
    typeof parsed.checksum != "string" ||
    (parsed.commitHead != null && typeof parsed.commitHead != "string")
  )
    throw new Error("Invalid manifest metadata");

  if (parsed.commitHead != null) keys.validateCommitKey(parsed.commitHead);

  if (parsed.transactionId != "" && parsed.commitHead == null)
    throw new Error("Missing commit head");

  if (parsed.transactionId == "" && parsed.commitHead != null)
    throw new Error("Unexpected commit head");

  const manifest: Manifest = {
    format: 1,
    transactionId: parsed.transactionId,
    commitHead: parsed.commitHead,
    entries,
  };

  const data = payload(manifest);

  assertDigest(encoder.encode(JSON.stringify(data)), parsed.checksum);

  return manifest;
}
