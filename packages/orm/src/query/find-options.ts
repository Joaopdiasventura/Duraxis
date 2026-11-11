import type { EntityProperty } from "../metadata/entity-metadata.js";
import type { Where } from "./where-operator.js";

export type SortDirection = "ASC" | "DESC";

export interface FindOptions<TEntity extends object> {
  readonly where?: Where<TEntity>;
  readonly orderBy?: Partial<Record<EntityProperty<TEntity>, SortDirection>>;
  readonly projection?: readonly EntityProperty<TEntity>[];
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface FindPage<TEntity extends object> {
  readonly items: readonly TEntity[];
  readonly nextCursor: string | null;
}
