import type { StorageDriver } from "@duraxis/storage";
import {
  decodeDocument,
  encodeDocument,
  fieldDefinition,
  indexFields,
  normalizeCollection,
  parseRecordKey,
  recordKey,
  validateDocument,
  type CollectionDefinition,
  type DocumentRecord,
  type ForeignKeyDefinition,
} from "../catalog/collection-schema.js";
import type { Snapshot } from "../commit/manifest.js";
import {
  InvalidForeignKeyDefinitionError,
  ReferencedRecordNotFoundError,
  ReferencedRecordRestrictedError,
} from "../errors/foreign-key.error.js";
import { PrimaryIndex } from "../indexes/primary/primary-index.js";
import { SecondaryIndexManager } from "../indexes/secondary/secondary-index-manager.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";
import type { PendingWrite } from "../transactions/transaction.js";

const MAX_CASCADE_OPERATIONS = 100_000;

interface IncomingForeignKey {
  readonly collection: string;
  readonly schema: CollectionDefinition;
  readonly foreignKey: ForeignKeyDefinition;
  readonly index: string;
}

export class ForeignKeyManager {
  readonly #primary: PrimaryIndex;
  readonly #secondary: SecondaryIndexManager;

  public constructor(storage: StorageDriver, keys = new StorageKeyManager()) {
    this.#primary = new PrimaryIndex(storage, keys);
    this.#secondary = new SecondaryIndexManager(storage, keys);
  }

  public async prepare(
    snapshot: Snapshot,
    sourceWrites: ReadonlyMap<string, PendingWrite>,
    sourceCatalog: ReadonlyMap<string, CollectionDefinition>,
  ): Promise<Map<string, PendingWrite>> {
    const catalog = this.validateCatalog(sourceCatalog);
    const writes = new Map<string, PendingWrite>(sourceWrites);

    const incoming = this.incoming(catalog);
    const queue: Array<{ collection: string; id: string }> = [];
    const visited = new Set<string>();

    for (const [key, operation] of writes) {
      const parsed = parseRecordKey(key);
      if (parsed && operation.type == "delete") queue.push(parsed);
    }

    for (let offset = 0; offset < queue.length; offset++) {
      if (visited.size > MAX_CASCADE_OPERATIONS)
        throw new Error("Foreign-key cascade operation limit exceeded");

      const parent = queue[offset]!;

      const parentKey = recordKey(parent.collection, parent.id);

      if (visited.has(parentKey)) continue;

      visited.add(parentKey);

      for (const relation of incoming.get(parent.collection) ?? []) {
        const childIds = await this.childIds(snapshot, writes, relation, parent.id);

        for (const childId of childIds) {
          const childKey = recordKey(relation.collection, childId);
          const document = await this.finalDocument(snapshot, writes, relation.collection, childId);

          if (!document || document[relation.foreignKey.field] !== parent.id) continue;

          switch (relation.foreignKey.onDelete) {
            case "RESTRICT":
              throw new ReferencedRecordRestrictedError(
                relation.collection,
                relation.foreignKey.name,
                `${parent.collection}/${parent.id}`,
              );

            case "CASCADE":
              writes.set(childKey, { type: "delete" });
              queue.push({ collection: relation.collection, id: childId });
              break;

            case "SET_NULL": {
              const next = { ...document, [relation.foreignKey.field]: null };
              writes.set(childKey, {
                type: "put",
                data: encodeDocument(validateDocument(relation.schema, next)),
              });
              break;
            }
          }
        }
      }
    }

    for (const [key, operation] of writes) {
      const parsed = parseRecordKey(key);

      if (!parsed || operation.type != "put") continue;

      const schema = catalog.get(parsed.collection);

      if (!schema)
        throw new InvalidForeignKeyDefinitionError(`Unknown collection: ${parsed.collection}`);

      const document = decodeDocument(operation.data);

      for (const foreignKey of schema.foreignKeys ?? []) {
        const definition = fieldDefinition(schema, foreignKey.field)!;
        const value = document[foreignKey.field];

        if (value == null) {
          if (value === null && definition.nullable) continue;

          if (value === undefined && !definition.required) continue;

          throw new ReferencedRecordNotFoundError(
            parsed.collection,
            foreignKey.name,
            String(value),
          );
        }

        if (
          typeof value != "string" ||
          !(await this.finalRecordExists(snapshot, writes, foreignKey.references.collection, value))
        )
          throw new ReferencedRecordNotFoundError(
            parsed.collection,
            foreignKey.name,
            `${foreignKey.references.collection}/${String(value)}`,
          );
      }
    }

    return writes;
  }

