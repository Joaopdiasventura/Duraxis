import { indexFields, type CollectionDefinition } from "../../catalog/collection-schema.js";
import {
  CollectionScan,
  Intersection,
  PrimaryLookup,
  SecondaryIndexRangeScan,
  SecondaryIndexScan,
  Union,
  UniqueIndexLookup,
  type OperatorOrdering,
  type QueryOperator,
} from "../executor/operators/operators.js";
import type { PhysicalAccess, PhysicalPlan } from "./physical-plan.js";

export class PlanCompiler {
  public compile(
    plan: PhysicalPlan,
    catalog: ReadonlyMap<string, CollectionDefinition>,
  ): QueryOperator {
    if (!plan || plan.format != 1 || typeof plan.collection != "string")
      throw new Error("Invalid physical plan");

    if (plan.limit != null && (!Number.isSafeInteger(plan.limit) || plan.limit < 0))
      throw new Error("Invalid physical plan limit");

    const schema = catalog.get(plan.collection);
    if (!schema) throw new Error(`Physical plan references unknown collection: ${plan.collection}`);

    return this.access(plan.access, schema, 0, new Set());
  }

  private access(
    access: PhysicalAccess,
    schema: CollectionDefinition,
    depth: number,
    seen: Set<object>,
  ): QueryOperator {
    if (!access || typeof access != "object" || depth > 64 || seen.has(access))
      throw new Error("Invalid or cyclic physical access plan");

    seen.add(access);

    try {
      if (access.collection != schema.name) throw new Error("Physical plan crosses collections");

      const ordering: OperatorOrdering | undefined = access.deterministicOrdering
        ? { fields: access.producedOrdering, deterministic: true }
        : undefined;

      switch (access.type) {
        case "collection-scan":
          return new CollectionScan(schema.name);

        case "primary-lookup":
          return new PrimaryLookup(schema.name, access.id);

        case "unique-index-lookup": {
          const index = this.index(schema, access.index);
          if (!index.unique || access.values.length != indexFields(index).length)
            throw new Error("Invalid unique-index physical lookup");

          return new UniqueIndexLookup(schema.name, index.name, access.values);
        }

        case "secondary-index-scan":
          this.index(schema, access.index);
          return new SecondaryIndexScan(schema.name, access.index, access.direction, ordering);

        case "secondary-index-range-scan": {
          const index = this.index(schema, access.index);

          if (access.prefix.length > indexFields(index).length)
            throw new Error("Invalid physical compound prefix");

          return new SecondaryIndexRangeScan(
            schema.name,
            access.index,
            { prefix: access.prefix, range: access.range },
            access.direction,
            ordering,
          );
        }

        case "union":
          return new Union(access.inputs.map((item) => this.access(item, schema, depth + 1, seen)));

        case "intersection":
          return new Intersection(
            access.inputs.map((item) => this.access(item, schema, depth + 1, seen)),
          );
      }
    } finally {
      seen.delete(access);
    }
  }

  private index(schema: CollectionDefinition, name: string) {
    const index = schema.indexes.find((item) => item.name == name);
    if (!index) throw new Error(`Physical plan references unknown index: ${schema.name}/${name}`);
    return index;
  }
}
