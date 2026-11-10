import type { StorageDriver } from "@duraxis/storage";
import type { Manifest } from "../../commit/manifest.js";
import type { PendingWrite } from "../../transactions/transaction.js";
import {
  decodeDocument,
  indexedValue,
  indexFields,
  fieldDefinition,
  indexId,
  parseRecordKey,
  type CollectionDefinition,
  type DocumentRecord,
  type SecondaryIndexDefinition,
  type IndexScalar,
} from "../../catalog/collection-schema.js";
import { encodeSecondaryKey, prefixSuccessor, type EncodedIndexBounds } from "../index-key.js";
import { PrimaryIndex } from "../primary/primary-index.js";
import { StorageKeyManager } from "../../security/storage-key-manager.js";
import { BPlusTree } from "../bptree/bptree.js";
import { BPlusTreeNodeStore } from "../bptree/bptree-node-store.js";
import type { BatchOperation, BPlusTreeNodeIO, ScanMetrics } from "../bptree/bptree-node.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface RecordChange {
  readonly recordId: string;
  readonly previous?: DocumentRecord;
  readonly next?: DocumentRecord;
}

export interface SecondaryIndexScanOptions {
  readonly eq?: IndexScalar | readonly IndexScalar[];
  readonly prefix?: readonly IndexScalar[];
  readonly gt?: readonly IndexScalar[];
  readonly gte?: readonly IndexScalar[];
  readonly lt?: readonly IndexScalar[];
  readonly lte?: readonly IndexScalar[];
  readonly direction?: "ASC" | "DESC";
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly metrics?: ScanMetrics;
}

export interface SecondaryIndexEntry {
  readonly id: string;
  readonly key: Uint8Array;
}

