# @duraxis/storage-s3

Amazon S3 storage for Duraxis, with an internally managed AWS SDK v3 client. Applications only
import Duraxis APIs. Requires Node.js 22.12+ and a pre-existing general-purpose S3 bucket.
No network requests occur in the constructor.

## Installation and standalone usage

```bash
pnpm add @duraxis/core @duraxis/storage-s3
```

```ts
import { DuraxisDatabase } from "@duraxis/core";
import { S3StorageDriver } from "@duraxis/storage-s3";

const storage = new S3StorageDriver({
  bucket: "my-duraxis-bucket",
  prefix: "databases/orders",
  client: { region: "sa-east-1" },
});
const database = new DuraxisDatabase({ storage });
try {
  await database.transaction((tx) => {
    tx.put("greeting", new TextEncoder().encode("hello"));
  });
  await database.transaction(async (tx) => {
    console.log(new TextDecoder().decode((await tx.get("greeting"))!));
  });
} finally {
  await database.close({ closeStorage: true });
}
```

The AWS SDK is a regular runtime dependency of this package. Do not install or construct an AWS
SDK client separately. For ORM usage, also install `@duraxis/orm` and pass the same database to
`DuraxisORM` as with the other drivers.

## NestJS

Install `@duraxis/nestjs`, `@duraxis/orm`, `@duraxis/core` and `@duraxis/storage-s3` alongside the
normal NestJS dependencies:

```ts
import { Module } from "@nestjs/common";
import { DuraxisModule } from "@duraxis/nestjs";
import { S3StorageDriver } from "@duraxis/storage-s3";

@Module({
  imports: [
    DuraxisModule.forRootAsync({
      useFactory: async () => ({
        driver: new S3StorageDriver({
          client: { region: "sa-east-1" },
          bucket: "my-duraxis-bucket",
          prefix: "databases/orders",
        }),
        closeStorage: true,
        autoLoadEntities: true,
        schema: { mode: "validate" },
      }),
    }),
  ],
})
export class AppModule {}
```

Provision the schema before using `validate`; an explicitly chosen `create` mode can initialize
a new namespace. Feature modules continue using `DuraxisModule.forFeature([Entity])`, ordinary
`providers: [Service]` and `@Transactional()`.

Nest treats a supplied driver instance as externally owned. Set **`closeStorage: true`** to close
it on shutdown. Alternatively, return `driver: () => new S3StorageDriver(options)`; Nest owns
factory-created drivers by default. No Nest ownership or transaction lifecycle rules are changed.

## Configuration and credentials

```ts
import type { S3StorageDriverOptions } from "@duraxis/storage-s3";

const options: S3StorageDriverOptions = {
  bucket: "my-duraxis-bucket",
  prefix: "database-a", // normalized to "database-a/"
  client: {
    region: "sa-east-1",
    endpoint: "http://127.0.0.1:9000", // optional compatible endpoint
    forcePathStyle: true, // commonly required by local compatible services
    maxAttempts: 3, // read attempts only, from 1 to 10
    credentials: {
      // optional; normally omit this entire property
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      sessionToken: process.env.S3_SESSION_TOKEN,
    },
  },
};
```

Omitting credentials uses the internal SDK's default credential provider chain, including
environment credentials, shared configuration, workload identity, ECS and EC2 IAM roles.
Omitting `region` uses the SDK's region resolution. Prefer IAM roles with short-lived credentials
in production. Explicit credential objects are static snapshots; rotate them by replacing the
driver, or use the default role/provider chain for automatic refresh. Never hard-code secrets.

Endpoints must be HTTP(S) URLs without embedded credentials, query strings or fragments. Bucket
names must satisfy general-purpose bucket naming constraints. Directory buckets, access-point
ARNs and S3 on Outposts are outside this driver's supported configuration.

The prefix is a database namespace, not a filesystem path. A nonempty prefix gets a trailing slash;
it is prepended consistently and removed from logical `list()` results. Keys remain case-sensitive,
are not path-normalized, and must be well-formed UTF-8 with a nonempty nonblank logical value.
The complete physical key is limited to S3's 1,024-byte limit. An empty prefix dedicates the
bucket to this driver's format. Do not share the same prefix with other object formats or writers.

## Storage format, versions and conditions

The local `StorageDriver` contract has conditional create, replacement and deletion, opaque
generation versions, isolated byte arrays, deterministic listing and shared `StorageError` codes.
The S3 implementation preserves these contracts without changing core, ORM, Nest or other drivers.

Each physical object contains a versioned 72-byte envelope: an 8-byte format marker, a fresh
32-byte random nonce, a SHA-256 payload digest, and then the unchanged logical payload. S3 user
metadata identifies format `1` and state `live` or `deleted`. A tombstone has an empty logical
payload. The driver verifies and removes the envelope on GET. Empty logical objects are supported.

The **opaque quoted ETag** returned by S3 is the storage version. It is reused as an `If-Match`
value; it is not interpreted as a cryptographic checksum. S3 `VersionId` is never used as a
conditional token. GET, successful PUT and LIST agree on the current live object's ETag.
Versions must be reused exactly as issued; wildcard and multi-value conditional expressions
are not accepted. Missing or malformed service ETags fail explicitly.

