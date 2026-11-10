import type { StorageDriver } from "@duraxis/storage";

import type { Snapshot } from "../commit/manifest.js";

import { StorageKeyManager } from "../security/storage-key-manager.js";

import { PrimaryIndex } from "../indexes/primary/primary-index.js";

export interface SnapshotReader {
  get(key: string): Promise<Uint8Array | null>;
}

export class ManifestSnapshotReader implements SnapshotReader {
  private readonly primary: PrimaryIndex;

  public constructor(
    storage: StorageDriver,
    private readonly snapshot: Snapshot,
    keys: StorageKeyManager,
  ) {
    this.primary = new PrimaryIndex(storage, keys);
  }

  public async get(key: string): Promise<Uint8Array | null> {
    return this.primary.read(this.snapshot.manifest, key);
  }
}
