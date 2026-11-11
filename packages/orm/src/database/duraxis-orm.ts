import { UniqueIndexViolationError } from "@duraxis/core";
import {
  OrmClosedError,
  OrmNotInitializedError,
  UniqueIndexViolationOrmError,
} from "../errors/index.js";
import type { EntityClass } from "../metadata/entity-metadata.js";
import { MetadataRegistry } from "../metadata/metadata-registry.js";
import { Repository } from "../repository/repository.js";
import { SchemaManager } from "../schema/schema-manager.js";
import { OrmTransactionManager } from "../transactions/orm-transaction.js";
import type { TransactionContext } from "../transactions/transaction-context.js";
import type { DuraxisOrmOptions } from "./orm-options.js";

type Lifecycle = "new" | "initializing" | "initialized" | "closed";

export class DuraxisORM {
  readonly #registry: MetadataRegistry;
  readonly #repositories = new Map<Function, unknown>();
  #lifecycle: Lifecycle = "new";
  #initialization?: Promise<void>;

  public constructor(private readonly options: DuraxisOrmOptions) {
    this.#registry = new MetadataRegistry(options.entities).finalize();
  }

  public initialize(): Promise<void> {
    if (this.#lifecycle == "closed") return Promise.reject(new OrmClosedError());
    if (this.#lifecycle == "initialized") return Promise.resolve();
    if (this.#initialization) return this.#initialization;

    this.#lifecycle = "initializing";

    this.#initialization = (async (): Promise<void> => {
      try {
        await new SchemaManager(
          this.options.database,
          this.#registry,
          this.options.schema?.mode ?? "validate",
        ).initialize();

        if (this.#lifecycle == "closed") throw new OrmClosedError();

        this.#lifecycle = "initialized";
      } catch (error) {
        if (this.#lifecycle != "closed") this.#lifecycle = "new";
        this.#initialization = undefined;
        throw error;
      }
    })();

    return this.#initialization;
  }

  public getRepository<TEntity extends object>(entity: EntityClass<TEntity>): Repository<TEntity> {
    this.assertReady();

    const cached = this.#repositories.get(entity);

    if (cached) return cached as Repository<TEntity>;

    const repository = new Repository(this.#registry.get(entity), {
      database: this.options.database,
      assertUsable: () => this.assertReady(),
    });

    this.#repositories.set(entity, repository);
    return repository;
  }

  public async transaction<TResult>(
    callback: (manager: TransactionContext) => Promise<TResult> | TResult,
  ): Promise<TResult> {
    this.assertReady();

    try {
      return await this.options.database.transaction(async (transaction) => {
        const manager = new OrmTransactionManager(
          this.options.database,
          transaction,
          this.#registry,
        );

        try {
          return await callback(manager);
        } finally {
          manager.close();
        }
      });
    } catch (cause) {
      if (cause instanceof UniqueIndexViolationError)
        throw new UniqueIndexViolationOrmError(cause.message, cause);

      throw cause;
    }
  }

  public async close(): Promise<void> {
    if (this.#lifecycle == "closed") return;

    const initialization = this.#initialization;

    if (initialization) await initialization.catch(() => undefined);

    this.#lifecycle = "closed";
    this.#repositories.clear();

    if (this.options.closeDatabase || this.options.closeStorage)
      await this.options.database.close({ closeStorage: this.options.closeStorage ?? false });
  }

  public get metadata(): MetadataRegistry {
    return this.#registry;
  }

  private assertReady(): void {
    if (this.#lifecycle == "closed") throw new OrmClosedError();
    if (this.#lifecycle != "initialized") throw new OrmNotInitializedError();
  }
}
