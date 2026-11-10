import { randomUUID } from "node:crypto";
import type { StorageDriver } from "@duraxis/storage";

import { encodeManifest, type Manifest } from "./manifest.js";

import { encodeCommitRecord } from "./commit-record.js";
import { Transaction } from "../transactions/transaction.js";
import { TransactionConflictError } from "../errors/transaction-conflict.error.js";
import { CommitOutcomeUnknownError } from "../errors/commit-outcome-unknown.error.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";
import { PrimaryIndex } from "../indexes/primary/primary-index.js";
import { SecondaryIndexManager } from "../indexes/secondary/secondary-index-manager.js";

export class CommitCoordinator {
  private readonly primary: PrimaryIndex;
  private readonly secondary: SecondaryIndexManager;

  public constructor(
    private readonly storage: StorageDriver,
    private readonly keys = new StorageKeyManager(),
  ) {
    this.primary = new PrimaryIndex(storage, keys);
    this.secondary = new SecondaryIndexManager(storage, keys);
  }

  public async commit(transaction: Transaction): Promise<void> {
    const prepared = transaction.prepareForCommit();

    if (prepared.writes.size == 0 && prepared.schemaChanges.size == 0) {
      transaction.markCommitted();
      return;
    }

    const transactionId = randomUUID();

    const catalog = new Map(prepared.snapshot.manifest.catalog);

    for (const [name, schema] of prepared.schemaChanges) catalog.set(name, schema);

    const changes = new Map<string, string | null>();

    for (const [key, operation] of prepared.writes) {
      if (operation.type == "delete") {
        changes.set(key, null);
        continue;
      }

      const ref = this.keys.objectKey(operation.data);

      const written = await this.storage.put(ref, operation.data, {
        condition: { type: "if-absent" },
      });

      if (!written.success) throw new Error("Unexpected immutable object key collision");

      changes.set(key, ref);
    }

    const primaryRoot = await this.primary.prepare(prepared.snapshot.manifest.primaryRoot, changes);

    const indexRoots = await this.secondary.prepare(
      prepared.snapshot.manifest,
      primaryRoot,
      prepared.writes,
      catalog,
    );

    const commitBytes = encodeCommitRecord({
      format: 1,
      transactionId,
      previous: prepared.snapshot.manifest.commitHead,
    });

    const commitKey = this.keys.commitKey(transactionId, commitBytes);

    const record = await this.storage.put(commitKey, commitBytes, {
      condition: { type: "if-absent" },
    });

    if (!record.success) throw new Error("Unexpected commit record collision");

    const manifest: Manifest = {
      format: 1,
      transactionId,
      commitHead: commitKey,
      primaryRoot,
      indexRoots,
      catalog,
    };

    const manifestBytes = encodeManifest(manifest, this.keys);

    transaction.beginPublication();

    let result: Awaited<ReturnType<StorageDriver["put"]>>;

    try {
      result = await this.storage.put(this.keys.manifestKey, manifestBytes, {
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
