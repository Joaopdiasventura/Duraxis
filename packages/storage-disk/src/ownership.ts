import { randomUUID } from "node:crypto";
import { open, readFile, readlink, stat, statfs, unlink, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { StorageError } from "@duraxis/storage";
import { sha256 } from "./disk-format.js";

const LOCK_FILE = ".duraxis-owner.lock";
const RECOVERY_GUARD_FILE = ".duraxis-owner.recovery";
const OWNERSHIP_CONFIRMATION = "I_HAVE_VERIFIED_EXCLUSIVE_ACCESS";
const OWNER_FIELDS = "applicationId,checksum,createdAt,format,hostname,ownerId,pid,processIdentity";
const GUARD_FIELDS = "checksum,createdAt,format,guardId,hostname,pid";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$/;
const PROCESS_IDENTITY_PATTERN = /^(?:linux:(?:pid:\[\d+\]|unavailable)|[a-z0-9]+:unverified)$/;
const MAX_METADATA_BYTES = 4096;

// Explicit allowlist. Unknown, remote, and userspace filesystems fail closed.
const LINUX_LOCAL_FILESYSTEMS = new Set([
  0x0000ef53, // ext2/3/4
  0x01021994, // tmpfs
  0x2fc12fc1, // zfs
  0x58465342, // xfs
  0x794c7630, // overlayfs
  0x858458f6, // ramfs
  0x9123683e, // btrfs
]);

export interface OwnershipRecoveryOptions {
  /** Defaults to manual. dead-process is restricted to validated local Linux environments. */
  readonly mode: "manual" | "dead-process";
  /** Stable application identity across restarts. It is not an owner token or a secret. */
  readonly applicationId?: string;
}

export interface RecoverOwnershipOptions {
  readonly directory: string;
  readonly confirmation: typeof OWNERSHIP_CONFIRMATION;
}

export interface NormalizedOwnershipRecovery {
  readonly mode: "manual" | "dead-process";
  readonly applicationId?: string;
}

interface OwnerPayload {
  readonly format: 2;
  readonly ownerId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: number;
  readonly applicationId: string | null;
  readonly processIdentity: string;
}

interface OwnerRecord extends OwnerPayload {
  readonly checksum: string;
}

interface GuardPayload {
  readonly format: 1;
  readonly guardId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: number;
}

interface GuardRecord extends GuardPayload {
  readonly checksum: string;
}

interface ObservedFile {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: Stats;
  readonly bytes: Buffer;
}

interface CoordinationGuard {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: Stats;
  readonly bytes: Buffer;
  readonly guardId: string;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error == "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function ownershipConflict(message: string, cause?: unknown): StorageError {
  return new StorageError(message, "OWNERSHIP_CONFLICT", cause == null ? undefined : { cause });
}

function canonicalOwner(payload: OwnerPayload): string {
  return JSON.stringify(payload);
}

function canonicalGuard(payload: GuardPayload): string {
  return JSON.stringify(payload);
}

function validHostname(value: unknown): value is string {
  return (
    typeof value == "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\0-\x1f\x7f]/.test(value)
  );
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev == right.dev && left.ino == right.ino;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;

  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);

    if (result.bytesWritten <= 0)
      throw new StorageError("Ownership metadata write made no progress", "UNAVAILABLE");

    offset += result.bytesWritten;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;

  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM"].includes(errorCode(error) ?? ""))
      throw error;
  } finally {
    await handle?.close();
  }
}

