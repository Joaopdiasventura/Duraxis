import { assertStorageKey, type StorageDriver } from "@duraxis/storage";

import type { Snapshot } from "../commit/manifest.js";

type PendingWrite =
  | {
      readonly type: "put";
      readonly data: Uint8Array;
    }
  | {
      readonly type: "delete";
    };

export class Transaction {
  private readonly writes = new Map<string, PendingWrite>();
  private active = true;

  public constructor(
    private readonly storage: StorageDriver,
    readonly snapshot: Snapshot,
  ) {}

  public async get(key: string): Promise<Uint8Array | null> {
    this.assertActive();
    assertStorageKey(key);

    const pending = this.writes.get(key);

    if (pending) return pending.type == "delete" ? null : new Uint8Array(pending.data);

    const objectKey = this.snapshot.manifest.entries.get(key);

    if (!objectKey) return null;

    const stored = await this.storage.get(objectKey);

    if (!stored) throw new Error(`Missing committed storage object: ${objectKey}`);

    this.assertActive();

    return new Uint8Array(stored.data);
  }

  public put(key: string, data: Uint8Array): void {
    this.assertActive();
    assertStorageKey(key);

    this.writes.set(key, {
      type: "put",
      data: new Uint8Array(data),
    });
  }

  public delete(key: string): void {
    this.assertActive();
    assertStorageKey(key);

    this.writes.set(key, {
      type: "delete",
    });
  }

  public hasPendingWrites(): boolean {
    return this.writes.size > 0;
  }

  public getPendingWrites(): ReadonlyMap<string, PendingWrite> {
    this.assertActive();

    return new Map(
      Array.from(this.writes, ([key, operation]) => [
        key,
        operation.type === "put"
          ? {
              type: "put" as const,
              data: new Uint8Array(operation.data),
            }
          : { type: "delete" as const },
      ]),
    );
  }

  public close(): void {
    this.active = false;
    this.writes.clear();
  }

  private assertActive(): void {
    if (!this.active) throw new Error("Transaction is no longer active");
  }
}
