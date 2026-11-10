export type FieldType = "string" | "number" | "boolean" | "date";
export type IndexOrder = "ASC" | "DESC";
export type IndexScalar = string | number | boolean | Date | null;

export interface FieldDefinition {
  readonly type: FieldType;
  readonly required?: boolean;
  readonly nullable?: boolean;
}

export interface IndexFieldDefinition {
  readonly field: string;
  readonly order: IndexOrder;
}

export interface SecondaryIndexDefinition {
  readonly name: string;
  readonly unique: boolean;
  readonly fields?: readonly IndexFieldDefinition[];
  readonly field?: string;
}

export interface CollectionDefinition {
  readonly name: string;
  readonly fields?: Readonly<Record<string, FieldDefinition>>;
  readonly allowAdditionalFields?: boolean;
  readonly indexes: readonly SecondaryIndexDefinition[];
}

export type DocumentRecord = Record<string, unknown>;

const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export const RECORD_PREFIX = "@duraxis/records/";

export function isValidSchemaName(name: unknown): name is string {
  return typeof name == "string" && NAME.test(name);
}

export function indexFields(index: SecondaryIndexDefinition): readonly IndexFieldDefinition[] {
  if (index.fields != null) return index.fields;
  return index.field == null ? [] : [{ field: index.field, order: "ASC" }];
}

export function fieldDefinition(
  schema: CollectionDefinition,
  name: string,
): FieldDefinition | undefined {
  return schema.fields && Object.hasOwn(schema.fields, name) ? schema.fields[name] : undefined;
}

export function normalizeCollection(schema: CollectionDefinition): CollectionDefinition {
  validateCollection(schema);
  const fields = schema.fields
    ? Object.fromEntries(
        Object.entries(schema.fields)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, field]) => [
            name,
            {
              type: field.type,
              required: field.required ?? false,
              nullable: field.nullable ?? false,
            },
          ]),
      )
    : undefined;

  return {
    name: schema.name,
    ...(fields == null ? {} : { fields }),
    allowAdditionalFields: schema.allowAdditionalFields ?? true,
    indexes: schema.indexes.map((index) => ({
      name: index.name,
      unique: index.unique,
      fields: indexFields(index).map((part) => ({ field: part.field, order: part.order })),
    })),
  };
}

export function validateCollection(schema: CollectionDefinition): void {
  if (!schema || !isValidSchemaName(schema.name) || !Array.isArray(schema.indexes))
    throw new Error("Invalid collection definition");

  if (schema.allowAdditionalFields != null && typeof schema.allowAdditionalFields != "boolean")
    throw new Error("Invalid additional-field policy");

  const fields = schema.fields;
  if (fields != null) {
    if (typeof fields != "object" || Array.isArray(fields)) throw new Error("Invalid field map");

    for (const [name, field] of Object.entries(fields)) {
      if (!isValidSchemaName(name) || !field || typeof field != "object")
        throw new Error(`Invalid field definition: ${name}`);

      if (!["string", "number", "boolean", "date"].includes(field.type))
        throw new Error(`Invalid field type: ${name}`);

      if (field.required != null && typeof field.required != "boolean")
        throw new Error(`Invalid required rule: ${name}`);

      if (field.nullable != null && typeof field.nullable != "boolean")
        throw new Error(`Invalid nullable rule: ${name}`);
    }
  }

  const names = new Set<string>();
  for (const index of schema.indexes) {
    if (!index || !isValidSchemaName(index.name) || typeof index.unique != "boolean")
      throw new Error("Invalid index definition");

    if (names.has(index.name)) throw new Error(`Duplicate index: ${index.name}`);

    names.add(index.name);

    if (index.field != null && index.fields != null)
      throw new Error(`Index ${index.name} must use field or fields, not both`);

    const parts = indexFields(index);

    if (parts.length == 0) throw new Error(`Index ${index.name} has no fields`);
    if (parts.length > 16) throw new Error(`Index ${index.name} has too many fields`);

    const indexed = new Set<string>();

    for (const part of parts) {
      if (!part || !isValidSchemaName(part.field) || !["ASC", "DESC"].includes(part.order))
        throw new Error(`Invalid index field in ${index.name}`);

      if (indexed.has(part.field)) throw new Error(`Duplicate field in index ${index.name}`);

      indexed.add(part.field);

      if (fields && !Object.hasOwn(fields, part.field))
        throw new Error(`Unknown indexed field: ${part.field}`);
    }
  }
}

