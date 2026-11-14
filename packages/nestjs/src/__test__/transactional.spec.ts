import "reflect-metadata";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { CommitOutcomeUnknownError, TransactionConflictError } from "@duraxis/core";
import { Column, Entity, PrimaryKey, type DuraxisORM, type Repository } from "@duraxis/orm";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";
import type { WriteOptions, WriteResult } from "@duraxis/storage";
import { describe, expect, it } from "vitest";
import {
  DuraxisModule,
  ExistingTransactionError,
  InjectDuraxisOrm,
  InjectDuraxisRepository,
  InjectDuraxisTransactionManager,
  NestedTransactionNotSupportedError,
  ReadOnlyTransactionError,
  TransactionIsolation,
  TransactionManager,
  TransactionPropagation,
  TransactionRequiredError,
  TransactionContextClosedError,
  TransactionalMethodReturnTypeError,
  Transactional,
  UnawaitedTransactionOperationError,
  UnexpectedTransactionRollbackError,
  UnsupportedMixedTransactionError,
  UnsupportedTransactionIsolationError,
  UnsupportedTransactionTimeoutError,
  getDuraxisRepositoryToken,
  getDuraxisTransactionManagerToken,
} from "../index.js";

@Entity("tx_users")
class User {
  @PrimaryKey()
  id!: string;

  @Column({ type: "string", required: true })
  name!: string;
}

@Entity("tx_wallets")
class Wallet {
  @PrimaryKey()
  id!: string;

  @Column({ type: "number", required: true })
  balance!: number;
}

class ValidationError extends Error {}

@Transactional()
@Injectable()
class ClassTransactionalService {
  public constructor(
    @InjectDuraxisTransactionManager() private readonly transactions: TransactionManager,
  ) {}

  public async inheritedDefault(): Promise<boolean> {
    return this.transactions.currentStatus()?.active ?? false;
  }

  @Transactional({ propagation: TransactionPropagation.NEVER })
  public async methodOverride(): Promise<boolean> {
    return this.transactions.currentStatus() == null;
  }
}

@Injectable()
class BaseTransactionalService {
  public constructor(
    @InjectDuraxisTransactionManager() protected readonly transactions: TransactionManager,
  ) {}

  @Transactional()
  public async inheritedMethod(): Promise<boolean> {
    return this.transactions.currentStatus()?.active ?? false;
  }
}

@Injectable()
class DerivedTransactionalService extends BaseTransactionalService {}

@Injectable()
class TransactionalService {
  public constructor(
    @InjectDuraxisRepository(User) private readonly users: Repository<User>,
    @InjectDuraxisRepository(Wallet) private readonly wallets: Repository<Wallet>,
    @InjectDuraxisOrm() private readonly orm: DuraxisORM,
    @InjectDuraxisTransactionManager() private readonly transactions: TransactionManager,
  ) {}

  @Transactional()
  public async create(id: string): Promise<void> {
    await this.users.insert({ id, name: id });
    expect((await this.users.findById(id))?.id).toBe(id);
    expect(await this.users.createQueryBuilder().where("id", "eq", id).getCount()).toBe(1);
  }

  @Transactional()
  public async atomicFailure(id: string): Promise<void> {
    await this.users.insert({ id, name: id });
    await this.wallets.insert({ id, balance: 1 });
    throw new Error("second operation failed");
  }

  @Transactional({ readOnly: true })
  public async writeReadOnly(id: string): Promise<void> {
    await this.users.insert({ id, name: id });
  }

  @Transactional({ propagation: TransactionPropagation.MANDATORY })
  public async mandatory(): Promise<boolean> {
    return this.transactions.currentStatus()?.active ?? false;
  }

  @Transactional({ propagation: TransactionPropagation.NEVER })
  public async never(): Promise<boolean> {
    return this.transactions.currentStatus() == null;
  }

  @Transactional({ propagation: TransactionPropagation.NESTED })
  public async nested(): Promise<void> {}

  @Transactional({ timeout: 5 })
  public async timeout(): Promise<void> {}

  @Transactional({ isolation: "SERIALIZABLE" as TransactionIsolation })
  public async unsupportedIsolation(): Promise<void> {}

