import type { PhysicalAccess, PhysicalPlan, ExplainResult } from "./physical-plan.js";

function inspect(access: PhysicalAccess, indexes: Set<string>, operators: string[]): void {
  operators.push(access.type);
  if ("index" in access) indexes.add(access.index);

  if (access.type == "union" || access.type == "intersection")
    for (const input of access.inputs) inspect(input, indexes, operators);
}

export function explainPhysicalPlan(plan: PhysicalPlan): ExplainResult {
  const indexes = new Set<string>();
  const operators: string[] = [];
  inspect(plan.access, indexes, operators);

  if (plan.residualPredicate) operators.push("filter");
  if (plan.requiresSort) operators.push("sort");
  if (plan.limit != null) operators.push("limit");
  if (plan.projection) operators.push("projection");

  return {
    plan,
    selectedIndexes: [...indexes].sort(),
    operators,
    residualFilter: plan.residualPredicate ?? null,
  };
}
