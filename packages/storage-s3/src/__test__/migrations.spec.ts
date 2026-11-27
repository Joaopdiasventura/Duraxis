import { beforeEach, describe, expect, it } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { DuraxisDatabase } from "@duraxis/core";
import { MigrationRunner, defineMigration, checksum, createSnapshot } from "@duraxis/migrations";
import { S3StorageDriver } from "../index.js";
import { FakeS3 } from "./fake-s3.js";
const id = "20261127110000000_initial";
const schema = { name: "users", indexes: [] };
const artifact = {
  migration: defineMigration({
    id,
    up(context) {
      context.schema.createCollection(schema);
      context.put("users", "one", { name: "Alice" });
    },
    down(context) {
      context.schema.dropCollection("users");
    },
  }),
  checksum: checksum("s3-artifact"),
  snapshot: createSnapshot(id, null, [schema]),
};
describe("S3 migration publication", () => {
  let fake: FakeS3;
  const storage = () =>
    new S3StorageDriver({ bucket: "test", prefix: "migrations", client: { region: "us-east-1" } });
  beforeEach(() => {
    fake = new FakeS3();
    fake.install();
  });
  it("persists migration history across independent driver instances", async () => {
    const first = new DuraxisDatabase({ storage: storage() });
    await new MigrationRunner(first, [artifact]).up();
    await first.close({ closeStorage: true });
    const reopened = new DuraxisDatabase({ storage: storage() });
    expect((await new MigrationRunner(reopened, [artifact]).status()).applied).toHaveLength(1);
    expect(await reopened.getDocument("users", "one")).toEqual({ name: "Alice" });
    await new MigrationRunner(reopened, [artifact]).down({ allowDestructive: true });
    expect(await reopened.getCollectionDefinitions()).toEqual([]);
    await reopened.close({ closeStorage: true });
  });
  it("reconciles a lost publication acknowledgement from persisted history", async () => {
    let lost = false;
    fake.after = (command) => {
      if (
        !lost &&
        command instanceof PutObjectCommand &&
        command.input.Key?.endsWith("/__duraxis/v1/manifest")
      ) {
        lost = true;
        throw new Error("lost acknowledgement");
      }
    };
    const db = new DuraxisDatabase({ storage: storage() });
    await new MigrationRunner(db, [artifact]).up();
    expect(lost).toBe(true);
    expect((await new MigrationRunner(db, [artifact]).status()).applied).toHaveLength(1);
    await db.close({ closeStorage: true });
  });
  it("coordinates independent runners through conditional manifest publication", async () => {
    const first = new DuraxisDatabase({ storage: storage() });
    const second = new DuraxisDatabase({ storage: storage() });
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const concurrent = {
      ...artifact,
      migration: defineMigration({
        id,
        async up(context) {
          context.schema.createCollection(schema);
          if (++arrived == 2) release();
          await gate;
        },
      }),
    };
    await Promise.all([
      new MigrationRunner(first, [concurrent]).up(),
      new MigrationRunner(second, [concurrent]).up(),
    ]);
    expect((await new MigrationRunner(first, [concurrent]).status()).applied).toHaveLength(1);
    expect(arrived).toBe(2);
    await first.close({ closeStorage: true });
    await second.close({ closeStorage: true });
  });
});