  @Transactional({ isolation: TransactionIsolation.SNAPSHOT })
  public async snapshot(): Promise<boolean> {
    return this.transactions.currentStatus()?.active ?? false;
  }

  @Transactional({ noRollbackFor: [ValidationError] })
  public async commitAndThrow(id: string): Promise<void> {
    await this.users.insert({ id, name: id });
    throw new ValidationError("valid business failure");
  }

  @Transactional({ noRollbackFor: [Error], rollbackFor: [ValidationError] })
  public async specificRollbackRule(id: string): Promise<void> {
    await this.users.insert({ id, name: id });
    throw new ValidationError("specific rollback");
  }

  @Transactional()
  public async imperativeInsideDeclarative(): Promise<void> {
    await this.orm.transaction(async () => {});
  }

  @Transactional()
  public async status(): Promise<ReturnType<TransactionManager["currentStatus"]>> {
    return this.transactions.currentStatus();
  }

  @Transactional()
  public async returnBuilder() {
    return this.users.createQueryBuilder().where("name", "eq", "builder");
  }

  @Transactional()
  public async unawaited(id: string): Promise<void> {
    void this.users.insert({ id, name: id });
  }

  @Transactional()
  public syncMethod(): Promise<void> {
    return undefined as unknown as Promise<void>;
  }

  @Transactional()
  public async aliasStatus(): Promise<boolean> {
    return this.transactions.currentStatus()?.active ?? false;
  }

  @Transactional()
  public async selfInner(id: string): Promise<void> {
    await this.users.insert({ id, name: id });
    throw new Error("self invocation");
  }

  public async callSelf(id: string): Promise<void> {
    await this.selfInner(id);
  }

  @Transactional()
  public async concurrent(
    id: string,
    entered: () => void,
    release: Promise<void>,
    rollback: boolean,
  ): Promise<void> {
    await this.users.insert({ id, name: id });
    entered();
    await release;
    if (rollback) this.transactions.setRollbackOnly();
  }

  @Transactional()
  public async concurrentUpdate(
    id: string,
    name: string,
    entered: () => void,
    release: Promise<void>,
  ): Promise<void> {
    await this.users.update(id, { name });
    entered();
    await release;
  }
}

@Injectable()
class InnerService {
  public constructor(
    @InjectDuraxisRepository(User) private readonly users: Repository<User>,
    @InjectDuraxisTransactionManager() private readonly transactions: TransactionManager,
  ) {}

  @Transactional()
  public async requiredFailure(id: string): Promise<void> {
    await this.users.insert({ id, name: id });
    throw new Error("inner failure");
  }

  @Transactional({ propagation: TransactionPropagation.REQUIRES_NEW })
  public async requiresNew(id: string): Promise<void> {
    await this.users.insert({ id, name: id });
  }

  @Transactional({ propagation: TransactionPropagation.NOT_SUPPORTED })
  public async notSupported(id: string): Promise<boolean> {
    const suspended = this.transactions.currentStatus() == null;
    await this.users.insert({ id, name: id });
    return suspended;
  }

  @Transactional({ propagation: TransactionPropagation.SUPPORTS })
  public async supports(id: string): Promise<boolean> {
    const active = this.transactions.currentStatus()?.active ?? false;
    await this.users.insert({ id, name: id });
    return active;
  }

  @Transactional({ propagation: TransactionPropagation.MANDATORY })
  public async mandatory(): Promise<boolean> {
    return this.transactions.currentStatus()?.active ?? false;
  }
}

@Injectable()
class OuterService {
  public constructor(
    private readonly inner: InnerService,
    @InjectDuraxisRepository(User) private readonly users: Repository<User>,
  ) {}

  @Transactional()
  public async catchesRequiredFailure(outerId: string, innerId: string): Promise<void> {
    await this.users.insert({ id: outerId, name: outerId });
    try {
      await this.inner.requiredFailure(innerId);
    } catch {}
  }

  @Transactional()
  public async rollsBackAroundRequiresNew(outerId: string, innerId: string): Promise<void> {
    await this.users.insert({ id: outerId, name: outerId });
    await this.inner.requiresNew(innerId);
    throw new Error("outer failure");
  }

