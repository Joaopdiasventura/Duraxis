import { entityConstructor, mutableDraft, propertyName } from "../metadata/decorator-metadata.js";

/** Declares the logical record identifier. It is never stored inside the document. */
export function PrimaryKey(): PropertyDecorator {
  return (target, key) => {
    mutableDraft(entityConstructor(target)).primaryKeys.push(propertyName(key));
  };
}
