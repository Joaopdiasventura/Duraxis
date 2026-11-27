import type { CursorKeyring } from "../query/model/cursor.js";
import { randomUUID } from "node:crypto";
import {
  ResourceScope,
  resourceLimits,
  estimateBytes,
  ResourceExhaustedError,
  OperationCancelledError,
  materialize,
  type ResourceLimits,
  type ResourceReservation,
} from "../resources/resource-manager.js";
import type { StorageDriver } from "@duraxis/storage";

import type { Snapshot } from "../commit/manifest.js";
import { ManifestSnapshotReader } from "../snapshots/snapshot-reader.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";
import { TransactionStateError } from "../errors/transaction-state.error.js";

import {
  RECORD_PREFIX,
  validateCollection,
  validateDocument,
  normalizeCollection,
  fieldDefinition,
  recordKey,
  encodeDocument,
  decodeDocument,
  indexedValue,
  type CollectionDefinition,
  type SecondaryIndexDefinition,
  type DocumentRecord,
} from "../catalog/collection-schema.js";
import { encodeIndexKey } from "../indexes/bptree/bptree-codec.js";
import { QueryContext } from "../query/context/query-context.js";

import {
  QueryExecutor,
  type QueryExecutorOptions,
  type QueryPage,
} from "../query/executor/query-executor.js";
import type { QueryOperator } from "../query/executor/operators/operators.js";
import type { LogicalQuery } from "../query/model/query.js";
import type { QueryRow } from "../query/executor/predicate.js";
import { RuleBasedPlanner } from "../query/planner/rule-based-planner.js";
import { PlanCompiler } from "../query/planner/plan-compiler.js";

export type TransactionState =
  "ACTIVE" | "PREPARING" | "COMMITTING" | "COMMITTED" | "ABORTED" | "UNKNOWN";

export type PendingWrite =
  | {
      readonly type: "put";
      readonly data: Uint8Array;
    }
  | {
      readonly type: "delete";
    };

export interface PreparedTransaction {
  readonly snapshot: Snapshot;
  readonly writes: ReadonlyMap<string, PendingWrite>;
  readonly schemaChanges: ReadonlyMap<string, CollectionDefinition | null>;
}

function cloneSchema(schema: CollectionDefinition): CollectionDefinition {
  return normalizeCollection(schema);
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  const source = snapshot.manifest;

  return {
    storageVersion: snapshot.storageVersion,
    manifest: {
      format: 1,
      transactionId: source.transactionId,
      commitHead: source.commitHead,
      primaryRoot: source.primaryRoot,
      indexRoots: new Map(source.indexRoots),
      catalog: new Map([...source.catalog].map(([name, schema]) => [name, cloneSchema(schema)])),
    },
  };
}

export class Transaction {
  public readonly id = randomUUID();
  private readonly pendingCleanup = new Set<Promise<unknown>>();
  private readonly localCancellation = new AbortController();
  public readonly signal: AbortSignal;
  public readonly resources: ResourceScope;
  public readonly limits: Readonly<ResourceLimits>;
  private readonly writeReservations = new Map<string, ResourceReservation>();
  private readonly schemaReservations = new Map<string, ResourceReservation>();
  private readonly writes = new Map<string, PendingWrite>();
  private readonly schemas = new Map<string, CollectionDefinition | null>();

  private snapshotValue?: Snapshot;

  private get capturedSnapshot(): Snapshot {
    if (!this.snapshotValue) throw new TransactionStateError("Transaction is closed");
    return this.snapshotValue;
  }

  private set capturedSnapshot(value: Snapshot) {
    this.snapshotValue = value;
  }

  private readerValue?: ManifestSnapshotReader;

  private get reader(): ManifestSnapshotReader {
    if (!this.readerValue) throw new TransactionStateError("Transaction is closed");
    return this.readerValue;
  }

  private set reader(value: ManifestSnapshotReader) {
    this.readerValue = value;
  }

  private stateValue: TransactionState = "ACTIVE";
  private pendingReads = 0;
  private readonly readWaiters: Array<() => void> = [];
  private readonly queryContexts = new Set<QueryContext>();
  private readonly planner = new RuleBasedPlanner();
  private readonly planCompiler = new PlanCompiler();

