import type { StorageObject, StorageObjectInfo } from "../types/storage-object.js";
import type { WriteOptions, DeleteOptions } from "../types/storage-options.js";
import type { WriteResult, DeleteResult } from "../types/storage-result.js";

export interface StorageDriverMetrics {
  readonly reads: number;
  readonly writes: number;
  readonly deletes: number;
  readonly lists: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  readonly synchronizationWaitMs: number;
}

export interface StorageReadOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
}

export interface StorageIterationOptions {
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
}

export interface StorageDriver {
  readonly capabilities?: { readonly boundedReads: boolean };

  iterate?(prefix: string, options?: StorageIterationOptions): AsyncIterable<StorageObjectInfo>;

  verifyExclusiveOwnership?(): Promise<void>;

  get(key: string, options?: StorageReadOptions): Promise<StorageObject | null>;

  put(key: string, data: Uint8Array, options: WriteOptions): Promise<WriteResult>;

  delete(key: string, options: DeleteOptions): Promise<DeleteResult>;

  list(prefix: string): Promise<readonly StorageObjectInfo[]>;

  close?(): Promise<void>;

  getMetrics?(): Readonly<StorageDriverMetrics>;
}
