import type { CursorKeyring } from "../query/model/cursor.js";
import { storageCoordination } from "../gc/storage-coordination.js";
import { OperationOwner } from "../resources/operation-owner.js";
import { OperationCancelledError } from "../resources/resource-manager.js";
import {
  databaseScope,
  resourceLimits,
  materialize,
  estimateBytes,
  type ResourceLimits,
  type ResourceScope,
} from "../resources/resource-manager.js";
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
  readonly resources?: Partial<ResourceLimits>;
  readonly cursorEncryption?: CursorKeyring;
  readonly accessScope?: {
    readonly tenant: string;
    readonly currentTenant: () => string | undefined;
  };
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
  readonly resources: ReturnType<ResourceScope["metrics"]>;
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

  const foreignKeys = Object.freeze(
    (normalized.foreignKeys ?? []).map((foreignKey) =>
      Object.freeze({
        ...foreignKey,
        references: Object.freeze({ ...foreignKey.references }),
      }),
    ),
  );

  return Object.freeze({
    ...normalized,
    ...(fields == null ? {} : { fields }),
    indexes,
    ...(foreignKeys.length == 0 ? {} : { foreignKeys }),
  });
}

export class DuraxisDatabase {
  public readonly resourceLimits: Readonly<ResourceLimits>;
  public readonly resources: ResourceScope;
  private readonly cursorEncryption?: CursorKeyring;
  private readonly accessScope?: DuraxisDatabaseOptions["accessScope"];
  private readonly storage: StorageDriver;
  private readonly keys: StorageKeyManager;
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
  private readonly owners = new Map<Snapshot, OperationOwner>();
  private readonly operations = new Set<OperationOwner>();
  private closePromise?: Promise<void>;
  private readonly cleanupFailures: unknown[] = [];
  private readonly outcomes = new Map<
    string,
    { status: "COMMITTED" | "NOT_COMMITTED"; expires: number }
  >();

  private readonly drainWaiters = new Set<() => void>();
  private maintenance = false;
  private pendingSnapshotAcquisitions = 0;
  private closed = false;

  public constructor(options: DuraxisDatabaseOptions) {
    if (options.storage.capabilities?.boundedReads !== true)
      throw new Error(
        "Core requires a storage driver with verified bounded-read support; update the driver contract",
      );

    this.resourceLimits = resourceLimits(options.resources);
    this.resources = databaseScope(this.resourceLimits);
    this.accessScope = options.accessScope ? Object.freeze({ ...options.accessScope }) : undefined;

    if (
      this.accessScope &&
      (!options.namespace ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(this.accessScope.tenant) ||
        typeof this.accessScope.currentTenant != "function")
    )
      throw new Error("Tenant scope requires an explicit namespace and trusted tenant resolver");

    this.cursorEncryption = options.cursorEncryption
      ? {
          ...options.cursorEncryption,
          keys: Object.fromEntries(
            Object.entries(options.cursorEncryption.keys).map(([id, key]) => [
              id,
              new Uint8Array(key),
            ]),
          ),
        }
      : undefined;

    this.storage = options.storage;
    this.keys = new StorageKeyManager(options.namespace);

    this.cursorSigningKey =
      options.cursorSigningKey == null ? randomBytes(32) : new Uint8Array(options.cursorSigningKey);

    if (this.cursorSigningKey.byteLength < 32)
      throw new Error("Cursor signing key must contain at least 32 bytes");
  }

  public get namespace(): string {
    return this.keys.namespace;
  }

