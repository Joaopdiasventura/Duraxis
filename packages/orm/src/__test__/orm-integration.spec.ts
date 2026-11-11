import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DuraxisDatabase,
  CommitOutcomeUnknownError,
  TransactionConflictError,
} from "@duraxis/core";
import type { WriteOptions, WriteResult } from "@duraxis/storage";
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { describe, expect, it } from "vitest";
import {
  Column,
  DuplicateRecordError,
  DuraxisORM,
  Entity,
  Index,
  OrmClosedError,
  OrmNotInitializedError,
  PrimaryKey,
  RecordNotFoundError,
  SchemaViolationError,
  InvalidQueryError,
  TransactionManagerClosedError,
  UniqueIndexViolationOrmError,
  type TransactionContext,
} from "../index.js";

@Entity("users")
class User {
  @PrimaryKey()
  id!: string;

  @Column({ type: "string", required: true })
  name!: string;

  @Index({ unique: true })
  @Column({ type: "string", required: true })
  email!: string;

  @Index()
  @Column({ type: "number", nullable: true })
  age!: number | null;

  @Column({ type: "boolean", required: true })
  active!: boolean;

  @Column({ type: "date", required: true })
  createdAt!: Date;
}

@Index("category_price", [
  { property: "category", order: "ASC" },
  { property: "price", order: "DESC" },
])
@Entity("products")
class Product {
  @PrimaryKey()
  id!: string;
  @Column({ type: "string", required: true })
  category!: string;
  @Column({ type: "number", required: true })
  price!: number;
}

function user(id: string, age: number | null, active = true): User {
  return {
    id,
    name: `User ${id}`,
    email: `${id}@example.com`,
    age,
    active,
    createdAt: new Date(`2026-01-${id.padStart(2, "0")}T00:00:00.000Z`),
  };
}

async function memoryFixture(entities = [User, Product] as const) {
  const storage = new MemoryStorageDriver();
  const database = new DuraxisDatabase({ storage });
  const orm = new DuraxisORM({ database, entities, schema: { mode: "create" } });
  await orm.initialize();
  return { storage, database, orm };
}

