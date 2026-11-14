import type { DuraxisORM, EntityClass, Repository, TransactionContext } from "@duraxis/orm";
import type { DuraxisNestConnection } from "../duraxis.connection.js";
import { normalizeDuraxisConnectionName } from "../duraxis.tokens.js";
import {
  ExistingTransactionError,
  NestedTransactionNotSupportedError,
  ReadOnlyTransactionError,
  TransactionContextClosedError,
  TransactionManagerShuttingDownError,
  TransactionRequiredError,
  TransactionalMethodReturnTypeError,
  UnawaitedTransactionOperationError,
  UnexpectedTransactionRollbackError,
  UnsupportedMixedTransactionError,
  UnsupportedTransactionIsolationError,
  UnsupportedTransactionTimeoutError,
} from "./transaction.errors.js";
import {
  TransactionContextManager,
  type PhysicalTransactionState,
  type TransactionExecutionContext,
} from "./transaction-context.manager.js";
import {
  TransactionIsolation,
  TransactionPropagation,
  type ErrorConstructor,
  type TransactionStatus,
  type TransactionalOptions,
} from "./transaction.types.js";
import {
  createTransactionAwareOrm,
  createTransactionAwareRepository,
} from "./transaction-aware.repository.js";

class RollbackOnlyAbort extends Error {}

type PhysicalOutcome<TResult> =
  | { readonly type: "result"; readonly value: TResult }
  | { readonly type: "committed-error"; readonly error: unknown };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value == "object" || typeof value == "function") &&
    value != null &&
    typeof Reflect.get(value, "then") == "function"
  );
}

function inheritanceDistance(error: Error, constructor: ErrorConstructor): number {
  if (!(error instanceof constructor)) return Number.POSITIVE_INFINITY;

  let distance = 0;
  let prototype: object | null = Object.getPrototypeOf(error);

  while (prototype && prototype != constructor.prototype) {
    prototype = Object.getPrototypeOf(prototype);
    distance++;
  }

  return distance;
}

function shouldRollback(error: unknown, options: TransactionalOptions): boolean {
  if (!(error instanceof Error)) return true;

  let bestDistance = Number.POSITIVE_INFINITY;
  let rollback = true;

  for (const constructor of options.rollbackFor ?? []) {
    const distance = inheritanceDistance(error, constructor);

    if (distance < bestDistance) {
      bestDistance = distance;
      rollback = true;
    }
  }

  for (const constructor of options.noRollbackFor ?? []) {
    const distance = inheritanceDistance(error, constructor);

    if (Number.isFinite(distance) && distance <= bestDistance) {
      bestDistance = distance;
      rollback = false;
    }
  }

  return rollback;
}

export class TransactionManager {
  readonly #repositories = new Map<Function, unknown>();
  readonly #ormFacade: DuraxisORM;
  #accepting = true;
  #activePhysicalTransactions = 0;
  readonly #shutdownWaiters = new Set<() => void>();

  public constructor(
    public readonly connectionName: string,
    private readonly connection: DuraxisNestConnection,
    private readonly orm: DuraxisORM,
    private readonly contexts: TransactionContextManager,
  ) {
    this.#ormFacade = createTransactionAwareOrm(orm, this);
  }

  public get ormProxy(): DuraxisORM {
    return this.#ormFacade;
  }

  public getRepository<TEntity extends object>(entity: EntityClass<TEntity>): Repository<TEntity> {
    const cached = this.#repositories.get(entity);

    if (cached) return cached as Repository<TEntity>;

    const repository = createTransactionAwareRepository(
      entity,
      this.orm.getRepository(entity),
      this,
    );

    this.#repositories.set(entity, repository);

    return repository;
  }

  public currentContext(): TransactionExecutionContext | undefined {
    const context = this.contexts.current(this.connection);
    if (context && !context.physical.active) throw new TransactionContextClosedError();
    return context;
  }

  public currentStatus(): TransactionStatus | null {
    const context = this.currentContext();

    return context
      ? {
          connectionName: this.connectionName,
          active: context.physical.active,
          newTransaction: context.newTransaction,
          readOnly: context.readOnly,
          rollbackOnly: context.physical.rollbackOnly,
        }
      : null;
  }

  public setRollbackOnly(): void {
    const context = this.currentContext();
    if (!context) throw new TransactionRequiredError(this.connectionName);
    context.physical.rollbackOnly = true;
  }

