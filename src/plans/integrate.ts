// Integration rules for a plan's parts, as pure functions. A plan item's
// fork is its integration branch: each part is merged into it with
// `git merge --no-ff`, the plan's checks run there, and once every part is
// in, the owner merges the whole branch into main (docs/orchestrator.md,
// section 5). These functions decide when a part may be merged, whether the
// merge the integrator reports is the one expected, how a failed merge is
// undone, which part goes next, and whether the plan may be accepted. They
// read nothing themselves: the Worker, the Ledger and the runner pass in what
// they observed, so the rules can be tested with `node --test`.
//
// The integration head is the plan branch's head as the Ledger last recorded
// it: the merge commit of its latest recorded integration (or of a refresh
// that merged main in), or the commit the plan forked from when there is
// neither. An integration is recorded only when its merge commit's first
// parent is the integration head, so the recorded heads form one first-parent
// line, and a branch whose head is the integration head holds nothing beyond
// what was recorded.

import { familyOf } from "../models/pool.ts";
import {
  countingReviews, DEFAULT_OWNER, evidenceAt, gate, modelOf, validActor,
  type Evidence, type Gate, type Item, type ItemState, type ProjectPolicy, type Review,
} from "../rules.ts";

// A part is an item, so it has an item's states, and one more: integrated,
// merged into the plan's branch with the plan's checks passing there. It
// leaves integrated only with its plan: merged when the plan lands on main,
// or abandoned with the plan.
export type PartState = ItemState | "integrated";

// A part is integrated only from submitted. Its builder has finished, so its
// head stays put while the integrator merges it, and the review that lets it
// in was of that head. A claimed part may still push. Parts do not take the
// owner's acceptance (they never appear as accept entries), so accepted is
// not a way in. A merged or abandoned part is closed, and an integrated one is
// already in.
export const INTEGRABLE_FROM: readonly PartState[] = ["submitted"];

// A dependency has landed when it is integrated or merged. Integrated puts its
// changes on the plan's branch, which dependents fork from; merged is what an
// integrated part becomes when its plan lands on main, so it has landed too.
export const LANDED: readonly PartState[] = ["integrated", "merged"];

export function landed(state: PartState): boolean {
  return LANDED.includes(state);
}

// What these rules read of a part. The item fields keep the item's names, so
// the Ledger can pass an item with the part's plan fields beside it.
export interface Part {
  id: string;                        // the part's item, tN
  key: string;                       // its key in the approved plan
  dependsOn: readonly string[];      // the keys of the parts it depends on
  state: PartState;
  head: string | null;               // the last head Atelier verified in the part's fork
  owner: string | null;
  pushActors?: readonly string[];    // holders and recorded push contributors
  integration?: Integration | null;  // recorded when the part became integrated
}

export interface Integration {
  head: string;         // the part's head that was merged, the one reviewed
  mergeCommit: string;  // the merge commit on the plan's branch
}

// One commit of a log, as Artifacts and `git log --format='%H %P'` list it.
export interface LogCommit {
  hash: string;
  parents: readonly string[];
}

const HASH = /^[a-f0-9]{40,64}$/;
const short = (hash: string) => hash.slice(0, 8);
const named = (part: Pick<Part, "key" | "id">) => `part ${part.key} (${part.id})`;

// Whether a reviewer is of another model family than everyone who built the
// part, both families recognised, as gate() counts a cross-family review of a
// protected change. A builder never counts as its own reviewer.
function otherFamily(reviewer: string, contributors: readonly string[]): boolean {
  if (!validActor(reviewer) || !reviewer.includes("/")) return false;
  const family = familyOf(modelOf(reviewer));
  return family !== "other" && contributors.every((actor) => {
    const theirs = familyOf(modelOf(actor));
    return actor !== reviewer && theirs !== "other" && theirs !== family;
  });
}

// The reviews that let a part's head into the plan. Reviews count as gate()
// counts them: the latest from each reviewer at that head, from the project
// owner or an assessor. One approval is needed, by the owner or by another
// family than the part's builders, whatever paths the part changes, because
// the orchestrator reviews every part. A counting rejection at that head
// blocks, as it does in gate().
function reviewBlockers(part: Part, head: string, reviews: Review[], policy: ProjectPolicy, owner: string): string[] {
  const counting = countingReviews(reviews.filter((r) => r.itemId === part.id), head, policy, owner);
  const contributors = [...new Set([...(part.pushActors ?? []), ...(part.owner ? [part.owner] : [])])];
  const approved = counting.some((r) => r.approve && (r.by === owner || otherFamily(r.by, contributors)));
  const blockers = approved ? [] : [`${named(part)} has no approval from another model family at ${short(head)}`];
  for (const r of counting) if (!r.approve) blockers.push(`${named(part)} was rejected at ${short(head)} by ${r.by}: ${r.note || "no note"}`);
  return blockers;
}

