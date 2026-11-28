import { access, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { exportSchema } from "@duraxis/orm";
import {
  MigrationRunner,
  validateArtifacts,
  createSnapshot,
  diffSchemas,
  schemaHash,
  type SchemaSnapshot,
  type SchemaPlan,
} from "@duraxis/migrations";
import {
  CommitOutcomeUnknownError,
  ResourceExhaustedError,
  OperationCancelledError,
  type CollectionDefinition,
  type DuraxisDatabase,
} from "@duraxis/core";
import {
  loadConfig,
  readJSON,
  requireMigrationConfig,
  type DuraxisConnectionConfig,
} from "../config.js";
import {
  artifactChecksum,
  loadArtifacts,
  migrationId,
  renderMigration,
  withArtifactLock,
  writePair,
  removePair,
} from "../artifacts.js";

import type { CLIIO } from "../cli.js";
import type { ParsedCommand } from "../registry/argument-parser.js";
class MigrationCleanupError extends Error {
  public constructor(cause: unknown) {
    super(
      "Migration database cleanup failed; inspect storage health and migration status before retrying",
      { cause },
    );
    this.name = "DuraxisMigrationCleanupError";
  }
}
async function withDatabase<T>(
  config: DuraxisConnectionConfig,
  callback: (database: DuraxisDatabase) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const database = await config.createDatabase();
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= database.close({ closeStorage: true }));
  const cancel = () => {
    // Observe rejection while the callback unwinds; finally awaits the same close
    // promise and reports cleanup failures rather than discarding them.
    void close().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await callback(database);
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
    try {
      await close();
    } catch (cause) {
      throw new MigrationCleanupError(cause);
    }
  }
}

function summary(plan: SchemaPlan): string {
  return plan.operations.length
    ? plan.operations
        .map(
          (operation) =>
            `${operation.before == null ? "+" : operation.after == null ? "-" : "~"} ${operation.kind} ${operation.collection}/${operation.name} (${operation.risk})`,
        )
        .join("\n")
    : "No schema differences.";
}

