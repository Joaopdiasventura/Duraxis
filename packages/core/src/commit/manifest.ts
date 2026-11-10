import { sha256, assertDigest } from "../integrity/integrity.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";
import {
  validateCollection,
  indexId,
  type CollectionDefinition,
} from "../catalog/collection-schema.js";

export const MANIFEST_KEY = "__duraxis/v1/manifest";
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface Manifest {
  readonly format: 1;
  readonly transactionId: string;
  readonly commitHead: string | null;
  readonly primaryRoot: string | null;
  readonly indexRoots: ReadonlyMap<string, string | null>;
  readonly catalog: ReadonlyMap<string, CollectionDefinition>;
}

export interface Snapshot {
  readonly manifest: Manifest;
  readonly storageVersion: string | null;
}

export function emptyManifest(): Manifest {
  return {
    format: 1,
    transactionId: "",
    commitHead: null,
    primaryRoot: null,
    indexRoots: new Map(),
    catalog: new Map(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value == "object" && value != null && !Array.isArray(value);
}

function sorted<V>(items: ReadonlyMap<string, V>): Record<string, V> {
  return Object.fromEntries([...items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function normalizedCatalog(
  catalog: ReadonlyMap<string, CollectionDefinition>,
): Record<string, CollectionDefinition> {
  const normalized = new Map<string, CollectionDefinition>();

  for (const [name, schema] of catalog) {
    validateCollection(schema);

    if (schema.name != name) throw new Error("Collection catalog name mismatch");

    normalized.set(name, {
      name,
      indexes: schema.indexes.map((index) => ({
        name: index.name,
        field: index.field,
        unique: index.unique,
      })),
    });
  }

  return sorted(normalized);
}

function validateManifest(manifest: Manifest, keys: StorageKeyManager): void {
  if (manifest.format != 1) throw new Error("Invalid Duraxis manifest format");

  if (manifest.transactionId != "" && !TRANSACTION_ID.test(manifest.transactionId))
    throw new Error("Invalid manifest transaction ID");

  if (manifest.transactionId == "") {
    if (manifest.commitHead != null) throw new Error("Unexpected commit head");
  } else {
    if (manifest.commitHead == null) throw new Error("Missing commit head");

    keys.validateCommitKey(manifest.commitHead);
  }

  if (manifest.primaryRoot != null) keys.validateIndexNodeKey(manifest.primaryRoot);

  const expected = new Set<string>();

  for (const [name, schema] of manifest.catalog) {
    validateCollection(schema);

    if (name != schema.name) throw new Error("Collection catalog name mismatch");
    for (const index of schema.indexes) expected.add(indexId(name, index.name));
  }

  for (const [name, root] of manifest.indexRoots) {
    if (!expected.has(name)) throw new Error(`Undeclared index root: ${name}`);

    if (root != null) {
      keys.validateIndexNodeKey(root);

      if (manifest.primaryRoot == null)
        throw new Error("Secondary index cannot contain data without a primary root");
    }
  }

  for (const name of expected)
    if (!manifest.indexRoots.has(name)) throw new Error(`Missing index root: ${name}`);
}

function payload(manifest: Manifest) {
  return {
    format: 1 as const,
    transactionId: manifest.transactionId,
    commitHead: manifest.commitHead,
    primaryRoot: manifest.primaryRoot,
    indexRoots: sorted(manifest.indexRoots),
    catalog: normalizedCatalog(manifest.catalog),
  };
}

export function encodeManifest(manifest: Manifest, keys = new StorageKeyManager()): Uint8Array {
  validateManifest(manifest, keys);

  const data = payload(manifest);
  const checksum = sha256(encoder.encode(JSON.stringify(data)));

  const bytes = encoder.encode(JSON.stringify({ ...data, checksum }));

  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Duraxis manifest exceeds size limit");

  return bytes;
}

export function decodeManifest(bytes: Uint8Array, keys = new StorageKeyManager()): Manifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Duraxis manifest exceeds size limit");

  const parsed: unknown = JSON.parse(decoder.decode(bytes));

  if (!isRecord(parsed)) throw new Error("Invalid Duraxis manifest");

  const fields = Object.keys(parsed).sort().join(",");

  if (fields != "catalog,checksum,commitHead,format,indexRoots,primaryRoot,transactionId") {
    throw new Error("Invalid Duraxis manifest layout");
  }

  if (
    parsed.format != 1 ||
    typeof parsed.transactionId != "string" ||
    (parsed.commitHead != null && typeof parsed.commitHead != "string") ||
    (parsed.primaryRoot != null && typeof parsed.primaryRoot != "string") ||
    typeof parsed.checksum != "string" ||
    !isRecord(parsed.indexRoots) ||
    !isRecord(parsed.catalog)
  )
    throw new Error("Invalid Duraxis manifest metadata");

  const indexRoots = new Map<string, string | null>();

  for (const [name, root] of Object.entries(parsed.indexRoots)) {
    if (root != null && typeof root != "string") throw new Error("Invalid index root");
    indexRoots.set(name, root!);
  }

  const catalog = new Map<string, CollectionDefinition>();

  for (const [name, value] of Object.entries(parsed.catalog)) {
    if (!isRecord(value) || !Array.isArray(value.indexes))
      throw new Error("Invalid collection definition");

    const schema = value as unknown as CollectionDefinition;

    validateCollection(schema);
    catalog.set(name, schema);
  }

  const manifest: Manifest = {
    format: 1,
    transactionId: parsed.transactionId,
    commitHead: parsed.commitHead!,
    primaryRoot: parsed.primaryRoot!,
    indexRoots,
    catalog,
  };

  validateManifest(manifest, keys);

  assertDigest(encoder.encode(JSON.stringify(payload(manifest))), parsed.checksum);

  return manifest;
}
