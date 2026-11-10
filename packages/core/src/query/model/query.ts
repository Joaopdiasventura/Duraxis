import type { IndexScalar, IndexOrder } from "../../catalog/collection-schema.js";

export type ComparisonOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

export type QueryPredicate =
  | {
      readonly type: "comparison";
      readonly field: string;
      readonly operator: ComparisonOperator;
      readonly value: IndexScalar;
    }
  | { readonly type: "in"; readonly field: string; readonly values: readonly IndexScalar[] }
  | { readonly type: "isNull"; readonly field: string }
  | { readonly type: "isMissing"; readonly field: string }
  | { readonly type: "and"; readonly predicates: readonly QueryPredicate[] }
  | { readonly type: "or"; readonly predicates: readonly QueryPredicate[] }
  | { readonly type: "not"; readonly predicate: QueryPredicate };

export interface QueryOrder {
  readonly field: string;
  readonly direction: IndexOrder;
}

export interface LogicalQuery {
  readonly collection: string;
  readonly where?: QueryPredicate;
  readonly orderBy?: readonly QueryOrder[];
  readonly projection?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export type AccessPath =
  | {
      readonly type: "collection-scan";
      readonly collection: string;
      readonly direction?: IndexOrder;
    }
  | { readonly type: "primary-lookup"; readonly collection: string; readonly id: string }
  | {
      readonly type: "unique-index-lookup";
      readonly collection: string;
      readonly index: string;
      readonly values: readonly IndexScalar[];
    }
  | {
      readonly type: "secondary-index-scan";
      readonly collection: string;
      readonly index: string;
      readonly direction?: IndexOrder;
    }
  | {
      readonly type: "secondary-index-range-scan";
      readonly collection: string;
      readonly index: string;
      readonly prefix?: readonly IndexScalar[];
      readonly gt?: readonly IndexScalar[];
      readonly gte?: readonly IndexScalar[];
      readonly lt?: readonly IndexScalar[];
      readonly lte?: readonly IndexScalar[];
      readonly direction?: IndexOrder;
    };
