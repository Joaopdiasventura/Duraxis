import "reflect-metadata";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Injectable, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { DuraxisDatabase } from "@duraxis/core";
import {
  Column,
  DuraxisORM,
  Entity,
  EntityNotRegisteredError,
  PrimaryKey,
  SchemaViolationError,
  type EntityClass,
  type Repository,
} from "@duraxis/orm";
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { describe, expect, it } from "vitest";
import {
  DuraxisModule,
  DuplicateDuraxisConnectionError,
  InjectDuraxisDatabase,
  InjectDuraxisOrm,
  InjectDuraxisRepository,
  getDuraxisDatabaseToken,
  getDuraxisOrmToken,
  getDuraxisRepositoryToken,
} from "../index.js";
import { DuraxisConnectionRegistry } from "../duraxis.registry.js";

@Entity("nest_users")
class User {
  @PrimaryKey()
  id!: string;

  @Column({ type: "string", required: true })
  email!: string;
}

@Entity("nest_products")
class Product {
  @PrimaryKey()
  id!: string;

  @Column({ type: "string", required: true })
  name!: string;
}

@Entity("unregistered")
class Unregistered {
  @PrimaryKey()
  id!: string;
}

class TrackingMemoryStorage extends MemoryStorageDriver {
  public closeCalls = 0;

  public async close(): Promise<void> {
    this.closeCalls++;
  }
}

class FailingCloseStorage extends MemoryStorageDriver {
  public async close(): Promise<void> {
    throw new Error("storage close failed");
  }
}

@Injectable()
class UserService {
  public constructor(
    @InjectDuraxisRepository(User) public readonly users: Repository<User>,
    @InjectDuraxisOrm() public readonly orm: DuraxisORM,
    @InjectDuraxisDatabase() public readonly database: DuraxisDatabase,
  ) {}
}

@Injectable()
class TransactionService {
  public constructor(@InjectDuraxisOrm() private readonly orm: DuraxisORM) {}

  public async createUser(id: string): Promise<void> {
    await this.orm.transaction(async (manager) => {
      await manager.getRepository(User).insert({ id, email: `${id}@example.com` });
      expect((await manager.getRepository(User).findById(id))?.id).toBe(id);
    });
  }
}

async function compileDefault(
  storage: MemoryStorageDriver = new MemoryStorageDriver(),
): Promise<TestingModule> {
  return await Test.createTestingModule({
    imports: [
      DuraxisModule.forRoot({
        driver: storage,
        entities: [User, Product],
        schema: { mode: "create" },
      }),
      DuraxisModule.forFeature([User, Product]),
    ],
    providers: [UserService, TransactionService],
  }).compile();
}

