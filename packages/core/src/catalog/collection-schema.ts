export type IndexScalar = string | number | boolean | null;

export interface SecondaryIndexDefinition {
  readonly name: string;
  readonly field: string;
  readonly unique: boolean;
}

export interface CollectionDefinition {
  readonly name: string;
  readonly indexes: readonly SecondaryIndexDefinition[];
}

export type DocumentRecord = Record<string, unknown>;

const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export const RECORD_PREFIX = "@duraxis/records/";

export function validateCollection(schema: CollectionDefinition): void {
  if (!schema || !NAME.test(schema.name) || !Array.isArray(schema.indexes))
    throw new Error("Invalid collection definition");

  const names = new Set<string>();

  for (const index of schema.indexes) {
    if (
      !index ||
      !NAME.test(index.name) ||
      !NAME.test(index.field) ||
      typeof index.unique != "boolean"
    )
      throw new Error("Invalid index definition");

    if (names.has(index.name)) throw new Error(`Duplicate index: ${index.name}`);

    names.add(index.name);
  }
}

export function recordKey(collection: string, id: string): string {
  if (!NAME.test(collection)) throw new Error("Invalid collection name");

  if (typeof id != "string" || id.length == 0 || Buffer.byteLength(id, "utf8") > 512)
    throw new Error("Invalid record ID");

  const key = `${RECORD_PREFIX}${collection}/${encodeURIComponent(id)}`;

  if (Buffer.byteLength(key, "utf8") > 1024) throw new Error("Record key exceeds B+tree key limit");

  return key;
}

export function parseRecordKey(key: string): { collection: string; id: string } | null {
  if (!key.startsWith(RECORD_PREFIX)) return null;

  const tail = key.slice(RECORD_PREFIX.length);
  const slash = tail.indexOf("/");

  if (slash < 1) throw new Error("Invalid internal record key");

  const collection = tail.slice(0, slash);
  const encodedId = tail.slice(slash + 1);
  const id = decodeURIComponent(encodedId);

  if (recordKey(collection, id) != key) throw new Error("Noncanonical internal record key");

  return { collection, id };
}

export function indexId(collection: string, index: string): string {
  if (!NAME.test(collection) || !NAME.test(index)) throw new Error("Invalid index identifier");
  return `${collection}/${index}`;
}

export function encodeDocument(document: DocumentRecord): Uint8Array {
  if (!document || typeof document != "object" || Array.isArray(document))
    throw new Error("Document must be an object");

  const serialized = JSON.stringify(document);

  if (typeof serialized != "string") throw new Error("Document is not serializable");

  const result = JSON.parse(serialized);

  if (!result || typeof result != "object" || Array.isArray(result))
    throw new Error("Invalid document");

  return new TextEncoder().encode(serialized);
}

export function decodeDocument(bytes: Uint8Array): DocumentRecord {
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", {
      fatal: true,
    }).decode(bytes),
  );

  if (!parsed || typeof parsed != "object" || Array.isArray(parsed))
    throw new Error("Invalid stored document");

  return parsed as DocumentRecord;
}

export function indexedValue(document: DocumentRecord, field: string): IndexScalar | undefined {
  if (!Object.hasOwn(document, field)) return undefined;

  const value = document[field];

  if (value == null || typeof value == "string" || typeof value == "boolean") return value;

  if (typeof value == "number" && Number.isFinite(value)) return value;

  throw new Error(`Unsupported indexed value for field ${field}`);
}
