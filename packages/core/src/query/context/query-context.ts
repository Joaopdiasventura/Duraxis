import type { StorageDriver } from "@duraxis/storage";
import type { Snapshot } from "../../commit/manifest.js";
import {
  RECORD_PREFIX,
  decodeDocument,
  indexFields,
  fieldDefinition,
  indexedValue,
  parseRecordKey,
  recordKey,
  type CollectionDefinition,
  type DocumentRecord,
  type IndexScalar,
} from "../../catalog/collection-schema.js";
import type { PendingWrite } from "../../transactions/transaction.js";
import { StorageKeyManager } from "../../security/storage-key-manager.js";
import { PrimaryIndex } from "../../indexes/primary/primary-index.js";
import { BPlusTreeNodeStore } from "../../indexes/bptree/bptree-node-store.js";
import { BPlusTreeNodeCache } from "../../indexes/bptree/bptree-node-cache.js";
import {
  SecondaryIndexManager,
  secondaryIndexBounds,
  type SecondaryIndexScanOptions,
} from "../../indexes/secondary/secondary-index-manager.js";
import { compareBytes, encodeSecondaryKey, prefixSuccessor } from "../../indexes/index-key.js";
import type { QueryRow } from "../executor/predicate.js";

export interface QueryMetrics {
  storageReads: number;
  storageWrites: number;
  nodesVisited: number;
  entriesExamined: number;
  recordsExamined: number;
  recordsReturned: number;
  cacheHits: number;
  cacheMisses: number;
  durationMs: number;
}

export interface QueryContextOptions {
  readonly writes?: ReadonlyMap<string, PendingWrite>;
  readonly catalog?: ReadonlyMap<string, CollectionDefinition>;
  readonly onIteratorStart?: () => void;
  readonly onIteratorEnd?: () => void;
  readonly onClose?: () => void;
}

function cloneWrites(
  source: ReadonlyMap<string, PendingWrite> | undefined,
): Map<string, PendingWrite> {
  const result = new Map<string, PendingWrite>();
  for (const [key, write] of source ?? [])
    result.set(
      key,
      write.type == "delete"
        ? { type: "delete" }
        : { type: "put", data: new Uint8Array(write.data) },
    );
  return result;
}

export class QueryContext {
  private readonly primary: PrimaryIndex;
  private readonly secondary: SecondaryIndexManager;
  private readonly nodeCache: BPlusTreeNodeCache;
  private readonly writes: ReadonlyMap<string, PendingWrite>;
  private readonly controller = new AbortController();
  private readonly startedAt = performance.now();
  private active = true;
  private iterators = 0;

  public readonly metrics: QueryMetrics = {
    storageReads: 0,
    storageWrites: 0,
    nodesVisited: 0,
    entriesExamined: 0,
    recordsExamined: 0,
    recordsReturned: 0,
    cacheHits: 0,
    cacheMisses: 0,
    durationMs: 0,
  };
  public readonly catalog: ReadonlyMap<string, CollectionDefinition>;

  public constructor(
    storage: StorageDriver,
    public readonly snapshot: Snapshot,
    keys: StorageKeyManager,
    private readonly options: QueryContextOptions = {},
  ) {
    this.nodeCache = new BPlusTreeNodeCache(new BPlusTreeNodeStore(storage, keys));
    this.primary = new PrimaryIndex(storage, keys, this.nodeCache);
    this.secondary = new SecondaryIndexManager(storage, keys, this.nodeCache);
    this.writes = cloneWrites(options.writes);
    this.catalog = new Map(options.catalog ?? snapshot.manifest.catalog);
  }

  public get generation(): string {
    return this.snapshot.manifest.transactionId || "initial";
  }
  public get signal(): AbortSignal {
    return this.controller.signal;
  }
  public get isActive(): boolean {
    return this.active;
  }

  public close(reason: unknown = new Error("Query context is closed")): void {
    if (!this.active) return;
    this.active = false;
    const cache = this.nodeCache.getMetrics();
    this.metrics.cacheHits = cache.hits;
    this.metrics.cacheMisses = cache.misses;
    this.metrics.durationMs = performance.now() - this.startedAt;
    this.controller.abort(reason);
    this.nodeCache.clear();
    this.options.onClose?.();
  }

