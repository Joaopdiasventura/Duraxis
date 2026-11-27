import { createHash } from "node:crypto";
import { normalizeCollection, type CollectionDefinition } from "@duraxis/core";

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;

  if (value && typeof value == "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`)
      .join(",")}}`;

  const json = JSON.stringify(value);

  if (json === undefined) throw new Error("Non-JSON schema value");

  return json;
}

export function checksum(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalSchema(
  collections: readonly CollectionDefinition[],
): readonly CollectionDefinition[] {
  const names = new Set<string>();

  return collections
    .map((definition) => {
      if (names.has(definition.name)) throw new Error(`Duplicate collection: ${definition.name}`);

      names.add(definition.name);

      const schema = normalizeCollection(definition);

      return {
        ...schema,
        indexes: [...schema.indexes].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        ),
        ...(schema.foreignKeys
          ? {
              foreignKeys: [...schema.foreignKeys].sort((a, b) =>
                a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
              ),
            }
          : {}),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function schemaHash(collections: readonly CollectionDefinition[]): string {
  return checksum(canonicalJSON(canonicalSchema(collections)));
}

export interface SchemaSnapshot {
  readonly formatVersion: 1;
  readonly migrationId: string | null;
  readonly parentMigrationId: string | null;
  readonly schemaHash: string;
  readonly collections: readonly CollectionDefinition[];
}

export function createSnapshot(
  migrationId: string | null,
  parentMigrationId: string | null,
  collections: readonly CollectionDefinition[],
): SchemaSnapshot {
  const normalized = canonicalSchema(collections);

  return {
    formatVersion: 1,
    migrationId,
    parentMigrationId,
    schemaHash: schemaHash(normalized),
    collections: normalized,
  };
}

export function validateSnapshot(snapshot: SchemaSnapshot): void {
  if (
    !snapshot ||
    snapshot.formatVersion !== 1 ||
    !Array.isArray(snapshot.collections) ||
    snapshot.schemaHash !== schemaHash(snapshot.collections)
  )
    throw new Error("Invalid or incompatible schema snapshot");

  const catalog = new Map(snapshot.collections.map((schema) => [schema.name, schema]));

  for (const schema of snapshot.collections)
    for (const key of schema.foreignKeys ?? [])
      if (!catalog.has(key.references.collection))
        throw new Error("Snapshot foreign key references an unmanaged collection");

  if (snapshot.migrationId === null && snapshot.parentMigrationId !== null)
    throw new Error("Invalid baseline parent");

  if (snapshot.migrationId !== null) validateMigrationId(snapshot.migrationId);
  if (snapshot.parentMigrationId !== null) validateMigrationId(snapshot.parentMigrationId);
}

export function validateMigrationId(id: string): void {
  if (typeof id != "string" || !/^\d{17}_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(id))
    throw new Error(`Invalid migration ID: ${id}`);
}
