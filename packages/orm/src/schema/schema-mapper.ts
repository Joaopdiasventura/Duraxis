import type { CollectionDefinition } from "@duraxis/core";
import type { EntityMetadata } from "../metadata/entity-metadata.js";

export function mapEntitySchema(metadata: EntityMetadata): CollectionDefinition {
  return {
    name: metadata.collection,
    fields: Object.fromEntries(
      metadata.columns.map((column) => [
        column.field,
        {
          type: column.type,
          required: column.required,
          nullable: column.nullable,
        },
      ]),
    ),
    allowAdditionalFields: false,
    indexes: metadata.indexes.map((index) => ({
      name: index.name,
      unique: index.unique,
      fields: index.fields.map((field) => ({ field: field.field, order: field.order })),
    })),
  };
}
