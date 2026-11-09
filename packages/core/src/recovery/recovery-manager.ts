import type { StorageDriver } from "@duraxis/storage";

import { decodeManifest, emptyManifest } from "../commit/manifest.js";

import { readCommitRecord } from "../commit/commit-record.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";

export type CommitStatus = "committed" | "unknown";

export class RecoveryManager {
  public constructor(
    private readonly storage: StorageDriver,
    private readonly keys: StorageKeyManager,
  ) {}

  public async getCommitStatus(transactionId: string): Promise<CommitStatus> {
    const stored = await this.storage.get(this.keys.manifestKey);

    const manifest = stored ? decodeManifest(stored.data, this.keys) : emptyManifest();

    if (manifest.transactionId == transactionId) return "committed";

    let cursor = manifest.commitHead ?? null;
    const seen = new Set<string>();

    while (cursor) {
      if (seen.has(cursor)) throw new Error("Commit history cycle detected");

      seen.add(cursor);

      const record = await readCommitRecord(this.storage, this.keys, cursor);

      if (record.transactionId == transactionId) return "committed";

      cursor = record.previous;

      if (seen.size > 1_000_000) throw new Error("Commit history scan limit exceeded");
    }

    return "unknown";
  }

  public async verifyHistory(): Promise<number> {
    const stored = await this.storage.get(this.keys.manifestKey);

    if (!stored) return 0;

    const manifest = decodeManifest(stored.data, this.keys);

    let cursor = manifest.commitHead ?? null;
    let count = 0;

    const seen = new Set<string>();
    let expectedId = manifest.transactionId;

    while (cursor) {
      if (seen.has(cursor)) throw new Error("Commit history cycle detected");

      seen.add(cursor);

      const record = await readCommitRecord(this.storage, this.keys, cursor);

      if (count == 0 && record.transactionId != expectedId)
        throw new Error("Broken commit history link");

      expectedId = "";
      cursor = record.previous;
      count++;
    }

    return count;
  }
}
