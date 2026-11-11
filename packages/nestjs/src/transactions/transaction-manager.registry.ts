import { TransactionManagerNotFoundError } from "./transaction.errors.js";
import type { TransactionManager } from "./transaction.manager.js";

export class TransactionManagerRegistry {
  readonly #managers = new Map<string, TransactionManager>();

  public register(connectionName: string, manager: TransactionManager): void {
    this.#managers.set(connectionName, manager);
  }

  public unregister(connectionName: string, manager: TransactionManager): void {
    if (this.#managers.get(connectionName) == manager) this.#managers.delete(connectionName);
  }

  public get(connectionName: string): TransactionManager {
    const manager = this.#managers.get(connectionName);
    if (!manager) throw new TransactionManagerNotFoundError(connectionName);
    return manager;
  }
}
