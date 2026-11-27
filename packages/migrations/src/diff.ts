import type {
  CollectionDefinition,
  FieldDefinition,
  ForeignKeyDefinition,
  SecondaryIndexDefinition,
} from "@duraxis/core";
import type { MigrationContext } from "./context.js";
import { canonicalJSON, canonicalSchema, schemaHash } from "./schema.js";

export type MigrationRisk =
  "safe" | "requires-validation" | "requires-data-transformation" | "destructive";

interface Change<K extends string, T> {
  readonly kind: K;
  readonly collection: string;
  readonly name: string;
  readonly before: T | null;
  readonly after: T | null;
  readonly risk: MigrationRisk;
}

export type MigrationOperation =
  | Change<"collection", CollectionDefinition>
  | Change<"field", FieldDefinition>
  | Change<"index", SecondaryIndexDefinition>
  | Change<"foreign-key", ForeignKeyDefinition>
  | Change<"additional-fields", boolean>;

export interface SchemaPlan {
  readonly before: readonly CollectionDefinition[];
  readonly after: readonly CollectionDefinition[];
  readonly operations: readonly MigrationOperation[];
}

function fieldRisk(before: FieldDefinition | null, after: FieldDefinition | null): MigrationRisk {
  if (!after) return "destructive";

  if (!before) return after.required ? "requires-data-transformation" : "safe";

  if (before.type != after.type || (!before.required && after.required))
    return "requires-data-transformation";

  if (before.nullable && !after.nullable) return "requires-validation";

  return "safe";
}

export function diffSchemas(
  before: readonly CollectionDefinition[],
  after: readonly CollectionDefinition[],
): SchemaPlan {
  const previous = canonicalSchema(before);
  const next = canonicalSchema(after);

  const left = new Map(previous.map((schema) => [schema.name, schema]));
  const right = new Map(next.map((schema) => [schema.name, schema]));

  const operations: MigrationOperation[] = [];

  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(name);
    const b = right.get(name);

    if (!a || !b) {
      operations.push({
        kind: "collection",
        collection: name,
        name,
        before: a ?? null,
        after: b ?? null,
        risk: b ? "requires-validation" : "destructive",
      });

      continue;
    }

    if ((a.fields == null) != (b.fields == null))
      operations.push({
        kind: "collection",
        collection: name,
        name,
        before: a,
        after: b,
        risk: "requires-validation",
      });

    const fields = new Set([...Object.keys(a.fields ?? {}), ...Object.keys(b.fields ?? {})]);

    for (const field of [...fields].sort()) {
      const from = a.fields?.[field] ?? null;
      const to = b.fields?.[field] ?? null;

      if (canonicalJSON(from) != canonicalJSON(to))
        operations.push({
          kind: "field",
          collection: name,
          name: field,
          before: from,
          after: to,
          risk: fieldRisk(from, to),
        });
    }

    if (a.allowAdditionalFields != b.allowAdditionalFields)
      operations.push({
        kind: "additional-fields",
        collection: name,
        name,
        before: a.allowAdditionalFields ?? true,
        after: b.allowAdditionalFields ?? true,
        risk: b.allowAdditionalFields ? "safe" : "requires-validation",
      });

    for (const index of [
      ...new Set([...a.indexes, ...b.indexes].map((index) => index.name)),
    ].sort()) {
      const from = a.indexes.find((item) => item.name == index) ?? null;
      const to = b.indexes.find((item) => item.name == index) ?? null;

      if (canonicalJSON(from) != canonicalJSON(to))
        operations.push({
          kind: "index",
          collection: name,
          name: index,
          before: from,
          after: to,
          risk: to?.unique ? "requires-validation" : "safe",
        });
    }

    for (const key of [
      ...new Set([...(a.foreignKeys ?? []), ...(b.foreignKeys ?? [])].map((key) => key.name)),
    ].sort()) {
      const from = a.foreignKeys?.find((item) => item.name == key) ?? null;
      const to = b.foreignKeys?.find((item) => item.name == key) ?? null;

      if (canonicalJSON(from) != canonicalJSON(to))
        operations.push({
          kind: "foreign-key",
          collection: name,
          name: key,
          before: from,
          after: to,
          risk: to ? "requires-validation" : "safe",
        });
    }
  }

  return { before: previous, after: next, operations };
}

export async function applySchemaPlan(context: MigrationContext, plan: SchemaPlan): Promise<void> {
  const names = new Set([...plan.before, ...plan.after].map((schema) => schema.name));

  if (
    schemaHash(context.schema.inspect().filter((schema) => names.has(schema.name))) !=
    schemaHash(plan.before)
  )
    throw new Error("Schema plan predecessor mismatch");

  for (const operation of plan.operations) {
    if (operation.risk == "requires-data-transformation")
      throw new Error(
        `Manual data transformation required: ${operation.collection}/${operation.name}`,
      );

    if (operation.kind == "field" && !operation.after)
      for await (const row of context.scan(operation.collection))
        if (Object.hasOwn(row.document, operation.name))
          throw new Error(
            `Cannot remove populated field: ${operation.collection}/${operation.name}; write an explicit transformation`,
          );
  }

  const old = new Set(plan.before.map((schema) => schema.name));
  const next = new Set(plan.after.map((schema) => schema.name));

  for (const schema of plan.before)
    if (!next.has(schema.name)) context.schema.dropCollection(schema.name);

  for (const schema of plan.after)
    if (old.has(schema.name)) context.schema.alterCollection(schema.name, schema);
    else context.schema.createCollection(schema);
}
