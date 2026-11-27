import type { LogicalQuery, QueryRow, DuraxisDatabase } from "@duraxis/core";
import { EntityMapper } from "../mapping/entity-mapper.js";
import type { EntityMetadata, RelationMetadata } from "../metadata/entity-metadata.js";
import type { Relations } from "../query/find-options.js";
import type { RepositoryRuntime } from "../repository/repository-options.js";

const BATCH_SIZE = 64;
const MAX_DEPTH = 8;
const MAX_RELATED_ENTITIES = 100_000;

interface RelationTree {
  readonly [property: string]: true | RelationTree | undefined;
}

export class RelationLoader<TEntity extends object> {
  public constructor(
    private readonly metadata: EntityMetadata<TEntity>,
    private readonly runtime: RepositoryRuntime,
  ) {}

  public async load(
    entities: readonly TEntity[],
    requested: Relations<TEntity> | undefined,
    signal?: AbortSignal,
  ): Promise<readonly TEntity[]> {
    if (!requested || entities.length == 0) return entities;

    const state = {
      loaded: 0,
      budget: this.runtime.database.createMaterializationBudget<object>(),
    };

    try {
      for (const entity of entities) state.budget.add(entity);

      await this.loadLevel(
        this.metadata,
        entities,
        requested as RelationTree,
        signal,
        0,
        new Set(),
        state,
      );

      return entities;
    } finally {
      state.budget.close();
    }
  }

  private async loadLevel<TCurrent extends object>(
    metadata: EntityMetadata<TCurrent>,
    entities: readonly object[],
    requested: RelationTree,
    signal: AbortSignal | undefined,
    depth: number,
    path: ReadonlySet<string>,
    state: { loaded: number; budget: ReturnType<DuraxisDatabase["createMaterializationBudget"]> },
  ): Promise<void> {
    if (depth >= MAX_DEPTH) throw new Error(`Relation depth exceeds ${MAX_DEPTH}`);

    for (const [property, nested] of Object.entries(requested)) {
      if (!nested) continue;

      signal?.throwIfAborted();

      const relation = metadata.relationForProperty(property);

      if (!relation) throw new Error(`Unknown relation: ${metadata.collection}.${property}`);

      const edge = `${metadata.collection}.${property}`;

      if (path.has(edge)) continue;

      const related = await this.loadRelation(metadata, entities, relation, signal);

      state.loaded += related.length;
      for (const entity of related) state.budget.add(entity);

      if (state.loaded > MAX_RELATED_ENTITIES)
        throw new Error("Related entity expansion limit exceeded");

      if (nested !== true && related.length) {
        const target = this.runtime.registry.get(relation.target);

        await this.loadLevel(
          target,
          related,
          nested,
          signal,
          depth + 1,
          new Set([...path, edge]),
          state,
        );
      }
    }
  }

  private async loadRelation<TCurrent extends object>(
    metadata: EntityMetadata<TCurrent>,
    entities: readonly object[],
    relation: RelationMetadata<TCurrent>,
    signal?: AbortSignal,
  ): Promise<object[]> {
    const target = this.runtime.registry.get(relation.target);
    const targetMapper = new EntityMapper(target);
    const related = new Map<string, object>();

    if (relation.kind == "many-to-one" || (relation.kind == "one-to-one" && relation.owner)) {
      const ids = this.values(entities, relation.foreignKeyProperty!);

      for (const row of await this.byIds(target.collection, ids, signal))
        related.set(row.id, targetMapper.hydrate(row.id, row.document));
      for (const entity of entities) {
        const id = this.value(entity, relation.foreignKeyProperty!);

        this.define(
          entity,
          relation.property,
          typeof id == "string" ? (related.get(id) ?? null) : null,
        );
      }

      return [...related.values()];
    }

    if (relation.kind == "one-to-many" || relation.kind == "one-to-one") {
      const inverse = target.relationForProperty(relation.inverseProperty!);

      if (!inverse?.foreignKeyField)
        throw new Error(
          `Relation ${metadata.collection}.${relation.property} has no owning inverse`,
        );

      const ownerIds = this.values(entities, metadata.primaryKey);

      const rows = await this.queryBatches(
        target.collection,
        inverse.foreignKeyField,
        ownerIds,
        signal,
      );

      const groups = new Map<string, object[]>();

      for (const row of rows) {
        const entity = targetMapper.hydrate(row.id, row.document);
        related.set(row.id, entity);
        const owner = row.document[inverse.foreignKeyField];
        if (typeof owner == "string") groups.set(owner, [...(groups.get(owner) ?? []), entity]);
      }

      for (const entity of entities) {
        const id = this.value(entity, metadata.primaryKey);
        const matches = typeof id == "string" ? (groups.get(id) ?? []) : [];
        this.define(
          entity,
          relation.property,
          relation.kind == "one-to-many" ? matches : (matches[0] ?? null),
        );
      }

      return [...related.values()];
    }

    const join = relation.joinTable!;
    const localField = relation.owner ? join.ownerField : join.inverseField;
    const remoteField = relation.owner ? join.inverseField : join.ownerField;
    const ownerIds = this.values(entities, metadata.primaryKey);
    const junctions = await this.queryBatches(join.name, localField, ownerIds, signal);
    const remoteIds = new Set<string>();

    for (const row of junctions) {
      const id = row.document[remoteField];
      if (typeof id == "string") remoteIds.add(id);
    }

    for (const row of await this.byIds(target.collection, remoteIds, signal))
      related.set(row.id, targetMapper.hydrate(row.id, row.document));

    const groups = new Map<string, object[]>();

    for (const row of junctions) {
      const local = row.document[localField];
      const remote = row.document[remoteField];
      const entity = typeof remote == "string" ? related.get(remote) : undefined;

      if (typeof local == "string" && entity)
        groups.set(local, [...(groups.get(local) ?? []), entity]);
    }

    for (const entity of entities) {
      const id = this.value(entity, metadata.primaryKey);
      this.define(entity, relation.property, typeof id == "string" ? (groups.get(id) ?? []) : []);
    }

    return [...related.values()];
  }

  private byIds(
    collection: string,
    ids: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<QueryRow[]> {
    return this.queryBatches(collection, "$id", ids, signal);
  }

  private async queryBatches(
    collection: string,
    field: string,
    values: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<QueryRow[]> {
    const all = [...values];
    const rows: QueryRow[] = [];

    const memory = this.runtime.database.createMaterializationBudget<QueryRow>();
    try {
      for (let offset = 0; offset < all.length; offset += BATCH_SIZE) {
        signal?.throwIfAborted();

        const batch = all.slice(offset, offset + BATCH_SIZE);

        if (!batch.length) continue;
        const query: LogicalQuery = {
          collection,
          where: { type: "in", field, values: batch },
        };

        const source = this.runtime.transaction
          ? this.runtime.transaction.query(query, { signal })
          : this.runtime.database.query(query, { signal });

        for await (const row of source) {
          memory.add(row);
          rows.push(row);
        }
      }

      return rows;
    } finally {
      memory.close();
    }
  }

  private values(entities: readonly object[], property: string): Set<string> {
    const result = new Set<string>();

    for (const entity of entities) {
      const value = this.value(entity, property);
      if (typeof value == "string") result.add(value);
    }

    return result;
  }

  private value(entity: object, property: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(entity, property);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  }

  private define(entity: object, property: string, value: unknown): void {
    Object.defineProperty(entity, property, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}
