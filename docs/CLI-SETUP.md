# CLI setup and administration

Node.js **24.15.0 or newer** runs both the application and CLI. Bun is supported as a package manager, not as the application runtime.

## Complete initialization workflows

```bash
# First use: explicitly request the official scoped package.
npx --package @duraxis/cli@latest duraxis init

# Existing local CLI, interactive wizard.
pnpm exec duraxis init
# Or, when available on PATH:
duraxis init

# Persistent standalone ORM with reviewed migrations.
duraxis init --framework standalone --driver disk --orm --migrations --example --package-manager pnpm --yes
pnpm exec duraxis migration:generate initial
pnpm exec duraxis migrate:up
pnpm exec duraxis migrate:check

# Core only; no ORM entities or migration paths required.
duraxis init --framework standalone --driver memory --no-orm --no-migrations --package-manager npm --yes

# NestJS owns one independently created storage instance.
duraxis init --framework nestjs --driver disk --orm --migrations --yes
# Duraxis is registered directly in AppModule; enableShutdownHooks() in bootstrap.
# Apply migrations before starting the application.

# S3: credentials come from the normal AWS provider chain.
duraxis init --driver s3 --bucket application-data --region us-east-1 --orm --migrations --yes

# A deliberately separate new package inside an existing repository.
duraxis init --directory apps/new-service --driver disk --no-orm --no-migrations --yes

# Offline planning/configuration: no package downloads or installation.
duraxis init --driver memory --no-install --dry-run --json
duraxis init --driver memory --no-install --yes
```

`--yes` accepts documented defaults; it does not authorize overwrites or bypass validation. Redirected input requires `--yes` or `--dry-run`. Interactive prompts use accessible numbered choices on stderr, support EOF/Ctrl+C and do not use ANSI escape sequences. JSON mode never prompts and keeps results on stdout and structured errors on stderr. Exit codes remain 0 (success) and 1 (failure/cancellation/failed diagnosis).

The nearest package.json determines the application root, not the workspace root. Explicit `--directory` selects that exact package directory and can create a new manifest. A nested directory without its own application package cannot implicitly initialize an ancestor workspace root: select `--directory` explicitly. Inspect `--dry-run` before initializing a nested directory if an ancestor already has a manifest. Multiple lockfile/packageManager signals require an explicit `--package-manager`. Conventional Nest module/entry-point filenames are inspected without executing source (at most 2,000 entries and four directory levels). Installation runs in the selected application package; workspace package-manager resolution remains the package manager's responsibility.

## Generated files and shared ownership

Initialization generates one `src/duraxis.config.ts` or `.js` file. Existing Nest AppModules are updated directly with AST-guided edits. No JSON settings, manual entity registry, database factory or wrapper module is generated. Source roots come from Nest/TypeScript project configuration; select ambiguous applications with `--source-dir` and `--directory`.

The [configuration and runtime API guide](CLI-SETUP.md) provides exact generated layouts, memory/disk/S3 examples, Core and ORM factories, discovery rules, named connections, production deployment.

Use `createDatabase(config)` from Core or `createORM(config)` from ORM in standalone applications; always close successfully returned resources in finally. Nest owns its factory-created connections and retains existing shutdown/transaction behavior. Migrations imply schema validation and must run before application startup. Without migrations, init explicitly configures the selected schema mode; public runtime factories default to validation.

## Initialization options

`duraxis help init` is generated from the same metadata used for argument validation and lists every supported flag.

