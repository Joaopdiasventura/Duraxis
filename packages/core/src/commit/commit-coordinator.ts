import { PreparedWrites } from "../resources/prepared-writes.js";
import { coordinateCommit } from "../gc/storage-coordination.js";
import { QueryContext } from "../query/context/query-context.js";
import { recordKey, validateDocument, encodeDocument } from "../catalog/collection-schema.js";

import type { StorageDriver } from "@duraxis/storage";

import { encodeManifest, type Manifest } from "./manifest.js";

import { encodeCommitRecord } from "./commit-record.js";
import { Transaction } from "../transactions/transaction.js";
import { TransactionConflictError } from "../errors/transaction-conflict.error.js";
import { CommitOutcomeUnknownError } from "../errors/commit-outcome-unknown.error.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";
import { PrimaryIndex } from "../indexes/primary/primary-index.js";
import { SecondaryIndexManager } from "../indexes/secondary/secondary-index-manager.js";
import { ForeignKeyManager } from "../relations/foreign-key-manager.js";

export class CommitCoordinator {
  private readonly primary: PrimaryIndex;
  private readonly secondary: SecondaryIndexManager;
  private readonly foreignKeys: ForeignKeyManager;

  public constructor(
    private readonly storage: StorageDriver,
    private readonly keys = new StorageKeyManager(),
    private readonly coordinationStorage = storage,
  ) {
    this.primary = new PrimaryIndex(storage, keys);
    this.secondary = new SecondaryIndexManager(storage, keys);
    this.foreignKeys = new ForeignKeyManager(storage, keys);
  }

  public async commit(transaction: Transaction): Promise<void> {
    const admission = transaction.resources.reserve({ queuedOperations: 1 });

    try {
      return await coordinateCommit(
        this.coordinationStorage,
        transaction.limits.maxQueuedOperations,
        async () => {
          if (transaction.hasChanges) {
            const current = await this.storage.get(this.keys.manifestKey);

            if ((current?.version ?? null) != transaction.expectedStorageVersion)
              throw new TransactionConflictError();
          }

          await this.publish(transaction);
        },
      );
    } finally {
      admission.release();
    }
  }

  private async publish(transaction: Transaction): Promise<void> {
    const prepared = transaction.prepareForCommit();

    if (prepared.writes.size == 0 && prepared.schemaChanges.size == 0) {
      transaction.markCommitted();
      return;
    }

    const transactionId = transaction.id;

    const catalog = new Map(prepared.snapshot.manifest.catalog);

    const staged = new PreparedWrites(transaction.resources, transaction.limits, prepared.writes);

    for (const [name, schema] of prepared.schemaChanges) {
      if (schema == null) catalog.delete(name);
      else catalog.set(name, schema);

      const previous = prepared.snapshot.manifest.catalog.get(name);

      const requiresValidation =
        schema == null ||
        !previous ||
        JSON.stringify(previous.fields) != JSON.stringify(schema.fields) ||
        previous.allowAdditionalFields != schema.allowAdditionalFields ||
        JSON.stringify(previous.foreignKeys) != JSON.stringify(schema.foreignKeys);

      if (!requiresValidation) continue;

      const scanCatalog = new Map(catalog);

      if (schema == null)
        scanCatalog.set(
          name,
          prepared.snapshot.manifest.catalog.get(name) ?? { name, indexes: [] },
        );

      const context = new QueryContext(this.storage, prepared.snapshot, this.keys, {
        writes: staged,
        catalog: scanCatalog,
        resources: transaction.resources,
        limits: transaction.limits,
      });

      try {
        for await (const row of context.scanCollection(name))
          staged.set(
            recordKey(name, row.id),
            schema == null
              ? { type: "delete" }
              : {
                  type: "put",
                  data: encodeDocument(validateDocument(schema, row.document)),
                },
          );
      } finally {
        context.close();
      }
    }

    const writes = await this.foreignKeys.prepare(prepared.snapshot, staged, catalog, staged);

    for (const [key, value] of writes) if (!staged.has(key)) staged.set(key, value);
    const changes = new Map<string, string | null>();

    for (const [key, operation] of writes) {
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
      writes,
      catalog,
      transaction.resources,
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

    if (!result.success) {
      transaction.rejectPublication();
      throw new TransactionConflictError();
    }

    transaction.markCommitted();
  }
}
