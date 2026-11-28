# @duraxis/storage changelog

## 0.2.1

### Patch Changes

- 6377fde: Add framework-independent configuration and owned database/ORM factories, bounded decorated-entity discovery, and shared NestJS/CLI schema resolution. Initialize projects with one source-root configuration and direct AST-guided AppModule integration. Support static inspection/mutation, centralized named connections, registry-free generators and source/compiled deployments without runtime CLI dependencies. Use shared typed configuration across runtime and CLI, standard Nest feature modules, and authenticated encrypted cursors. Document storage, migration, discovery and lifecycle contracts.

## 0.2.0

### Minor Changes

- a4bed1c: Harden bounded production pilots with hierarchical resource admission, query and transaction deadlines, tracked pending I/O, bounded materialization, weighted caches, incremental listings and journal replay, and verified single-owner garbage collection.

  Breaking pre-1.0 changes: Core requires bounded-read adapter capabilities; resource limits now reject oversized work; destructive S3 GC fails closed; encrypted expiring v3 cursors replace signed database cursors. Restart pagination and provision stable encryption keys. Tenant context checks strengthen application isolation but do not authorize raw storage access.

  Add conservative commit reconciliation and bounded atomic idempotency receipts without callback retries. Preserve manifest CAS, physical persistence formats and migration checksum identities. See docs/PRODUCTION-HARDENING.md for defaults, deployment constraints, receipt retention and remaining index/FK accounting limitations.

## 0.1.2

### Patch Changes

- 8c357b5: fix: padronize the published versions
- 8c357b5: fix: padronize the published versions

## 0.1.1

### Patch Changes

- e6facc7: fix: padronize the published versions

This file is maintained by Changesets. Future releases will add versioned
entries automatically.