  @Transactional()
  public async callsNotSupported(outerId: string, innerId: string): Promise<boolean> {
    await this.users.insert({ id: outerId, name: outerId });
    const suspended = await this.inner.notSupported(innerId);
    throw Object.assign(new Error("outer failure"), { suspended });
  }

  @Transactional()
  public async callsMandatory(): Promise<boolean> {
    return await this.inner.mandatory();
  }

  @Transactional()
  public async callsSupports(outerId: string, innerId: string): Promise<boolean> {
    await this.users.insert({ id: outerId, name: outerId });
    return await this.inner.supports(innerId);
  }
}

async function compile(): Promise<TestingModule> {
  return await Test.createTestingModule({
    imports: [
      DuraxisModule.forRoot({
        driver: new MemoryStorageDriver(),
        autoLoadEntities: true,
        schema: { mode: "create" },
      }),
      DuraxisModule.forFeature([User, Wallet]),
    ],
    providers: [
      TransactionalService,
      InnerService,
      OuterService,
      ClassTransactionalService,
      DerivedTransactionalService,
    ],
  }).compile();
}

describe("declarative transactions", () => {
  it("commits atomically and gives injected repositories read-your-writes", async () => {
    const module = await compile();
    try {
      await module.get(TransactionalService).create("committed");
      const users = module.get<Repository<User>>(getDuraxisRepositoryToken(User));
      expect((await users.findById("committed"))?.name).toBe("committed");
    } finally {
      await module.close();
    }
  });

  it("rolls back all repositories when a method fails", async () => {
    const module = await compile();
    try {
      await expect(module.get(TransactionalService).atomicFailure("atomic")).rejects.toThrow(
        "second operation failed",
      );
      expect(
        await module.get<Repository<User>>(getDuraxisRepositoryToken(User)).findById("atomic"),
      ).toBeNull();
      expect(
        await module.get<Repository<Wallet>>(getDuraxisRepositoryToken(Wallet)).findById("atomic"),
      ).toBeNull();
    } finally {
      await module.close();
    }
  });

  it("marks a shared REQUIRED transaction rollback-only", async () => {
    const module = await compile();
    try {
      await expect(
        module.get(OuterService).catchesRequiredFailure("outer", "inner"),
      ).rejects.toBeInstanceOf(UnexpectedTransactionRollbackError);
      const users = module.get<Repository<User>>(getDuraxisRepositoryToken(User));
      expect(await users.findById("outer")).toBeNull();
      expect(await users.findById("inner")).toBeNull();
    } finally {
      await module.close();
    }
  });

  it("commits REQUIRES_NEW independently and restores the outer context", async () => {
    const module = await compile();
    try {
      await expect(
        module.get(OuterService).rollsBackAroundRequiresNew("outer-new", "inner-new"),
      ).rejects.toThrow("outer failure");
      const users = module.get<Repository<User>>(getDuraxisRepositoryToken(User));
      expect(await users.findById("outer-new")).toBeNull();
      expect((await users.findById("inner-new"))?.id).toBe("inner-new");
    } finally {
      await module.close();
    }
  });

  it("suspends the context for NOT_SUPPORTED while the outer transaction rolls back", async () => {
    const module = await compile();
    try {
      await expect(
        module.get(OuterService).callsNotSupported("outer-suspended", "inner-suspended"),
      ).rejects.toMatchObject({ suspended: true });
      const users = module.get<Repository<User>>(getDuraxisRepositoryToken(User));
      expect(await users.findById("outer-suspended")).toBeNull();
      expect((await users.findById("inner-suspended"))?.id).toBe("inner-suspended");
    } finally {
      await module.close();
    }
  });

  it("implements SUPPORTS, MANDATORY and NEVER boundaries", async () => {
    const module = await compile();
    try {
      const inner = module.get(InnerService);
      const service = module.get(TransactionalService);
      expect(await inner.supports("supports-outside")).toBe(false);
      await expect(service.mandatory()).rejects.toBeInstanceOf(TransactionRequiredError);
      expect(await module.get(OuterService).callsMandatory()).toBe(true);
      expect(await module.get(OuterService).callsSupports("supports-outer", "supports-inner")).toBe(
        true,
      );
      expect(await service.never()).toBe(true);
      await expect(
        module
          .get<TransactionManager>(getDuraxisTransactionManagerToken())
          .execute({}, "test", async () => await service.never()),
      ).rejects.toBeInstanceOf(ExistingTransactionError);
    } finally {
      await module.close();
    }
  });

  it("enforces read-only, isolation, timeout and NESTED limitations", async () => {
    const module = await compile();
    try {
      const service = module.get(TransactionalService);
      await expect(service.writeReadOnly("read-only")).rejects.toBeInstanceOf(
        ReadOnlyTransactionError,
      );
      expect(await service.snapshot()).toBe(true);
      await expect(service.unsupportedIsolation()).rejects.toBeInstanceOf(
        UnsupportedTransactionIsolationError,
      );
      await expect(service.timeout()).rejects.toBeInstanceOf(UnsupportedTransactionTimeoutError);
      await expect(service.nested()).rejects.toBeInstanceOf(NestedTransactionNotSupportedError);
    } finally {
      await module.close();
    }
  });

  it("commits for noRollbackFor and still propagates the original exception", async () => {
    const module = await compile();
    try {
      const failure = module.get(TransactionalService).commitAndThrow("committed-error");
      await expect(failure).rejects.toBeInstanceOf(ValidationError);
      expect(
        (
          await module
            .get<Repository<User>>(getDuraxisRepositoryToken(User))
            .findById("committed-error")
        )?.id,
      ).toBe("committed-error");
    } finally {
      await module.close();
    }
  });

  it("uses the most specific rollback rule", async () => {
    const module = await compile();
    try {
      await expect(
        module.get(TransactionalService).specificRollbackRule("specific-rule"),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(
        await module
          .get<Repository<User>>(getDuraxisRepositoryToken(User))
          .findById("specific-rule"),
      ).toBeNull();
    } finally {
      await module.close();
    }
  });

  it("rejects imperative transactions nested inside declarative ones", async () => {
    const module = await compile();
    try {
      await expect(
        module.get(TransactionalService).imperativeInsideDeclarative(),
      ).rejects.toBeInstanceOf(UnsupportedMixedTransactionError);
    } finally {
      await module.close();
    }
  });

  it("supports the Transaction alias and rejects synchronous method contracts", async () => {
    const module = await compile();
    try {
      const service = module.get(TransactionalService);
      expect(await service.aliasStatus()).toBe(true);
      await expect(service.syncMethod()).rejects.toBeInstanceOf(TransactionalMethodReturnTypeError);
    } finally {
      await module.close();
    }
  });

  it("supports class metadata, method overrides and inherited methods", async () => {
    const module = await compile();
    try {
      expect(await module.get(ClassTransactionalService).inheritedDefault()).toBe(true);
      expect(await module.get(ClassTransactionalService).methodOverride()).toBe(true);
      expect(await module.get(DerivedTransactionalService).inheritedMethod()).toBe(true);
    } finally {
      await module.close();
    }
  });

  it("rejects unawaited operations instead of committing before they complete", async () => {
    const module = await compile();
    try {
      await expect(module.get(TransactionalService).unawaited("unawaited")).rejects.toBeInstanceOf(
        UnawaitedTransactionOperationError,
      );
      expect(
        await module.get<Repository<User>>(getDuraxisRepositoryToken(User)).findById("unawaited"),
      ).toBeNull();
    } finally {
      await module.close();
    }
  });

  it("prevents a transaction-captured QueryBuilder from escaping its scope", async () => {
    const module = await compile();
    try {
      const builder = await module.get(TransactionalService).returnBuilder();
      expect(() => builder.getMany()).toThrow(TransactionContextClosedError);
    } finally {
      await module.close();
    }
  });

  it("intercepts self-invocation and rolls back the inner transactional boundary", async () => {
    const module = await compile();
    try {
      await expect(module.get(TransactionalService).callSelf("self")).rejects.toThrow(
        "self invocation",
      );
      expect(
        await module.get<Repository<User>>(getDuraxisRepositoryToken(User)).findById("self"),
      ).toBeNull();
    } finally {
      await module.close();
    }
  });

  it("isolates concurrent AsyncLocalStorage contexts under Promise.all", async () => {
    const module = await compile();
    try {
      let enteredCount = 0;
      let release!: () => void;
      let bothEntered!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const enteredPromise = new Promise<void>((resolve) => {
        bothEntered = resolve;
      });
      const entered = (): void => {
        enteredCount++;
        if (enteredCount == 2) bothEntered();
      };
      const service = module.get(TransactionalService);
      const rollingBack = service.concurrent("parallel-rollback", entered, releasePromise, true);
      const committing = service.concurrent("parallel-commit", entered, releasePromise, false);
      await enteredPromise;
      release();
      const outcomes = await Promise.allSettled([rollingBack, committing]);
      expect(outcomes[0]?.status).toBe("rejected");
      expect(outcomes[1]?.status).toBe("fulfilled");
      const users = module.get<Repository<User>>(getDuraxisRepositoryToken(User));
      expect(await users.findById("parallel-rollback")).toBeNull();
      expect((await users.findById("parallel-commit"))?.id).toBe("parallel-commit");
    } finally {
      await module.close();
    }
  });

  it("waits for active transactions during shutdown and rejects new transactions", async () => {
    const module = await compile();
    let release!: () => void;
    let entered!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = module.get(TransactionalService);
    const active = service.concurrent("shutdown-active", entered, releasePromise, false);
    await enteredPromise;
    let closed = false;
    const closing = (async () => {
      await module.close();
      closed = true;
    })();
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await active;
    await closing;
    expect(closed).toBe(true);
  });

  it("preserves optimistic conflicts and never retries the method callback", async () => {
    const module = await compile();
    try {
      const users = module.get<Repository<User>>(getDuraxisRepositoryToken(User));
      await users.insert({ id: "conflict", name: "initial" });
      let enteredCount = 0;
      let methodCalls = 0;
      let release!: () => void;
      let bothEntered!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const enteredPromise = new Promise<void>((resolve) => {
        bothEntered = resolve;
      });
      const entered = (): void => {
        methodCalls++;
        enteredCount++;
        if (enteredCount == 2) bothEntered();
      };
      const service = module.get(TransactionalService);
      const first = service.concurrentUpdate("conflict", "first", entered, releasePromise);
      const second = service.concurrentUpdate("conflict", "second", entered, releasePromise);
      await enteredPromise;
      release();
      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes.filter((outcome) => outcome.status == "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status == "rejected");
      expect(rejected?.status == "rejected" && rejected.reason).toBeInstanceOf(
        TransactionConflictError,
      );
      expect(methodCalls).toBe(2);
    } finally {
      await module.close();
    }
  });

  it("preserves CommitOutcomeUnknownError from the core", async () => {
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
    const module = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          driver: storage,
          autoLoadEntities: true,
          schema: { mode: "create" },
        }),
        DuraxisModule.forFeature([User, Wallet]),
      ],
      providers: [TransactionalService],
    }).compile();
    try {
      storage.armed = true;
      await expect(module.get(TransactionalService).create("unknown")).rejects.toBeInstanceOf(
        CommitOutcomeUnknownError,
      );
    } finally {
      storage.armed = false;
      await module.close();
    }
  });

  it("does not leak transaction context between independent Nest applications", async () => {
    const [rollingBackApplication, committingApplication] = await Promise.all([
      compile(),
      compile(),
    ]);
    try {
      const outcomes = await Promise.allSettled([
        rollingBackApplication.get(TransactionalService).atomicFailure("app-isolated"),
        committingApplication.get(TransactionalService).create("app-isolated"),
      ]);
      expect(outcomes[0]?.status).toBe("rejected");
      expect(outcomes[1]?.status).toBe("fulfilled");
      expect(
        await rollingBackApplication
          .get<Repository<User>>(getDuraxisRepositoryToken(User))
          .findById("app-isolated"),
      ).toBeNull();
      expect(
        (
          await committingApplication
            .get<Repository<User>>(getDuraxisRepositoryToken(User))
            .findById("app-isolated")
        )?.id,
      ).toBe("app-isolated");
    } finally {
      await Promise.all([rollingBackApplication.close(), committingApplication.close()]);
    }
  });

  it("selects and isolates the declarative manager for a named connection", async () => {
    @Injectable()
    class PrimaryService {
      public constructor(
        @InjectDuraxisRepository(User, "primary-tx")
        private readonly users: Repository<User>,
        @InjectDuraxisTransactionManager("primary-tx")
        private readonly transactions: TransactionManager,
      ) {}

      @Transactional({ connectionName: "primary-tx" })
      public async create(): Promise<string | undefined> {
        await this.users.insert({ id: "named", name: "primary" });
        return this.transactions.currentStatus()?.connectionName;
      }
    }

    const module = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          name: "primary-tx",
          driver: new MemoryStorageDriver(),
          autoLoadEntities: true,
          schema: { mode: "create" },
        }),
        DuraxisModule.forFeature([User], "primary-tx"),
        DuraxisModule.forRoot({
          name: "analytics-tx",
          driver: new MemoryStorageDriver(),
          autoLoadEntities: true,
          schema: { mode: "create" },
        }),
        DuraxisModule.forFeature([User], "analytics-tx"),
      ],
      providers: [PrimaryService],
    }).compile();
    try {
      expect(await module.get(PrimaryService).create()).toBe("primary-tx");
      expect(
        (
          await module
            .get<Repository<User>>(getDuraxisRepositoryToken(User, "primary-tx"))
            .findById("named")
        )?.name,
      ).toBe("primary");
      expect(
        await module
          .get<Repository<User>>(getDuraxisRepositoryToken(User, "analytics-tx"))
          .findById("named"),
      ).toBeNull();
    } finally {
      await module.close();
    }
  });

  it("supports standard transactional providers without repositories", async () => {
    @Injectable()
    class StatusService {
      public constructor(
        @InjectDuraxisTransactionManager() private readonly transactions: TransactionManager,
      ) {}

      @Transactional()
      public async active(): Promise<boolean> {
        return this.transactions.currentStatus()?.active ?? false;
      }
    }

    const module = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRoot({
          driver: new MemoryStorageDriver(),
          entities: [],
          schema: { mode: "create" },
        }),
      ],
      providers: [StatusService],
    }).compile();
    try {
      expect(await module.get(StatusService).active()).toBe(true);
    } finally {
      await module.close();
    }
  });
});

