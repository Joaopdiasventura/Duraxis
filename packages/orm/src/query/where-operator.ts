import type { EntityProperty } from "../metadata/entity-metadata.js";

type Comparable = string | number | Date;
type Present<T> = Exclude<T, null | undefined>;

export type WhereOperator<T> = {
  readonly eq?: Present<T> | (null extends T ? null : never);
  readonly ne?: Present<T> | (null extends T ? null : never);
  readonly in?: readonly (Present<T> | (null extends T ? null : never))[];
  readonly isNull?: true;
  readonly isMissing?: true;
} & (Present<T> extends Comparable
  ? {
      readonly gt?: Present<T>;
      readonly gte?: Present<T>;
      readonly lt?: Present<T>;
      readonly lte?: Present<T>;
    }
  : object);

export type WhereValue<T> = Present<T> | (null extends T ? null : never) | WhereOperator<T>;

export type Where<TEntity extends object> = Partial<{
  readonly [K in EntityProperty<TEntity>]: WhereValue<TEntity[K]>;
}> & {
  readonly AND?: readonly Where<TEntity>[];
  readonly OR?: readonly Where<TEntity>[];
  readonly NOT?: Where<TEntity>;
};

export type QueryComparisonOperator<T> =
  | "eq"
  | "ne"
  | "in"
  | "isNull"
  | "isMissing"
  | (Present<T> extends Comparable ? "gt" | "gte" | "lt" | "lte" : never);

export type QueryComparisonValue<
  T,
  TOperator extends QueryComparisonOperator<T>,
> = TOperator extends "isNull" | "isMissing"
  ? never
  : TOperator extends "in"
    ? readonly (Present<T> | (null extends T ? null : never))[]
    : Present<T> | (null extends T ? null : never);
