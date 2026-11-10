import type { DocumentRecord, IndexScalar } from "../../../catalog/collection-schema.js";
import type { QueryContext } from "../../context/query-context.js";
import type { QueryOrder, QueryPredicate } from "../../model/query.js";
import { compareRows, evaluatePredicate, type QueryRow } from "../predicate.js";

export interface OperatorOrdering {
  readonly fields: readonly QueryOrder[];
  readonly deterministic: boolean;
}

export interface QueryOperator {
  readonly name: string;
  readonly ordering?: OperatorOrdering;
  execute(context: QueryContext): AsyncIterable<QueryRow>;
}

export class PrimaryLookup implements QueryOperator {
  public readonly name = "PrimaryLookup";

  public constructor(
    readonly collection: string,
    readonly id: string,
  ) {}

  public async *execute(context: QueryContext): AsyncIterable<QueryRow> {
    const document = await context.getDocument(this.collection, this.id);
    if (document) yield { id: this.id, document };
  }
}

export class UniqueIndexLookup implements QueryOperator {
  public readonly name = "UniqueIndexLookup";

  public constructor(
    readonly collection: string,
    readonly index: string,
    readonly values: readonly IndexScalar[],
  ) {}

  public execute(context: QueryContext): AsyncIterable<QueryRow> {
    return context.scanIndex(this.collection, this.index, { eq: this.values, limit: 1 });
  }
}

export class SecondaryIndexScan implements QueryOperator {
  public readonly name = "SecondaryIndexScan";

  public constructor(
    readonly collection: string,
    readonly index: string,
    readonly direction: "ASC" | "DESC" = "ASC",
  ) {}

  public execute(context: QueryContext): AsyncIterable<QueryRow> {
    return context.scanIndex(this.collection, this.index, { direction: this.direction });
  }
}

export interface SecondaryRange {
  readonly prefix?: readonly IndexScalar[];
  readonly gt?: readonly IndexScalar[];
  readonly gte?: readonly IndexScalar[];
  readonly lt?: readonly IndexScalar[];
  readonly lte?: readonly IndexScalar[];
}

export class SecondaryIndexRangeScan implements QueryOperator {
  public readonly name = "SecondaryIndexRangeScan";

  public constructor(
    readonly collection: string,
    readonly index: string,
    readonly range: SecondaryRange,
    readonly direction: "ASC" | "DESC" = "ASC",
  ) {}

  public execute(context: QueryContext): AsyncIterable<QueryRow> {
    return context.scanIndex(this.collection, this.index, {
      ...this.range,
      direction: this.direction,
    });
  }
}

export class CollectionScan implements QueryOperator {
  public readonly name = "CollectionScan";

  public constructor(
    readonly collection: string,
    readonly direction: "ASC" | "DESC" = "ASC",
  ) {}

  public execute(context: QueryContext): AsyncIterable<QueryRow> {
    return context.scanCollection(this.collection, { direction: this.direction });
  }
}

export class Filter implements QueryOperator {
  public readonly name = "Filter";
  public readonly ordering;

  public constructor(
    readonly input: QueryOperator,
    readonly predicate: QueryPredicate,
    readonly collection: string,
  ) {
    this.ordering = input.ordering;
  }

  public async *execute(context: QueryContext): AsyncIterable<QueryRow> {
    const schema = context.catalog.get(this.collection);
    if (!schema) throw new Error(`Unknown collection: ${this.collection}`);

    for await (const row of this.input.execute(context)) {
      context.assertActive();
      if (evaluatePredicate(schema, row.document, this.predicate)) yield row;
    }
  }
}

export interface SortSpillStore {
  write(rows: readonly QueryRow[] | AsyncIterable<QueryRow>): Promise<string>;
  read(handle: string): AsyncIterable<QueryRow>;
  delete(handle: string): Promise<void>;
}

export class QueryMemoryLimitError extends Error {
  public constructor(message = "Query materialization memory limit exceeded") {
    super(message);
    this.name = "QueryMemoryLimitError";
  }
}

export class Sort implements QueryOperator {
  public readonly name = "Sort";
  public readonly ordering: OperatorOrdering;

  public constructor(
    readonly input: QueryOperator,
    readonly collection: string,
    readonly orders: readonly QueryOrder[],
    readonly options: { readonly maxRowsInMemory?: number; readonly spill?: SortSpillStore } = {},
  ) {
    this.ordering = { fields: orders, deterministic: true };
  }