async function observe(path: string): Promise<ObservedFile | null> {
  let handle: FileHandle;

  try {
    handle = await open(path, "r");
  } catch (error) {
    if (errorCode(error) == "ENOENT") return null;
    throw error;
  }

  try {
    const identity = await handle.stat();
    const bytes = await handle.readFile();

    return { path, handle, identity, bytes };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertObservedUnchanged(observed: ObservedFile): Promise<void> {
  let currentIdentity: Stats;
  let currentBytes: Buffer;

  try {
    [currentIdentity, currentBytes] = await Promise.all([
      stat(observed.path),
      readFile(observed.path),
    ]);
  } catch (cause) {
    throw ownershipConflict("Ownership metadata changed during inspection", cause);
  }

  if (!sameIdentity(observed.identity, currentIdentity) || !observed.bytes.equals(currentBytes))
    throw ownershipConflict("Ownership metadata changed during inspection");
}

async function removeObserved(observed: ObservedFile): Promise<void> {
  try {
    await assertObservedUnchanged(observed);
  } finally {
    await observed.handle.close();
  }

  try {
    await unlink(observed.path);
  } catch (cause) {
    throw ownershipConflict("Failed to remove the observed ownership lock", cause);
  }
}

async function removeCreatedFile(path: string, handle: FileHandle, identity: Stats): Promise<void> {
  await handle.close().catch(() => undefined);

  try {
    const current = await stat(path);

    if (!sameIdentity(identity, current))
      throw ownershipConflict("Created ownership file was replaced unexpectedly");

    await unlink(path);
  } catch (error) {
    if (errorCode(error) != "ENOENT") throw error;
  }
}

function parseRecord(bytes: Uint8Array, label: string): Record<string, unknown> {
  if (bytes.byteLength == 0 || bytes.byteLength > MAX_METADATA_BYTES)
    throw ownershipConflict(`Invalid ${label}`);

  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

    if (!value || typeof value != "object" || Array.isArray(value))
      throw new Error("not an object");

    return value as Record<string, unknown>;
  } catch (cause) {
    throw ownershipConflict(`Invalid ${label}`, cause);
  }
}

function parseOwner(bytes: Uint8Array): OwnerRecord {
  const record = parseRecord(bytes, "owner lock metadata");

  if (record.format != 2)
    throw ownershipConflict(
      "Owner lock format is incompatible with automatic recovery; use explicit manual recovery",
    );

  if (
    Object.keys(record).sort().join(",") != OWNER_FIELDS ||
    !UUID_PATTERN.test(String(record.ownerId)) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    !validHostname(record.hostname) ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt as number) < 0 ||
    (record.applicationId !== null &&
      (typeof record.applicationId != "string" ||
        !APPLICATION_ID_PATTERN.test(record.applicationId))) ||
    typeof record.processIdentity != "string" ||
    !PROCESS_IDENTITY_PATTERN.test(record.processIdentity) ||
    typeof record.checksum != "string" ||
    !/^[0-9a-f]{64}$/.test(record.checksum)
  )
    throw ownershipConflict("Invalid owner lock metadata");

  const payload: OwnerPayload = {
    format: 2,
    ownerId: record.ownerId as string,
    pid: record.pid as number,
    hostname: record.hostname,
    createdAt: record.createdAt as number,
    applicationId: record.applicationId as string | null,
    processIdentity: record.processIdentity,
  };

  if (sha256(canonicalOwner(payload)) != record.checksum)
    throw ownershipConflict("Owner lock metadata checksum is invalid");

  return { ...payload, checksum: record.checksum };
}

function parseGuard(bytes: Uint8Array): GuardRecord {
  const record = parseRecord(bytes, "ownership recovery guard");

  if (
    Object.keys(record).sort().join(",") != GUARD_FIELDS ||
    record.format != 1 ||
    !UUID_PATTERN.test(String(record.guardId)) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    !validHostname(record.hostname) ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt as number) < 0 ||
    typeof record.checksum != "string" ||
    !/^[0-9a-f]{64}$/.test(record.checksum)
  )
    throw ownershipConflict("Invalid ownership recovery guard");

  const payload: GuardPayload = {
    format: 1,
    guardId: record.guardId as string,
    pid: record.pid as number,
    hostname: record.hostname,
    createdAt: record.createdAt as number,
  };

  if (sha256(canonicalGuard(payload)) != record.checksum)
    throw ownershipConflict("Ownership recovery guard checksum is invalid");

  return { ...payload, checksum: record.checksum };
}

async function acquireGuard(root: string): Promise<CoordinationGuard> {
  const path = join(root, RECOVERY_GUARD_FILE);

  let handle: FileHandle;

  try {
    handle = await open(path, "wx", 0o600);
  } catch (cause) {
    if (errorCode(cause) == "EEXIST")
      throw ownershipConflict(
        "Another ownership operation is active or left an uncertain recovery guard",
        cause,
      );

    throw cause;
  }
  let identity: Stats;
  try {
    identity = await handle.stat();
  } catch (cause) {
    await handle.close().catch(() => undefined);

    throw cause;
  }

  const payload: GuardPayload = {
    format: 1,
    guardId: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
  };

  const bytes = Buffer.from(
    JSON.stringify({ ...payload, checksum: sha256(canonicalGuard(payload)) }),
  );

  try {
    await writeAll(handle, bytes);
    await handle.sync();
    await syncDirectory(root);

    return { path, handle, identity, bytes, guardId: payload.guardId };
  } catch (cause) {
    try {
      await removeCreatedFile(path, handle, identity);
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        "Ownership guard creation and cleanup both failed",
      );
    }
    throw cause;
  }
}

