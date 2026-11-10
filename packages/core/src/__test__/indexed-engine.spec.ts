import { describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";

import { DuraxisDatabase } from "../database/duraxis-database.js";
import { TransactionConflictError } from "../errors/transaction-conflict.error.js";
import { UniqueIndexViolationError } from "../indexes/secondary/secondary-index-manager.js";

const USERS = {
  name: "users",
  indexes: [
    {
      name: "email",
      field: "email",
      unique: true,
    },
    {
      name: "age",
      field: "age",
      unique: false,
    },
  ],
} as const;

function fixture() {
  const storage = new MemoryStorageDriver();

  return {
    storage,
    db: new DuraxisDatabase({ storage }),
  };
}

describe("Indexed engine", () => {
  it("persists records and maintains secondary indexes", async () => {
    const { db } = fixture();

    await db.defineCollection(USERS);

    await db.transaction((tx) => {
      tx.putDocument("users", "1", {
        email: "a@example.com",
        age: 25,
      });

      tx.putDocument("users", "2", {
        email: "b@example.com",
        age: 25,
      });
    });

    expect((await db.findByIndex("users", "age", 25)).map((row) => row.id)).toEqual(["1", "2"]);

    expect((await db.findByIndex("users", "email", "a@example.com"))[0]?.id).toBe("1");

    expect((await db.getDocument("users", "2"))?.age).toBe(25);
  });

  it("updates index entries with the document", async () => {
    const { db } = fixture();

    await db.defineCollection(USERS);

    await db.transaction((tx) => {
      tx.putDocument("users", "1", {
        email: "old@example.com",
        age: 20,
      });
    });

    await db.transaction((tx) => {
      tx.putDocument("users", "1", {
        email: "new@example.com",
        age: 30,
      });
    });

    expect(await db.findByIndex("users", "email", "old@example.com")).toEqual([]);

    expect((await db.findByIndex("users", "age", 30))[0]?.id).toBe("1");

    expect(await db.findByIndex("users", "age", 20)).toEqual([]);
  });

  it("deletes records and their index entries atomically", async () => {
    const { db } = fixture();

    await db.defineCollection(USERS);

    await db.transaction((tx) => {
      tx.putDocument("users", "1", {
        email: "a@example.com",
        age: 20,
      });
    });

    await db.transaction((tx) => {
      tx.deleteDocument("users", "1");
    });

    expect(await db.getDocument("users", "1")).toBeNull();

    expect(await db.findByIndex("users", "age", 20)).toEqual([]);

    expect(await db.findByIndex("users", "email", "a@example.com")).toEqual([]);
  });

  it("rejects duplicate unique keys without publishing", async () => {
    const { db } = fixture();

    await db.defineCollection(USERS);

    await db.transaction((tx) => {
      tx.putDocument("users", "1", {
        email: "same@example.com",
      });
    });

    await expect(
      db.transaction((tx) => {
        tx.putDocument("users", "2", {
          email: "same@example.com",
        });
      }),
    ).rejects.toBeInstanceOf(UniqueIndexViolationError);

    expect(await db.getDocument("users", "2")).toBeNull();

    expect(
      (await db.findByIndex("users", "email", "same@example.com")).map((row) => row.id),
    ).toEqual(["1"]);
  });

  it("allows exchanging unique keys in one transaction", async () => {
    const { db } = fixture();

    await db.defineCollection(USERS);

    await db.transaction((tx) => {
      tx.putDocument("users", "1", {
        email: "a@example.com",
      });
      tx.putDocument("users", "2", {
        email: "b@example.com",
      });
    });

    await db.transaction((tx) => {
      tx.putDocument("users", "1", {
        email: "b@example.com",
      });
      tx.putDocument("users", "2", {
        email: "a@example.com",
      });
    });

    expect((await db.findByIndex("users", "email", "a@example.com"))[0]?.id).toBe("2");
  });

  it("builds new indexes from existing records", async () => {
    const { db } = fixture();

    await db.defineCollection({
      name: "products",
      indexes: [],
    });

    await db.transaction((tx) => {
      tx.putDocument("products", "1", {
        category: "hardware",
      });

      tx.putDocument("products", "2", {
        category: "hardware",
      });
    });

    await db.addIndex("products", {
      name: "category",
      field: "category",
      unique: false,
    });

    expect((await db.findByIndex("products", "category", "hardware")).map((row) => row.id)).toEqual(
      ["1", "2"],
    );
  });

  it("rejects competing commits on the same snapshot", async () => {
    const { db } = fixture();

    await db.defineCollection(USERS);

    let arrived = 0;
    let release!: () => void;

    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const insert = (id: string) =>
      db.transaction(async (tx) => {
        tx.putDocument("users", id, {
          email: "same@example.com",
        });

        arrived++;

        if (arrived === 2) release();

        await barrier;
      });

    const results = await Promise.allSettled([insert("1"), insert("2")]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const rejected = results.find((r) => r.status === "rejected");

    expect(rejected?.status).toBe("rejected");

    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(TransactionConflictError);
    }

    expect(await db.scanCollection("users")).toHaveLength(1);
  });

  it("can reopen an indexed database using the same storage", async () => {
    const { db, storage } = fixture();

    await db.defineCollection(USERS);

    await db.transaction((tx) => {
      tx.putDocument("users", "1", {
        email: "a@example.com",
        age: 25,
      });
    });

    const reopened = new DuraxisDatabase({ storage });

    expect((await reopened.getDocument("users", "1"))?.age).toBe(25);

    expect((await reopened.findByIndex("users", "age", 25))[0]?.id).toBe("1");

    const integrity = await reopened.verifyIntegrity();

    expect(integrity.objects).toBeGreaterThan(0);
    expect(integrity.nodes).toBeGreaterThan(0);
    expect(integrity.indexes).toBe(2);
  });

  it("keeps current references reachable for GC", async () => {
    const { db, storage } = fixture();

    await db.defineCollection(USERS);

    await db.transaction((tx) => {
      tx.putDocument("users", "1", {
        email: "a@example.com",
      });
    });

    const report = await db.collectGarbage(storage, {
      dryRun: true,
      olderThanMs: 0,
    });

    expect(report.nodesScanned).toBeGreaterThan(0);
    expect(report.deleted).toBe(0);
    expect(report.reachable).toBeGreaterThan(0);
  });
});
