import type { StorageDriver } from "@duraxis/storage";

import { MANIFEST_KEY, decodeManifest, emptyManifest, type Snapshot } from "../commit/manifest.js";
import { CommitCoordinator } from "../commit/commit-coordinator.js";
import { Transaction } from "../transactions/transaction.js";

export interface DuraxisDatabaseOptions {
  readonly storage: StorageDriver;
}

export class DuraxisDatabase {
  private readonly storage: StorageDriver;
  private readonly coordinator: CommitCoordinator;

  public constructor(options: DuraxisDatabaseOptions) {
    this.storage = options.storage;
    this.coordinator = new CommitCoordinator(this.storage);
  }

  public async transaction<T>(callback: (tx: Transaction) => Promise<T> | T): Promise<T> {
    const snapshot = await this.createSnapshot();
    const tx = new Transaction(this.storage, snapshot);

    try {
      const result = await callback(tx);

      await this.coordinator.commit(tx);

      return result;
    } finally {
      tx.close();
    }
  }

  private async createSnapshot(): Promise<Snapshot> {
    const stored = await this.storage.get(MANIFEST_KEY);

    return stored
      ? {
          manifest: decodeManifest(stored.data),
          storageVersion: stored.version,
        }
      : {
          manifest: emptyManifest(),
          storageVersion: null,
        };
  }
}
