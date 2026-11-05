import {
  assertStorageKey,
  type StorageDriver,
  type StorageObject,
  type WriteOptions,
  type WriteResult,
  type DeleteOptions,
  type DeleteResult,
} from "@duraxis/storage";

interface MemoryEntry {
  readonly data: Uint8Array;
  readonly version: string;
}

export class MemoryStorageDriver implements StorageDriver {
  private readonly entries = new Map<string, MemoryEntry>();
  private versionCounter = 0n;

  public async get(key: string): Promise<StorageObject | null> {
    assertStorageKey(key);

    const entry = this.entries.get(key);

    return !entry
      ? null
      : {
          data: new Uint8Array(entry.data),
          version: entry.version,
        };
  }

  public async put(key: string, data: Uint8Array, options: WriteOptions): Promise<WriteResult> {
    assertStorageKey(key);

    const current = this.entries.get(key);
    const condition = options.condition;

    switch (condition.type) {
      case "if-absent": {
        if (current)
          return {
            success: false,
            reason: "conflict",
          };

        break;
      }

      case "if-version": {
        if (!current || current.version != condition.version)
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
    });

    return {
      success: true,
      version,
    };
  }

  public async delete(key: string, options: DeleteOptions): Promise<DeleteResult> {
    assertStorageKey(key);

    const current = this.entries.get(key);
    const condition = options.condition;

    switch (condition.type) {
      case "if-absent": {
        if (current)
          return {
            success: false,
            reason: "conflict",
          };

        return { success: true };
      }

      case "if-version": {
        if (!current || current.version != condition.version)
          return {
            success: false,
            reason: "conflict",
          };

        this.entries.delete(key);

        return { success: true };
      }
    }
  }

  private nextVersion(): string {
    this.versionCounter += 1n;
    return this.versionCounter.toString();
  }
}
