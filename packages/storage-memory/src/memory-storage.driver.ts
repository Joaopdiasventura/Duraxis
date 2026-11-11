import {
  assertStorageKey,
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

export class MemoryStorageDriver implements StorageDriver {
  private readonly entries = new Map<string, MemoryEntry>();
  private versionCounter = 0n;

  private readonly metrics: StorageDriverMetrics = {
    reads: 0,
    writes: 0,
    deletes: 0,
    lists: 0,
    bytesRead: 0,
    bytesWritten: 0,
    synchronizationWaitMs: 0,
  };

  public async get(key: string): Promise<StorageObject | null> {
    assertStorageKey(key);

    (this.metrics as { reads: number }).reads++;

    const entry = this.entries.get(key);

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

    const version = this.nextVersion();

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

        return { success: true };
      }
    }
  }

  public async list(prefix: string): Promise<readonly StorageObjectInfo[]> {
    if (typeof prefix != "string" || prefix.includes("\0"))
      throw new TypeError("Invalid storage prefix");

    (this.metrics as { lists: number }).lists++;

    const results: StorageObjectInfo[] = [];

    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;

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
