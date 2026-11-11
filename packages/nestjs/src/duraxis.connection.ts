import type { OnApplicationShutdown, OnModuleDestroy } from "@nestjs/common";
import { DuraxisDatabase } from "@duraxis/core";
import { DuraxisORM } from "@duraxis/orm";
import type { StorageDriver } from "@duraxis/storage";
import type { DuraxisModuleOptions } from "./duraxis.interfaces.js";

function isStorageDriver(value: unknown): value is StorageDriver {
  if (typeof value != "object" || value == null) return false;
  return ["get", "put", "delete", "list"].every(
    (method) => method in value && typeof Reflect.get(value, method) == "function",
  );
}

export class DuraxisNestConnection implements OnModuleDestroy, OnApplicationShutdown {
  #closing?: Promise<void>;

  private constructor(
    public readonly name: string,
    public readonly database: DuraxisDatabase,
    public readonly orm: DuraxisORM,
    private readonly onClosed: () => void,
  ) {}

  public static async create(
    name: string,
    options: DuraxisModuleOptions,
    onClosed: () => void = () => {},
  ): Promise<DuraxisNestConnection> {
    const driverIsFactory = typeof options.driver == "function";
    const closeStorage = options.closeStorage ?? driverIsFactory;
    let driver: StorageDriver | undefined;
    let database: DuraxisDatabase | undefined;
    let orm: DuraxisORM | undefined;

    try {
      driver = driverIsFactory ? await options.driver() : options.driver;
      if (!isStorageDriver(driver))
        throw new TypeError("Duraxis driver factory returned an invalid StorageDriver");

      database = new DuraxisDatabase({
        ...options.database,
        storage: driver,
      });
      orm = new DuraxisORM({
        database,
        entities: options.entities,
        ...(options.schema == null ? {} : { schema: options.schema }),
        closeDatabase: true,
        closeStorage,
      });
      await orm.initialize();
      return new DuraxisNestConnection(name, database, orm, onClosed);
    } catch (cause) {
      try {
        if (orm) await orm.close();
        else if (database) await database.close({ closeStorage });
        else if (driver && closeStorage) await driver.close?.();
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          `Duraxis connection ${name} initialization and cleanup both failed`,
        );
      }
      throw cause;
    }
  }

  public async close(): Promise<void> {
    if (!this.#closing) this.#closing = this.closeResources();
    await this.#closing;
  }

  private async closeResources(): Promise<void> {
    await this.orm.close();
    this.onClosed();
  }

  public async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
