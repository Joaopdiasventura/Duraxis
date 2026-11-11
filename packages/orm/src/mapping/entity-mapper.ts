import type { DocumentRecord } from "@duraxis/core";
import { InvalidColumnError, MissingPrimaryKeyError } from "../errors/index.js";
import type { EntityMetadata } from "../metadata/entity-metadata.js";
import { EntityHydrator } from "./entity-hydrator.js";
import { ValueTransformer } from "./value-transformer.js";

export interface SerializedEntity {
  readonly id: string;
  readonly document: DocumentRecord;
}

export class EntityMapper<TEntity extends object> {
  readonly #transformer = new ValueTransformer();
  readonly #hydrator: EntityHydrator<TEntity>;

  public constructor(public readonly metadata: EntityMetadata<TEntity>) {
    this.#hydrator = new EntityHydrator(metadata, this.#transformer);
  }

  public create(data: Partial<TEntity>): TEntity {
    return this.#hydrator.create(data);
  }

  public serialize(entity: TEntity): SerializedEntity {
    const id = this.ownValue(entity, this.metadata.primaryKey);

    if (typeof id != "string" || id.length == 0)
      throw new MissingPrimaryKeyError(
        `Primary key ${this.metadata.primaryKey} must be a non-empty string`,
      );

    const document: DocumentRecord = {};

    for (const column of this.metadata.columns) {
      const descriptor = Object.getOwnPropertyDescriptor(entity, column.property);

      if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
        if (column.required)
          throw new InvalidColumnError(`Missing required column: ${column.property}`);

        continue;
      }

      document[column.field] = this.#transformer.toDocument(column, descriptor.value);
    }

    return { id, document };
  }

  public hydrate(id: string, document: DocumentRecord): TEntity {
    return this.#hydrator.hydrate(id, document);
  }

  private ownValue(entity: TEntity, property: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(entity, property);
    if (!descriptor || !("value" in descriptor)) return undefined;
    return descriptor.value;
  }
}