async function releaseGuard(root: string, guard: CoordinationGuard): Promise<void> {
  try {
    const currentIdentity = await stat(guard.path);
    const currentBytes = await readFile(guard.path);
    const record = parseGuard(currentBytes);

    if (
      !sameIdentity(guard.identity, currentIdentity) ||
      !guard.bytes.equals(currentBytes) ||
      record.guardId != guard.guardId
    )
      throw ownershipConflict("Ownership recovery guard changed unexpectedly");
  } finally {
    await guard.handle.close();
  }

  await unlink(guard.path);
  await syncDirectory(root);
}

async function withGuard<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const guard = await acquireGuard(root);
  let result: T | undefined;
  let operationFailure: unknown;

  try {
    result = await operation();
  } catch (error) {
    operationFailure = error;
  }

  try {
    await releaseGuard(root, guard);
  } catch (guardFailure) {
    if (operationFailure != null)
      throw new AggregateError(
        [operationFailure, guardFailure],
        "Ownership operation and recovery-guard release both failed",
      );

    throw guardFailure;
  }

  if (operationFailure != null) throw operationFailure;

  return result as T;
}

async function automaticProcessIdentity(root: string): Promise<string> {
  if (process.platform != "linux")
    throw ownershipConflict(
      "Automatic dead-process recovery is supported only on validated Linux environments",
    );

  let namespace: string;

  try {
    namespace = await readlink("/proc/self/ns/pid");
  } catch (cause) {
    throw ownershipConflict("The Linux PID namespace cannot be established", cause);
  }

  if (!/^pid:\[\d+\]$/.test(namespace))
    throw ownershipConflict("The Linux PID namespace identity is invalid");

  let filesystemType: number;

  try {
    filesystemType = (await statfs(root)).type >>> 0;
  } catch (cause) {
    throw ownershipConflict("The storage filesystem type cannot be established", cause);
  }

  if (!LINUX_LOCAL_FILESYSTEMS.has(filesystemType))
    throw ownershipConflict(
      `Automatic recovery is not supported on filesystem type 0x${filesystemType.toString(16)}`,
    );

  return `linux:${namespace}`;
}

async function processIdentityForLock(root: string, mode: "manual" | "dead-process") {
  if (mode == "dead-process") return await automaticProcessIdentity(root);

  if (process.platform == "linux") {
    try {
      return `linux:${await readlink("/proc/self/ns/pid")}`;
    } catch {
      return "linux:unavailable";
    }
  }
  return `${process.platform}:unverified`;
}

function assertRecoverableOwner(
  owner: OwnerRecord,
  recovery: NormalizedOwnershipRecovery,
  processIdentity: string,
): void {
  if (owner.hostname != hostname())
    throw ownershipConflict("Owner lock belongs to a different host");

  if (owner.processIdentity != processIdentity)
    throw ownershipConflict("Owner lock belongs to a different or unsupported process namespace");

  if (owner.applicationId != (recovery.applicationId ?? null))
    throw ownershipConflict("Owner lock belongs to a different application identity");

  try {
    process.kill(owner.pid, 0);
  } catch (cause) {
    if (errorCode(cause) == "ESRCH") return;

    if (errorCode(cause) == "EPERM")
      throw ownershipConflict("Owner process existence is inconclusive", cause);

    throw ownershipConflict("Owner process existence could not be determined", cause);
  }

  throw ownershipConflict(
    "Owner process may still be running; PID reuse is treated as an ownership conflict",
  );
}