| Options                                                                          | Behavior                                                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `--framework standalone\|nestjs\|auto`                                           | Auto-detect installed NestJS; otherwise standalone. NestJS requires ORM.                            |
| `--driver memory\|disk\|s3\|custom`                                              | Default Disk.                                                                                       |
| `--orm / --no-orm`                                                               | Optional for standalone; default enabled for NestJS.                                                |
| `--migrations / --no-migrations`                                                 | Default enabled for persistent storage, disabled for Memory.                                        |
| `--package-manager npm\|pnpm\|yarn\|bun\|auto`                                   | Manifest and lockfile detection; conflicts rejected without explicit selection.                     |
| `--language typescript\|javascript\|auto`                                        | Existing TypeScript detection; a new project defaults to TypeScript.                                |
| `--module-format esm\|cjs\|auto`                                                 | Existing manifest type; a new project defaults to ESM.                                              |
| `--namespace`, `--directory`, `--source-dir`, `--storage-directory`              | Namespace and project-relative locations; namespace is not authorization.                           |
| `--bucket`, `--prefix`, `--region`, `--endpoint`, `--force-path-style`           | S3 configuration; no infrastructure provisioning.                                                   |
| `--schema-mode create\|validate\|validate-managed`                               | ORM initialization; migrations reject create mode.                                                  |
| `--example / --no-example`                                                       | Optional ORM example; disabled by default.                                                          |
| `--install / --no-install`                                                       | Installation enabled by default; offline scaffolding reports missing dependencies explicitly.       |
| `--resources-file path.json`                                                     | Positive integer Core resource overrides, validated against actual exported limits.                 |
| `--cursor-key-env NAME`                                                          | Environment reference to a persistent secret 32-byte hex encryption key. No secret argument values. |
| `--max-stored-bytes`, `--max-entries`                                            | Memory storage limits.                                                                              |
| `--max-object-bytes`                                                             | Official storage single-object limit.                                                               |
| `--max-metadata-bytes`, `--max-journal-bytes`, `--max-queued-operations`         | Disk storage limits.                                                                                |
| `--max-pending-operations`, `--max-attempts`                                     | S3 admission and supported read attempts (1–10).                                                    |
| `--ownership-recovery manual`, `--application-id`                                | Conservative Disk ownership; automatic recovery is never generated.                                 |
| `--custom-module`, `--custom-export`, `--custom-constructor`, `--custom-options` | Trusted existing local/package driver implementation, optional constructor/config module.           |
| `--registry`, `--prerelease`                                                     | Explicit registry override and opt-in prerelease selection.                                         |
| `--dry-run`, `--yes`, `--json`                                                   | Plan without writes; accept defaults; machine-readable output.                                      |

Driver-inappropriate resource flags, contradictory switches, missing S3 bucket, invalid names/paths, and unsupported combinations fail before writes/install. New projects are configured without changing existing Node engine declarations; declarations excluding the running supported Node version must be corrected first.

## Dependencies and package managers

