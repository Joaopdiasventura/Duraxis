# @duraxis/nestjs changelog

## 0.4.0

### Minor Changes

- a4bed1c: Harden bounded production pilots with hierarchical resource admission, query and transaction deadlines, tracked pending I/O, bounded materialization, weighted caches, incremental listings and journal replay, and verified single-owner garbage collection.

  Breaking pre-1.0 changes: Core requires bounded-read adapter capabilities; resource limits now reject oversized work; destructive S3 GC fails closed; encrypted expiring v3 cursors replace signed database cursors. Restart pagination and provision stable encryption keys. Tenant context checks strengthen application isolation but do not authorize raw storage access.

  Add conservative commit reconciliation and bounded atomic idempotency receipts without callback retries. Preserve manifest CAS, physical persistence formats and migration checksum identities. See docs/PRODUCTION-HARDENING.md for defaults, deployment constraints, receipt retention and remaining index/FK accounting limitations.

### Patch Changes

- Updated dependencies [a4bed1c]
  - @duraxis/core@0.4.0
  - @duraxis/storage@0.2.0
  - @duraxis/orm@0.4.0

## 0.3.0

### Minor Changes

- eb56e40: Add transactional collection alteration/removal, final-schema validation, schema-aware index rebuilding, and protected subsystem metadata. Add standalone ORM schema export and opt-in strict managed validation. Introduce the migration runtime and CLI with snapshots, schema comparison, atomic history, conservative rollback, baseline adoption, and recovery-aware publication. Document deployment sequencing and transaction memory limits.

### Patch Changes

- Updated dependencies [eb56e40]
  - @duraxis/core@0.3.0
  - @duraxis/orm@0.3.0

## 0.2.4

### Patch Changes

- 8c357b5: fix: padronize the published versions
- 8c357b5: adjust the release version
- 8c357b5: fix: padronize the published versions
- Updated dependencies [8c357b5]
- Updated dependencies [8c357b5]
  - @duraxis/core@0.2.2
  - @duraxis/orm@0.2.2
  - @duraxis/storage@0.1.2

## 0.2.3

### Patch Changes

- e6facc7: fix: padronize the published versions
- e6facc7: adjust the release version
- Updated dependencies [e6facc7]
  - @duraxis/core@0.2.1
  - @duraxis/orm@0.2.1
  - @duraxis/storage@0.1.1

## 0.2.2

### Patch Changes

- c8d2a63: adjust the release version

## 0.2.1

### Patch Changes

- 5b88773: adjust the release version

## 0.2.0

### Minor Changes

- 6123078: Add transactional foreign-key integrity, referential actions, ORM relationship decorators, batched relation loading, and ManyToMany association operations.

### Patch Changes

- Updated dependencies [6123078]
  - @duraxis/core@0.2.0
  - @duraxis/orm@0.2.0

## 0.1.2

### Patch Changes

- a447bb5: Activate declarative transactions automatically for standard Nest class providers using application-scoped property injection. Preserve provider identity and support singleton, transient and request scopes, lifecycle calls after injection, inherited metadata and self-invocation. Deprecate the transactional registration helpers while retaining their named-connection defaults for migration. Self-invocation now honors inner transaction boundaries; constructor-time transactions remain unsupported and are documented explicitly.

## 0.1.1

### Patch Changes

- 0b272bd: Improve disk storage ownership recovery and NestJS lifecycle management to safely handle abandoned locks and application restarts
- @duraxis/orm@0.1.0

This file is maintained by Changesets. Future releases will add versioned
entries automatically.
