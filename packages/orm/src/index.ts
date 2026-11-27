export { Entity } from "./decorators/entity.decorator.js";
export { Column } from "./decorators/column.decorator.js";
export { PrimaryKey } from "./decorators/primary-key.decorator.js";
export { Index } from "./decorators/index.decorator.js";
export {
  OneToMany,
  ManyToOne,
  OneToOne,
  ManyToMany,
  JoinTable,
} from "./decorators/relation.decorators.js";
export type { OwningRelationOptions, JoinTableOptions } from "./decorators/relation.decorators.js";
export type {
  PropertyIndexOptions,
  CompositeIndexField,
  CompositeIndexOptions,
} from "./decorators/index.decorator.js";

export { DuraxisORM } from "./database/duraxis-orm.js";
export type { DuraxisOrmOptions } from "./database/orm-options.js";
export { Repository } from "./repository/repository.js";
export { QueryBuilder } from "./query/query-builder.js";
export { OrmTransactionManager } from "./transactions/orm-transaction.js";
export type { TransactionContext } from "./transactions/transaction-context.js";

export { MetadataRegistry } from "./metadata/metadata-registry.js";
export { EntityMetadata } from "./metadata/entity-metadata.js";
export type {
  EntityClass,
  EntityProperty,
  ColumnOptions,
  ColumnMetadata,
  IndexMetadata,
  IndexFieldMetadata,
  RelationKind,
  RelationMetadata,
  JoinTableMetadata,
} from "./metadata/entity-metadata.js";

export { EntityMapper } from "./mapping/entity-mapper.js";
export { EntityHydrator } from "./mapping/entity-hydrator.js";
export { ValueTransformer } from "./mapping/value-transformer.js";
export { SchemaManager } from "./schema/schema-manager.js";
export type { SchemaMode } from "./schema/schema-manager.js";

export type { FindOptions, FindPage, SortDirection, Relations } from "./query/find-options.js";
export { RelationLoader } from "./relations/relation-loader.js";
export { RelationOperations } from "./relations/relation-operations.js";
export type {
  Where,
  WhereOperator,
  WhereValue,
  QueryComparisonOperator,
  QueryComparisonValue,
} from "./query/where-operator.js";

export * from "./errors/index.js";

export { TransactionConflictError, CommitOutcomeUnknownError } from "@duraxis/core";

export { exportSchema } from "./schema/schema-exporter.js";
