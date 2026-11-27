# @duraxis/cli

Standalone Duraxis migration tooling. Node.js 24.15.0 or newer is required. The CLI builds on
`@duraxis/migrations` and the ORM's database-independent schema exporter.

## Quick start

```bash
pnpm add @duraxis/core @duraxis/orm @duraxis/migrations @duraxis/storage-disk
pnpm add -D @duraxis/cli
pnpm exec duraxis init
```

Edit the generated config to import your decorated entities and open your storage:

```ts
import { fileURLToPath } from "node:url";
import { defineDuraxisConfig } from "@duraxis/cli";
import { DuraxisDatabase } from "@duraxis/core";
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";
import { User } from "./src/entities/user.entity.js";

export default defineDuraxisConfig({
  entities: [User],
  migrations: {
    directory: "./duraxis/migrations",
    snapshots: "./duraxis/snapshots",
    format: "ts",
  },
  async createDatabase() {
    const storage = await AsyncDiskStorageDriver.open({
      directory: fileURLToPath(new URL("./data/duraxis", import.meta.url)),
    });
    return new DuraxisDatabase({ storage });
  },
});
```

```bash
pnpm exec duraxis migration:generate initial-schema
pnpm exec duraxis migrate:up
# Modify entity definitions to add an optional status column.
pnpm exec duraxis migration:generate add-user-status
pnpm exec duraxis migrate:diff
pnpm exec duraxis migrate:up
pnpm exec duraxis migrate:status
pnpm exec duraxis migrate:check
pnpm exec duraxis migrate:down --yes
```

Generated rollback rejects populated fields or collections it would remove. For
production, review generated files, constraints, data transformations, and backups
before applying or reverting. Never edit a shared or applied migration.

Without a local installation, use the scoped package name explicitly:

```bash
npx --package @duraxis/cli duraxis --help
```

An unscoped `npx duraxis` does not identify this package. Install the dev dependency
before using `pnpm exec duraxis`.

## Configuration and loading

Discovery walks from the working directory upward for `duraxis.config.ts`,
`duraxis.config.mts`, `duraxis.config.js`, `duraxis.config.mjs`,
`duraxis.config.cts`, or `duraxis.config.cjs`. `--config <path>` overrides discovery.
Migration and snapshot directories resolve relative to the config file. Paths
inside your database factory are your responsibility; use `import.meta.url` as
above instead of depending on the command's working directory.

`entities` accepts a class array or an async factory returning classes, allowing
project-specific entity discovery. `migrations.format` is `ts` (default) or `js`.
A `databases` object can hold named connection configs with the same three fields
(`entities`, `migrations`, `createDatabase`). Select one with `--database <name>`;
the top-level connection is the default.

The factory returns an owned Core database, not a NestJS connection. The CLI closes
that database and storage in a `finally` block. Factories must clean up resources
if they fail before returning. Do not pass an application-owned connection to
this CLI API; use the programmatic runner for that scenario.

Duraxis registers synchronous Node.js `registerHooks()` before loading a config,
entity, or migration, including programmatic `loadConfig()` calls. No manual
loader registration, experimental Node flags, or extra runtime transpiler is
required. Native type stripping alone cannot implement legacy decorators.

Supported configuration formats are `.ts`, `.mts`, `.js`, `.mjs`, `.cts`, and
`.cjs`. Discovery checks those extensions in that order. `.ts` and `.mts` source
modules execute as ESM; `.cts` uses CommonJS. JavaScript keeps Node's ordinary
package/module semantics. Executable migration artifacts support ESM `.ts`,
`.mts`, `.js`, and `.mjs`; CommonJS migration artifacts are unsupported because
their executable form does not share the ESM checksum identity contract.

Standard Node resolution runs first. Only missing local relative/file-URL imports
in module graphs loaded by Duraxis receive source-extension fallbacks:
`.js` → `.ts`, `.mjs` → `.mts`, `.cjs` → `.cts`. Existing JavaScript wins. Bare
packages, package exports, built-ins, and dependencies under `node_modules` are
left to Node. Missing dependencies and execution errors propagate without retrying
another source module. Direct TypeScript imports, nested and dynamic imports,
file URLs, spaces, and Unicode filesystem names work through the same path.

The production dependency TypeScript 5.9.3 transpiles source with ES2022 output,
`experimentalDecorators: true`, `emitDecoratorMetadata: true`, and
`useDefineForClassFields: false`. Reflective metadata consumers must load their
usual `reflect-metadata` dependency before decorated modules. Entity columns
should declare their Core `type` explicitly. `tsconfig.json` path aliases,
custom compiler plugins, `.tsx`/`.jsx`, and TypeScript package sources inside
`node_modules` are not supported. Use relative imports or published package exports.
When using a CommonJS config, load decorated entities and Duraxis connections
from ESM with native dynamic imports. Mixing independent ESM and CommonJS copies
of ORM decorators/Core constructors is unsupported; the CLI executes as ESM.
Config files and migrations are trusted executable code; keep module initialization
free of database writes and external side effects.

