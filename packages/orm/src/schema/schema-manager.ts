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
import { mapEntitySchema } from "./schema-mapper.js";

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

    for (const metadata of this.registry.all()) {
      const expected = normalizeCollection(mapEntitySchema(metadata));
      const current = persisted.get(expected.name);

      if (!current) {
        if (this.mode == "validate")
          throw new SchemaViolationError(`Missing collection: ${expected.name}`);

        await this.mutate(
          () => this.database.defineCollection(expected),
          `Could not create collection: ${expected.name}`,
        );

        persisted.set(expected.name, expected);
        continue;
      }

      this.validateFields(expected, current);

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
