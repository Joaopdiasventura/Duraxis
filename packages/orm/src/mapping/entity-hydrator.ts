import type { DocumentRecord } from "@duraxis/core";
import type { EntityMetadata } from "../metadata/entity-metadata.js";
import { ValueTransformer } from "./value-transformer.js";

export class EntityHydrator<TEntity extends object> {
  public constructor(
    private readonly metadata: EntityMetadata<TEntity>,
    private readonly transformer = new ValueTransformer(),
  ) {}

  public hydrate(id: string, document: DocumentRecord): TEntity {
    const entity = Object.create(this.metadata.entity.prototype) as TEntity;

    this.define(entity, this.metadata.primaryKey, id);

    for (const column of this.metadata.columns)
      if (Object.hasOwn(document, column.field))
        this.define(
          entity,
          column.property,
          this.transformer.fromDocument(column, document[column.field]),
        );

    return entity;
  }

  public create(data: Partial<TEntity>): TEntity {
    const entity = Object.create(this.metadata.entity.prototype) as TEntity;

    const allowed = new Set<string>([
      this.metadata.primaryKey,
      ...this.metadata.columns.map((column) => column.property),
    ]);

    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(data, key);

      if (descriptor && "value" in descriptor && descriptor.value !== undefined)
        this.define(entity, key, descriptor.value);
    }

    return entity;
  }

  private define(target: object, property: string, value: unknown): void {
    Object.defineProperty(target, property, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}
