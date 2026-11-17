import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { describe, expect, it } from "vitest";
import {
  DuraxisDatabase,
  InvalidForeignKeyDefinitionError,
  ReferencedRecordNotFoundError,
  ReferencedRecordRestrictedError,
  TransactionConflictError,
  type CollectionDefinition,
  type ReferentialAction,
} from "../index.js";

function schemas(
  onDelete: ReferentialAction = "RESTRICT",
  nullable = false,
): readonly CollectionDefinition[] {
  return [
    {
      name: "users",
      fields: { email: { type: "string" as const, required: true } },
      indexes: [],
    },
    {
      name: "posts",
      fields: {
        title: { type: "string" as const, required: true },
        authorId: { type: "string" as const, required: !nullable, nullable },
      },
      indexes: [],
      foreignKeys: [
        {
          name: "author",
          field: "authorId",
          references: { collection: "users", field: "$id" as const },
          onDelete,
        },
      ],
    },
  ];
}

describe("core foreign keys", () => {
  it("validates final transaction state and rolls invalid writes back", async () => {
    const database = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
    await database.defineCollections(schemas());
    await database.transaction((tx) => {
      tx.putDocument("users", "u1", { email: "u@example.com" });
      tx.putDocument("posts", "p1", { title: "post", authorId: "u1" });
    });
    await expect(
      database.transaction((tx) =>
        tx.putDocument("posts", "bad", { title: "bad", authorId: "missing" }),
      ),
    ).rejects.toBeInstanceOf(ReferencedRecordNotFoundError);
    expect(await database.getDocument("posts", "bad")).toBeNull();
    await expect(
      database.transaction((tx) => {
        tx.deleteDocument("users", "u1");
      }),
    ).rejects.toBeInstanceOf(ReferencedRecordRestrictedError);
    await database.transaction((tx) => {
      tx.deleteDocument("posts", "p1");
      tx.deleteDocument("users", "u1");
    });
    expect(await database.getDocument("users", "u1")).toBeNull();
  });

  it("persists definitions, auto-creates indexes, cascades and sets null", async () => {
    const storage = new MemoryStorageDriver();
    const cascade = new DuraxisDatabase({ storage, namespace: "cascade" });
    await cascade.defineCollections(schemas("CASCADE"));
    await cascade.transaction((tx) => {
      tx.putDocument("users", "u1", { email: "u@example.com" });
      tx.putDocument("posts", "p1", { title: "post", authorId: "u1" });
    });
    await cascade.transaction((tx) => tx.deleteDocument("users", "u1"));
    expect(await cascade.getDocument("posts", "p1")).toBeNull();
    const definitions = await new DuraxisDatabase({
      storage,
      namespace: "cascade",
    }).getCollectionDefinitions();
    expect(definitions.find((item) => item.name == "posts")?.foreignKeys?.[0]?.name).toBe("author");
    expect(
      definitions.find((item) => item.name == "posts")?.indexes.map((item) => item.name),
    ).toContain("fk_author");

    const setNull = new DuraxisDatabase({ storage, namespace: "null" });
    await setNull.defineCollections(schemas("SET_NULL", true));
    await setNull.transaction((tx) => {
      tx.putDocument("users", "u1", { email: "u@example.com" });
      tx.putDocument("posts", "p1", { title: "post", authorId: "u1" });
    });
    await setNull.transaction((tx) => tx.deleteDocument("users", "u1"));
    expect((await setNull.getDocument("posts", "p1"))?.authorId).toBeNull();

    const invalid = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
    await expect(invalid.defineCollections(schemas("SET_NULL"))).rejects.toBeInstanceOf(
      InvalidForeignKeyDefinitionError,
    );
  });

  it("terminates cyclic cascades without partial publication", async () => {
    const database = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
    await database.defineCollections([
      {
        name: "nodesA",
        fields: { bId: { type: "string", required: true } },
        indexes: [],
        foreignKeys: [
          {
            name: "b",
            field: "bId",
            references: { collection: "nodesB", field: "$id" },
            onDelete: "CASCADE",
          },
        ],
      },
      {
        name: "nodesB",
        fields: { aId: { type: "string", required: true } },
        indexes: [],
        foreignKeys: [
          {
            name: "a",
            field: "aId",
            references: { collection: "nodesA", field: "$id" },
            onDelete: "CASCADE",
          },
        ],
      },
    ]);
    await database.transaction((tx) => {
      tx.putDocument("nodesA", "a1", { bId: "b1" });
      tx.putDocument("nodesB", "b1", { aId: "a1" });
    });
    await database.transaction((tx) => tx.deleteDocument("nodesA", "a1"));
    expect(await database.getDocument("nodesA", "a1")).toBeNull();
    expect(await database.getDocument("nodesB", "b1")).toBeNull();
  });

  it("preserves optimistic conflicts when a parent is concurrently deleted", async () => {
    const database = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
    await database.defineCollections(schemas());
    await database.transaction((tx) => tx.putDocument("users", "u1", { email: "u@example.com" }));
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const run = (action: "reference" | "delete") =>
      database.transaction(async (tx) => {
        if (action == "reference") tx.putDocument("posts", "p1", { title: "post", authorId: "u1" });
        else tx.deleteDocument("users", "u1");
        if (++arrived == 2) release();
        await barrier;
      });
    const results = await Promise.allSettled([run("reference"), run("delete")]);
    expect(results.filter((result) => result.status == "rejected")).toHaveLength(1);
    const reason = results.find((result) => result.status == "rejected");
    expect(
      reason?.status == "rejected" &&
        (reason.reason instanceof TransactionConflictError ||
          reason.reason instanceof ReferencedRecordRestrictedError),
    ).toBe(true);
  });
});
