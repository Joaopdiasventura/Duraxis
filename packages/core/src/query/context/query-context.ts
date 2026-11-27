import {
  ResourceScope,
  OperationCancelledError,
  resourceLimits,
  estimateBytes,
  type ResourceLimits,
  type ResourceReservation,
} from "../../resources/resource-manager.js";
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
  readonly assertAccess?: () => void;
  readonly resources?: ResourceScope;
  readonly limits?: ResourceLimits;
  readonly writes?: ReadonlyMap<string, PendingWrite>;
  readonly catalog?: ReadonlyMap<string, CollectionDefinition>;
  readonly onIteratorStart?: () => void;
  readonly onIteratorEnd?: () => void;
  readonly onClose?: () => void;
  readonly onPendingCleanup?: (promise: Promise<unknown>) => void;
  readonly onCleanupFailure?: (error: unknown) => void;
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
  public readonly resources: ResourceScope;
  public readonly limits: Readonly<ResourceLimits>;
  private readonly iteratorReservations: ResourceReservation[] = [];
  private readonly primary: PrimaryIndex;
  private readonly secondary: SecondaryIndexManager;
  private readonly nodeCache: BPlusTreeNodeCache;
  private readonly writes: Map<string, PendingWrite>;
  private readonly controller = new AbortController();
  private readonly startedAt = performance.now();
  private active = true;
  private iterators = 0;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly cancellationReturns = new Set<() => Promise<unknown>>();

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
  private snapshotValue?: Snapshot;

  public get snapshot(): Snapshot {
    this.assertActive();
    return this.snapshotValue!;
  }

  private readonly catalogValue = new Map<string, CollectionDefinition>();
  public get catalog(): ReadonlyMap<string, CollectionDefinition> {
    return this.catalogValue;
  }

  public constructor(
    storage: StorageDriver,
    snapshot: Snapshot,
    keys: StorageKeyManager,
    private readonly options: QueryContextOptions = {},
  ) {
    this.snapshotValue = snapshot;

    this.limits = options.limits ?? resourceLimits();

    this.resources = (options.resources ?? new ResourceScope({})).child({
      workingBytes: this.limits.maxQueryWorkingBytes,
      spillBytes: this.limits.maxSpillBytes,
    });

    try {
      this.resources.reserve({
        queries: 1,
        iterators: 1,
        workingBytes: estimateBytes([...(options.writes ?? [])]),
      });
    } catch (error) {
      this.resources.close();
      throw error;
    }

    const queryStorage: StorageDriver = {
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
      list: storage.list.bind(storage),
      get: (key, options) =>
        storage.get(key, {
          ...options,
          signal: options?.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal,
        }),
    };

    this.nodeCache = new BPlusTreeNodeCache(
      new BPlusTreeNodeStore(queryStorage, keys),
      256,
      Math.min(4 * 1024 * 1024, this.limits.maxQueryWorkingBytes),
      this.resources,
    );

    this.primary = new PrimaryIndex(queryStorage, keys, this.nodeCache);
    this.secondary = new SecondaryIndexManager(queryStorage, keys, this.nodeCache);
    this.writes = cloneWrites(options.writes);

    for (const [name, definition] of options.catalog ?? snapshot.manifest.catalog)
      this.catalogValue.set(name, definition);

    this.timer = setTimeout(
      () => this.cancel(new OperationCancelledError("Query lifetime expired")),
      this.limits.maxQueryDurationMs,
    );

    this.timer.unref();
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

  public bindCancellation(close: () => Promise<unknown>): () => void {
    this.cancellationReturns.add(close);
    return () => this.cancellationReturns.delete(close);
  }

  private managed(factory: () => AsyncIterable<QueryRow>): AsyncIterable<QueryRow> {
    const context = this;

    const iterator = (async function* () {
      const unbind = context.bindCancellation(() => iterator.return(undefined));
      try {
        yield* factory();
      } finally {
        unbind();
      }
    })();
    return iterator;
  }

  public scanCollection(
    collection: string,
    options: {
      readonly direction?: "ASC" | "DESC";
      readonly limit?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): AsyncIterable<QueryRow> {
    return this.managed(() => this.scanCollectionRows(collection, options));
  }

  public scanIndex(
    collection: string,
    index: string,
    options: SecondaryIndexScanOptions = {},
  ): AsyncIterable<QueryRow> {
    return this.managed(() => this.scanIndexRows(collection, index, options));
  }

  public close(
    reason: unknown = new Error("Query context is closed"),
    cleanup?: () => Promise<unknown>,
  ): void {
    if (!this.active) return;

    this.active = false;
    clearTimeout(this.timer);
    this.cancellationReturns.clear();

    const cache = this.nodeCache.getMetrics();

    this.metrics.cacheHits = cache.hits;
    this.metrics.cacheMisses = cache.misses;
    this.metrics.durationMs = performance.now() - this.startedAt;

    this.controller.abort(reason);
    this.nodeCache.clear();
    this.writes.clear();
    this.catalogValue.clear();

    this.snapshotValue = undefined;

    while (this.iterators > 0) this.end();

    const finish = () => {
      this.resources.close();
      this.options.onClose?.();
    };

    if (cleanup) {
      const pending = Promise.resolve().then(cleanup);

      this.options.onPendingCleanup?.(pending);

      pending.then(finish, (error) => {
        this.options.onCleanupFailure?.(error);
        finish();
      });
    } else finish();
  }

  public cancel(reason: unknown = new Error("Query cancelled")): void {
    const callbacks = [...this.cancellationReturns];
    this.cancellationReturns.clear();
    this.close(
      reason,
      callbacks.length
        ? async () => {
            const results = await Promise.allSettled(
              callbacks.map((callback) => Promise.resolve().then(callback)),
            );

            const errors = results
              .filter((result) => result.status == "rejected")
              .map((result) => result.reason);

            if (errors.length) throw new AggregateError(errors, "Query iterator cleanup failed");
          }
        : undefined,
    );
  }

  public assertActive(): void {
    this.options.assertAccess?.();
    if (!this.active) throw this.controller.signal.reason ?? new Error("Query context is closed");
  }

  private begin(): void {
    this.assertActive();
    this.iteratorReservations.push(this.resources.reserve({ iterators: this.iterators ? 1 : 0 }));
    this.iterators++;
    this.options.onIteratorStart?.();
  }

  private end(): void {
    if (this.iterators == 0) return;
    this.iterators--;
    this.iteratorReservations.pop()?.release();
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

  private async *scanCollectionRows(
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

          if (next.done && pendingIndex >= pendingRows.length) break;

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
    let bytes = 0;
    const memory = this.resources.reserve({});

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

      if (matches(key)) {
        bytes += estimateBytes(document) + key.byteLength + id.length * 2;

        memory.resize({ workingBytes: bytes });
        result.push({ key, row: { id, document } });
      }
    }

    return result;
  }

  private async *scanIndexRows(
    collection: string,
    indexName: string,
    options: SecondaryIndexScanOptions = {},
  ): AsyncIterable<QueryRow> {
    this.begin();
    try {
      const schema = this.schema(collection);

      if (!schema.indexes.some((index) => index.name == indexName))
        throw new Error(`Index is not available in captured snapshot: ${collection}/${indexName}`);

      const previous = this.snapshot.manifest.catalog.get(collection);

      if (JSON.stringify(previous) != JSON.stringify(schema)) {
        const index = schema.indexes.find((item) => item.name == indexName);

        if (!index) throw new Error(`Unknown index: ${collection}/${indexName}`);

        const parts = indexFields(index);
        const bounds = secondaryIndexBounds(index, options);

        const entries: Array<{ key: Uint8Array; row: QueryRow }> = [];
        const memory = this.resources.reserve({});

        let bytes = 0;

        for await (const row of this.scanCollection(collection, { signal: options.signal })) {
          const values = parts.map((part) =>
            indexedValue(row.document, part.field, fieldDefinition(schema, part.field)),
          );

          if (values.some((value) => value === undefined)) continue;

          const key = encodeSecondaryKey(
            values as IndexScalar[],
            index.unique ? undefined : row.id,
            parts.map((part) => part.order),
          );

          if (
            (bounds.gt == null || compareBytes(key, bounds.gt) > 0) &&
            (bounds.gte == null || compareBytes(key, bounds.gte) >= 0) &&
            (bounds.lt == null || compareBytes(key, bounds.lt) < 0) &&
            (bounds.lte == null || compareBytes(key, bounds.lte) <= 0)
          ) {
            bytes += estimateBytes(row) + key.byteLength;
            memory.resize({ workingBytes: bytes });
            entries.push({ key, row });
          }
        }

        const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

        if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid query limit");

        entries.sort((a, b) => compareBytes(a.key, b.key) * (options.direction == "DESC" ? -1 : 1));

        for (const entry of entries.slice(0, limit)) yield entry.row;

        return;
      }

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

          if (next.done && stagedIndex >= staged.length) break;

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
