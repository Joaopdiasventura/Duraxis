export { DuraxisDatabase } from "./database/duraxis-database.js";

export type { DuraxisDatabaseOptions } from "./database/duraxis-database.js";

export { Transaction } from "./transactions/transaction.js";

export type { TransactionState } from "./transactions/transaction.js";

export { TransactionConflictError } from "./errors/transaction-conflict.error.js";

export { TransactionStateError } from "./errors/transaction-state.error.js";

export { CommitOutcomeUnknownError } from "./errors/commit-outcome-unknown.error.js";

export { RecoveryManager } from "./recovery/recovery-manager.js";

export type { CommitStatus } from "./recovery/recovery-manager.js";

export { GarbageCollector } from "./gc/garbage-collector.js";

export type { GarbageCollectionOptions, GarbageCollectionReport } from "./gc/garbage-collector.js";

export { ManifestSnapshotReader } from "./snapshots/snapshot-reader.js";

export type { SnapshotReader } from "./snapshots/snapshot-reader.js";

export { ManifestReachabilityScanner } from "./gc/reachability-scanner.js";

export type { ReachabilityScanner } from "./gc/reachability-scanner.js";

export { BPlusTree } from "./indexes/bptree/bptree.js";

export type { BPlusTreeOptions } from "./indexes/bptree/bptree.js";

export { BPlusTreeNodeStore } from "./indexes/bptree/bptree-node-store.js";
export { BPlusTreeNodeCache } from "./indexes/bptree/bptree-node-cache.js";

export type {
  NodeId,
  IndexEntry,
  ScanOptions,
  ScanMetrics,
  BatchOperation,
  BPlusTreeNodeIO,
} from "./indexes/bptree/bptree-node.js";

export { BPlusTreeValidator } from "./indexes/bptree/bptree-validator.js";

export type { BPlusTreeValidationResult } from "./indexes/bptree/bptree-validator.js";

export { PrimaryIndex } from "./indexes/primary/primary-index.js";

export {
  SecondaryIndexManager,
  UniqueIndexViolationError,
} from "./indexes/secondary/secondary-index-manager.js";

export type {
  SecondaryIndexScanOptions,
  SecondaryIndexEntry,
} from "./indexes/secondary/secondary-index-manager.js";

export {
  encodeScalar,
  encodeCompositeKey,
  encodeIdentifier,
  encodeSecondaryKey,
  prefixSuccessor,
  prefixBounds,
  compositePrefixBounds,
  indexRangeBounds,
  compareBytes,
  compareIndexScalars,
} from "./indexes/index-key.js";

export type { IndexKeyPart, EncodedIndexBounds } from "./indexes/index-key.js";

export {
  validateCollection,
  normalizeCollection,
  validateDocument,
  indexFields,
  fieldDefinition,
  recordKey,
  parseRecordKey,
  indexId,
  encodeDocument,
  decodeDocument,
  indexedValue,
} from "./catalog/collection-schema.js";

export type {
  IndexScalar,
  FieldType,
  FieldDefinition,
  IndexOrder,
  IndexFieldDefinition,
  SecondaryIndexDefinition,
  CollectionDefinition,
  DocumentRecord,
} from "./catalog/collection-schema.js";

export type { CollectionRow } from "./database/duraxis-database.js";

export { QueryContext } from "./query/context/query-context.js";
export type { QueryContextOptions, QueryMetrics } from "./query/context/query-context.js";
export { validateQuery } from "./query/validation/query-validator.js";
export { encodeQueryCursor, decodeQueryCursor } from "./query/model/cursor.js";

export type {
  LogicalQuery,
  QueryPredicate,
  QueryOrder,
  ComparisonOperator,
  AccessPath,
} from "./query/model/query.js";

export { QueryExecutor } from "./query/executor/query-executor.js";
export type { QueryPage, QueryExecutorOptions } from "./query/executor/query-executor.js";
export { evaluatePredicate, compareRows } from "./query/executor/predicate.js";
export type { QueryRow } from "./query/executor/predicate.js";

export {
  PrimaryLookup,
  UniqueIndexLookup,
  SecondaryIndexScan,
  SecondaryIndexRangeScan,
  CollectionScan,
  Filter,
  Sort,
  Limit,
  Projection,
  Union,
  Intersection,
  Difference,
  QueryMemoryLimitError,
} from "./query/executor/operators/operators.js";

export type {
  QueryOperator,
  OperatorOrdering,
  SortSpillStore,
  SecondaryRange,
} from "./query/executor/operators/operators.js";

export { ReferenceQueryExecutor } from "./query/testing/reference-query-executor.js";
