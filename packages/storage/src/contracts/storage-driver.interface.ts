import type { StorageObject, StorageObjectInfo } from "../types/storage-object.js";
import type { WriteOptions, DeleteOptions } from "../types/storage-options.js";
import type { WriteResult, DeleteResult } from "../types/storage-result.js";

export interface StorageDriver {
  get(key: string): Promise<StorageObject | null>;

  put(key: string, data: Uint8Array, options: WriteOptions): Promise<WriteResult>;

  delete(key: string, options: DeleteOptions): Promise<DeleteResult>;

  list(prefix: string): Promise<readonly StorageObjectInfo[]>;
}
