import "reflect-metadata";

import { Controller, Inject, Injectable, Module, Scope, SetMetadata } from "@nestjs/common";
import { ContextIdFactory } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { Column, Entity, PrimaryKey, type Repository } from "@duraxis/orm";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { describe, expect, it, vi } from "vitest";
import {
  DuraxisModule,
  InjectDuraxisRepository,
  InjectDuraxisTransactionManager,
  Transactional,
  TransactionalProviderNotReadyError,
  TransactionManager,
  TransactionManagerNotFoundError,
  TransactionManagerShuttingDownError,
  TransactionPropagation,
  UnexpectedTransactionRollbackError,
  getDuraxisRepositoryToken,
  getDuraxisTransactionManagerToken,
} from "../index.js";
import { instrumentTransactionalMethods } from "../transactions/transactional.instrumentation.js";

@Entity("automatic_users")
class User {
  @PrimaryKey()
  id!: string;

  @Column({ type: "string", required: true })
  name!: string;
}

class BusinessError extends Error {}
const MARKER = Symbol("method metadata");
const SYMBOL_METHOD = Symbol("transactional method");

@Injectable()
class UserService {
  public constructor(
    @InjectDuraxisRepository(User) public readonly repository: Repository<User>,
    @InjectDuraxisTransactionManager() public readonly transactions: TransactionManager,
  ) {}

  @Transactional()
  @SetMetadata(MARKER, "preserved")
  public async create(id: string, fail = false): Promise<User> {
    const user = await this.repository.save({ id, name: id });
    if (fail) throw new Error("after first write");
    return user;
  }

  @Transactional()
  public async [SYMBOL_METHOD](): Promise<boolean> {
    return this.transactions.currentStatus()?.active ?? false;
  }

  @Transactional({ noRollbackFor: [BusinessError] })
  public async unrelatedError(id: string): Promise<void> {
    await this.repository.save({ id, name: id });
    throw new Error("unrelated error");
  }

  @Transactional({ noRollbackFor: [BusinessError] })
  public async explicitRollbackOnly(id: string): Promise<void> {
    await this.repository.save({ id, name: id });
    this.transactions.setRollbackOnly();
    throw new BusinessError("excluded error after rollback-only");
  }

  @Transactional()
  public async catchesExcluded(id: string): Promise<void> {
    try {
      await this.excluded(id);
    } catch (error) {
      if (!(error instanceof BusinessError)) throw error;
    }
  }

  @Transactional({ noRollbackFor: [BusinessError] })
  public async excluded(id: string): Promise<void> {
    await this.repository.save({ id, name: id });
    throw new BusinessError("excluded");
  }

  @Transactional()
  public async catchesLocally(id: string): Promise<void> {
    await this.repository.save({ id, name: id });
    try {
      throw new BusinessError("caught inside the same boundary");
    } catch (error) {
      if (!(error instanceof BusinessError)) throw error;
    }
  }

  @Transactional()
  public async raises(error: Error): Promise<void> {
    throw error;
  }

  @Transactional()
  public async propagates(error: Error): Promise<void> {
    await this.raises(error);
  }
}

@Injectable()
class CallerService {
  public constructor(@Inject(UserService) public readonly users: UserService) {}

  public async create(id: string): Promise<User> {
    return await this.users.create(id);
  }
}

@Controller()
class UserController {
  public constructor(@Inject(UserService) public readonly users: UserService) {}

  public async create(id: string): Promise<User> {
    return await this.users.create(id);
  }
}

// Regression: the feature module has exactly the ordinary consumer configuration.
@Module({
  imports: [DuraxisModule.forFeature([User])],
  controllers: [UserController],
  providers: [UserService],
})
class UserModule {}

function root() {
  return DuraxisModule.forRoot({
    driver: new MemoryStorageDriver(),
    autoLoadEntities: true,
    schema: { mode: "create" },
  });
}

async function compile(): Promise<TestingModule> {
  return await Test.createTestingModule({
    imports: [root(), UserModule],
  }).compile();
}

