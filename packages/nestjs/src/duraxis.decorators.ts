import { Inject } from "@nestjs/common";
import type { EntityClass } from "@duraxis/orm";
import {
  getDuraxisDatabaseToken,
  getDuraxisOrmToken,
  getDuraxisRepositoryToken,
} from "./duraxis.tokens.js";

export function InjectDuraxisRepository<TEntity extends object>(
  entity: EntityClass<TEntity>,
  connectionName?: string,
): ParameterDecorator & PropertyDecorator {
  return Inject(getDuraxisRepositoryToken(entity, connectionName));
}

export function InjectDuraxisOrm(connectionName?: string): ParameterDecorator & PropertyDecorator {
  return Inject(getDuraxisOrmToken(connectionName));
}

export function InjectDuraxisDatabase(
  connectionName?: string,
): ParameterDecorator & PropertyDecorator {
  return Inject(getDuraxisDatabaseToken(connectionName));
}
