import type { FieldType, IndexOrder } from "@duraxis/core";

export type EntityClass<TEntity extends object = object> = new (...args: never[]) => TEntity;
export type EntityProperty<TEntity extends object> = Extract<
  {
    [K in keyof TEntity]-?: TEntity[K] extends Function ? never : K;
  }[keyof TEntity],
  string
>;

export interface ColumnOptions {
  readonly type: FieldType;
  readonly name?: string;
  readonly required?: boolean;
  readonly nullable?: boolean;
}

export interface ColumnMetadata<TEntity extends object = object> {
  readonly property: EntityProperty<TEntity>;
  readonly field: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly nullable: boolean;
}

export interface IndexFieldMetadata<TEntity extends object = object> {
  readonly property: EntityProperty<TEntity>;
  readonly field: string;
  readonly order: IndexOrder;
}

export interface IndexMetadata<TEntity extends object = object> {
  readonly name: string;
  readonly unique: boolean;
  readonly fields: readonly IndexFieldMetadata<TEntity>[];
}

export class EntityMetadata<TEntity extends object = object> {
  readonly #byProperty: ReadonlyMap<string, ColumnMetadata<TEntity>>;
  readonly #byField: ReadonlyMap<string, ColumnMetadata<TEntity>>;

  public readonly entity: EntityClass<TEntity>;
  public readonly collection: string;
  public readonly primaryKey: EntityProperty<TEntity>;
  public readonly columns: readonly ColumnMetadata<TEntity>[];
  public readonly indexes: readonly IndexMetadata<TEntity>[];

  public constructor(options: {
    readonly entity: EntityClass<TEntity>;
    readonly collection: string;
    readonly primaryKey: EntityProperty<TEntity>;
    readonly columns: readonly ColumnMetadata<TEntity>[];
    readonly indexes: readonly IndexMetadata<TEntity>[];
  }) {
    this.entity = options.entity;

    this.collection = options.collection;
    this.primaryKey = options.primaryKey;

    this.columns = Object.freeze(options.columns.map((column) => Object.freeze({ ...column })));

    this.indexes = Object.freeze(
      options.indexes.map((index) =>
        Object.freeze({
          ...index,
          fields: Object.freeze(index.fields.map((field) => Object.freeze({ ...field }))),
        }),
      ),
    );

    this.#byProperty = new Map(this.columns.map((column) => [column.property, column]));
    this.#byField = new Map(this.columns.map((column) => [column.field, column]));
    
    Object.freeze(this);
  }

  public columnForProperty(property: string): ColumnMetadata<TEntity> | undefined {
    return this.#byProperty.get(property);
  }

  public columnForField(field: string): ColumnMetadata<TEntity> | undefined {
    return this.#byField.get(field);
  }
}