describe("DuraxisModule root and feature providers", () => {
  it("autoloads entities declared only by forFeature", async () => {
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          driver: new MemoryStorageDriver(),
          autoLoadEntities: true,
          schema: { mode: "create" },
        }),
        DuraxisModule.forFeature([User]),
      ],
    }).compile();
    try {
      const users = testingModule.get<Repository<User>>(getDuraxisRepositoryToken(User));
      await users.insert({ id: "autoload", email: "autoload@example.com" });
      expect((await users.findById("autoload"))?.email).toBe("autoload@example.com");
    } finally {
      await testingModule.close();
    }
  });

  it("combines explicit and auto-loaded entities without duplicating class identities", async () => {
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          driver: new MemoryStorageDriver(),
          entities: [User],
          autoLoadEntities: true,
          schema: { mode: "create" },
        }),
        DuraxisModule.forFeature([User, User]),
        DuraxisModule.forFeature([Product]),
      ],
    }).compile();
    try {
      expect(testingModule.get(getDuraxisRepositoryToken(User))).toBeDefined();
      expect(testingModule.get(getDuraxisRepositoryToken(Product))).toBeDefined();
    } finally {
      await testingModule.close();
    }
  });

  it("auto-loads distinct entity classes that share the same JavaScript class name", async () => {
    const makeEntity = (collection: string): EntityClass<{ id: string }> => {
      @Entity(collection)
      class Collision {
        @PrimaryKey()
        id!: string;
      }
      return Collision;
    };
    const first = makeEntity("autoload_collision_one");
    const second = makeEntity("autoload_collision_two");
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          driver: new MemoryStorageDriver(),
          autoLoadEntities: true,
          schema: { mode: "create" },
        }),
        DuraxisModule.forFeature([first, second]),
      ],
    }).compile();
    try {
      expect(first.name).toBe(second.name);
      expect(testingModule.get(getDuraxisRepositoryToken(first))).toBeDefined();
      expect(testingModule.get(getDuraxisRepositoryToken(second))).toBeDefined();
    } finally {
      await testingModule.close();
    }
  });

  it("auto-loads asynchronous named connections without cross-connection contamination", async () => {
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forFeature([User], "primary-auto"),
        DuraxisModule.forRootAsync({
          name: "primary-auto",
          useFactory: async () => ({
            driver: new MemoryStorageDriver(),
            autoLoadEntities: true,
            schema: { mode: "create" },
          }),
        }),
        DuraxisModule.forRoot({
          name: "secondary-auto",
          driver: new MemoryStorageDriver(),
          autoLoadEntities: true,
          schema: { mode: "create" },
        }),
        DuraxisModule.forFeature([Product], "secondary-auto"),
      ],
    }).compile();
    try {
      const primary = testingModule.get<DuraxisORM>(getDuraxisOrmToken("primary-auto"));
      const secondary = testingModule.get<DuraxisORM>(getDuraxisOrmToken("secondary-auto"));
      expect(primary.getRepository(User)).toBeDefined();
      expect(() => primary.getRepository(Product)).toThrow(EntityNotRegisteredError);
      expect(secondary.getRepository(Product)).toBeDefined();
      expect(() => secondary.getRepository(User)).toThrow(EntityNotRegisteredError);
    } finally {
      await testingModule.close();
    }
  });

  it("isolates entity discovery across applications compiled concurrently", async () => {
    const [usersApplication, productsApplication] = await Promise.all([
      Test.createTestingModule({
        imports: [
          DuraxisModule.forRoot({
            driver: new MemoryStorageDriver(),
            autoLoadEntities: true,
            schema: { mode: "create" },
          }),
          DuraxisModule.forFeature([User]),
        ],
      }).compile(),
      Test.createTestingModule({
        imports: [
          DuraxisModule.forRoot({
            driver: new MemoryStorageDriver(),
            autoLoadEntities: true,
            schema: { mode: "create" },
          }),
          DuraxisModule.forFeature([Product]),
        ],
      }).compile(),
    ]);
    try {
      expect(() =>
        usersApplication.get<DuraxisORM>(getDuraxisOrmToken()).getRepository(Product),
      ).toThrow(EntityNotRegisteredError);
      expect(() =>
        productsApplication.get<DuraxisORM>(getDuraxisOrmToken()).getRepository(User),
      ).toThrow(EntityNotRegisteredError);
    } finally {
      await Promise.all([usersApplication.close(), productsApplication.close()]);
    }
  });

  it("initializes forRoot with a memory driver and injects typed services", async () => {
    const testingModule = await compileDefault();
    try {
      const service = testingModule.get(UserService);
      await service.users.insert({ id: "1", email: "one@example.com" });
      expect((await service.users.findById("1"))?.email).toBe("one@example.com");
      expect(service.orm).toBe(testingModule.get(getDuraxisOrmToken()));
      expect(service.database).toBe(testingModule.get(getDuraxisDatabaseToken()));
    } finally {
      await testingModule.close();
    }
  });

  it("registers multiple forFeature entities and reuses ORM repositories", async () => {
    const testingModule = await compileDefault();
    try {
      const orm = testingModule.get<DuraxisORM>(getDuraxisOrmToken());
      const users = testingModule.get<Repository<User>>(getDuraxisRepositoryToken(User));
      const products = testingModule.get<Repository<Product>>(getDuraxisRepositoryToken(Product));
      expect(users).toBe(orm.getRepository(User));
      expect(products).toBe(orm.getRepository(Product));
      expect(testingModule.get(getDuraxisRepositoryToken(User))).toBe(users);
      await products.insert({ id: "p1", name: "Duraxis" });
      expect((await products.findById("p1"))?.name).toBe("Duraxis");
    } finally {
      await testingModule.close();
    }
  });

  it("executes transactions through the injected ORM", async () => {
    const testingModule = await compileDefault();
    try {
      await testingModule.get(TransactionService).createUser("tx");
      expect(
        (await testingModule.get<Repository<User>>(getDuraxisRepositoryToken(User)).findById("tx"))
          ?.email,
      ).toBe("tx@example.com");
    } finally {
      await testingModule.close();
    }
  });

  it("rejects a forFeature entity absent from root configuration", async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          DuraxisModule.forRoot({
            driver: new MemoryStorageDriver(),
            entities: [User],
            schema: { mode: "create" },
          }),
          DuraxisModule.forFeature([Unregistered]),
        ],
      }).compile(),
    ).rejects.toBeInstanceOf(EntityNotRegisteredError);
  });

  it("does not expose repositories globally without forFeature", async () => {
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          driver: new MemoryStorageDriver(),
          entities: [User],
          schema: { mode: "create" },
        }),
      ],
    }).compile();
    try {
      expect(() => testingModule.get(getDuraxisRepositoryToken(User))).toThrow();
      expect(testingModule.get(getDuraxisOrmToken())).toBeInstanceOf(DuraxisORM);
    } finally {
      await testingModule.close();
    }
  });
});

