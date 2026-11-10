import type { StorageDriver } from "@duraxis/storage";

import type { Manifest } from "../../commit/manifest.js";
import type { PendingWrite } from "../../transactions/transaction.js";

import {
  decodeDocument,
  indexedValue,
  indexId,
  parseRecordKey,
  type CollectionDefinition,
  type DocumentRecord,
  type SecondaryIndexDefinition,
  type IndexScalar,
} from "../../catalog/collection-schema.js";

import { encodeSecondaryKey, prefixSuccessor } from "../index-key.js";

import { PrimaryIndex } from "../primary/primary-index.js";
import { StorageKeyManager } from "../../security/storage-key-manager.js";
import { BPlusTree } from "../bptree/bptree.js";
import { BPlusTreeNodeStore } from "../bptree/bptree-node-store.js";

import type { BatchOperation } from "../bptree/bptree-node.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface RecordChange {
  readonly recordId: string;
  readonly previous?: DocumentRecord;
  readonly next?: DocumentRecord;
}

function entryKey(
  index: SecondaryIndexDefinition,
  value: IndexScalar,
  recordId: string,
): Uint8Array {
  return encodeSecondaryKey(value, index.unique ? undefined : recordId);
}

function keyId(key: Uint8Array): string {
  return Buffer.from(key).toString("hex");
}

export class UniqueIndexViolationError extends Error {
  constructor(
    readonly collection: string,
    readonly index: string,
  ) {
    super(`Unique index violation: ${collection}/${index}`);
    this.name = "UniqueIndexViolationError";
  }
}

export class SecondaryIndexManager {
  private readonly nodes: BPlusTreeNodeStore;
  private readonly primary: PrimaryIndex;

  public constructor(storage: StorageDriver, keys: StorageKeyManager) {
    this.nodes = new BPlusTreeNodeStore(storage, keys);
    this.primary = new PrimaryIndex(storage, keys);
  }

  public async prepare(
    previousManifest: Manifest,
    nextPrimaryRoot: string | null,
    writes: ReadonlyMap<string, PendingWrite>,
    catalog: ReadonlyMap<string, CollectionDefinition>,
  ): Promise<Map<string, string | null>> {
    const roots = new Map(previousManifest.indexRoots);
    const oldCatalog = previousManifest.catalog;

    const tree = new BPlusTree(this.nodes);

    for (const [collectionName, schema] of catalog) {
      const previousSchema = oldCatalog.get(collectionName);

      const changes = await this.collectChanges(previousManifest, collectionName, writes);

      for (const index of schema.indexes) {
        const id = indexId(collectionName, index.name);

        const existed = previousSchema?.indexes.some((item) => item.name == index.name) ?? false;

        if (!existed) {
          roots.set(id, await this.rebuild(collectionName, index, nextPrimaryRoot));
          continue;
        }

        if (!roots.has(id)) throw new Error(`Missing committed index root: ${id}`);

        const root = roots.get(id)!;
        const operations: BatchOperation[] = [];

        const released = new Map<string, string>();

        for (const change of changes) {
          if (change.previous === undefined) continue;

          const value = indexedValue(change.previous, index.field);

          if (value === undefined) continue;

          const key = entryKey(index, value, change.recordId);

          operations.push({
            type: "delete",
            key,
          });

          if (index.unique) released.set(keyId(key), change.recordId);
        }

        const planned = new Map<string, string>();

        for (const change of changes) {
          if (change.next === undefined) continue;

          const value = indexedValue(change.next, index.field);

          if (value === undefined) continue;

          const key = entryKey(index, value, change.recordId);

          if (index.unique) {
            const encoded = keyId(key);
            const plannedOwner = planned.get(encoded);

            if (plannedOwner != undefined && plannedOwner != change.recordId)
              throw new UniqueIndexViolationError(collectionName, index.name);

            planned.set(encoded, change.recordId);

            const existing = await tree.get(root, key);

            if (existing != null) {
              const currentOwner = decoder.decode(existing);
              const ownerIsSame = currentOwner == change.recordId;
              const ownerWillRelease = released.get(encoded) == currentOwner;

              if (!ownerIsSame && !ownerWillRelease)
                throw new UniqueIndexViolationError(collectionName, index.name);
            }
          }

          operations.push({
            type: "put",
            key,
            value: encoder.encode(change.recordId),
          });
        }

        roots.set(id, operations.length == 0 ? root : await tree.batch(root, operations));
      }
    }

    return roots;
  }

  private async collectChanges(
    manifest: Manifest,
    collection: string,
    writes: ReadonlyMap<string, PendingWrite>,
  ): Promise<RecordChange[]> {
    const changes: RecordChange[] = [];

    for (const [key, operation] of writes) {
      const parsed = parseRecordKey(key);

      if (parsed == null || parsed.collection != collection) continue;

      const previousRef = await this.primary.getReference(manifest, key);

      const previous =
        previousRef == null
          ? undefined
          : decodeDocument(await this.primary.readObject(previousRef));

      const next = operation.type == "put" ? decodeDocument(operation.data) : undefined;

      changes.push({
        recordId: parsed.id,
        previous,
        next,
      });
    }

    return changes;
  }

  private async rebuild(
    collection: string,
    index: SecondaryIndexDefinition,
    primaryRoot: string | null,
  ): Promise<string | null> {
    const tree = new BPlusTree(this.nodes);

    const operations: BatchOperation[] = [];
    const uniqueOwners = new Map<string, string>();

    for await (const entry of this.primary.scanReferences(primaryRoot)) {
      const parsed = parseRecordKey(entry.key);

      if (parsed == null || parsed.collection != collection) continue;

      const document = decodeDocument(await this.primary.readObject(entry.ref));

      const value = indexedValue(document, index.field);

      if (value === undefined) continue;

      const key = entryKey(index, value, parsed.id);

      if (index.unique) {
        const encoded = keyId(key);
        const owner = uniqueOwners.get(encoded);

        if (owner != undefined && owner != parsed.id)
          throw new UniqueIndexViolationError(collection, index.name);

        uniqueOwners.set(encoded, parsed.id);
      }

      operations.push({
        type: "put",
        key,
        value: encoder.encode(parsed.id),
      });
    }

    return tree.batch(null, operations);
  }

  public async lookupIds(
    manifest: Manifest,
    collection: string,
    indexName: string,
    value: IndexScalar,
    limit = 100,
  ): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid query limit");

    const schema = manifest.catalog.get(collection);
    const index = schema?.indexes.find((item) => item.name == indexName);

    if (!index) throw new Error(`Unknown index: ${collection}/${indexName}`);

    const id = indexId(collection, indexName);

    if (!manifest.indexRoots.has(id)) throw new Error(`Missing committed index root: ${id}`);

    const root = manifest.indexRoots.get(id)!;

    if (root == null || limit == 0) return [];

    const tree = new BPlusTree(this.nodes);
    const prefix = encodeSecondaryKey(value);

    if (index.unique) {
      const found = await tree.get(root, prefix);
      return found == null ? [] : [decoder.decode(found)];
    }

    const ids: string[] = [];
    const end = prefixSuccessor(prefix);

    for await (const entry of tree.scan(root, {
      gte: prefix,
      ...(end == null ? {} : { lt: end }),
      limit,
    }))
      ids.push(decoder.decode(entry.value));

    return ids;
  }
}
