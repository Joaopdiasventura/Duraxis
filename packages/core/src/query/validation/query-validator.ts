import {
  isValidSchemaName,
  fieldDefinition,
  type CollectionDefinition,
  type FieldDefinition,
  type IndexScalar,
} from "../../catalog/collection-schema.js";
import type { LogicalQuery, QueryPredicate } from "../model/query.js";

const MAX_PREDICATE_DEPTH = 64;
const MAX_IN_VALUES = 10_000;

function validateValue(
  field: string,
  definition: FieldDefinition | undefined,
  value: IndexScalar,
): void {
  if (value === null) {
    if (definition && !definition.nullable) throw new Error(`Field ${field} is not nullable`);
    return;
  }

  if (!definition) {
    if (
      !(value instanceof Date) &&
      typeof value != "string" &&
      typeof value != "number" &&
      typeof value != "boolean"
    )
      throw new Error(`Invalid query value for ${field}`);

    if (typeof value == "number" && !Number.isFinite(value))
      throw new Error(`Invalid query number for ${field}`);

    return;
  }

  const valid =
    definition.type == "date"
      ? (value instanceof Date && Number.isFinite(value.getTime())) ||
        (typeof value == "string" &&
          Number.isFinite(new Date(value).getTime()) &&
          new Date(value).toISOString() == value)
      : typeof value == definition.type && (typeof value != "number" || Number.isFinite(value));

  if (!valid) throw new Error(`Query value does not match field ${field}`);
}

function field(schema: CollectionDefinition, name: string): FieldDefinition | undefined {
  if (!isValidSchemaName(name)) throw new Error(`Invalid query field: ${name}`);

  const definition = fieldDefinition(schema, name);

  if (schema.fields && !definition) throw new Error(`Unknown query field: ${name}`);

  return definition;
}

function predicate(schema: CollectionDefinition, value: QueryPredicate, depth: number): void {
  if (depth > MAX_PREDICATE_DEPTH) throw new Error("Query predicate nesting is too deep");

  if (!value || typeof value != "object") throw new Error("Invalid query predicate");

  switch (value.type) {
    case "comparison": {
      const definition = field(schema, value.field);

      if (!["eq", "ne", "gt", "gte", "lt", "lte"].includes(value.operator))
        throw new Error("Invalid comparison operator");

      validateValue(value.field, definition, value.value);

      if (["gt", "gte", "lt", "lte"].includes(value.operator) && value.value === null)
        throw new Error("Null only supports equality comparisons");

      return;
    }

    case "in": {
      const definition = field(schema, value.field);

      if (
        !Array.isArray(value.values) ||
        value.values.length == 0 ||
        value.values.length > MAX_IN_VALUES
      )
        throw new Error("Invalid IN value list");

      for (const item of value.values) validateValue(value.field, definition, item);

      return;
    }

    case "isNull":
    case "isMissing":
      field(schema, value.field);
      return;

    case "and":
    case "or":
      if (!Array.isArray(value.predicates) || value.predicates.length == 0)
        throw new Error(`${value.type.toUpperCase()} requires predicates`);

      for (const child of value.predicates) predicate(schema, child, depth + 1);
      return;

    case "not":
      predicate(schema, value.predicate, depth + 1);
      return;

    default:
      throw new Error("Unknown query predicate");
  }
}

export function validateQuery(
  query: LogicalQuery,
  catalog: ReadonlyMap<string, CollectionDefinition>,
): CollectionDefinition {
  if (!query || typeof query != "object" || !isValidSchemaName(query.collection))
    throw new Error("Invalid logical query");
  const schema = catalog.get(query.collection);
  if (!schema) throw new Error(`Unknown collection: ${query.collection}`);
  if (query.where) predicate(schema, query.where, 0);
  const orders = new Set<string>();
  for (const order of query.orderBy ?? []) {
    field(schema, order.field);
    if (order.direction != "ASC" && order.direction != "DESC")
      throw new Error("Invalid query order");
    if (orders.has(order.field)) throw new Error(`Duplicate order field: ${order.field}`);
    orders.add(order.field);
  }
  const projection = new Set<string>();
  for (const name of query.projection ?? []) {
    field(schema, name);
    if (projection.has(name)) throw new Error(`Duplicate projection field: ${name}`);
    projection.add(name);
  }
  if (query.projection && query.projection.length == 0)
    throw new Error("Projection cannot be empty");
  if (
    query.limit != null &&
    (!Number.isSafeInteger(query.limit) || query.limit < 0 || query.limit > 1_000_000)
  )
    throw new Error("Invalid query limit");
  if (
    query.cursor != null &&
    (typeof query.cursor != "string" || query.cursor.length == 0 || query.cursor.length > 16_384)
  )
    throw new Error("Invalid query cursor");
  return schema;
}
