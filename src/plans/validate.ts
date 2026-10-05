import { scopesOverlap } from "../rules.ts";
import type { Plan } from "./schema.ts";

export function validatePlan(plan: Plan): string[] {
  const errors: string[] = [];
  if (plan.parts.length > 12) errors.push("plan.parts: must contain at most 12 parts");
  const parts = new Map(plan.parts.map((part) => [part.key, part]));
  const seen = new Set<string>();
  for (const part of plan.parts) {
    if (seen.has(part.key)) errors.push(`part ${part.key}.key: duplicate key`);
    seen.add(part.key);
    if (part.scope.length > 6) errors.push(`part ${part.key}.scope: must contain at most 6 globs`);
    for (const dep of part.dependsOn) {
      if (!parts.has(dep)) errors.push(`part ${part.key}.dependsOn: unknown part ${dep}`);
      else if (part.kind === "interface" && parts.get(dep)!.kind !== "interface") {
        errors.push(`part ${part.key}.dependsOn: interface parts may depend only on interface parts (${dep})`);
      }
    }
  }
  if (seen.size !== plan.parts.length) return errors;

  const dependencies = new Map(plan.parts.map((part) => [part.key, new Set(part.dependsOn.filter((key) => parts.has(key)))]));
  const remaining = new Map([...dependencies].map(([key, deps]) => [key, new Set(deps)]));
  const ready = [...remaining].filter(([, deps]) => !deps.size).map(([key]) => key);
  for (const key of ready) {
    remaining.delete(key);
    for (const [other, deps] of remaining) if (deps.delete(key) && !deps.size) ready.push(other);
  }
  if (remaining.size) {
    // Kahn's remainder includes blocked descendants. Follow dependencies to
    // name an actual cycle rather than reporting those descendants as cyclic.
    const path: string[] = [];
    let key = remaining.keys().next().value!;
    while (!path.includes(key)) {
      path.push(key);
      key = remaining.get(key)!.values().next().value!;
    }
    const cycle = [...path.slice(path.indexOf(key)), key];
    errors.push(`part ${key}.dependsOn: cycle ${cycle.join(" -> ")}`);
  }

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
  return errors;
}