describe("ordinary Nest transactional providers", () => {
  it("preserves identity, constructor injection, arguments, results and method metadata", async () => {
    const module = await compile();
    try {
      const service = module.get(UserService);
      expect(service).toBeInstanceOf(UserService);
      expect(module.get(UserController).users).toBe(service);
      expect(service.repository).toBe(module.get(getDuraxisRepositoryToken(User)));
      expect(await module.get(UserController).create("consumer")).toMatchObject({
        id: "consumer",
        name: "consumer",
      });
      expect(await service.repository.findById("consumer")).toMatchObject({ id: "consumer" });
      expect(await service[SYMBOL_METHOD]()).toBe(true);
      expect(Reflect.getMetadata(MARKER, service.create)).toBe("preserved");
    } finally {
      await module.close();
    }
  });

  it("instruments the same service instance injected into another provider", async () => {
    const module = await Test.createTestingModule({
      imports: [root(), DuraxisModule.forFeature([User])],
      providers: [UserService, CallerService],
    }).compile();
    try {
      const caller = module.get(CallerService);
      expect(caller.users).toBe(module.get(UserService));
      expect(await caller.create("service-call")).toMatchObject({ id: "service-call" });
    } finally {
      await module.close();
    }
  });

  it("propagates the original exception through participating REQUIRED boundaries", async () => {
    const module = await compile();
    try {
      const error = new BusinessError("original error");
      await expect(module.get(UserService).propagates(error)).rejects.toBe(error);
    } finally {
      await module.close();
    }
  });

  it("rolls back the first write when the ordinary provider throws", async () => {
    const module = await compile();
    try {
      const service = module.get(UserController).users;
      await expect(service.create("rollback", true)).rejects.toThrow("after first write");
      expect(await service.repository.findById("rollback")).toBeNull();
    } finally {
      await module.close();
    }
  });

  it("does not let an unrelated noRollbackFor rule commit a failure", async () => {
    const module = await compile();
    try {
      const service = module.get(UserService);
      await expect(service.unrelatedError("unrelated")).rejects.toThrow("unrelated error");
      expect(await service.repository.findById("unrelated")).toBeNull();
    } finally {
      await module.close();
    }
  });

  it("honors rollback-only even when the escaping exception is excluded", async () => {
    const module = await compile();
    try {
      const service = module.get(UserService);
      await expect(service.explicitRollbackOnly("rollback-only")).rejects.toBeInstanceOf(
        UnexpectedTransactionRollbackError,
      );
      expect(await service.repository.findById("rollback-only")).toBeNull();
    } finally {
      await module.close();
    }
  });

  it("commits caught local exceptions and caught excluded participating exceptions", async () => {
    const module = await compile();
    try {
      const service = module.get(UserService);
      await service.catchesExcluded("caught-excluded");
      await service.catchesLocally("caught-local");
      expect(await service.repository.findById("caught-excluded")).not.toBeNull();
      expect(await service.repository.findById("caught-local")).not.toBeNull();
    } finally {
      await module.close();
    }
  });

  it("keeps instrumentation idempotent across repeated initialization", async () => {
    const module = await compile();
    try {
      const service = module.get(UserService);
      const method = service.create;
      instrumentTransactionalMethods(service);
      instrumentTransactionalMethods(service);
      await module.init();
      await module.init();
      expect(service.create).toBe(method);
      const execute = vi.spyOn(service.transactions, "execute");
      await service.create("once");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await module.close();
    }
  });

  it("isolates managers even for nested calls across independent applications", async () => {
    const first = await compile();
    const second = await compile();
    try {
      const firstService = first.get(UserService);
      const secondService = second.get(UserService);
      await expect(
        firstService.transactions.execute({}, "outer application", async () => {
          await firstService.create("same-id");
          await secondService.create("same-id");
          expect(secondService.transactions.currentStatus()).toBeNull();
          throw new Error("first application rollback");
        }),
      ).rejects.toThrow("first application rollback");
      expect(await firstService.repository.findById("same-id")).toBeNull();
      expect(await secondService.repository.findById("same-id")).not.toBeNull();
      await first.close();
      await secondService.create("first-app-closed");
    } finally {
      await first.close();
      await second.close();
    }
  });

  it.each([Scope.DEFAULT, Scope.TRANSIENT, Scope.REQUEST])(
    "intercepts Nest-managed instances in scope %s",
    async (scope) => {
      let constructions = 0;
      @Injectable({ scope })
      class ScopedService extends UserService {
        public constructor(
          @InjectDuraxisRepository(User) repository: Repository<User>,
          @InjectDuraxisTransactionManager() transactions: TransactionManager,
        ) {
          super(repository, transactions);
          constructions++;
        }
      }
      const module = await Test.createTestingModule({
        imports: [root(), DuraxisModule.forFeature([User])],
        providers: [ScopedService],
      }).compile();
      try {
        const first = await module.resolve(ScopedService, ContextIdFactory.create());
        const second = await module.resolve(ScopedService, ContextIdFactory.create());
        expect(first === second).toBe(scope == Scope.DEFAULT);
        expect(constructions).toBe(scope == Scope.DEFAULT ? 1 : 2);
        await first.create("first-scope");
        await expect(second.create("second-scope", true)).rejects.toThrow("after first write");
        expect(await first.repository.findById("first-scope")).not.toBeNull();
        expect(await first.repository.findById("second-scope")).toBeNull();
      } finally {
        await module.close();
      }
    },
  );

  it("inherits class metadata for new methods, overrides and instance functions", async () => {
    @Transactional({ readOnly: true })
    @Injectable()
    class Base {
      public constructor(
        @InjectDuraxisTransactionManager() public readonly transactions: TransactionManager,
      ) {}

      public async status(): Promise<boolean> {
        return false;
      }
    }
    @Injectable()
    class Derived extends Base {
      public override async status(): Promise<boolean> {
        return this.transactions.currentStatus()?.readOnly ?? false;
      }

      public extra = async (): Promise<boolean> =>
        this.transactions.currentStatus()?.readOnly ?? false;

      @Transactional({ readOnly: false, propagation: TransactionPropagation.NEVER })
      public async overrideOptions(): Promise<boolean> {
        return this.transactions.currentStatus() == null;
      }
    }
    const module = await Test.createTestingModule({
      imports: [root()],
      providers: [Derived],
    }).compile();
    try {
      const service = module.get(Derived);
      expect(await service.status()).toBe(true);
      expect(await service.extra()).toBe(true);
      expect(await service.overrideOptions()).toBe(true);
    } finally {
      await module.close();
    }
  });

  it("supports transactional calls in startup hooks and rejects calls after shutdown", async () => {
    @Transactional()
    @Injectable()
    class StartupService {
      public constructor(@Inject(UserService) private readonly users: UserService) {}

      public async onModuleInit(): Promise<void> {
        expect(this.users.transactions.currentStatus()).toBeNull();
        await this.users.create("module-init");
      }

      @Transactional()
      public async onApplicationBootstrap(): Promise<void> {
        expect(this.users.transactions.currentStatus()?.active).toBe(true);
        await this.users.create("application-bootstrap");
      }
    }
    const module = await Test.createTestingModule({
      imports: [root(), DuraxisModule.forFeature([User])],
      providers: [StartupService, UserService],
    }).compile();
    try {
      await module.init();
      const service = module.get(UserService);
      expect(await service.repository.findById("module-init")).not.toBeNull();
      expect(await service.repository.findById("application-bootstrap")).not.toBeNull();
      await module.close();
      expect(() => service.create("closed")).toThrow(TransactionManagerNotFoundError);
      await expect(
        service.transactions.execute({}, "closed", async () => {}),
      ).rejects.toBeInstanceOf(TransactionManagerShuttingDownError);
    } finally {
      await module.close();
    }
  });

  it("selects a connection per invocation and rejects unknown connections", async () => {
    @Transactional({ connectionName: "first" })
    @Injectable()
    class MultipleConnections {
      public constructor(
        @InjectDuraxisRepository(User, "first") public readonly first: Repository<User>,
        @InjectDuraxisRepository(User, "second") public readonly second: Repository<User>,
        @InjectDuraxisTransactionManager("first") public readonly firstManager: TransactionManager,
        @InjectDuraxisTransactionManager("second")
        public readonly secondManager: TransactionManager,
      ) {}

      public async firstBoundary(): Promise<void> {
        await this.first.save({ id: "first", name: "first" });
        await this.secondBoundary();
        expect(this.secondManager.currentStatus()).toBeNull();
        expect(this.firstManager.currentStatus()?.connectionName).toBe("first");
        throw new Error("first connection rollback");
      }

      @Transactional({ connectionName: "second" })
      public async secondBoundary(): Promise<void> {
        expect(this.firstManager.currentStatus()?.connectionName).toBe("first");
        expect(this.secondManager.currentStatus()?.connectionName).toBe("second");
        await this.second.save({ id: "second", name: "second" });
      }

      @Transactional({ connectionName: "unknown" })
      public async unknown(): Promise<void> {
        throw new Error("must never execute");
      }
    }
    const module = await Test.createTestingModule({
      imports: [
        ...["first", "second"].map((name) =>
          DuraxisModule.forRoot({
            name,
            driver: new MemoryStorageDriver(),
            autoLoadEntities: true,
            schema: { mode: "create" },
          }),
        ),
        DuraxisModule.forFeature([User], "first"),
        DuraxisModule.forFeature([User], "second"),
      ],
      providers: [MultipleConnections],
    }).compile();
    try {
      const service = module.get(MultipleConnections);
      await expect(service.firstBoundary()).rejects.toThrow("first connection rollback");
      expect(await service.first.findById("first")).toBeNull();
      expect(await service.second.findById("second")).not.toBeNull();
      expect(service.firstManager.currentStatus()).toBeNull();
      expect(service.secondManager.currentStatus()).toBeNull();
      expect(() => service.unknown()).toThrow(TransactionManagerNotFoundError);
    } finally {
      await module.close();
    }
  });

  it("supports providers whose request scope is inherited from a dependency", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class RequestDependency {}

    @Injectable()
    class RequestConsumer {
      public constructor(
        @Inject(RequestDependency) public readonly dependency: RequestDependency,
        @InjectDuraxisTransactionManager() private readonly transactions: TransactionManager,
      ) {}

      @Transactional()
      public async active(): Promise<boolean> {
        return this.transactions.currentStatus()?.active ?? false;
      }
    }
    const module = await Test.createTestingModule({
      imports: [root()],
      providers: [RequestConsumer, RequestDependency],
    }).compile();
    try {
      const context = ContextIdFactory.create();
      const first = await module.resolve(RequestConsumer, context);
      expect(await module.resolve(RequestConsumer, context)).toBe(first);
      const second = await module.resolve(RequestConsumer, ContextIdFactory.create());
      expect(first.dependency).not.toBe(second.dependency);
      expect(await first.active()).toBe(true);
      expect(await second.active()).toBe(true);
    } finally {
      await module.close();
    }
  });

  it("rejects transactional calls from a constructor before property injection", async () => {
    @Injectable()
    class EarlyService {
      public constructor() {
        void this.invoke();
      }

      @Transactional()
      public async invoke(): Promise<void> {
        throw new Error("must never execute");
      }
    }
    await expect(
      Test.createTestingModule({ imports: [root()], providers: [EarlyService] }).compile(),
    ).rejects.toBeInstanceOf(TransactionalProviderNotReadyError);
  });

  it.each(["value", "factory"])(
    "rejects %s instances without Nest property injection",
    async (kind) => {
      @Injectable()
      class UnmanagedService {
        @Transactional()
        public async invoke(): Promise<void> {
          throw new Error("must never execute");
        }
      }
      const instance = new UnmanagedService();
      expect(() => instance.invoke()).toThrow(TransactionalProviderNotReadyError);
      const provider =
        kind == "value"
          ? { provide: UnmanagedService, useValue: instance }
          : { provide: UnmanagedService, useFactory: () => instance };
      const module = await Test.createTestingModule({
        imports: [root()],
        providers: [provider],
      }).compile();
      try {
        expect(() => module.get(UnmanagedService).invoke()).toThrow(
          TransactionalProviderNotReadyError,
        );
      } finally {
        await module.close();
      }
    },
  );

  it("retains deprecated registration helpers and their named default connection", async () => {
    let initializations = 0;
    @Injectable()
    class LegacyService {
      public constructor(
        @InjectDuraxisTransactionManager("legacy")
        private readonly transactions: TransactionManager,
      ) {}

      @Transactional()
      public async status(): Promise<string | undefined> {
        return this.transactions.currentStatus()?.connectionName;
      }

      public async onModuleInit(): Promise<void> {
        initializations++;
        expect(await this.status()).toBe("legacy");
      }
    }
    const module = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({ name: "legacy", driver: new MemoryStorageDriver(), entities: [] }),
        DuraxisModule.forTransactionalProviders([LegacyService], "legacy"),
        DuraxisModule.forTransactionalFeature([User], [UserService]),
        root(),
      ],
    }).compile();
    try {
      await module.init();
      expect(initializations).toBe(1);
      expect(await module.get(LegacyService).status()).toBe("legacy");
      await module.get(UserService).create("legacy-feature");
      expect(
        await module
          .get<Repository<User>>(getDuraxisRepositoryToken(User))
          .findById("legacy-feature"),
      ).not.toBeNull();
      expect(module.get(getDuraxisTransactionManagerToken("legacy"))).toBeDefined();
    } finally {
      await module.close();
    }
  });
});
