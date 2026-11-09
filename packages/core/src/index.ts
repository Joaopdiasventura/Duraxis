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

export type {
  GarbageCollectionReport,
  ListableStorageDriver,
  StorageObjectInfo,
} from "./gc/garbage-collector.js";
