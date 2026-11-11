import type { IndexScalar, LogicalQuery, QueryOrder, QueryPredicate } from "@duraxis/core";
import { InvalidQueryError } from "../errors/index.js";
import type { EntityMetadata, EntityProperty } from "../metadata/entity-metadata.js";
import type { FindOptions } from "./find-options.js";
import type { Where } from "./where-operator.js";

const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull", "isMissing"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value == "object" && value != null && !Array.isArray(value) && !(value instanceof Date)
  );
}

export class QueryMapper<TEntity extends object> {
  public constructor(private readonly metadata: EntityMetadata<TEntity>) {}

  public map(options: FindOptions<TEntity> = {}): LogicalQuery {
    if (
      options.limit != null &&
      (!Number.isSafeInteger(options.limit) || options.limit < 0 || options.limit > 1_000_000)
    )
      throw new InvalidQueryError("Invalid query limit");

    if (options.projection?.length == 0) throw new InvalidQueryError("Projection cannot be empty");

    if (options.cursor != null && (options.cursor.length == 0 || options.cursor.length > 16_384))
      throw new InvalidQueryError("Invalid query cursor");

    const where = options.where ? this.where(options.where) : undefined;
    const orderBy: QueryOrder[] = [];

    for (const [property, direction] of Object.entries(options.orderBy ?? {})) {
      if (direction !== "ASC" && direction !== "DESC")
        throw new InvalidQueryError(`Invalid order for ${property}`);

      orderBy.push({ field: this.field(property), direction });
    }

    const projection = options.projection?.map((property) => {
      const field = this.field(property);
      if (field == "$id") throw new InvalidQueryError("Primary key is always returned separately");
      return field;
    });

    return {
      collection: this.metadata.collection,
      ...(where == null ? {} : { where }),
      ...(orderBy.length == 0 ? {} : { orderBy }),
      ...(projection == null ? {} : { projection }),
      ...(options.limit == null ? {} : { limit: options.limit }),
      ...(options.cursor == null ? {} : { cursor: options.cursor }),
    };
  }

  public where(where: Where<TEntity>): QueryPredicate {
    if (!isRecord(where)) throw new InvalidQueryError("Where clause must be an object");

    const predicates: QueryPredicate[] = [];

    for (const [property, condition] of Object.entries(where)) {
      if (property == "AND" || property == "OR") {
        if (!Array.isArray(condition) || condition.length == 0)
          throw new InvalidQueryError(`${property} requires at least one predicate`);

        predicates.push({
          type: property == "AND" ? "and" : "or",
          predicates: condition.map((item) => this.where(item as Where<TEntity>)),
        });
      } else if (property == "NOT") {
        predicates.push({ type: "not", predicate: this.where(condition as Where<TEntity>) });
      } else {
        predicates.push(...this.condition(property, condition));
      }
    }

    if (predicates.length == 0) throw new InvalidQueryError("Where clause cannot be empty");

    return predicates.length == 1 ? predicates[0]! : { type: "and", predicates };
  }

  public comparison(property: string, operator: string, value?: unknown): QueryPredicate {
    const field = this.field(property);

    if (["eq", "ne", "gt", "gte", "lt", "lte"].includes(operator))
      return {
        type: "comparison",
        field,
        operator: operator as "eq" | "ne" | "gt" | "gte" | "lt" | "lte",
        value: this.scalar(property, value),
      };

    if (operator == "in") {
      if (!Array.isArray(value) || value.length == 0)
        throw new InvalidQueryError(`IN on ${property} requires a non-empty array`);

      return { type: "in", field, values: value.map((item) => this.scalar(property, item)) };
    }

    if (operator == "isNull" || operator == "isMissing") return { type: operator, field };

    throw new InvalidQueryError(`Unknown query operator: ${operator}`);
  }

  public field(property: string): string {
    if (property == this.metadata.primaryKey) return "$id";

    const column = this.metadata.columnForProperty(property);
    if (!column) throw new InvalidQueryError(`Unknown entity property: ${property}`);

    return column.field;
  }

  private condition(property: string, condition: unknown): readonly QueryPredicate[] {
    this.field(property);

    if (!isRecord(condition)) return [this.comparison(property, "eq", condition)];

    const entries = Object.entries(condition);
    if (entries.length == 0) throw new InvalidQueryError(`Empty condition for ${property}`);

    return entries.map(([operator, value]) => {
      if (!OPERATORS.has(operator))
        throw new InvalidQueryError(`Unknown query operator: ${operator}`);

      if ((operator == "isNull" || operator == "isMissing") && value !== true)
        throw new InvalidQueryError(`${operator} must be true`);

      return this.comparison(property, operator, value);
    });
  }

  private scalar(property: string, value: unknown): IndexScalar {
    if (property == this.metadata.primaryKey) {
      if (typeof value == "string") return value;

      throw new InvalidQueryError("Primary-key comparisons require a string");
    }

    const column = this.metadata.columnForProperty(property);
    if (!column) throw new InvalidQueryError(`Unknown entity property: ${property}`);

    if (value === null) {
      if (column.nullable) return null;
      throw new InvalidQueryError(`Column ${property} is not nullable`);
    }

    if (column.type == "date" && value instanceof Date && Number.isFinite(value.getTime()))
      return value;

    if (column.type == "string" && typeof value == "string") return value;

    if (column.type == "boolean" && typeof value == "boolean") return value;

    if (column.type == "number" && typeof value == "number" && Number.isFinite(value)) return value;

    throw new InvalidQueryError(`Invalid query value for ${property}`);
  }
}
