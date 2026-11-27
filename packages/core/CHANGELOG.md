# @duraxis/core changelog

## 0.4.0

### Minor Changes

- a4bed1c: Harden bounded production pilots with hierarchical resource admission, query and transaction deadlines, tracked pending I/O, bounded materialization, weighted caches, incremental listings and journal replay, and verified single-owner garbage collection.

  Breaking pre-1.0 changes: Core requires bounded-read adapter capabilities; resource limits now reject oversized work; destructive S3 GC fails closed; encrypted expiring v3 cursors replace signed database cursors. Restart pagination and provision stable encryption keys. Tenant context checks strengthen application isolation but do not authorize raw storage access.

  Add conservative commit reconciliation and bounded atomic idempotency receipts without callback retries. Preserve manifest CAS, physical persistence formats and migration checksum identities. See docs/PRODUCTION-HARDENING.md for defaults, deployment constraints, receipt retention and remaining index/FK accounting limitations.

### Patch Changes

- Updated dependencies [a4bed1c]
  - @duraxis/storage@0.2.0

## 0.3.0

### Minor Changes

- eb56e40: Add transactional collection alteration/removal, final-schema validation, schema-aware index rebuilding, and protected subsystem metadata. Add standalone ORM schema export and opt-in strict managed validation. Introduce the migration runtime and CLI with snapshots, schema comparison, atomic history, conservative rollback, baseline adoption, and recovery-aware publication. Document deployment sequencing and transaction memory limits.

## 0.2.2

### Patch Changes

- 8c357b5: fix: padronize the published versions
- 8c357b5: fix: padronize the published versions
- Updated dependencies [8c357b5]
- Updated dependencies [8c357b5]
  - @duraxis/storage@0.1.2

## 0.2.1

### Patch Changes

- e6facc7: fix: padronize the published versions
- Updated dependencies [e6facc7]
  - @duraxis/storage@0.1.1

## 0.2.0

### Minor Changes

- 6123078: Add transactional foreign-key integrity, referential actions, ORM relationship decorators, batched relation loading, and ManyToMany association operations.

This file is maintained by Changesets. Future releases will add versioned
entries automatically.
