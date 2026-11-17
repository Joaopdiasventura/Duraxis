import type { ReferentialAction } from "@duraxis/core";
import type { EntityClass } from "../metadata/entity-metadata.js";
import {
  entityConstructor,
  mutableDraft,
  propertyName,
  type InverseSelector,
  type RelationTarget,
} from "../metadata/decorator-metadata.js";

export interface OwningRelationOptions {
  readonly foreignKey: string;
  readonly onDelete?: ReferentialAction;
}

export interface JoinTableOptions {
  readonly name: string;
  readonly joinColumn?: string;
  readonly inverseJoinColumn?: string;
}

type TargetFactory<TTarget extends object> = () => EntityClass<TTarget>;
type Selector<TTarget extends object> = (entity: TTarget) => unknown;

function relation(
  kind: "many-to-one" | "one-to-many" | "one-to-one" | "many-to-many",
  target: RelationTarget,
  inverse: InverseSelector | undefined,
  options: OwningRelationOptions | undefined,
): PropertyDecorator {
  return (prototype, key) => {
    mutableDraft(entityConstructor(prototype)).relations.push({
      kind,
      property: propertyName(key),
      target,
      ...(inverse ? { inverse } : {}),
      ...(options?.foreignKey ? { foreignKey: options.foreignKey } : {}),
      ...(options?.onDelete ? { onDelete: options.onDelete } : {}),
    });
  };
}

export function ManyToOne<TTarget extends object>(
  target: TargetFactory<TTarget>,
  options: OwningRelationOptions,
): PropertyDecorator {
  return relation("many-to-one", target, undefined, options);
}

export function OneToMany<TTarget extends object>(
  target: TargetFactory<TTarget>,
  inverse: Selector<TTarget>,
): PropertyDecorator {
  return relation("one-to-many", target, inverse as InverseSelector, undefined);
}

export function OneToOne<TTarget extends object>(
  target: TargetFactory<TTarget>,
  inverseOrOptions: Selector<TTarget> | OwningRelationOptions,
): PropertyDecorator {
  return typeof inverseOrOptions == "function"
    ? relation("one-to-one", target, inverseOrOptions as InverseSelector, undefined)
    : relation("one-to-one", target, undefined, inverseOrOptions);
}

export function ManyToMany<TTarget extends object>(
  target: TargetFactory<TTarget>,
  inverse: Selector<TTarget>,
): PropertyDecorator {
  return relation("many-to-many", target, inverse as InverseSelector, undefined);
}

export function JoinTable(options: JoinTableOptions): PropertyDecorator {
  return (prototype, key) => {
    mutableDraft(entityConstructor(prototype)).joinTables.push({
      property: propertyName(key),
      name: options.name,
      ...(options.joinColumn ? { joinColumn: options.joinColumn } : {}),
      ...(options.inverseJoinColumn ? { inverseJoinColumn: options.inverseJoinColumn } : {}),
    });
  };
}
