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
  readonly nodesScanned: number;
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
    private readonly scanner: ReachabilityScanner = new ManifestReachabilityScanner(keys, storage),
  ) {}

  public async collect(options: GarbageCollectionOptions = {}): Promise<GarbageCollectionReport> {
    const dryRun = options.dryRun != false;

    if (!dryRun && options.exclusiveMaintenance != true)
      throw new Error("Deletion requires externally guaranteed exclusive maintenance");

    if (!dryRun && this.activeSnapshots().length != 0)
      throw new Error("Cannot delete objects with active snapshots");

    const olderThanMs = options.olderThanMs ?? DEFAULT_GRACE_PERIOD_MS;

    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0)
      throw new Error("Invalid GC grace period");

    const current = await this.storage.get(this.keys.manifestKey);

    const snapshot: Snapshot = {
      manifest: current ? decodeManifest(current.data, this.keys) : emptyManifest(),
      storageVersion: current?.version ?? null,
    };

    const reachable = new Set<string>();

    for (const item of [snapshot, ...this.activeSnapshots()]) {
      const refs = await this.scanner.scan(item);
      for (const ref of refs) reachable.add(ref);
    }

    const objects = await this.storage.list(this.keys.objectPrefix);
    const nodes = await this.storage.list(this.keys.indexNodePrefix);
    const cutoff = Date.now() - olderThanMs;

    let candidates = 0;
    let deleted = 0;

    for (const object of [...objects, ...nodes]) {
      if (object.key.startsWith(this.keys.objectPrefix)) this.keys.validateObjectKey(object.key);
      else this.keys.validateIndexNodeKey(object.key);

      if (!Number.isSafeInteger(object.createdAt))
        throw new Error(`Invalid object timestamp: ${object.key}`);

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
      nodesScanned: nodes.length,
      reachable: reachable.size,
      candidates,
      deleted,
      dryRun,
    };
  }
}
