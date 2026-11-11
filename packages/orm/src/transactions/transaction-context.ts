import type { EntityClass } from "../metadata/entity-metadata.js";
import type { Repository } from "../repository/repository.js";

export interface TransactionContext {
  getRepository<TEntity extends object>(entity: EntityClass<TEntity>): Repository<TEntity>;
}