  public cancel(reason: unknown = new Error("Query cancelled")): void {
    this.close(reason);
  }

  public assertActive(): void {
    if (!this.active) throw this.controller.signal.reason ?? new Error("Query context is closed");
  }

  private begin(): void {
    this.assertActive();
    this.iterators++;
    this.options.onIteratorStart?.();
  }

  private end(): void {
    if (this.iterators > 0) this.iterators--;
    this.options.onIteratorEnd?.();
  }

  private schema(collection: string): CollectionDefinition {
    const schema = this.catalog.get(collection);
    if (!schema) throw new Error(`Unknown collection: ${collection}`);
    return schema;
  }

  public async getDocument(collection: string, id: string): Promise<DocumentRecord | null> {
    this.assertActive();
    this.schema(collection);
    const key = recordKey(collection, id);
    const pending = this.writes.get(key);
    if (pending) return pending.type == "delete" ? null : decodeDocument(pending.data);
    this.metrics.storageReads++;
    const bytes = await this.primary.read(this.snapshot.manifest, key);
    this.assertActive();
    return bytes == null ? null : decodeDocument(bytes);
  }

  private pendingFor(collection: string): Map<string, PendingWrite> {
    const result = new Map<string, PendingWrite>();
    for (const [key, write] of this.writes) {
      const parsed = parseRecordKey(key);
      if (parsed?.collection == collection) result.set(parsed.id, write);
    }
    return result;
  }

