import { AsyncLocalStorage } from "node:async_hooks";
import type { TransactionContext } from "@duraxis/orm";

export interface PhysicalTransactionState {
  readonly manager: TransactionContext;
  readonly pending: Set<Promise<unknown>>;
  active: boolean;
  rollbackOnly: boolean;
}

export interface TransactionExecutionContext {
  readonly physical: PhysicalTransactionState;
  readonly readOnly: boolean;
  readonly newTransaction: boolean;
}

export class TransactionContextManager {
  readonly #storage = new AsyncLocalStorage<ReadonlyMap<object, TransactionExecutionContext>>();

  public current(connectionIdentity: object): TransactionExecutionContext | undefined {
    return this.#storage.getStore()?.get(connectionIdentity);
  }

  public async run<TResult>(
    connectionIdentity: object,
    context: TransactionExecutionContext,
    callback: () => Promise<TResult>,
  ): Promise<TResult> {
    const contexts = new Map(this.#storage.getStore() ?? []);
    contexts.set(connectionIdentity, context);
    return await this.#storage.run(contexts, callback);
  }

  public async suspend<TResult>(
    connectionIdentity: object,
    callback: () => Promise<TResult>,
  ): Promise<TResult> {
    const contexts = new Map(this.#storage.getStore() ?? []);
    contexts.delete(connectionIdentity);
    return await this.#storage.run(contexts, callback);
  }
}