The CLI uses native fetch and process APIs; no new third-party dependencies were added. Metadata is time/size/graph bounded. The resolver prefers compatible stable `latest` distribution tags and otherwise the highest compatible stable published versions, validates Node engines, Duraxis dependency constraints and peers, and retains compatible existing specifications. Existing peer declarations must be provably compatible rather than guessed compatible. Unsupported ranges fail with instructions. Supported syntax: exact versions, caret, tilde, numeric partials, x/* wildcards, comparator conjunctions and `||`. Hyphen, URL, alias and workspace dependency ranges are deliberately not interpreted as semver. This focused validator is not a complete npm solver; incompatible or non-converging graphs fail closed, and final resolution/lockfile generation belongs to the selected package manager.

Metadata registry selection uses `--registry`, `npm_config_registry`, then project/workspace `.npmrc` registry locations. The native metadata client does not forward npmrc authentication tokens or accept embedded URL credentials; authenticated private registries requiring such tokens need an external metadata proxy or manual dependency installation. Registry redirects are rejected. Installer stdout/stderr is suppressed to keep output credential-safe and JSON clean; nonzero exit codes report recovery guidance. Cancellation signals the installer and escalates termination after five seconds; child lifecycle-script side effects still need inspection. The `--registry` flag selects metadata lookup; configure the package manager’s registry as well for installation. Package-manager installation uses its normal credential/configuration mechanisms and may run ordinary lifecycle scripts. No force or peer-dependency bypass flags are used. Windows Node package managers require an available JavaScript entry point; the CLI invokes it with node rather than interpolating a shell command. Bun uses its native executable. Windows/macOS execution has not been exercised on this Linux host. Managed source paths use portable relative paths with forward slashes; project/storage directory resolution uses native Node paths. Symlinks in managed write paths are rejected.

Only selected Duraxis/runtime peers are direct production dependencies. CLI and new TypeScript tooling are development dependencies. The internally pinned TypeScript **5.9.3** used for migration execution/checksum normalization is unchanged. S3 templates do not import the AWS SDK directly. Existing unrelated dependency declarations are preserved.

## Configuration, diagnostics and storage

```bash
duraxis config:show --json
duraxis config:validate
duraxis config:set namespace reports --dry-run
duraxis connection:add reporting --driver disk --storage-directory ./data/reporting --orm --no-migrations --no-install --yes
duraxis connection:list --json
duraxis storage:list
duraxis storage:check
duraxis storage:check --live
duraxis doctor --json
duraxis upgrade --check
duraxis upgrade --apply
```

New configurations use `defineDuraxisConfig` from `@duraxis/core`, shared by CLI, standalone and NestJS. Named connections use `--database`; they share one configuration file, require isolated entity directories/lists and use connection-specific environment overrides. Disk connections require distinct directories. `.env` is not implicitly loaded; use Node `--env-file` or application provisioning.

Static commands inspect inline configuration syntax without evaluating application code. `--evaluate` explicitly evaluates trusted config:show/config:validate code without opening storage. Static validation does not prove arbitrary factories/custom storage correctness. Dynamic configurations remain unresolved or fail with manual instructions. Doctor reports PASS/WARN/FAIL/SKIP and inspects installed metadata without importing packages.

`config:set` supports namespace, storageDirectory, bucket, prefix, region, endpoint and schemaMode. For new configurations it safely edits literal settings or generated environment fallbacks using AST positions. `connection:add` appends an isolated entry in the centralized new configuration; arbitrary dynamic expressions require manual editing. Secrets must use environment references.

Live storage checks are explicit. They open a fresh Core database, read catalog metadata, and close it in finally. No test objects or business data are written. Disk must already have a journal, temporarily acquires exclusive ownership, and may perform the driver's normal initialization/recovery housekeeping. Stop the owning application first; no stale locks are automatically recovered. This is not an OS-enforced read-only open. S3 checks require working credentials/permissions and the provider's actual conditional consistency semantics. No S3 infrastructure is created or modified. Destructive distributed GC remains unsupported; see [production hardening](PRODUCTION-HARDENING.md).

Memory is process-local and volatile. Explicit migration testing on Memory does not create persistent history across CLI invocations. Use Disk/S3 for independent administrative processes. Custom storage requires an existing trusted implementation and bounded-read capability; the CLI generates an integration, never a fake persistence driver or certification of concurrency correctness. A package reference is resolved as a production dependency; local implementation/configuration modules must already exist. Custom setup reports `configured-custom-driver-not-evaluated`; capability checks run only when its factory is explicitly invoked.

Upgrade rejects unsupported/workspace-owned specifications and blocks automatic downgrades. Upgrade check reads metadata; only `--apply` authorizes package-manager updates. Pre-1.0 minor releases may break compatibility. No configuration or database formats are automatically migrated, and checksum history is never rewritten.

## Generators and filesystem safety

```bash
duraxis generate:entity User --dry-run
duraxis generate:entity User
duraxis generate:module Reports --dry-run
```

Entities require ORM; modules require NestJS. Names are PascalCase identifiers and files are created exclusively. New entity generation writes only the entity file; conventional discovery finds it without a registry update. Feature modules use `forFeature`, importing a matching generated entity when present.

Plans list file paths, create/modify/remove actions, byte sizes, directories, dependency commands and warnings. Existing file bodies are deliberately omitted to avoid leaking secrets from package scripts or project metadata. Dry-run does not create files/directories, run installers, open storage or provision infrastructure. It may read registry metadata unless `--no-install` is selected. Filesystem changes use a per-project exclusive guard, path/symlink checks, expected-content checks, exclusive creation and temporary-file replacement. Repeated initialization reports existing connections and available commands. Failure rolls back CLI-controlled files only if their written content is unchanged; concurrent user edits are preserved and incomplete rollback is reported. External installers/lifecycle scripts and lockfiles are not transactional. Inspect their partial changes before retrying. The guard coordinates CLI instances, not hostile processes modifying the filesystem between native filesystem calls.

`.env` is never overwritten; missing `.env.example` declarations are merged without replacing existing values; gitignore entries are appended without duplication and migrations are never ignored. Credentials/encryption key values must not be placed in arguments/settings. Executable configs and custom modules remain trusted application code. See `duraxis help <command>` for generated command documentation and the CLI README for unchanged migration safety/checksum guarantees.
