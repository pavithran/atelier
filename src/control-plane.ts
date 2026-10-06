import { checkFiles, evidenceAt, matchesFolded, pushActors, scopesOverlap, SHIP_FILES, type Evidence, type ProjectPolicy } from "./rules.ts";

type Policy = { protected?: string[]; checks?: string[]; shipRuns?: string[]; shipKinds?: string[]; eligible?: string[]; refuseOverlap?: boolean };

export function controlPlaneChanges(before: Policy, after: Policy) {
  // Checks are not ControlPlane's to set, so a side that carries none, such
  // as the policy read from the files, is not compared on them.
  const checksCompared = before.checks !== undefined && after.checks !== undefined;
  const fields = (policy: Policy) => ({
    protected: [...new Set(policy.protected ?? [])].sort(),
    eligible: [...new Set(policy.eligible ?? [])].sort(),
    refuseOverlap: policy.refuseOverlap ?? false,
    ...(checksCompared ? { checks: [...new Set(policy.checks)].sort() } : {}),
  });
  const old = fields(before), current = fields(after);
  return (Object.keys(current) as (keyof typeof current)[]).filter((key) => JSON.stringify(old[key]) !== JSON.stringify(current[key]))
    .map((key) => `${key}: ${JSON.stringify(old[key])} -> ${JSON.stringify(current[key])}`);
}

// The policy an acceptance was made under, for the comparison at merge: the
// fields the acceptance recorded, over the server's policy as it was before
// this command refreshed it, which stands in for an acceptance made before
// every field was recorded. An acceptance that recorded no protected paths
// is taken as having protected none.
export function acceptancePolicy(detail: { policy: Policy; acceptanceProtected?: string[] | null; acceptancePolicy?: Policy | null }, before: Policy): Policy {
  const accepted = detail.acceptancePolicy ?? {};
  return {
    ...detail.policy, eligible: before.eligible, refuseOverlap: before.refuseOverlap, checks: before.checks,
    ...(before.shipRuns !== undefined || accepted.shipRuns !== undefined ? { shipRuns: accepted.shipRuns ?? before.shipRuns ?? [] } : {}),
    ...accepted, protected: detail.acceptanceProtected ?? [],
  };
}

// The ship order a checkout declares (cli/ship.mjs shipPolicy) is compared as
// a whole, since the gate guards the files its commands run: a ship order that
// changed since acceptance is a policy change for the merge guard, and for
// `atelier sync`'s report.
export function shipChanges(before: Policy, after: Policy): string[] {
  return (["shipRuns", "shipKinds"] as const)
    .filter((k) => JSON.stringify(before[k] ?? []) !== JSON.stringify(after[k] ?? []))
    .map((k) => `ship ${k === "shipRuns" ? "commands" : "approval kinds"}: ${JSON.stringify(before[k] ?? [])} -> ${JSON.stringify(after[k] ?? [])}`);
}

// What the merge guard needs of the item beyond its changed paths: who
// contributed to it, which required checks were observed passing at the
// accepted revision, and which live items its scope overlaps.
export interface MergeContext { contributors?: string[]; passed?: string[]; overlapping?: string[] }

export function mergeContext(
  detail: { item: { id: string; scope: string[]; acceptedHead: string | null }; policy: ProjectPolicy; evidence: Evidence[]; events: { actor: string; kind: string; data: Record<string, unknown> }[] },
  items: { id: string; state: string; owner: string | null; scope: string[] }[] = [],
): MergeContext {
  const { item } = detail;
  return {
    contributors: pushActors(detail.events),
    passed: evidenceAt(detail.policy, detail.evidence, item.acceptedHead).checks.filter((c) => c.grade === "observed" && c.passed).map((c) => c.claim),
    overlapping: items.filter((o) => o.id !== item.id && (o.state === "claimed" || o.state === "submitted") && scopesOverlap(item.scope, o.scope)).map((o) => `${o.id} (${o.owner ?? "unowned"})`),
  };
}

// Eligibility as assertEligible reads the list: by the actor's harness.
const eligible = (actor: string, list: string[] | undefined) => {
  const harness = actor.split("/")[0];
  return !list?.length || list.some((k) => harness === k || harness.startsWith(`${k}-`));
};

export function mergePolicyDecision(before: Policy, after: Policy, paths: string[], allowChanged = false, context: MergeContext = {}) {
  const changes = [...controlPlaneChanges(before, after), ...shipChanges(before, after)];
  // Matched as changeClass matches the guarded set: whatever the letter case or Unicode form.
  const guarded = (policy: Policy) => [...(policy.protected ?? []), ...checkFiles(policy.checks ?? []), ...SHIP_FILES, ...checkFiles(policy.shipRuns ?? [])];
  const newlyProtected = paths.filter((path) => matchesFolded(path, guarded(after)) && !matchesFolded(path, guarded(before)));
  // What the accepted item satisfied under the policy it was accepted under
  // and no longer does under the policy as it is now.
  const reasons: string[] = [];
  if (newlyProtected.length) reasons.push(`the accepted revision touches newly protected paths: ${newlyProtected.join(", ")}`);
  const ineligible = (context.contributors ?? []).filter((actor) => eligible(actor, before.eligible) && !eligible(actor, after.eligible));
  if (ineligible.length) reasons.push(`its contributors are no longer eligible here: ${ineligible.join(", ")} (eligible: ${(after.eligible ?? []).join(", ")})`);
  const unchecked = before.checks && after.checks ? after.checks.filter((c) => !before.checks!.includes(c) && !(context.passed ?? []).includes(c)) : [];
  if (unchecked.length) reasons.push(`checks required now were not observed passing at the accepted revision: ${unchecked.map((c) => `\`${c}\``).join(", ")}`);
  if (after.refuseOverlap && !before.refuseOverlap && context.overlapping?.length) reasons.push(`overlapping claims are now refused, and its scope overlaps live ${context.overlapping.join(", ")}`);
  return {
    warning: changes.length ? `Warning: ControlPlane policy changed since acceptance: ${changes.join("; ")}` : null,
    refusal: changes.length && reasons.length && !allowChanged
      ? `${reasons.join("; ")}. Review the task again on its page and accept again, or use --policy-changed-ok after reviewing this policy change.` : null,
  };
}
