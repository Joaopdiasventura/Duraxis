import type { CollectionDefinition } from "@duraxis/core";
import type { EntityMetadata } from "../metadata/entity-metadata.js";

export function mapEntitySchema(metadata: EntityMetadata): CollectionDefinition {
  const relationIndexes = metadata.relations
    .filter((relation) => relation.kind == "one-to-one" && relation.owner)
    .map((relation) => ({
      name: `unique_${relation.property}`,
      unique: true,
      fields: [{ field: relation.foreignKeyField!, order: "ASC" as const }],
    }));
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
    indexes: [
      ...metadata.indexes.map((index) => ({
        name: index.name,
        unique: index.unique,
        fields: index.fields.map((field) => ({ field: field.field, order: field.order })),
      })),
      ...relationIndexes,
    ],
    foreignKeys: metadata.relations
      .filter((relation) => relation.owner && relation.foreignKeyField)
      .map((relation) => ({
        name: relation.property,
        field: relation.foreignKeyField!,
        references: { collection: relation.targetCollection, field: "$id" as const },
        onDelete: relation.onDelete,
      })),
  };
}

export function mapJunctionSchemas(
  metadata: readonly EntityMetadata[],
): readonly CollectionDefinition[] {
  const schemas = new Map<string, CollectionDefinition>();
  for (const entity of metadata)
    for (const relation of entity.relations) {
      if (relation.kind != "many-to-many" || !relation.owner || !relation.joinTable) continue;
      const join = relation.joinTable;
      if (join.ownerField == join.inverseField)
        throw new Error(`Join table ${join.name} uses the same field for both sides`);
      if (schemas.has(join.name)) throw new Error(`Duplicate join table: ${join.name}`);
      schemas.set(join.name, {
        name: join.name,
        fields: {
          [join.ownerField]: { type: "string", required: true, nullable: false },
          [join.inverseField]: { type: "string", required: true, nullable: false },
        },
        allowAdditionalFields: false,
        indexes: [
          { name: "owner", unique: false, field: join.ownerField },
          { name: "inverse", unique: false, field: join.inverseField },
          {
            name: "pair",
            unique: true,
            fields: [
              { field: join.ownerField, order: "ASC" },
              { field: join.inverseField, order: "ASC" },
            ],
          },
        ],
        foreignKeys: [
          {
            name: "owner",
            field: join.ownerField,
            references: { collection: entity.collection, field: "$id" },
            onDelete: "CASCADE",
          },
          {
            name: "inverse",
            field: join.inverseField,
            references: { collection: relation.targetCollection, field: "$id" },
            onDelete: "CASCADE",
          },
        ],
      });
    }
  return [...schemas.values()];
}
