import { describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import {
  CollectionScan,
  DuraxisDatabase,
  ReferenceQueryExecutor,
  RuleBasedPlanner,
  type LogicalQuery,
  type QueryRow,
} from "../index.js";

const ITEMS = {
  name: "items",
  fields: {
    sku: { type: "string", required: true },
    category: { type: "string", required: true },
    price: { type: "number", required: true },
    active: { type: "boolean", required: true },
    note: { type: "string", nullable: true },
  },
  allowAdditionalFields: false,
  indexes: [
    { name: "sku", unique: true, fields: [{ field: "sku", order: "ASC" }] },
    { name: "category", unique: false, fields: [{ field: "category", order: "ASC" }] },
    { name: "active", unique: false, fields: [{ field: "active", order: "ASC" }] },
    { name: "note", unique: false, fields: [{ field: "note", order: "ASC" }] },
    {
      name: "category_price",
      unique: false,
      fields: [
        { field: "category", order: "ASC" },
        { field: "price", order: "DESC" },
      ],
    },
    { name: "price_desc", unique: false, fields: [{ field: "price", order: "DESC" }] },
  ],
} as const;

async function fixture(count = 120) {
  const storage = new MemoryStorageDriver();
  const db = new DuraxisDatabase({
    storage,
    cursorSigningKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
  });
  await db.defineCollection(ITEMS);
  let state = 0x51f15e;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  await db.transaction((tx) => {
    for (let i = 0; i < count; i++) {
      const document: Record<string, unknown> = {
        sku: `SKU-${String(i).padStart(4, "0")}`,
        category: ["books", "hardware", "music"][random() % 3],
        price: random() % 100,
        active: (random() & 1) == 0,
      };
      if (i % 7 == 0) document.note = null;
      else if (i % 5 != 0) document.note = `note-${i % 4}`;
      tx.putDocument("items", `id-${String(i).padStart(4, "0")}`, document);
    }
  });
  return { db, storage };
}

async function collect(iterable: AsyncIterable<QueryRow>): Promise<QueryRow[]> {
  const rows: QueryRow[] = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

async function differential(db: DuraxisDatabase, query: LogicalQuery) {
  const planned = await collect(db.query(query));
  const reference = await db.transaction(async (tx) => {
    const context = tx.createQueryContext();
    try {
      return await collect(new ReferenceQueryExecutor().execute(context, query));
    } finally {
      context.close();
    }
  });
  expect(planned).toEqual(reference);
  return planned;
}

describe("RuleBasedPlanner", () => {
  it("chooses primary and unique lookups from equality evidence", async () => {
    const { db } = await fixture(20);
    const primary: LogicalQuery = {
      collection: "items",
      where: { type: "comparison", field: "$id", operator: "eq", value: "id-0003" },
    };
    expect((await db.explain(primary)).plan.access.type).toBe("primary-lookup");
    expect((await differential(db, primary)).map((row) => row.id)).toEqual(["id-0003"]);

    const unique: LogicalQuery = {
      collection: "items",
      where: { type: "comparison", field: "sku", operator: "eq", value: "SKU-0007" },
    };
    const explanation = await db.explain(unique);
    expect(explanation.plan.access.type).toBe("unique-index-lookup");
    expect(explanation.selectedIndexes).toEqual(["sku"]);
    expect((await differential(db, unique)).map((row) => row.id)).toEqual(["id-0007"]);
  });

  it("uses a mixed compound prefix and logical DESC range without losing boundaries", async () => {
    const { db } = await fixture();
    for (const operator of ["gt", "gte", "lt", "lte"] as const) {
      const query: LogicalQuery = {
        collection: "items",
        where: {
          type: "and",
          predicates: [
            { type: "comparison", field: "category", operator: "eq", value: "books" },
            { type: "comparison", field: "price", operator, value: 50 },
          ],
        },
        orderBy: [{ field: "price", direction: "DESC" }],
      };
      const explanation = await db.explain(query);
      expect(explanation.selectedIndexes).toContain("category_price");
      expect(explanation.plan.requiresSort).toBe(false);
      await differential(db, query);
    }
  });

  it("handles null equality as an indexed value rather than absent options", async () => {
    const { db } = await fixture(40);
    const query: LogicalQuery = {
      collection: "items",
      where: { type: "isNull", field: "note" },
      orderBy: [{ field: "note", direction: "ASC" }],
    };
    expect((await db.explain(query)).selectedIndexes).toEqual(["note"]);
    const rows = await differential(db, query);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.document.note === null)).toBe(true);
    expect((await db.findByIndex("items", "note", null)).length).toBeGreaterThan(0);
  });

  it("plans indexed OR, IN and independent AND composition with residual filters", async () => {
    const { db } = await fixture();
    const queries: LogicalQuery[] = [
      {
        collection: "items",
        where: {
          type: "or",
          predicates: [
            { type: "comparison", field: "category", operator: "eq", value: "books" },
            { type: "comparison", field: "active", operator: "eq", value: true },
          ],
        },
        orderBy: [{ field: "sku", direction: "ASC" }],
      },
      {
        collection: "items",
        where: { type: "in", field: "category", values: ["books", "music"] },
        orderBy: [{ field: "sku", direction: "ASC" }],
      },
      {
        collection: "items",
        where: {
          type: "and",
          predicates: [
            { type: "comparison", field: "active", operator: "eq", value: true },
            { type: "comparison", field: "note", operator: "eq", value: "note-1" },
          ],
        },
      },
    ];
    expect((await db.explain(queries[0]!)).plan.access.type).toBe("union");
    expect((await db.explain(queries[1]!)).plan.access.type).toBe("union");
    expect((await db.explain(queries[2]!)).plan.access.type).toBe("intersection");
    for (const query of queries) await differential(db, query);
  });

  it("falls back for NOT and retains the complete predicate as residual", async () => {
    const { db } = await fixture();
    const query: LogicalQuery = {
      collection: "items",
      where: {
        type: "not",
        predicate: { type: "comparison", field: "category", operator: "eq", value: "books" },
      },
    };
    const explanation = await db.explain(query);
    expect(explanation.plan.access.type).toBe("collection-scan");
    expect(explanation.residualFilter).toEqual(query.where);
    await differential(db, query);
  });

  it("authenticates cursor query identity and emits continuation only with lookahead", async () => {
    const { db } = await fixture(4);
    const query: LogicalQuery = {
      collection: "items",
      orderBy: [{ field: "sku", direction: "ASC" }],
      limit: 2,
    };
    const first = await db.queryPage(query);
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await db.queryPage({ ...query, cursor: first.nextCursor! });
    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const tampered = `${first.nextCursor!.slice(0, -1)}${first.nextCursor!.endsWith("A") ? "B" : "A"}`;
    await expect(db.queryPage({ ...query, cursor: tampered })).rejects.toThrow("cursor");
    await expect(
      db.queryPage({
        ...query,
        cursor: first.nextCursor!,
        where: { type: "comparison", field: "active", operator: "eq", value: true },
      }),
    ).rejects.toThrow("incompatible");
  });

  it("plans against the transaction's captured read-your-writes view", async () => {
    const { db } = await fixture(10);
    await db.transaction(async (tx) => {
      tx.putDocument("items", "pending", {
        sku: "PENDING",
        category: "books",
        price: 55,
        active: true,
        note: null,
      });
      tx.deleteDocument("items", "id-0000");
      const rows = await collect(
        tx.query({
          collection: "items",
          where: { type: "comparison", field: "sku", operator: "eq", value: "PENDING" },
        }),
      );
      expect(rows.map((row) => row.id)).toEqual(["pending"]);
    });
  });

  it("keeps planning deterministic", async () => {
    const planner = new RuleBasedPlanner();
    const catalog = new Map([["items", ITEMS]]);
    const query: LogicalQuery = {
      collection: "items",
      where: { type: "comparison", field: "category", operator: "eq", value: "books" },
    };
    expect(planner.plan(query, catalog)).toEqual(planner.plan(query, catalog));
  });
});
