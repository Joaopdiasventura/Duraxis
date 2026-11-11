import type { CollectionDefinition } from "../../catalog/collection-schema.js";
import type { LogicalQuery, QueryPredicate } from "../model/query.js";
import { validateQuery } from "../validation/query-validator.js";
import { AccessPathEnumerator, type AccessCandidate } from "./access-path-enumerator.js";
import type { PhysicalPlan } from "./physical-plan.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value == "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }

  return value;
}

function best(candidates: readonly AccessCandidate[]): AccessCandidate {
  return [...candidates].sort((a, b) => {
    const tierA = a.rulePriority <= 1 ? a.rulePriority : 2;
    const tierB = b.rulePriority <= 1 ? b.rulePriority : 2;

    const rules =
      tierA - tierB || b.constrainedFields - a.constrainedFields || a.rulePriority - b.rulePriority;

    if (rules) return rules;

    const left = JSON.stringify(a.access);
    const right = JSON.stringify(b.access);

    return left < right ? -1 : left > right ? 1 : 0;
  })[0]!;
}

export class RuleBasedPlanner {
  public constructor(private readonly enumerator = new AccessPathEnumerator()) {}

  public plan(
    query: LogicalQuery,
    catalog: ReadonlyMap<string, CollectionDefinition>,
  ): PhysicalPlan {
    const schema = validateQuery(query, catalog);
    const selected = this.choose(query, schema, query.where);

    const required = query.orderBy ?? [];

    const requiresSort =
      required.length > 0 &&
      (!selected.access.deterministicOrdering ||
        selected.access.producedOrdering.length != required.length ||
        selected.access.producedOrdering.some(
          (item, index) =>
            item.field != required[index]!.field || item.direction != required[index]!.direction,
        ));

    return deepFreeze({
      format: 1,
      collection: query.collection,
      access: selected.access,
      appliedPredicates: [],
      ...(query.where ? { residualPredicate: query.where } : {}),
      producedOrdering: selected.access.producedOrdering,
      requiredOrdering: required,
      requiresSort,
      ...(query.limit != null ? { limit: query.limit } : {}),
      ...(query.projection ? { projection: query.projection } : {}),
      metadata: {
        rule: selected.reason,
        rulePriority: selected.rulePriority,
        constrainedFields: selected.constrainedFields,
      },
    });
  }

  private choose(
    query: LogicalQuery,
    schema: CollectionDefinition,
    predicate: QueryPredicate | undefined,
  ): AccessCandidate {
    if (predicate?.type == "or") {
      const branches = predicate.predicates.map((item) =>
        best(this.enumerator.enumerate({ ...query, where: item }, schema, item)),
      );

      if (branches.every((item) => item.access.type != "collection-scan"))
        return {
          access: {
            type: "union",
            collection: schema.name,
            inputs: branches.map((item) => item.access),
            producedOrdering: [],
            deterministicOrdering: false,
          },
          rulePriority: 10,
          constrainedFields: branches.reduce((sum, item) => sum + item.constrainedFields, 0),
          reason: "indexed OR union",
        };
    }

    if (predicate?.type == "and") {
      const branches = predicate.predicates
        .map((item) => best(this.enumerator.enumerate({ ...query, where: item }, schema, item)))
        .filter(
          (item) =>
            item.access.type != "collection-scan" &&
            item.access.type != "primary-lookup" &&
            item.access.type != "unique-index-lookup",
        );

      const combined = best(this.enumerator.enumerate(query, schema, predicate));

      if (combined.access.type == "primary-lookup" || combined.access.type == "unique-index-lookup")
        return combined;

      if (branches.length >= 2 && combined.constrainedFields < 2)
        return {
          access: {
            type: "intersection",
            collection: schema.name,
            inputs: branches.map((item) => item.access),
            producedOrdering: [],
            deterministicOrdering: false,
          },
          rulePriority: 12,
          constrainedFields: branches.length,
          reason: "indexed AND intersection",
        };

      return combined;
    }

    return best(this.enumerator.enumerate(query, schema, predicate));
  }
}