// Why a part may not be integrated now; empty when it may. It must be
// submitted, every part it depends on must have landed, and its head must
// carry an approval from another family. The review is read only for a
// submitted part, since an earlier state has no settled head to approve.
export function integrationBlockers(part: Part, parts: readonly Part[], reviews: Review[], policy: ProjectPolicy, owner = DEFAULT_OWNER): string[] {
  const blockers: string[] = [];
  const submitted = INTEGRABLE_FROM.includes(part.state);
  if (!submitted) blockers.push(`${named(part)} is ${part.state}; only a submitted part is integrated`);
  for (const key of part.dependsOn) {
    const dep = parts.find((p) => p.key === key);
    if (!dep) blockers.push(`${named(part)} depends on part ${key}, which is not in the plan`);
    else if (!landed(dep.state)) blockers.push(`${named(part)} waits for ${named(dep)}, which is ${dep.state}`);
  }
  if (submitted && !part.head) blockers.push(`${named(part)} has no verified head`);
  if (submitted && part.head) blockers.push(...reviewBlockers(part, part.head, reviews, policy, owner));
  return blockers;
}

// The part to integrate next: the first in plan order that may be integrated
// now, or null when none may. A part whose dependencies have not landed is
// never chosen. Integrations run one at a time on the plan item, so the order
// only decides which part waits; plan order gives the same answer whatever
// order the parts' states arrived in. The caller passes the parts in the
// approved plan's order.
export function nextToIntegrate(parts: readonly Part[], reviews: Review[], policy: ProjectPolicy, owner = DEFAULT_OWNER): Part | null {
  return parts.find((part) => integrationBlockers(part, parts, reviews, policy, owner).length === 0) ?? null;
}

// The branch's first-parent line: from the head, log[0], each commit's first
// parent, as far as the log reaches.
function firstParentLine(log: readonly LogCommit[]): Set<string> {
  const byHash = new Map(log.map((c) => [c.hash, c]));
  const line = new Set<string>();
  for (let c: LogCommit | undefined = log[0]; c && !line.has(c.hash); c = byHash.get(c.parents[0] ?? "")) line.add(c.hash);
  return line;
}

export interface IntegrationClaim {
  log: readonly LogCommit[];  // the plan branch's log, newest first; log[0] is its head
  integrationHead: string;    // the plan branch's integration head before this integration
  partHead: string;           // the part's verified head
  mergeCommit: string;        // the commit the integrator reports
}

// Whether the integrator's report holds: its merge commit is on the plan
// branch's first-parent line and merges the part's head onto the integration
// head. The merged route checks a merge onto main the same way: the commit is
// in main's log and its parents include the accepted head. Two checks are
// added here. The first parent must be the integration head, so nothing lands
// on the branch between recorded integrations. The parents must be exactly
// two, so a merge cannot bring in a commit nobody reviewed. The merge commit
// need not be the branch's head: planGate refuses a branch whose head is not
// the integration head, and the next integration must sit on this one.
// Returns the reasons the report fails; empty when it holds.
export function verifyIntegration(claim: IntegrationClaim): string[] {
  const { log, integrationHead, partHead, mergeCommit } = claim;
  if (!HASH.test(mergeCommit)) return ["the merge commit is not a full commit hash"];
  const commit = log.find((c) => c.hash === mergeCommit);
  if (!commit) return [`${short(mergeCommit)} is not in the plan branch's log`];
  const reasons: string[] = [];
  const merge = short(mergeCommit), count = commit.parents.length;
  if (!firstParentLine(log).has(mergeCommit)) reasons.push(`${merge} is not on the plan branch's first-parent line`);
  if (!commit.parents.includes(partHead)) reasons.push(`${merge}'s parents do not include the part's head ${short(partHead)}`);
  if (commit.parents[0] !== integrationHead) {
    reasons.push(`${merge}'s first parent is ${count ? short(commit.parents[0]) : "missing"}, not the plan's integration head ${short(integrationHead)}`);
  }
  if (count !== 2) reasons.push(`${merge} has ${count} parent${count === 1 ? "" : "s"}; an integration merges one part, so it has two`);
  if (partHead === integrationHead) reasons.push("the part's head is the plan's integration head; there is nothing to merge");
  return reasons;
}

// The plan's required checks at the merge commit, read as gate() reads
// evidence: each must be observed passing there. The integrator runs them
// before it reports, and the Ledger records the integration only on this
// observation, so a recorded integration leaves the plan's branch passing its
// checks on Atelier's word, not the integrator's. Pass the plan item's
// evidence. Returns what is pending or failing; empty when every check passed.
export function integrationChecks(policy: ProjectPolicy, evidence: Evidence[], mergeCommit: string): string[] {
  return evidenceAt(policy, evidence, mergeCommit).checks.flatMap((c) =>
    c.grade === "pending" ? [`\`${c.claim}\` not yet observed at ${short(mergeCommit)}`]
      : c.passed ? [] : [`\`${c.claim}\` failed when observed at ${short(mergeCommit)}`]);
}

