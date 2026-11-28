# @duraxis/cli

## 0.5.0

### Minor Changes

- 6377fde: Add framework-independent configuration and owned database/ORM factories, bounded decorated-entity discovery, and shared NestJS/CLI schema resolution. Initialize projects with one source-root configuration and direct AST-guided AppModule integration. Support static inspection/mutation, centralized named connections, registry-free generators and source/compiled deployments without runtime CLI dependencies. Use shared typed configuration across runtime and CLI, standard Nest feature modules, and authenticated encrypted cursors. Document storage, migration, discovery and lifecycle contracts.

### Patch Changes

- Updated dependencies [6377fde]
  - @duraxis/core@0.5.0
  - @duraxis/orm@0.5.0
  - @duraxis/migrations@0.3.1

## 0.4.0

### Minor Changes

- 8ef8100: Expand the migration CLI into project setup and administration tooling with native interactive/non-interactive initialization, standalone Core/ORM and NestJS shared factories, official/custom storage integration, optional migrations, named connections, static diagnostics, configuration commands, generators and compatible dependency updates.

  Generate command help and argument validation from one registry. Add native registry/version compatibility checks, package-manager execution, guarded filesystem plans and rollback. Migration cancellation now closes owned database resources cooperatively while preserving in-flight publication semantics and explicitly reporting cleanup failures. No new third-party dependencies or migration checksum compiler changes.

  Pre-1.0 behavior change: `init` now creates functional project settings and shared application factories, installs dependencies by default, and requires `--yes` in non-interactive mode. Use `--no-install` for offline scaffolding and explicitly select migrations. Existing executable configurations remain supported and are never automatically rewritten. See the CLI README for trust boundaries and supported combinations.

## 0.3.0

### Minor Changes

- a4bed1c: Harden bounded production pilots with hierarchical resource admission, query and transaction deadlines, tracked pending I/O, bounded materialization, weighted caches, incremental listings and journal replay, and verified single-owner garbage collection.

  Breaking pre-1.0 changes: Core requires bounded-read adapter capabilities; resource limits now reject oversized work; destructive S3 GC fails closed; encrypted expiring v3 cursors replace signed database cursors. Restart pagination and provision stable encryption keys. Tenant context checks strengthen application isolation but do not authorize raw storage access.

  Add conservative commit reconciliation and bounded atomic idempotency receipts without callback retries. Preserve manifest CAS, physical persistence formats and migration checksum identities. See docs/PRODUCTION-HARDENING.md for defaults, deployment constraints, receipt retention and remaining index/FK accounting limitations.

### Patch Changes

- Updated dependencies [a4bed1c]
  - @duraxis/core@0.4.0
  - @duraxis/orm@0.4.0
  - @duraxis/migrations@0.3.0

## 0.2.0

### Minor Changes

- eb56e40: Add transactional collection alteration/removal, final-schema validation, schema-aware index rebuilding, and protected subsystem metadata. Add standalone ORM schema export and opt-in strict managed validation. Introduce the migration runtime and CLI with snapshots, schema comparison, atomic history, conservative rollback, baseline adoption, and recovery-aware publication. Document deployment sequencing and transaction memory limits.

### Patch Changes

- Updated dependencies [eb56e40]
  - @duraxis/core@0.3.0
  - @duraxis/orm@0.3.0
  - @duraxis/migrations@0.2.0

## 0.1.0

Initial migration tooling.
