import { parseArgs } from "node:util";
import { access, mkdir, writeFile, unlink } from "node:fs/promises";
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
import { loadConfig, readJSON, type DuraxisConnectionConfig } from "./config.js";
import {
  artifactChecksum,
  loadArtifacts,
  migrationId,
  renderMigration,
  withArtifactLock,
  writePair,
  removePair,
} from "./artifacts.js";

export interface CLIIO {
  readonly cwd?: string;
  readonly out?: (message: string) => void;
  readonly error?: (message: string) => void;
}

const help = `duraxis <command> [options]
  init
  migration:create <name>
  migration:generate <name> [--allow-destructive]
  migration:snapshot --schema <collections.json>
  migration:remove --yes
  migration:baseline <name> --yes
  migrate:up [--steps N | --to ID] [--dry-run] [--allow-destructive]
  migrate:down [--steps N | --to ID] --yes
  migrate:status
  migrate:diff [--persisted]
  migrate:check [--offline]
Options: --config PATH --database NAME --json
Rollback --to retains the target version. Dry-run is a static preview only.`;

async function withDatabase<T>(
  config: DuraxisConnectionConfig,
  callback: (database: DuraxisDatabase) => Promise<T>,
): Promise<T> {
  const database = await config.createDatabase();

  try {
    return await callback(database);
  } finally {
    await database.close({ closeStorage: true });
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

async function init(cwd: string): Promise<void> {
  const configPath = resolve(cwd, "duraxis.config.ts");
  const base = resolve(cwd, "duraxis/snapshots/baseline.json");

  for (const path of [configPath, base])
    try {
      await access(path);
      throw new Error(`Refusing to overwrite ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code != "ENOENT") throw error;
    }

  await mkdir(resolve(cwd, "duraxis/migrations"), { recursive: true });
  await mkdir(resolve(cwd, "duraxis/snapshots"), { recursive: true });

  await writeFile(
    configPath,
    `import { defineDuraxisConfig } from "@duraxis/cli";

export default defineDuraxisConfig({
  entities: [], // Import your decorated entity classes here.
  migrations: { directory: "./duraxis/migrations", snapshots: "./duraxis/snapshots", format: "ts" },
  async createDatabase() {
    // Return a DuraxisDatabase configured with your storage driver.
    // The CLI closes this database and its storage after every command.
    throw new Error("Configure createDatabase() before accessing a database");
  },
});
`,
    { flag: "wx" },
  );

  try {
    await writeFile(base, JSON.stringify(createSnapshot(null, null, []), null, 2) + "\n", {
      flag: "wx",
    });
  } catch (error) {
    await unlink(configPath);
    throw error;
  }
}

export async function runCLI(args: readonly string[], io: CLIIO = {}): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const out = io.out ?? console.log;

  const errorOut = io.error ?? console.error;

  let jsonErrors = false;

  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string" },
        database: { type: "string" },
        json: { type: "boolean" },
        steps: { type: "string" },
        to: { type: "string" },
        "dry-run": { type: "boolean" },
        "allow-destructive": { type: "boolean" },
        yes: { type: "boolean" },
        offline: { type: "boolean" },
        persisted: { type: "boolean" },
        schema: { type: "string" },
        help: { type: "boolean" },
      },
    });

    jsonErrors = values.json ?? false;

    const command = positionals[0];
    const name = positionals[1];

    if (!command || values.help) {
      out(help);
      return 0;
    }

    const commands = [
      "init",
      "migration:create",
      "migration:generate",
      "migration:snapshot",
      "migration:remove",
      "migration:baseline",
      "migrate:up",
      "migrate:down",
      "migrate:status",
      "migrate:diff",
      "migrate:check",
    ];

    if (!commands.includes(command)) throw new Error(`Unknown command: ${command}`);

    if (
      positionals.length > 2 ||
      (name && !["migration:create", "migration:generate", "migration:baseline"].includes(command))
    )
      throw new Error("Unexpected positional arguments");

    const allowed: Record<string, readonly string[]> = {
      init: [],
      "migration:create": [],
      "migration:generate": ["allow-destructive"],
      "migration:snapshot": ["schema"],
      "migration:remove": ["yes"],
      "migration:baseline": ["yes"],
      "migrate:up": ["steps", "to", "dry-run", "allow-destructive"],
      "migrate:down": ["steps", "to", "yes"],
      "migrate:status": [],
      "migrate:diff": ["persisted"],
      "migrate:check": ["offline"],
    };

    for (const option of Object.keys(values))
      if (!["config", "database", "json", "help", ...allowed[command]].includes(option))
        throw new Error(`Option --${option} is not supported by ${command}`);

    if (command == "init") {
      await init(cwd);
      out(
        "Initialized duraxis.config.ts and migration directories. Configure entities and createDatabase().",
      );
      return 0;
    }

    const { config, root } = await loadConfig(cwd, values.config, values.database);

    const directory = resolve(root, config.migrations.directory);
    const snapshots = resolve(root, config.migrations.snapshots);

    const print = (value: unknown, text: string) =>
      out(values.json ? JSON.stringify(value, null, 2) : text);

    const entities = async () =>
      exportSchema(
        typeof config.entities == "function" ? await config.entities() : config.entities,
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

      out("Saved intended manual snapshot. migrate:up verifies the actual result atomically.");

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
          await withDatabase(config, (database) =>
            new MigrationRunner(database, local.artifacts).baseline(),
          );

          out(`Registered existing baseline ${initial.migration.id}`);
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
          await withDatabase(config, async (database) => {
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

            await new MigrationRunner(database, loaded.artifacts).baseline();
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

        await withDatabase(config, async (database) => {
          const status = await new MigrationRunner(database, local.artifacts).status();

          if (status.applied.some((entry) => entry.id == latest))
            throw new Error("Cannot remove an applied migration");

          const snapshotPath = join(snapshots, `${latest}.json`);

          try {
            await access(snapshotPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code != "ENOENT") throw error;

            await unlink(join(directory, latestFile!));

            return;
          }

          await removePair(join(directory, latestFile!), snapshotPath);
        });

        out(
          `Removed ${latest}. This checks only the configured database; never remove shared or released migrations.`,
        );
      });

      return 0;
    }

    const local = await loadArtifacts(config, root);

    if (command == "migrate:diff" && !values.persisted) {
      const plan = diffSchemas(
        local.artifacts.at(-1)?.snapshot.collections ?? [],
        await entities(),
      );

      print(plan, summary(plan));

      return 0;
    }

    if (command == "migrate:check" && values.offline) {
      validateArtifacts(local.artifacts);

      const plan = diffSchemas(
        local.artifacts.at(-1)?.snapshot.collections ?? [],
        await entities(),
      );

      if (plan.operations.length)
        throw new Error(`Unrepresented entity changes:\n${summary(plan)}`);

      print(
        { valid: true, mode: "offline" },
        "Local files, snapshots, and entity schema are valid. Database history was not checked.",
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

    await withDatabase(config, async (database) => {
      const runner = new MigrationRunner(database, local.artifacts);

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

        const plan = diffSchemas(
          local.artifacts.at(-1)?.snapshot.collections ?? [],
          await entities(),
        );

        if (plan.operations.length)
          throw new Error(`Unrepresented entity changes:\n${summary(plan)}`);

        print(
          { valid: true },
          "Migration files, snapshots, history, schema, and entities are valid.",
        );
      }
    });

    return 0;
  } catch (error) {
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