function valuesFor(
  schema: CollectionDefinition,
  index: SecondaryIndexDefinition,
  document: DocumentRecord,
): readonly IndexScalar[] | undefined {
  const values: IndexScalar[] = [];
  for (const part of indexFields(index)) {
    const value = indexedValue(document, part.field, fieldDefinition(schema, part.field));
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

function entryKey(
  index: SecondaryIndexDefinition,
  values: readonly IndexScalar[],
  id: string,
): Uint8Array {
  return encodeSecondaryKey(
    values,
    index.unique ? undefined : id,
    indexFields(index).map((p) => p.order),
  );
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
  private readonly nodes: BPlusTreeNodeIO;
  private readonly primary: PrimaryIndex;

  public constructor(
    storage: StorageDriver,
    keys: StorageKeyManager,
    nodes: BPlusTreeNodeIO = new BPlusTreeNodeStore(storage, keys),
  ) {
    this.nodes = nodes;
    this.primary = new PrimaryIndex(storage, keys, nodes);
  }

  public async prepare(
    previousManifest: Manifest,
    nextPrimaryRoot: string | null,
    writes: ReadonlyMap<string, PendingWrite>,
    catalog: ReadonlyMap<string, CollectionDefinition>,
  ): Promise<Map<string, string | null>> {
    const roots = new Map(previousManifest.indexRoots);
    const declared = new Set<string>();
    const tree = new BPlusTree(this.nodes);

    for (const [collectionName, schema] of catalog) {
      const previousSchema = previousManifest.catalog.get(collectionName);
      const changes = await this.collectChanges(previousManifest, collectionName, writes);

      for (const index of schema.indexes) {
        const id = indexId(collectionName, index.name);
        declared.add(id);
        const oldIndex = previousSchema?.indexes.find((item) => item.name == index.name);
        const sameDefinition =
          oldIndex != null &&
          JSON.stringify(indexFields(oldIndex)) == JSON.stringify(indexFields(index)) &&
          oldIndex.unique == index.unique;
        if (!sameDefinition) {
          roots.set(id, await this.rebuild(collectionName, schema, index, nextPrimaryRoot));
          continue;
        }
        if (!roots.has(id)) throw new Error(`Missing committed index root: ${id}`);
        const root = roots.get(id)!;
        const operations: BatchOperation[] = [];
        const released = new Map<string, string>();

        for (const change of changes) {
          if (change.previous === undefined) continue;
          const values = valuesFor(schema, index, change.previous);
          if (values === undefined) continue;
          const key = entryKey(index, values, change.recordId);
          operations.push({ type: "delete", key });
          if (index.unique) released.set(keyId(key), change.recordId);
        }

        const planned = new Map<string, string>();
        for (const change of changes) {
          if (change.next === undefined) continue;
          const values = valuesFor(schema, index, change.next);
          if (values === undefined) continue;
          const key = entryKey(index, values, change.recordId);
          if (index.unique) {
            const encoded = keyId(key);
            const owner = planned.get(encoded);
            if (owner != null && owner != change.recordId)
              throw new UniqueIndexViolationError(collectionName, index.name);
            planned.set(encoded, change.recordId);
            const existing = await tree.get(root, key);
            if (existing != null) {
              const currentOwner = decoder.decode(existing);
              if (currentOwner != change.recordId && released.get(encoded) != currentOwner)
                throw new UniqueIndexViolationError(collectionName, index.name);
            }
          }
          operations.push({ type: "put", key, value: encoder.encode(change.recordId) });
        }
        roots.set(id, operations.length == 0 ? root : await tree.batch(root, operations));
      }
    }
    for (const id of [...roots.keys()]) if (!declared.has(id)) roots.delete(id);
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
      changes.push({
        recordId: parsed.id,
        previous:
          previousRef == null
            ? undefined
            : decodeDocument(await this.primary.readObject(previousRef)),
        next: operation.type == "put" ? decodeDocument(operation.data) : undefined,
      });
    }
    return changes;
  }

  private async rebuild(
    collection: string,
    schema: CollectionDefinition,
    index: SecondaryIndexDefinition,
    primaryRoot: string | null,
  ): Promise<string | null> {
    const tree = new BPlusTree(this.nodes);
    let root: string | null = null;
    let operations: BatchOperation[] = [];
    const flush = async () => {
      if (operations.length) {
        root = await tree.batch(root, operations);
        operations = [];
      }
    };
    for await (const entry of this.primary.scanReferences(primaryRoot)) {
      const parsed = parseRecordKey(entry.key);
      if (parsed == null || parsed.collection != collection) continue;
      const values = valuesFor(
        schema,
        index,
        decodeDocument(await this.primary.readObject(entry.ref)),
      );
      if (values === undefined) continue;
      const key = entryKey(index, values, parsed.id);
      if (index.unique) {
        await flush();
        const existing = await tree.get(root, key);
        if (existing != null && decoder.decode(existing) != parsed.id)
          throw new UniqueIndexViolationError(collection, index.name);
      }
      operations.push({ type: "put", key, value: encoder.encode(parsed.id) });
      if (operations.length >= 256) await flush();
    }
    await flush();
    return root;
  }

  private resolve(manifest: Manifest, collection: string, indexName: string) {
    const schema = manifest.catalog.get(collection);
    const index = schema?.indexes.find((item) => item.name == indexName);
    if (!schema || !index) throw new Error(`Unknown index: ${collection}/${indexName}`);
    const id = indexId(collection, indexName);
    if (!manifest.indexRoots.has(id)) throw new Error(`Missing committed index root: ${id}`);
    return { schema, index, root: manifest.indexRoots.get(id)! };
  }

  private bounds(
    index: SecondaryIndexDefinition,
    options: SecondaryIndexScanOptions,
  ): EncodedIndexBounds {
    const eq =
      options.eq == null
        ? undefined
        : Array.isArray(options.eq)
          ? options.eq
          : [options.eq as IndexScalar];
    if (eq && (options.prefix || options.gt || options.gte || options.lt || options.lte))
      throw new Error("Equality cannot be combined with index ranges");
    if (options.prefix && (options.gt || options.gte || options.lt || options.lte))
      throw new Error("Prefix cannot be combined with index ranges");
    if (options.gt && options.gte) throw new Error("Use either gt or gte");
    if (options.lt && options.lte) throw new Error("Use either lt or lte");
    const orders = indexFields(index).map((part) => part.order);
    const encode = (values: readonly IndexScalar[]) => {
      if (values.length == 0 || values.length > orders.length)
        throw new Error("Invalid compound key arity");
      return encodeSecondaryKey(values, undefined, orders.slice(0, values.length));
    };
    const prefix = eq ?? options.prefix;
    if (prefix) {
      const start = encode(prefix);
      const end = prefixSuccessor(start);
      return { gte: start, ...(end == null ? {} : { lt: end }) };
    }
    const bounds: { gt?: Uint8Array; gte?: Uint8Array; lt?: Uint8Array; lte?: Uint8Array } = {};
    if (options.gte) bounds.gte = encode(options.gte);
    if (options.gt) {
      const next = prefixSuccessor(encode(options.gt));
      if (next) bounds.gte = next;
      else bounds.gt = encode(options.gt);
    }
    if (options.lt) bounds.lt = encode(options.lt);
    if (options.lte) {
      const next = prefixSuccessor(encode(options.lte));
      if (next) bounds.lt = next;
      else bounds.lte = encode(options.lte);
    }
    return bounds;
  }

  /** Ordered, incremental access that never materializes the ID set. */
  public async *scanIds(
    manifest: Manifest,
    collection: string,
    indexName: string,
    options: SecondaryIndexScanOptions = {},
  ): AsyncIterable<SecondaryIndexEntry> {
    const { index, root } = this.resolve(manifest, collection, indexName);
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid query limit");
    if (root == null || limit == 0) return;
    const tree = new BPlusTree(this.nodes);
    const bounds = this.bounds(index, options);
    for await (const entry of tree.scan(root, {
      ...bounds,
      direction: options.direction,
      limit,
      signal: options.signal,
      metrics: options.metrics,
    }))
      yield { id: decoder.decode(entry.value), key: entry.key };
  }

  public async lookupIds(
    manifest: Manifest,
    collection: string,
    indexName: string,
    value: IndexScalar | readonly IndexScalar[],
    limit = 100,
  ): Promise<string[]> {
    const ids: string[] = [];
    for await (const entry of this.scanIds(manifest, collection, indexName, { eq: value, limit }))
      ids.push(entry.id);
    return ids;
  }
}