  public constructor(
    private readonly storage: StorageDriver,
    snapshot: Snapshot,
    private readonly keys = new StorageKeyManager(),
    private readonly cursorSigningKey?: Uint8Array,
    parentResources?: ResourceScope,
    limits: ResourceLimits = resourceLimits(),
    private readonly operationSignal?: AbortSignal,
    private readonly onPublication?: () => void,
    private readonly assertAccessScope?: () => void,
    private readonly runtimeHooks: {
      readonly cursorEncryption?: CursorKeyring;
      readonly onPendingCleanup?: (promise: Promise<unknown>) => void;
      readonly onCleanupFailure?: (error: unknown) => void;
    } = {},
  ) {
    this.signal = operationSignal
      ? AbortSignal.any([operationSignal, this.localCancellation.signal])
      : this.localCancellation.signal;

    this.limits = limits;

    this.resources = (parentResources ?? new ResourceScope({})).child({
      workingBytes: limits.maxTransactionWorkingBytes,
      writes: limits.maxPendingWrites,
      writeBytes: limits.maxPendingWriteBytes,
    });

    this.resources.reserve({ transactions: 1 });
    this.resources.reserve({ workingBytes: estimateBytes([...snapshot.manifest.catalog]) });

    this.capturedSnapshot = cloneSnapshot(snapshot);
    this.reader = new ManifestSnapshotReader(this.storage, this.capturedSnapshot, keys);
  }

  public get expectedStorageVersion(): string | null {
    this.assertActive();
    return this.capturedSnapshot.storageVersion;
  }

  public get hasChanges(): boolean {
    this.assertActive();
    return this.writes.size + this.schemas.size > 0;
  }

  public get state(): TransactionState {
    return this.stateValue;
  }

  public get hasPendingReads(): boolean {
    return this.pendingReads != 0;
  }

  public async get(key: string): Promise<Uint8Array | null> {
    this.assertActive();
    this.validateKey(key);
    this.pendingReads++;

    try {
      const pending = this.writes.get(key);

      if (pending) return pending.type == "delete" ? null : new Uint8Array(pending.data);

      const result = await this.reader.get(key);
      this.assertActive();

      return result;
    } catch (error) {
      if (
        this.stateValue != "ACTIVE" &&
        !this.operationSignal?.aborted &&
        error instanceof OperationCancelledError
      )
        throw new TransactionStateError("Transaction is no longer active");

      throw error;
    } finally {
      this.pendingReads--;
      if (this.pendingReads == 0) for (const resolve of this.readWaiters.splice(0)) resolve();
    }
  }

  public put(key: string, data: Uint8Array): void {
    this.assertActive();
    this.validateKey(key);

    if (key.startsWith(RECORD_PREFIX)) throw new Error("Reserved internal collection key");

    this.stagePut(key, data);
  }

  public delete(key: string): void {
    this.assertActive();
    this.validateKey(key);

    if (key.startsWith(RECORD_PREFIX)) throw new Error("Reserved internal collection key");

    this.stageDelete(key);
  }

  public defineCollection(definition: CollectionDefinition): void {
    this.assertActive();
    validateCollection(definition);

    if (this.schemas.get(definition.name) === null)
      throw new Error("Cannot recreate a dropped collection in the same transaction");
    if (this.collection(definition.name))
      throw new Error(`Collection already exists: ${definition.name}`);

    this.stageSchema(definition.name, cloneSchema(definition));
  }

  public defineCollections(definitions: readonly CollectionDefinition[]): void {
    this.assertActive();
    const names = new Set<string>();

    for (const definition of definitions) {
      validateCollection(definition);
      if (
        names.has(definition.name) ||
        this.schemas.has(definition.name) ||
        this.collection(definition.name)
      )
        throw new Error(`Collection already exists: ${definition.name}`);
      names.add(definition.name);
    }

    for (const definition of definitions)
      this.stageSchema(definition.name, cloneSchema(definition));
  }

  public getCollectionDefinitions(): readonly CollectionDefinition[] {
    this.assertActive();

    const catalog = new Map(this.capturedSnapshot.manifest.catalog);

    for (const [name, schema] of this.schemas) {
      if (schema == null) catalog.delete(name);
      else catalog.set(name, schema);
    }

    return [...catalog.values()].map(cloneSchema);
  }

  public alterCollection(name: string, definition: CollectionDefinition): void {
    this.assertActive();
    this.requireCollection(name);

    if (name != definition.name)
      throw new Error("Collection replacement cannot rename a collection");

    this.stageSchema(name, cloneSchema(definition));
  }