export async function executeMigration(parsed: ParsedCommand, io: CLIIO): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const out = io.out ?? console.log;
  const errorOut = io.error ?? console.error;
  const { values, positionals } = parsed;
  const command = parsed.definition.name;
  const name = positionals[0];
  const jsonErrors = values.json ?? false;
  try {
    io.signal?.throwIfAborted();
    const { config, root, path } = await loadConfig(cwd, values.config, values.database);

    io.signal?.throwIfAborted();
    const ownedDatabase = <T>(callback: (database: DuraxisDatabase) => Promise<T>) =>
      withDatabase(config, callback, io.signal);
    requireMigrationConfig(config);
    if (
      ["migration:generate", "migration:baseline"].includes(command) &&
      config.entities === undefined
    )
      throw new Error(
        "This command requires a configured ORM entity schema source. Use migration:create for Core-only manual migrations.",
      );
    const directory = resolve(root, config.migrations.directory);
    const snapshots = resolve(root, config.migrations.snapshots);

    const print = (value: unknown, text: string) => {
      io.signal?.throwIfAborted();
      out(values.json ? JSON.stringify(value, null, 2) : text);
    };

    let schemaExporter = exportSchema;
    let Runner = MigrationRunner;
    if (config.moduleFormat === "cjs") {
      const require = (await import("node:module")).createRequire(path);
      const migrations: unknown = require("@duraxis/migrations");
      const isMigrationModule = (
        value: unknown,
      ): value is Pick<typeof import("@duraxis/migrations"), "MigrationRunner"> =>
        value !== null &&
        typeof value === "object" &&
        "MigrationRunner" in value &&
        typeof value.MigrationRunner === "function";
      if (!isMigrationModule(migrations))
        throw new Error("Installed migrations package does not export MigrationRunner");
      Runner = migrations.MigrationRunner;
      const module: unknown =
        config.entities === undefined ? { exportSchema } : require("@duraxis/orm");
      const isOrmModule = (
        value: unknown,
      ): value is Pick<typeof import("@duraxis/orm"), "exportSchema"> =>
        value !== null &&
        typeof value === "object" &&
        "exportSchema" in value &&
        typeof value.exportSchema === "function";
      if (!isOrmModule(module))
        throw new Error("Installed ORM package does not export exportSchema");
      schemaExporter = module.exportSchema;
    }

    const entities = async () =>
      schemaExporter(
        typeof config.entities == "function" ? await config.entities() : (config.entities ?? []),
      );

    if (command == "migration:snapshot") {
      if (!values.schema)
        throw new Error("Provide --schema with a JSON array of expected collection definitions");

      await withArtifactLock(directory, async () => {
        const { readdir } = await import("node:fs/promises");

        const files = (await readdir(directory))
          .filter((file) => /\.(ts|mts|js|mjs)$/.test(file) && !/\.d\.(?:ts|mts)$/.test(file))
          .sort();

        const latest = files.at(-1);

        if (!latest) throw new Error("No manual migration found");

        const id = latest.replace(/\.(ts|mts|js|mjs)$/, "");

        const parent = files.at(-2)?.replace(/\.(ts|mts|js|mjs)$/, "") ?? null;

        if (parent) {
          const previous = await readJSON<SchemaSnapshot>(join(snapshots, `${parent}.json`));
          if (previous.migrationId != parent) throw new Error("Invalid predecessor snapshot");
        }

        const definitions = await readJSON<readonly CollectionDefinition[]>(
          resolve(cwd, values.schema!),
        );

        await writeFile(
          join(snapshots, `${id}.json`),
          JSON.stringify(createSnapshot(id, parent, definitions), null, 2) + "\n",
          { flag: "wx" },
        );
      });

      print(
        { status: "snapshot-saved" },
        "Saved intended manual snapshot. migrate:up verifies the actual result atomically.",
      );

      return 0;
    }

    if (["migration:create", "migration:generate", "migration:baseline"].includes(command)) {
      if (!name) throw new Error("A migration name is required");

      if (command == "migration:baseline" && !values.yes)
        throw new Error("Baseline adoption requires --yes");

      await withArtifactLock(directory, async () => {
        const local = await loadArtifacts(config, root, true);
        const previous = local.artifacts.at(-1);

        const id = migrationId(name, previous?.migration.id);
        const migrationPath = join(directory, `${id}.${config.migrations.format ?? "ts"}`);

        if (command == "migration:create") {
          await writeFile(migrationPath, renderMigration(id), { flag: "wx" });
          print(
            { id, unfinished: true },
            `Created ${id}. Implement up(), then use migration:snapshot --schema <collections.json>.`,
          );
          return;
        }

        const desired = await entities();

        const before = previous?.snapshot.collections ?? [];
        const plan = diffSchemas(before, desired);

        if (command == "migration:baseline" && local.artifacts.length) {
          if (local.artifacts.length != 1)
            throw new Error("Baseline requires exactly one initial artifact");

          const initial = local.artifacts[0]!;
          const creation = diffSchemas([], desired);

          if (
            initial.snapshot.schemaHash != schemaHash(desired) ||
            initial.checksum != artifactChecksum(renderMigration(initial.migration.id, creation))
          )
            throw new Error(
              "Existing baseline must be an unmodified generated initial-schema migration matching entities",
            );
          await ownedDatabase((database) => new Runner(database, local.artifacts).baseline());

          print(
            { baseline: initial.migration.id, registered: true },
            `Registered existing baseline ${initial.migration.id}`,
          );
          return;
        }

        if (!plan.operations.length) {
          print({ operations: [] }, "No schema differences.");
          return;
        }

        if (plan.operations.some((operation) => operation.risk == "requires-data-transformation"))
          throw new Error(
            "Automatic generation requires a manual data transformation. Use migration:create and provide a snapshot.",
          );

        if (
          plan.operations.some((operation) => operation.risk == "destructive") &&
          !values["allow-destructive"]
        )
          throw new Error("Destructive generation requires --allow-destructive");

        const snapshot = createSnapshot(id, previous?.migration.id ?? null, desired);

        if (command == "migration:baseline") {
          await ownedDatabase(async (database) => {
            const actual = await database.getCollectionDefinitions();
            const names = new Set(desired.map((schema) => schema.name));

            if (
              schemaHash(actual.filter((schema) => names.has(schema.name))) != snapshot.schemaHash
            )
              throw new Error("Persisted managed schema is incompatible with baseline");

            await writePair(
              migrationPath,
              renderMigration(id, plan),
              join(snapshots, `${id}.json`),
              snapshot,
            );

            const loaded = await loadArtifacts(config, root, true);

            await new Runner(database, loaded.artifacts).baseline();
          });
        } else
          await writePair(
            migrationPath,
            renderMigration(id, plan),
            join(snapshots, `${id}.json`),
            snapshot,
          );

        print({ id, operations: plan.operations }, `Created ${id}\n${summary(plan)}`);
      });

      return 0;
    }

    if (command == "migration:remove") {
      if (!values.yes)
        throw new Error("Removing the latest unpublished local migration requires --yes");

      await withArtifactLock(directory, async () => {
        const local = await loadArtifacts(config, root, true, true);

        const latestFile = local.files.at(-1);

        const latest = latestFile?.replace(/\.(ts|mts|js|mjs)$/, "");

        if (!latest) throw new Error("No local migration to remove");

        await ownedDatabase(async (database) => {
          const status = await new Runner(database, local.artifacts).status();

          if (status.applied.some((entry) => entry.id == latest))
            throw new Error("Cannot remove an applied migration");

          const snapshotPath = join(snapshots, `${latest}.json`);

          try {
            await access(snapshotPath);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;

            await unlink(join(directory, latestFile!));

            return;
          }

          await removePair(join(directory, latestFile!), snapshotPath);
        });

        print(
          { removed: latest },
          `Removed ${latest}. This checks only the configured database; never remove shared or released migrations.`,
        );
      });

      return 0;
    }

    const local = await loadArtifacts(config, root);
    const checkEntitySchema = async (): Promise<boolean> => {
      if (config.entities === undefined) return false;
      const difference = diffSchemas(
        local.artifacts.at(-1)?.snapshot.collections ?? [],
        await entities(),
      );
      if (difference.operations.length)
        throw new Error(`Unrepresented entity changes:\n${summary(difference)}`);
      return true;
    };

    if (command == "migrate:diff" && !values.persisted) {
      if (config.entities === undefined)
        throw new Error(
          "Local schema diff requires an entity schema source; use --persisted to validate the applied catalog",
        );
      const plan = diffSchemas(
        local.artifacts.at(-1)?.snapshot.collections ?? [],
        await entities(),
      );

      print(plan, summary(plan));

      return 0;
    }

    if (command == "migrate:check" && values.offline) {
      validateArtifacts(local.artifacts);

      const entitySchemaChecked = await checkEntitySchema();
      print(
        { valid: true, mode: "offline", entitySchemaChecked },
        entitySchemaChecked
          ? "Local files, snapshots, and entity schema are valid. Database history was not checked."
          : "Local files and snapshots are valid. No entity schema source configured; database history was not checked.",
      );

      return 0;
    }

    if (command == "migrate:up" && values["dry-run"]) {
      const steps = values.steps === undefined ? undefined : Number(values.steps);

      if (steps !== undefined && (!Number.isSafeInteger(steps) || steps < 0))
        throw new Error("Invalid steps");

      if (
        values.to &&
        (!local.artifacts.some((artifact) => artifact.migration.id == values.to) ||
          steps !== undefined)
      )
        throw new Error("Invalid target or conflicting --steps");

      const candidates = local.artifacts
        .filter((artifact) => !values.to || artifact.migration.id <= values.to)
        .slice(0, steps ?? Infinity)
        .map((artifact) => artifact.migration.id);

      print(
        { dryRun: true, appliedStateChecked: false, candidates },
        `Static preview only; database was not opened and applied state was not checked. Migration callbacks were not executed.\n${candidates.join("\n")}`,
      );

      return 0;
    }

    await ownedDatabase(async (database) => {
      const runner = new Runner(database, local.artifacts);

      const options = {
        ...(values.steps === undefined ? {} : { steps: Number(values.steps) }),
        ...(values.to ? { to: values.to } : {}),
        allowDestructive: values["allow-destructive"] ?? false,
      };

      if (command == "migrate:up") {
        const applied = await runner.up(options);

        print({ applied }, `Applied ${applied.length} migration(s).\n${applied.join("\n")}`);
      } else if (command == "migrate:down") {
        if (!values.yes)
          throw new Error("Rollback requires --yes; review backups and down() first");

        const reverted = await runner.down({ ...options, allowDestructive: true });

        print({ reverted }, `Reverted ${reverted.length} migration(s).`);
      } else if (command == "migrate:status") {
        const status = await runner.status();

        print(
          status,
          `Duraxis migration status\nDatabase: ${values.database ?? "default"}\n\nApplied:\n${status.applied.map((entry) => `  ${entry.id}`).join("\n")}\nPending:\n${status.pending.map((id) => `  ${id}`).join("\n")}\nSchema drift: none\n${status.applied.length} applied, ${status.pending.length} pending`,
        );
      } else if (command == "migrate:diff") {
        const plan = await runner.drift();

        print(plan, summary(plan));
      } else if (command == "migrate:check") {
        await runner.status();

        const entitySchemaChecked = await checkEntitySchema();
        print(
          { valid: true, entitySchemaChecked },
          entitySchemaChecked
            ? "Migration files, snapshots, history, schema, and entities are valid."
            : "Migration files, snapshots, history and persisted schema are valid. No entity schema source configured.",
        );
      }
    });

    return 0;
  } catch (error) {
    if (io.signal?.aborted || error instanceof MigrationCleanupError) throw error;
    const message =
      error instanceof CommitOutcomeUnknownError
        ? `Commit outcome is unknown for transaction ${error.transactionId}. Reconcile migration status before retrying; do not repeat external side effects.`
        : error instanceof ResourceExhaustedError
          ? error.message
          : error instanceof OperationCancelledError
            ? "Duraxis operation cancelled or deadline exceeded. Check configured resource deadlines and storage health."
            : error instanceof Error
              ? error.message
              : String(error);

    errorOut(jsonErrors ? JSON.stringify({ error: message }) : message);

    return 1;
  }
}
