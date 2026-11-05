import { describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import type { StorageDriver, WriteOptions, WriteResult } from "@duraxis/storage";

import { DuraxisDatabase } from "../database/duraxis-database.js";
import { TransactionConflictError } from "../errors/transaction-conflict.error.js";
import { MANIFEST_KEY } from "../commit/manifest.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encode = (value: string) => encoder.encode(value);
const decode = (value: Uint8Array | null) => (value == null ? null : decoder.decode(value));

function createDatabase() {
  const storage = new MemoryStorageDriver();
  return {
    storage,
    db: new DuraxisDatabase({ storage }),
  };
}

describe("DuraxisDatabase", () => {
  it("commits multiple objects together", async () => {
    const { db } = createDatabase();

    await db.transaction((tx) => {
      tx.put("a", encode("100"));
      tx.put("b", encode("200"));
    });

    await db.transaction(async (tx) => {
      expect(decode(await tx.get("a"))).toBe("100");
      expect(decode(await tx.get("b"))).toBe("200");
    });
  });

  it("discards changes when the callback throws", async () => {
    const { db } = createDatabase();

    await expect(
      db.transaction((tx) => {
        tx.put("a", encode("100"));
        tx.put("b", encode("200"));
        throw new Error("Business failure");
      }),
    ).rejects.toThrow("Business failure");

    await db.transaction(async (tx) => {
      expect(await tx.get("a")).toBeNull();
      expect(await tx.get("b")).toBeNull();
    });
  });

  it("supports read-your-writes", async () => {
    const { db } = createDatabase();

    await db.transaction(async (tx) => {
      tx.put("a", encode("initial"));

      expect(decode(await tx.get("a"))).toBe("initial");

      tx.put("a", encode("updated"));

      expect(decode(await tx.get("a"))).toBe("updated");

      tx.delete("a");

      expect(await tx.get("a")).toBeNull();
    });
  });

  it("preserves an existing snapshot", async () => {
    const { db } = createDatabase();

    await db.transaction((tx) => {
      tx.put("a", encode("old-a"));
      tx.put("b", encode("old-b"));
    });

    let release!: () => void;
    let signalStarted!: () => void;

    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    const reader = db.transaction(async (tx) => {
      expect(decode(await tx.get("a"))).toBe("old-a");

      signalStarted();
      await wait;

      expect(decode(await tx.get("b"))).toBe("old-b");
    });

    await started;

    await db.transaction((tx) => {
      tx.put("a", encode("new-a"));
      tx.put("b", encode("new-b"));
    });

    release();
    await reader;
  });

  it("aborts one conflicting transaction", async () => {
    const { db } = createDatabase();

    await db.transaction((tx) => {
      tx.put("counter", encode("0"));
    });

    let arrived = 0;
    let release!: () => void;

    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const increment = () =>
      db.transaction(async (tx) => {
        const current = Number(decode(await tx.get("counter")));

        arrived++;

        if (arrived == 2) release();

        await barrier;

        tx.put("counter", encode(String(current + 1)));
      });

    const results = await Promise.allSettled([increment(), increment()]);

    expect(results.filter((r) => r.status == "fulfilled")).toHaveLength(1);

    const rejected = results.find((r) => r.status == "rejected");

    expect(rejected?.status).toBe("rejected");

    if (rejected?.status == "rejected")
      expect(rejected.reason).toBeInstanceOf(TransactionConflictError);

    await db.transaction(async (tx) => {
      expect(decode(await tx.get("counter"))).toBe("1");
    });
  });

  it("works across database instances sharing storage", async () => {
    const storage = new MemoryStorageDriver();

    const first = new DuraxisDatabase({ storage });
    const second = new DuraxisDatabase({ storage });

    await first.transaction((tx) => {
      tx.put("shared", encode("hello"));
    });

    await second.transaction(async (tx) => {
      expect(decode(await tx.get("shared"))).toBe("hello");
    });
  });

  it("does not publish data if manifest creation fails", async () => {
    class FailingStorage extends MemoryStorageDriver {
      override async put(
        key: string,
        data: Uint8Array,
        options: WriteOptions,
      ): Promise<WriteResult> {
        if (key == MANIFEST_KEY) throw new Error("Simulated manifest failure");
        return super.put(key, data, options);
      }
    }

    const storage: StorageDriver = new FailingStorage();
    const db = new DuraxisDatabase({ storage });

    await expect(
      db.transaction((tx) => {
        tx.put("a", encode("value-a"));
        tx.put("b", encode("value-b"));
      }),
    ).rejects.toThrow("Simulated manifest failure");

    await db.transaction(async (tx) => {
      expect(await tx.get("a")).toBeNull();
      expect(await tx.get("b")).toBeNull();
    });
  });

  it("prevents transaction use after completion", async () => {
    const { db } = createDatabase();

    let captured: Parameters<Parameters<typeof db.transaction>[0]>[0] | undefined;

    await db.transaction((tx) => {
      captured = tx;
    });

    expect(() => captured!.put("late", encode("value"))).toThrow("Transaction is no longer active");
  });
});
