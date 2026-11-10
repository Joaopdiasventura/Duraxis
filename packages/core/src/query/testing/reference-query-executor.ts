import type { LogicalQuery } from "../model/query.js";
import type { QueryContext } from "../context/query-context.js";
import { CollectionScan } from "../executor/operators/operators.js";
import { QueryExecutor, type QueryPage } from "../executor/query-executor.js";
import type { QueryRow } from "../executor/predicate.js";

export class ReferenceQueryExecutor {
  private readonly executor = new QueryExecutor();
  public execute(context: QueryContext, query: LogicalQuery): AsyncIterable<QueryRow> {
    return this.executor.execute(context, query, new CollectionScan(query.collection));
  }
  public page(context: QueryContext, query: LogicalQuery): Promise<QueryPage> {
    return this.executor.page(context, query, new CollectionScan(query.collection));
  }
}
