# @duraxis/cli

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