  private validateCatalog(
    source: ReadonlyMap<string, CollectionDefinition>,
  ): Map<string, CollectionDefinition> {
    const catalog = new Map<string, CollectionDefinition>();
    try {
      for (const [name, definition] of source) catalog.set(name, normalizeCollection(definition));
    } catch (cause) {
      throw new InvalidForeignKeyDefinitionError(
        cause instanceof Error ? cause.message : "Invalid foreign key definition",
      );
    }

    for (const [collection, schema] of catalog)
      for (const foreignKey of schema.foreignKeys ?? []) {
        if (!catalog.has(foreignKey.references.collection))
          throw new InvalidForeignKeyDefinitionError(
            `Foreign key ${collection}/${foreignKey.name} references unknown collection ${foreignKey.references.collection}`,
          );
      }

    return catalog;
  }

  private incoming(
    catalog: ReadonlyMap<string, CollectionDefinition>,
  ): Map<string, IncomingForeignKey[]> {
    const result = new Map<string, IncomingForeignKey[]>();
    for (const [collection, schema] of catalog)
      for (const foreignKey of schema.foreignKeys ?? []) {
        const index = schema.indexes.find((candidate) => {
          const parts = indexFields(candidate);
          return parts.length == 1 && parts[0]!.field == foreignKey.field;
        });

        if (!index)
          throw new InvalidForeignKeyDefinitionError(
            `Foreign key ${collection}/${foreignKey.name} has no supporting index`,
          );

        const values = result.get(foreignKey.references.collection) ?? [];

        values.push({ collection, schema, foreignKey, index: index.name });
        result.set(foreignKey.references.collection, values);
      }

    for (const values of result.values())
      values.sort((left, right) =>
        `${left.collection}/${left.foreignKey.name}`.localeCompare(
          `${right.collection}/${right.foreignKey.name}`,
        ),
      );

    return result;
  }

  private async childIds(
    snapshot: Snapshot,
    writes: ReadonlyMap<string, PendingWrite>,
    relation: IncomingForeignKey,
    parentId: string,
  ): Promise<Set<string>> {
    const result = new Set<string>();
    const previousSchema = snapshot.manifest.catalog.get(relation.collection);

    if (previousSchema?.indexes.some((index) => index.name == relation.index))
      for await (const entry of this.#secondary.scanIds(
        snapshot.manifest,
        relation.collection,
        relation.index,
        { eq: parentId },
      ))
        result.add(entry.id);

    for (const [key, operation] of writes) {
      const parsed = parseRecordKey(key);

      if (!parsed || parsed.collection != relation.collection) continue;

      if (operation.type == "delete") result.delete(parsed.id);
      else if (decodeDocument(operation.data)[relation.foreignKey.field] === parentId)
        result.add(parsed.id);
      else result.delete(parsed.id);
    }

    return result;
  }

  private async finalRecordExists(
    snapshot: Snapshot,
    writes: ReadonlyMap<string, PendingWrite>,
    collection: string,
    id: string,
  ): Promise<boolean> {
    return (await this.finalDocument(snapshot, writes, collection, id)) != null;
  }

  private async finalDocument(
    snapshot: Snapshot,
    writes: ReadonlyMap<string, PendingWrite>,
    collection: string,
    id: string,
  ): Promise<DocumentRecord | null> {
    const key = recordKey(collection, id);
    const pending = writes.get(key);

    if (pending) return pending.type == "delete" ? null : decodeDocument(pending.data);

    const stored = await this.#primary.read(snapshot.manifest, key);
    return stored == null ? null : decodeDocument(stored);
  }
}
