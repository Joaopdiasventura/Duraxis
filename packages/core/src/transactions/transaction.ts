import type { StorageDriver } from "@duraxis/storage";

import type { Snapshot } from "../commit/manifest.js";
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

  private stateValue: TransactionState = "ACTIVE";
  private pendingReads = 0;

  public constructor(
    private readonly storage: StorageDriver,
    snapshot: Snapshot,
    private readonly keys: StorageKeyManager = new StorageKeyManager(),
  ) {
    this.capturedSnapshot = cloneSnapshot(snapshot);
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

      const objectKey = this.capturedSnapshot.manifest.entries.get(key);

      if (!objectKey) return null;

      this.keys.validateObjectKey(objectKey);

      const stored = await this.storage.get(objectKey);

      this.assertActive();

      if (!stored) throw new Error(`Missing committed storage object: ${objectKey}`);

      this.keys.verifyObject(objectKey, stored.data);

      return new Uint8Array(stored.data);
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
        Array.from(this.writes, ([key, item]) => [
          key,
          item.type == "put"
            ? {
                type: "put" as const,
                data: new Uint8Array(item.data),
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
    if (this.stateValue != "COMMITTING" && this.stateValue != "PREPARING")
      throw new TransactionStateError("Transaction cannot be committed in its current state");

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
      entries: new Map(snapshot.manifest.entries),
    },
  };
}
