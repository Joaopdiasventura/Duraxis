import type { StorageDriver } from "@duraxis/storage";

import { decodeManifest, emptyManifest, type Snapshot } from "../commit/manifest.js";

import { CommitCoordinator } from "../commit/commit-coordinator.js";
import { Transaction } from "../transactions/transaction.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";
import { RecoveryManager } from "../recovery/recovery-manager.js";
import type { SnapshotReader } from "../snapshots/snapshot-reader.js";

import {
  GarbageCollector,
  type GarbageCollectionOptions,
  type GarbageCollectionReport,
} from "../gc/garbage-collector.js";

export interface DuraxisDatabaseOptions {
  readonly storage: StorageDriver;
  readonly namespace?: string;
}

export class DuraxisDatabase {
  private readonly storage: StorageDriver;
  private readonly coordinator: CommitCoordinator;
  private readonly keys: StorageKeyManager;
  private readonly recovery: RecoveryManager;

  private readonly active = new Set<Snapshot>();
  private maintenance = false;
  private pendingSnapshotAcquisitions = 0;

  public constructor(options: DuraxisDatabaseOptions) {
    this.storage = options.storage;
    this.keys = new StorageKeyManager(options.namespace);

    this.coordinator = new CommitCoordinator(this.storage, this.keys);

    this.recovery = new RecoveryManager(this.storage, this.keys);
  }

  public async transaction<T>(callback: (tx: Transaction) => Promise<T> | T): Promise<T> {
    const snapshot = await this.acquireSnapshot();
    const tx = new Transaction(this.storage, snapshot, this.keys);

    try {
      const result = await callback(tx);
      await this.coordinator.commit(tx);
      return result;
    } catch (error) {
      tx.abort();
      throw error;
    } finally {
      tx.close();
      this.active.delete(snapshot);
    }
  }

  public async snapshot<T>(callback: (reader: SnapshotReader) => Promise<T> | T): Promise<T> {
    const snapshot = await this.acquireSnapshot();
    const tx = new Transaction(this.storage, snapshot, this.keys);

    try {
      return await callback({
        get: (key: string) => tx.get(key),
      });
    } finally {
      tx.close();
      this.active.delete(snapshot);
    }
  }

  public async getCommitStatus(transactionId: string) {
    return this.recovery.getCommitStatus(transactionId);
  }

  public async verifyHistory(): Promise<number> {
    return this.recovery.verifyHistory();
  }

  public async verifyIntegrity(): Promise<{
    objects: number;
    commits: number;
  }> {
    const snapshot = await this.acquireSnapshot();

    try {
      let objects = 0;

      for (const ref of snapshot.manifest.entries.values()) {
        this.keys.validateObjectKey(ref);

        const stored = await this.storage.get(ref);

        if (!stored) throw new Error(`Missing committed object: ${ref}`);

        this.keys.verifyObject(ref, stored.data);
        objects++;
      }

      const commits = await this.recovery.verifyHistory();

      return { objects, commits };
    } finally {
      this.active.delete(snapshot);
    }
  }

  public async collectGarbage(
    storage: StorageDriver,
    options: GarbageCollectionOptions = {},
  ): Promise<GarbageCollectionReport> {
    if (storage != this.storage) throw new Error("GC driver must match database storage");
    if (this.maintenance) throw new Error("Maintenance already active");

    this.maintenance = true;

    try {
      if (options.dryRun == false)
        if (this.active.size > 0 || this.pendingSnapshotAcquisitions > 0)
          throw new Error("Active transactions or pending snapshots prevent GC");

      const collector = new GarbageCollector(this.storage, this.keys, () => [...this.active]);

      return await collector.collect(options);
    } finally {
      this.maintenance = false;
    }
  }

  private async acquireSnapshot(): Promise<Snapshot> {
    if (this.maintenance) throw new Error("Database is in exclusive maintenance mode");

    this.pendingSnapshotAcquisitions++;

    try {
      const snapshot = await this.createSnapshot();

      if (this.maintenance) throw new Error("Database is in exclusive maintenance mode");

      this.active.add(snapshot);

      return snapshot;
    } finally {
      this.pendingSnapshotAcquisitions--;
    }
  }

  private async createSnapshot(): Promise<Snapshot> {
    const stored = await this.storage.get(this.keys.manifestKey);
    return stored
      ? {
          manifest: decodeManifest(stored.data, this.keys),
          storageVersion: stored.version,
        }
      : {
          manifest: emptyManifest(),
          storageVersion: null,
        };
  }
}
