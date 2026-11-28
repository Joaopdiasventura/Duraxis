import { createHmac, createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  fieldDefinition,
  type CollectionDefinition,
  type IndexScalar,
} from "../../catalog/collection-schema.js";
import type { LogicalQuery } from "./query.js";
import type { QueryRow } from "../executor/predicate.js";

interface CursorEnvelope {
  readonly version: 3;
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

function cursorEnvelope(
  generation: string,
  schema: CollectionDefinition,
  query: LogicalQuery,
  row: QueryRow,
  signingKey: Uint8Array,
): CursorEnvelope {
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
    version: 3,
    generation,
    queryHash: queryHash(signingKey, query),
    values,
    id: row.id,
  };

  return envelope;
}

export interface CursorKeyring {
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, Uint8Array>>;
  readonly ttlMs?: number;
}

function cursorKeys(value: Uint8Array | CursorKeyring): CursorKeyring {
  if (value instanceof Uint8Array) {
    if (value.byteLength < 32) throw new Error("Cursor key must contain at least 32 bytes");

    return {
      activeKeyId: "default",
      keys: { default: createHash("sha256").update(value).digest() },
      ttlMs: 15 * 60_000,
    };
  }

  if (
    !value ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(value.activeKeyId) ||
    !Object.hasOwn(value.keys, value.activeKeyId)
  )
    throw new Error("Invalid cursor keyring");

  for (const [id, key] of Object.entries(value.keys))
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !(key instanceof Uint8Array) || key.byteLength != 32)
      throw new Error("Cursor encryption keys must contain exactly 32 bytes");

  if (Object.keys(value.keys).length > 16) throw new Error("Cursor keyring is too large");

  if (value.ttlMs !== undefined && (!Number.isSafeInteger(value.ttlMs) || value.ttlMs < 1))
    throw new Error("Invalid cursor expiry");

  return value;
}

export function encodeQueryCursor(
  generation: string,
  schema: CollectionDefinition,
  query: LogicalQuery,
  row: QueryRow,
  keys: Uint8Array | CursorKeyring,
  namespace = "",
): string {
  const ring = cursorKeys(keys);
  const key = ring.keys[ring.activeKeyId]!;

  const envelope = cursorEnvelope(generation, schema, query, row, key);

  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);

  cipher.setAAD(Buffer.from(canonical({ version: 3, keyId: ring.activeKeyId, namespace })));

  const payload = JSON.stringify({
    ...envelope,
    version: 3,
    namespace,
    expiresAt: Date.now() + (ring.ttlMs ?? 15 * 60_000),
  });

  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);

  const cursor = Buffer.from(
    JSON.stringify({
      version: 3,
      keyId: ring.activeKeyId,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    }),
  ).toString("base64url");

  if (cursor.length > 16_384) throw new Error("Query cursor exceeds maximum size");

  return cursor;
}

export function decodeQueryCursor(
  cursor: string,
  generation: string,
  schema: CollectionDefinition,
  query: LogicalQuery,
  keys: Uint8Array | CursorKeyring,
  namespace = "",
): { readonly values: readonly (IndexScalar | undefined)[]; readonly id: string } {
  if (
    typeof cursor != "string" ||
    !cursor.length ||
    cursor.length > 16_384 ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  )
    throw new Error("Invalid query cursor");

  const ring = cursorKeys(keys);
  let outer: Record<string, unknown>;

  try {
    outer = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    throw new Error("Invalid query cursor");
  }

  if (!outer || typeof outer != "object" || Array.isArray(outer))
    throw new Error("Invalid query cursor");

  if (outer.version !== 3) throw new Error("Unsupported cursor format; restart pagination");

  if (
    Object.keys(outer).sort().join(",") != "ciphertext,keyId,nonce,tag,version" ||
    typeof outer.keyId != "string" ||
    !Object.hasOwn(ring.keys, outer.keyId)
  )
    throw new Error("Invalid query cursor");

  const binary = (value: unknown) => {
    if (typeof value != "string" || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error("Invalid query cursor");

    const result = Buffer.from(value, "base64url");

    if (result.toString("base64url") != value) throw new Error("Invalid query cursor");

    return result;
  };

  const nonce = binary(outer.nonce);
  const tag = binary(outer.tag);

  const ciphertext = binary(outer.ciphertext);

  if (nonce.length != 12 || tag.length != 16) throw new Error("Invalid query cursor");

  const key = ring.keys[outer.keyId]!;
  let payload: Record<string, unknown>;

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);

    decipher.setAAD(Buffer.from(canonical({ version: 3, keyId: outer.keyId, namespace })));
    decipher.setAuthTag(tag);

    payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString());
  } catch {
    throw new Error("Invalid query cursor authentication");
  }

  if (!payload || typeof payload != "object" || Array.isArray(payload))
    throw new Error("Invalid query cursor payload");

  if (
    payload.version != 3 ||
    payload.namespace != namespace ||
    typeof payload.expiresAt != "number" ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= Date.now()
  )
    throw new Error("Invalid or expired query cursor");

  if (payload.generation != generation)
    throw new Error("Query cursor snapshot generation is unavailable");

  if (payload.queryHash != queryHash(key, query) || query.collection != schema.name)
    throw new Error("Query cursor is incompatible with this query");

  if (
    typeof payload.id != "string" ||
    !payload.id.length ||
    Buffer.byteLength(payload.id) > 512 ||
    !Array.isArray(payload.values) ||
    payload.values.length != (query.orderBy ?? []).length
  )
    throw new Error("Invalid query cursor payload");

  const values = payload.values.map((value: unknown, index: number): IndexScalar | undefined => {
    if (
      value &&
      typeof value == "object" &&
      Object.keys(value).join(",") == "missing" &&
      (value as { missing: unknown }).missing === true
    )
      return undefined;

    if (
      value !== null &&
      typeof value != "string" &&
      typeof value != "boolean" &&
      (typeof value != "number" || !Number.isFinite(value))
    )
      throw new Error("Invalid cursor scalar");

    if (
      fieldDefinition(schema, query.orderBy![index]!.field)?.type == "date" &&
      typeof value == "string"
    ) {
      const date = new Date(value);

      if (!Number.isFinite(date.getTime()) || date.toISOString() != value)
        throw new Error("Invalid cursor date");

      return date;
    }

    return value as IndexScalar;
  });

  return { id: payload.id, values };
}
