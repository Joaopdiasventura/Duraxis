import { storageCoordination } from "./storage-coordination.js";
import { ResourceScope, ResourceExhaustedError } from "../resources/resource-manager.js";
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
  readonly maxMarkBytes?: number;
  readonly maxReferences?: number;
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
    private readonly resourceParent = new ResourceScope({ workingBytes: 64 * 1024 * 1024 }),
  ) {}

  public async collect(options: GarbageCollectionOptions = {}): Promise<GarbageCollectionReport> {
    const started = performance.now();
    const dryRun = options.dryRun != false;

    if (!dryRun && options.exclusiveMaintenance != true)
      throw new Error(
        "Deletion requires explicit exclusive maintenance intent and verified driver ownership",
      );

    const coordination = storageCoordination(this.storage);

    if (coordination.maintenance) throw new Error("Maintenance is already active");

    if (!dryRun && (coordination.active || this.activeSnapshots().length))
      throw new Error("Cannot delete objects with active snapshots or operations");

    if (!dryRun && !this.storage.verifyExclusiveOwnership)
      throw new Error(
        "Destructive GC is unsupported without verified single-owner storage; shared/distributed storage must use dry-run",
      );

    if (!this.storage.iterate) throw new Error("GC requires incremental storage listing support");

    coordination.maintenance = true;

    const maxMarkBytes = options.maxMarkBytes ?? 32 * 1024 * 1024;
    const maxReferences = options.maxReferences ?? 100_000;

    if (
      !Number.isSafeInteger(maxMarkBytes) ||
      maxMarkBytes < 1 ||
      !Number.isSafeInteger(maxReferences) ||
      maxReferences < 1
    ) {
      coordination.maintenance = false;
      throw new RangeError("Invalid GC mark budget");
    }

    const resources = this.resourceParent.child({ workingBytes: maxMarkBytes * 2 });
    const reservation = resources.reserve({});

    let markBytes = 0;

    try {
      if (!dryRun) await this.storage.verifyExclusiveOwnership!();
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

      if (coordination.snapshots.size > maxReferences)
        throw new ResourceExhaustedError("gcSnapshots", maxReferences);

      const retainedSnapshots = [
        snapshot,
        ...new Set([...this.activeSnapshots(), ...coordination.snapshots]),
      ];

      const mark = (ref: string) => {
        if (reachable.has(ref)) return;

        if (reachable.size >= maxReferences)
          throw new ResourceExhaustedError("gcReferences", maxReferences);

        const size = ref.length * 2 + 64;

        if (markBytes + size > maxMarkBytes)
          throw new ResourceExhaustedError("gcMarkBytes", maxMarkBytes);

        reservation.resize({ workingBytes: markBytes + size });
        markBytes += size;
        reachable.add(ref);
      };

      for (const item of retainedSnapshots) {
        const scanLease = resources.reserve({ workingBytes: maxMarkBytes });

        try {
          const refs = await this.scanner.scan(item, {
            maxReferences,
            maxBytes: maxMarkBytes,
            signal: options.signal,
          });

          for (const ref of refs) mark(ref);
        } finally {
          scanLease.release();
        }
      }

      for (const retained of retainedSnapshots) {
        let cursor = retained.manifest.commitHead;
        let count = 0;

        while (cursor) {
          if (reachable.has(cursor)) break;
          if (++count > 1_000_000) throw new Error("Commit history scan limit exceeded during GC");

          mark(cursor);

          cursor = (await readCommitRecord(this.storage, this.keys, cursor)).previous;
        }
      }

      const cutoff = Date.now() - olderThanMs;

      let candidates = 0;
      let deleted = 0;
      let failed = 0;

      let scanned = 0;
      let nodesScanned = 0;
      let commitsScanned = 0;
      let position = 0;

      for (const prefix of [
        this.keys.objectPrefix,
        this.keys.indexNodePrefix,
        this.keys.commitPrefix,
      ])
        for await (const object of this.storage.iterate(prefix, {
          pageSize: Math.min(batchSize, 1000),
          signal: options.signal,
        })) {
          if (prefix == this.keys.objectPrefix) scanned++;
          else if (prefix == this.keys.indexNodePrefix) nodesScanned++;
          else commitsScanned++;

          position++;

          if (options.signal?.aborted) throw options.signal.reason ?? new Error("GC cancelled");

          if (object.key.startsWith(this.keys.objectPrefix))
            this.keys.validateObjectKey(object.key);
          else if (object.key.startsWith(this.keys.indexNodePrefix))
            this.keys.validateIndexNodeKey(object.key);
          else this.keys.validateCommitKey(object.key);

          if (!Number.isSafeInteger(object.createdAt))
            throw new Error(`Invalid object timestamp: ${object.key}`);

          if (reachable.has(object.key) || object.createdAt > cutoff) continue;

          candidates++;

          if (dryRun) {
            if ((position + 1) % batchSize == 0)
              await new Promise<void>((resolve) => setImmediate(resolve));
            continue;
          }

          try {
            await this.storage.verifyExclusiveOwnership!();

            const result = await this.storage.delete(object.key, {
              condition: { type: "if-version", version: object.version },
            });

            if (result.success) deleted++;
            else failed++;
          } catch (error) {
            failed++;
            if (!options.continueOnError) throw error;
          }

          if ((position + 1) % batchSize == 0)
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

      return {
        scanned,
        nodesScanned,
        reachable: reachable.size,
        candidates,
        deleted,
        failed,
        commitsScanned,
        durationMs: performance.now() - started,
        dryRun,
      };
    } finally {
      resources.close();
      coordination.maintenance = false;
    }
  }
}
