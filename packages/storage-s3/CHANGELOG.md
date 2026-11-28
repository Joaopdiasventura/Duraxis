# @duraxis/storage-s3

## 0.2.1

### Patch Changes

- 6377fde: Add framework-independent configuration and owned database/ORM factories, bounded decorated-entity discovery, and shared NestJS/CLI schema resolution. Initialize projects with one source-root configuration and direct AST-guided AppModule integration. Support static inspection/mutation, centralized named connections, registry-free generators and source/compiled deployments without runtime CLI dependencies. Use shared typed configuration across runtime and CLI, standard Nest feature modules, and authenticated encrypted cursors. Document storage, migration, discovery and lifecycle contracts.
- Updated dependencies [6377fde]
  - @duraxis/storage@0.2.1

## 0.2.0

### Minor Changes

- a4bed1c: Harden bounded production pilots with hierarchical resource admission, query and transaction deadlines, tracked pending I/O, bounded materialization, weighted caches, incremental listings and journal replay, and verified single-owner garbage collection.

  Breaking pre-1.0 changes: Core requires bounded-read adapter capabilities; resource limits now reject oversized work; destructive S3 GC fails closed; encrypted expiring v3 cursors replace signed database cursors. Restart pagination and provision stable encryption keys. Tenant context checks strengthen application isolation but do not authorize raw storage access.

  Add conservative commit reconciliation and bounded atomic idempotency receipts without callback retries. Preserve manifest CAS, physical persistence formats and migration checksum identities. See docs/PRODUCTION-HARDENING.md for defaults, deployment constraints, receipt retention and remaining index/FK accounting limitations.

### Patch Changes

- Updated dependencies [a4bed1c]
  - @duraxis/storage@0.2.0

## 0.1.3

### Patch Changes

- 8c357b5: fix: padronize the published versions
- 8c357b5: fix: padronize the published versions
- Updated dependencies [8c357b5]
- Updated dependencies [8c357b5]
  - @duraxis/storage@0.1.2

## 0.1.2

### Patch Changes

- e6facc7: fix: padronize the published versions
- Updated dependencies [e6facc7]
  - @duraxis/storage@0.1.1

## 0.1.1

### Patch Changes

- bc8f6ea: Republish S3 storage driver to restore npm package availability

## 0.1.0

### Minor Changes

- 8aa0c51: Add the S3 storage driver with an internally managed AWS SDK dependency, plain configuration, conditional manifest publication, nonce-protected object generations, tombstone CAS deletion, paginated metadata listing, safe mutation retry handling and coordinated shutdown. Include storage conformance, real core/ORM/Nest regression tests and opt-in live S3 integration tests.

## 0.1.0

Initial S3 driver with conditional writes, isolated namespaces and managed AWS SDK lifecycle.
