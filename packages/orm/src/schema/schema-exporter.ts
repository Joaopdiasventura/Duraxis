import { normalizeCollection, type CollectionDefinition } from "@duraxis/core";
import { MetadataRegistry } from "../metadata/metadata-registry.js";
import type { EntityClass } from "../metadata/entity-metadata.js";
import { mapEntitySchema, mapJunctionSchemas } from "./schema-mapper.js";

export function exportRegistrySchema(registry: MetadataRegistry): readonly CollectionDefinition[] {
  return [...registry.all().map(mapEntitySchema), ...mapJunctionSchemas(registry.all())].map(
    normalizeCollection,
  );
}

export function exportSchema(entities: readonly EntityClass[]): readonly CollectionDefinition[] {
  return exportRegistrySchema(new MetadataRegistry(entities).finalize())
    .map((schema) => ({
      ...schema,
      indexes: [...schema.indexes].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      ...(schema.foreignKeys
        ? {
            foreignKeys: [...schema.foreignKeys].sort((a, b) =>
              a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
            ),
          }
        : {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