describe("DuraxisModule.forRootAsync", () => {
  it("supports a synchronous factory", async () => {
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRootAsync({
          useFactory: () => ({
            driver: new MemoryStorageDriver(),
            entities: [User],
            schema: { mode: "create" },
          }),
        }),
        DuraxisModule.forFeature([User]),
      ],
    }).compile();
    try {
      expect(testingModule.get(getDuraxisRepositoryToken(User))).toBeDefined();
    } finally {
      await testingModule.close();
    }
  });

  it("supports an asynchronous factory", async () => {
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRootAsync({
          name: "async",
          useFactory: async () => {
            await Promise.resolve();
            return {
              driver: new MemoryStorageDriver(),
              entities: [User],
              schema: { mode: "create" },
            };
          },
        }),
        DuraxisModule.forFeature([User], "async"),
      ],
    }).compile();
    try {
      expect(testingModule.get(getDuraxisOrmToken("async"))).toBeInstanceOf(DuraxisORM);
    } finally {
      await testingModule.close();
    }
  });

  it("resolves dependencies injected into the options factory", async () => {
    const CONFIG = Symbol("CONFIG");
    interface Config {
      readonly schemaMode: "create";
      readonly storage: MemoryStorageDriver;
    }
    const config: Config = { schemaMode: "create", storage: new MemoryStorageDriver() };

    @Module({ providers: [{ provide: CONFIG, useValue: config }], exports: [CONFIG] })
    class ConfigModule {}

    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRootAsync<[Config]>({
          imports: [ConfigModule],
          inject: [CONFIG],
          useFactory: (injected: Config) => ({
            driver: injected.storage,
            entities: [User],
            schema: { mode: injected.schemaMode },
          }),
        }),
        DuraxisModule.forFeature([User]),
      ],
    }).compile();
    try {
      expect(testingModule.get(getDuraxisRepositoryToken(User))).toBeDefined();
    } finally {
      await testingModule.close();
    }
  });

  it("creates and initializes a connection only once", async () => {
    let factoryCalls = 0;
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRootAsync({
          useFactory: async () => {
            factoryCalls++;
            await Promise.resolve();
            return {
              driver: new MemoryStorageDriver(),
              entities: [User],
              schema: { mode: "create" },
            };
          },
        }),
        DuraxisModule.forFeature([User, User]),
      ],
    }).compile();
    try {
      const [first, second] = await Promise.all([
        Promise.resolve(testingModule.get(getDuraxisOrmToken())),
        Promise.resolve(testingModule.get(getDuraxisOrmToken())),
      ]);
      expect(first).toBe(second);
      expect(factoryCalls).toBe(1);
    } finally {
      await testingModule.close();
    }
  });
});

