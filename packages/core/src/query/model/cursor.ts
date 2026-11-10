import { sha256 } from "../../integrity/integrity.js";
import {
  fieldDefinition,
  type CollectionDefinition,
  type IndexScalar,
} from "../../catalog/collection-schema.js";
import type { QueryOrder } from "./query.js";
import type { QueryRow } from "../executor/predicate.js";

interface CursorEnvelope {
  readonly version: 1;
  readonly generation: string;
  readonly collection: string;
  readonly orderBy: readonly QueryOrder[];
  readonly values: readonly (string | number | boolean | null | { missing: true })[];
  readonly id: string;
}

function payload(envelope: CursorEnvelope): string {
  return JSON.stringify(envelope);
}

export function encodeQueryCursor(
  generation: string,
  schema: CollectionDefinition,
  orderBy: readonly QueryOrder[],
  row: QueryRow,
): string {
  const values = orderBy.map(({ field }) => {
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
    version: 1,
    generation,
    collection: schema.name,
    orderBy,
    values,
    id: row.id,
  };

  const json = payload(envelope);

  return Buffer.from(
    JSON.stringify({ payload: envelope, checksum: sha256(new TextEncoder().encode(json)) }),
  ).toString("base64url");
}

export function decodeQueryCursor(
  cursor: string,
  generation: string,
  schema: CollectionDefinition,
  orderBy: readonly QueryOrder[],
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

  if (
    !envelope ||
    envelope.version != 1 ||
    typeof record.checksum != "string" ||
    record.checksum != sha256(new TextEncoder().encode(payload(envelope)))
  )
    throw new Error("Invalid query cursor integrity");

  if (envelope.generation != generation)
    throw new Error("Query cursor snapshot generation is unavailable");

  if (
    envelope.collection != schema.name ||
    JSON.stringify(envelope.orderBy) != JSON.stringify(orderBy)
  )
    throw new Error("Query cursor is incompatible with this query");

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
