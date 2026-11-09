export interface StorageObject {
  readonly data: Uint8Array;
  readonly version: string;
}

export interface StorageObjectInfo {
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
}
