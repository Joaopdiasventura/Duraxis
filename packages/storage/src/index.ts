export type { StorageDriver, StorageDriverMetrics } from "./contracts/storage-driver.interface.js";

export type { StorageObject, StorageObjectInfo } from "./types/storage-object.js";

export type { WriteCondition, WriteOptions, DeleteOptions } from "./types/storage-options.js";

export type { WriteResult, DeleteResult } from "./types/storage-result.js";

export { StorageError } from "./errors/storage.error.js";

export type { StorageErrorCode } from "./errors/storage.error.js";

export { assertStorageKey } from "./utils/assert-storage-key.js";
