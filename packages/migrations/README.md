# @duraxis/migrations

Transactional schema evolution for Duraxis. Requires Node.js 24.15.0 or later.
The engine depends only on `@duraxis/core`; it does not load files, ORM entities,
NestJS, or concrete storage drivers. Use `@duraxis/cli` for project tooling.

## Installation and programmatic execution

```bash
pnpm add @duraxis/core @duraxis/migrations
```

```ts
import { MigrationRunner, defineMigration, createSnapshot, checksum } from "@duraxis/migrations";

const definition = {
  name: "users",
  fields: { name: { type: "string" as const, required: true } },
  allowAdditionalFields: false,
  indexes: [],
};
const migration = defineMigration({
  id: "20261127110000000_create_users",
  up(context) {
    context.schema.createCollection(definition);
  },
  // This manual rollback deliberately removes records. Review backups first.
  down(context) {
    context.schema.dropCollection("users");
  },
});
const runner = new MigrationRunner(database, [
  {
    migration,
    // Your loader must hash the immutable executable artifact, not its ID alone.
    checksum: checksum(immutableArtifactText),
    snapshot: createSnapshot(migration.id, null, [definition]),
  },
]);
await runner.up();
console.log(await runner.status());
console.log(await runner.drift());
await runner.down({ allowDestructive: true });
```

The caller owns `database` and its storage. The runner never closes them. All
artifacts and their expected snapshots must be supplied in ascending ID order,
including every applied version. IDs have 17 UTC timestamp digits (milliseconds),
an underscore, and a lowercase underscore-separated name. Duplicate IDs,
missing parents, invalid snapshots, and modified applied artifacts are errors.

`up({ steps, to, allowDestructive })` applies one transaction per version.
`to` includes the target for `up`. `down()` reverts one version by default;
`down({ to })` **retains** that version and reverts later versions. `steps` and
`to` are mutually exclusive. Rollback requires `allowDestructive: true`, and all
selected versions must have `down` implementations before rollback begins.

## Context and schema editing

Migration callbacks receive schema inspection, generic collection replacement,
field/index/foreign-key editing, and document methods. They receive no transaction
commit, abort, close, raw-key access, or metadata access.

```ts
async up(context) {
  context.schema.addField("users", "status", {
    type: "string", required: true, nullable: false,
  });
  await context.transform("users", document => ({
    ...document, status: "active",
  }));
  await context.schema.renameField("users", "name", "fullName");
}
```

`get(collection, id)`, `scan(collection)`, `put(collection, id, document)`, and
`delete(collection, id)` operate on the same transaction. `transform` awaits
one callback per document. Scans include staged writes and capture their view
when iteration starts. Transformations must satisfy the schema currently staged
for each `put`; stage compatible field definitions before rewriting values.
Commit validates the final schema, including records written before alteration.

`schema.inspect()` returns detached definitions. `definition(name)` returns one.
`createCollection`, `createCollections`, `alterCollection`, `dropCollection`,
`addField`, `alterField`, `addIndex`, `removeIndex`, `addForeignKey`, and
`removeForeignKey` stage changes. Cross-collection references are checked against
the final catalog at commit, allowing cyclic definitions to be staged atomically.
Foreign key removal retains its supporting index unless explicitly removed.

`renameField` is asynchronous, preserves values, updates indexes and foreign keys,
and rejects destination collisions. `removeField` is asynchronous and requires
`{ strategy: "reject-if-populated" }` or `{ strategy: "delete-values" }`.
Dependent indexes and foreign keys must be removed first. `delete-values` is an
explicit irreversible data transformation. Dropping a collection removes its
logical records and index roots; no physical storage objects are directly deleted.
Old snapshots retain their roots, and ordinary garbage collection reclaims
unreachable objects under existing maintenance rules.

## Transactions, history, concurrency, and recovery

The runner reads history, verifies its expected predecessor, checks managed schema
drift, runs the callback, checks the expected result, and writes history within
one Core transaction. Final document, foreign key, and unique-index validation
runs before conditional manifest publication. An exception discards staged data,
catalog changes, and history together. Earlier successful migrations remain
committed when a later migration fails.

History is versioned JSON in the protected primary-tree logical key
`__duraxis/metadata/migrations`, scoped by the database's storage namespace. Each
entry includes ID, artifact checksum, applied time, sequence, resulting schema
hash, and an operation receipt. History follows normal object integrity checks,
snapshot publication, recovery, and GC. Ordinary transaction `put`/`delete`
cannot address reserved metadata. Core's explicit subsystem metadata API is a
trusted extension API, not an authorization boundary against hostile application
code with direct storage access.

