import { mutableDraft } from "../metadata/decorator-metadata.js";

export function Entity(name?: string): ClassDecorator {
  return (target) => {
    const draft = mutableDraft(target);
    draft.entityApplications++;
    draft.entityName = name ?? target.name;
  };
}