Programmatic use needs no executable bootstrap:

```ts
import { loadConfig, disposeTypeScriptLoader } from "@duraxis/cli";
const { config } = await loadConfig(process.cwd());
// Use config and its asynchronous entity/migration callbacks here.
disposeTypeScriptLoader();
```

A library instance registers one hook pair, reuses it for repeated calls, and
tracks only explicitly loaded local module graphs. Hooks stay active for later
dynamic imports from those graphs. Call `disposeTypeScriptLoader()` when callbacks
no longer need them; it deregisters the hooks. Later loads initialize a new pair.
Graph tracking and Node's module cache remain in effect so cached callbacks keep
working after reinitialization. This is not a watch-mode/hot-reload facility. The CommonJS entry uses Node 24 require(ESM),
so both programmatic exports share the same implementation and hook state.

Local generation, local diff, offline check, and dry-run never call the database
factory. Other commands open the configured database. Disk requires exclusive
directory ownership: stop the application or use deployment sequencing that
releases that directory before invoking the CLI.

## Commands

Every command supports `--config`, `--database`, and `--json`. Unknown options and
options inappropriate for a command are errors. Errors exit with code 1; success
exits 0. `--json` emits machine-readable success results for inspection commands
and JSON errors on stderr. No command requires an interactive prompt.

