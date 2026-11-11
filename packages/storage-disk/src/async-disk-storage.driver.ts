import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  truncate,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  assertStorageKey,
  StorageError,
  type DeleteOptions,
  type DeleteResult,
  type StorageDriver,
  type StorageDriverMetrics,
  type StorageObject,
  type StorageObjectInfo,
  type WriteOptions,
  type WriteResult,
} from "@duraxis/storage";
import {
  decodeJournal,
  decodePhysicalObject,
  encodeJournalFrame,
  encodePhysicalObject,
  sha256,
  type JournalPayload,
  type StoredMetadata,
} from "./disk-format.js";

const LOCK_FILE = ".duraxis-owner.lock";
const JOURNAL_FILE = "journal.log";
const PREVIOUS_JOURNAL = "journal.previous";
const NEXT_JOURNAL = "journal.next";
const OBJECTS_DIRECTORY = "objects";
const OWNERSHIP_CONFIRMATION = "I_HAVE_VERIFIED_EXCLUSIVE_ACCESS";

export type DiskFaultPoint =
  | "after-object-sync"
  | "after-object-publish"
  | "after-object-directory-sync"
  | "after-journal-write"
  | "after-journal-sync"
  | "after-journal-rotation";

export interface DiskFaultContext {
  readonly operation: "put" | "delete" | "compact";
  readonly key?: string;
}

export interface AsyncDiskStorageOptions {
  readonly directory: string;
  readonly maxKeyBytes?: number;
  readonly maxObjectBytes?: number;
  readonly maxJournalBytes?: number;
  readonly nodeCacheHint?: number;
  readonly faultInjector?: (
    point: DiskFaultPoint,
    context: DiskFaultContext,
  ) => void | Promise<void>;
}

export interface RecoverOwnershipOptions {
  readonly directory: string;
  readonly confirmation: typeof OWNERSHIP_CONFIRMATION;
}

export interface DiskDurabilityCapabilities {
  readonly fileDataSync: true;
  readonly directoryEntrySync: boolean;
  readonly ownership: "exclusive-directory";
  readonly processCrashRecovery: true;
  readonly powerLossGuarantee: "file-and-directory-sync" | "file-sync-only";
}

interface MutableMetrics {
  reads: number;
  writes: number;
  deletes: number;
  lists: number;
  bytesRead: number;
  bytesWritten: number;
  synchronizationWaitMs: number;
}

interface LockPayload {
  readonly format: 1;
  readonly ownerId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: number;
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error == "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) == "ENOENT") return false;
    throw error;
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position = 0): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (result.bytesWritten <= 0)
      throw new StorageError("Disk write made no progress", "UNAVAILABLE");
    offset += result.bytesWritten;
  }
}

export class AsyncDiskStorageDriver implements StorageDriver {
  private static readonly activeDirectories = new Set<string>();

  private readonly entries = new Map<string, StoredMetadata>();
  private readonly ownerId = randomUUID();
  private readonly metrics: MutableMetrics = {
    reads: 0,
    writes: 0,
    deletes: 0,
    lists: 0,
    bytesRead: 0,
    bytesWritten: 0,
    synchronizationWaitMs: 0,
  };
  private operationTail: Promise<void> = Promise.resolve();
  private journal!: FileHandle;
  private lockHandle!: FileHandle;
  private journalBytes = 0;
  private sequence = 0;
  private directorySync = true;
  private closed = false;
  private closing = false;
  private poisoned = false;

  private constructor(
    private readonly root: string,
    private readonly registryKey: string,
    private readonly options: Required<
      Pick<AsyncDiskStorageOptions, "maxKeyBytes" | "maxObjectBytes" | "maxJournalBytes">
    > &
      AsyncDiskStorageOptions,
  ) {}