  public dropCollection(name: string): void {
    this.assertActive();
    this.requireCollection(name);
    this.stageSchema(name, null);
  }

  public async getMetadata(namespace: string): Promise<Uint8Array | null> {
    this.assertActive();

    const key = this.metadataKey(namespace);
    this.pendingReads++;

    try {
      const pending = this.writes.get(key);

      const value = pending
        ? pending.type == "delete"
          ? null
          : pending.data
        : await this.reader.get(key);

      this.assertActive();

      return value == null ? null : new Uint8Array(value);
    } finally {
      this.releaseRead();
    }
  }

  public putMetadata(namespace: string, data: Uint8Array): void {
    this.assertActive();
    this.stagePut(this.metadataKey(namespace), data);
  }

  private metadataKey(namespace: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace)) throw new Error("Invalid metadata namespace");
    return `__duraxis/metadata/${namespace}`;
  }

  public async *scanCollection(collection: string): AsyncIterable<QueryRow> {
    const context = this.createQueryContext();
    try {
      yield* context.scanCollection(collection);
    } finally {
      context.close();
    }
  }

  public addIndex(collection: string, index: SecondaryIndexDefinition): void {
    this.assertActive();

    const current = this.requireCollection(collection);

    const updated: CollectionDefinition = {
      ...current,
      indexes: [...current.indexes, index],
    };

    validateCollection(updated);

    this.stageSchema(collection, cloneSchema(updated));
  }

  public removeIndex(collection: string, indexName: string): void {
    this.assertActive();
    const current = this.requireCollection(collection);

    if (!current.indexes.some((index) => index.name == indexName))
      throw new Error(`Unknown index: ${collection}/${indexName}`);

    this.stageSchema(
      collection,
      cloneSchema({
        ...current,
        indexes: current.indexes.filter((index) => index.name != indexName),
      }),
    );
  }

  public async getDocument(collection: string, id: string): Promise<DocumentRecord | null> {
    this.assertActive();
    this.requireCollection(collection);

    const value = await this.get(recordKey(collection, id));

    return value == null ? null : decodeDocument(value);
  }

  public createQueryContext(): QueryContext {
    this.assertActive();

    const catalog = new Map(this.capturedSnapshot.manifest.catalog);

    for (const [name, schema] of this.schemas) {
      if (schema == null) catalog.delete(name);
      else catalog.set(name, cloneSchema(schema));
    }

    let context!: QueryContext;

    context = new QueryContext(this.storage, cloneSnapshot(this.capturedSnapshot), this.keys, {
      assertAccess: this.assertAccessScope,
      onPendingCleanup: (promise) => {
        this.pendingCleanup.add(promise);
        this.runtimeHooks.onPendingCleanup?.(promise);

        const complete = () => this.pendingCleanup.delete(promise);

        promise.then(complete, complete);
      },
      onCleanupFailure: this.runtimeHooks.onCleanupFailure,
      resources: this.resources,
      limits: this.limits,
      writes: this.writes,
      catalog,
      onIteratorStart: () => {
        this.pendingReads++;
      },
      onIteratorEnd: () => this.releaseRead(),
      onClose: () => this.queryContexts.delete(context),
    });

    this.queryContexts.add(context);

    return context;
  }

  public query(query: LogicalQuery, options?: QueryExecutorOptions): AsyncIterable<QueryRow>;

  public query(
    query: LogicalQuery,
    source: QueryOperator,
    options?: QueryExecutorOptions,
  ): AsyncIterable<QueryRow>;

  public query(
    query: LogicalQuery,
    sourceOrOptions?: QueryOperator | QueryExecutorOptions,
    explicitOptions?: QueryExecutorOptions,
  ): AsyncIterable<QueryRow> {
    const context = this.createQueryContext();

    const explicit = this.isOperator(sourceOrOptions) ? sourceOrOptions : undefined;

    const options: QueryExecutorOptions | undefined = explicit
      ? explicitOptions
      : (sourceOrOptions as QueryExecutorOptions | undefined);

    const source =
      explicit ??
      this.planCompiler.compile(
        this.planner.plan(query, context.catalog, context.limits),
        context.catalog,
      );

    const executor = new QueryExecutor(this.queryOptions(options));
    const transaction = this;

    const iterator = (async function* () {
      let unbindSignal = () => {};

      try {
        unbindSignal = transaction.bindSignal(context, options?.signal);
        yield* executor.execute(context, query, source);
      } finally {
        unbindSignal();
        context.close();
      }
    })();

    context.bindCancellation(() => iterator.return(undefined));

    return iterator;
  }

  public queryPage(query: LogicalQuery, options?: QueryExecutorOptions): Promise<QueryPage>;

  public queryPage(
    query: LogicalQuery,
    source: QueryOperator,
    options?: QueryExecutorOptions,
  ): Promise<QueryPage>;

  public async queryPage(
    query: LogicalQuery,
    sourceOrOptions?: QueryOperator | QueryExecutorOptions,
    explicitOptions?: QueryExecutorOptions,
  ): Promise<QueryPage> {
    const context = this.createQueryContext();
    let unbindSignal = () => {};

    try {
      const explicit = this.isOperator(sourceOrOptions) ? sourceOrOptions : undefined;

      const options: QueryExecutorOptions | undefined = explicit
        ? explicitOptions
        : (sourceOrOptions as QueryExecutorOptions | undefined);
      unbindSignal = this.bindSignal(context, options?.signal);

      const source =
        explicit ??
        this.planCompiler.compile(
          this.planner.plan(query, context.catalog, context.limits),
          context.catalog,
        );

      return await new QueryExecutor(this.queryOptions(options)).page(context, query, source);
    } finally {
      unbindSignal();
      context.close();
    }
  }

  public putDocument(collection: string, id: string, document: DocumentRecord): void {
    this.assertActive();

    const schema = this.requireCollection(collection);

    const estimate = estimateBytes(
      document,
      this.limits.maxDocumentBytes * 4,
      this.limits.maxDocumentDepth,
    );

    const encoding = this.resources.reserve({ workingBytes: estimate * 4 });

    try {
      const parsed = validateDocument(schema, document);
      const data = encodeDocument(parsed);

      for (const index of schema.indexes)
        for (const part of index.fields ??
          (index.field ? [{ field: index.field, order: "ASC" as const }] : []))
          indexedValue(parsed, part.field, fieldDefinition(schema, part.field));

      this.stagePut(recordKey(collection, id), data);
    } finally {
      encoding.release();
    }
  }

  public deleteDocument(collection: string, id: string): void {
    this.assertActive();
    this.requireCollection(collection);

    this.stageDelete(recordKey(collection, id));
  }

  public prepareForCommit(): PreparedTransaction {
    this.assertActive();

    if (this.pendingReads != 0)
      throw new TransactionStateError("Transaction has pending reads; await all tx.get() calls");

    this.resources.reserve({
      workingBytes: [...this.writes].reduce(
        (n, [key, op]) => n + key.length * 2 + 96 + (op.type == "put" ? op.data.byteLength : 0),
        0,
      ),
    });

    this.stateValue = "PREPARING";

    const writes = new Map<string, PendingWrite>();

    for (const [key, operation] of this.writes)
      writes.set(
        key,
        operation.type == "delete"
          ? { type: "delete" }
          : {
              type: "put",
              data: new Uint8Array(operation.data),
            },
      );

    return {
      snapshot: cloneSnapshot(this.capturedSnapshot),
      writes,
      schemaChanges: new Map(
        [...this.schemas].map(([name, schema]) => [
          name,
          schema == null ? null : cloneSchema(schema),
        ]),
      ),
    };
  }

  public async waitForReads(): Promise<void> {
    if (this.pendingReads == 0) return;

    await new Promise<void>((resolve) => {
      this.readWaiters.push(resolve);
    });
  }

  public beginPublication(): void {
    this.assertAccessScope?.();

    if (this.stateValue != "PREPARING")
      throw new TransactionStateError("Transaction is not preparing");

    this.onPublication?.();
    this.stateValue = "COMMITTING";
  }

  public markCommitted(): void {
    if (this.stateValue != "PREPARING" && this.stateValue != "COMMITTING")
      throw new TransactionStateError("Invalid transaction state");
    this.stateValue = "COMMITTED";
  }

  public markUnknown(): void {
    this.stateValue = "UNKNOWN";
  }

  public abort(): void {
    if (this.stateValue == "COMMITTING") return;
    if (this.stateValue != "COMMITTED" && this.stateValue != "UNKNOWN") this.stateValue = "ABORTED";
  }

  public rejectPublication(): void {
    if (this.stateValue != "COMMITTING")
      throw new TransactionStateError("No publication in progress");

    this.stateValue = "ABORTED";
  }

  public close(): void {
    if (this.stateValue == "COMMITTING") return;

    this.localCancellation.abort(new TransactionStateError("Transaction is closed"));

    if (this.stateValue == "ACTIVE" || this.stateValue == "PREPARING") this.abort();

    for (const context of [...this.queryContexts])
      context.cancel(new TransactionStateError("Transaction is closed"));

    this.queryContexts.clear();
    this.writes.clear();
    this.schemas.clear();
    this.writeReservations.clear();
    this.schemaReservations.clear();

    if (this.pendingCleanup.size)
      void Promise.allSettled([...this.pendingCleanup]).then(() => this.resources.close());
    else this.resources.close();

    this.snapshotValue = undefined;
    this.readerValue = undefined;
  }

  public createMaterializationBudget<T>() {
    return materialize<T>(this.resources, this.limits);
  }

  private reserveWrite(key: string, bytes: number): void {
    if (bytes > this.limits.maxDocumentBytes)
      throw new ResourceExhaustedError("documentBytes", this.limits.maxDocumentBytes);

    const amounts = { writes: 1, writeBytes: bytes, workingBytes: bytes + key.length * 2 + 128 };
    const current = this.writeReservations.get(key);

    if (current) current.resize(amounts);
    else this.writeReservations.set(key, this.resources.reserve(amounts));
  }

  private stageDelete(key: string): void {
    this.reserveWrite(key, 0);
    this.writes.set(key, { type: "delete" });
  }

  private stageSchema(name: string, schema: CollectionDefinition | null): void {
    const amounts = { workingBytes: estimateBytes(schema) + 128 };
    const current = this.schemaReservations.get(name);

    if (current) current.resize(amounts);
    else this.schemaReservations.set(name, this.resources.reserve(amounts));

    this.schemas.set(name, schema);
  }

  private stagePut(key: string, data: Uint8Array): void {
    if (!(data instanceof Uint8Array)) throw new TypeError("Storage value must be Uint8Array");

    this.reserveWrite(key, data.byteLength);
    this.writes.set(key, {
      type: "put",
      data: new Uint8Array(data),
    });
  }

  private releaseRead(): void {
    if (this.pendingReads > 0) this.pendingReads--;
    if (this.pendingReads == 0) for (const resolve of this.readWaiters.splice(0)) resolve();
  }

  private queryOptions(options?: QueryExecutorOptions): QueryExecutorOptions {
    return {
      ...options,
      cursorSigningKey: this.cursorSigningKey,
      cursorEncryption: this.runtimeHooks.cursorEncryption,
      cursorNamespace: this.keys.namespace,
    };
  }

  private bindSignal(context: QueryContext, signal?: AbortSignal): () => void {
    if (!signal) return () => {};
    const cancel = () => context.cancel(signal.reason ?? new Error("Query cancelled"));
    if (signal.aborted) throw signal.reason ?? new Error("Query cancelled");
    else signal.addEventListener("abort", cancel, { once: true });
    return () => signal.removeEventListener("abort", cancel);
  }

  private isOperator(
    value: QueryOperator | QueryExecutorOptions | undefined,
  ): value is QueryOperator {
    return value != null && typeof (value as QueryOperator).execute == "function";
  }

  private collection(name: string): CollectionDefinition | undefined {
    return this.schemas.has(name)
      ? (this.schemas.get(name) ?? undefined)
      : this.capturedSnapshot.manifest.catalog.get(name);
  }

  private requireCollection(name: string): CollectionDefinition {
    const schema = this.collection(name);

    if (!schema) throw new Error(`Unknown collection: ${name}`);

    return schema;
  }

  private assertActive(): void {
    this.assertAccessScope?.();
    this.operationSignal?.throwIfAborted();

    if (this.stateValue != "ACTIVE")
      throw new TransactionStateError("Transaction is no longer active");
  }

  private validateKey(key: string): void {
    if (Buffer.byteLength(key) > 1024) throw new ResourceExhaustedError("keyBytes", 1024);
    this.keys.validateLogicalKey(key);
    encodeIndexKey(new TextEncoder().encode(key));
  }
}
