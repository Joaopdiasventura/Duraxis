import { Global, Injectable, Module } from "@nestjs/common";
import { DuraxisNestConnection } from "./duraxis.connection.js";
import { DuplicateDuraxisConnectionError } from "./duraxis.errors.js";
import type { DuraxisModuleOptions } from "./duraxis.interfaces.js";

@Injectable()
export class DuraxisConnectionRegistry {
  readonly #active = new Map<string, Promise<DuraxisNestConnection>>();

  public async create(name: string, options: DuraxisModuleOptions): Promise<DuraxisNestConnection> {
    const existing = this.#active.get(name);
    if (existing) {
      const duplicate = new DuplicateDuraxisConnectionError(name);
      try {
        const connection = await existing;
        await connection.close();
      } catch (cleanupCause) {
        throw new AggregateError(
          [duplicate, cleanupCause],
          `Duplicate Duraxis connection ${name} could not be cleaned up`,
        );
      }
      throw duplicate;
    }

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
  providers: [DuraxisConnectionRegistry],
  exports: [DuraxisConnectionRegistry],
})
export class DuraxisConnectionRegistryModule {}
