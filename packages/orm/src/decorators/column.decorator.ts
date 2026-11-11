import type { ColumnOptions } from "../metadata/entity-metadata.js";
import { entityConstructor, mutableDraft, propertyName } from "../metadata/decorator-metadata.js";

export function Column(options: ColumnOptions): PropertyDecorator {
  return (target, key) => {
    mutableDraft(entityConstructor(target)).columns.push({
      property: propertyName(key),
      options: { ...options },
    });
  };
}
