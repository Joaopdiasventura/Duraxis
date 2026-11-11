import {
  indexFields,
  type CollectionDefinition,
  type IndexScalar,
} from "../../catalog/collection-schema.js";
import type { LogicalQuery, QueryOrder, QueryPredicate } from "../model/query.js";
import type { PhysicalAccess } from "./physical-plan.js";
import { PredicateAnalyzer, type FieldConstraint } from "./predicate-analyzer.js";

export interface AccessCandidate {
  readonly access: PhysicalAccess;
  readonly rulePriority: number;
  readonly constrainedFields: number;
  readonly reason: string;
}

function ordering(
  fields: readonly QueryOrder[],
): Pick<PhysicalAccess, "producedOrdering" | "deterministicOrdering"> {
  return { producedOrdering: fields, deterministicOrdering: true };
}

function noOrdering(): Pick<PhysicalAccess, "producedOrdering" | "deterministicOrdering"> {
  return { producedOrdering: [], deterministicOrdering: false };
}

function sameOrder(a: readonly QueryOrder[], b: readonly QueryOrder[]): boolean {
  return (
    a.length == b.length &&
    a.every(
      (field, index) => field.field == b[index]!.field && field.direction == b[index]!.direction,
    )
  );
}

function logicalRange(constraint: FieldConstraint) {
  return {
    ...(constraint.gt !== undefined ? { gt: constraint.gt } : {}),
    ...(constraint.gte !== undefined ? { gte: constraint.gte } : {}),
    ...(constraint.lt !== undefined ? { lt: constraint.lt } : {}),
    ...(constraint.lte !== undefined ? { lte: constraint.lte } : {}),
  };
}

export class AccessPathEnumerator {
  public constructor(private readonly analyzer = new PredicateAnalyzer()) {}

  public enumerate(
    query: LogicalQuery,
    schema: CollectionDefinition,
    predicate: QueryPredicate | undefined = query.where,
  ): readonly AccessCandidate[] {
    const candidates: AccessCandidate[] = [
      {
        access: { type: "collection-scan", collection: schema.name, ...noOrdering() },
        rulePriority: 100,
        constrainedFields: 0,
        reason: "fallback collection scan",
      },
    ];

    const analysis = this.analyzer.analyze(predicate, schema);
    if (!analysis.conjunctive) return candidates;

    const id = analysis.constraints.get("$id");
    if (id?.hasEquality && typeof id.equality == "string")
      candidates.push({
        access: {
          type: "primary-lookup",
          collection: schema.name,
          id: id.equality,
          ...ordering([]),
        },
        rulePriority: 0,
        constrainedFields: 1,
        reason: "primary key equality",
      });

    for (const index of schema.indexes) {
      const fields = indexFields(index);
      const prefix: IndexScalar[] = [];

      for (const part of fields) {
        const constraint = analysis.constraints.get(part.field);
        if (!constraint?.hasEquality) break;
        prefix.push(constraint.equality!);
      }

      const next = fields[prefix.length];
      const rangeConstraint = next ? analysis.constraints.get(next.field) : undefined;

      const hasRange =
        rangeConstraint != null &&
        [rangeConstraint.gt, rangeConstraint.gte, rangeConstraint.lt, rangeConstraint.lte].some(
          (value) => value !== undefined,
        );

      const physicalOrder = fields.map((field) => ({ field: field.field, direction: field.order }));
      const requested = query.orderBy ?? [];

      const remainingOrder = physicalOrder.slice(prefix.length);
      const satisfies = sameOrder(requested, physicalOrder) || sameOrder(requested, remainingOrder);

      const produced = satisfies ? requested : physicalOrder;

      if (prefix.length == fields.length && index.unique) {
        candidates.push({
          access: {
            type: "unique-index-lookup",
            collection: schema.name,
            index: index.name,
            values: prefix,
            ...ordering([]),
          },
          rulePriority: 1,
          constrainedFields: prefix.length,
          reason: "complete unique-index equality",
        });
        continue;
      }

      if (prefix.length || hasRange) {
        candidates.push({
          access: {
            type: "secondary-index-range-scan",
            collection: schema.name,
            index: index.name,
            prefix,
            ...(hasRange ? { range: logicalRange(rangeConstraint!) } : {}),
            direction: "ASC",
            ...(satisfies ? ordering(produced) : noOrdering()),
          },
          rulePriority: hasRange ? 30 - prefix.length : 20 - prefix.length,
          constrainedFields: prefix.length + Number(hasRange),
          reason: hasRange ? "compound prefix plus logical range" : "compound equality prefix",
        });
      } else if (query.orderBy && satisfies) {
        candidates.push({
          access: {
            type: "secondary-index-scan",
            collection: schema.name,
            index: index.name,
            direction: "ASC",
            ...ordering(produced),
          },
          rulePriority: 80,
          constrainedFields: 0,
          reason: "index provides requested ordering",
        });
      }

      const first = analysis.constraints.get(fields[0]!.field);

      if (first?.in && first.in.length <= 64) {
        const inputs: PhysicalAccess[] = first.in.map(
          (value) =>
            ({
              type:
                index.unique && fields.length == 1
                  ? "unique-index-lookup"
                  : "secondary-index-range-scan",
              collection: schema.name,
              index: index.name,
              ...(index.unique && fields.length == 1
                ? { values: [value] }
                : { prefix: [value], direction: "ASC" as const }),
              ...noOrdering(),
            }) as PhysicalAccess,
        );

        candidates.push({
          access: { type: "union", collection: schema.name, inputs, ...noOrdering() },
          rulePriority: 15,
          constrainedFields: 1,
          reason: "bounded IN expansion",
        });
      }
    }
    
    return candidates;
  }
}
