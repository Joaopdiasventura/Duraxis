import { describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { DuraxisDatabase } from "../database/duraxis-database.js";

describe("production maintenance contracts", () => {
  it("checkpoints commit history and collects unreachable commit records", async () => {
    const storage = new MemoryStorageDriver();
    const db = new DuraxisDatabase({ storage });
    await db.transaction((tx) => tx.put("a", new TextEncoder().encode("1")));
    await db.transaction((tx) => tx.put("b", new TextEncoder().encode("2")));
    expect(await db.verifyHistory()).toBe(2);
    await db.checkpointHistory();
    expect(await db.verifyHistory()).toBe(1);
    const dryRun = await db.collectGarbage(storage, { dryRun: true, olderThanMs: 0, batchSize: 1 });
    expect(dryRun.commitsScanned).toBeGreaterThanOrEqual(3);
    expect(dryRun.candidates).toBeGreaterThanOrEqual(2);
    const collected = await db.collectGarbage(storage, {
      dryRun: false,
      exclusiveMaintenance: true,
      olderThanMs: 0,
      batchSize: 1,
    });
    expect(collected.deleted).toBeGreaterThanOrEqual(2);
    expect(collected.failed).toBe(0);
    expect(await db.verifyHistory()).toBe(1);
  });

  it("exposes bounded metrics and explicit database lifecycle", async () => {
    const storage = new MemoryStorageDriver();
    const db = new DuraxisDatabase({ storage });
    await db.transaction((tx) => tx.put("key", new Uint8Array([1, 2, 3])));
    const metrics = db.getMetrics();
    expect(metrics.transactionsStarted).toBe(1);
    expect(metrics.transactionsCommitted).toBe(1);
    expect(metrics.storage?.writes).toBeGreaterThan(0);
    await db.close();
    await expect(db.transaction((tx) => tx.get("key"))).rejects.toThrow("closed");
  });

  it("supports cancellable incremental GC", async () => {
    const storage = new MemoryStorageDriver();
    const db = new DuraxisDatabase({ storage });
    await db.transaction((tx) => tx.put("key", new Uint8Array([1])));
    const controller = new AbortController();
    controller.abort(new Error("stop gc"));
    await expect(
      db.collectGarbage(storage, { dryRun: true, signal: controller.signal }),
    ).rejects.toThrow("stop gc");
  });
});
