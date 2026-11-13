# @duraxis/storage-disk

Asynchronous local-filesystem `StorageDriver` for Duraxis. It persists immutable object payloads
and a checksummed journal while holding exclusive ownership of the database directory.

## Installation

```bash
pnpm add @duraxis/storage-disk
npm install @duraxis/storage-disk
yarn add @duraxis/storage-disk
```

Node.js 22.12 or newer is required.

## Basic use

```ts
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";

const storage = await AsyncDiskStorageDriver.open({ directory: "./data/duraxis" });
try {
  await storage.put("example", new TextEncoder().encode("value"), {
    condition: { type: "if-absent" },
  });
} finally {
  await storage.close();
}
```

The package exports `AsyncDiskStorageDriver`, its options and durability types, and the
`OwnershipRecoveryOptions` and `RecoverOwnershipOptions` types. It implements the contract from
`@duraxis/storage` and is normally consumed through `@duraxis/core`, `@duraxis/orm`, or
`@duraxis/nestjs`.

## Exclusive directory ownership

Opening a driver atomically creates `.duraxis-owner.lock`. A second driver cannot begin journal
recovery or database operations while that lock exists. A unique per-process owner token prevents
`close()` and failed-initialization cleanup from deleting a replacement lock. Repeated or
concurrent `close()` calls share the same shutdown attempt and only the current owner may release
the lock.

All participating acquire, recovery, and release operations are serialized by an exclusively
created `.duraxis-owner.recovery` guard. The guard is checked by file identity, token, checksum,
and exact contents before it is removed. Duraxis never guesses that an existing guard is stale:
an interrupted guard operation therefore requires operator investigation.

Ownership metadata format 2 records the owner token, PID, hostname, application identity, Linux
PID namespace, creation time, and checksum. Older format-1 locks remain compatible with explicit
manual recovery, but are never reclaimed automatically because they do not contain sufficient
process identity.

## Recovery modes

The default remains conservative and backward-compatible:

```ts
await AsyncDiskStorageDriver.open({
  directory: "./data/duraxis",
  ownershipRecovery: { mode: "manual" }, // also the default when omitted
});
```

After an unexpected termination, manual recovery requires an operational check that no process
can still use the directory:

```ts
await AsyncDiskStorageDriver.recoverAbandonedOwnership({
  directory: "./data/duraxis",
  confirmation: "I_HAVE_VERIFIED_EXCLUSIVE_ACCESS",
});
```

The confirmation is deliberately explicit; the method does not prove that the old process is
dead. Stop all application replicas and inspect the host before using it. Recovery only removes
ownership metadata. It does not erase objects, reset the journal, or truncate committed data.
Normal journal recovery runs after the replacement owner has acquired the directory.

For a supported local Linux deployment, conservative automatic recovery can be enabled:

```ts
const storage = await AsyncDiskStorageDriver.open({
  directory: "/var/lib/my-service/duraxis",
  ownershipRecovery: {
    mode: "dead-process",
    applicationId: "com.example.my-service",
  },
});
```

Use one stable `applicationId` for the application across restarts. It must be 1-128 characters
using letters, digits, `.`, `_`, `:`, `/`, or `-`; it is an identifier, not a secret. Matching
application IDs never prove owner death by themselves.

Automatic recovery occurs only when all of these checks succeed:

- the lock is valid format 2 and its checksum and required fields are valid;
- application ID, hostname, and Linux PID namespace exactly match the current process;
- the directory is on an explicitly recognized local filesystem;
- `process.kill(recordedPid, 0)` reports `ESRCH` in that same process namespace; and
- the recovery guard is acquired and the observed lock remains byte-for-byte and inode-identical.

A live PID, PID reuse, `EPERM`, corrupt or truncated metadata, another hostname or namespace, an
unknown filesystem, or any inconclusive result produces `OWNERSHIP_CONFLICT` without modifying the
owner lock. Lock age is never used as proof of death.

### Supported environments and limitations

Automatic recovery is currently enabled only on Linux with `/proc` PID namespaces and these
recognized local filesystem types: ext2/3/4, XFS, Btrfs, ZFS, tmpfs, ramfs, and overlayfs. Network
filesystems, FUSE/unknown filesystems, Windows, and macOS fail closed; use manual mode there.
Container replacement commonly changes the PID namespace even when the hostname is reused, so it
also requires manual recovery. A matching hostname does not imply a shared PID namespace.

This mechanism is not a distributed lock, lease, heartbeat, or fencing service. Do not share a
database directory between hosts or independent containers. Filesystem power-loss guarantees still
depend on the operating system and storage device honoring file and directory synchronization.

If `.duraxis-owner.recovery` exists after an interrupted ownership operation, Duraxis will not
remove it. First stop every possible owner/recovery process, verify the directory is not mounted or
used elsewhere, preserve the files for diagnosis, and only then remove the guard manually. Run the
explicit recovery method for the owner lock afterward. Never automate this operator procedure.

## NestJS factory integration

Use a driver factory so `DuraxisModule` owns and closes the disk driver. A supplied driver instance
is externally owned by default and is not closed unless `closeStorage: true` is set.

```ts
import { Module } from "@nestjs/common";
import { DuraxisModule } from "@duraxis/nestjs";
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";
import { User } from "./user.entity.js";

@Module({
  imports: [
    DuraxisModule.forRootAsync({
      useFactory: async () => ({
        driver: () =>
          AsyncDiskStorageDriver.open({
            directory: "/var/lib/my-service/duraxis",
            ownershipRecovery: {
              mode: "dead-process",
              applicationId: "com.example.my-service",
            },
          }),
        entities: [User],
        schema: { mode: "validate" },
      }),
    }),
    DuraxisModule.forFeature([User]),
  ],
})
export class AppModule {}
```

Nest application shutdown awaits the factory-owned driver. Graceful shutdown removes the owner
lock, and the same directory can then be reopened with its persisted data intact.

## Operational notes

- Place the database on a local filesystem and grant the application exclusive directory access.
- Always await `close()` during graceful shutdown.
- Treat `OWNERSHIP_CONFLICT` as a safety decision; do not add an unsafe force-unlock loop.
- Back up and inspect the database before manual intervention after a crash.
- `durability` reports whether directory-entry synchronization is available on the current host.

The driver does not coordinate multiple hosts. It preserves atomic storage operations, journal
recovery, object versions, and checksummed physical formats, but should be evaluated against the
failure model and storage stack of each deployment.