function normalizeFieldValue(name: string, definition: FieldDefinition, value: unknown): unknown {
  if (value === null) {
    if (!definition.nullable) throw new Error(`Field ${name} is not nullable`);
    return null;
  }

  switch (definition.type) {
    case "string":
      if (typeof value != "string") throw new Error(`Field ${name} must be a string`);
      return value;

    case "number":
      if (typeof value != "number" || !Number.isFinite(value))
        throw new Error(`Field ${name} must be a finite number`);
      return Object.is(value, -0) ? 0 : value;

    case "boolean":
      if (typeof value != "boolean") throw new Error(`Field ${name} must be a boolean`);
      return value;

    case "date": {
      const date =
        value instanceof Date ? value : typeof value == "string" ? new Date(value) : null;

      if (!date || !Number.isFinite(date.getTime()))
        throw new Error(`Field ${name} must be a date`);

      const canonical = date.toISOString();
      if (typeof value == "string" && value != canonical)
        throw new Error(`Field ${name} must use canonical ISO-8601 form`);

      return canonical;
    }
  }
}

export function validateDocument(
  schema: CollectionDefinition,
  document: DocumentRecord,
): DocumentRecord {
  validateCollection(schema);
  if (!document || typeof document != "object" || Array.isArray(document))
    throw new Error("Document must be an object");

  const result: DocumentRecord = {};

  const fields = schema.fields;

  for (const [name, value] of Object.entries(document)) {
    const definition = fieldDefinition(schema, name);

    if (definition) result[name] = normalizeFieldValue(name, definition, value);
    else {
      if (fields && schema.allowAdditionalFields === false)
        throw new Error(`Unknown document field: ${name}`);
    
      result[name] = value;
    }
  }

  if (fields)
    for (const [name, definition] of Object.entries(fields))
      if ((definition.required ?? false) && !Object.hasOwn(result, name))
        throw new Error(`Missing required field: ${name}`);

  const serialized = JSON.stringify(result);
  if (typeof serialized != "string") throw new Error("Document is not serializable");

  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed != "object" || Array.isArray(parsed))
    throw new Error("Invalid document");

  return parsed as DocumentRecord;
}

export function recordKey(collection: string, id: string): string {
  if (!isValidSchemaName(collection)) throw new Error("Invalid collection name");

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

  let id: string;

  try {
    id = decodeURIComponent(encodedId);
  } catch {
    throw new Error("Invalid internal record key");
  }

  if (recordKey(collection, id) != key) throw new Error("Noncanonical internal record key");

  return { collection, id };
}

export function indexId(collection: string, index: string): string {
  if (!isValidSchemaName(collection) || !isValidSchemaName(index))
    throw new Error("Invalid index identifier");
  return `${collection}/${index}`;
}

export function encodeDocument(document: DocumentRecord): Uint8Array {
  if (!document || typeof document != "object" || Array.isArray(document))
    throw new Error("Document must be an object");

  const serialized = JSON.stringify(document);
  if (typeof serialized != "string") throw new Error("Document is not serializable");

  const result: unknown = JSON.parse(serialized);

  if (!result || typeof result != "object" || Array.isArray(result))
    throw new Error("Invalid document");

  return new TextEncoder().encode(serialized);
}

export function decodeDocument(bytes: Uint8Array): DocumentRecord {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

  if (!parsed || typeof parsed != "object" || Array.isArray(parsed))
    throw new Error("Invalid stored document");

  return parsed as DocumentRecord;
}

export function indexedValue(
  document: DocumentRecord,
  field: string,
  definition?: FieldDefinition,
): IndexScalar | undefined {
  if (!Object.hasOwn(document, field)) return undefined;
  const value = document[field];

  if (value === null) return null;

  if (definition?.type == "date") {
    const date = value instanceof Date ? value : typeof value == "string" ? new Date(value) : null;

    if (!date || !Number.isFinite(date.getTime()))
      throw new Error(`Invalid date value for field ${field}`);

    return date;
  }

  if (typeof value == "string" || typeof value == "boolean") return value;
  if (typeof value == "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;

  throw new Error(`Unsupported indexed value for field ${field}`);
}
