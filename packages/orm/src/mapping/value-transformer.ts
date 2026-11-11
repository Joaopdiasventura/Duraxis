import { InvalidColumnError } from "../errors/index.js";
import type { ColumnMetadata } from "../metadata/entity-metadata.js";

export class ValueTransformer {
  public toDocument<TEntity extends object>(
    column: ColumnMetadata<TEntity>,
    value: unknown,
  ): unknown {
    if (value === null) {
      if (!column.nullable)
        throw new InvalidColumnError(`Column ${column.property} is not nullable`);
      return null;
    }

    switch (column.type) {
      case "string":
        return typeof value != "string" ? this.invalid(column, "string") : value;

      case "number":
        return typeof value != "number" || !Number.isFinite(value)
          ? this.invalid(column, "finite number")
          : Object.is(value, -0)
            ? 0
            : value;

      case "boolean":
        return typeof value != "boolean" ? this.invalid(column, "boolean") : value;

      case "date":
        return !(value instanceof Date) || !Number.isFinite(value.getTime())
          ? this.invalid(column, "valid Date")
          : value.toISOString();
    }
  }

  public fromDocument<TEntity extends object>(
    column: ColumnMetadata<TEntity>,
    value: unknown,
  ): unknown {
    if (value === null) {
      if (!column.nullable)
        throw new InvalidColumnError(`Stored column ${column.field} is not nullable`);

      return null;
    }

    if (column.type == "date") {
      if (typeof value != "string") return this.invalid(column, "canonical date string");

      const date = new Date(value);

      return !Number.isFinite(date.getTime()) || date.toISOString() != value
        ? this.invalid(column, "canonical date string")
        : date;
    }
    
    return this.toDocument(column, value);
  }

  private invalid<TEntity extends object>(
    column: ColumnMetadata<TEntity>,
    expected: string,
  ): never {
    throw new InvalidColumnError(`Column ${column.property} must be a ${expected}`);
  }
}
