import type { StorageDriver } from "@duraxis/storage";
import { randomBytes, randomUUID } from "node:crypto";

import {
  decodeManifest,
  emptyManifest,
  encodeManifest,
  type Manifest,
  type Snapshot,
} from "../commit/manifest.js";
import { encodeCommitRecord } from "../commit/commit-record.js";

import { CommitCoordinator } from "../commit/commit-coordinator.js";
import { Transaction } from "../transactions/transaction.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";
import { RecoveryManager } from "../recovery/recovery-manager.js";
import type { SnapshotReader } from "../snapshots/snapshot-reader.js";

import {
  GarbageCollector,
  type GarbageCollectionOptions,
  type GarbageCollectionReport,
} from "../gc/garbage-collector.js";

import { ManifestReachabilityScanner } from "../gc/reachability-scanner.js";
import { PrimaryIndex } from "../indexes/primary/primary-index.js";
import { SecondaryIndexManager } from "../indexes/secondary/secondary-index-manager.js";
import { BPlusTreeNodeStore } from "../indexes/bptree/bptree-node-store.js";
import { IndexConsistencyChecker } from "../indexes/index-consistency-checker.js";
import { prefixSuccessor } from "../indexes/index-key.js";
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
import { explainPhysicalPlan } from "../query/planner/explain.js";
import type { ExplainResult, PhysicalPlan } from "../query/planner/physical-plan.js";
import { TransactionConflictError } from "../errors/transaction-conflict.error.js";
import { CommitOutcomeUnknownError } from "../errors/commit-outcome-unknown.error.js";

import {
  RECORD_PREFIX,
  normalizeCollection,
  recordKey,
  decodeDocument,
  parseRecordKey,
  type CollectionDefinition,
  type SecondaryIndexDefinition,
  type DocumentRecord,
  type IndexScalar,
} from "../catalog/collection-schema.js";

export interface DuraxisDatabaseOptions {
  readonly storage: StorageDriver;
  readonly namespace?: string;
  readonly cursorSigningKey?: Uint8Array;
}

export interface CollectionRow {
  readonly id: string;
  readonly document: DocumentRecord;
}

export interface DuraxisMetrics {
  readonly transactionsStarted: number;
  readonly transactionsCommitted: number;
  readonly transactionConflicts: number;
  readonly commitOutcomesUnknown: number;
  readonly commitDurationMs: number;
  readonly queries: number;
  readonly queryDurationMs: number;
  readonly garbageCollections: number;
  readonly garbageCollectionDurationMs: number;
  readonly storage?: ReturnType<NonNullable<StorageDriver["getMetrics"]>>;
}

function immutableCollection(definition: CollectionDefinition): CollectionDefinition {
  const normalized = normalizeCollection(definition);

  const fields = normalized.fields
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(normalized.fields).map(([name, field]) => [
            name,
            Object.freeze({ ...field }),
          ]),
        ),
      )
    : undefined;

  const indexes = Object.freeze(
    normalized.indexes.map((index) =>
      Object.freeze({
        ...index,
        fields: Object.freeze((index.fields ?? []).map((field) => Object.freeze({ ...field }))),
      }),
    ),
  );

  return Object.freeze({
    ...normalized,
    ...(fields == null ? {} : { fields }),
    indexes,
  });
}

export class DuraxisDatabase {
  private readonly storage: StorageDriver;
  private readonly keys: StorageKeyManager;
  private readonly coordinator: CommitCoordinator;
  private readonly recovery: RecoveryManager;
  private readonly primary: PrimaryIndex;
  private readonly secondary: SecondaryIndexManager;
  private readonly cursorSigningKey: Uint8Array;
  private readonly planner = new RuleBasedPlanner();
  private readonly planCompiler = new PlanCompiler();
  private readonly metrics = {
    transactionsStarted: 0,
    transactionsCommitted: 0,
    transactionConflicts: 0,
    commitOutcomesUnknown: 0,
    commitDurationMs: 0,
    queries: 0,
    queryDurationMs: 0,
    garbageCollections: 0,
    garbageCollectionDurationMs: 0,
  };

  private readonly active = new Set<Snapshot>();
  private maintenance = false;
  private pendingSnapshotAcquisitions = 0;
  private closed = false;

