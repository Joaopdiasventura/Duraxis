import { Global, Injectable, Module } from "@nestjs/common";
import { DuraxisNestConnection } from "./duraxis.connection.js";
import { DuplicateDuraxisConnectionError } from "./duraxis.errors.js";
import type { DuraxisModuleOptions } from "./duraxis.interfaces.js";
import { TransactionContextManager } from "./transactions/transaction-context.manager.js";
import { TransactionManagerRegistry } from "./transactions/transaction-manager.registry.js";

@Injectable()
export class DuraxisConnectionRegistry {
  readonly #active = new Map<string, Promise<DuraxisNestConnection>>();

  public async create(name: string, options: DuraxisModuleOptions): Promise<DuraxisNestConnection> {
    const existing = this.#active.get(name);
    if (existing) throw new DuplicateDuraxisConnectionError(name);

    let creation!: Promise<DuraxisNestConnection>;

    creation = DuraxisNestConnection.create(name, options, () => {
      if (this.#active.get(name) == creation) this.#active.delete(name);
    });

    this.#active.set(name, creation);

    try {
      return await creation;
    } catch (error) {
      if (this.#active.get(name) == creation) this.#active.delete(name);
      throw error;
    }
  }
}

@Global()
@Module({
  providers: [DuraxisConnectionRegistry, TransactionContextManager, TransactionManagerRegistry],
  exports: [DuraxisConnectionRegistry, TransactionContextManager, TransactionManagerRegistry],
})
export class DuraxisConnectionRegistryModule {}
