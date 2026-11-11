import type {
  ExplainResult,
  LogicalQuery,
  QueryPage,
  QueryPredicate,
  QueryRow,
} from "@duraxis/core";
import type { EntityProperty } from "../metadata/entity-metadata.js";
import type { FindPage, SortDirection } from "./find-options.js";
import { QueryMapper } from "./query-mapper.js";
import type { QueryComparisonOperator, QueryComparisonValue, Where } from "./where-operator.js";

export interface QueryBuilderExecutor<TEntity extends object> {
  readonly queryRows: (query: LogicalQuery, signal?: AbortSignal) => Promise<readonly QueryRow[]>;
  readonly queryPage: (query: LogicalQuery, signal?: AbortSignal) => Promise<QueryPage>;
  readonly count: (query: LogicalQuery, signal?: AbortSignal) => Promise<number>;
  readonly hydrate: (row: QueryRow) => TEntity;
  readonly explain: (query: LogicalQuery) => Promise<ExplainResult>;
}

interface BuilderState {
  readonly where?: QueryPredicate;
  readonly orderBy: readonly { readonly field: string; readonly direction: SortDirection }[];
  readonly projection?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export class QueryBuilder<TEntity extends object> {
  public constructor(
    private readonly mapper: QueryMapper<TEntity>,
    private readonly executor: QueryBuilderExecutor<TEntity>,
    private readonly collection: string,
    private readonly state: BuilderState = { orderBy: [] },
  ) {}

  public where<K extends EntityProperty<TEntity>, O extends QueryComparisonOperator<TEntity[K]>>(
    property: K,
    operator: O,
    ...value: QueryComparisonValue<TEntity[K], O> extends never
      ? []
      : [QueryComparisonValue<TEntity[K], O>]
  ): QueryBuilder<TEntity> {
    return this.with({ where: this.mapper.comparison(property, operator, value[0]) });
  }

  public andWhere<K extends EntityProperty<TEntity>, O extends QueryComparisonOperator<TEntity[K]>>(
    property: K,
    operator: O,
    ...value: QueryComparisonValue<TEntity[K], O> extends never
      ? []
      : [QueryComparisonValue<TEntity[K], O>]
  ): QueryBuilder<TEntity> {
    return this.combine("and", this.mapper.comparison(property, operator, value[0]));
  }

  public orWhere<K extends EntityProperty<TEntity>, O extends QueryComparisonOperator<TEntity[K]>>(
    property: K,
    operator: O,
    ...value: QueryComparisonValue<TEntity[K], O> extends never
      ? []
      : [QueryComparisonValue<TEntity[K], O>]
  ): QueryBuilder<TEntity> {
    return this.combine("or", this.mapper.comparison(property, operator, value[0]));
  }

  public andWhereGroup(where: Where<TEntity>): QueryBuilder<TEntity> {
    return this.combine("and", this.mapper.where(where));
  }

  public orWhereGroup(where: Where<TEntity>): QueryBuilder<TEntity> {
    return this.combine("or", this.mapper.where(where));
  }

  public notWhere(where: Where<TEntity>): QueryBuilder<TEntity> {
    return this.combine("and", { type: "not", predicate: this.mapper.where(where) });
  }

  public orderBy<K extends EntityProperty<TEntity>>(
    property: K,
    direction: SortDirection,
  ): QueryBuilder<TEntity> {
    const field = this.mapper.field(property);

    return this.with({
      orderBy: [
        ...this.state.orderBy.filter((order) => order.field != field),
        { field, direction },
      ],
    });
  }

  public select(properties: readonly EntityProperty<TEntity>[]): QueryBuilder<TEntity> {
    return this.with({
      projection: properties.map((property) => {
        const field = this.mapper.field(property);
        if (field == "$id") throw new Error("Primary key is always selected");
        return field;
      }),
    });
  }

  public limit(limit: number): QueryBuilder<TEntity> {
    return this.with({ limit });
  }

  public cursor(cursor: string): QueryBuilder<TEntity> {
    return this.with({ cursor });
  }

  public withSignal(signal: AbortSignal): QueryBuilder<TEntity> {
    return this.with({ signal });
  }

  public async getMany(): Promise<readonly TEntity[]> {
    return (await this.executor.queryRows(this.toLogicalQuery(), this.state.signal)).map(
      this.executor.hydrate,
    );
  }

  public async getOne(): Promise<TEntity | null> {
    const rows = await this.executor.queryRows(
      { ...this.toLogicalQuery(), limit: 1 },
      this.state.signal,
    );

    return rows[0] ? this.executor.hydrate(rows[0]) : null;
  }

  public async getCount(): Promise<number> {
    const query = this.toLogicalQuery();
    
    return this.executor.count(
      {
        collection: query.collection,
        ...(query.where ? { where: query.where } : {}),
      },
      this.state.signal,
    );
  }

  public async getPage(): Promise<FindPage<TEntity>> {
    const page = await this.executor.queryPage(this.toLogicalQuery(), this.state.signal);
    return { items: page.rows.map(this.executor.hydrate), nextCursor: page.nextCursor };
  }

  public explain(): Promise<ExplainResult> {
    return this.executor.explain(this.toLogicalQuery());
  }

  public toLogicalQuery(): LogicalQuery {
    return {
      collection: this.collection,
      ...(this.state.where ? { where: this.state.where } : {}),
      ...(this.state.orderBy.length ? { orderBy: this.state.orderBy } : {}),
      ...(this.state.projection ? { projection: this.state.projection } : {}),
      ...(this.state.limit == null ? {} : { limit: this.state.limit }),
      ...(this.state.cursor == null ? {} : { cursor: this.state.cursor }),
    };
  }

  private combine(type: "and" | "or", predicate: QueryPredicate): QueryBuilder<TEntity> {
    return this.with({
      where: this.state.where ? { type, predicates: [this.state.where, predicate] } : predicate,
    });
  }

  private with(changes: Partial<BuilderState>): QueryBuilder<TEntity> {
    return new QueryBuilder(this.mapper, this.executor, this.collection, {
      ...this.state,
      ...changes,
    });
  }
}
