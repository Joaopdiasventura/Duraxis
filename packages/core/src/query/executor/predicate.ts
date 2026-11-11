import {
  indexedValue,
  fieldDefinition,
  type CollectionDefinition,
  type DocumentRecord,
  type IndexScalar,
} from "../../catalog/collection-schema.js";
import { compareIndexScalars } from "../../indexes/index-key.js";
import type { QueryOrder, QueryPredicate } from "../model/query.js";

export interface QueryRow {
  readonly id: string;
  readonly document: DocumentRecord;
}

function value(
  schema: CollectionDefinition,
  document: DocumentRecord,
  field: string,
  id?: string,
): IndexScalar | undefined {
  if (field == "$id") return id;
  return indexedValue(document, field, fieldDefinition(schema, field));
}

function normalizeExpected(
  schema: CollectionDefinition,
  field: string,
  expected: IndexScalar,
): IndexScalar {
  if (fieldDefinition(schema, field)?.type == "date" && typeof expected == "string")
    return new Date(expected);
  return expected;
}

export function evaluatePredicate(
  schema: CollectionDefinition,
  document: DocumentRecord,
  predicate: QueryPredicate,
  id?: string,
): boolean {
  switch (predicate.type) {
    case "comparison": {
      const actual = value(schema, document, predicate.field, id);
      if (actual === undefined) return false;

      const expected = normalizeExpected(schema, predicate.field, predicate.value);
      const comparison = compareIndexScalars(actual, expected);

      switch (predicate.operator) {
        case "eq":
          return comparison == 0;
        case "ne":
          return comparison != 0;
        case "gt":
          return comparison > 0;
        case "gte":
          return comparison >= 0;
        case "lt":
          return comparison < 0;
        case "lte":
          return comparison <= 0;
      }
    }

    case "in": {
      const actual = value(schema, document, predicate.field, id);
      return (
        actual !== undefined &&
        predicate.values.some(
          (item) =>
            compareIndexScalars(actual, normalizeExpected(schema, predicate.field, item)) == 0,
        )
      );
    }

    case "isNull":
      return (
        predicate.field != "$id" &&
        Object.hasOwn(document, predicate.field) &&
        document[predicate.field] === null
      );

    case "isMissing":
      return predicate.field != "$id" && !Object.hasOwn(document, predicate.field);

    case "and":
      return predicate.predicates.every((item) => evaluatePredicate(schema, document, item, id));

    case "or":
      return predicate.predicates.some((item) => evaluatePredicate(schema, document, item, id));

    case "not":
      return !evaluatePredicate(schema, document, predicate.predicate, id);
  }
}

function compareId(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);

  for (let i = 0; i < n; i++) if (x[i] != y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length - y.length;
}

export function compareRows(
  schema: CollectionDefinition,
  orders: readonly QueryOrder[],
  a: QueryRow,
  b: QueryRow,
): number {
  for (const order of orders) {
    const av = value(schema, a.document, order.field, a.id);
    const bv = value(schema, b.document, order.field, b.id);

    let comparison: number;

    if (av === undefined || bv === undefined)
      comparison = av === bv ? 0 : av === undefined ? -1 : 1;
    else comparison = compareIndexScalars(av, bv);
    if (comparison != 0) return order.direction == "ASC" ? comparison : -comparison;
  }

  return compareId(a.id, b.id);
}
