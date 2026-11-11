import { InvalidMetadataError, MissingPrimaryKeyError } from "../errors/index.js";
import { ownDraft, type DecoratorDraft } from "./decorator-metadata.js";
import {
  EntityMetadata,
  type ColumnMetadata,
  type EntityClass,
  type EntityProperty,
  type IndexMetadata,
} from "./entity-metadata.js";

const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const TYPES = new Set(["string", "number", "boolean", "date"]);

function requireName(name: unknown, label: string): asserts name is string {
  if (typeof name != "string" || !NAME.test(name))
    throw new InvalidMetadataError(`Invalid ${label}: ${String(name)}`);
}

function hierarchy(entity: Function): readonly DecoratorDraft[] {
  const result: DecoratorDraft[] = [];

  let current: unknown = entity;

  while (typeof current == "function" && current != Function.prototype) {
    const draft = ownDraft(current);
    if (draft) result.unshift(draft);
    current = Object.getPrototypeOf(current);
  }

  return result;
}

export function buildEntityMetadata<TEntity extends object>(
  entity: EntityClass<TEntity>,
): EntityMetadata<TEntity> {
  const own = ownDraft(entity);

  if (!own?.entityName) throw new InvalidMetadataError(`Class ${entity.name} is missing @Entity()`);

  if (own.entityApplications != 1)
    throw new InvalidMetadataError(`Class ${entity.name} has duplicate @Entity() decorators`);

  requireName(own.entityName, "entity name");

  const drafts = hierarchy(entity);
  const columns: ColumnMetadata<TEntity>[] = [];
  const byProperty = new Map<string, ColumnMetadata<TEntity>>();
  const byField = new Map<string, ColumnMetadata<TEntity>>();
  const primaryKeys: string[] = [];

  for (const draft of drafts) {
    for (const key of draft.primaryKeys) {
      requireName(key, "primary-key property");
      primaryKeys.push(key);
    }

    for (const column of draft.columns) {
      requireName(column.property, "column property");

      const field = column.options.name ?? column.property;

      requireName(field, "persisted column name");

      if (!TYPES.has(column.options.type))
        throw new InvalidMetadataError(`Invalid column type for ${column.property}`);

      if (byProperty.has(column.property))
        throw new InvalidMetadataError(`Duplicate column property: ${column.property}`);

      if (byField.has(field))
        throw new InvalidMetadataError(`Duplicate persisted column name: ${field}`);

      const metadata: ColumnMetadata<TEntity> = {
        property: column.property as EntityProperty<TEntity>,
        field,
        type: column.options.type,
        required: column.options.required ?? false,
        nullable: column.options.nullable ?? false,
      };

      columns.push(metadata);
      byProperty.set(column.property, metadata);
      byField.set(field, metadata);
    }
  }

  if (primaryKeys.length == 0)
    throw new MissingPrimaryKeyError(`Entity ${entity.name} must declare exactly one primary key`);

  if (primaryKeys.length != 1)
    throw new InvalidMetadataError(`Entity ${entity.name} declares multiple primary keys`);

  const primaryKey = primaryKeys[0]!;

  if (byProperty.has(primaryKey))
    throw new InvalidMetadataError(
      `Primary key ${primaryKey} must not also be declared as a persisted column`,
    );

  const indexes: IndexMetadata<TEntity>[] = [];
  const indexNames = new Set<string>();

  for (const draft of drafts) {
    for (const index of draft.indexes) {
      const name = index.kind == "property" ? (index.name ?? index.property) : index.name;

      requireName(name, "index name");

      if (indexNames.has(name)) throw new InvalidMetadataError(`Duplicate index name: ${name}`);

      indexNames.add(name);

      const fields =
        index.kind == "property"
          ? [{ property: index.property, order: "ASC" as const }]
          : index.fields;

      if (fields.length == 0) throw new InvalidMetadataError(`Index ${name} has no fields`);

      const seen = new Set<string>();

      const mapped = fields.map((part) => {
        requireName(part.property, `property in index ${name}`);

        const column = byProperty.get(part.property);

        if (!column)
          throw new InvalidMetadataError(
            `Index ${name} references unknown column property: ${part.property}`,
          );

        if (seen.has(part.property))
          throw new InvalidMetadataError(`Index ${name} repeats property: ${part.property}`);

        seen.add(part.property);

        if (part.order != "ASC" && part.order != "DESC")
          throw new InvalidMetadataError(`Invalid order in index ${name}`);

        return {
          property: column.property,
          field: column.field,
          order: part.order,
        };
      });

      indexes.push({ name, unique: index.unique, fields: mapped });
    }
  }

  return new EntityMetadata({
    entity,
    collection: own.entityName,
    primaryKey: primaryKey as EntityProperty<TEntity>,
    columns,
    indexes,
  });
}