  public constructor(options: DuraxisDatabaseOptions) {
    this.storage = options.storage;
    this.keys = new StorageKeyManager(options.namespace);
    this.coordinator = new CommitCoordinator(this.storage, this.keys);
    this.recovery = new RecoveryManager(this.storage, this.keys);
    this.primary = new PrimaryIndex(this.storage, this.keys);
    this.secondary = new SecondaryIndexManager(this.storage, this.keys);
    this.cursorSigningKey =
      options.cursorSigningKey == null ? randomBytes(32) : new Uint8Array(options.cursorSigningKey);
    if (this.cursorSigningKey.byteLength < 32)
      throw new Error("Cursor signing key must contain at least 32 bytes");
  }

  public async transaction<T>(callback: (tx: Transaction) => Promise<T> | T): Promise<T> {
    this.metrics.transactionsStarted++;
    const snapshot = await this.acquireSnapshot();
    const tx = new Transaction(this.storage, snapshot, this.keys, this.cursorSigningKey);

    try {
      const result = await callback(tx);
      const started = performance.now();
      try {
        await this.coordinator.commit(tx);
      } finally {
        this.metrics.commitDurationMs += performance.now() - started;
      }
      this.metrics.transactionsCommitted++;
      return result;
    } catch (error) {
      if (error instanceof TransactionConflictError) this.metrics.transactionConflicts++;
      if (error instanceof CommitOutcomeUnknownError) this.metrics.commitOutcomesUnknown++;
      tx.abort();
      throw error;
    } finally {
      this.releaseSnapshot(snapshot, tx);
    }
  }

  public async snapshot<T>(callback: (reader: SnapshotReader) => Promise<T> | T): Promise<T> {
    const snapshot = await this.acquireSnapshot();
    const tx = new Transaction(this.storage, snapshot, this.keys, this.cursorSigningKey);

    try {
      return await callback({
        get: (key: string) => tx.get(key),
      });
    } finally {
      this.releaseSnapshot(snapshot, tx);
    }
  }

  public async defineCollection(schema: CollectionDefinition): Promise<void> {
    await this.transaction((tx) => {
      tx.defineCollection(schema);
    });
  }