The nonce changes the physical body for every write, including identical-value replacements,
deletions and recreations. This prevents ordinary same-content/ABA version reuse under S3's
ETag semantics, subject to the probabilistic uniqueness of random nonces and service tokens.
Payload integrity uses SHA-256 independently of ETag. This is not protection against an actor
authorized to rewrite both data and metadata. Copying/restoring old physical objects, external
unconditional writes or an endpoint that reuses ETags across distinct bodies invalidate the
concurrency assumptions. Bucket versioning is optional and does not replace these conditions.

| Operation           | Physical behavior                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET                 | `GetObject`, consume/close body, decode envelope; `NoSuchKey` or a valid tombstone becomes `null`.                                                    |
| PUT `if-absent`     | `PutObject` with `If-None-Match: *`. An existing live object conflicts. A tombstone can be replaced using `If-Match` against its observed ETag.       |
| PUT `if-version`    | HEAD checks live state and version; `PutObject` still uses the caller's `If-Match` token atomically.                                                  |
| DELETE `if-version` | HEAD checks live state and version; a conditional `PutObject` replaces it with a new tombstone using `If-Match`.                                      |
| DELETE `if-absent`  | A read-only absence assertion using HEAD; success if logically absent, conflict if live. No object is removed.                                        |
| LIST                | `ListObjectsV2` pages plus HEAD per physical entry; filters tombstones and returns sorted logical keys, current ETags and last-modified milliseconds. |

All physical mutations are conditional writes. Metadata preflights never authorize an
unconditional overwrite: if another writer wins after HEAD, the final `If-Match` fails. Two
independent drivers racing against one version cannot both publish a replacement, deletion or
recreation. The implementation never uses a GET followed by an unconditional PUT/DELETE.

**Why tombstones?** An idempotent S3 deletion API is not the same contract as Duraxis's deletion
CAS, where a missing object conflicts and exactly one competing mutation may succeed. The
implementation uses conditional PUT's existence precondition to avoid depending on missing-key
DeleteObject behavior. `if-absent` deletion is simply an atomic read-only assertion: a later
concurrent create may succeed, which is consistent with the assertion's earlier observation.

Deleting replaces the body with a small persistent tombstone; it does not issue `DeleteObject`.
These objects intentionally remain to preserve logical state. Do not expire tombstones or restore
historical object generations while the database is active. In versioned buckets, old object
versions also retain previous payloads and incur storage costs. Removing historical versions or
tombstones requires a separately planned, externally exclusive maintenance procedure; no automatic
physical tombstone compactor is provided.

ListObjectsV2 includes ETag and LastModified, but no Duraxis state metadata or S3 VersionId.
HEAD is needed to exclude tombstones and read a coherent current ETag/state/timestamp tuple.
Up to 16 HEAD requests run concurrently per page, and all settle before shutdown or a listing
error is returned. No object bodies are downloaded during listing. LastModified is the current
generation's creation time, not the original logical key's first-ever creation time. Listing is
not a multi-object snapshot under concurrent writes; external exclusive maintenance remains
necessary for destructive GC. Generic HEAD 404s are confirmed with a narrow listing so missing
buckets and permission failures are not silently treated as missing objects.

## Transactions, uncertain outcomes and errors

The existing core writes immutable objects/index nodes and a commit-history record before
publishing the manifest with a conditional write. The manifest ETag is its optimistic publication
token. Losing that CAS raises the existing `TransactionConflictError`; the driver never retries
the transaction callback. These guarantees rely on a service that correctly implements strongly
consistent reads/listing and atomic `If-Match` / `If-None-Match` conditional writes.

The SDK has **one attempt for every request**. The driver explicitly retries safe reads only,
with bounded jitter, for selected transient failures (default three attempts). The public
`client.maxAttempts` controls these read attempts, never mutation retries. Access denial, invalid
requests and known unsupported operations are not automatically retried. Explicit 412 responses
and 409 `ConditionalRequestConflict` responses become conflicts; unrelated 409 errors remain errors.

A lost response, timeout, cancellation or server failure during a mutation may have happened
after S3 committed it. The driver throws `StorageError` with `OUTCOME_UNKNOWN` instead of claiming
failure or retrying into a false conflict. The core wraps manifest publication exceptions in
`CommitOutcomeUnknownError` and supplies the transaction ID for `database.getCommitStatus(id)`.
Commit history can establish `committed` even after later commits. An absent history entry means
`unknown`, not proof that an operation failed. Confirm status before deciding on an application retry.

Other failures map to `INVALID_KEY`, `ACCESS_DENIED`, `UNAVAILABLE`, `TIMEOUT`, `RESOURCE_LIMIT`,
`CORRUPTION`, `CLOSED` or `UNKNOWN` as appropriate. GET returns `null` only for confirmed key absence
or a valid tombstone. The driver does not log credentials or include configuration, object keys,
signed URLs or raw SDK messages in its public error messages. Original causes are retained for
diagnosis; apply your normal redaction policy before logging nested causes.