  public async *execute(context: QueryContext): AsyncIterable<QueryRow> {
    const schema = context.catalog.get(this.collection);
    if (!schema) throw new Error(`Unknown collection: ${this.collection}`);

    const maximum = this.options.maxRowsInMemory ?? 10_000;
    if (!Number.isSafeInteger(maximum) || maximum < 2) throw new Error("Invalid sort memory limit");

    const compare = (a: QueryRow, b: QueryRow) => compareRows(schema, this.orders, a, b);

    const spill = this.options.spill;
    let chunk: QueryRow[] = [];
    let runs: string[] = [];

    const active = new Set<string>();

    const write = async (rows: readonly QueryRow[] | AsyncIterable<QueryRow>) => {
      const handle = await spill!.write(rows);
      active.add(handle);
      return handle;
    };

    const merge = async function* (handles: readonly string[]): AsyncIterable<QueryRow> {
      const iterators = handles.map((handle) => spill!.read(handle)[Symbol.asyncIterator]());

      try {
        const heads = await Promise.all(iterators.map((iterator) => iterator.next()));

        while (true) {
          let selected = -1;
          for (let i = 0; i < heads.length; i++)
            if (
              !heads[i]!.done &&
              (selected < 0 || compare(heads[i]!.value, heads[selected]!.value) < 0)
            )
              selected = i;

          if (selected < 0) break;

          context.assertActive();

          yield heads[selected]!.value;

          heads[selected] = await iterators[selected]!.next();
        }
      } finally {
        await Promise.all(iterators.map((iterator) => iterator.return?.()));
      }
    };

    try {
      for await (const row of this.input.execute(context)) {
        chunk.push(row);

        if (chunk.length < maximum) continue;
        if (!this.options.spill) throw new QueryMemoryLimitError();

        chunk.sort(compare);
        runs.push(await write(chunk));
        chunk = [];
      }
      if (runs.length == 0) {
        chunk.sort(compare);

        for (const row of chunk) {
          context.assertActive();
          yield row;
        }

        return;
      }

      if (chunk.length) {
        chunk.sort(compare);
        runs.push(await write(chunk));
      }

      while (runs.length > 32) {
        const consolidated: string[] = [];

        for (let i = 0; i < runs.length; i += 32) {
          const group = runs.slice(i, i + 32);
          const handle = await write(merge(group));

          consolidated.push(handle);

          await Promise.all(group.map((item) => spill!.delete(item)));

          for (const item of group) active.delete(item);
        }

        runs = consolidated;
      }

      yield* merge(runs);
    } finally {
      await Promise.all([...active].map((handle) => spill!.delete(handle)));
    }
  }
}

export class Limit implements QueryOperator {
  public readonly name = "Limit";
  public readonly ordering;

  public constructor(
    readonly input: QueryOperator,
    readonly count: number,
  ) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid query limit");
    this.ordering = input.ordering;
  }

  public async *execute(context: QueryContext): AsyncIterable<QueryRow> {
    if (this.count == 0) return;

    let count = 0;

    for await (const row of this.input.execute(context)) {
      context.assertActive();
      yield row;
      if (++count >= this.count) return;
    }
  }
}

export class Projection implements QueryOperator {
  public readonly name = "Projection";
  public readonly ordering;

  public constructor(
    readonly input: QueryOperator,
    readonly fields: readonly string[],
  ) {
    this.ordering = input.ordering;
  }

  public async *execute(context: QueryContext): AsyncIterable<QueryRow> {
    for await (const row of this.input.execute(context)) {
      context.assertActive();

      const document: DocumentRecord = {};

      for (const field of this.fields)
        if (Object.hasOwn(row.document, field)) document[field] = row.document[field];

      yield { id: row.id, document };
    }
  }
}

abstract class SetOperator implements QueryOperator {
  public abstract readonly name: string;

  public constructor(
    readonly inputs: readonly QueryOperator[],
    readonly maxSetEntries = 100_000,
  ) {
    if (inputs.length == 0) throw new Error("Set operator requires inputs");
  }

  protected async ids(context: QueryContext, input: QueryOperator): Promise<Map<string, QueryRow>> {
    const result = new Map<string, QueryRow>();

    for await (const row of input.execute(context)) {
      context.assertActive();
      if (result.size >= this.maxSetEntries && !result.has(row.id))
        throw new QueryMemoryLimitError();

      result.set(row.id, row);
    }

    return result;
  }

  public abstract execute(context: QueryContext): AsyncIterable<QueryRow>;
}

export class Union extends SetOperator {
  public readonly name = "Union";

  public async *execute(context: QueryContext): AsyncIterable<QueryRow> {
    const seen = new Set<string>();

    for (const input of this.inputs)
      for await (const row of input.execute(context)) {
        context.assertActive();

        if (seen.has(row.id)) continue;
        if (seen.size >= this.maxSetEntries) throw new QueryMemoryLimitError();

        seen.add(row.id);

        yield row;
      }
  }
}

export class Intersection extends SetOperator {
  public readonly name = "Intersection";

  public async *execute(context: QueryContext): AsyncIterable<QueryRow> {
    const [first, ...rest] = this.inputs;
    const candidates = await this.ids(context, first!);

    for (const input of rest) {
      const current = await this.ids(context, input);
      for (const id of [...candidates.keys()]) if (!current.has(id)) candidates.delete(id);
    }

    for (const row of candidates.values()) {
      context.assertActive();
      yield row;
    }
  }
}

export class Difference extends SetOperator {
  public readonly name = "Difference";

  public constructor(
    readonly universe: QueryOperator,
    readonly excluded: QueryOperator,
    maxSetEntries = 100_000,
  ) {
    super([universe, excluded], maxSetEntries);
  }

  public async *execute(context: QueryContext): AsyncIterable<QueryRow> {
    const excluded = await this.ids(context, this.excluded);

    for await (const row of this.universe.execute(context)) {
      context.assertActive();
      if (!excluded.has(row.id)) yield row;
    }
  }
}