  public static async open(options: AsyncDiskStorageOptions): Promise<AsyncDiskStorageDriver> {
    if (!options || typeof options.directory != "string" || options.directory.trim() == "")
      throw new TypeError("A storage directory is required");
    const maxKeyBytes = options.maxKeyBytes ?? 4096;
    const maxObjectBytes = options.maxObjectBytes ?? 256 * 1024 * 1024;
    const maxJournalBytes = options.maxJournalBytes ?? 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(maxKeyBytes) || maxKeyBytes < 64 || maxKeyBytes > 64 * 1024)
      throw new RangeError("Invalid maximum storage key size");
    if (
      !Number.isSafeInteger(maxObjectBytes) ||
      maxObjectBytes < 0 ||
      maxObjectBytes > 1024 * 1024 * 1024
    )
      throw new RangeError("Invalid maximum object size");
    if (!Number.isSafeInteger(maxJournalBytes) || maxJournalBytes < 1024 * 1024)
      throw new RangeError("Invalid maximum journal size");

    const requested = resolve(options.directory);
    await mkdir(requested, { recursive: true });
    const root = await realpath(requested);
    const registryKey = process.platform == "win32" ? root.toLocaleLowerCase("en-US") : root;
    if (this.activeDirectories.has(registryKey))
      throw new StorageError(
        "Storage directory is already owned by this process",
        "OWNERSHIP_CONFLICT",
      );
    this.activeDirectories.add(registryKey);
    const driver = new AsyncDiskStorageDriver(root, registryKey, {
      ...options,
      directory: root,
      maxKeyBytes,
      maxObjectBytes,
      maxJournalBytes,
    });
    try {
      await driver.initialize();
      return driver;
    } catch (error) {
      this.activeDirectories.delete(registryKey);
      await driver.cleanupFailedOpen();
      throw error;
    }
  }

  public static async recoverAbandonedOwnership(options: RecoverOwnershipOptions): Promise<void> {
    if (options.confirmation != OWNERSHIP_CONFIRMATION)
      throw new StorageError("Explicit exclusive-access confirmation is required", "ACCESS_DENIED");
    const root = await realpath(resolve(options.directory));
    const registryKey = process.platform == "win32" ? root.toLocaleLowerCase("en-US") : root;
    if (this.activeDirectories.has(registryKey))
      throw new StorageError("Cannot recover ownership held by this process", "OWNERSHIP_CONFLICT");
    try {
      await unlink(join(root, LOCK_FILE));
    } catch (error) {
      if (nodeErrorCode(error) != "ENOENT") throw error;
    }
    try {
      await this.syncDirectoryStatic(root);
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM"].includes(nodeErrorCode(error) ?? ""))
        throw error;
    }
  }

  public get durability(): DiskDurabilityCapabilities {
    return {
      fileDataSync: true,
      directoryEntrySync: this.directorySync,
      ownership: "exclusive-directory",
      processCrashRecovery: true,
      powerLossGuarantee: this.directorySync ? "file-and-directory-sync" : "file-sync-only",
    };
  }

  public getMetrics(): Readonly<StorageDriverMetrics> {
    return { ...this.metrics };
  }

  private async initialize(): Promise<void> {
    await mkdir(join(this.root, OBJECTS_DIRECTORY), { recursive: true });
    const lockPath = join(this.root, LOCK_FILE);
    try {
      this.lockHandle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (nodeErrorCode(error) == "EEXIST")
        throw new StorageError(
          "Storage directory has an owner lock; close the owner or perform explicit abandoned-lock recovery",
          "OWNERSHIP_CONFLICT",
          { cause: error },
        );
      throw error;
    }
    const lockPayload: LockPayload = {
      format: 1,
      ownerId: this.ownerId,
      pid: process.pid,
      hostname: hostname(),
      createdAt: Date.now(),
    };
    const canonical = JSON.stringify(lockPayload);
    await writeAll(
      this.lockHandle,
      new TextEncoder().encode(
        JSON.stringify({
          ...lockPayload,
          checksum: sha256(canonical),
        }),
      ),
    );
    await this.lockHandle.sync();
    await this.syncDirectory(this.root);
    await this.recoverJournalRotation();
    const journalPath = join(this.root, JOURNAL_FILE);
    if (!(await exists(journalPath))) {
      const created = await open(journalPath, "wx", 0o600);
      await created.sync();
      await created.close();
      await this.syncDirectory(this.root);
    }
    const bytes = await readFile(journalPath);
    if (bytes.byteLength > this.options.maxJournalBytes)
      throw new StorageError("Storage journal exceeds configured limit", "RESOURCE_LIMIT");
    const decoded = decodeJournal(bytes);
    for (const frame of decoded.frames) {
      this.validateKey(frame.key);
      this.sequence = frame.sequence;
      if (frame.op == "put")
        this.entries.set(frame.key, {
          version: frame.version,
          createdAt: frame.createdAt,
          size: frame.size,
          digest: frame.digest,
        });
      else this.entries.delete(frame.key);
    }
    if (decoded.incompleteTail) {
      await truncate(journalPath, decoded.validBytes);
      const repaired = await open(journalPath, "r+");
      await repaired.sync();
      await repaired.close();
    }
    this.journalBytes = decoded.validBytes;
    this.journal = await open(journalPath, "r+");
    await this.assertCurrentObjectsExist();
    await this.cleanupPhysicalObjects();
  }

  private validateKey(key: string): void {
    assertStorageKey(key);
    if (Buffer.byteLength(key, "utf8") > this.options.maxKeyBytes)
      throw new StorageError("Storage key exceeds configured byte limit", "INVALID_KEY");
  }

  private assertUsable(): void {
    if (this.closed || this.closing) throw new StorageError("Storage driver is closed", "CLOSED");
    if (this.poisoned)
      throw new StorageError(
        "Storage outcome is unknown; close and reopen before continuing",
        "OUTCOME_UNKNOWN",
      );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.assertUsable();
    const before = performance.now();
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.metrics.synchronizationWaitMs += performance.now() - before;
    try {
      this.assertUsable();
      return await operation();
    } finally {
      release();
    }
  }

  public get(key: string): Promise<StorageObject | null> {
    return this.exclusive(async () => {
      this.validateKey(key);
      this.metrics.reads++;
      const metadata = this.entries.get(key);
      if (!metadata) return null;
      const path = this.objectPath(key, metadata.version);
      let info;
      try {
        info = await stat(path);
      } catch (error) {
        if (nodeErrorCode(error) == "ENOENT")
          throw new StorageError(`Missing physical object for key ${key}`, "CORRUPTION", {
            cause: error,
          });
        throw error;
      }
      if (info.size > this.options.maxObjectBytes + 32 * 1024)
        throw new StorageError("Physical object exceeds configured size", "CORRUPTION");
      const physical = await readFile(path);
      this.metrics.bytesRead += physical.byteLength;
      return { data: decodePhysicalObject(physical, key, metadata), version: metadata.version };
    });
  }

  public put(key: string, data: Uint8Array, options: WriteOptions): Promise<WriteResult> {
    return this.exclusive(async () => {
      this.validateKey(key);
      if (!(data instanceof Uint8Array)) throw new TypeError("Storage data must be a Uint8Array");
      if (data.byteLength > this.options.maxObjectBytes)
        throw new StorageError("Storage object exceeds configured byte limit", "RESOURCE_LIMIT");
      const current = this.entries.get(key);
      if (
        options.condition.type == "if-absent"
          ? current != null
          : current == null || current.version != options.condition.version
      )
        return { success: false, reason: "conflict" };
      this.metrics.writes++;
      const metadata: StoredMetadata = {
        version: randomUUID(),
        createdAt: Date.now(),
        size: data.byteLength,
        digest: sha256(data),
      };
      const physical = encodePhysicalObject(key, metadata, data);
      const finalPath = this.objectPath(key, metadata.version);
      const parent = dirname(finalPath);
      await mkdir(parent, { recursive: true });
      const temporary = join(parent, `.${metadata.version}.${randomUUID()}.tmp`);
      let published = false;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await writeAll(handle, physical);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.fault("after-object-sync", { operation: "put", key });
        await rename(temporary, finalPath);
        published = true;
        await this.fault("after-object-publish", { operation: "put", key });
        await this.syncDirectory(parent);
        await this.fault("after-object-directory-sync", { operation: "put", key });
        const frame: JournalPayload = {
          format: 1,
          sequence: this.sequence + 1,
          op: "put",
          key,
          version: metadata.version,
          createdAt: metadata.createdAt,
          size: metadata.size,
          digest: metadata.digest,
        };
        await this.append(frame);
        this.entries.set(key, metadata);
        this.sequence = frame.sequence;
        this.metrics.bytesWritten += physical.byteLength;
        if (current) await this.removeObsolete(this.objectPath(key, current.version));
        return { success: true, version: metadata.version };
      } catch (error) {
        if (!published) await this.removeObsolete(temporary);
        throw error;
      }
    });
  }

  public delete(key: string, options: DeleteOptions): Promise<DeleteResult> {
    return this.exclusive(async () => {
      this.validateKey(key);
      const current = this.entries.get(key);
      if (options.condition.type == "if-absent")
        return current ? { success: false, reason: "conflict" } : { success: true };
      if (!current || current.version != options.condition.version)
        return { success: false, reason: "conflict" };
      this.metrics.deletes++;
      const frame: JournalPayload = {
        format: 1,
        sequence: this.sequence + 1,
        op: "delete",
        key,
      };
      await this.append(frame);
      this.entries.delete(key);
      this.sequence = frame.sequence;
      await this.removeObsolete(this.objectPath(key, current.version));
      return { success: true };
    });
  }

  public list(prefix: string): Promise<readonly StorageObjectInfo[]> {
    return this.exclusive(async () => {
      if (
        typeof prefix != "string" ||
        prefix.includes("\0") ||
        Buffer.byteLength(prefix, "utf8") > this.options.maxKeyBytes
      )
        throw new StorageError("Invalid storage prefix", "INVALID_KEY");
      this.metrics.lists++;
      return [...this.entries]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, version: value.version, createdAt: value.createdAt }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    });
  }

  private async append(frame: JournalPayload): Promise<void> {
    const encoded = encodeJournalFrame(frame);
    if (this.journalBytes + encoded.byteLength > this.options.maxJournalBytes)
      throw new StorageError(
        "Storage journal limit reached; compact before writing",
        "RESOURCE_LIMIT",
      );
    try {
      await writeAll(this.journal, encoded, this.journalBytes);
      await this.fault("after-journal-write", { operation: frame.op, key: frame.key });
      await this.journal.sync();
      await this.fault("after-journal-sync", { operation: frame.op, key: frame.key });
      this.journalBytes += encoded.byteLength;
      this.metrics.bytesWritten += encoded.byteLength;
    } catch (cause) {
      this.poisoned = true;
      throw new StorageError("Storage publication outcome is unknown", "OUTCOME_UNKNOWN", {
        cause,
      });
    }
  }

  public compact(): Promise<void> {
    return this.exclusive(async () => {
      try {
        const nextPath = join(this.root, NEXT_JOURNAL);
        const previousPath = join(this.root, PREVIOUS_JOURNAL);
        const currentPath = join(this.root, JOURNAL_FILE);
        await this.removeObsolete(nextPath);
        await this.removeObsolete(previousPath);
        const next = await open(nextPath, "wx", 0o600);
        let offset = 0;
        let sequence = 0;
        try {
          for (const [key, metadata] of [...this.entries].sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          )) {
            const bytes = encodeJournalFrame({
              format: 1,
              sequence: ++sequence,
              op: "put",
              key,
              version: metadata.version,
              createdAt: metadata.createdAt,
              size: metadata.size,
              digest: metadata.digest,
            });
            await writeAll(next, bytes, offset);
            offset += bytes.byteLength;
          }
          await next.sync();
        } finally {
          await next.close();
        }
        await this.journal.close();
        await rename(currentPath, previousPath);
        await rename(nextPath, currentPath);
        await this.syncDirectory(this.root);
        await this.fault("after-journal-rotation", { operation: "compact" });
        this.journal = await open(currentPath, "r+");
        this.journalBytes = offset;
        this.sequence = sequence;
        await this.removeObsolete(previousPath);
      } catch (cause) {
        this.poisoned = true;
        throw new StorageError("Journal compaction outcome is unknown", "OUTCOME_UNKNOWN", {
          cause,
        });
      }
    });
  }

  public async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    await this.operationTail;
    let failure: unknown;
    try {
      if (this.journal) await this.journal.close();
      if (this.lockHandle) await this.lockHandle.close();
      const lockPath = join(this.root, LOCK_FILE);
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      const canonical = JSON.stringify({
        format: lock.format,
        ownerId: lock.ownerId,
        pid: lock.pid,
        hostname: lock.hostname,
        createdAt: lock.createdAt,
      });
      if (
        Object.keys(lock).sort().join(",") != "checksum,createdAt,format,hostname,ownerId,pid" ||
        lock.format != 1 ||
        lock.ownerId != this.ownerId ||
        lock.checksum != sha256(canonical)
      )
        throw new StorageError("Storage ownership changed unexpectedly", "OWNERSHIP_CONFLICT");
      await unlink(lockPath);
      await this.syncDirectory(this.root);
    } catch (error) {
      failure = error;
    } finally {
      this.closed = true;
      this.closing = false;
      AsyncDiskStorageDriver.activeDirectories.delete(this.registryKey);
    }
    if (failure) throw failure;
  }

  private objectPath(key: string, version: string): string {
    const hash = sha256(new TextEncoder().encode(key));
    return join(this.root, OBJECTS_DIRECTORY, hash.slice(0, 2), hash, `${version}.obj`);
  }

  private async assertCurrentObjectsExist(): Promise<void> {
    for (const [key, metadata] of this.entries) {
      try {
        await stat(this.objectPath(key, metadata.version));
      } catch (error) {
        if (nodeErrorCode(error) == "ENOENT")
          throw new StorageError(`Journal references a missing object: ${key}`, "CORRUPTION", {
            cause: error,
          });
        throw error;
      }
    }
  }

  private async cleanupPhysicalObjects(): Promise<void> {
    const referenced = new Set(
      [...this.entries].map(([key, metadata]) => this.objectPath(key, metadata.version)),
    );
    const walk = async (directory: string): Promise<void> => {
      let items;
      try {
        items = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (nodeErrorCode(error) == "ENOENT") return;
        throw error;
      }
      for (const item of items) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await walk(path);
        else if (
          item.isFile() &&
          (item.name.endsWith(".tmp") || (item.name.endsWith(".obj") && !referenced.has(path)))
        )
          await this.removeObsolete(path);
      }
    };
    await walk(join(this.root, OBJECTS_DIRECTORY));
  }

  private async recoverJournalRotation(): Promise<void> {
    const current = join(this.root, JOURNAL_FILE);
    const previous = join(this.root, PREVIOUS_JOURNAL);
    const next = join(this.root, NEXT_JOURNAL);
    const hasCurrent = await exists(current);
    const hasPrevious = await exists(previous);
    const hasNext = await exists(next);
    if (!hasCurrent) {
      if (hasNext) await rename(next, current);
      else if (hasPrevious) await rename(previous, current);
    } else if (hasPrevious) {
      try {
        decodeJournal(await readFile(current));
        await this.removeObsolete(previous);
      } catch {
        await this.removeObsolete(current);
        await rename(previous, current);
      }
    }
    if ((await exists(current)) && (await exists(next))) await this.removeObsolete(next);
    if ((await exists(current)) && (await exists(previous))) await this.removeObsolete(previous);
    await this.syncDirectory(this.root);
  }

  private async fault(point: DiskFaultPoint, context: DiskFaultContext): Promise<void> {
    await this.options.faultInjector?.(point, context);
  }

  private async removeObsolete(path: string): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch {
      /* Cleanup is retried during the next open. */
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    if (!this.directorySync) return;
    try {
      await AsyncDiskStorageDriver.syncDirectoryStatic(directory);
    } catch (error) {
      if (["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM"].includes(nodeErrorCode(error) ?? ""))
        this.directorySync = false;
      else throw error;
    }
  }

  private static async syncDirectoryStatic(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async cleanupFailedOpen(): Promise<void> {
    try {
      if (this.journal) await this.journal.close();
    } catch {}
    try {
      if (this.lockHandle) await this.lockHandle.close();
    } catch {}
    try {
      const lockPath = join(this.root, LOCK_FILE);
      if (await exists(lockPath)) {
        const value = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
        if (value.ownerId == this.ownerId) await unlink(lockPath);
      }
    } catch {}
  }
}
