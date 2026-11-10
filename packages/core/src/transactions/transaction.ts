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
  readonly schemaChanges: ReadonlyMap<string, CollectionDefinition>;
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
  private readonly writes = new Map<string, PendingWrite>();
  private readonly schemas = new Map<string, CollectionDefinition>();

  private readonly capturedSnapshot: Snapshot;
  private readonly reader: ManifestSnapshotReader;

  private stateValue: TransactionState = "ACTIVE";
  private pendingReads = 0;
  private readonly readWaiters: Array<() => void> = [];
  private readonly queryContexts = new Set<QueryContext>();

  public constructor(
    private readonly storage: StorageDriver,
    snapshot: Snapshot,
    private readonly keys = new StorageKeyManager(),
  ) {
    this.capturedSnapshot = cloneSnapshot(snapshot);
    this.reader = new ManifestSnapshotReader(this.storage, this.capturedSnapshot, keys);
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

    this.writes.set(key, { type: "delete" });
  }

  public defineCollection(definition: CollectionDefinition): void {
    this.assertActive();
    validateCollection(definition);

    if (this.collection(definition.name))
      throw new Error(`Collection already exists: ${definition.name}`);

    this.schemas.set(definition.name, cloneSchema(definition));
  }

  public addIndex(collection: string, index: SecondaryIndexDefinition): void {
    this.assertActive();

    const current = this.requireCollection(collection);

    const updated: CollectionDefinition = {
      name: collection,
      indexes: [...current.indexes, index],
    };

    validateCollection(updated);

    this.schemas.set(collection, cloneSchema(updated));
  }

  public removeIndex(collection: string, indexName: string): void {
    this.assertActive();
    const current = this.requireCollection(collection);

    if (!current.indexes.some((index) => index.name == indexName))
      throw new Error(`Unknown index: ${collection}/${indexName}`);

    this.schemas.set(
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

    for (const [name, schema] of this.schemas) catalog.set(name, cloneSchema(schema));

    let context!: QueryContext;

    context = new QueryContext(this.storage, cloneSnapshot(this.capturedSnapshot), this.keys, {
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

  public query(
    query: LogicalQuery,
    source: QueryOperator,
    options?: QueryExecutorOptions,
  ): AsyncIterable<QueryRow> {
    const context = this.createQueryContext();
    const executor = new QueryExecutor(options);

    return (async function* () {
      try {
        yield* executor.execute(context, query, source);
      } finally {
        context.close();
      }
    })();
  }

  public async queryPage(
    query: LogicalQuery,
    source: QueryOperator,
    options?: QueryExecutorOptions,
  ): Promise<QueryPage> {
    const context = this.createQueryContext();

    try {
      return await new QueryExecutor(options).page(context, query, source);
    } finally {
      context.close();
    }
  }

  public putDocument(collection: string, id: string, document: DocumentRecord): void {
    this.assertActive();

    const schema = this.requireCollection(collection);
    const parsed = validateDocument(schema, document);
    const data = encodeDocument(parsed);

    for (const index of schema.indexes)
      for (const part of index.fields ??
        (index.field ? [{ field: index.field, order: "ASC" as const }] : []))
        indexedValue(parsed, part.field, fieldDefinition(schema, part.field));

    this.stagePut(recordKey(collection, id), data);
  }

  public deleteDocument(collection: string, id: string): void {
    this.assertActive();
    this.requireCollection(collection);

    this.writes.set(recordKey(collection, id), {
      type: "delete",
    });
  }

  public prepareForCommit(): PreparedTransaction {
    this.assertActive();

    if (this.pendingReads != 0)
      throw new TransactionStateError("Transaction has pending reads; await all tx.get() calls");

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
        [...this.schemas].map(([name, schema]) => [name, cloneSchema(schema)]),
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
    if (this.stateValue != "PREPARING")
      throw new TransactionStateError("Transaction is not preparing");
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
    if (this.stateValue != "COMMITTED" && this.stateValue != "UNKNOWN") this.stateValue = "ABORTED";
  }

  public close(): void {
    if (this.stateValue == "ACTIVE" || this.stateValue == "PREPARING") this.abort();
    for (const context of [...this.queryContexts]) context.close();

    this.queryContexts.clear();
    this.writes.clear();
    this.schemas.clear();
  }

  private stagePut(key: string, data: Uint8Array): void {
    if (!(data instanceof Uint8Array)) throw new TypeError("Storage value must be Uint8Array");

    this.writes.set(key, {
      type: "put",
      data: new Uint8Array(data),
    });
  }

  private releaseRead(): void {
    if (this.pendingReads > 0) this.pendingReads--;
    if (this.pendingReads == 0) for (const resolve of this.readWaiters.splice(0)) resolve();
  }

  private collection(name: string): CollectionDefinition | undefined {
    return this.schemas.get(name) ?? this.capturedSnapshot.manifest.catalog.get(name);
  }

  private requireCollection(name: string): CollectionDefinition {
    const schema = this.collection(name);

    if (!schema) throw new Error(`Unknown collection: ${name}`);

    return schema;
  }

  private assertActive(): void {
    if (this.stateValue != "ACTIVE")
      throw new TransactionStateError("Transaction is no longer active");
  }

  private validateKey(key: string): void {
    this.keys.validateLogicalKey(key);
    encodeIndexKey(new TextEncoder().encode(key));
  }
}
