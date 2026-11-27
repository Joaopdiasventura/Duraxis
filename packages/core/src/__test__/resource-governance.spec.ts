import { OperationOwner } from "../resources/operation-owner.js";
import { describe, expect, it, vi } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { DuraxisDatabase } from "../database/duraxis-database.js";
import { ResourceScope, ResourceExhaustedError } from "../resources/resource-manager.js";

describe("hierarchical resource governance", () => {
  it("atomically resizes reservations, shares parent limits and releases idempotently", () => {
    const parent = new ResourceScope({ workingBytes: 10 });
    const a = parent.child({});
    const b = parent.child({});
    const lease = a.reserve({ workingBytes: 6 });
    expect(() => b.reserve({ workingBytes: 5 })).toThrow(ResourceExhaustedError);
    expect(parent.metrics().current.workingBytes).toBe(6);
    expect(() => lease.resize({ workingBytes: 11 })).toThrow(ResourceExhaustedError);
    expect(parent.metrics().current.workingBytes).toBe(6);
    lease.resize({ workingBytes: 2 });
    b.reserve({ workingBytes: 8 });
    a.close();
    lease.release();
    a.close();
    b.close();
    expect(parent.metrics().current.workingBytes).toBe(0);
    expect(parent.metrics().highWater.workingBytes).toBe(10);
  });
  it("preserves accounting against a seeded reference model", () => {
    const scope = new ResourceScope({ workingBytes: 1000 });
    const leases = Array.from({ length: 16 }, () => scope.reserve({}));
    const values = new Array<number>(16).fill(0);
    let seed = 0x5eed;
    for (let step = 0; step < 2000; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const index = seed % values.length;
      const next = (seed >>> 8) % 150;
      const total = values.reduce((a, b) => a + b, 0) - values[index]! + next;
      if (total > 1000)
        expect(() => leases[index]!.resize({ workingBytes: next })).toThrow(ResourceExhaustedError);
      else {
        leases[index]!.resize({ workingBytes: next });
        values[index] = next;
      }
      expect(scope.metrics().current.workingBytes ?? 0).toBe(values.reduce((a, b) => a + b, 0));
    }
    scope.close();
    for (const lease of leases) lease.release();
    expect(scope.metrics().current.workingBytes).toBe(0);
  });
  it("keeps cancelled uninterruptible storage work protected until it settles", async () => {
    const scope = new ResourceScope({ workingBytes: 1024 });
    const storage = new MemoryStorageDriver();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    storage.get = async () => {
      entered();
      await gate;
      return null;
    };
    let disposed = 0;
    const owner = new OperationOwner(
      scope,
      storage,
      10000,
      () => {
        disposed++;
      },
      128,
    );
    const read = owner.storage.get("key");
    const rejected = expect(read).rejects.toThrow();
    await started;
    owner.cancel();
    expect(disposed).toBe(0);
    expect(owner.pendingOperations).toBe(1);
    expect(scope.metrics().current.pendingOperations).toBe(1);
    release();
    await rejected;
    expect(disposed).toBe(1);
    expect(scope.metrics().current.workingBytes).toBe(0);
    owner.finish();
    owner.cancel();
    expect(disposed).toBe(1);
  });
  it("bounds materialization while allowing streaming beyond the result budget", async () => {
    const db = new DuraxisDatabase({
      storage: new MemoryStorageDriver(),
      resources: { maxResultRows: 2 },
    });
    await db.transaction((tx) => {
      tx.defineCollection({ name: "items", indexes: [] });
      for (let i = 0; i < 5; i++) tx.putDocument("items", String(i), { value: i });
    });
    await expect(db.queryAll({ collection: "items" })).rejects.toThrow(ResourceExhaustedError);
    let rows = 0;
    for await (const row of db.query({ collection: "items" })) {
      expect(row).toHaveProperty("id");
      rows++;
    }
    expect(rows).toBe(5);
    expect(db.getMetrics().resources.current.workingBytes).toBe(0);
    await db.close();
  });
  it("bounds serialized pending bytes and replacement count without losing earlier writes", async () => {
    const db = new DuraxisDatabase({
      storage: new MemoryStorageDriver(),
      resources: { maxPendingWrites: 1, maxPendingWriteBytes: 8 },
    });
    await db.transaction((tx) => {
      tx.put("one", new Uint8Array(8));
      tx.put("one", new Uint8Array(4));
      expect(() => tx.put("two", new Uint8Array(1))).toThrow(ResourceExhaustedError);
      expect(() => tx.put("one", new Uint8Array(9))).toThrow(ResourceExhaustedError);
    });
    expect(await db.snapshot((reader) => reader.get("one"))).toHaveLength(4);
    expect(db.getMetrics().resources.current.workingBytes).toBe(0);
  });
  it("rejects large documents and excessive object depth before staging", async () => {
    const db = new DuraxisDatabase({
      storage: new MemoryStorageDriver(),
      resources: { maxDocumentBytes: 128, maxDocumentDepth: 2 },
    });
    await db.defineCollection({ name: "items", indexes: [] });
    await expect(
      db.transaction((tx) => tx.putDocument("items", "large", { text: "x".repeat(1024) })),
    ).rejects.toThrow(ResourceExhaustedError);
    await expect(
      db.transaction((tx) => tx.putDocument("items", "deep", { a: { b: { c: true } } })),
    ).rejects.toThrow(ResourceExhaustedError);
    expect(await db.scanCollection("items")).toEqual([]);
  });
  it("expires an abandoned query and a callback that never settles", async () => {
    const db = new DuraxisDatabase({
      storage: new MemoryStorageDriver(),
      resources: { maxSnapshotLifetimeMs: 100 },
    });
    await db.transaction((tx) => {
      tx.defineCollection({ name: "items", indexes: [] });
      tx.putDocument("items", "1", {});
    });
    vi.useFakeTimers();
    const iterator = db.query({ collection: "items" })[Symbol.asyncIterator]();
    await iterator.next();
    await vi.advanceTimersByTimeAsync(101);
    expect(db.getMetrics().resources.current.snapshots).toBe(0);
    // This transaction's timer is installed under the fake clock.
    const pending = db.transaction(async () => {
      await new Promise(() => {});
    });
    const rejection = expect(pending).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    vi.useRealTimers();
    await iterator.return?.();
    await db.close();
    expect(db.getMetrics().resources.current.snapshots).toBe(0);
  });
});