Independent runners race on the existing storage manifest CAS. A conflicting
runner reloads and verifies history. It accepts an identical committed version
and otherwise stops; it never automatically replays a migration callback. A lost
commit acknowledgement is reconciled using persisted history receipts, then Core
commit-history recovery when necessary. Receipts remain usable after commit
history checkpointing. If success cannot be established, the original unknown
outcome is surfaced. Inspect persisted history and storage health before another
attempt. Migration callbacks must avoid nontransactional external side effects.

This mechanism also conflicts with ordinary concurrent application commits; it
does not lock out application writes or provide online schema-change coordination.
Quiesce incompatible writers during deployment. Disk retains exclusive directory
ownership. S3 uses the driver's existing conditional publication contract.

## Snapshots, comparison, and artifact identity

`canonicalSchema`, `canonicalJSON`, `schemaHash`, `createSnapshot`, and
`validateSnapshot` provide format-version-1 JSON snapshots with migration ID,
parent ID, canonical managed collections, and a SHA-256 schema hash. Collection,
field, index, and foreign-key names are deterministic; composite index component
order is preserved. Snapshots contain no timestamps or machine paths.

`diffSchemas(before, after)` returns a typed `SchemaPlan` with before/after
schemas and collection, field, index, foreign-key, and additional-field-policy
operations. Risks are `safe`, `requires-validation`,
`requires-data-transformation`, or `destructive`. Renames are never inferred.
`applySchemaPlan(context, plan)` verifies the predecessor and stages the final
catalog graph. This defers relationship validation until the graph is complete
instead of imposing an impossible topological order on cyclic relationships.
Required-field backfills and field-type conversions require manual migrations;
automatic plans refuse to invent values. Field removal rejects populated values.

The engine accepts SHA-256 artifact digests from its loader. The CLI defines an
identity using pinned TypeScript 5.9.3: two transpilation/printing passes targeting
ES2022 ESM, with comments removed and TypeScript decorators enabled. It verifies the
same digest for TypeScript and JavaScript emitted using those options. Ship ESM
migration files, preserve ESM imports, and do not bundle/minify or downlevel them.
Formatting, comments, and type-only edits are excluded from executable identity.
Changing executable code changes the checksum. Imported helper contents are not
transitively hashed: historical migrations must be self-contained, and any
external dependencies must be immutable and pinned. Upgrading the identity
compiler requires an explicit compatibility review, not rewriting history.

## Managed scope, baseline, and compatibility

Snapshots contain the complete schema managed by this migration chain. Drift is
checked over the union of names in all supplied snapshots; unrelated collections
are permitted and migration callbacks may not change them. `baseline()` requires
exactly one initial artifact and a matching persisted managed schema, then records
it without executing `up`. That artifact must also create the same schema on an
empty database. The CLI verifies its generated initial-schema artifact for this
workflow. Never use baseline to conceal drift.

Existing databases and manifest format 1 remain readable with the updated Core;
no metadata is created until migrations are adopted. Databases containing the
new reserved metadata entries require the updated Core for full-tree operations.
Do not downgrade Core on a migration-enabled database. Existing applications
without migration configuration retain their normal initialization behavior.

## Operational limits

Each migration is one transaction. Streaming reads do **not** make write staging
bounded: transformed writes, schema-validation writes, cascades, and deletes are
held in memory. Queries against a changed index use a transaction-local scan and
sort. Size migrations for available memory and test on representative data.
There is no implicit partial commit, resumable batching, online DDL, distributed
maintenance lock, or backup restoration. Retain backups before destructive
production operations. A structural inverse cannot reconstruct discarded values.

Use `duraxis migrate:up` before starting NestJS with `schema: { mode: "validate" }`
(or opt-in `validate-managed` for strict index validation on owned collections).
Named connections, async configuration, and auto-loaded entities remain under
NestJS's existing ownership model. A runner can reuse an already-owned Core
connection programmatically, but application startup does not run migrations.
For incompatible changes, stop older replicas, migrate once, then start compatible
replicas. Use staged coordinated application/schema releases when downtime
is unsuitable.

## Production resource and lifecycle limits

See the [production hardening guide](../../docs/PRODUCTION-HARDENING.md) for bounded defaults, cancellation, verified maintenance, tenant trust boundaries, encrypted cursors, upgrade instructions and remaining pilot limitations. Core rejects storage adapters without bounded-read capability; destructive shared-storage garbage collection is unsupported.

## CLI project setup

Run `npx --package @duraxis/cli@latest duraxis init` to generate one source-root configuration. NestJS AppModule integration is automatic; standalone applications call the public runtime factories. See the [shared configuration API and examples](../../docs/CLI-SETUP.md) and [setup guide](../../docs/CLI-SETUP.md).

Enable shared migrations with `migrations: true`, or customize `directory` and `snapshots`. Core normalizes these settings for CLI/runtime; migrations imply validation and never enable schema creation. CLI resolves entity files without starting Nest. New CLI artifacts use `.mts`/`.mjs`; old artifacts, snapshots, history and locking remain unchanged.
