import { StorageKeyManager } from "../security/storage-key-manager.js";

export const MANIFEST_KEY = "__duraxis/v1/manifest";

export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_ENTRIES = 250_000;

const encoder = new TextEncoder();

const decoder = new TextDecoder("utf-8", {
  fatal: true,
});

export interface Manifest {
  readonly format: 1;
  readonly transactionId: string;
  readonly entries: ReadonlyMap<string, string>;
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
  };
}

export function encodeManifest(manifest: Manifest): Uint8Array {
  const data = encoder.encode(
    JSON.stringify({
      format: manifest.format,
      transactionId: manifest.transactionId,
      entries: Object.fromEntries(manifest.entries),
    }),
  );

  if (data.byteLength > MAX_MANIFEST_BYTES) throw new Error("Duraxis manifest exceeds size limit");

  return data;
}

export function decodeManifest(
  data: Uint8Array,
  keys: StorageKeyManager = new StorageKeyManager(),
): Manifest {
  if (data.byteLength > MAX_MANIFEST_BYTES) throw new Error("Duraxis manifest exceeds size limit");

  const parsed: unknown = JSON.parse(decoder.decode(data));

  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join() != "entries,format,transactionId" ||
    parsed.format != 1 ||
    typeof parsed.transactionId != "string" ||
    !isRecord(parsed.entries)
  )
    throw new Error("Invalid Duraxis manifest");

  if (parsed.transactionId != "" && !/^[0-9a-f-]{36}$/.test(parsed.transactionId))
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

  return {
    format: 1,
    transactionId: parsed.transactionId,
    entries,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
