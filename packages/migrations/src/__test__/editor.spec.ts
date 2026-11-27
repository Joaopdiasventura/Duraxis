import { describe, expect, it } from "vitest";
import { DuraxisDatabase, type CollectionDefinition } from "@duraxis/core";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { createMigrationContext, diffSchemas, applySchemaPlan } from "../index.js";
const definition: CollectionDefinition = {
  name: "users",
  fields: { name: { type: "string", required: true } },
  allowAdditionalFields: false,
  indexes: [{ name: "name", field: "name", unique: true }],
};
async function setup() {
  const db = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
  await db.transaction((tx) => {
    tx.defineCollection(definition);
    tx.putDocument("users", "one", { name: "Alice" });
  });
  return db;
}
describe("migration schema editor", () => {
  it("renames fields and index definitions while retaining values", async () => {
    const db = await setup();
    await db.transaction((tx) =>
      createMigrationContext(tx).schema.renameField("users", "name", "fullName"),
    );
    expect(await db.getDocument("users", "one")).toEqual({ fullName: "Alice" });
    expect(await db.findByIndex("users", "name", "Alice")).toHaveLength(1);
  });
  it("requires an explicit strategy before removing populated fields", async () => {
    const db = await setup();
    await db.transaction((tx) => tx.removeIndex("users", "name"));
    await expect(
      db.transaction((tx) =>
        createMigrationContext(tx).schema.removeField("users", "name", {
          strategy: "reject-if-populated",
        }),
      ),
    ).rejects.toThrow("populated");
    await db.transaction((tx) =>
      createMigrationContext(tx).schema.removeField("users", "name", { strategy: "delete-values" }),
    );
    expect(await db.getDocument("users", "one")).toEqual({});
  });
  it("backfills required fields in the same transaction and does not expose publication methods", async () => {
    const db = await setup();
    await db.transaction(async (tx) => {
      const context = createMigrationContext(tx);
      expect(context).not.toHaveProperty("commit");
      expect(context.schema).not.toHaveProperty("tx");
      context.schema.addField("users", "status", { type: "string", required: true });
      await context.transform("users", (document) => ({ ...document, status: "active" }));
    });
    expect(await db.getDocument("users", "one")).toEqual({ name: "Alice", status: "active" });
  });
  it("classifies transformations, preserves composite order, and refuses unsafe automatic execution", async () => {
    const plan = diffSchemas(
      [definition],
      [{ ...definition, fields: { name: { type: "number", required: true } } }],
    );
    expect(plan.operations[0]?.risk).toBe("requires-data-transformation");
    const db = await setup();
    await expect(
      db.transaction((tx) => applySchemaPlan(createMigrationContext(tx), plan)),
    ).rejects.toThrow("Manual");
    expect(await db.getDocument("users", "one")).toEqual({ name: "Alice" });
  });
});
