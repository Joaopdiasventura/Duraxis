import { describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import {
  CollectionScan,
  DuraxisDatabase,
  QueryMemoryLimitError,
  ReferenceQueryExecutor,
  PrimaryLookup,
  UniqueIndexLookup,
  SecondaryIndexRangeScan,
  SecondaryIndexScan,
  Sort,
  type QueryRow,
  type SortSpillStore,
  type LogicalQuery,
} from "../index.js";

const PEOPLE = {
  name: "people",
  fields: {
    email: { type: "string", required: true },
    age: { type: "number", required: true },
    active: { type: "boolean", required: true },
    nickname: { type: "string", nullable: true },
    created: { type: "date", required: true },
  },
  allowAdditionalFields: false,
  indexes: [
    { name: "email", unique: true, fields: [{ field: "email", order: "ASC" }] },
    { name: "age", unique: false, fields: [{ field: "age", order: "ASC" }] },
    {
      name: "age_email",
      unique: false,
      fields: [
        { field: "age", order: "DESC" },
        { field: "email", order: "ASC" },
      ],
    },
  ],
} as const;

async function fixture() {
  const storage = new MemoryStorageDriver();
  const db = new DuraxisDatabase({ storage });
  await db.defineCollection(PEOPLE);
  await db.transaction((tx) => {
    const rows = [
      ["a", "a@example.com", 20, true, null],
      ["b", "b@example.com", 20, false, "bee"],
      ["c", "c@example.com", 30, true, undefined],
      ["d", "d@example.com", 40, true, "dee"],
    ] as const;
    for (const [id, email, age, active, nickname] of rows) {
      const document: Record<string, unknown> = {
        email,
        age,
        active,
        created: new Date(`2026-01-0${age / 10}T00:00:00.000Z`),
      };
      if (nickname !== undefined) document.nickname = nickname;
      tx.putDocument("people", id, document);
    }
  });
  return { db, storage };
}

const ids = async (rows: AsyncIterable<{ id: string }>) => {
  const result: string[] = [];
  for await (const row of rows) result.push(row.id);
  return result;
};

describe("query infrastructure", () => {
  it("validates typed documents, nullability, required and absent fields", async () => {
    const { db } = await fixture();
    await expect(
      db.transaction((tx) => tx.putDocument("people", "x", { email: "x", age: 1, active: true })),
    ).rejects.toThrow("created");
    await expect(
      db.transaction((tx) =>
        tx.putDocument("people", "x", {
          email: "x",
          age: "1",
          active: true,
          created: new Date(),
        }),
      ),
    ).rejects.toThrow("age");
    await expect(
      db.transaction((tx) =>
        tx.putDocument("people", "x", {
          email: "x",
          age: 1,
          active: true,
          created: new Date(),
          nickname: null,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("matches reference and explicit indexed access with residual AND/OR/NOT/IN", async () => {
    const { db } = await fixture();
    const query: LogicalQuery = {
      collection: "people",
      where: {
        type: "and",
        predicates: [
          { type: "in", field: "age", values: [20, 30] },
          {
            type: "or",
            predicates: [
              { type: "comparison", field: "active", operator: "eq", value: true },
              { type: "not", predicate: { type: "isMissing", field: "nickname" } },
            ],
          },
        ],
      },
      orderBy: [
        { field: "age", direction: "DESC" },
        { field: "email", direction: "ASC" },
      ],
    };
    const reference = await db.transaction(async (tx) => {
      const context = tx.createQueryContext();
      try {
        return await ids(new ReferenceQueryExecutor().execute(context, query));
      } finally {
        context.close();
      }
    });
    const indexed = await ids(
      db.query(query, new SecondaryIndexRangeScan("people", "age", { gte: [20], lte: [30] })),
    );
    expect(indexed).toEqual(reference);
    expect(reference).toEqual(["c", "a", "b"]);
  });

  it("distinguishes null and missing", async () => {
    const { db } = await fixture();
    const base = { collection: "people", orderBy: [{ field: "email", direction: "ASC" }] } as const;
    expect(
      await ids(
        db.query(
          { ...base, where: { type: "isNull", field: "nickname" } },
          new CollectionScan("people"),
        ),
      ),
    ).toEqual(["a"]);
    expect(
      await ids(
        db.query(
          { ...base, where: { type: "isMissing", field: "nickname" } },
          new CollectionScan("people"),
        ),
      ),
    ).toEqual(["c"]);
  });

  it("executes primary, unique and compound equality access with projection", async () => {
    const { db } = await fixture();
    const primary = await db.queryPage(
      { collection: "people", projection: ["email"] },
      new PrimaryLookup("people", "a"),
    );
    expect(primary.rows).toEqual([{ id: "a", document: { email: "a@example.com" } }]);
    expect(
      await ids(
        db.query(
          { collection: "people" },
          new UniqueIndexLookup("people", "email", ["c@example.com"]),
        ),
      ),
    ).toEqual(["c"]);
    expect(
      await ids(
        db.query(
          { collection: "people" },
          new SecondaryIndexRangeScan("people", "age_email", {
            prefix: [20, "b@example.com"],
          }),
        ),
      ),
    ).toEqual(["b"]);
  });

  it("applies residual filters before limit", async () => {
    const { db } = await fixture();
    const query: LogicalQuery = {
      collection: "people",
      where: { type: "comparison", field: "active", operator: "eq", value: true },
      orderBy: [{ field: "age", direction: "ASC" }],
      limit: 2,
    };
    expect(await ids(db.query(query, new SecondaryIndexScan("people", "age")))).toEqual(["a", "c"]);
  });

  it("provides read-your-writes for indexed queries from a fixed pending-write capture", async () => {
    const { db } = await fixture();
    await db.transaction(async (tx) => {
      tx.putDocument("people", "a", {
        email: "a@example.com",
        age: 99,
        active: true,
        created: new Date("2026-01-01T00:00:00.000Z"),
      });
      tx.deleteDocument("people", "b");
      tx.putDocument("people", "e", {
        email: "e@example.com",
        age: 20,
        active: true,
        created: new Date("2026-01-01T00:00:00.000Z"),
      });
      const query: LogicalQuery = {
        collection: "people",
        where: { type: "comparison", field: "age", operator: "eq", value: 20 },
        orderBy: [{ field: "email", direction: "ASC" }],
      };
      const iterable = tx.query(
        query,
        new SecondaryIndexRangeScan("people", "age", { prefix: [20] }),
      );
      tx.putDocument("people", "f", {
        email: "f@example.com",
        age: 20,
        active: true,
        created: new Date("2026-01-01T00:00:00.000Z"),
      });
      expect(await ids(iterable)).toEqual(["e"]);
    });
  });

  it("paginates deterministically and rejects a cursor on another generation", async () => {
    const { db } = await fixture();
    const query: LogicalQuery = {
      collection: "people",
      orderBy: [{ field: "age", direction: "ASC" }],
      limit: 2,
    };
    const first = await db.queryPage(query, new CollectionScan("people"));
    expect(first.rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await db.queryPage(
      { ...query, cursor: first.nextCursor! },
      new CollectionScan("people"),
    );
    expect(second.rows.map((row) => row.id)).toEqual(["c", "d"]);
    await db.transaction((tx) => tx.deleteDocument("people", "d"));
    await expect(
      db.queryPage({ ...query, cursor: first.nextCursor! }, new CollectionScan("people")),
    ).rejects.toThrow("generation");
  });

  it("supports transactional index removal and rebuild", async () => {
    const { db } = await fixture();
    await db.removeIndex("people", "age");
    await expect(
      ids(db.query({ collection: "people" }, new SecondaryIndexScan("people", "age"))),
    ).rejects.toThrow("Index is not available");
    await db.addIndex("people", {
      name: "age",
      unique: false,
      fields: [{ field: "age", order: "DESC" }],
    });
    expect(
      await ids(db.query({ collection: "people" }, new SecondaryIndexScan("people", "age"))),
    ).toEqual(["d", "c", "a", "b"]);
  });

  it("bounds sort memory and closes cancelled contexts", async () => {
    const { db } = await fixture();
    await expect(
      db.transaction(async (tx) => {
        const context = tx.createQueryContext();
        const sort = new Sort(
          new CollectionScan("people"),
          "people",
          [{ field: "age", direction: "ASC" }],
          { maxRowsInMemory: 2 },
        );
        await expect(ids(sort.execute(context))).rejects.toBeInstanceOf(QueryMemoryLimitError);
        const runs = new Map<string, QueryRow[]>();
        let sequence = 0;
        const spill: SortSpillStore = {
          async write(rows) {
            const stored: QueryRow[] = [];
            if (Symbol.asyncIterator in Object(rows)) {
              for await (const row of rows as AsyncIterable<QueryRow>) stored.push(row);
            } else stored.push(...(rows as readonly QueryRow[]));
            const handle = String(sequence++);
            runs.set(handle, stored);
            return handle;
          },
          async *read(handle) {
            yield* runs.get(handle)!;
          },
          async delete(handle) {
            runs.delete(handle);
          },
        };
        const spilling = new Sort(
          new CollectionScan("people"),
          "people",
          [{ field: "age", direction: "ASC" }],
          { maxRowsInMemory: 2, spill },
        );
        expect(await ids(spilling.execute(context))).toEqual(["a", "b", "c", "d"]);
        expect(runs.size).toBe(0);
        context.cancel();
        await expect(ids(context.scanCollection("people"))).rejects.toThrow("cancelled");
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates storage failures and releases database-owned query snapshots", async () => {
    class FailingReads extends MemoryStorageDriver {
      public failNodes = false;
      override async get(key: string) {
        if (this.failNodes && key.includes("/indexes/nodes/"))
          throw new Error("simulated node read failure");
        return super.get(key);
      }
    }
    const storage = new FailingReads();
    const db = new DuraxisDatabase({ storage });
    await db.defineCollection(PEOPLE);
    await db.transaction((tx) =>
      tx.putDocument("people", "a", {
        email: "a@example.com",
        age: 20,
        active: true,
        created: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    storage.failNodes = true;
    await expect(
      ids(db.query({ collection: "people" }, new SecondaryIndexScan("people", "age"))),
    ).rejects.toThrow("simulated node read failure");
    storage.failNodes = false;
    await expect(
      db.collectGarbage(storage, { dryRun: false, exclusiveMaintenance: true, olderThanMs: 0 }),
    ).resolves.toMatchObject({ dryRun: false });
  });

  it("keeps GC from deleting while a query iterator owns a snapshot", async () => {
    const { db, storage } = await fixture();
    const iterator = db
      .query({ collection: "people" }, new CollectionScan("people"))
      [Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await expect(
      db.collectGarbage(storage, {
        dryRun: false,
        exclusiveMaintenance: true,
        olderThanMs: 0,
      }),
    ).rejects.toThrow("Active transactions");
    await iterator.return?.();
    await expect(
      db.collectGarbage(storage, {
        dryRun: false,
        exclusiveMaintenance: true,
        olderThanMs: 0,
      }),
    ).resolves.toMatchObject({ dryRun: false });
  });

  it("keeps a stable query snapshot across concurrent commits", async () => {
    const { db } = await fixture();
    let release!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = db.transaction(async (tx) => {
      const context = tx.createQueryContext();
      ready();
      await wait;
      try {
        return await ids(
          new ReferenceQueryExecutor().execute(context, {
            collection: "people",
            orderBy: [{ field: "email", direction: "ASC" }],
          }),
        );
      } finally {
        context.close();
      }
    });
    await started;
    await db.transaction((tx) =>
      tx.putDocument("people", "e", {
        email: "e@example.com",
        age: 50,
        active: true,
        created: new Date("2026-01-05T00:00:00.000Z"),
      }),
    );
    release();
    expect(await reader).toEqual(["a", "b", "c", "d"]);
  });
});