The implementation preserves the core's snapshot/optimistic transaction model. It does not add
distributed transactions, transparent conflict retries or a blanket full-ACID certification.

## Lifecycle, GC and metrics

One AWS client belongs to each driver. `close()` is idempotent, rejects new operations with
`CLOSED`, waits for active operations (including streams, pagination and retry waits), and then
destroys the client's resources. It does not force-cancel a hung request or impose a shutdown
deadline. Close after completing database/ORM work; close the database with `closeStorage: true`
or close the externally managed driver yourself.

GC uses listing timestamps and versions. A changed object's old ETag cannot authorize replacing
the newer generation with a tombstone. The existing core defaults GC to dry run; destructive GC
requires `exclusiveMaintenance: true` and an actual external guarantee that all application
instances, uploads and readers have stopped. The flag is an assertion, not an S3 distributed lock.
No destructive GC is enabled by this driver. S3 lifecycle policies must not expire live database
objects or commit-history records independently of Duraxis reachability.

`getMetrics()` returns a snapshot. `reads`, `writes`, `deletes` and `lists` count validated logical
driver calls, including conflicts. Bytes count successfully returned logical data and acknowledged
logical writes, excluding envelopes, tombstones and uncertain writes. `synchronizationWaitMs` is
zero because the driver has no local mutation lock. Counts are **not HTTP request counts**: HEAD
preflights, pagination, conflict checks and read retries add requests.

## Permissions and operational costs

Allow `s3:GetObject` and `s3:PutObject` for the dedicated object prefix, and `s3:ListBucket` on the
bucket with an appropriate prefix restriction. HEAD uses GetObject permission. No bucket creation,
ACL, version-listing or DeleteObject permission is needed by the driver. Default bucket SSE-KMS
encryption also needs the appropriate KMS permissions (including decrypt and data-key generation).
The optional integration-test cleanup additionally needs `s3:DeleteObject` in its random test prefix.

Typical request costs are one PUT for a new key, one HEAD plus one PUT for a replacement/deletion,
and a failed PUT, HEAD and conditional PUT for recreation over a tombstone. Missing HEAD may add
a narrow LIST. Listing adds one HEAD per physical object, including retained tombstones. Duraxis
transactions can write many immutable/index objects; measure latency and request charges for your
workload. Full objects are buffered in memory, with 72 bytes of physical envelope overhead; this
driver uses single PUT, not multipart uploads (maximum physical object size 5 GiB). Versioning,
noncurrent generations, tombstones, KMS and data transfer can add costs.

MinIO and other compatible endpoints must be independently verified for all required conditions,
metadata, pagination and consistency. Passing a fake transport or MinIO test does not establish
Amazon S3 compatibility. Production bucket policies should prevent other writers from bypassing
the driver's conditional-write protocol. A correct configuration cannot compensate for a service
that ignores conditional headers.

## Tests

```bash
pnpm build
pnpm exec vitest run --project @duraxis/storage-s3
```

Default tests make no AWS requests and need no credentials. They reuse the storage conformance
suite, a fake SDK transport, the actual SDK against a loopback HTTP server, real core/ORM/Nest
modules, racing manifest publishers, unknown commit outcomes, retained recovery history and GC
version checks. Loopback tests verify serialized conditional headers and mutation retry behavior.

Live tests are disabled by default. To opt in for a dedicated test bucket:

```bash
DURAXIS_S3_INTEGRATION=1 \
DURAXIS_S3_TEST_BUCKET=my-dedicated-test-bucket \
DURAXIS_S3_TEST_REGION=sa-east-1 \
pnpm exec vitest run --project @duraxis/storage-s3 src/__test__/s3-integration.spec.ts
```

For a compatible endpoint, additionally set `DURAXIS_S3_TEST_ENDPOINT=http://127.0.0.1:9000` and
`DURAXIS_S3_TEST_PATH_STYLE=1`. Configure standard AWS credential environment variables or a role;
no SDK client code is needed. Live conformance tests include 100-way write/CAS races and incur
requests. Each run creates a random `duraxis-integration/<UUID>/` namespace. Cleanup conditionally
deletes only that run's current objects. Versioned buckets retain historical versions/delete markers;
use a dedicated bucket and arrange their cleanup separately. Interrupted tests can leave isolated
test objects. Never point live tests at an active application's namespace.

## Local architecture reviewed

The implementation follows `storage`'s exact interface and errors, `storage-memory`/`storage-disk`
byte isolation and CAS conventions, and `storage-testkit`'s complete conformance suite. Core's
`CommitCoordinator` publishes through manifest CAS; `RecoveryManager` follows transaction IDs and
history; `GarbageCollector` relies on current versions/timestamps and conditional deletion. Nest's
`DuraxisNestConnection` owns factory-created drivers and optionally closes external ones. None of
these production implementations are changed.

The package follows the local ESM/CommonJS Vite build, strict TypeScript declarations, pnpm
workspace, Vitest project, package-validation and Changesets conventions. Public declarations only
reference Duraxis types. The repository has no Turborepo build configuration to extend.
