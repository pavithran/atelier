import { checkFiles, matchesFolded } from "./rules.ts";

type Policy = { protected?: string[]; checks?: string[]; eligible?: string[]; refuseOverlap?: boolean };

export function controlPlaneChanges(before: Policy, after: Policy) {
  const fields = (policy: Policy) => ({
    protected: [...new Set(policy.protected ?? [])].sort(),
    eligible: [...new Set(policy.eligible ?? [])].sort(),
    refuseOverlap: policy.refuseOverlap ?? false,
  });
  const old = fields(before), current = fields(after);
  return (Object.keys(current) as (keyof typeof current)[]).filter((key) => JSON.stringify(old[key]) !== JSON.stringify(current[key]))
    .map((key) => `${key}: ${JSON.stringify(old[key])} -> ${JSON.stringify(current[key])}`);
}

export function mergePolicyDecision(before: Policy, after: Policy, paths: string[], allowChanged = false) {
  const changes = controlPlaneChanges(before, after);
  // Matched as changeClass matches the guarded set: whatever the letter case or Unicode form.
  const guarded = (policy: Policy) => [...(policy.protected ?? []), ...checkFiles(policy.checks ?? [])];
  const newlyProtected = paths.filter((path) => matchesFolded(path, guarded(after)) && !matchesFolded(path, guarded(before)));
  return {
    warning: changes.length ? `Warning: ControlPlane policy changed since acceptance: ${changes.join("; ")}` : null,
    refusal: changes.length && newlyProtected.length && !allowChanged
      ? `the accepted revision touches newly protected paths: ${newlyProtected.join(", ")}. Review the task again on its page and accept again, or use --policy-changed-ok after reviewing this policy change.` : null,
  };
}