| Command                              | Behavior and options                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`                               | Creates a config, migration/snapshot directories, and an empty `baseline.json`; refuses existing files. Does not modify application source.                                                                 |
| `migration:create <name>`            | Creates a throwing manual template. Complete it and provide an expected snapshot before use.                                                                                                                |
| `migration:snapshot --schema <file>` | Saves an intended snapshot for the latest manual migration from a JSON array of Core collection definitions. Never overwrites a snapshot. Application verifies the result atomically.                       |
| `migration:generate <name>`          | Compares the latest local snapshot with exported entities and generates a self-contained migration/snapshot pair. No file on no-change. `--allow-destructive` authorizes generating removals.               |
| `migration:remove --yes`             | Removes the latest unpublished local migration and its snapshot after proving it is unapplied to this configured database. Also accepts an unfinished latest template.                                      |
| `migration:baseline <name> --yes`    | Adopts an existing matching managed catalog without reapplying creation. Creates initial artifacts, or validates and registers a single unmodified generated initial artifact.                              |
| `migrate:up`                         | Applies pending versions in ascending order, one transaction each. `--steps N` or `--to ID` (inclusive); `--allow-destructive` for schema removal.                                                          |
| `migrate:up --dry-run`               | Static local artifact preview; does not open the target database or execute callbacks. Applied/pending status is explicitly unknown. Supports `--steps` or `--to`.                                          |
| `migrate:down --yes`                 | Reverts the latest version; `--steps N` or `--to ID`. `--to` **retains** the target and reverts later versions. Requires usable `down()` implementations.                                                   |
| `migrate:status`                     | Displays applied/pending versions and validates checksums, history, snapshots, and managed catalog drift. Integrity failures exit nonzero.                                                                  |
| `migrate:diff`                       | Compares the latest local snapshot with current entities. `--persisted` instead compares the applied expected snapshot with persisted managed catalog in one transaction, while checking history integrity. |
| `migrate:check`                      | Checks local artifacts, snapshots, chain, applied checksums, managed drift, and unrepresented entity changes. `--offline` excludes database/history checks.                                                 |

`steps` and `to` are mutually exclusive. Names are sanitized to lowercase
underscore-separated names; paths and traversal components are rejected. IDs use
UTC milliseconds and advance beyond the latest local timestamp on collisions.
Exclusive filesystem creation prevents overwrites. Concurrent development branches
can produce divergent parents: rebase and regenerate unpublished branches before
release. There is no automatic history merge.

## Automatic and manual migrations

Generation uses snapshots, not an arbitrary development database. Entity metadata
is desired schema; snapshots are versioned expected schema; migration files are
executable changes; the persisted catalog and internal history are actual state.
Generated files embed definitions and never import current entities. Plans stage
the final catalog graph atomically, supporting circular foreign keys.

Type changes and newly required fields on existing collections require explicit
manual transformations, so generation rejects them. It does not infer renames.
Use `migration:create` and write `context.schema.renameField`, backfills, or other
transformations. For example:

```ts
import { defineMigration } from "@duraxis/migrations";
export default defineMigration({
  id: "20261127110000000_add_status", // Use the generated filename's ID.
  async up(context) {
    context.schema.addField("users", "status", { type: "string", required: true });
    await context.transform("users", (document) => ({ ...document, status: "active" }));
  },
  // Omit down when values cannot be safely restored.
});
```

Prepare a complete JSON array of intended managed collection definitions, then run:

```bash
pnpm exec duraxis migration:snapshot --schema expected-schema.json
pnpm exec duraxis migrate:up
```

The supplied snapshot is an intention, not proof that a manual callback is correct.
The runner verifies the actual resulting catalog hash before publication; Core
then validates existing documents, constraints, and indexes. A throwing template
or mismatched schema cannot acquire an applied history entry.

Generated removal of a field rejects existing values, even with
`--allow-destructive`; write an explicit `removeField` with `delete-values` to
acknowledge data loss. Generated collection drops have no automatic rollback.
Generated inverses for field/collection creation reject populated data. Unique
index creation validates duplicates; constraint failures roll back the version.

## Snapshots and immutable identity

Commit all migration files and snapshots, including the empty baseline. Every
migration must have one snapshot with matching ID, parent, and hash. Duplicate
TS/JS copies, missing applied files, orphan snapshots, incompatible formats,
checksum mismatches, and divergent chains are rejected. Production should contain
one executable format per migration, not both `.ts` and `.js` copies.

Artifact checksums normalize executable code with pinned TypeScript 5.9.3 (two
passes, ES2022 ESM, comments removed, legacy decorators, metadata enabled,
`useDefineForClassFields: false`). Compiled migrations must preserve this target
and ESM module form. Comments/types/formatting do not change identity; executable
edits do. External helper content is not transitively hashed: keep historical
migrations self-contained and pin unavoidable dependencies. Do not bundle,
minify, or downlevel production migrations. Snapshots and IDs accompany compiled
files unchanged. The packed consumer test verifies this deployment path.

## Existing databases and recovery

Baseline compares only entity-owned collections, permits unrelated collections,
and registers the initial generated schema in the same transaction that verifies
its persisted definitions. The same initial migration creates the schema on a new
empty database. Baseline refuses incompatible catalogs or existing history. If
registration fails after files were written, retain those files; rerun the
baseline command to validate the single generated initial artifact and register
it, provided persisted history is still empty. If history is already recorded,
inspect `migrate:status` instead.

History lives in protected transactional Core metadata, never a local JSON history
file. CAS publication coordinates runners across processes. Conflicts reload
history; identical committed versions are accepted and arbitrary callbacks are
never automatically replayed. Unknown publication outcomes are reconciled against
persisted receipts and Core recovery; inconclusive outcomes stop safely. Do not
assume an unknown outcome rolled back. Restore storage availability and inspect
status before further action. Checkpoints do not invalidate persisted receipts.

Generation/removal uses an exclusive `.duraxis-artifacts.lock` guard. Ordinary
pair-write failures remove the newly created migration. Removal renames both files
before deleting either. A process crash may leave the guard, a partial pair, or
`.removing-*` tombstones. Stop other writers, inspect/recover the intended pair
from version control or tombstones, verify the snapshot chain, then remove the
stale guard and run `migrate:check`. Filesystem pair updates are not a power-loss
atomic database transaction. Never remove guards automatically based on age.

Checking one configured database cannot prove a migration was never applied in
another environment. Never remove shared or released migrations. Checksums have
no default bypass flag. Rollback runs explicit transactional code against current
data; it never restores an old manifest or discards unrelated later writes.

## Deployment and CI

```bash
pnpm exec duraxis migrate:check --offline
pnpm exec duraxis migrate:up
pnpm exec duraxis migrate:check
# Start the application only after successful validation.
```

Ship the CLI in the migration job's image even when application dev dependencies
are omitted. For disk, release exclusive storage ownership before the job. For
S3, use the existing driver's conditional publication and namespace configuration;
ordinary application writers are not locked out by migrations. Quiesce writers
for incompatible changes. Use one deployment job, backups, and representative
pre-production data. Do not depend on process-local locks across replicas.

For NestJS, run migrations before application initialization with
`schema: { mode: "validate" }`, or `validate-managed` to reject extra indexes in
managed collections. No mandatory CLI dependency or automatic startup migration
is added to NestJS. Existing named connections, `forRootAsync`, entity auto-loading,
and transaction ownership are unchanged. Stop incompatible older replicas before
schema changes; use staged compatible releases for rolling deployments.

All transformed writes and affected-schema validation writes are staged in memory
until one atomic commit. Streaming reads do not provide bounded transaction size.
There is no online DDL, resumable batching, distributed maintenance lock, or
implicit partial migration commit. See [`@duraxis/migrations`](../migrations/README.md)
for the programmatic API, recovery guarantees, and Core compatibility details.
