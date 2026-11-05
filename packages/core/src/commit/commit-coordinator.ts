import { randomUUID } from "node:crypto";
import type { StorageDriver } from "@duraxis/storage";

import { MANIFEST_KEY, encodeManifest, type Manifest } from "./manifest.js";
import { Transaction } from "../transactions/transaction.js";
import { TransactionConflictError } from "../errors/transaction-conflict.error.js";

export class CommitCoordinator {
  public constructor(private readonly storage: StorageDriver) {}

  public async commit(transaction: Transaction): Promise<void> {
    if (!transaction.hasPendingWrites()) return;

    const transactionId = randomUUID();

    const entries = new Map(transaction.snapshot.manifest.entries);

    for (const [key, operation] of transaction.getPendingWrites()) {
      if (operation.type == "delete") {
        entries.delete(key);
        continue;
      }

      const objectKey = `__duraxis/v1/objects/${randomUUID()}`;

      const result = await this.storage.put(objectKey, operation.data, {
        condition: {
          type: "if-absent",
        },
      });

      if (!result.success) throw new Error("Unexpected immutable object key collision");

      entries.set(key, objectKey);
    }

    const manifest: Manifest = {
      format: 1,
      transactionId,
      entries,
    };

    const previousVersion = transaction.snapshot.storageVersion;

    const result = await this.storage.put(MANIFEST_KEY, encodeManifest(manifest), {
      condition:
        previousVersion == null
          ? { type: "if-absent" }
          : {
              type: "if-version",
              version: previousVersion,
            },
    });

    if (!result.success) throw new TransactionConflictError();
  }
}
