import {
  CommitOutcomeUnknownError,
  TransactionConflictError,
  normalizeCollection,
  type CollectionDefinition,
  type DuraxisDatabase,
  type SecondaryIndexDefinition,
} from "@duraxis/core";
import { SchemaViolationError } from "../errors/index.js";
import type { MetadataRegistry } from "../metadata/metadata-registry.js";
import { mapEntitySchema, mapJunctionSchemas } from "./schema-mapper.js";

export type SchemaMode = "validate" | "create";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) == JSON.stringify(right);
}

function indexMap(definition: CollectionDefinition): ReadonlyMap<string, SecondaryIndexDefinition> {
  return new Map(definition.indexes.map((index) => [index.name, index]));
}

export class SchemaManager {
  public constructor(
    private readonly database: DuraxisDatabase,
    private readonly registry: MetadataRegistry,
    private readonly mode: SchemaMode,
  ) {}

  public async initialize(): Promise<void> {
    const persisted = new Map(
      (await this.database.getCollectionDefinitions()).map((definition) => [
        definition.name,
        normalizeCollection(definition),
      ]),
    );

    const expectedSchemas = [
      ...this.registry.all().map((metadata) => mapEntitySchema(metadata)),
      ...mapJunctionSchemas(this.registry.all()),
    ].map((schema) => normalizeCollection(schema));
    const missing = expectedSchemas.filter((schema) => !persisted.has(schema.name));
    if (missing.length && this.mode == "validate")
      throw new SchemaViolationError(`Missing collection: ${missing[0]!.name}`);
    if (missing.length) {
      await this.mutate(
        () => this.database.defineCollections(missing),
        `Could not create collections: ${missing.map((schema) => schema.name).join(", ")}`,
      );
      for (const schema of missing) persisted.set(schema.name, schema);
    }

    for (const expected of expectedSchemas) {
      const current = persisted.get(expected.name);
      if (!current) throw new SchemaViolationError(`Missing collection: ${expected.name}`);

      this.validateFields(expected, current);

      if (!same(expected.foreignKeys ?? [], current.foreignKeys ?? []))
        throw new SchemaViolationError(`Incompatible foreign keys: ${expected.name}`);

      const actualIndexes = indexMap(current);

      for (const expectedIndex of expected.indexes) {
        const actual = actualIndexes.get(expectedIndex.name);

        if (!actual) {
          if (this.mode == "validate")
            throw new SchemaViolationError(`Missing index: ${expected.name}/${expectedIndex.name}`);

          await this.mutate(
            () => this.database.addIndex(expected.name, expectedIndex),
            `Could not create index: ${expected.name}/${expectedIndex.name}`,
          );

          continue;
        }

        if (!same(actual, expectedIndex))
          throw new SchemaViolationError(
            `Incompatible index: ${expected.name}/${expectedIndex.name}`,
          );
      }
    }
  }

  private validateFields(expected: CollectionDefinition, actual: CollectionDefinition): void {
    if (
      expected.allowAdditionalFields != actual.allowAdditionalFields ||
      !same(expected.fields ?? {}, actual.fields ?? {})
    )
      throw new SchemaViolationError(`Incompatible collection schema: ${expected.name}`);
  }

  private async mutate(operation: () => Promise<void>, message: string): Promise<void> {
    try {
      await operation();
    } catch (cause) {
      if (
        cause instanceof TransactionConflictError ||
        cause instanceof CommitOutcomeUnknownError ||
        cause instanceof SchemaViolationError
      )
        throw cause;

      throw new SchemaViolationError(message, { cause });
    }
  }
}
