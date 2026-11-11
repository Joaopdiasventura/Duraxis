import {
  fieldDefinition,
  type CollectionDefinition,
  type IndexScalar,
} from "../../catalog/collection-schema.js";
import { compareIndexScalars } from "../../indexes/index-key.js";
import type { QueryPredicate } from "../model/query.js";

export interface FieldConstraint {
  readonly field: string;
  readonly hasEquality: boolean;
  readonly equality?: IndexScalar;
  readonly in?: readonly IndexScalar[];
  readonly gt?: IndexScalar;
  readonly gte?: IndexScalar;
  readonly lt?: IndexScalar;
  readonly lte?: IndexScalar;
  readonly predicates: readonly QueryPredicate[];
}

export interface PredicateAnalysis {
  readonly conjunctive: boolean;
  readonly constraints: ReadonlyMap<string, FieldConstraint>;
  readonly conjuncts: readonly QueryPredicate[];
}

function normalized(schema: CollectionDefinition, field: string, value: IndexScalar): IndexScalar {
  return fieldDefinition(schema, field)?.type == "date" && typeof value == "string"
    ? new Date(value)
    : value;
}

function strongerLower(
  current: { value: IndexScalar; inclusive: boolean } | undefined,
  candidate: { value: IndexScalar; inclusive: boolean },
) {
  if (!current) return candidate;

  const comparison = compareIndexScalars(candidate.value, current.value);
  if (comparison > 0 || (comparison == 0 && !candidate.inclusive)) return candidate;

  return current;
}

function strongerUpper(
  current: { value: IndexScalar; inclusive: boolean } | undefined,
  candidate: { value: IndexScalar; inclusive: boolean },
) {
  if (!current) return candidate;

  const comparison = compareIndexScalars(candidate.value, current.value);
  if (comparison < 0 || (comparison == 0 && !candidate.inclusive)) return candidate;

  return current;
}

export class PredicateAnalyzer {
  public analyze(
    predicate: QueryPredicate | undefined,
    schema: CollectionDefinition,
  ): PredicateAnalysis {
    if (!predicate) return { conjunctive: true, constraints: new Map(), conjuncts: [] };

    const conjuncts = this.flattenAnd(predicate);
    if (!conjuncts) return { conjunctive: false, constraints: new Map(), conjuncts: [predicate] };

    const mutable = new Map<
      string,
      {
        hasEquality: boolean;
        equality?: IndexScalar;
        in?: readonly IndexScalar[];
        lower?: { value: IndexScalar; inclusive: boolean };
        upper?: { value: IndexScalar; inclusive: boolean };
        predicates: QueryPredicate[];
      }
    >();

    for (const item of conjuncts) {
      let field: string | undefined;
      if (item.type == "comparison" || item.type == "in" || item.type == "isNull")
        field = item.field;

      if (!field) continue;

      const target = mutable.get(field) ?? { hasEquality: false, predicates: [] };

      target.predicates.push(item);

      if (item.type == "isNull") {
        target.hasEquality = true;
        target.equality = null;
      } else if (item.type == "in") {
        target.in = item.values.map((value) => normalized(schema, field!, value));
      } else if (item.type == "comparison" && item.operator == "eq") {
        target.hasEquality = true;
        target.equality = normalized(schema, field, item.value);
      } else if (item.type == "comparison" && (item.operator == "gt" || item.operator == "gte")) {
        target.lower = strongerLower(target.lower, {
          value: normalized(schema, field, item.value),
          inclusive: item.operator == "gte",
        });
      } else if (item.type == "comparison" && (item.operator == "lt" || item.operator == "lte")) {
        target.upper = strongerUpper(target.upper, {
          value: normalized(schema, field, item.value),
          inclusive: item.operator == "lte",
        });
      }

      mutable.set(field, target);
    }

    const constraints = new Map<string, FieldConstraint>();

    for (const [field, value] of mutable)
      constraints.set(field, {
        field,
        hasEquality: value.hasEquality,
        ...(value.hasEquality ? { equality: value.equality } : {}),
        ...(value.in ? { in: value.in } : {}),
        ...(value.lower
          ? value.lower.inclusive
            ? { gte: value.lower.value }
            : { gt: value.lower.value }
          : {}),
        ...(value.upper
          ? value.upper.inclusive
            ? { lte: value.upper.value }
            : { lt: value.upper.value }
          : {}),
        predicates: value.predicates,
      });

    return { conjunctive: true, constraints, conjuncts };
  }

  private flattenAnd(predicate: QueryPredicate): QueryPredicate[] | null {
    if (predicate.type != "and")
      return predicate.type == "or" || predicate.type == "not" ? null : [predicate];

    const result: QueryPredicate[] = [];

    for (const item of predicate.predicates) {
      const nested = this.flattenAnd(item);
      if (!nested) return null;
      result.push(...nested);
    }

    return result;
  }
}