  public async getCollectionDefinitions(): Promise<readonly CollectionDefinition[]> {
    const snapshot = await this.acquireSnapshot();

    try {
      return Object.freeze(
        [...snapshot.manifest.catalog.values()]
          .map((definition) => immutableCollection(definition))
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
    } finally {
      this.active.delete(snapshot);
    }
  }

  public async addIndex(collection: string, index: SecondaryIndexDefinition): Promise<void> {
    await this.transaction((tx) => {
      tx.addIndex(collection, index);
    });
  }

  public async removeIndex(collection: string, indexName: string): Promise<void> {
    await this.transaction((tx) => tx.removeIndex(collection, indexName));
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
    const database = this;

    return (async function* () {
      const started = performance.now();
      database.metrics.queries++;
      const snapshot = await database.acquireSnapshot();
      const context = new QueryContext(database.storage, snapshot, database.keys);
      let unbindSignal = () => {};

      try {
        const explicit = database.isOperator(sourceOrOptions) ? sourceOrOptions : undefined;
        const options: QueryExecutorOptions | undefined = explicit
          ? explicitOptions
          : (sourceOrOptions as QueryExecutorOptions | undefined);

        unbindSignal = database.bindSignal(context, options?.signal);

        const source =
          explicit ??
          database.planCompiler.compile(
            database.planner.plan(query, context.catalog),
            context.catalog,
          );
        yield* new QueryExecutor(database.queryOptions(options)).execute(context, query, source);
      } finally {
        unbindSignal();
        database.metrics.queryDurationMs += performance.now() - started;
        context.close();
        database.active.delete(snapshot);
      }
    })();
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
    const started = performance.now();
    this.metrics.queries++;
    const snapshot = await this.acquireSnapshot();
    const context = new QueryContext(this.storage, snapshot, this.keys);
    let unbindSignal = () => {};

    try {
      const explicit = this.isOperator(sourceOrOptions) ? sourceOrOptions : undefined;
      const options: QueryExecutorOptions | undefined = explicit
        ? explicitOptions
        : (sourceOrOptions as QueryExecutorOptions | undefined);

      unbindSignal = this.bindSignal(context, options?.signal);

      const source =
        explicit ??
        this.planCompiler.compile(this.planner.plan(query, context.catalog), context.catalog);
      return await new QueryExecutor(this.queryOptions(options)).page(context, query, source);
    } finally {
      unbindSignal();
      this.metrics.queryDurationMs += performance.now() - started;
      context.close();
      this.active.delete(snapshot);
    }
  }

  public async queryAll(
    query: LogicalQuery,
    options?: QueryExecutorOptions,
  ): Promise<readonly QueryRow[]> {
    const rows: QueryRow[] = [];
    for await (const row of this.query(query, options)) rows.push(row);
    return rows;
  }

  public async explain(query: LogicalQuery): Promise<ExplainResult> {
    const snapshot = await this.acquireSnapshot();
    try {
      return explainPhysicalPlan(this.planner.plan(query, snapshot.manifest.catalog));
    } finally {
      this.active.delete(snapshot);
    }
  }

  public executePlan(
    query: LogicalQuery,
    plan: PhysicalPlan,
    options?: QueryExecutorOptions,
  ): AsyncIterable<QueryRow> {
    if (plan.collection != query.collection) throw new Error("Plan and query collections differ");
    if (
      plan.limit != query.limit ||
      JSON.stringify(plan.projection ?? null) != JSON.stringify(query.projection ?? null) ||
      JSON.stringify(plan.requiredOrdering) != JSON.stringify(query.orderBy ?? [])
    )
      throw new Error("Physical plan is incompatible with the logical query");
    const database = this;
    return (async function* () {
      const snapshot = await database.acquireSnapshot();
      const context = new QueryContext(database.storage, snapshot, database.keys);

      const unbindSignal = database.bindSignal(context, options?.signal);

      try {
        const source = database.planCompiler.compile(plan, context.catalog);
        yield* new QueryExecutor(database.queryOptions(options)).execute(context, query, source);
      } finally {
        unbindSignal();
        context.close();
        database.active.delete(snapshot);
      }
    })();
  }

  public async getDocument(collection: string, id: string): Promise<DocumentRecord | null> {
    return this.transaction((tx) => tx.getDocument(collection, id));
  }

  public async findByIndex(
    collection: string,
    indexName: string,
    value: IndexScalar | readonly IndexScalar[],
    limit = 100,
  ): Promise<CollectionRow[]> {
    const snapshot = await this.acquireSnapshot();

    try {
      const ids = await this.secondary.lookupIds(
        snapshot.manifest,
        collection,
        indexName,
        value,
        limit,
      );

      const rows: CollectionRow[] = [];

      for (const id of ids) {
        const bytes = await this.primary.read(snapshot.manifest, recordKey(collection, id));

        if (bytes == null) throw new Error(`Index references missing record: ${collection}/${id}`);

        rows.push({
          id,
          document: decodeDocument(bytes),
        });
      }

      return rows;
    } finally {
      this.active.delete(snapshot);
    }
  }

  public async scanCollection(collection: string, limit = 100): Promise<CollectionRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid scan limit");

    const snapshot = await this.acquireSnapshot();

    try {
      if (!snapshot.manifest.catalog.has(collection))
        throw new Error(`Unknown collection: ${collection}`);

      const rows: CollectionRow[] = [];
      if (limit == 0) return rows;

      const prefix = new TextEncoder().encode(`${RECORD_PREFIX}${collection}/`);

      const end = prefixSuccessor(prefix);

      for await (const entry of this.primary.scanReferences(snapshot.manifest.primaryRoot, {
        gte: prefix,
        ...(end == null ? {} : { lt: end }),
      })) {
        const parsed = parseRecordKey(entry.key);

        if (!parsed || parsed.collection != collection) continue;

        rows.push({
          id: parsed.id,
          document: decodeDocument(await this.primary.readObject(entry.ref)),
        });

        if (rows.length >= limit) break;
      }

      return rows;
    } finally {
      this.active.delete(snapshot);
    }
  }

  public async getCommitStatus(transactionId: string) {
    return this.recovery.getCommitStatus(transactionId);
  }

  public async verifyHistory(): Promise<number> {
    return this.recovery.verifyHistory();
  }

  /** Starts a new verifiable commit-history chain without changing data roots. */
  public async checkpointHistory(): Promise<string> {
    if (this.closed) throw new Error("Database is closed");
    if (this.maintenance || this.active.size || this.pendingSnapshotAcquisitions)
      throw new Error("History checkpoint requires exclusive database maintenance");
    this.maintenance = true;
    const transactionId = randomUUID();
    try {
      const snapshot = await this.createSnapshot();
      const recordBytes = encodeCommitRecord({ format: 1, transactionId, previous: null });
      const commitHead = this.keys.commitKey(transactionId, recordBytes);
      const record = await this.storage.put(commitHead, recordBytes, {
        condition: { type: "if-absent" },
      });
      if (!record.success) throw new Error("Unexpected checkpoint record collision");
      const manifest: Manifest = {
        ...snapshot.manifest,
        transactionId,
        commitHead,
      };
      let published;
      try {
        published = await this.storage.put(
          this.keys.manifestKey,
          encodeManifest(manifest, this.keys),
          {
            condition:
              snapshot.storageVersion == null
                ? { type: "if-absent" }
                : { type: "if-version", version: snapshot.storageVersion },
          },
        );
      } catch (cause) {
        throw new CommitOutcomeUnknownError(transactionId, cause);
      }
      if (!published.success) throw new TransactionConflictError();
      return transactionId;
    } finally {
      this.maintenance = false;
    }
  }

