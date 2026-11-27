import type { DuraxisDatabase, Transaction } from "@duraxis/core";
import { TransactionManagerClosedError } from "../errors/index.js";
import type { EntityClass } from "../metadata/entity-metadata.js";
import type { MetadataRegistry } from "../metadata/metadata-registry.js";
import { Repository } from "../repository/repository.js";
import type { TransactionContext } from "./transaction-context.js";

export class OrmTransactionManager implements TransactionContext {
  readonly #repositories = new Map<Function, unknown>();
  #active = true;
  readonly #abort = () => this.close();

  public get signal(): AbortSignal {
    return this.transaction.signal;
  }

  public constructor(
    private readonly database: DuraxisDatabase,
    private readonly transaction: Transaction,
    private readonly registry: MetadataRegistry,
  ) {
    this.transaction.signal.addEventListener("abort", this.#abort, { once: true });
    if (this.transaction.signal.aborted) this.close();
  }

  public getRepository<TEntity extends object>(entity: EntityClass<TEntity>): Repository<TEntity> {
    this.assertActive();
    const cached = this.#repositories.get(entity);

    if (cached) return cached as Repository<TEntity>;

    const repository = new Repository(this.registry.get(entity), {
      database: this.database,
      transaction: this.transaction,
      registry: this.registry,
      assertUsable: () => this.assertActive(),
    });

    this.#repositories.set(entity, repository);

    return repository;
  }

  public close(): void {
    this.#active = false;
    this.transaction.signal.removeEventListener("abort", this.#abort);
    this.#repositories.clear();
  }

  private assertActive(): void {
    if (!this.#active || this.transaction.state != "ACTIVE")
      throw new TransactionManagerClosedError();
  }
}
