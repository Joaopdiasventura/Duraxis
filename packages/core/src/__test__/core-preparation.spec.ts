import { describe, expect, it } from "vitest";

import { MemoryStorageDriver } from "@duraxis/storage-memory";

import { DuraxisDatabase } from "../database/duraxis-database.js";

import { decodeManifest, MANIFEST_KEY } from "../commit/manifest.js";

import { ManifestSnapshotReader } from "../snapshots/snapshot-reader.js";

import { ManifestReachabilityScanner } from "../gc/reachability-scanner.js";

import { StorageKeyManager } from "../security/storage-key-manager.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encode = (value: string) => encoder.encode(value);

const decode = (value: Uint8Array | null) => (value === null ? null : decoder.decode(value));

describe("Core preparation", () => {
  it("reads committed data through SnapshotReader", async () => {
    const storage = new MemoryStorageDriver();
    const keys = new StorageKeyManager();

    const database = new DuraxisDatabase({ storage });

    await database.transaction((tx) => {
      tx.put("users/1", encode("Joao"));
    });

    const stored = await storage.get(MANIFEST_KEY);

    const snapshot = {
      manifest: decodeManifest(stored!.data, keys),
      storageVersion: stored!.version,
    };

    const reader = new ManifestSnapshotReader(storage, snapshot, keys);

    expect(decode(await reader.get("users/1"))).toBe("Joao");

    expect(await reader.get("missing")).toBeNull();
  });

  it("preserves old snapshots after newer commits", async () => {
    const storage = new MemoryStorageDriver();
    const database = new DuraxisDatabase({ storage });

    await database.transaction((tx) => {
      tx.put("counter", encode("1"));
    });

    let release!: () => void;
    let ready!: () => void;

    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    const reader = database.snapshot(async (snapshot) => {
      expect(decode(await snapshot.get("counter"))).toBe("1");

      ready();

      await wait;

      expect(decode(await snapshot.get("counter"))).toBe("1");
    });

    await started;

    await database.transaction((tx) => {
      tx.put("counter", encode("2"));
    });

    release();

    await reader;

    await database.snapshot(async (snapshot) => {
      expect(decode(await snapshot.get("counter"))).toBe("2");
    });
  });

  it("collects physical references from a manifest", async () => {
    const storage = new MemoryStorageDriver();
    const keys = new StorageKeyManager();

    const database = new DuraxisDatabase({ storage });

    await database.transaction((tx) => {
      tx.put("users/1", encode("Joao"));
      tx.put("users/2", encode("Maria"));
    });

    const stored = await storage.get(MANIFEST_KEY);

    const snapshot = {
      manifest: decodeManifest(stored!.data, keys),
      storageVersion: stored!.version,
    };

    const scanner = new ManifestReachabilityScanner(keys);

    const reachable = await scanner.scan(snapshot);

    expect(reachable.size).toBe(2);

    for (const key of snapshot.manifest.entries.values()) {
      expect(reachable.has(key)).toBe(true);
    }
  });

  it("does not delete reachable objects", async () => {
    const storage = new MemoryStorageDriver();
    const database = new DuraxisDatabase({ storage });

    await database.transaction((tx) => {
      tx.put("users/1", encode("Joao"));
    });

    const report = await database.collectGarbage(storage, {
      dryRun: true,
      olderThanMs: 0,
    });

    expect(report.scanned).toBe(1);
    expect(report.candidates).toBe(0);
    expect(report.deleted).toBe(0);
  });

  it("rejects destructive GC with an active snapshot", async () => {
    const storage = new MemoryStorageDriver();
    const database = new DuraxisDatabase({ storage });

    await database.transaction((tx) => {
      tx.put("key", encode("value"));
    });

    let signal!: () => void;
    let release!: () => void;

    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });

    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    const reader = database.snapshot(async (snapshot) => {
      signal();
      await wait;

      expect(decode(await snapshot.get("key"))).toBe("value");
    });

    await started;

    await expect(
      database.collectGarbage(storage, {
        dryRun: false,
        exclusiveMaintenance: true,
        olderThanMs: 0,
      }),
    ).rejects.toThrow("Active transactions");

    release();
    await reader;
  });

  it("rejects transactions started during maintenance", async () => {
    class DeferredStorage extends MemoryStorageDriver {
      private releaseList?: () => void;
      private signalList?: () => void;

      readonly listStarted = new Promise<void>((resolve) => {
        this.signalList = resolve;
      });

      release(): void {
        this.releaseList?.();
      }

      override async list(prefix: string) {
        this.signalList?.();

        await new Promise<void>((resolve) => {
          this.releaseList = resolve;
        });

        return super.list(prefix);
      }
    }

    const storage = new DeferredStorage();
    const database = new DuraxisDatabase({ storage });

    const gc = database.collectGarbage(storage, {
      dryRun: true,
    });

    await storage.listStarted;

    await expect(database.transaction((tx) => tx.get("missing"))).rejects.toThrow(
      "maintenance mode",
    );

    storage.release();

    await gc;
  });

  it("rejects corrupted referenced objects", async () => {
    const storage = new MemoryStorageDriver();
    const database = new DuraxisDatabase({ storage });

    await database.transaction((tx) => {
      tx.put("key", encode("original"));
    });

    const manifest = await storage.get(MANIFEST_KEY);

    const physicalKey = decodeManifest(manifest!.data).entries.get("key")!;

    const stored = await storage.get(physicalKey);

    await storage.put(physicalKey, encode("corrupted"), {
      condition: {
        type: "if-version",
        version: stored!.version,
      },
    });

    await expect(database.snapshot((reader) => reader.get("key"))).rejects.toThrow(
      "integrity check failed",
    );
  });
});