describe("tokens and named connections", () => {
  it("keeps tokens stable and collision-safe for equal class names", () => {
    const makeEntity = (collection: string): EntityClass<{ id: string }> => {
      @Entity(collection)
      class Collision {
        @PrimaryKey()
        id!: string;
      }
      return Collision;
    };
    const first = makeEntity("collision_one");
    const second = makeEntity("collision_two");
    expect(first.name).toBe(second.name);
    expect(getDuraxisRepositoryToken(first)).toBe(getDuraxisRepositoryToken(first));
    expect(getDuraxisRepositoryToken(first)).not.toBe(getDuraxisRepositoryToken(second));
    expect(getDuraxisRepositoryToken(first, "named")).not.toBe(getDuraxisRepositoryToken(first));
    expect(getDuraxisOrmToken("named")).toBe(getDuraxisOrmToken("named"));
  });

  it("isolates repositories, databases and data across named connections", async () => {
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          name: "primary",
          driver: new MemoryStorageDriver(),
          entities: [User],
          schema: { mode: "create" },
        }),
        DuraxisModule.forFeature([User], "primary"),
        DuraxisModule.forRoot({
          name: "analytics",
          driver: new MemoryStorageDriver(),
          entities: [User],
          schema: { mode: "create" },
        }),
        DuraxisModule.forFeature([User], "analytics"),
      ],
    }).compile();
    try {
      const primary = testingModule.get<Repository<User>>(
        getDuraxisRepositoryToken(User, "primary"),
      );
      const analytics = testingModule.get<Repository<User>>(
        getDuraxisRepositoryToken(User, "analytics"),
      );
      await primary.insert({ id: "same", email: "primary@example.com" });
      await analytics.insert({ id: "same", email: "analytics@example.com" });
      expect((await primary.findById("same"))?.email).toBe("primary@example.com");
      expect((await analytics.findById("same"))?.email).toBe("analytics@example.com");
      expect(testingModule.get(getDuraxisDatabaseToken("primary"))).not.toBe(
        testingModule.get(getDuraxisDatabaseToken("analytics")),
      );
    } finally {
      await testingModule.close();
    }
  });

  it("supports the public injection decorators for a named connection", async () => {
    @Injectable()
    class NamedService {
      public constructor(
        @InjectDuraxisRepository(User, "primary") public readonly users: Repository<User>,
        @InjectDuraxisOrm("primary") public readonly orm: DuraxisORM,
        @InjectDuraxisDatabase("primary") public readonly database: DuraxisDatabase,
      ) {}
    }
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          name: "primary",
          driver: new MemoryStorageDriver(),
          entities: [User],
          schema: { mode: "create" },
        }),
        DuraxisModule.forFeature([User], "primary"),
      ],
      providers: [NamedService],
    }).compile();
    try {
      const service = testingModule.get(NamedService);
      expect(service.users).toBe(service.orm.getRepository(User));
      expect(service.database).toBe(testingModule.get(getDuraxisDatabaseToken("primary")));
    } finally {
      await testingModule.close();
    }
  });

  it("rejects duplicate root configuration for one connection name", async () => {
    const firstStorage = new TrackingMemoryStorage();
    const secondStorage = new TrackingMemoryStorage();
    await expect(
      Test.createTestingModule({
        imports: [
          DuraxisModule.forRoot({
            name: "duplicate",
            driver: () => firstStorage,
            entities: [User],
            schema: { mode: "create" },
          }),
          DuraxisModule.forRoot({
            name: "duplicate",
            driver: () => secondStorage,
            entities: [User],
            schema: { mode: "create" },
          }),
        ],
      }).compile(),
    ).rejects.toBeInstanceOf(DuplicateDuraxisConnectionError);
    expect(firstStorage.closeCalls + secondStorage.closeCalls).toBe(0);
  });

  it("does not close the valid registered connection when a duplicate is rejected", async () => {
    const registry = new DuraxisConnectionRegistry();
    const validStorage = new TrackingMemoryStorage();
    const rejectedStorage = new TrackingMemoryStorage();
    const connection = await registry.create("registry-duplicate", {
      driver: () => validStorage,
      entities: [User],
      schema: { mode: "create" },
    });
    try {
      await expect(
        registry.create("registry-duplicate", {
          driver: () => rejectedStorage,
          entities: [User],
          schema: { mode: "create" },
        }),
      ).rejects.toBeInstanceOf(DuplicateDuraxisConnectionError);
      await connection.orm.getRepository(User).insert({ id: "still-valid", email: "valid@test" });
      expect((await connection.orm.getRepository(User).findById("still-valid"))?.id).toBe(
        "still-valid",
      );
      expect(validStorage.closeCalls).toBe(0);
      expect(rejectedStorage.closeCalls).toBe(0);
    } finally {
      await connection.close();
    }
    expect(validStorage.closeCalls).toBe(1);
  });
});

