import type { EntityProperty } from "../metadata/entity-metadata.js";
import type { Where } from "./where-operator.js";

export type SortDirection = "ASC" | "DESC";

type RelatedObject<T> =
  NonNullable<T> extends readonly (infer TItem)[]
    ? TItem extends object
      ? TItem
      : never
    : NonNullable<T> extends object
      ? NonNullable<T>
      : never;

export type Relations<TEntity extends object> = {
  readonly [K in keyof TEntity]?: RelatedObject<TEntity[K]> extends never
    ? never
    : true | Relations<RelatedObject<TEntity[K]>>;
};

export interface FindOptions<TEntity extends object> {
  readonly where?: Where<TEntity>;
  readonly orderBy?: Partial<Record<EntityProperty<TEntity>, SortDirection>>;
  readonly projection?: readonly EntityProperty<TEntity>[];
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
  readonly relations?: Relations<TEntity>;
}

export interface FindPage<TEntity extends object> {
  readonly items: readonly TEntity[];
  readonly nextCursor: string | null;
}
