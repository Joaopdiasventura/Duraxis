import type { ColumnOptions, EntityClass } from "./entity-metadata.js";

export interface DraftColumn {
  readonly property: string;
  readonly options: ColumnOptions;
}

export interface DraftPropertyIndex {
  readonly kind: "property";
  readonly property: string;
  readonly name?: string;
  readonly unique: boolean;
}

export interface DraftCompositeIndex {
  readonly kind: "composite";
  readonly name: string;
  readonly unique: boolean;
  readonly fields: readonly { readonly property: string; readonly order: "ASC" | "DESC" }[];
}

export interface DecoratorDraft {
  entityName?: string;
  entityApplications: number;
  readonly columns: DraftColumn[];
  readonly primaryKeys: string[];
  readonly indexes: Array<DraftPropertyIndex | DraftCompositeIndex>;
}

const drafts = new WeakMap<Function, DecoratorDraft>();

export function ownDraft(entity: Function): DecoratorDraft | undefined {
  return drafts.get(entity);
}

export function mutableDraft(entity: Function): DecoratorDraft {
  let draft = drafts.get(entity);

  if (!draft) {
    draft = { entityApplications: 0, columns: [], primaryKeys: [], indexes: [] };
    drafts.set(entity, draft);
  }

  return draft;
}

export function entityConstructor(target: object): EntityClass {
  const constructor = target.constructor;
  if (typeof constructor != "function") throw new TypeError("Invalid decorator target");
  return constructor as EntityClass;
}

export function propertyName(value: string | symbol): string {
  if (typeof value != "string") throw new TypeError("Symbol entity properties are not supported");
  return value;
}
