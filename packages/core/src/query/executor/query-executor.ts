import type { AccessPath, LogicalQuery, QueryOrder } from "../model/query.js";
import { decodeQueryCursor, encodeQueryCursor } from "../model/cursor.js";
import { validateQuery } from "../validation/query-validator.js";

import type { QueryContext } from "../context/query-context.js";
import { compareIndexScalars, compareBytes } from "../../indexes/index-key.js";
import { fieldDefinition, type IndexScalar } from "../../catalog/collection-schema.js";
import type { QueryRow } from "./predicate.js";

import {
  CollectionScan,
  Filter,
  Limit,
  PrimaryLookup,
  Projection,
  SecondaryIndexRangeScan,
  SecondaryIndexScan,
  Sort,
  UniqueIndexLookup,
  type QueryOperator,
  type SortSpillStore,
} from "./operators/operators.js";

class CursorAfter implements QueryOperator {
  public readonly name = "CursorAfter";
  public readonly ordering;

  public constructor(
    readonly input: QueryOperator,
    readonly orderBy: readonly QueryOrder[],
    readonly values: readonly (IndexScalar | undefined)[],
    readonly id: string,
    readonly collection: string,
  ) {
    this.ordering = input.ordering;
  }

  public async *execute(context: QueryContext): AsyncIterable<QueryRow> {
    const schema = context.catalog.get(this.collection)!;
    const compareId = (a: string, b: string) =>
      compareBytes(new TextEncoder().encode(a), new TextEncoder().encode(b));

    for await (const row of this.input.execute(context)) {
      let comparison = 0;

      for (let i = 0; i < this.orderBy.length; i++) {
        const order = this.orderBy[i]!;
        const actualRaw = Object.hasOwn(row.document, order.field)
          ? row.document[order.field]
          : undefined;

        let actual: IndexScalar | undefined;

        if (actualRaw === undefined) actual = undefined;
        else if (
          fieldDefinition(schema, order.field)?.type == "date" &&
          typeof actualRaw == "string"
        )
          actual = new Date(actualRaw);
        else actual = actualRaw as IndexScalar;

        const expected = this.values[i];

        comparison =
          actual === undefined || expected === undefined
            ? actual == expected
              ? 0
              : actual === undefined
                ? -1
                : 1
            : compareIndexScalars(actual, expected);

        if (comparison) {
          if (order.direction == "DESC") comparison = -comparison;
          break;
        }
      }
      if (!comparison) comparison = compareId(row.id, this.id);
      if (comparison > 0) yield row;
    }
  }
}

export interface QueryPage {
  readonly rows: readonly QueryRow[];
  readonly nextCursor: string | null;
}

export interface QueryExecutorOptions {
  readonly maxSortRowsInMemory?: number;
  readonly sortSpill?: SortSpillStore;
}

export class QueryExecutor {
  public constructor(private readonly options: QueryExecutorOptions = {}) {}

  public access(path: AccessPath): QueryOperator {
    switch (path.type) {
      case "collection-scan":
        return new CollectionScan(path.collection, path.direction);

      case "primary-lookup":
        return new PrimaryLookup(path.collection, path.id);

      case "unique-index-lookup":
        return new UniqueIndexLookup(path.collection, path.index, path.values);

      case "secondary-index-scan":
        return new SecondaryIndexScan(path.collection, path.index, path.direction);

      case "secondary-index-range-scan": {
        const { collection, index, direction, type: _type, ...range } = path;
        return new SecondaryIndexRangeScan(collection, index, range, direction);
      }
    }
  }

  private semanticPipeline(
    context: QueryContext,
    query: LogicalQuery,
    source: QueryOperator,
    forceDeterministicSort = false,
  ): QueryOperator {
    validateQuery(query, context.catalog);
    let operator = source;

    if (query.where) operator = new Filter(operator, query.where, query.collection);

    const orderBy = query.orderBy ?? [];

    if (forceDeterministicSort || query.orderBy || query.cursor)
      operator = new Sort(operator, query.collection, orderBy, {
        maxRowsInMemory: this.options.maxSortRowsInMemory,
        spill: this.options.sortSpill,
      });

    if (query.cursor) {
      const cursor = decodeQueryCursor(
        query.cursor,
        context.generation,
        context.catalog.get(query.collection)!,
        orderBy,
      );

      operator = new CursorAfter(operator, orderBy, cursor.values, cursor.id, query.collection);
    }

    if (query.limit != null) operator = new Limit(operator, query.limit);
    return operator;
  }

  public execute(
    context: QueryContext,
    query: LogicalQuery,
    source: QueryOperator,
  ): AsyncIterable<QueryRow> {
    let operator = this.semanticPipeline(context, query, source);
    if (query.projection) operator = new Projection(operator, query.projection);
    return operator.execute(context);
  }

  public async page(
    context: QueryContext,
    query: LogicalQuery,
    source: QueryOperator,
  ): Promise<QueryPage> {
    const operator = this.semanticPipeline(context, query, source, true);
    const raw: QueryRow[] = [];

    for await (const row of operator.execute(context)) raw.push(row);
    const schema = context.catalog.get(query.collection)!;

    const nextCursor =
      query.limit == null || raw.length < query.limit || raw.length == 0
        ? null
        : encodeQueryCursor(context.generation, schema, query.orderBy ?? [], raw[raw.length - 1]!);

    const rows = query.projection
      ? raw.map((row) => ({
          id: row.id,
          document: Object.fromEntries(
            query
              .projection!.filter((f) => Object.hasOwn(row.document, f))
              .map((f) => [f, row.document[f]]),
          ),
        }))
      : raw;

    return { rows, nextCursor };
  }
}
