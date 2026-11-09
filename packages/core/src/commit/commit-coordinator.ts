import { randomUUID } from "node:crypto";

import type { StorageDriver } from "@duraxis/storage";

import { encodeManifest, type Manifest } from "./manifest.js";

import { encodeCommitRecord } from "./commit-record.js";
import { Transaction } from "../transactions/transaction.js";
import { TransactionConflictError } from "../errors/transaction-conflict.error.js";
import { CommitOutcomeUnknownError } from "../errors/commit-outcome-unknown.error.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";

export class CommitCoordinator {
  public constructor(
    private readonly storage: StorageDriver,
    private readonly keys = new StorageKeyManager(),
  ) {}

  public async commit(transaction: Transaction): Promise<void> {
    const prepared = transaction.prepareForCommit();

    if (prepared.writes.size == 0) {
      transaction.markCommitted();
      return;
    }

    const transactionId = randomUUID();

    const entries = new Map(prepared.snapshot.manifest.entries);

    for (const [key, operation] of prepared.writes) {
      if (operation.type == "delete") {
        entries.delete(key);
        continue;
      }

      const objectKey = this.keys.objectKey(operation.data);

      const result = await this.storage.put(objectKey, operation.data, {
        condition: {
          type: "if-absent",
        },
      });

      if (!result.success) throw new Error("Unexpected immutable object key collision");

      entries.set(key, objectKey);
    }

    const commitBytes = encodeCommitRecord({
      format: 1,
      transactionId,
      previous: prepared.snapshot.manifest.commitHead ?? null,
    });

    const commitKey = this.keys.commitKey(transactionId, commitBytes);

    const recordResult = await this.storage.put(commitKey, commitBytes, {
      condition: {
        type: "if-absent",
      },
    });

    if (!recordResult.success) throw new Error("Unexpected commit record collision");

    const manifest: Manifest = {
      format: 1,
      transactionId,
      commitHead: commitKey,
      entries,
    };

    const bytes = encodeManifest(manifest);

    transaction.beginPublication();

    let result;

    try {
      result = await this.storage.put(this.keys.manifestKey, bytes, {
        condition:
          prepared.snapshot.storageVersion == null
            ? { type: "if-absent" }
            : {
                type: "if-version",
                version: prepared.snapshot.storageVersion,
              },
      });
    } catch (cause) {
      transaction.markUnknown();

      throw new CommitOutcomeUnknownError(transactionId, cause);
    }

    if (!result.success) throw new TransactionConflictError();

    transaction.markCommitted();
  }
}
