import { diffSchemas, type SchemaPlan } from "./diff.js";
import { randomUUID } from "node:crypto";
import {
  CommitOutcomeUnknownError,
  TransactionConflictError,
  type DuraxisDatabase,
  type Transaction,
} from "@duraxis/core";
import { createMigrationContext, type MigrationContext } from "./context.js";
import {
  canonicalJSON,
  schemaHash,
  validateMigrationId,
  validateSnapshot,
  type SchemaSnapshot,
} from "./schema.js";

export interface DuraxisMigration {
  readonly id: string;
  up(context: MigrationContext): Promise<void> | void;
  down?(context: MigrationContext): Promise<void> | void;
}

export function defineMigration<const T extends DuraxisMigration>(migration: T): T {
  validateMigrationId(migration.id);

  if (
    typeof migration.up != "function" ||
    (migration.down !== undefined && typeof migration.down != "function")
  )
    throw new Error("Invalid migration callbacks");

  return Object.freeze(migration);
}

export interface MigrationArtifact {
  readonly migration: DuraxisMigration;
  readonly checksum: string;
  readonly snapshot: SchemaSnapshot;
}

export interface MigrationHistoryEntry {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: string;
  readonly sequence: number;
  readonly schemaHash: string;
  readonly operationId: string;
}

interface History {
  readonly formatVersion: 1;
  readonly revision: string;
  readonly entries: readonly MigrationHistoryEntry[];
}

const namespace = "migrations";
const digest = /^sha256:[a-f0-9]{64}$/;

async function readHistory(tx: Transaction): Promise<History> {
  const bytes = await tx.getMetadata(namespace);

  if (bytes == null) return { formatVersion: 1, revision: "", entries: [] };
  const history: History = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

  if (
    history.formatVersion !== 1 ||
    !Array.isArray(history.entries) ||
    typeof history.revision != "string"
  )
    throw new Error("Invalid migration history");

  history.entries.forEach((entry, index) => {
    validateMigrationId(entry.id);

    if (
      entry.sequence != index + 1 ||
      !digest.test(entry.checksum) ||
      !digest.test(entry.schemaHash) ||
      typeof entry.operationId != "string" ||
      !Number.isFinite(Date.parse(entry.appliedAt)) ||
      (index && history.entries[index - 1]!.id >= entry.id)
    )
      throw new Error("Invalid migration history ordering or metadata");
  });

  return history;
}

function writeHistory(tx: Transaction, history: History): void {
  tx.putMetadata(namespace, new TextEncoder().encode(canonicalJSON(history)));
}

export function validateArtifacts(artifacts: readonly MigrationArtifact[]): void {
  let parent: string | null = null;

  for (const artifact of artifacts) {
    defineMigration(artifact.migration);
    validateSnapshot(artifact.snapshot);

    if (!digest.test(artifact.checksum)) throw new Error("Invalid artifact checksum");

    if (
      artifact.snapshot.migrationId != artifact.migration.id ||
      artifact.snapshot.parentMigrationId != parent ||
      (parent && parent >= artifact.migration.id)
    )
      throw new Error("Duplicate, unordered, or divergent migration chain");

    parent = artifact.migration.id;
  }
}

export interface RunOptions {
  readonly steps?: number;
  readonly to?: string;
  readonly allowDestructive?: boolean;
}

export class MigrationRunner {
  private readonly managedNames: ReadonlySet<string>;

  public constructor(
    private readonly database: DuraxisDatabase,
    private readonly artifacts: readonly MigrationArtifact[],
  ) {
    validateArtifacts(artifacts);

    this.managedNames = new Set(
      artifacts.flatMap((artifact) => artifact.snapshot.collections.map((schema) => schema.name)),
    );
  }

  private async validate(tx: Transaction, checkSchema = true): Promise<History> {
    const history = await readHistory(tx);

    history.entries.forEach((entry, index) => {
      const artifact = this.artifacts[index];

      if (!artifact || artifact.migration.id != entry.id)
        throw new Error(`Missing migration or divergent history: ${entry.id}`);

      if (artifact.checksum != entry.checksum)
        throw new Error(`Applied migration checksum mismatch: ${entry.id}`);

      if (artifact.snapshot.schemaHash != entry.schemaHash)
        throw new Error(`Applied snapshot mismatch: ${entry.id}`);
    });

    const expected = history.entries.at(-1)?.schemaHash ?? schemaHash([]);

    if (
      checkSchema &&
      schemaHash(
        tx.getCollectionDefinitions().filter((schema) => this.managedNames.has(schema.name)),
      ) != expected
    )
      throw new Error("Database schema drift detected");

    return history;
  }

  public async status(): Promise<{
    applied: readonly MigrationHistoryEntry[];
    pending: readonly string[];
  }> {
    return this.database.transaction(async (tx) => {
      const history = await this.validate(tx);

      return {
        applied: history.entries,
        pending: this.artifacts
          .slice(history.entries.length)
          .map((artifact) => artifact.migration.id),
      };
    });
  }

  public async drift(): Promise<SchemaPlan> {
    return this.database.transaction(async (tx) => {
      const history = await this.validate(tx, false);

      return diffSchemas(
        this.artifacts[history.entries.length - 1]?.snapshot.collections ?? [],
        tx.getCollectionDefinitions().filter((schema) => this.managedNames.has(schema.name)),
      );
    });
  }

  private validateOptions(options: RunOptions): void {
    if (options.steps !== undefined && (!Number.isSafeInteger(options.steps) || options.steps < 0))
      throw new Error("Invalid migration steps");

    if (options.to && !this.artifacts.some((artifact) => artifact.migration.id == options.to))
      throw new Error(`Unknown migration target: ${options.to}`);

    if (options.to && options.steps !== undefined) throw new Error("Use either --steps or --to");
  }

