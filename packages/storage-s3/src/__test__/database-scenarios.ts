import { DuraxisDatabase, TransactionConflictError } from "@duraxis/core";
import { Column, DuraxisORM, Entity, Index, PrimaryKey } from "@duraxis/orm";
import { expect, it } from "vitest";
import type { S3StorageDriver } from "../index.js";

@Entity("s3_users")
class User {
  @PrimaryKey() id!: string;
  @Index() @Column({ type: "string", required: true }) name!: string;
}

/** Each call supplies a fresh database namespace, shared by the returned factory. */
export function defineDatabaseScenarios(fixture: () => () => S3StorageDriver): void {
  it("persists core documents, indexes and ORM transactions across close and reopen", async () => {
    const create = fixture();
    const first = create();
    const database = new DuraxisDatabase({ storage: first });
    const orm = new DuraxisORM({ database, entities: [User], schema: { mode: "create" } });
    await orm.initialize();
    try {
      await orm.transaction(async (manager) => {
        const users = manager.getRepository(User);
        await users.insert({ id: "a", name: "Alice" });
        await users.insert({ id: "b", name: "Bob" });
      });
      await orm.getRepository(User).update("a", { name: "Alicia" });
      expect((await database.getDocument("s3_users", "a"))?.name).toBe("Alicia");
      expect(
        (await orm.getRepository(User).find({ where: { name: "Alicia" } })).map((user) => user.id),
      ).toEqual(["a"]);
      expect(await orm.getRepository(User).delete("b")).toBe(true);
      await expect(
        orm.transaction(async (manager) => {
          await manager.getRepository(User).save({ id: "rolled-back", name: "Rollback" });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await orm.getRepository(User).findById("rolled-back")).toBeNull();
      expect(await database.verifyHistory()).toBeGreaterThanOrEqual(4);
    } finally {
      await orm.close();
      await database.close({ closeStorage: true });
    }
    const reopenedStorage = create();
    const reopened = new DuraxisDatabase({ storage: reopenedStorage });
    const reopenedOrm = new DuraxisORM({
      database: reopened,
      entities: [User],
      schema: { mode: "validate" },
    });
    try {
      await reopenedOrm.initialize();
      const users = reopenedOrm.getRepository(User);
      expect((await users.findById("a"))?.name).toBe("Alicia");
      expect(await users.findById("b")).toBeNull();
      expect(await users.findById("rolled-back")).toBeNull();
      expect((await users.find({ where: { name: "Alicia" } })).map((user) => user.id)).toEqual([
        "a",
      ]);
      expect(await reopened.verifyHistory()).toBeGreaterThanOrEqual(4);
      const report = await reopened.collectGarbage(reopenedStorage, {
        dryRun: true,
        olderThanMs: 0,
      });
      expect(report.dryRun).toBe(true);
      expect(report.deleted).toBe(0);
      await expect(reopened.collectGarbage(reopenedStorage, { dryRun: false })).rejects.toThrow(
        "exclusive maintenance",
      );
      expect((await users.findById("a"))?.name).toBe("Alicia");
    } finally {
      await reopenedOrm.close();
      await reopened.close({ closeStorage: true });
    }
  });

  it("allows one manifest publisher across independent driver/database instances", async () => {
    const create = fixture();
    const firstStorage = create();
    const secondStorage = create();
    const first = new DuraxisDatabase({ storage: firstStorage });
    const second = new DuraxisDatabase({ storage: secondStorage });
    try {
      await first.transaction((tx) => tx.put("counter", new TextEncoder().encode("0")));
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const increment = async (database: DuraxisDatabase) =>
        await database.transaction(async (tx) => {
          const value = Number(new TextDecoder().decode((await tx.get("counter"))!));
          if (++arrived == 2) release();
          await barrier;
          tx.put("counter", new TextEncoder().encode(String(value + 1)));
        });
      const results = await Promise.allSettled([increment(first), increment(second)]);
      expect(results.filter((result) => result.status == "fulfilled")).toHaveLength(1);
      const failure = results.find((result) => result.status == "rejected");
      expect(failure?.status == "rejected" && failure.reason).toBeInstanceOf(
        TransactionConflictError,
      );
      await second.transaction(async (tx) =>
        expect(new TextDecoder().decode((await tx.get("counter"))!)).toBe("1"),
      );
      expect(await first.verifyHistory()).toBe(2);
    } finally {
      await first.close({ closeStorage: true });
      await second.close({ closeStorage: true });
    }
  });
}
