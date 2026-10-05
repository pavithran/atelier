import { scopesOverlap } from "../rules.ts";
import { parsePlan, type Plan } from "./schema.ts";
import { planErrors } from "./errors.ts";

export function validatePlan(plan: Plan): string[] {
  const parsed = parsePlan(plan);
  if (!parsed.ok) return parsed.errors;
  plan = parsed.plan;
  const errors = planErrors();
  const parts = new Map(plan.parts.map((part) => [part.key, part]));
  const seen = new Set<string>();
  for (const part of plan.parts) {
    if (seen.has(part.key)) errors.push(`part ${part.key}.key: duplicate key`);
    seen.add(part.key);
    for (const dep of part.dependsOn) {
      if (!parts.has(dep)) errors.push(`part ${part.key}.dependsOn: unknown part ${dep}`);
      else if (part.kind === "interface" && parts.get(dep)!.kind !== "interface") {
        errors.push(`part ${part.key}.dependsOn: interface parts may depend only on interface parts (${dep})`);
      }
    }
  }
  if (seen.size !== plan.parts.length) return errors.result();

  const dependencies = new Map(plan.parts.map((part) => [part.key, new Set(part.dependsOn.filter((key) => parts.has(key)))]));
  const remaining = new Map([...dependencies].map(([key, deps]) => [key, new Set(deps)]));
  const ready = [...remaining].filter(([, deps]) => !deps.size).map(([key]) => key);
  for (const key of ready) {
    remaining.delete(key);
    for (const [other, deps] of remaining) if (deps.delete(key) && !deps.size) ready.push(other);
  }
  // Visit every remaining branch, including separate cycles. Blocked
  // descendants are not named as members of a cycle.
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (key: string) => {
    const start = path.indexOf(key);
    if (start !== -1) {
      errors.push(`part ${key}.dependsOn: cycle ${[...path.slice(start), key].join(" -> ")}`);
      return;
    }
    if (visited.has(key)) return;
    visited.add(key);
    path.push(key);
    for (const dep of remaining.get(key)!) visit(dep);
    path.pop();
  };
  for (const key of remaining.keys()) visit(key);

  const reaches = (from: string, target: string): boolean => {
    const visited = new Set<string>([from]);
    const pending = [...dependencies.get(from)!];
    for (const key of pending) {
      if (visited.has(key)) continue;
      if (key === target) return true;
      visited.add(key);
      pending.push(...dependencies.get(key)!);
    }
    return false;
  };
  for (const [i, part] of plan.parts.entries()) {
    for (const other of plan.parts.slice(i + 1)) {
      if (scopesOverlap(part.scope, other.scope) && !reaches(part.key, other.key) && !reaches(other.key, part.key)) {
        errors.push(`part ${part.key}.scope: overlaps part ${other.key}.scope without dependency ordering`);
      }
    }
    for (const use of part.uses) {
      if (!plan.parts.some((provider) => provider.provides.includes(use) && reaches(part.key, provider.key))) {
        errors.push(`part ${part.key}.uses: ${use} has no provider reachable through dependsOn`);
      }
    }
  }
  // Size M's model context-window rule belongs to step 3, routing.
  return errors.result();
}
