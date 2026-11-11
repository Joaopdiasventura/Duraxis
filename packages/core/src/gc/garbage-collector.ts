import type { StorageDriver } from "@duraxis/storage";

import { decodeManifest, emptyManifest, type Snapshot } from "../commit/manifest.js";

import { StorageKeyManager } from "../security/storage-key-manager.js";

import { ManifestReachabilityScanner, type ReachabilityScanner } from "./reachability-scanner.js";
import { readCommitRecord } from "../commit/commit-record.js";

const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface GarbageCollectionOptions {
  readonly dryRun?: boolean;
  readonly exclusiveMaintenance?: boolean;
  readonly olderThanMs?: number;
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
  readonly continueOnError?: boolean;
}

export interface GarbageCollectionReport {
  readonly scanned: number;
  readonly nodesScanned: number;
  readonly reachable: number;
  readonly candidates: number;
  readonly deleted: number;
  readonly failed: number;
  readonly commitsScanned: number;
  readonly durationMs: number;
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
    const started = performance.now();
    const dryRun = options.dryRun != false;

    if (!dryRun && options.exclusiveMaintenance != true)
      throw new Error("Deletion requires externally guaranteed exclusive maintenance");

    if (!dryRun && this.activeSnapshots().length != 0)
      throw new Error("Cannot delete objects with active snapshots");

    const olderThanMs = options.olderThanMs ?? DEFAULT_GRACE_PERIOD_MS;

    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0)
      throw new Error("Invalid GC grace period");
    const batchSize = options.batchSize ?? 256;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100_000)
      throw new Error("Invalid GC batch size");
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("GC cancelled");

    const current = await this.storage.get(this.keys.manifestKey);

    const snapshot: Snapshot = {
      manifest: current ? decodeManifest(current.data, this.keys) : emptyManifest(),
      storageVersion: current?.version ?? null,
    };

    const reachable = new Set<string>();

    const retainedSnapshots = [snapshot, ...this.activeSnapshots()];
    for (const item of retainedSnapshots) {
      const refs = await this.scanner.scan(item);
      for (const ref of refs) reachable.add(ref);
    }

    const objects = await this.storage.list(this.keys.objectPrefix);
    const nodes = await this.storage.list(this.keys.indexNodePrefix);
    const commits = await this.storage.list(this.keys.commitPrefix);
    const reachableCommits = new Set<string>();
    for (const retained of retainedSnapshots) {
      let cursor = retained.manifest.commitHead;
      let count = 0;
      while (cursor) {
        if (reachableCommits.has(cursor)) break;
        if (++count > 1_000_000) throw new Error("Commit history scan limit exceeded during GC");
        reachableCommits.add(cursor);
        cursor = (await readCommitRecord(this.storage, this.keys, cursor)).previous;
      }
    }
    const cutoff = Date.now() - olderThanMs;

    let candidates = 0;
    let deleted = 0;
    let failed = 0;

    const candidatesForScan = [...objects, ...nodes, ...commits];
    for (let position = 0; position < candidatesForScan.length; position++) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("GC cancelled");
      const object = candidatesForScan[position]!;
      if (object.key.startsWith(this.keys.objectPrefix)) this.keys.validateObjectKey(object.key);
      else if (object.key.startsWith(this.keys.indexNodePrefix))
        this.keys.validateIndexNodeKey(object.key);
      else this.keys.validateCommitKey(object.key);

      if (!Number.isSafeInteger(object.createdAt))
        throw new Error(`Invalid object timestamp: ${object.key}`);

      if (
        reachable.has(object.key) ||
        reachableCommits.has(object.key) ||
        object.createdAt > cutoff
      )
        continue;

      candidates++;

      if (dryRun) {
        if ((position + 1) % batchSize == 0)
          await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }

      try {
        const result = await this.storage.delete(object.key, {
          condition: { type: "if-version", version: object.version },
        });
        if (result.success) deleted++;
      } catch (error) {
        failed++;
        if (!options.continueOnError) throw error;
      }
      if ((position + 1) % batchSize == 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    return {
      scanned: objects.length,
      nodesScanned: nodes.length,
      reachable: reachable.size,
      candidates,
      deleted,
      failed,
      commitsScanned: commits.length,
      durationMs: performance.now() - started,
      dryRun,
    };
  }
}
