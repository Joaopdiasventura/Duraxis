# @duraxis/storage-s3

## 0.1.0

### Minor Changes

- 8aa0c51: Add the S3 storage driver with an internally managed AWS SDK dependency, plain configuration, conditional manifest publication, nonce-protected object generations, tombstone CAS deletion, paginated metadata listing, safe mutation retry handling and coordinated shutdown. Include storage conformance, real core/ORM/Nest regression tests and opt-in live S3 integration tests.

## 0.1.0

Initial S3 driver with conditional writes, isolated namespaces and managed AWS SDK lifecycle.
