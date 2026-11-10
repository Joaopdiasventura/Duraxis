import type { StorageDriver } from "@duraxis/storage";

import { decodeManifest, emptyManifest, type Snapshot } from "../commit/manifest.js";

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

import {
  RECORD_PREFIX,
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
}

export interface CollectionRow {
  readonly id: string;
  readonly document: DocumentRecord;
}

export class DuraxisDatabase {
  private readonly storage: StorageDriver;
  private readonly keys: StorageKeyManager;
  private readonly coordinator: CommitCoordinator;
  private readonly recovery: RecoveryManager;
  private readonly primary: PrimaryIndex;
  private readonly secondary: SecondaryIndexManager;

  private readonly active = new Set<Snapshot>();
  private maintenance = false;
  private pendingSnapshotAcquisitions = 0;

  public constructor(options: DuraxisDatabaseOptions) {
    this.storage = options.storage;
    this.keys = new StorageKeyManager(options.namespace);
    this.coordinator = new CommitCoordinator(this.storage, this.keys);
    this.recovery = new RecoveryManager(this.storage, this.keys);
    this.primary = new PrimaryIndex(this.storage, this.keys);
    this.secondary = new SecondaryIndexManager(this.storage, this.keys);
  }

  public async transaction<T>(callback: (tx: Transaction) => Promise<T> | T): Promise<T> {
    const snapshot = await this.acquireSnapshot();
    const tx = new Transaction(this.storage, snapshot, this.keys);

    try {
      const result = await callback(tx);
      await this.coordinator.commit(tx);
      return result;
    } catch (error) {
      tx.abort();
      throw error;
    } finally {
      this.releaseSnapshot(snapshot, tx);
    }
  }

  public async snapshot<T>(callback: (reader: SnapshotReader) => Promise<T> | T): Promise<T> {
    const snapshot = await this.acquireSnapshot();
    const tx = new Transaction(this.storage, snapshot, this.keys);

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

  public async addIndex(collection: string, index: SecondaryIndexDefinition): Promise<void> {
    await this.transaction((tx) => {
      tx.addIndex(collection, index);
    });
  }

  public async removeIndex(collection: string, indexName: string): Promise<void> {
    await this.transaction((tx) => tx.removeIndex(collection, indexName));
  }

  public query(
    query: LogicalQuery,
    source: QueryOperator,
    options?: QueryExecutorOptions,
  ): AsyncIterable<QueryRow> {
    const database = this;

    return (async function* () {
      const snapshot = await database.acquireSnapshot();
      const context = new QueryContext(database.storage, snapshot, database.keys);

      try {
        yield* new QueryExecutor(options).execute(context, query, source);
      } finally {
        context.close();
        database.active.delete(snapshot);
      }
    })();
  }

  public async queryPage(
    query: LogicalQuery,
    source: QueryOperator,
    options?: QueryExecutorOptions,
  ): Promise<QueryPage> {
    const snapshot = await this.acquireSnapshot();
    const context = new QueryContext(this.storage, snapshot, this.keys);
    
    try {
      return await new QueryExecutor(options).page(context, query, source);
    } finally {
      context.close();
      this.active.delete(snapshot);
    }
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
    if (storage != this.storage) throw new Error("GC driver must match database storage");
    if (this.maintenance) throw new Error("Maintenance already active");

    this.maintenance = true;

    try {
      if (options.dryRun == false && (this.active.size > 0 || this.pendingSnapshotAcquisitions > 0))
        throw new Error("Active transactions or pending snapshots prevent GC");

      const gc = new GarbageCollector(this.storage, this.keys, () => [...this.active]);

      return await gc.collect(options);
    } finally {
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

  private async acquireSnapshot(): Promise<Snapshot> {
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
