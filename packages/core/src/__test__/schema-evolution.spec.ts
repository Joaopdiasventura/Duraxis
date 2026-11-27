import { describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { DuraxisDatabase } from "../database/duraxis-database.js";
import type { CollectionDefinition } from "../catalog/collection-schema.js";

const users: CollectionDefinition = {
  name: "users",
  fields: { value: { type: "string" } },
  allowAdditionalFields: false,
  indexes: [{ name: "value", field: "value", unique: false }],
};
const setup = async () => {
  const storage = new MemoryStorageDriver();
  const db = new DuraxisDatabase({ storage });
  await db.transaction((tx) => {
    tx.defineCollection(users);
    tx.putDocument("users", "1", { value: "2026-01-01T00:00:00.000Z" });
  });
  return { db, storage };
};
describe("transactional schema evolution", () => {
  it("validates old and pending documents against the final schema atomically", async () => {
    const { db } = await setup();
    await expect(
      db.transaction((tx) =>
        tx.alterCollection("users", {
          ...users,
          fields: { value: { type: "number", required: true } },
        }),
      ),
    ).rejects.toThrow("number");
    await expect(
      db.transaction((tx) => {
        tx.putDocument("users", "2", { value: "x" });
        tx.alterCollection("users", {
          ...users,
          fields: { value: { type: "string" }, required: { type: "boolean", required: true } },
        });
      }),
    ).rejects.toThrow("required");
    expect(await db.getDocument("users", "2")).toBeNull();
    expect((await db.getCollectionDefinitions())[0]?.fields?.value.type).toBe("string");
  });
  it("rebuilds unchanged index declarations after a field type change", async () => {
    const { db } = await setup();
    await db.transaction(async (tx) => {
      tx.alterCollection("users", { ...users, fields: { value: { type: "date" } } });
      const context = tx.createQueryContext();
      try {
        const rows = [];
        for await (const row of context.scanIndex("users", "value", {
          eq: new Date("2026-01-01T00:00:00.000Z"),
        }))
          rows.push(row);
        expect(rows).toHaveLength(1);
      } finally {
        context.close();
      }
    });
    expect(
      await db.findByIndex("users", "value", new Date("2026-01-01T00:00:00.000Z")),
    ).toHaveLength(1);
    await db.verifyIntegrity();
  });
  it("drops records and roots without affecting a captured snapshot", async () => {
    const { db, storage } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const reader = db.transaction(async (tx) => {
      ready();
      await gate;
      expect(await tx.getDocument("users", "1")).not.toBeNull();
    });
    await started;
    await db.transaction((tx) => {
      tx.dropCollection("users");
      expect(tx.getCollectionDefinitions()).toEqual([]);
      expect(() => tx.putDocument("users", "2", {})).toThrow("Unknown");
    });
    release();
    await reader;
    await db.defineCollections([users]);
    expect(await db.scanCollection("users")).toEqual([]);
    await db.verifyIntegrity();
    expect(
      (await db.collectGarbage(storage, { dryRun: true, olderThanMs: 0 })).candidates,
    ).toBeGreaterThan(0);
  });
  it("validates new foreign keys over existing data and referenced collection drops", async () => {
    const { db } = await setup();
    await db.defineCollections([{ name: "parents", indexes: [] }]);
    const linked: CollectionDefinition = {
      ...users,
      foreignKeys: [
        {
          name: "parent",
          field: "value",
          references: { collection: "parents", field: "$id" },
          onDelete: "RESTRICT",
        },
      ],
    };
    await expect(db.transaction((tx) => tx.alterCollection("users", linked))).rejects.toThrow();
    await db.transaction((tx) => tx.putDocument("parents", "2026-01-01T00:00:00.000Z", {}));
    await db.transaction((tx) => tx.alterCollection("users", linked));
    await expect(db.transaction((tx) => tx.dropCollection("parents"))).rejects.toThrow(
      "unknown collection",
    );
    await db.transaction((tx) => {
      tx.alterCollection("users", users);
      tx.dropCollection("parents");
    });
  });
  it("protects subsystem metadata and persists it through the ordinary commit path", async () => {
    const { db } = await setup();
    await db.transaction((tx) => {
      expect(() => tx.put("__duraxis/metadata/migrations", new Uint8Array())).toThrow("Reserved");
      tx.putMetadata("migrations", new Uint8Array([1]));
    });
    expect(await db.transaction((tx) => tx.getMetadata("migrations"))).toEqual(new Uint8Array([1]));
    await db.verifyIntegrity();
  });
});

describe("schema constraint changes", () => {
  it("rejects tightened nullability and additional-field policy", async () => {
    const { db } = await setup();
    await db.transaction((tx) => {
      tx.alterCollection("users", {
        ...users,
        fields: { value: { type: "string", nullable: true } },
        allowAdditionalFields: true,
      });
      tx.putDocument("users", "null", { value: null, extra: true });
    });
    await expect(
      db.transaction((tx) =>
        tx.alterCollection("users", { ...users, allowAdditionalFields: true }),
      ),
    ).rejects.toThrow("nullable");
    await expect(
      db.transaction((tx) =>
        tx.alterCollection("users", {
          ...users,
          fields: { value: { type: "string", nullable: true } },
        }),
      ),
    ).rejects.toThrow("Unknown document field");
  });
  it("rejects unique-index adoption over duplicates", async () => {
    const { db } = await setup();
    await db.transaction((tx) =>
      tx.putDocument("users", "2", { value: "2026-01-01T00:00:00.000Z" }),
    );
    await expect(
      db.transaction((tx) =>
        tx.alterCollection("users", {
          ...users,
          indexes: [{ name: "value", field: "value", unique: true }],
        }),
      ),
    ).rejects.toThrow("Unique");
    expect(await db.findByIndex("users", "value", "2026-01-01T00:00:00.000Z")).toHaveLength(2);
  });
  it("uses final relationships and data when changing an existing supporting index", async () => {
    const db = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
    await db.defineCollections([
      { name: "parents", indexes: [] },
      {
        name: "children",
        fields: { old: { type: "string" }, next: { type: "string", nullable: true } },
        indexes: [{ name: "link", field: "old", unique: false }],
      },
    ]);
    await db.transaction((tx) => {
      tx.putDocument("parents", "p", {});
      tx.putDocument("children", "c", { old: "other", next: "p" });
    });
    await db.transaction((tx) => {
      const schema = tx.getCollectionDefinitions().find((schema) => schema.name == "children")!;
      tx.alterCollection("children", {
        ...schema,
        indexes: [{ name: "link", field: "next", unique: false }],
        foreignKeys: [
          {
            name: "link",
            field: "next",
            references: { collection: "parents", field: "$id" },
            onDelete: "SET_NULL",
          },
        ],
      });
      tx.deleteDocument("parents", "p");
    });
    expect(await db.getDocument("children", "c")).toEqual({ old: "other", next: null });
    await db.verifyIntegrity();
  });
});