describe("initialization failures and lifecycle", () => {
  it("propagates driver factory failures", async () => {
    const failure = new Error("driver creation failed");
    await expect(
      Test.createTestingModule({
        imports: [
          DuraxisModule.forRoot({
            driver: async () => {
              throw failure;
            },
            entities: [User],
          }),
        ],
      }).compile(),
    ).rejects.toBe(failure);
  });

  it("closes owned resources after schema initialization failure", async () => {
    const storage = new TrackingMemoryStorage();
    const setup = new DuraxisDatabase({ storage });
    await setup.defineCollection({
      name: "nest_users",
      fields: { email: { type: "number" } },
      allowAdditionalFields: false,
      indexes: [],
    });
    await setup.close();

    await expect(
      Test.createTestingModule({
        imports: [
          DuraxisModule.forRoot({
            driver: storage,
            entities: [User],
            schema: { mode: "create" },
            closeStorage: true,
          }),
        ],
      }).compile(),
    ).rejects.toBeInstanceOf(SchemaViolationError);
    expect(storage.closeCalls).toBe(1);
  });

  it("closes factory-owned storage once on repeated shutdown", async () => {
    const storage = new TrackingMemoryStorage();
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          driver: () => storage,
          entities: [User],
          schema: { mode: "create" },
        }),
      ],
    }).compile();
    await testingModule.close();
    await testingModule.close();
    expect(storage.closeCalls).toBe(1);
  });

  it("does not close supplied externally managed drivers by default", async () => {
    const storage = new TrackingMemoryStorage();
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          driver: storage,
          entities: [User],
          schema: { mode: "create" },
        }),
      ],
    }).compile();
    const database = testingModule.get<DuraxisDatabase>(getDuraxisDatabaseToken());
    await testingModule.close();
    expect(storage.closeCalls).toBe(0);
    await expect(database.getCollectionDefinitions()).rejects.toThrow("closed");
  });

  it("propagates shutdown failures", async () => {
    const testingModule = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          driver: () => new FailingCloseStorage(),
          entities: [User],
          schema: { mode: "create" },
        }),
      ],
    }).compile();
    await expect(testingModule.close()).rejects.toThrow("storage close failed");
  });
});

describe("AsyncDiskStorageDriver integration", () => {
  it("closes, releases the ownership lock and reopens persisted data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "duraxis-nestjs-"));
    let first: TestingModule | undefined;
    let second: TestingModule | undefined;
    try {
      first = await Test.createTestingModule({
        imports: [
          DuraxisModule.forRootAsync({
            useFactory: async () => ({
              driver: () => AsyncDiskStorageDriver.open({ directory }),
              entities: [User],
              schema: { mode: "create" },
            }),
          }),
          DuraxisModule.forFeature([User]),
        ],
      }).compile();
      await first
        .get<Repository<User>>(getDuraxisRepositoryToken(User))
        .insert({ id: "disk", email: "disk@example.com" });
      await first.close();
      first = undefined;

      second = await Test.createTestingModule({
        imports: [
          DuraxisModule.forRootAsync({
            useFactory: async () => ({
              driver: () => AsyncDiskStorageDriver.open({ directory }),
              entities: [User],
              schema: { mode: "validate" },
            }),
          }),
          DuraxisModule.forFeature([User]),
        ],
      }).compile();
      expect(
        (await second.get<Repository<User>>(getDuraxisRepositoryToken(User)).findById("disk"))
          ?.email,
      ).toBe("disk@example.com");
      expect(
        await second.get<DuraxisDatabase>(getDuraxisDatabaseToken()).verifyIntegrity(),
      ).toMatchObject({ indexes: 0 });
    } finally {
      await first?.close();
      await second?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
