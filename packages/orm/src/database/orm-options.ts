import type { DuraxisDatabase } from "@duraxis/core";
import type { EntityClass } from "../metadata/entity-metadata.js";
import type { SchemaMode } from "../schema/schema-manager.js";

export interface DuraxisOrmOptions {
  readonly database: DuraxisDatabase;
  readonly entities: readonly EntityClass[];
  readonly schema?: {
    readonly mode: SchemaMode;
  };
  readonly closeDatabase?: boolean;
  readonly closeStorage?: boolean;
}
