import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { readdir } from "node:fs/promises";
import { DuraxisDatabase } from "../../packages/core/dist/index.js";
import { MemoryStorageDriver } from "../../packages/storage-memory/dist/index.js";
const iterations = Number(process.argv[2] ?? 500);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100_000)
  throw new Error("Iterations must be between 1 and 100000");
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const storage = new MemoryStorageDriver();
const database = new DuraxisDatabase({ storage });
const before = process.memoryUsage();
try {
  await database.defineCollection({
    name: "items",
    fields: { value: { type: "number" } },
    indexes: [{ name: "value", field: "value", unique: false }],
  });
  for (let i = 0; i < iterations; i++) {
    await database.transaction((tx) => tx.putDocument("items", String(i % 25), { value: i }));
    if (i % 7 == 0)
      await database
        .transaction((tx) => {
          tx.putDocument("items", "rollback", { value: -1 });
          throw new Error("expected rollback");
        })
        .catch((error) => {
          assert.equal(error.message, "expected rollback");
        });
    const iterator = database.query({ collection: "items" })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return();
    if (i % 25 == 0) await new Promise((resolve) => setImmediate(resolve));
    if (i % 50 == 0)
      await database.collectGarbage(storage, {
        dryRun: false,
        exclusiveMaintenance: true,
        olderThanMs: 0,
      });
    assert.equal(database.getMetrics().resources.current.workingBytes, 0);
    assert.equal(database.getMetrics().resources.current.snapshots, 0);
  }
  await database.verifyIntegrity();
  const metrics = database.getMetrics();
  await database.close();
  let descriptors = null;
  if (process.platform === "linux") descriptors = (await readdir("/proc/self/fd")).length;
  console.log(
    JSON.stringify(
      {
        iterations,
        before,
        after: process.memoryUsage(),
        resources: metrics.resources,
        storage: storage.getMetrics(),
        openFileDescriptors: descriptors,
        eventLoopDelayMs: {
          mean: Number.isFinite(delay.mean) ? delay.mean / 1e6 : null,
          max: delay.max / 1e6,
        },
      },
      null,
      2,
    ),
  );
} finally {
  delay.disable();
  await database.close();
}