  public static forTenant(
    options: Omit<DuraxisDatabaseOptions, "namespace" | "accessScope"> & {
      readonly tenant: string;
      readonly currentTenant: () => string | undefined;
    },
  ): DuraxisDatabase {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.tenant)) throw new Error("Invalid tenant identifier");

    return new DuraxisDatabase({
      ...options,
      namespace: `tenants/${options.tenant}/v1`,
      accessScope: { tenant: options.tenant, currentTenant: options.currentTenant },
    });
  }

  private assertAccess(): void {
    if (this.accessScope && this.accessScope.currentTenant() !== this.accessScope.tenant)
      throw new Error("Missing or incorrect tenant access scope");
  }

  public async transaction<T>(callback: (tx: Transaction) => Promise<T> | T): Promise<T> {
    this.assertAccess();
    this.metrics.transactionsStarted++;
    const snapshot = await this.acquireSnapshot("transaction");
    const owner = this.owners.get(snapshot)!;
    let tx: Transaction;
    try {
      tx = new Transaction(
        owner.storage,
        snapshot,
        this.keys,
        this.cursorSigningKey,
        owner.scope,
        this.resourceLimits,
        owner.signal,
        () => owner.protectPublication(),
        () => this.assertAccess(),
        {
          cursorEncryption: this.cursorEncryption,
          onPendingCleanup: (promise) => owner.holdCleanup(promise),
          onCleanupFailure: (error) => {
            if (this.cleanupFailures.length < 16)
              this.cleanupFailures.push(
                new Error("Deferred query cleanup failed; inspect storage health"),
              );
          },
        },
      );
    } catch (error) {
      owner.finish();
      throw error;
    }

    const abort = () => tx.close();
    owner.signal.addEventListener("abort", abort, { once: true });

    try {
      const result = await owner.wait(Promise.resolve().then(() => callback(tx)));

      const started = performance.now();

      try {
        await new CommitCoordinator(owner.storage, this.keys, this.storage).commit(tx);
      } finally {
        this.metrics.commitDurationMs += performance.now() - started;
      }

      this.rememberOutcome(tx.id, "COMMITTED");
      this.metrics.transactionsCommitted++;

      return result;
    } catch (error) {
      if (error instanceof TransactionConflictError) this.metrics.transactionConflicts++;
      if (error instanceof CommitOutcomeUnknownError) this.metrics.commitOutcomesUnknown++;

      if (!(error instanceof CommitOutcomeUnknownError))
        this.rememberOutcome(tx.id, "NOT_COMMITTED");

      tx.abort();
      throw error;
    } finally {
      owner.signal.removeEventListener("abort", abort);
      this.releaseSnapshot(snapshot, tx);
    }
  }

  private rememberOutcome(id: string, status: "COMMITTED" | "NOT_COMMITTED"): void {
    if (this.outcomes.size >= 1024) this.outcomes.delete(this.outcomes.keys().next().value!);
    this.outcomes.set(id, { status, expires: Date.now() + 24 * 60 * 60_000 });
  }

  public async resolveCommitOutcome(
    id: string,
  ): Promise<"COMMITTED" | "NOT_COMMITTED" | "UNKNOWN"> {
    this.assertAccess();

    const retained = this.outcomes.get(id);

    if (retained && retained.expires > Date.now()) return retained.status;

    const receipt = await this.transaction(async (tx) => {
      const bytes = await tx.getMetadata("idempotency");

      if (!bytes) return false;

      const entries = JSON.parse(new TextDecoder().decode(bytes)) as Record<
        string,
        { id: string; expires: number }
      >;

      return Object.values(entries).some((entry) => entry.id == id && entry.expires > Date.now());
    });

    if (receipt) return "COMMITTED";

    return (await this.getCommitStatus(id)) == "committed" ? "COMMITTED" : "UNKNOWN";
  }

  public async transactionOnce<T>(
    operationId: string,
    callback: (tx: Transaction) => Promise<T> | T,
  ): Promise<{ readonly applied: boolean; readonly transactionId: string; readonly result?: T }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId))
      throw new Error("Invalid idempotency identifier");

    try {
      return await this.transaction(async (tx) => {
        const bytes = await tx.getMetadata("idempotency");

        const ledger = bytes
          ? (JSON.parse(new TextDecoder().decode(bytes)) as Record<
              string,
              { id: string; expires: number }
            >)
          : {};

        const existing = Object.hasOwn(ledger, operationId) ? ledger[operationId] : undefined;

        if (existing && existing.expires > Date.now())
          return { applied: false, transactionId: existing.id };

        const live = Object.fromEntries(
          Object.entries(ledger).filter(([, entry]) => entry.expires > Date.now()),
        );

        if (Object.keys(live).length >= 1024)
          throw new Error(
            "Idempotency retention capacity exceeded; wait for expiration or use a separate namespace",
          );

        const result = await callback(tx);

        Object.defineProperty(live, operationId, {
          value: { id: tx.id, expires: Date.now() + 24 * 60 * 60_000 },
          enumerable: true,
        });

        tx.putMetadata("idempotency", new TextEncoder().encode(JSON.stringify(live)));

        return { applied: true, transactionId: tx.id, result };
      });
    } catch (error) {
      if (
        !(error instanceof TransactionConflictError) &&
        !(error instanceof CommitOutcomeUnknownError)
      )
        throw error;

      const receipt = await this.transaction(async (tx) => {
        const bytes = await tx.getMetadata("idempotency");

        if (!bytes) return undefined;

        const ledger = JSON.parse(new TextDecoder().decode(bytes)) as Record<
          string,
          { id: string; expires: number }
        >;

        return Object.hasOwn(ledger, operationId) && ledger[operationId]!.expires > Date.now()
          ? ledger[operationId]
          : undefined;
      });

      if (receipt) return { applied: false, transactionId: receipt.id };

      throw error;
    }
  }

  public async snapshot<T>(callback: (reader: SnapshotReader) => Promise<T> | T): Promise<T> {
    const snapshot = await this.acquireSnapshot();
    const owner = this.owners.get(snapshot)!;

    let tx: Transaction;

    try {
      tx = new Transaction(
        owner.storage,
        snapshot,
        this.keys,
        this.cursorSigningKey,
        owner.scope,
        this.resourceLimits,
        owner.signal,
        () => owner.protectPublication(),
        () => this.assertAccess(),
        {
          cursorEncryption: this.cursorEncryption,
          onPendingCleanup: (promise) => owner.holdCleanup(promise),
          onCleanupFailure: (error) => {
            if (this.cleanupFailures.length < 16)
              this.cleanupFailures.push(
                new Error("Deferred query cleanup failed; inspect storage health"),
              );
          },
        },
      );
    } catch (error) {
      owner.finish();
      throw error;
    }

    const abort = () => tx.close();

    owner.signal.addEventListener("abort", abort, { once: true });

    try {
      return await owner.wait(
        Promise.resolve().then(() =>
          callback({
            get: (key: string) => tx.get(key),
          }),
        ),
      );
    } finally {
      owner.signal.removeEventListener("abort", abort);
      this.releaseSnapshot(snapshot, tx);
    }
  }

  public async defineCollection(schema: CollectionDefinition): Promise<void> {
    await this.transaction((tx) => {
      tx.defineCollection(schema);
    });
  }

  public async defineCollections(schemas: readonly CollectionDefinition[]): Promise<void> {
    await this.transaction((tx) => tx.defineCollections(schemas));
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
      this.finishSnapshot(snapshot);
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

    const iterator = (async function* () {
      const started = performance.now();

      database.metrics.queries++;

      const snapshot = await database.acquireSnapshot("query");
      const context = database.queryContext(snapshot);

      context.bindCancellation(() => iterator.return(undefined));

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
            database.planner.plan(query, context.catalog, context.limits),
            context.catalog,
          );
        yield* new QueryExecutor(database.queryOptions(options)).execute(context, query, source);
      } finally {
        unbindSignal();
        database.metrics.queryDurationMs += performance.now() - started;
        context.close();
        database.finishSnapshot(snapshot);
      }
    })();

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
    const started = performance.now();
    this.metrics.queries++;
    const snapshot = await this.acquireSnapshot();
    const context = this.queryContext(snapshot);
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
      this.metrics.queryDurationMs += performance.now() - started;
      context.close();
      this.finishSnapshot(snapshot);
    }
  }

  public async queryAll(
    query: LogicalQuery,
    options?: QueryExecutorOptions,
  ): Promise<readonly QueryRow[]> {
    const rows: QueryRow[] = [];
    const results = materialize<QueryRow>(this.resources, this.resourceLimits);

    try {
      for await (const row of this.query(query, options)) {
        results.add(row);
        rows.push(row);
      }

      return rows;
    } finally {
      results.close();
    }
  }

  public createMaterializationBudget<T>() {
    return materialize<T>(this.resources, this.resourceLimits);
  }

  public async explain(query: LogicalQuery): Promise<ExplainResult> {
    const snapshot = await this.acquireSnapshot();
    try {
      return explainPhysicalPlan(
        this.planner.plan(query, snapshot.manifest.catalog, this.resourceLimits),
      );
    } finally {
      this.finishSnapshot(snapshot);
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

    const iterator = (async function* () {
      const snapshot = await database.acquireSnapshot("query");
      const context = database.queryContext(snapshot);

      context.bindCancellation(() => iterator.return(undefined));

      const unbindSignal = database.bindSignal(context, options?.signal);

      try {
        const source = database.planCompiler.compile(plan, context.catalog);
        yield* new QueryExecutor(database.queryOptions(options)).execute(context, query, source);
      } finally {
        unbindSignal();
        context.close();
        database.finishSnapshot(snapshot);
      }
    })();

    return iterator;
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
    const context = this.queryContext(snapshot);
    const memory = this.createMaterializationBudget<CollectionRow>();

    const rows: CollectionRow[] = [];

    try {
      for await (const row of context.scanIndex(collection, indexName, { eq: value, limit })) {
        memory.add(row);
        rows.push(row);
      }

      return rows;
    } finally {
      memory.close();
      context.close();
      this.finishSnapshot(snapshot);
    }
  }

  public async scanCollection(collection: string, limit = 100): Promise<CollectionRow[]> {
    const snapshot = await this.acquireSnapshot();
    const context = this.queryContext(snapshot);

    const memory = this.createMaterializationBudget<CollectionRow>();

    const rows: CollectionRow[] = [];

    try {
      for await (const row of context.scanCollection(collection, { limit })) {
        memory.add(row);
        rows.push(row);
      }

      return rows;
    } finally {
      memory.close();
      context.close();
      this.finishSnapshot(snapshot);
    }
  }

  public async getCommitStatus(transactionId: string) {
    const snapshot = await this.acquireSnapshot();

    try {
      return await new RecoveryManager(
        this.owners.get(snapshot)!.storage,
        this.keys,
      ).getCommitStatus(transactionId);
    } finally {
      this.finishSnapshot(snapshot);
    }
  }

  public async verifyHistory(): Promise<number> {
    const snapshot = await this.acquireSnapshot();

    try {
      return await new RecoveryManager(
        this.owners.get(snapshot)!.storage,
        this.keys,
      ).verifyHistory();
    } finally {
      this.finishSnapshot(snapshot);
    }
  }

  public async checkpointHistory(): Promise<string> {
    this.assertAccess();
    if (this.closed) throw new Error("Database is closed");

    if (this.maintenance || this.active.size || this.pendingSnapshotAcquisitions)
      throw new Error("History checkpoint requires exclusive database maintenance");

    const shared = storageCoordination(this.storage);

    if (shared.maintenance || shared.active)
      throw new Error("History checkpoint requires exclusive database maintenance");

    shared.maintenance = true;
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
      shared.maintenance = false;
    }
  }

  public async verifyIntegrity(): Promise<{
    objects: number;
    nodes: number;
    indexes: number;
    commits: number;
  }> {
    const snapshot = await this.acquireSnapshot();

    const owner = this.owners.get(snapshot)!;
    const storage = owner.storage;
    const primary = new PrimaryIndex(storage, this.keys);

    try {
      const scanner = new ManifestReachabilityScanner(this.keys, storage);
      const nodes = new BPlusTreeNodeStore(storage, this.keys);
      const reachable = await scanner.scan(snapshot);

      let objectsCount = 0;
      let nodesCount = 0;

      for (const ref of reachable)
        if (ref.startsWith(this.keys.objectPrefix)) {
          await primary.readObject(ref);
          objectsCount++;
        } else {
          this.keys.validateIndexNodeKey(ref);
          await nodes.read(ref);
          nodesCount++;
        }

      const checker = new IndexConsistencyChecker(storage, this.keys);
      const indexes = await checker.verify(snapshot.manifest);
      const commits = await new RecoveryManager(storage, this.keys).verifyHistory();

      return {
        objects: objectsCount,
        nodes: nodesCount,
        indexes,
        commits,
      };
    } finally {
      this.finishSnapshot(snapshot);
    }
  }

  public async collectGarbage(
    storage: StorageDriver,
    options: GarbageCollectionOptions = {},
  ): Promise<GarbageCollectionReport> {
    this.assertAccess();
    const started = performance.now();

    this.metrics.garbageCollections++;

    if (storage != this.storage) throw new Error("GC driver must match database storage");
    if (this.maintenance) throw new Error("Maintenance already active");

    this.maintenance = true;

    try {
      if (options.dryRun == false && (this.active.size > 0 || this.pendingSnapshotAcquisitions > 0))
        throw new Error("Active transactions or pending snapshots prevent GC");

      const gc = new GarbageCollector(
        this.storage,
        this.keys,
        () => [...this.active],
        new ManifestReachabilityScanner(this.keys, this.storage),
        this.resources,
      );

      return await gc.collect(options);
    } finally {
      this.metrics.garbageCollectionDurationMs += performance.now() - started;
      this.maintenance = false;
    }
  }

  private finishSnapshot(snapshot: Snapshot): void {
    this.owners.get(snapshot)?.finish();
  }
  private queryContext(snapshot: Snapshot): QueryContext {
    const owner = this.owners.get(snapshot)!;

    let context: QueryContext;

    const abort = () => context.cancel(owner.signal.reason);

    try {
      context = new QueryContext(owner.storage, snapshot, this.keys, {
        resources: owner.scope,
        limits: this.resourceLimits,
        assertAccess: () => this.assertAccess(),
        onPendingCleanup: (promise) => owner.holdCleanup(promise),
        onCleanupFailure: (error) => {
          if (this.cleanupFailures.length < 16)
            this.cleanupFailures.push(
              new Error("Deferred query cleanup failed; inspect storage health"),
            );
        },
        onClose: () => {
          owner.signal.removeEventListener("abort", abort);
          owner.finish();
        },
      });
    } catch (error) {
      owner.finish();
      throw error;
    }

    owner.signal.addEventListener("abort", abort, { once: true });

    if (owner.signal.aborted) abort();

    return context;
  }

  private releaseSnapshot(snapshot: Snapshot, tx: Transaction): void {
    tx.close();
    this.finishSnapshot(snapshot);
  }

  private queryOptions(options?: QueryExecutorOptions): QueryExecutorOptions {
    return {
      ...options,
      cursorSigningKey: this.cursorSigningKey,
      cursorEncryption: this.cursorEncryption,
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

  private async acquireSnapshot(
    kind: "transaction" | "query" | "snapshot" = "snapshot",
  ): Promise<Snapshot> {
    this.assertAccess();
    if (this.closed) throw new Error("Database is closed");

    if (this.maintenance || storageCoordination(this.storage).maintenance)
      throw new Error("Database is in exclusive maintenance mode");

    const scope = this.resources.child({
      workingBytes:
        kind == "query"
          ? this.resourceLimits.maxQueryWorkingBytes
          : this.resourceLimits.maxTransactionWorkingBytes,
    });

    try {
      scope.reserve({ snapshots: 1 });
    } catch (error) {
      scope.close();
      throw error;
    }

    const shared = storageCoordination(this.storage);

    shared.active++;

    let snapshot: Snapshot | undefined;

    const owner = new OperationOwner(
      scope,
      this.storage,
      Math.min(
        this.resourceLimits.maxSnapshotLifetimeMs,
        kind == "transaction"
          ? this.resourceLimits.maxTransactionDurationMs
          : kind == "query"
            ? this.resourceLimits.maxQueryDurationMs
            : this.resourceLimits.maxSnapshotLifetimeMs,
      ),
      () => {
        if (snapshot) {
          this.active.delete(snapshot);
          this.owners.delete(snapshot);
          shared.snapshots.delete(snapshot);
        }
        shared.active--;
        this.operations.delete(owner);
        if (!this.operations.size) for (const resolve of [...this.drainWaiters]) resolve();
      },
      this.resourceLimits.maxStorageReadBytes,
    );

    this.operations.add(owner);
    this.pendingSnapshotAcquisitions++;

    try {
      const stored = await owner.wait(owner.storage.get(this.keys.manifestKey));

      if (this.maintenance || this.closed) throw new Error("Database is not accepting snapshots");

      snapshot =
        stored == null
          ? { manifest: emptyManifest(), storageVersion: null }
          : { manifest: decodeManifest(stored.data, this.keys), storageVersion: stored.version };

      scope.reserve({
        workingBytes:
          estimateBytes([...snapshot.manifest.catalog]) +
          estimateBytes([...snapshot.manifest.indexRoots]),
      });

      this.active.add(snapshot);
      shared.snapshots.add(snapshot);
      this.owners.set(snapshot, owner);

      return snapshot;
    } catch (error) {
      owner.finish();
      throw error;
    } finally {
      this.pendingSnapshotAcquisitions--;
    }
  }

  public getMetrics(): DuraxisMetrics {
    return {
      ...this.metrics,
      resources: this.resources.metrics(),
      ...(this.storage.getMetrics ? { storage: this.storage.getMetrics() } : {}),
    };
  }

  public close(
    options: { readonly closeStorage?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closed = true;

    const timeout = options.timeoutMs ?? 30_000;

    if (!Number.isSafeInteger(timeout) || timeout < 1)
      return Promise.reject(new RangeError("Invalid shutdown deadline"));

    this.closePromise = (async () => {
      for (const owner of this.operations)
        owner.cancel(new OperationCancelledError("Database is shutting down"));

      if (this.operations.size)
        await new Promise<void>((resolve, reject) => {
          const complete = () => {
            clearTimeout(timer);
            this.drainWaiters.delete(complete);
            resolve();
          };

          const timer = setTimeout(() => {
            this.drainWaiters.delete(complete);
            reject(
              new OperationCancelledError(
                `Shutdown deadline exceeded; ${this.operations.size} operations still protect storage. Storage was not closed`,
              ),
            );
          }, timeout);

          this.drainWaiters.add(complete);

          if (!this.operations.size) complete();
        });

      if (options.closeStorage) await this.storage.close?.();

      if (this.cleanupFailures.length)
        throw new AggregateError(this.cleanupFailures.splice(0), "Deferred query cleanup failed");
    })();

    this.closePromise.catch(() => {
      this.closePromise = undefined;
    });

    return this.closePromise;
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