  public async up(options: RunOptions = {}): Promise<readonly string[]> {
    this.validateOptions(options);

    const status = await this.status();
    const selected = this.artifacts
      .slice(status.applied.length)
      .filter((artifact) => !options.to || artifact.migration.id <= options.to)
      .slice(0, options.steps ?? Infinity);

    const completed: string[] = [];

    for (const artifact of selected) {
      await this.execute(artifact, "up", options);
      completed.push(artifact.migration.id);
    }

    return completed;
  }

  public async down(options: RunOptions = {}): Promise<readonly string[]> {
    this.validateOptions(options);

    if (!options.allowDestructive)
      throw new Error("Rollback requires explicit destructive authorization");

    const status = await this.status();

    if (options.to && !status.applied.some((entry) => entry.id == options.to))
      throw new Error("Rollback target is not applied");

    const selected = this.artifacts
      .slice(0, status.applied.length)
      .reverse()
      .filter((artifact) => !options.to || artifact.migration.id > options.to)
      .slice(0, options.steps ?? (options.to ? Infinity : 1));

    for (const artifact of selected)
      if (!artifact.migration.down)
        throw new Error(`Irreversible migration: ${artifact.migration.id}`);

    const completed: string[] = [];

    for (const artifact of selected) {
      await this.execute(artifact, "down", options);
      completed.push(artifact.migration.id);
    }

    return completed;
  }

  public async baseline(): Promise<void> {
    if (this.artifacts.length != 1)
      throw new Error("Baseline requires exactly one initial artifact");

    const artifact = this.artifacts[0]!;
    const operationId = randomUUID();

    try {
      await this.database.transaction(async (tx) => {
        const history = await readHistory(tx);
        if (history.entries.length) throw new Error("Database already has migration history");

        this.assertSchema(tx, artifact.snapshot);

        writeHistory(tx, {
          formatVersion: 1,
          revision: operationId,
          entries: [this.entry(artifact, 1, operationId)],
        });
      });
    } catch (error) {
      await this.reconcile(error, operationId, "up", artifact);
    }
  }

  private entry(
    artifact: MigrationArtifact,
    sequence: number,
    operationId: string,
  ): MigrationHistoryEntry {
    return {
      id: artifact.migration.id,
      checksum: artifact.checksum,
      schemaHash: artifact.snapshot.schemaHash,
      appliedAt: new Date().toISOString(),
      sequence,
      operationId,
    };
  }

  private assertSchema(tx: Transaction, snapshot?: SchemaSnapshot): void {
    if (
      schemaHash(
        tx.getCollectionDefinitions().filter((schema) => this.managedNames.has(schema.name)),
      ) != (snapshot?.schemaHash ?? schemaHash([]))
    )
      throw new Error("Migration result does not match expected snapshot");
  }

  private async execute(
    artifact: MigrationArtifact,
    direction: "up" | "down",
    options: RunOptions,
  ): Promise<void> {
    const operationId = randomUUID();
    try {
      await this.database.transaction(async (tx) => {
        const history = await this.validate(tx);
        const index = this.artifacts.indexOf(artifact);

        if (direction == "up" && history.entries[index]?.id == artifact.migration.id) return;
        if ((direction == "up" ? history.entries.length : history.entries.length - 1) != index)
          throw new Error("Migration predecessor changed");

        const before = tx.getCollectionDefinitions();

        await (direction == "up" ? artifact.migration.up : artifact.migration.down!)(
          createMigrationContext(tx),
        );

        const after = new Map(tx.getCollectionDefinitions().map((schema) => [schema.name, schema]));

        if (
          !options.allowDestructive &&
          before.some(
            (schema) =>
              !after.has(schema.name) ||
              Object.keys(schema.fields ?? {}).some(
                (name) => !Object.hasOwn(after.get(schema.name)?.fields ?? {}, name),
              ),
          )
        )
          throw new Error("Destructive schema change requires explicit authorization");

        if (
          schemaHash(before.filter((schema) => !this.managedNames.has(schema.name))) !=
          schemaHash([...after.values()].filter((schema) => !this.managedNames.has(schema.name)))
        )
          throw new Error("Migration changed collections outside its snapshots");

        this.assertSchema(
          tx,
          direction == "up" ? artifact.snapshot : this.artifacts[index - 1]?.snapshot,
        );

        writeHistory(tx, {
          formatVersion: 1,
          revision: operationId,
          entries:
            direction == "up"
              ? [...history.entries, this.entry(artifact, index + 1, operationId)]
              : history.entries.slice(0, -1),
        });
      });
    } catch (error) {
      await this.reconcile(error, operationId, direction, artifact);
    }
  }

  private async reconcile(
    error: unknown,
    operationId: string,
    direction: "up" | "down",
    artifact: MigrationArtifact,
  ): Promise<void> {
    if (
      !(error instanceof TransactionConflictError) &&
      !(error instanceof CommitOutcomeUnknownError)
    )
      throw error;

    const history = await this.database.transaction((tx) => this.validate(tx));

    if (
      history.revision == operationId ||
      (direction == "up" &&
        history.entries.some(
          (entry) => entry.id == artifact.migration.id && entry.checksum == artifact.checksum,
        ))
    )
      return;

    if (
      error instanceof CommitOutcomeUnknownError &&
      (await this.database.getCommitStatus(error.transactionId)) == "committed"
    )
      return;

    throw error;
  }
}
