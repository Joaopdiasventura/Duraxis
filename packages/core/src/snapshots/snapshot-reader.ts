import type { StorageDriver } from "@duraxis/storage";

import type { Snapshot } from "../commit/manifest.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";

export interface SnapshotReader {
  get(key: string): Promise<Uint8Array | null>;
}

export class ManifestSnapshotReader implements SnapshotReader {
  public constructor(
    private readonly storage: StorageDriver,
    private readonly snapshot: Snapshot,
    private readonly keys: StorageKeyManager,
  ) {}

  public async get(key: string): Promise<Uint8Array | null> {
    this.keys.validateLogicalKey(key);

    const objectKey = this.snapshot.manifest.entries.get(key);

    if (!objectKey) return null;

    this.keys.validateObjectKey(objectKey);

    const stored = await this.storage.get(objectKey);

    if (!stored) throw new Error(`Missing committed storage object: ${objectKey}`);

    this.keys.verifyObject(objectKey, stored.data);

    return new Uint8Array(stored.data);
  }
}
