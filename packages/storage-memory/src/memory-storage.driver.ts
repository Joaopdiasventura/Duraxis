import {
  StorageError,
  assertStorageKey,
  assertWriteCondition,
  type StorageDriver,
  type StorageObject,
  type StorageObjectInfo,
  type WriteOptions,
  type WriteResult,
  type DeleteOptions,
  type DeleteResult,
  type StorageDriverMetrics,
} from "@duraxis/storage";

interface MemoryEntry {
  readonly data: Uint8Array;
  readonly version: string;
  readonly createdAt: number;
}

export interface MemoryStorageOptions {
  readonly maxStoredBytes?: number;
  readonly maxEntries?: number;
  readonly maxObjectBytes?: number;
}

export class MemoryStorageDriver implements StorageDriver {
  public readonly capabilities = Object.freeze({ boundedReads: true });
  private readonly entries = new Map<string, MemoryEntry>();

  private versionCounter = 0n;
  private storedBytes = 0;

  public constructor(private readonly options: MemoryStorageOptions = {}) {
    for (const value of Object.values(options))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError("Invalid memory storage limit");
  }

  public getResourceUsage() {
    return { storedBytes: this.storedBytes, entries: this.entries.size };
  }

  private readonly metrics: StorageDriverMetrics = {
    reads: 0,
    writes: 0,
    deletes: 0,
    lists: 0,
    bytesRead: 0,
    bytesWritten: 0,
    synchronizationWaitMs: 0,
  };

  public async get(
    key: string,
    options: { readonly signal?: AbortSignal; readonly maxBytes?: number } = {},
  ): Promise<StorageObject | null> {
    assertStorageKey(key);

    (this.metrics as { reads: number }).reads++;

    options.signal?.throwIfAborted();

    const entry = this.entries.get(key);

    if (entry && entry.data.byteLength > (options.maxBytes ?? 16 * 1024 * 1024))
      throw new StorageError("Storage read exceeds byte limit", "RESOURCE_LIMIT");

    if (entry) (this.metrics as { bytesRead: number }).bytesRead += entry.data.byteLength;

    return !entry
      ? null
      : {
          data: new Uint8Array(entry.data),
          version: entry.version,
        };
  }

  public async put(key: string, data: Uint8Array, options: WriteOptions): Promise<WriteResult> {
    assertStorageKey(key);

    if (!(data instanceof Uint8Array)) throw new TypeError("Storage data must be a Uint8Array");

    (this.metrics as { writes: number; bytesWritten: number }).writes++;
    (this.metrics as { bytesWritten: number }).bytesWritten += data.byteLength;

    assertWriteCondition(options?.condition);
    const current = this.entries.get(key);

    switch (options.condition.type) {
      case "if-absent": {
        if (current)
          return {
            success: false,
            reason: "conflict",
          };

        break;
      }

      case "if-version": {
        if (!current || current.version != options.condition.version)
          return {
            success: false,
            reason: "conflict",
          };

        break;
      }
    }

    const size = data.byteLength + key.length * 2 + 96;
    const previous = current ? current.data.byteLength + key.length * 2 + 96 : 0;

    if (
      data.byteLength > (this.options.maxObjectBytes ?? 16 * 1024 * 1024) ||
      this.storedBytes - previous + size > (this.options.maxStoredBytes ?? 256 * 1024 * 1024) ||
      (!current && this.entries.size >= (this.options.maxEntries ?? 100_000))
    )
      throw new StorageError("Memory storage capacity exceeded", "RESOURCE_LIMIT");

    const version = this.nextVersion();

    this.storedBytes += size - previous;

    this.entries.set(key, {
      data: new Uint8Array(data),
      version,
      createdAt: Date.now(),
    });

    return {
      success: true,
      version,
    };
  }

  public async delete(key: string, options: DeleteOptions): Promise<DeleteResult> {
    assertStorageKey(key);

    (this.metrics as { deletes: number }).deletes++;

    assertWriteCondition(options?.condition);
    const current = this.entries.get(key);

    switch (options.condition.type) {
      case "if-absent":
        return current
          ? {
              success: false,
              reason: "conflict",
            }
          : { success: true };

      case "if-version": {
        if (!current || current.version != options.condition.version)
          return {
            success: false,
            reason: "conflict",
          };

        this.entries.delete(key);
        this.storedBytes -= current.data.byteLength + key.length * 2 + 96;

        return { success: true };
      }
    }
  }

  public async verifyExclusiveOwnership(): Promise<void> {
    /* Private, instance-owned Map; no independent storage clients. */
  }

  public async *iterate(
    prefix: string,
    options: { readonly pageSize?: number; readonly signal?: AbortSignal } = {},
  ): AsyncIterable<StorageObjectInfo> {
    if (typeof prefix != "string" || prefix.includes("\0"))
      throw new TypeError("Invalid storage prefix");

    const pageSize = options.pageSize ?? 256;

    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000)
      throw new RangeError("Invalid listing page size");

    let count = 0;

    for (const [key, entry] of this.entries) {
      options.signal?.throwIfAborted();

      if (!key.startsWith(prefix)) continue;

      yield { key, version: entry.version, createdAt: entry.createdAt };

      if (++count % pageSize == 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  public async list(prefix: string): Promise<readonly StorageObjectInfo[]> {
    if (typeof prefix != "string" || prefix.includes("\0"))
      throw new TypeError("Invalid storage prefix");

    (this.metrics as { lists: number }).lists++;

    const results: StorageObjectInfo[] = [];

    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;

      if (results.length >= 100_000)
        throw new StorageError("Legacy listing limit exceeded; use iterate()", "RESOURCE_LIMIT");

      results.push({
        key,
        version: entry.version,
        createdAt: entry.createdAt,
      });
    }

    results.sort((a, b) => a.key.localeCompare(b.key));

    return results;
  }

  public getMetrics(): Readonly<StorageDriverMetrics> {
    return { ...this.metrics };
  }

  private nextVersion(): string {
    this.versionCounter += 1n;
    return this.versionCounter.toString();
  }
}
