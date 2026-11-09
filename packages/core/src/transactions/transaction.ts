import type { StorageDriver } from "@duraxis/storage";

import type { Snapshot } from "../commit/manifest.js";

import { ManifestSnapshotReader, type SnapshotReader } from "../snapshots/snapshot-reader.js";

import { StorageKeyManager } from "../security/storage-key-manager.js";
import { TransactionStateError } from "../errors/transaction-state.error.js";

export type TransactionState =
  "ACTIVE" | "PREPARING" | "COMMITTING" | "COMMITTED" | "ABORTED" | "UNKNOWN";

export type PendingWrite =
  | {
      readonly type: "put";
      readonly data: Uint8Array;
    }
  | {
      readonly type: "delete";
    };

export interface PreparedTransaction {
  readonly snapshot: Snapshot;
  readonly writes: ReadonlyMap<string, PendingWrite>;
}

export class Transaction {
  private readonly writes = new Map<string, PendingWrite>();

  private readonly capturedSnapshot: Snapshot;
  private readonly reader: SnapshotReader;

  private stateValue: TransactionState = "ACTIVE";
  private pendingReads = 0;

  public constructor(
    storage: StorageDriver,
    snapshot: Snapshot,
    private readonly keys = new StorageKeyManager(),
  ) {
    this.capturedSnapshot = cloneSnapshot(snapshot);
    this.reader = new ManifestSnapshotReader(storage, this.capturedSnapshot, this.keys);
  }

  public get state(): TransactionState {
    return this.stateValue;
  }

  public async get(key: string): Promise<Uint8Array | null> {
    this.assertActive();
    this.keys.validateLogicalKey(key);
    this.pendingReads++;

    try {
      const pending = this.writes.get(key);

      if (pending) return pending.type == "delete" ? null : new Uint8Array(pending.data);

      const result = await this.reader.get(key);

      this.assertActive();

      return result;
    } finally {
      this.pendingReads--;
    }
  }

  public put(key: string, data: Uint8Array): void {
    this.assertActive();
    this.keys.validateLogicalKey(key);

    if (!(data instanceof Uint8Array)) throw new TypeError("Storage value must be Uint8Array");

    this.writes.set(key, {
      type: "put",
      data: new Uint8Array(data),
    });
  }

  public delete(key: string): void {
    this.assertActive();
    this.keys.validateLogicalKey(key);

    this.writes.set(key, {
      type: "delete",
    });
  }

  public prepareForCommit(): PreparedTransaction {
    this.assertActive();

    if (this.pendingReads > 0)
      throw new TransactionStateError("Transaction has pending reads; await all tx.get() calls");

    this.stateValue = "PREPARING";

    return {
      snapshot: cloneSnapshot(this.capturedSnapshot),
      writes: new Map(
        [...this.writes].map(([key, operation]) => [
          key,
          operation.type == "put"
            ? {
                type: "put" as const,
                data: new Uint8Array(operation.data),
              }
            : {
                type: "delete" as const,
              },
        ]),
      ),
    };
  }

  public beginPublication(): void {
    if (this.stateValue != "PREPARING")
      throw new TransactionStateError("Transaction is not preparing");
    this.stateValue = "COMMITTING";
  }

  public markCommitted(): void {
    if (this.stateValue != "PREPARING" && this.stateValue != "COMMITTING")
      throw new TransactionStateError("Invalid transaction state");
    this.stateValue = "COMMITTED";
  }

  public markUnknown(): void {
    this.stateValue = "UNKNOWN";
  }

  public abort(): void {
    if (this.stateValue != "COMMITTED" && this.stateValue != "UNKNOWN") this.stateValue = "ABORTED";
  }

  public close(): void {
    if (this.stateValue == "ACTIVE" || this.stateValue == "PREPARING") this.abort();
    this.writes.clear();
  }

  private assertActive(): void {
    if (this.stateValue != "ACTIVE")
      throw new TransactionStateError("Transaction is no longer active");
  }
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    storageVersion: snapshot.storageVersion,
    manifest: {
      format: 1,
      transactionId: snapshot.manifest.transactionId,
      commitHead: snapshot.manifest.commitHead ?? null,
      entries: new Map(snapshot.manifest.entries),
    },
  };
}
