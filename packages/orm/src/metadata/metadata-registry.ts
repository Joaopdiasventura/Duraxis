import { EntityNotRegisteredError, InvalidMetadataError } from "../errors/index.js";
import { buildEntityMetadata, decoratorHierarchy } from "./metadata-validator.js";
import { EntityMetadata, type EntityClass, type RelationMetadata } from "./entity-metadata.js";

const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function selectedProperty(selector: (entity: never) => unknown): string {
  let selected: string | undefined;

  const proxy = new Proxy(Object.create(null) as never, {
    get(_target, property) {
      if (typeof property != "string") throw new InvalidMetadataError("Invalid inverse selector");
      selected = property;
      return property;
    },
  });

  selector(proxy);

  if (!selected || !NAME.test(selected))
    throw new InvalidMetadataError("Inverse relation selector must select one property");

  return selected;
}

function defaultJoinField(entity: EntityClass): string {
  return `${entity.name.charAt(0).toLowerCase()}${entity.name.slice(1)}Id`;
}

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
    const preliminary = new Map<Function, RelationMetadata[]>();

    for (const raw of this.#metadata.values()) {
      const metadata = raw as EntityMetadata;

      const relations: RelationMetadata[] = [];

      const drafts = decoratorHierarchy(metadata.entity);

      const relationDrafts = drafts.flatMap((draft) => draft.relations);

      const joinTables = drafts.flatMap((draft) => draft.joinTables);

      const properties = new Set<string>();

      for (const draft of relationDrafts) {
        if (!NAME.test(draft.property) || properties.has(draft.property))
          throw new InvalidMetadataError(`Invalid or duplicate relation: ${draft.property}`);

        properties.add(draft.property);

        const target = draft.target();

        if (typeof target != "function" || !this.#metadata.has(target))
          throw new InvalidMetadataError(
            `Relation ${metadata.collection}.${draft.property} targets an unregistered entity`,
          );

        const targetMetadata = this.get(target);

        const column = draft.foreignKey ? metadata.columnForProperty(draft.foreignKey) : undefined;

        const owner =
          draft.kind == "many-to-one" || (draft.kind == "one-to-one" && !!draft.foreignKey);

        if (owner && draft.property.length > 61)
          throw new InvalidMetadataError(`Owning relation name is too long: ${draft.property}`);

        if (owner && (!column || column.type != "string"))
          throw new InvalidMetadataError(
            `Owning relation ${metadata.collection}.${draft.property} requires a string foreign-key column`,
          );

        if (draft.onDelete == "SET_NULL" && !column?.nullable)
          throw new InvalidMetadataError(
            `SET_NULL relation ${metadata.collection}.${draft.property} requires a nullable column`,
          );

        const join = joinTables.find((item) => item.property == draft.property);

        if (join && draft.kind != "many-to-many")
          throw new InvalidMetadataError(`@JoinTable is only valid on ManyToMany relations`);

        if (join && !NAME.test(join.name))
          throw new InvalidMetadataError(`Invalid join table name: ${join.name}`);

        relations.push({
          kind: draft.kind,
          property: draft.property as never,
          target,
          targetCollection: targetMetadata.collection,
          ...(draft.inverse ? { inverseProperty: selectedProperty(draft.inverse) } : {}),
          owner: owner || !!join,
          ...(draft.foreignKey ? { foreignKeyProperty: draft.foreignKey } : {}),
          ...(column ? { foreignKeyField: column.field } : {}),
          required: column?.required ?? false,
          nullable: column?.nullable ?? false,
          onDelete: draft.onDelete ?? (draft.kind == "many-to-many" ? "CASCADE" : "RESTRICT"),
          ...(join
            ? {
                joinTable: {
                  name: join.name,
                  ownerField: join.joinColumn ?? defaultJoinField(metadata.entity),
                  inverseField: join.inverseJoinColumn ?? defaultJoinField(target),
                },
              }
            : {}),
        });
      }

      for (const join of joinTables)
        if (!relationDrafts.some((relation) => relation.property == join.property))
          throw new InvalidMetadataError(`@JoinTable has no relation: ${join.property}`);

      preliminary.set(metadata.entity, relations);
    }

    for (const raw of this.#metadata.values()) {
      const metadata = raw as EntityMetadata;

      for (const relation of preliminary.get(metadata.entity) ?? []) {
        if (!relation.inverseProperty) continue;

        const inverse = preliminary
          .get(relation.target)
          ?.find((candidate) => candidate.property == relation.inverseProperty);

        if (!inverse || inverse.target != metadata.entity)
          throw new InvalidMetadataError(
            `Invalid inverse relation ${metadata.collection}.${relation.property}`,
          );

        if (relation.kind == "many-to-many") {
          if (inverse.kind != "many-to-many")
            throw new InvalidMetadataError("ManyToMany inverse must also be ManyToMany");

          if (relation.owner && inverse.owner)
            throw new InvalidMetadataError("Only one ManyToMany side may declare @JoinTable");

          if (!relation.owner && !inverse.owner)
            throw new InvalidMetadataError("One ManyToMany side must declare @JoinTable");
        } else if (relation.kind == "one-to-many") {
          if (inverse.kind != "many-to-one" || !inverse.owner)
            throw new InvalidMetadataError("OneToMany inverse must be an owning ManyToOne");
        } else if (relation.kind == "one-to-one" && relation.owner == inverse.owner) {
          throw new InvalidMetadataError("Exactly one OneToOne side must own the relation");
        }
      }
    }

    for (const [entity, raw] of [...this.#metadata]) {
      const metadata = raw as EntityMetadata;
    
      const relations = (preliminary.get(entity) ?? []).map((relation) => {
        if (relation.kind != "many-to-many" || relation.joinTable) return relation;
    
        const inverse = preliminary
          .get(relation.target)!
          .find((candidate) => candidate.property == relation.inverseProperty)!;
    
          return { ...relation, joinTable: inverse.joinTable };
      });
    
      this.#metadata.set(
        entity,
        new EntityMetadata({
          entity: metadata.entity,
          collection: metadata.collection,
          primaryKey: metadata.primaryKey,
          columns: metadata.columns,
          indexes: metadata.indexes,
          relations,
        }),
      );
    }
    
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