async function createOwnerFile(
  root: string,
  ownerId: string,
  recovery: NormalizedOwnershipRecovery,
  processIdentity: string,
): Promise<{ handle: FileHandle; identity: Stats } | null> {
  const path = join(root, LOCK_FILE);
  let handle: FileHandle;

  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) == "EEXIST") return null;
    throw error;
  }

  let identity: Stats;

  try {
    identity = await handle.stat();
  } catch (cause) {
    await handle.close().catch(() => undefined);
    throw cause;
  }

  const payload: OwnerPayload = {
    format: 2,
    ownerId,
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
    applicationId: recovery.applicationId ?? null,
    processIdentity,
  };

  const bytes = Buffer.from(
    JSON.stringify({ ...payload, checksum: sha256(canonicalOwner(payload)) }),
  );

  try {
    await writeAll(handle, bytes);
    await handle.sync();
    await syncDirectory(root);
    return { handle, identity };
  } catch (cause) {
    try {
      await removeCreatedFile(path, handle, identity);
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        "Owner lock creation and cleanup both failed",
      );
    }

    throw cause;
  }
}

export function normalizeOwnershipRecovery(
  options: OwnershipRecoveryOptions | undefined,
): NormalizedOwnershipRecovery {
  if (options == null) return { mode: "manual" };

  if (options.mode != "manual" && options.mode != "dead-process")
    throw new TypeError('ownershipRecovery.mode must be "manual" or "dead-process"');

  if (
    options.applicationId != null &&
    (typeof options.applicationId != "string" ||
      !APPLICATION_ID_PATTERN.test(options.applicationId))
  )
    throw new TypeError("ownershipRecovery.applicationId must be 1-128 safe identifier characters");

  return {
    mode: options.mode,
    ...(options.applicationId == null ? {} : { applicationId: options.applicationId }),
  };
}

export class DirectoryOwnership {
  readonly #ownerId = randomUUID();
  #lockHandle?: FileHandle;
  #owned = false;

  public constructor(
    private readonly root: string,
    private readonly recovery: NormalizedOwnershipRecovery,
  ) {}

  public get isOwned(): boolean {
    return this.#owned;
  }

  public async acquire(): Promise<void> {
    const processIdentity = await processIdentityForLock(this.root, this.recovery.mode);

    await withGuard(this.root, async () => {
      let created = await createOwnerFile(this.root, this.#ownerId, this.recovery, processIdentity);
      if (!created) {
        if (this.recovery.mode == "manual")
          throw ownershipConflict(
            "Storage directory has an owner lock; close the owner or perform explicit abandoned-lock recovery",
          );

        const observed = await observe(join(this.root, LOCK_FILE));

        if (observed) {
          let owner: OwnerRecord;

          try {
            owner = parseOwner(observed.bytes);
            assertRecoverableOwner(owner, this.recovery, processIdentity);
            await removeObserved(observed);
          } catch (error) {
            await observed.handle.close().catch(() => undefined);
            throw error;
          }

          await syncDirectory(this.root);
        }

        created = await createOwnerFile(this.root, this.#ownerId, this.recovery, processIdentity);

        if (!created)
          throw ownershipConflict("Another process acquired storage ownership during recovery");
      }
      this.#lockHandle = created.handle;
      this.#owned = true;
    });
  }

  public async release(): Promise<void> {
    if (!this.#owned) return;

    await withGuard(this.root, async () => {
      const observed = await observe(join(this.root, LOCK_FILE));
      if (!observed) {
        this.#owned = false;
        await this.#lockHandle?.close().catch(() => undefined);

        this.#lockHandle = undefined;
        throw ownershipConflict("Current owner lock is missing");
      }

      try {
        const owner = parseOwner(observed.bytes);

        if (owner.ownerId != this.#ownerId)
          throw ownershipConflict("Storage ownership changed unexpectedly");

        await this.#lockHandle?.close();
        this.#lockHandle = undefined;

        await removeObserved(observed);
        this.#owned = false;

        await syncDirectory(this.root);
      } catch (error) {
        await observed.handle.close().catch(() => undefined);
        throw error;
      }
    });
  }
}

export async function manuallyRecoverOwnership(root: string): Promise<void> {
  await withGuard(root, async () => {
    const observed = await observe(join(root, LOCK_FILE));
    if (!observed) return;
    await removeObserved(observed);
    await syncDirectory(root);
  });
}

export function validateManualRecoveryConfirmation(
  confirmation: RecoverOwnershipOptions["confirmation"],
): void {
  if (confirmation != OWNERSHIP_CONFIRMATION)
    throw new StorageError("Explicit exclusive-access confirmation is required", "ACCESS_DENIED");
}
