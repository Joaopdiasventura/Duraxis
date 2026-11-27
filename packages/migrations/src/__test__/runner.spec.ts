import { describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { DuraxisDatabase, type CollectionDefinition } from "@duraxis/core";
import {
  MigrationRunner,
  defineMigration,
  checksum,
  createSnapshot,
  schemaHash,
  diffSchemas,
  applySchemaPlan,
  type MigrationArtifact,
} from "../index.js";
const id = "20261127110000000_initial";
const users: CollectionDefinition = {
  name: "users",
  fields: { name: { type: "string" } },
  indexes: [],
};
function artifact(
  up = (context: Parameters<Parameters<typeof defineMigration>[0]["up"]>[0]) =>
    context.schema.createCollection(users),
): MigrationArtifact {
  return {
    migration: defineMigration({
      id,
      up,
      down: (context) => context.schema.dropCollection("users"),
    }),
    checksum: checksum("immutable artifact"),
    snapshot: createSnapshot(id, null, [users]),
  };
}
const setup = () => new DuraxisDatabase({ storage: new MemoryStorageDriver() });
describe("migration runtime", () => {
  it("applies, skips, reverts, and reapplies with atomic history", async () => {
    const db = setup();
    const runner = new MigrationRunner(db, [artifact()]);
    expect(await runner.up()).toEqual([id]);
    expect(await runner.up()).toEqual([]);
    await expect(runner.down()).rejects.toThrow("authorization");
    expect(await runner.down({ allowDestructive: true })).toEqual([id]);
    expect(await db.getCollectionDefinitions()).toEqual([]);
    await runner.up();
    expect((await runner.status()).applied).toHaveLength(1);
  });
  it("rolls back callback failures and snapshot mismatches", async () => {
    const db = setup();
    await expect(
      new MigrationRunner(db, [
        artifact((context) => {
          context.schema.createCollection(users);
          throw new Error("fail");
        }),
      ]).up(),
    ).rejects.toThrow("fail");
    await expect(new MigrationRunner(db, [artifact(() => {})]).up()).rejects.toThrow("snapshot");
    expect(await db.getCollectionDefinitions()).toEqual([]);
    expect((await new MigrationRunner(db, [artifact()]).status()).applied).toEqual([]);
  });
  it("detects changed checksums, missing files, duplicate IDs and schema drift", async () => {
    const db = setup();
    await new MigrationRunner(db, [artifact()]).up();
    await expect(
      new MigrationRunner(db, [{ ...artifact(), checksum: checksum("changed") }]).status(),
    ).rejects.toThrow("checksum");
    await expect(new MigrationRunner(db, []).status()).rejects.toThrow("Missing");
    expect(() => new MigrationRunner(db, [artifact(), artifact()])).toThrow("chain");
    await db.addIndex("users", { name: "name", field: "name", unique: false });
    await expect(new MigrationRunner(db, [artifact()]).status()).rejects.toThrow("drift");
  });
  it("does not retry callbacks on concurrent publication", async () => {
    const db = setup();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const migration = artifact(async (context) => {
      context.schema.createCollection(users);
      if (++calls == 2) release();
      await gate;
    });
    await Promise.all([
      new MigrationRunner(db, [migration]).up(),
      new MigrationRunner(db, [migration]).up(),
    ]);
    expect(calls).toBe(2);
    expect((await new MigrationRunner(db, [migration]).status()).applied).toHaveLength(1);
  });
  it("validates baseline without applying creation and ignores unrelated collections", async () => {
    const db = setup();
    await db.defineCollections([users, { name: "unrelated", indexes: [] }]);
    const runner = new MigrationRunner(db, [
      artifact(() => {
        throw new Error("must not execute");
      }),
    ]);
    await runner.baseline();
    expect((await runner.status()).pending).toEqual([]);
  });
  it("plans a deterministic atomic graph including cyclic foreign keys", async () => {
    const definitions: CollectionDefinition[] = [
      {
        name: "a",
        fields: { parent: { type: "string" } },
        indexes: [],
        foreignKeys: [
          {
            name: "parent",
            field: "parent",
            references: { collection: "b", field: "$id" },
            onDelete: "CASCADE",
          },
        ],
      },
      { name: "b", indexes: [] },
    ];
    expect(schemaHash(definitions)).toBe(schemaHash([...definitions].reverse()));
    const plan = diffSchemas([], definitions);
    const db = setup();
    const migration = {
      migration: defineMigration({ id, up: (context) => applySchemaPlan(context, plan) }),
      checksum: checksum("plan"),
      snapshot: createSnapshot(id, null, definitions),
    };
    await new MigrationRunner(db, [migration]).up();
    expect(schemaHash(await db.getCollectionDefinitions())).toBe(schemaHash(definitions));
    expect(diffSchemas(definitions, definitions).operations).toEqual([]);
  });
});

describe("migration failure and recovery", () => {
  it("keeps earlier versions committed when a later callback fails", async () => {
    const db = setup();
    const secondId = "20261127110000001_second";
    const thirdId = "20261127110000002_third";
    const second: MigrationArtifact = {
      migration: defineMigration({
        id: secondId,
        up(context) {
          context.put("users", "one", { name: "Alice" });
        },
        down(context) {
          context.delete("users", "one");
        },
      }),
      checksum: checksum("second"),
      snapshot: createSnapshot(secondId, id, [users]),
    };
    const third: MigrationArtifact = {
      migration: defineMigration({
        id: thirdId,
        up() {
          throw new Error("third failed");
        },
      }),
      checksum: checksum("third"),
      snapshot: createSnapshot(thirdId, secondId, [users]),
    };
    const runner = new MigrationRunner(db, [artifact(), second, third]);
    await expect(runner.up()).rejects.toThrow("third failed");
    expect((await runner.status()).applied).toHaveLength(2);
    await runner.down({ to: id, allowDestructive: true });
    expect((await runner.status()).applied.map((entry) => entry.id)).toEqual([id]);
    expect(await db.getDocument("users", "one")).toBeNull();
  });
  it("never retries a callback after a conflict with ordinary application writes", async () => {
    const db = setup();
    let calls = 0;
    const migration = artifact(async (context) => {
      calls++;
      context.schema.createCollection(users);
      await db.transaction((tx) => tx.put("ordinary", new Uint8Array([1])));
    });
    await expect(new MigrationRunner(db, [migration]).up()).rejects.toThrow("conflict");
    expect(calls).toBe(1);
    expect((await new MigrationRunner(db, [artifact()]).status()).applied).toHaveLength(0);
  });
  it("reconciles a lost acknowledgement after a history checkpoint", async () => {
    const storage = new MemoryStorageDriver();
    const db = new DuraxisDatabase({ storage });
    const put = storage.put.bind(storage);
    let fault = true;
    storage.put = async (key, bytes, options) => {
      const result = await put(key, bytes, options);
      if (fault && key.endsWith("/manifest")) {
        fault = false;
        throw new Error("lost publication response");
      }
      return result;
    };
    await new MigrationRunner(db, [artifact()]).up();
    // Maintenance now rejects active publication. Checkpoint after it drains,
    // then verify the durable migration receipt using a fresh connection.
    const other = new DuraxisDatabase({ storage });
    await other.checkpointHistory();
    expect((await new MigrationRunner(other, [artifact()]).status()).applied).toHaveLength(1);
    await other.close();
    await db.close();
  });
  it("stops on an unknown outcome without assuming rollback or rerunning callbacks", async () => {
    const storage = new MemoryStorageDriver();
    const db = new DuraxisDatabase({ storage });
    const put = storage.put.bind(storage);
    let calls = 0;
    storage.put = async (key, bytes, options) => {
      if (key.endsWith("/manifest")) throw new Error("publication unavailable");
      return put(key, bytes, options);
    };
    const migration = artifact((context) => {
      calls++;
      context.schema.createCollection(users);
    });
    await expect(new MigrationRunner(db, [migration]).up()).rejects.toThrow("unknown");
    expect(calls).toBe(1);
    expect(await db.getCollectionDefinitions()).toEqual([]);
  });
  it("rejects irreversible rollback and tampered snapshots", async () => {
    const db = setup();
    const initial = artifact();
    const migration = { ...initial, migration: defineMigration({ id, up: initial.migration.up }) };
    const runner = new MigrationRunner(db, [migration]);
    await runner.up();
    await expect(runner.down({ allowDestructive: true })).rejects.toThrow("Irreversible");
    expect(
      () =>
        new MigrationRunner(db, [
          { ...initial, snapshot: { ...initial.snapshot, schemaHash: checksum("changed") } },
        ]),
    ).toThrow("snapshot");
  });
});