describe("DuraxisORM repositories and queries", () => {
  it("enforces lifecycle and supports idempotent initialization and close", async () => {
    const storage = new MemoryStorageDriver();
    const database = new DuraxisDatabase({ storage });
    const orm = new DuraxisORM({ database, entities: [User], schema: { mode: "create" } });
    expect(() => orm.getRepository(User)).toThrow(OrmNotInitializedError);
    await Promise.all([orm.initialize(), orm.initialize()]);
    expect(orm.getRepository(User)).toBe(orm.getRepository(User));
    await orm.close();
    await orm.close();
    expect(() => orm.getRepository(User)).toThrow(OrmClosedError);
    await expect(database.getCollectionDefinitions()).resolves.toHaveLength(1);
  });

  it("implements create, insert, save, update, upsert, delete and findById semantics", async () => {
    const { orm } = await memoryFixture();
    const repository = orm.getRepository(User);
    const first = repository.create(user("1", 20));
    expect(first).toBeInstanceOf(User);
    expect(await repository.findById("1")).toBeNull();
    await repository.insert(first);
    await expect(repository.insert({ ...first, name: "overwritten" })).rejects.toBeInstanceOf(
      DuplicateRecordError,
    );
    expect((await repository.findById("1"))?.name).toBe("User 1");
    const updated = await repository.update("1", { age: null, name: undefined });
    expect(updated.age).toBeNull();
    expect(updated.name).toBe("User 1");
    await expect(repository.update("missing", { age: 10 })).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
    await repository.save({ ...user("1", 21), name: "saved" });
    expect((await repository.findById("1"))?.name).toBe("saved");
    await repository.upsert(user("2", 30));
    expect((await repository.findById("2"))?.age).toBe(30);
    expect(await repository.delete("2")).toBe(true);
    expect(await repository.delete("2")).toBe(false);
  });

  it("maps typed comparisons, logical operators, ordering, projection and count", async () => {
    const { orm, database } = await memoryFixture();
    const users = orm.getRepository(User);
    await orm.transaction(async (manager) => {
      const repository = manager.getRepository(User);
      await repository.insert(user("1", 17));
      await repository.insert(user("2", 20, false));
      await repository.insert(user("3", 30));
      await repository.insert(user("4", null));
    });
    expect(
      (
        await users.find({
          where: {
            AND: [
              { age: { gte: 18 } },
              { OR: [{ active: true }, { email: { in: ["2@example.com"] } }] },
              { NOT: { name: { eq: "nobody" } } },
            ],
          },
          orderBy: { age: "DESC" },
        })
      ).map((item) => item.id),
    ).toEqual(["3", "2"]);
    expect((await users.find({ where: { age: { isNull: true } } })).map((item) => item.id)).toEqual(
      ["4"],
    );
    const projected = await users.findOne({
      where: { id: "1" },
      projection: ["name"],
    });
    expect(projected?.id).toBe("1");
    expect(projected?.name).toBe("User 1");
    expect(Object.hasOwn(projected!, "email")).toBe(false);
    expect(await users.exists({ where: { email: "3@example.com" } })).toBe(true);
    expect(await users.count({ where: { active: true } })).toBe(3);
    expect(
      (await users.find({ where: { age: { ne: 20 } } })).map((item) => item.id).sort(),
    ).toEqual(["1", "3", "4"]);
    expect(
      (await users.find({ where: { age: { gt: 17, lte: 30 } } })).map((item) => item.id),
    ).toEqual(["2", "3"]);
    const direct = await database.queryAll({
      collection: "users",
      where: { type: "comparison", field: "age", operator: "gte", value: 18 },
      orderBy: [{ field: "age", direction: "ASC" }],
    });
    expect(
      (await users.find({ where: { age: { gte: 18 } }, orderBy: { age: "ASC" } })).map(
        (item) => item.id,
      ),
    ).toEqual(direct.map((row) => row.id));
    await users.insert({ ...user("5", 50), age: undefined as never });
    expect(
      (await users.find({ where: { age: { isMissing: true } } })).map((item) => item.id),
    ).toEqual(["5"]);
    await expect(users.find({ where: { age: { gte: "18" } } as never })).rejects.toBeInstanceOf(
      InvalidQueryError,
    );
  });

  it("paginates with cursors and delegates planning/explain to the core", async () => {
    const { orm } = await memoryFixture();
    const users = orm.getRepository(User);
    await orm.transaction(async (manager) => {
      const repository = manager.getRepository(User);
      for (const id of ["1", "2", "3", "4", "5"])
        await repository.insert(user(id, 10 + Number(id)));
    });
    const first = await users.findPage({ orderBy: { age: "ASC" }, limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["1", "2"]);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await users.findPage({
      orderBy: { age: "ASC" },
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.id)).toEqual(["3", "4"]);
    const builder = users
      .createQueryBuilder()
      .where("age", "gte", 12)
      .andWhere("active", "eq", true)
      .orderBy("age", "DESC")
      .limit(2);
    expect((await builder.getMany()).map((item) => item.id)).toEqual(["5", "4"]);
    expect(await builder.getCount()).toBe(4);
    const plan = await builder.explain();
    expect(plan.selectedIndexes).toContain("age");
    const fork = builder.where("id", "eq", "1");
    expect(fork).not.toBe(builder);
    expect(builder.toLogicalQuery().where).not.toEqual(fork.toLogicalQuery().where);
    const scan = await users.createQueryBuilder().where("name", "eq", "User 1").explain();
    expect(scan.operators).toContain("collection-scan");
  });

  it("propagates query cancellation and releases the core snapshot", async () => {
    const { orm, database } = await memoryFixture();
    await orm.getRepository(User).insert(user("1", 20));
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    await expect(orm.getRepository(User).find({ signal: controller.signal })).rejects.toThrow(
      "cancelled by caller",
    );
    await expect(
      orm.getRepository(User).createQueryBuilder().withSignal(controller.signal).getMany(),
    ).rejects.toThrow("cancelled by caller");
    await expect(database.close()).resolves.toBeUndefined();
  });

  it("preserves unique-index errors and does not publish duplicate values", async () => {
    const { orm } = await memoryFixture();
    const users = orm.getRepository(User);
    await users.insert(user("1", 20));
    await expect(users.insert({ ...user("2", 21), email: "1@example.com" })).rejects.toBeInstanceOf(
      UniqueIndexViolationOrmError,
    );
    expect(await users.findById("2")).toBeNull();
  });
});

describe("DuraxisORM transactions", () => {
  it("uses one core transaction for multiple repositories with read-your-writes", async () => {
    const { orm } = await memoryFixture();
    await orm.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const products = manager.getRepository(Product);
      await users.insert(user("1", 20));
      await products.insert({ id: "p1", category: "books", price: 25 });
      expect((await users.findById("1"))?.email).toBe("1@example.com");
      expect((await products.find({ where: { category: "books" } })).map((p) => p.id)).toEqual([
        "p1",
      ]);
      expect(
        (await products.createQueryBuilder().where("category", "eq", "books").explain())
          .selectedIndexes,
      ).toContain("category_price");
    });
  });

  it("rolls back callback errors and prohibits manager/repository use afterward", async () => {
    const { orm } = await memoryFixture();
    let captured: TransactionContext | undefined;
    await expect(
      orm.transaction(async (manager) => {
        captured = manager;
        await manager.getRepository(User).insert(user("1", 20));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await orm.getRepository(User).findById("1")).toBeNull();
    expect(() => captured!.getRepository(User)).toThrow(TransactionManagerClosedError);
  });

  it("surfaces conflicts without retrying callbacks", async () => {
    const { orm } = await memoryFixture();
    await orm.getRepository(User).insert(user("1", 20));
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const update = (age: number) =>
      orm.transaction(async (manager) => {
        calls++;
        await manager.getRepository(User).update("1", { age });
        arrived++;
        if (arrived == 2) release();
        await barrier;
      });
    const results = await Promise.allSettled([update(21), update(22)]);
    expect(results.filter((result) => result.status == "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status == "rejected");
    expect(rejected?.status == "rejected" && rejected.reason).toBeInstanceOf(
      TransactionConflictError,
    );
    expect(calls).toBe(2);
  });

  it("preserves an unknown commit outcome", async () => {
    class FailingStorage extends MemoryStorageDriver {
      public armed = false;
      public override put(
        key: string,
        data: Uint8Array,
        options: WriteOptions,
      ): Promise<WriteResult> {
        if (this.armed && key == "__duraxis/v1/manifest")
          return Promise.reject(new Error("publication failed"));
        return super.put(key, data, options);
      }
    }
    const storage = new FailingStorage();
    const database = new DuraxisDatabase({ storage });
    const orm = new DuraxisORM({ database, entities: [User], schema: { mode: "create" } });
    await orm.initialize();
    storage.armed = true;
    await expect(orm.getRepository(User).insert(user("1", 20))).rejects.toBeInstanceOf(
      CommitOutcomeUnknownError,
    );
  });
});

describe("DuraxisORM schema management", () => {
  it("validates compatible schemas and creates missing indexes without deleting extras", async () => {
    const storage = new MemoryStorageDriver();
    const database = new DuraxisDatabase({ storage });
    const create = new DuraxisORM({ database, entities: [User], schema: { mode: "create" } });
    await create.initialize();
    await database.addIndex("users", { name: "extra", unique: false, field: "name" });
    const validate = new DuraxisORM({ database, entities: [User], schema: { mode: "validate" } });
    await expect(validate.initialize()).resolves.toBeUndefined();
    expect(
      (await database.getCollectionDefinitions())[0]?.indexes.map((index) => index.name),
    ).toEqual(["email", "age", "extra"]);
  });

  it("rejects missing collections in validate mode and incompatible fields in create mode", async () => {
    const missing = new DuraxisORM({
      database: new DuraxisDatabase({ storage: new MemoryStorageDriver() }),
      entities: [User],
      schema: { mode: "validate" },
    });
    await expect(missing.initialize()).rejects.toBeInstanceOf(SchemaViolationError);

    const database = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
    await database.defineCollection({
      name: "users",
      fields: { name: { type: "number" } },
      allowAdditionalFields: false,
      indexes: [],
    });
    const incompatible = new DuraxisORM({
      database,
      entities: [User],
      schema: { mode: "create" },
    });
    await expect(incompatible.initialize()).rejects.toBeInstanceOf(SchemaViolationError);
  });

  it("adds missing compatible indexes to an existing collection", async () => {
    const database = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
    await database.defineCollection({
      name: "users",
      fields: {
        name: { type: "string", required: true, nullable: false },
        email: { type: "string", required: true, nullable: false },
        age: { type: "number", required: false, nullable: true },
        active: { type: "boolean", required: true, nullable: false },
        createdAt: { type: "date", required: true, nullable: false },
      },
      allowAdditionalFields: false,
      indexes: [],
    });
    const orm = new DuraxisORM({
      database,
      entities: [User],
      schema: { mode: "create" },
    });
    await orm.initialize();
    expect(
      (await database.getCollectionDefinitions())[0]?.indexes.map((index) => index.name),
    ).toEqual(["email", "age"]);
  });
});

describe("DuraxisORM disk persistence", () => {
  it("reopens entities, indexes and dates using AsyncDiskStorageDriver", async () => {
    const directory = await mkdtemp(join(tmpdir(), "duraxis-orm-"));
    try {
      const firstStorage = await AsyncDiskStorageDriver.open({ directory });
      const firstDatabase = new DuraxisDatabase({ storage: firstStorage });
      const firstOrm = new DuraxisORM({
        database: firstDatabase,
        entities: [User],
        schema: { mode: "create" },
        closeDatabase: true,
        closeStorage: true,
      });
      await firstOrm.initialize();
      await firstOrm.getRepository(User).insert(user("1", 25));
      await firstOrm.close();

      const secondStorage = await AsyncDiskStorageDriver.open({ directory });
      const secondDatabase = new DuraxisDatabase({ storage: secondStorage });
      const secondOrm = new DuraxisORM({
        database: secondDatabase,
        entities: [User],
        schema: { mode: "validate" },
        closeDatabase: true,
        closeStorage: true,
      });
      await secondOrm.initialize();
      const restored = await secondOrm.getRepository(User).findOne({
        where: { email: "1@example.com" },
      });
      expect(restored?.age).toBe(25);
      expect(restored?.createdAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
      expect(await secondDatabase.verifyIntegrity()).toMatchObject({ indexes: 2 });
      await secondOrm.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("compile-time query types", () => {
  it("keeps field value types in find options and the query builder", () => {
    const useTypes = (repository: ReturnType<DuraxisORM["getRepository"]>) => repository;
    expect(useTypes).toBeTypeOf("function");
    // These invalid examples are intentionally compile-time assertions.
    const check = (repository: import("../index.js").Repository<User>) => {
      // @ts-expect-error numeric comparison cannot use a string
      void repository.find({ where: { age: { gte: "18" } } });
      // @ts-expect-error text comparison cannot use a number
      void repository.createQueryBuilder().where("email", "eq", 42);
    };
    expect(check).toBeTypeOf("function");
  });
});
