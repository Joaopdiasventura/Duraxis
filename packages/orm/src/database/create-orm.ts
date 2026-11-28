import {
  createDatabase,
  normalizeDuraxisConnection,
  selectDuraxisConnection,
  type DuraxisConfiguration,
} from "@duraxis/core";
import { discoverEntities } from "../discovery.js";
import { DuraxisORM } from "./duraxis-orm.js";

export async function createORM(config: DuraxisConfiguration, name?: string): Promise<DuraxisORM> {
  const options = normalizeDuraxisConnection(selectDuraxisConnection(config, name));
  const entities = await discoverEntities(options);
  const database = await createDatabase(options);

  try {
    const orm = new DuraxisORM({
      database,
      entities,
      schema: options.schema,
      closeDatabase: true,
      closeStorage: options.closeStorage ?? typeof options.driver === "function",
    });

    await orm.initialize();

    return orm;
  } catch (cause) {
    try {
      await database.close();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], "ORM initialization and cleanup failed");
    }

    throw cause;
  }
}