describe("declarative transactions with AsyncDiskStorageDriver", () => {
  it("proves atomic rollback, closes the lock, and reopens committed data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "duraxis-nestjs-transaction-"));
    let first: TestingModule | undefined;
    let reopened: TestingModule | undefined;
    try {
      first = await Test.createTestingModule({
        imports: [
          DuraxisModule.forRoot({
            driver: () => AsyncDiskStorageDriver.open({ directory }),
            autoLoadEntities: true,
            schema: { mode: "create" },
          }),
          DuraxisModule.forFeature([User, Wallet]),
        ],
        providers: [TransactionalService],
      }).compile();
      const service = first.get(TransactionalService);
      await expect(service.atomicFailure("rolled-back-disk")).rejects.toThrow(
        "second operation failed",
      );
      await service.create("committed-disk");
      await first.close();
      first = undefined;

      reopened = await Test.createTestingModule({
        imports: [
          DuraxisModule.forRoot({
            driver: () => AsyncDiskStorageDriver.open({ directory }),
            entities: [User, Wallet],
            schema: { mode: "validate" },
          }),
          DuraxisModule.forFeature([User, Wallet]),
        ],
      }).compile();
      const users = reopened.get<Repository<User>>(getDuraxisRepositoryToken(User));
      const wallets = reopened.get<Repository<Wallet>>(getDuraxisRepositoryToken(Wallet));
      expect(await users.findById("rolled-back-disk")).toBeNull();
      expect(await wallets.findById("rolled-back-disk")).toBeNull();
      expect((await users.findById("committed-disk"))?.id).toBe("committed-disk");
    } finally {
      await first?.close();
      await reopened?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
