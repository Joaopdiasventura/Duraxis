import { createHmac, timingSafeEqual } from "node:crypto";
import {
  fieldDefinition,
  type CollectionDefinition,
  type IndexScalar,
} from "../../catalog/collection-schema.js";
import type { LogicalQuery } from "./query.js";
import type { QueryRow } from "../executor/predicate.js";

interface CursorEnvelope {
  readonly version: 2;
  readonly generation: string;
  readonly queryHash: string;
  readonly values: readonly (string | number | boolean | null | { missing: true })[];
  readonly id: string;
}

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value == "string" || typeof value == "boolean")
    return JSON.stringify(value);
  if (typeof value == "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid cursor query number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value == "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new Error("Invalid cursor query value");
}

function shape(query: LogicalQuery): unknown {
  return {
    collection: query.collection,
    where: query.where,
    orderBy: query.orderBy ?? [],
    projection: query.projection ?? null,
    limit: query.limit ?? null,
  };
}

function hmac(key: Uint8Array, value: string): string {
  if (!(key instanceof Uint8Array) || key.byteLength < 32)
    throw new Error("Cursor signing key must contain at least 32 bytes");
  return createHmac("sha256", key).update(value).digest("hex");
}

function queryHash(key: Uint8Array, query: LogicalQuery): string {
  return hmac(key, canonical(shape(query)));
}

export function encodeQueryCursor(
  generation: string,
  schema: CollectionDefinition,
  query: LogicalQuery,
  row: QueryRow,
  signingKey: Uint8Array,
): string {
  if (query.collection != schema.name) throw new Error("Cursor collection mismatch");
  const orderBy = query.orderBy ?? [];
  const values = orderBy.map(({ field }) => {
    if (field == "$id") return row.id;
    if (!Object.hasOwn(row.document, field)) return { missing: true } as const;
    const value = row.document[field];
    if (value instanceof Date) return value.toISOString();
    if (
      value === null ||
      typeof value == "string" ||
      typeof value == "number" ||
      typeof value == "boolean"
    )
      return value;
    throw new Error(`Cannot encode cursor value for ${field}`);
  });
  const envelope: CursorEnvelope = {
    version: 2,
    generation,
    queryHash: queryHash(signingKey, query),
    values,
    id: row.id,
  };
  const payload = canonical(envelope);
  return Buffer.from(
    JSON.stringify({ payload: envelope, signature: hmac(signingKey, payload) }),
  ).toString("base64url");
}

export function decodeQueryCursor(
  cursor: string,
  generation: string,
  schema: CollectionDefinition,
  query: LogicalQuery,
  signingKey: Uint8Array,
): { readonly values: readonly (IndexScalar | undefined)[]; readonly id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid query cursor");
  }
  if (!parsed || typeof parsed != "object" || Array.isArray(parsed))
    throw new Error("Invalid query cursor");
  const record = parsed as Record<string, unknown>;
  const envelope = record.payload as CursorEnvelope;
  if (!envelope || envelope.version != 2 || typeof record.signature != "string")
    throw new Error("Invalid query cursor payload");
  const expectedSignature = hmac(signingKey, canonical(envelope));
  const actual = Buffer.from(record.signature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");
  if (actual.length != expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Invalid query cursor signature");
  if (envelope.generation != generation)
    throw new Error("Query cursor snapshot generation is unavailable");
  if (envelope.queryHash != queryHash(signingKey, query) || query.collection != schema.name)
    throw new Error("Query cursor is incompatible with this query");
  const orderBy = query.orderBy ?? [];
  if (
    !Array.isArray(envelope.values) ||
    envelope.values.length != orderBy.length ||
    typeof envelope.id != "string"
  )
    throw new Error("Invalid query cursor payload");
  return {
    id: envelope.id,
    values: envelope.values.map((item, index) => {
      if (item && typeof item == "object" && "missing" in item) return undefined;
      if (fieldDefinition(schema, orderBy[index]!.field)?.type == "date" && typeof item == "string")
        return new Date(item);
      return item as IndexScalar;
    }),
  };
}
