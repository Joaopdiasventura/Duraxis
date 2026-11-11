import {
  UniqueIndexViolationError,
  type LogicalQuery,
  type QueryPage,
  type QueryRow,
  type Transaction,
} from "@duraxis/core";
import {
  DuplicateRecordError,
  InvalidColumnError,
  RecordNotFoundError,
  UniqueIndexViolationOrmError,
} from "../errors/index.js";
import { EntityMapper } from "../mapping/entity-mapper.js";
import type { EntityMetadata } from "../metadata/entity-metadata.js";
import type { FindOptions, FindPage } from "../query/find-options.js";
import { QueryBuilder } from "../query/query-builder.js";
import { QueryMapper } from "../query/query-mapper.js";
import type { RepositoryRuntime } from "./repository-options.js";

export class Repository<TEntity extends object> {
  readonly #entityMapper: EntityMapper<TEntity>;
  readonly #queryMapper: QueryMapper<TEntity>;

  public constructor(
    public readonly metadata: EntityMetadata<TEntity>,
    private readonly runtime: RepositoryRuntime,
  ) {
    this.#entityMapper = new EntityMapper(metadata);
    this.#queryMapper = new QueryMapper(metadata);
  }

  public create(data: Partial<TEntity>): TEntity {
    this.runtime.assertUsable();
    return this.#entityMapper.create(data);
  }

  public async insert(entity: TEntity): Promise<TEntity> {
    this.runtime.assertUsable();
    const serialized = this.#entityMapper.serialize(entity);

    await this.write(async (tx) => {
      if ((await tx.getDocument(this.metadata.collection, serialized.id)) != null)
        throw new DuplicateRecordError(
          `Record already exists: ${this.metadata.collection}/${serialized.id}`,
        );

      tx.putDocument(this.metadata.collection, serialized.id, serialized.document);
    });

    return entity;
  }

  public save(entity: TEntity): Promise<TEntity> {
    return this.upsert(entity);
  }

  public async update(id: string, changes: Partial<TEntity>): Promise<TEntity> {
    this.runtime.assertUsable();

    let updated: TEntity | undefined;

    await this.write(async (tx) => {
      const document = await tx.getDocument(this.metadata.collection, id);
      if (!document)
        throw new RecordNotFoundError(`Record not found: ${this.metadata.collection}/${id}`);

      const entity = this.#entityMapper.hydrate(id, document);

      const primaryChange = Object.getOwnPropertyDescriptor(changes, this.metadata.primaryKey);

      if (
        primaryChange &&
        "value" in primaryChange &&
        primaryChange.value !== undefined &&
        primaryChange.value !== id
      )
        throw new InvalidColumnError("Primary key cannot be changed by update()");

      for (const column of this.metadata.columns) {
        const descriptor = Object.getOwnPropertyDescriptor(changes, column.property);

        if (descriptor && "value" in descriptor && descriptor.value !== undefined)
          Object.defineProperty(entity, column.property, {
            value: descriptor.value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      }

      const serialized = this.#entityMapper.serialize(entity);

      tx.putDocument(this.metadata.collection, id, serialized.document);
      updated = entity;
    });

    if (!updated) throw new Error("Update completed without an entity result");

    return updated;
  }

  public async upsert(entity: TEntity): Promise<TEntity> {
    this.runtime.assertUsable();

    const serialized = this.#entityMapper.serialize(entity);

    await this.write((tx) => {
      tx.putDocument(this.metadata.collection, serialized.id, serialized.document);
    });

    return entity;
  }

  public async delete(id: string): Promise<boolean> {
    this.runtime.assertUsable();

    let deleted = false;

    await this.write(async (tx) => {
      if ((await tx.getDocument(this.metadata.collection, id)) == null) return;
      tx.deleteDocument(this.metadata.collection, id);
      deleted = true;
    });

    return deleted;
  }

  public async findById(id: string): Promise<TEntity | null> {
    this.runtime.assertUsable();

    if (this.runtime.transaction) {
      const document = await this.runtime.transaction.getDocument(this.metadata.collection, id);
      return document ? this.#entityMapper.hydrate(id, document) : null;
    }
    const page = await this.runtime.database.queryPage({
      collection: this.metadata.collection,
      where: { type: "comparison", field: "$id", operator: "eq", value: id },
      limit: 1,
    });

    const row = page.rows[0];
    return row ? this.#entityMapper.hydrate(row.id, row.document) : null;
  }

  public async findOne(options: FindOptions<TEntity> = {}): Promise<TEntity | null> {
    const rows = await this.queryRows(
      { ...this.#queryMapper.map(options), limit: 1 },
      options.signal,
    );
    return rows[0] ? this.hydrate(rows[0]) : null;
  }

  public async find(options: FindOptions<TEntity> = {}): Promise<readonly TEntity[]> {
    return (await this.queryRows(this.#queryMapper.map(options), options.signal)).map((row) =>
      this.hydrate(row),
    );
  }

  public async findPage(options: FindOptions<TEntity>): Promise<FindPage<TEntity>> {
    const page = await this.queryPage(this.#queryMapper.map(options), options.signal);
    return { items: page.rows.map((row) => this.hydrate(row)), nextCursor: page.nextCursor };
  }

  public async exists(options: FindOptions<TEntity> = {}): Promise<boolean> {
    return (await this.findOne(options)) != null;
  }

  public async count(
    options: Pick<FindOptions<TEntity>, "where" | "signal"> = {},
  ): Promise<number> {
    const query = this.#queryMapper.map(options);
    let count = 0;
    for await (const _row of this.sourceQuery(query, options.signal)) count++;
    return count;
  }

  public createQueryBuilder(): QueryBuilder<TEntity> {
    this.runtime.assertUsable();

    return new QueryBuilder(
      this.#queryMapper,
      {
        queryRows: (query, signal) => this.queryRows(query, signal),
        queryPage: (query, signal) => this.queryPage(query, signal),
        count: async (query, signal) => {
          let count = 0;
          for await (const _row of this.sourceQuery(query, signal)) count++;
          return count;
        },
        hydrate: (row) => this.hydrate(row),
        explain: (query) => this.runtime.database.explain(query),
      },
      this.metadata.collection,
    );
  }

  private hydrate(row: QueryRow): TEntity {
    return this.#entityMapper.hydrate(row.id, row.document);
  }

  private async queryRows(query: LogicalQuery, signal?: AbortSignal): Promise<readonly QueryRow[]> {
    this.runtime.assertUsable();
    const rows: QueryRow[] = [];
    for await (const row of this.sourceQuery(query, signal)) rows.push(row);
    return rows;
  }

  private queryPage(query: LogicalQuery, signal?: AbortSignal): Promise<QueryPage> {
    this.runtime.assertUsable();
    return this.runtime.transaction
      ? this.runtime.transaction.queryPage(query, { signal })
      : this.runtime.database.queryPage(query, { signal });
  }

  private sourceQuery(query: LogicalQuery, signal?: AbortSignal): AsyncIterable<QueryRow> {
    this.runtime.assertUsable();
    return this.runtime.transaction
      ? this.runtime.transaction.query(query, { signal })
      : this.runtime.database.query(query, { signal });
  }

  private async write(action: (transaction: Transaction) => Promise<void> | void): Promise<void> {
    try {
      if (this.runtime.transaction) await action(this.runtime.transaction);
      else await this.runtime.database.transaction(action);
    } catch (cause) {
      if (cause instanceof UniqueIndexViolationError)
        throw new UniqueIndexViolationOrmError(cause.message, cause);
      throw cause;
    }
  }
}
