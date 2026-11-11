import { entityConstructor, mutableDraft, propertyName } from "../metadata/decorator-metadata.js";

export interface PropertyIndexOptions {
  readonly name?: string;
  readonly unique?: boolean;
}

export interface CompositeIndexField {
  readonly property: string;
  readonly order?: "ASC" | "DESC";
}

export interface CompositeIndexOptions {
  readonly unique?: boolean;
}

export function Index(options?: PropertyIndexOptions): PropertyDecorator;
export function Index(
  name: string,
  fields: readonly CompositeIndexField[],
  options?: CompositeIndexOptions,
): ClassDecorator;
export function Index(
  nameOrOptions: string | PropertyIndexOptions = {},
  fields?: readonly CompositeIndexField[],
  compositeOptions: CompositeIndexOptions = {},
): PropertyDecorator | ClassDecorator {
  if (typeof nameOrOptions == "string") {
    return (target: Function) => {
      mutableDraft(target).indexes.push({
        kind: "composite",
        name: nameOrOptions,
        unique: compositeOptions.unique ?? false,
        fields: (fields ?? []).map((field) => ({
          property: field.property,
          order: field.order ?? "ASC",
        })),
      });
    };
  }

  return (target, key) => {
    mutableDraft(entityConstructor(target)).indexes.push({
      kind: "property",
      property: propertyName(key),
      ...(nameOrOptions.name == null ? {} : { name: nameOrOptions.name }),
      unique: nameOrOptions.unique ?? false,
    });
  };
}
