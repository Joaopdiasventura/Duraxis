import type { DocumentRecord, IndexScalar } from "../../catalog/collection-schema.js";
import type { LogicalIndexRange, QueryOrder, QueryPredicate } from "../model/query.js";

interface AccessBase {
  readonly collection: string;
  readonly producedOrdering: readonly QueryOrder[];
  readonly deterministicOrdering: boolean;
}

export type PhysicalAccess =
  | (AccessBase & { readonly type: "collection-scan" })
  | (AccessBase & { readonly type: "primary-lookup"; readonly id: string })
  | (AccessBase & {
      readonly type: "unique-index-lookup";
      readonly index: string;
      readonly values: readonly IndexScalar[];
    })
  | (AccessBase & {
      readonly type: "secondary-index-scan";
      readonly index: string;
      readonly direction: "ASC" | "DESC";
    })
  | (AccessBase & {
      readonly type: "secondary-index-range-scan";
      readonly index: string;
      readonly prefix: readonly IndexScalar[];
      readonly range?: LogicalIndexRange;
      readonly direction: "ASC" | "DESC";
    })
  | (AccessBase & { readonly type: "union"; readonly inputs: readonly PhysicalAccess[] })
  | (AccessBase & { readonly type: "intersection"; readonly inputs: readonly PhysicalAccess[] });

export interface PhysicalPlan {
  readonly format: 1;
  readonly collection: string;
  readonly access: PhysicalAccess;
  readonly appliedPredicates: readonly QueryPredicate[];
  readonly residualPredicate?: QueryPredicate;
  readonly producedOrdering: readonly QueryOrder[];
  readonly requiredOrdering: readonly QueryOrder[];
  readonly requiresSort: boolean;
  readonly limit?: number;
  readonly projection?: readonly string[];
  readonly metadata: Readonly<DocumentRecord>;
}

export interface ExplainResult {
  readonly plan: PhysicalPlan;
  readonly selectedIndexes: readonly string[];
  readonly operators: readonly string[];
  readonly residualFilter: QueryPredicate | null;
}