  public async *scanCollection(
    collection: string,
    options: {
      readonly direction?: "ASC" | "DESC";
      readonly limit?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): AsyncIterable<QueryRow> {
    this.begin();
    try {
      this.schema(collection);
      const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid query limit");
      if (limit == 0) return;
      const direction = options.direction ?? "ASC";
      if (direction != "ASC" && direction != "DESC") throw new Error("Invalid scan direction");
      const pending = this.pendingFor(collection);
      const pendingRows = [...pending]
        .filter(([, write]) => write.type == "put")
        .map(([id, write]) => ({
          id,
          key: new TextEncoder().encode(recordKey(collection, id)),
          document: decodeDocument((write as { data: Uint8Array }).data),
        }))
        .sort((a, b) => compareBytes(a.key, b.key) * (direction == "ASC" ? 1 : -1));
      const prefix = new TextEncoder().encode(`${RECORD_PREFIX}${collection}/`);
      const end = prefixSuccessor(prefix);
      const committed = this.primary
        .scanReferences(this.snapshot.manifest.primaryRoot, {
          gte: prefix,
          ...(end == null ? {} : { lt: end }),
          direction,
          signal: this.signal,
          metrics: this.metrics,
        })
        [Symbol.asyncIterator]();
      try {
        let next = await committed.next();
        let pendingIndex = 0;
        let emitted = 0;
        while ((!next.done || pendingIndex < pendingRows.length) && emitted < limit) {
          if (options.signal?.aborted) throw options.signal.reason ?? new Error("Query cancelled");
          this.assertActive();
          while (!next.done) {
            const parsed = parseRecordKey(next.value.key);
            if (parsed && !pending.has(parsed.id)) break;
            next = await committed.next();
          }
          const staged = pendingRows[pendingIndex];
          const committedKey = next.done ? undefined : new TextEncoder().encode(next.value.key);
          const usePending =
            staged != null &&
            (committedKey == null ||
              compareBytes(staged.key, committedKey) * (direction == "ASC" ? 1 : -1) <= 0);
          let row: QueryRow;
          if (usePending) {
            row = { id: staged.id, document: staged.document };
            pendingIndex++;
          } else {
            const parsed = parseRecordKey(next.value.key);
            if (!parsed) throw new Error("Invalid record reference in collection scan");
            this.metrics.storageReads++;
            row = {
              id: parsed.id,
              document: decodeDocument(await this.primary.readObject(next.value.ref)),
            };
            next = await committed.next();
          }
          this.metrics.recordsExamined++;
          this.metrics.recordsReturned++;
          emitted++;
          yield row;
        }
      } finally {
        await committed.return?.();
      }
    } finally {
      this.end();
    }
  }

  private pendingIndexEntries(
    collection: string,
    indexName: string,
    options: SecondaryIndexScanOptions,
  ): Array<{ key: Uint8Array; row: QueryRow }> {
    const schema = this.schema(collection);
    const index = schema.indexes.find((item) => item.name == indexName);
    if (!index) throw new Error(`Unknown index: ${collection}/${indexName}`);
    const parts = indexFields(index);
    const orders = parts.map((part) => part.order);
    const bounds = secondaryIndexBounds(index, options);
    const matches = (key: Uint8Array) =>
      (bounds.gt == null || compareBytes(key, bounds.gt) > 0) &&
      (bounds.gte == null || compareBytes(key, bounds.gte) >= 0) &&
      (bounds.lt == null || compareBytes(key, bounds.lt) < 0) &&
      (bounds.lte == null || compareBytes(key, bounds.lte) <= 0);
    const result: Array<{ key: Uint8Array; row: QueryRow }> = [];
    for (const [id, write] of this.pendingFor(collection)) {
      if (write.type != "put") continue;
      const document = decodeDocument(write.data);
      const values: IndexScalar[] = [];
      let missing = false;
      for (const part of parts) {
        const item = indexedValue(document, part.field, fieldDefinition(schema, part.field));
        if (item === undefined) {
          missing = true;
          break;
        }
        values.push(item);
      }
      if (missing) continue;
      const key = encodeSecondaryKey(values, index.unique ? undefined : id, orders);
      if (matches(key)) result.push({ key, row: { id, document } });
    }
    return result;
  }

  public async *scanIndex(
    collection: string,
    indexName: string,
    options: SecondaryIndexScanOptions = {},
  ): AsyncIterable<QueryRow> {
    this.begin();
    try {
      const schema = this.schema(collection);
      if (
        !this.snapshot.manifest.catalog
          .get(collection)
          ?.indexes.some((index) => index.name == indexName)
      )
        throw new Error(`Index is not available in captured snapshot: ${collection}/${indexName}`);
      const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid query limit");
      if (limit == 0) return;
      const direction = options.direction ?? "ASC";
      const pending = this.pendingFor(collection);
      const staged = this.pendingIndexEntries(collection, indexName, options).sort(
        (a, b) => compareBytes(a.key, b.key) * (direction == "ASC" ? 1 : -1),
      );
      const committed = this.secondary
        .scanIds(this.snapshot.manifest, collection, indexName, {
          ...options,
          limit: undefined,
          signal: this.signal,
          metrics: this.metrics,
        })
        [Symbol.asyncIterator]();
      try {
        let next = await committed.next();
        let stagedIndex = 0;
        let emitted = 0;
        while ((!next.done || stagedIndex < staged.length) && emitted < limit) {
          if (options.signal?.aborted) throw options.signal.reason ?? new Error("Query cancelled");
          this.assertActive();
          while (!next.done && pending.has(next.value.id)) next = await committed.next();
          const pendingEntry = staged[stagedIndex];
          const usePending =
            pendingEntry != null &&
            (next.done ||
              compareBytes(pendingEntry.key, next.value.key) * (direction == "ASC" ? 1 : -1) <= 0);
          let row: QueryRow;
          if (usePending) {
            row = pendingEntry.row;
            stagedIndex++;
          } else {
            const document = await this.getDocument(collection, next.value.id);
            if (document == null)
              throw new Error(`Index references missing record: ${collection}/${next.value.id}`);
            row = { id: next.value.id, document };
            next = await committed.next();
          }
          this.metrics.recordsExamined++;
          this.metrics.recordsReturned++;
          emitted++;
          yield row;
        }
      } finally {
        await committed.return?.();
      }
      void schema;
    } finally {
      this.end();
    }
  }
}
