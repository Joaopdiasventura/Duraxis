---
"@duraxis/core": minor
"@duraxis/storage": minor
"@duraxis/storage-disk": minor
"@duraxis/storage-memory": minor
"@duraxis/storage-s3": minor
"@duraxis/orm": minor
"@duraxis/nestjs": minor
"@duraxis/migrations": minor
"@duraxis/cli": minor
---

Harden bounded production pilots with hierarchical resource admission, query and transaction deadlines, tracked pending I/O, bounded materialization, weighted caches, incremental listings and journal replay, and verified single-owner garbage collection.

Breaking pre-1.0 changes: Core requires bounded-read adapter capabilities; resource limits now reject oversized work; destructive S3 GC fails closed; encrypted expiring v3 cursors replace signed database cursors. Restart pagination and provision stable encryption keys. Tenant context checks strengthen application isolation but do not authorize raw storage access.

Add conservative commit reconciliation and bounded atomic idempotency receipts without callback retries. Preserve manifest CAS, physical persistence formats and migration checksum identities. See docs/PRODUCTION-HARDENING.md for defaults, deployment constraints, receipt retention and remaining index/FK accounting limitations.
