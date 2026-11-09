import type { StorageDriver } from "@duraxis/storage";

import { decodeManifest, emptyManifest, type Snapshot } from "../commit/manifest.js";

import { StorageKeyManager } from "../security/storage-key-manager.js";

import { ManifestReachabilityScanner, type ReachabilityScanner } from "./reachability-scanner.js";

const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface GarbageCollectionOptions {
  readonly dryRun?: boolean;
  readonly exclusiveMaintenance?: boolean;
  readonly olderThanMs?: number;
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
    private readonly storage: StorageDriver,
    private readonly keys: StorageKeyManager,
    private readonly activeSnapshots: () => readonly Snapshot[],
    private readonly scanner: ReachabilityScanner = new ManifestReachabilityScanner(keys),
  ) {}

  public async collect(options: GarbageCollectionOptions = {}): Promise<GarbageCollectionReport> {
    const dryRun = options.dryRun != false;

    if (!dryRun && options.exclusiveMaintenance != true)
      throw new Error("Deletion requires externally guaranteed exclusive maintenance");

    const olderThanMs = options.olderThanMs ?? DEFAULT_GRACE_PERIOD_MS;

    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0)
      throw new Error("Invalid GC grace period");

    if (!dryRun && this.activeSnapshots().length > 0)
      throw new Error("Cannot delete objects with active snapshots");

    const current = await this.storage.get(this.keys.manifestKey);

    const currentSnapshot: Snapshot = current
      ? {
          manifest: decodeManifest(current.data, this.keys),
          storageVersion: current.version,
        }
      : {
          manifest: emptyManifest(),
          storageVersion: null,
        };

    const reachable = new Set<string>();

    const snapshots = [currentSnapshot, ...this.activeSnapshots()];

    for (const snapshot of snapshots) {
      const references = await this.scanner.scan(snapshot);
      for (const key of references) reachable.add(key);
    }

    const cutoff = Date.now() - olderThanMs;

    const objects = await this.storage.list(this.keys.objectPrefix);

    let candidates = 0;
    let deleted = 0;

    for (const object of objects) {
      this.keys.validateObjectKey(object.key);

      if (!Number.isFinite(object.createdAt) || !Number.isSafeInteger(object.createdAt))
        throw new Error(`Invalid object creation timestamp: ${object.key}`);

      if (reachable.has(object.key) || object.createdAt > cutoff) continue;

      candidates++;

      if (dryRun) continue;

      const result = await this.storage.delete(object.key, {
        condition: {
          type: "if-version",
          version: object.version,
        },
      });

      if (result.success) deleted++;
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