  public async verifyIntegrity(): Promise<{
    objects: number;
    nodes: number;
    indexes: number;
    commits: number;
  }> {
    const snapshot = await this.acquireSnapshot();

    try {
      const scanner = new ManifestReachabilityScanner(this.keys, this.storage);
      const nodes = new BPlusTreeNodeStore(this.storage, this.keys);
      const reachable = await scanner.scan(snapshot);

      let objectsCount = 0;
      let nodesCount = 0;

      for (const ref of reachable)
        if (ref.startsWith(this.keys.objectPrefix)) {
          await this.primary.readObject(ref);
          objectsCount++;
        } else {
          this.keys.validateIndexNodeKey(ref);
          await nodes.read(ref);
          nodesCount++;
        }

      const checker = new IndexConsistencyChecker(this.storage, this.keys);
      const indexes = await checker.verify(snapshot.manifest);
      const commits = await this.recovery.verifyHistory();

      return {
        objects: objectsCount,
        nodes: nodesCount,
        indexes,
        commits,
      };
    } finally {
      this.active.delete(snapshot);
    }
  }

  public async collectGarbage(
    storage: StorageDriver,
    options: GarbageCollectionOptions = {},
  ): Promise<GarbageCollectionReport> {
    const started = performance.now();
    this.metrics.garbageCollections++;
    if (storage != this.storage) throw new Error("GC driver must match database storage");
    if (this.maintenance) throw new Error("Maintenance already active");

    this.maintenance = true;

    try {
      if (options.dryRun == false && (this.active.size > 0 || this.pendingSnapshotAcquisitions > 0))
        throw new Error("Active transactions or pending snapshots prevent GC");

      const gc = new GarbageCollector(this.storage, this.keys, () => [...this.active]);

      return await gc.collect(options);
    } finally {
      this.metrics.garbageCollectionDurationMs += performance.now() - started;
      this.maintenance = false;
    }
  }

  private releaseSnapshot(snapshot: Snapshot, tx: Transaction): void {
    tx.close();

    if (!tx.hasPendingReads) {
      this.active.delete(snapshot);
      return;
    }

    void tx.waitForReads().then(() => {
      this.active.delete(snapshot);
    });
  }

  private queryOptions(options?: QueryExecutorOptions): QueryExecutorOptions {
    return {
      ...options,
      cursorSigningKey: options?.cursorSigningKey ?? this.cursorSigningKey,
    };
  }

  private bindSignal(context: QueryContext, signal?: AbortSignal): () => void {
    if (!signal) return () => {};

    const cancel = () => context.cancel(signal.reason ?? new Error("Query cancelled"));

    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });

    return () => signal.removeEventListener("abort", cancel);
  }

  private isOperator(
    value: QueryOperator | QueryExecutorOptions | undefined,
  ): value is QueryOperator {
    return value != null && typeof (value as QueryOperator).execute == "function";
  }

  private async acquireSnapshot(): Promise<Snapshot> {
    if (this.closed) throw new Error("Database is closed");
    if (this.maintenance) throw new Error("Database is in exclusive maintenance mode");

    this.pendingSnapshotAcquisitions++;

    try {
      const snapshot = await this.createSnapshot();

      if (this.maintenance) throw new Error("Database is in exclusive maintenance mode");

      this.active.add(snapshot);
      return snapshot;
    } finally {
      this.pendingSnapshotAcquisitions--;
    }
  }

  public getMetrics(): DuraxisMetrics {
    return {
      ...this.metrics,
      ...(this.storage.getMetrics ? { storage: this.storage.getMetrics() } : {}),
    };
  }

  public async close(options: { readonly closeStorage?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    if (this.active.size || this.pendingSnapshotAcquisitions)
      throw new Error("Cannot close database with active transactions or queries");
    this.closed = true;
    if (options.closeStorage) await this.storage.close?.();
  }

  private async createSnapshot(): Promise<Snapshot> {
    const stored = await this.storage.get(this.keys.manifestKey);

    return stored == null
      ? {
          manifest: emptyManifest(),
          storageVersion: null,
        }
      : {
          manifest: decodeManifest(stored.data, this.keys),
          storageVersion: stored.version,
        };
  }
}
