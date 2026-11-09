import type { StorageDriver } from "@duraxis/storage";

import { decodeManifest, emptyManifest, type Snapshot } from "../commit/manifest.js";

import { StorageKeyManager } from "../security/storage-key-manager.js";

const MS_LIMIT = 24 * 60 * 60 * 1000;

export interface StorageObjectInfo {
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
}

export interface ListableStorageDriver extends StorageDriver {
  list(prefix: string): Promise<readonly StorageObjectInfo[]>;
}

export interface GarbageCollectionReport {
  readonly scanned: number;
  readonly reachable: number;
  readonly candidates: number;
  readonly deleted: number;
  readonly dryRun: boolean;
}

export class GarbageCollector {
  public constructor(
    private readonly storage: ListableStorageDriver,
    private readonly keys: StorageKeyManager,
    private readonly activeSnapshots: () => readonly Snapshot[],
  ) {}

  public async collect(
    options: {
      dryRun?: boolean;
      exclusiveMaintenance?: boolean;
      olderThanMs?: number;
    } = {},
  ): Promise<GarbageCollectionReport> {
    const dryRun = options.dryRun != false;

    if (!dryRun && options.exclusiveMaintenance != true)
      throw new Error("Deletion requires externally guaranteed exclusive maintenance");

    if (!dryRun && this.activeSnapshots().length != 0)
      throw new Error("Cannot delete objects with active snapshots");

    const stored = await this.storage.get(this.keys.manifestKey);

    const manifest = stored ? decodeManifest(stored.data, this.keys) : emptyManifest();

    const reachable = new Set<string>(manifest.entries.values());

    for (const snapshot of this.activeSnapshots())
      for (const key of snapshot.manifest.entries.values()) reachable.add(key);

    const olderThanMs = options.olderThanMs ?? MS_LIMIT;

    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0)
      throw new Error("Invalid GC grace period");

    const cutoff = Date.now() - olderThanMs;

    const objects = await this.storage.list(this.keys.objectPrefix);

    let candidates = 0;
    let deleted = 0;

    for (const object of objects) {
      this.keys.validateObjectKey(object.key);

      if (reachable.has(object.key) || object.createdAt > cutoff) continue;

      candidates++;

      if (!dryRun) {
        const result = await this.storage.delete(object.key, {
          condition: {
            type: "if-version",
            version: object.version,
          },
        });

        if (result.success) deleted++;
      }
    }

    return {
      scanned: objects.length,
      reachable: reachable.size,
      candidates,
      deleted,
      dryRun,
    };
  }
}
