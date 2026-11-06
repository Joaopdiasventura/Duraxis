import type { StorageDriver } from "@duraxis/storage";

import { decodeManifest, emptyManifest, type Snapshot } from "../commit/manifest.js";

import { CommitCoordinator } from "../commit/commit-coordinator.js";
import { Transaction } from "../transactions/transaction.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";

export interface DuraxisDatabaseOptions {
  readonly storage: StorageDriver;

  /**
   * Separate databases sharing a storage backend
   * must use distinct namespaces.
   */
  readonly namespace?: string;
}

export class DuraxisDatabase {
  private readonly storage: StorageDriver;
  private readonly coordinator: CommitCoordinator;
  private readonly keys: StorageKeyManager;

  public constructor(options: DuraxisDatabaseOptions) {
    this.storage = options.storage;

    this.keys = new StorageKeyManager(options.namespace);

    this.coordinator = new CommitCoordinator(this.storage, this.keys);
  }

  public async transaction<T>(callback: (tx: Transaction) => Promise<T> | T): Promise<T> {
    const snapshot = await this.createSnapshot();

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
