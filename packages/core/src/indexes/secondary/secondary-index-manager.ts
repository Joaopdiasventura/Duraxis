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

import { BPlusTreeBatchStore } from "../bptree/bptree-batch-store.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function entryKey(
  index: SecondaryIndexDefinition,
  value: IndexScalar,
  recordId: string,
): Uint8Array {
  return encodeSecondaryKey(value, index.unique ? undefined : recordId);
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
    oldManifest: Manifest,
    nextPrimaryRoot: string | null,
    writes: ReadonlyMap<string, PendingWrite>,
    catalog: ReadonlyMap<string, CollectionDefinition>,
  ): Promise<Map<string, string | null>> {
    const roots = new Map(oldManifest.indexRoots);
    const oldCatalog = oldManifest.catalog;

    for (const [collectionName, schema] of catalog) {
      const previous = oldCatalog.get(collectionName);

      for (const index of schema.indexes) {
        const id = indexId(collectionName, index.name);

        const existed = previous?.indexes.some((item) => item.name == index.name) ?? false;

        if (!existed) {
          roots.set(id, await this.rebuild(collectionName, index, nextPrimaryRoot));
          continue;
        }

        if (!roots.has(id)) throw new Error(`Missing committed index root: ${id}`);

        const stage = new BPlusTreeBatchStore(this.nodes);
        const tree = new BPlusTree(stage);
        let root = roots.get(id) ?? null;

        const changes: Array<{
          recordId: string;
          previous?: DocumentRecord;
          next?: DocumentRecord;
        }> = [];

        for (const [key, operation] of writes) {
          const parsed = parseRecordKey(key);

          if (!parsed || parsed.collection != collectionName) continue;

          const previousRef = await this.primary.getReference(oldManifest, key);

          const previousDocument =
            previousRef == null
              ? undefined
              : decodeDocument(await this.primary.readObject(previousRef));

          const nextDocument = operation.type == "put" ? decodeDocument(operation.data) : undefined;

          changes.push({
            recordId: parsed.id,
            previous: previousDocument,
            next: nextDocument,
          });
        }

        for (const change of changes) {
          if (!change.previous) continue;

          const value = indexedValue(change.previous, index.field);

          if (value == undefined) continue;

          root = await tree.delete(root, entryKey(index, value, change.recordId));
        }

        for (const change of changes) {
          if (!change.next) continue;

          const value = indexedValue(change.next, index.field);

          if (value == undefined) continue;

          const key = entryKey(index, value, change.recordId);

          if (index.unique) {
            const existing = await tree.get(root, key);

            if (existing != null && decoder.decode(existing) != change.recordId)
              throw new UniqueIndexViolationError(collectionName, index.name);
          }

          root = await tree.put(root, key, encoder.encode(change.recordId));
        }

        roots.set(id, await stage.flush(root));
      }
    }

    return roots;
  }

  private async rebuild(
    collection: string,
    index: SecondaryIndexDefinition,
    primaryRoot: string | null,
  ): Promise<string | null> {
    const stage = new BPlusTreeBatchStore(this.nodes);
    const tree = new BPlusTree(stage);

    let root: string | null = null;

    for await (const entry of this.primary.scanReferences(primaryRoot)) {
      const parsed = parseRecordKey(entry.key);

      if (!parsed || parsed.collection != collection) continue;

      const document = decodeDocument(await this.primary.readObject(entry.ref));

      const value = indexedValue(document, index.field);

      if (value == undefined) continue;

      const key = entryKey(index, value, parsed.id);

      if (index.unique && (await tree.get(root, key)))
        throw new UniqueIndexViolationError(collection, index.name);

      root = await tree.put(root, key, encoder.encode(parsed.id));
    }

    return stage.flush(root);
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

    const key = indexId(collection, indexName);

    if (!manifest.indexRoots.has(key)) throw new Error(`Missing index root: ${key}`);

    const root = manifest.indexRoots.get(key)!;

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
