import { describe, expect, it, vi } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { DuraxisDatabase } from "../database/duraxis-database.js";
import { encodeQueryCursor, decodeQueryCursor, type CursorKeyring } from "../query/model/cursor.js";

const schema = { name: "items", indexes: [] };
const query = { collection: "items", limit: 1 };
const ring: CursorKeyring = { activeKeyId: "a", keys: { a: new Uint8Array(32).fill(7) } };
describe("production reliability boundaries", () => {
  it("encrypts cursor payloads and rejects tampering, wrong bindings, expiration, and unknown keys", () => {
    const cursor = encodeQueryCursor(
      "generation",
      schema,
      query,
      { id: "sensitive-id", document: {} },
      ring,
      "tenant-a",
    );
    const outer = JSON.parse(Buffer.from(cursor, "base64url").toString());
    expect(JSON.stringify(outer)).not.toContain("sensitive-id");
    expect(JSON.stringify(outer)).not.toContain("generation");
    expect(decodeQueryCursor(cursor, "generation", schema, query, ring, "tenant-a").id).toBe(
      "sensitive-id",
    );
    expect(() =>
      decodeQueryCursor(cursor, "generation", schema, query, ring, "tenant-b"),
    ).toThrow();
    expect(() =>
      decodeQueryCursor(cursor, "generation", schema, { ...query, limit: 2 }, ring, "tenant-a"),
    ).toThrow();
    expect(() =>
      decodeQueryCursor(
        cursor,
        "generation",
        schema,
        query,
        { activeKeyId: "b", keys: { b: new Uint8Array(32) } },
        "tenant-a",
      ),
    ).toThrow();
    for (const field of ["ciphertext", "tag", "nonce"]) {
      const altered = { ...outer, [field]: Buffer.alloc(12).toString("base64url") };
      expect(() =>
        decodeQueryCursor(
          Buffer.from(JSON.stringify(altered)).toString("base64url"),
          "generation",
          schema,
          query,
          ring,
          "tenant-a",
        ),
      ).toThrow();
    }
    expect(() =>
      decodeQueryCursor("x".repeat(16_385), "generation", schema, query, ring),
    ).toThrow();
    const expired = encodeQueryCursor(
      "generation",
      schema,
      query,
      { id: "id", document: {} },
      { ...ring, ttlMs: 1 },
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 100);
    expect(() => decodeQueryCursor(expired, "generation", schema, query, ring)).toThrow("expired");
    vi.restoreAllMocks();
    const rotated = { activeKeyId: "b", keys: { ...ring.keys, b: new Uint8Array(32).fill(9) } };
    expect(decodeQueryCursor(cursor, "generation", schema, query, rotated, "tenant-a").id).toBe(
      "sensitive-id",
    );
  });
  it("enforces trusted tenant context on retained handles and separates namespaces", async () => {
    const storage = new MemoryStorageDriver();
    let tenant: string | undefined = "a";
    const a = DuraxisDatabase.forTenant({ storage, tenant: "a", currentTenant: () => tenant });
    const b = DuraxisDatabase.forTenant({ storage, tenant: "b", currentTenant: () => tenant });
    await a.transaction((tx) => {
      tx.defineCollection(schema);
      tx.putDocument("items", "one", { value: "private" });
    });
    tenant = undefined;
    await expect(a.getDocument("items", "one")).rejects.toThrow("scope");
    tenant = "b";
    await expect(a.getDocument("items", "one")).rejects.toThrow("scope");
    await b.defineCollection(schema);
    expect(await b.getDocument("items", "one")).toBeNull();
    expect(() =>
      DuraxisDatabase.forTenant({ storage, tenant: "../escape", currentTenant: () => tenant }),
    ).toThrow();
    await a.close();
    await b.close();
  });
  it("coordinates maintenance across database instances and fails before deleting when mark budgets exhaust", async () => {
    const storage = new MemoryStorageDriver();
    const a = new DuraxisDatabase({ storage });
    const b = new DuraxisDatabase({ storage });
    await a.transaction((tx) => tx.put("key", new Uint8Array([1])));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reader = a.snapshot(async (snapshot) => {
      entered();
      await gate;
      expect(await snapshot.get("key")).toEqual(new Uint8Array([1]));
    });
    await started;
    await expect(
      b.collectGarbage(storage, { dryRun: false, exclusiveMaintenance: true, olderThanMs: 0 }),
    ).rejects.toThrow("active");
    release();
    await reader;
    const deletes = storage.getMetrics().deletes;
    await expect(
      b.collectGarbage(storage, {
        dryRun: false,
        exclusiveMaintenance: true,
        olderThanMs: 0,
        maxMarkBytes: 1,
      }),
    ).rejects.toThrow();
    expect(storage.getMetrics().deletes).toBe(deletes);
    expect(await a.snapshot((snapshot) => snapshot.get("key"))).toEqual(new Uint8Array([1]));
  });
  it("retains idempotency evidence through restart and history checkpoint without false negatives", async () => {
    const storage = new MemoryStorageDriver();
    const db = new DuraxisDatabase({ storage });
    let calls = 0;
    const first = await db.transactionOnce("stable-operation", (tx) => {
      calls++;
      tx.put("value", new Uint8Array([1]));
      return "result";
    });
    expect(first.applied).toBe(true);
    expect(
      (
        await db.transactionOnce("stable-operation", () => {
          calls++;
        })
      ).applied,
    ).toBe(false);
    await db.checkpointHistory();
    await db.close();
    const reopened = new DuraxisDatabase({ storage });
    expect(await reopened.resolveCommitOutcome(first.transactionId)).toBe("COMMITTED");
    expect(calls).toBe(1);
    let failedId = "";
    await expect(
      reopened.transaction((tx) => {
        failedId = tx.id;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await reopened.resolveCommitOutcome(failedId)).toBe("NOT_COMMITTED");
    await reopened.close();
    expect(await new DuraxisDatabase({ storage }).resolveCommitOutcome(failedId)).toBe("UNKNOWN");
  });
  it("rejects stale commits before persisting immutable objects", async () => {
    const storage = new MemoryStorageDriver();
    const db = new DuraxisDatabase({ storage });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stale = db.transaction(async (tx) => {
      tx.put("stale", new Uint8Array([1]));
      entered();
      await gate;
    });
    await started;
    await db.transaction((tx) => tx.put("winner", new Uint8Array([2])));
    const writes = storage.getMetrics().writes;
    release();
    await expect(stale).rejects.toThrow("conflict");
    expect(storage.getMetrics().writes).toBe(writes);
  });
});