  public async execute<TResult>(
    options: TransactionalOptions,
    methodName: string,
    invocation: () => unknown,
  ): Promise<TResult> {
    this.validateOptions(options);

    const current = this.currentContext();

    if (!this.#accepting && !current) throw new TransactionManagerShuttingDownError();

    const propagation = options.propagation ?? TransactionPropagation.REQUIRED;

    switch (propagation) {
      case TransactionPropagation.REQUIRED:
        return current
          ? await this.join<TResult>(current, options, methodName, invocation)
          : await this.start<TResult>(options, methodName, invocation);

      case TransactionPropagation.REQUIRES_NEW:
        return await this.start<TResult>(options, methodName, invocation);

      case TransactionPropagation.SUPPORTS:
        return current
          ? await this.join<TResult>(current, options, methodName, invocation)
          : await this.invoke<TResult>(methodName, invocation);

      case TransactionPropagation.MANDATORY:
        if (!current) throw new TransactionRequiredError(this.connectionName);
        return await this.join<TResult>(current, options, methodName, invocation);

      case TransactionPropagation.NOT_SUPPORTED:
        return current
          ? await this.contexts.suspend(
              this.connection,
              async () => await this.invoke<TResult>(methodName, invocation),
            )
          : await this.invoke<TResult>(methodName, invocation);

      case TransactionPropagation.NEVER:
        if (current) throw new ExistingTransactionError(this.connectionName);
        return await this.invoke<TResult>(methodName, invocation);

      case TransactionPropagation.NESTED:
        throw new NestedTransactionNotSupportedError();
    }
  }

  public resolveRepository<TEntity extends object>(
    entity: EntityClass<TEntity>,
    baseRepository: Repository<TEntity>,
  ): Repository<TEntity> {
    const context = this.currentContext();
    return context ? context.physical.manager.getRepository(entity) : baseRepository;
  }

  public assertWriteAllowed(operation: string): void {
    if (this.currentContext()?.readOnly) throw new ReadOnlyTransactionError(operation);
  }

  public assertCapturedContext(captured: TransactionExecutionContext | undefined): void {
    if (!captured) return;

    const current = this.currentContext();

    if (!captured.physical.active || current?.physical != captured.physical)
      throw new TransactionContextClosedError();
  }

  public track(value: PromiseLike<unknown>): Promise<unknown> {
    const context = this.currentContext();
    const promise = Promise.resolve(value);

    if (!context) return promise;

    let tracked!: Promise<unknown>;

    tracked = (async () => {
      try {
        return await promise;
      } finally {
        context.physical.pending.delete(tracked);
      }
    })();

    context.physical.pending.add(tracked);

    return tracked;
  }

  public rejectMixedTransaction(): never {
    throw new UnsupportedMixedTransactionError();
  }

  public async shutdown(): Promise<void> {
    this.#accepting = false;

    if (this.#activePhysicalTransactions == 0) return;

    await new Promise<void>((resolve) => this.#shutdownWaiters.add(resolve));
  }

  private async start<TResult>(
    options: TransactionalOptions,
    methodName: string,
    invocation: () => unknown,
  ): Promise<TResult> {
    if (!this.#accepting) throw new TransactionManagerShuttingDownError();

    this.#activePhysicalTransactions++;

    try {
      const outcome = await this.orm.transaction(async (manager) => {
        const physical: PhysicalTransactionState = {
          manager,
          pending: new Set(),
          active: true,
          rollbackOnly: false,
        };

        const context: TransactionExecutionContext = {
          physical,
          readOnly: options.readOnly ?? false,
          newTransaction: true,
        };

        try {
          return await this.contexts.run(this.connection, context, async () => {
            try {
              const value = await this.invoke<TResult>(methodName, invocation);

              await this.rejectPendingOperations(physical);

              if (physical.rollbackOnly) throw new RollbackOnlyAbort();

              return { type: "result", value } satisfies PhysicalOutcome<TResult>;
            } catch (error) {
              await this.rejectPendingOperations(physical);

              if (error instanceof RollbackOnlyAbort || shouldRollback(error, options)) throw error;
              if (physical.rollbackOnly) throw new RollbackOnlyAbort();

              return { type: "committed-error", error } satisfies PhysicalOutcome<TResult>;
            }
          });
        } finally {
          physical.active = false;
        }
      });

      if (outcome.type == "committed-error") throw outcome.error;
      return outcome.value;
    } catch (error) {
      if (error instanceof RollbackOnlyAbort) throw new UnexpectedTransactionRollbackError();
      throw error;
    } finally {
      this.#activePhysicalTransactions--;

      if (this.#activePhysicalTransactions == 0)
        for (const resolve of this.#shutdownWaiters) resolve();

      if (this.#activePhysicalTransactions == 0) this.#shutdownWaiters.clear();
    }
  }

  private async join<TResult>(
    current: TransactionExecutionContext,
    options: TransactionalOptions,
    methodName: string,
    invocation: () => unknown,
  ): Promise<TResult> {
    const context: TransactionExecutionContext = {
      physical: current.physical,
      readOnly: current.readOnly || (options.readOnly ?? false),
      newTransaction: false,
    };

    return await this.contexts.run(this.connection, context, async () => {
      try {
        return await this.invoke<TResult>(methodName, invocation);
      } catch (error) {
        if (shouldRollback(error, options)) current.physical.rollbackOnly = true;
        throw error;
      }
    });
  }

  private async invoke<TResult>(methodName: string, invocation: () => unknown): Promise<TResult> {
    const result = invocation();
    if (!isPromiseLike(result)) throw new TransactionalMethodReturnTypeError(methodName);
    return (await result) as TResult;
  }

  private async rejectPendingOperations(physical: PhysicalTransactionState): Promise<void> {
    if (physical.pending.size == 0) return;

    const results = await Promise.allSettled([...physical.pending]);
    const rejected = results.find((result) => result.status == "rejected");

    throw new UnawaitedTransactionOperationError(
      rejected?.status == "rejected" ? { cause: rejected.reason } : undefined,
    );
  }

  private validateOptions(options: TransactionalOptions): void {
    if (options.timeout != null) throw new UnsupportedTransactionTimeoutError();

    const isolation = options.isolation ?? TransactionIsolation.DEFAULT;

    if (isolation != TransactionIsolation.DEFAULT && isolation != TransactionIsolation.SNAPSHOT)
      throw new UnsupportedTransactionIsolationError(String(isolation));

    if (options.connectionName != null) normalizeDuraxisConnectionName(options.connectionName);
  }
}
