import { EntityNotRegisteredError, InvalidMetadataError } from "../errors/index.js";
import { buildEntityMetadata } from "./metadata-validator.js";
import type { EntityClass, EntityMetadata } from "./entity-metadata.js";

export class MetadataRegistry {
  readonly #metadata = new Map<Function, unknown>();
  readonly #collections = new Map<string, Function>();

  #finalized = false;

  public constructor(entities: readonly EntityClass[] = []) {
    for (const entity of entities) this.register(entity);
  }

  public register<TEntity extends object>(entity: EntityClass<TEntity>): EntityMetadata<TEntity> {
    if (this.#finalized) throw new InvalidMetadataError("Metadata registry is finalized");
    const existing = this.#metadata.get(entity);

    if (existing) return existing as EntityMetadata<TEntity>;

    const metadata = buildEntityMetadata(entity);
    const collectionOwner = this.#collections.get(metadata.collection);

    if (collectionOwner && collectionOwner != entity)
      throw new InvalidMetadataError(`Duplicate entity collection: ${metadata.collection}`);

    this.#metadata.set(entity, metadata);
    this.#collections.set(metadata.collection, entity);
    
    return metadata;
  }

  public finalize(): this {
    this.#finalized = true;
    return this;
  }

  public get<TEntity extends object>(entity: EntityClass<TEntity>): EntityMetadata<TEntity> {
    const metadata = this.#metadata.get(entity);
    if (!metadata) throw new EntityNotRegisteredError(entity);
    return metadata as EntityMetadata<TEntity>;
  }

  public has(entity: Function): boolean {
    return this.#metadata.has(entity);
  }

  public all(): readonly EntityMetadata[] {
    return Object.freeze(
      [...this.#metadata.values()].map((metadata) => metadata as EntityMetadata),
    );
  }

  public get finalized(): boolean {
    return this.#finalized;
  }
}
