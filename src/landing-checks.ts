import { evidenceAt, RuleError, type Evidence, type ProjectPolicy } from "./rules.ts";

// Recheck scoped checks at the merge boundary: acceptance may predate a
// policy change or a failed retry. Legacy container results cannot prove
// that a heavier check ran on a runner.
export function assertLandingChecks(id: string, policy: ProjectPolicy, evidence: Evidence[], head: string | null): void {
  const commands = new Set(policy.checkPaths?.filter((c) => c.paths.length).map((c) => c.command));
  const scoped = { ...policy, checks: policy.checks.filter((c) => commands.has(c)) };
  if (!scoped.checks.length) return;
  const view = evidenceAt(scoped, evidence.filter((e) => e.grade === "reported" || e.where === "runner"), head);
  const missing = view.checks.filter((c) => c.grade !== "observed" || !c.passed).map((c) => `\`${c.claim}\``);
  if (missing.length) throw new RuleError("not_ready", `${id} cannot merge until these path-scoped checks pass on a runner at the exact head: ${missing.join(", ")}`, 409, `run atelier check ${id}, then atelier land ${id} again`);
}