// What a failed integration does to the plan's branch. The integrator pushes
// its merge before the checks run; when they fail, the branch must return to
// the integration head. The answer depends only on the branch's head:
//   none: the head is the integration head, as after a merge that conflicted
//     and was never pushed, or after a rollback that held.
//   restore: the head is this integration's merge, the part's head merged onto
//     the integration head, the one shape verifyIntegration accepts. The
//     integrator runs
//       git push --force-with-lease=<branch>:<lease> <remote> <restore>:<branch>
//     so the push lands only while the branch is still at that merge.
//   refuse: the head is anything else. Restoring the integration head would
//     discard commits this integration did not make, so the branch stays as
//     it is and the reason goes to the owner.
// The Worker asks the same question of the branch's log once integration-failed
// is posted: none means the branch is back at the integration head.
export type Rollback =
  | { action: "none" }
  | { action: "restore"; lease: string; restore: string }
  | { action: "refuse"; reason: string };

export function rollbackFor(log: readonly LogCommit[], integrationHead: string, partHead: string): Rollback {
  const head = log[0];
  if (!head) return { action: "refuse", reason: "the plan branch's log is empty" };
  if (head.hash === integrationHead) return { action: "none" };
  const [first, second, ...more] = head.parents;
  if (first === integrationHead && second === partHead && !more.length) return { action: "restore", lease: head.hash, restore: integrationHead };
  return {
    action: "refuse",
    reason: `the plan branch is at ${short(head.hash)}, which is neither its integration head ${short(integrationHead)} nor a merge of the part's head ${short(partHead)} onto it; it was not rolled back`,
  };
}

export interface PlanGateInput {
  plan: Item;                      // the plan item; its fork is the integration branch
  parts: readonly Part[];          // every part of the plan, in plan order
  integrationHead: string | null;  // as the Ledger recorded it; null when it recorded none
  policy: ProjectPolicy;
  evidence: Evidence[];            // the plan item's
  reviews: Review[];               // the plan item's and its parts', told apart by itemId
  owner?: string;
}

// Whether the owner may accept a plan for main. It is gate() for the plan
// item, so the plan's required checks must be observed passing at its
// branch's head and the plan's own reviews count as for any item, with these
// blockers added:
//   every part is integrated, merged or abandoned. The owner may abandon a
//     part of a blocked plan; it brings nothing to the branch, but a part that
//     depends on it can never land, and that part blocks;
//   a part abandoned after it was integrated blocks, because its changes are
//     on the branch although the plan gave it up;
//   each integrated part has an approval from another family at the head that
//     was integrated, and no counting rejection there;
//   at least one part is integrated, or the plan brings nothing to main;
//   the plan's head is its integration head, so the branch holds the recorded
//     integrations and nothing pushed beside them.
// The owner's acceptance and the merge itself are unchanged: atelier merge tP
// --head H --approve reviews the plan, accepts it through this gate and lands
// it under the landing lease. An accepted plan is checked again as accept()
// does, with its state passed as submitted.
export function planGate(input: PlanGateInput): Gate {
  const { plan, parts, integrationHead, policy, evidence, reviews, owner = DEFAULT_OWNER } = input;
  const g = gate(plan, policy, evidence, reviews.filter((r) => r.itemId === plan.id), owner);
  const blockers = [...g.blockers];
  for (const part of parts) {
    if (part.state === "merged") continue;
    if (part.state === "abandoned") {
      if (part.integration) blockers.push(`${named(part)} was abandoned after it was integrated; its changes are on the plan's branch`);
      continue;
    }
    if (part.state !== "integrated") {
      const gone = part.dependsOn.map((key) => parts.find((p) => p.key === key)).filter((dep) => dep?.state === "abandoned");
      blockers.push(`${named(part)} is ${part.state}, not integrated${gone.length ? `, and cannot be: it depends on abandoned ${gone.map((dep) => named(dep!)).join(", ")}` : ""}`);
      continue;
    }
    if (!part.integration) blockers.push(`${named(part)} is integrated, but no integration is recorded`);
    else blockers.push(...reviewBlockers(part, part.integration.head, reviews, policy, owner));
  }
  if (!parts.some((part) => part.state === "integrated")) blockers.push("no part is integrated; the plan brings nothing to main");
  if (plan.head && plan.head !== integrationHead) {
    blockers.push(`the plan's head ${short(plan.head)} is not its integration head ${integrationHead ? short(integrationHead) : "(none recorded)"}; the branch has commits no integration recorded`);
  }
  return { ...g, ready: blockers.length === 0, blockers };
}
