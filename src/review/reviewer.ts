// Choosing the reviewer for a submission. The reviewer is a model of another
// recognised family than every contributor to the item, available, not
// refused, paid only when the owner allows it, and one whose review the
// ledger will record and the gate will count. Candidates are asked in this
// order: on a re-review, the previous round's reviewer; then the plan's
// routed reviewer for the part; then the part's alternates; then the rest of
// the pool. Each choice carries its reasons in the words src/plans/route.ts
// uses for the same rules, and when no model qualifies the result says why,
// naming each model passed over.
//
// The family rule is the one gate() in src/rules.ts applies to a protected
// change in every project, and automatic review applies it to every part
// whatever its class: a model of the builder's family is likely to share the
// builder's blind spots, so a different model alone is a weaker second
// opinion.

import type { ModelEntry } from "../models/pool.ts";
import { MODEL_PROFILES, type ModelProfile } from "../models/registry.ts";
import { paidPerToken, SIZE_M_CONTEXT, type Availability, type Choice, type PartRoute } from "../plans/route.ts";
import type { PlanPart } from "../plans/schema.ts";
import { assertEligible, DEFAULT_OWNER, hasRole, parseRuleError, sameActor, type Item, type ProjectPolicy } from "../rules.ts";
import { actorFamily, contributorsOf, describeContributors, familyRefusal } from "./independence.ts";

export interface PickInput {
  item: Pick<Item, "owner" | "pushActors">;     // its contributors, as the gate counts them
  pool: readonly ModelEntry[];
  policy: ProjectPolicy;
  allowPaid: boolean;                           // for a part, as the plan was approved
  spend?: { cap: number; used: number };        // paid models are excluded once used reaches cap
  availability?: Readonly<Record<string, Availability>>;
  part?: Pick<PlanPart, "taskKind" | "size"> | null;
  route?: Pick<PartRoute, "reviewer" | "alternates"> | null;  // the part's routing, frozen at approval
  previous?: string | null;                     // the reviewer of the last rejected round
  avoid?: readonly { actor: string; reason: string }[];       // reviewers to pass over, such as one whose claim lapsed
  profiles?: readonly ModelProfile[];           // context windows; MODEL_PROFILES by default
  owner?: string;
}

// The invariant: unpicked is null exactly when reviewer is set.
export interface ReviewerPick {
  reviewer: Choice | null;
  passedOver: Choice[];       // candidates that failed a rule, in the order they were asked
  unpicked: string | null;    // why no reviewer qualifies; null when one does
}

type Source = { kind: "previous" | "routed" | "pool" } | { kind: "alternate"; index: number };

const actorOf = (entry: ModelEntry) => `${entry.harness}/${entry.id}`;
const namesOf = (entry: ModelEntry) => [entry.id, ...entry.aliases].map((id) => `${entry.harness}/${id}`.toLowerCase());
const findEntry = (pool: readonly ModelEntry[], actor: string) => pool.find((entry) => namesOf(entry).includes(actor.toLowerCase()));

export function pickReviewer(input: PickInput): ReviewerPick {
  const contributors = contributorsOf(input.item);
  const none = (unpicked: string, passedOver: Choice[] = []): ReviewerPick => ({ reviewer: null, passedOver, unpicked });
  if (!contributors.length) return none("no contributor is recorded for this item, so no reviewer can be shown to be independent of its authors");
  const unknown = contributors.filter((c) => actorFamily(c) === "other");
  if (unknown.length) {
    return none(`no reviewer can be of another family than ${unknown.join(", ")}, whose family is not recognised from ${unknown.length === 1 ? "its name" : "their names"}`);
  }

  // Outside the plan's routing nothing here scores models: the routing
  // scored the reviewer and alternates when the plan was approved. The rest
  // of the pool follows in model id, then actor name order, route()'s
  // tie-break, so the result never depends on the order the pool arrives in.
  const wanted: { actor: string; source: Source }[] = [];
  if (input.previous) wanted.push({ actor: input.previous, source: { kind: "previous" } });
  if (input.route?.reviewer) wanted.push({ actor: input.route.reviewer.actor, source: { kind: "routed" } });
  input.route?.alternates.forEach((c, index) => wanted.push({ actor: c.actor, source: { kind: "alternate", index } }));
  const pool = [...input.pool].sort((a, b) => a.id.localeCompare(b.id) || actorOf(a).localeCompare(actorOf(b)));
  for (const entry of pool) wanted.push({ actor: actorOf(entry), source: { kind: "pool" } });

  const seen = new Set<string>();
  const passedOver: Choice[] = [];
  const lead: string[] = [];
  for (const { actor, source } of wanted) {
    const entry = findEntry(input.pool, actor);
    const key = entry ? actorOf(entry).toLowerCase() : actor.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const judged = entry ? judge(entry, contributors, input) : { failed: ["not in the pool"], passed: [] };
    if (!entry || judged.failed.length) {
      passedOver.push({ actor: entry ? actorOf(entry) : actor, reasons: judged.failed });
      const why = entry ? `not chosen: ${judged.failed.join("; ")}` : "it is not in the pool";
      if (source.kind === "previous") lead.push(`The previous round's reviewer was ${actor}; ${why}`);
      if (source.kind === "routed") lead.push(`The plan routed ${actor} to review this part; ${why}`);
      continue;
    }
    return { reviewer: { actor: actorOf(entry), reasons: [...lead, position(source, input), ...judged.passed] }, passedOver, unpicked: null };
  }
  const tried = passedOver.length ? passedOver.map((c) => `${c.actor} (${c.reasons.join("; ")})`).join(", ") : "no model in the pool";
  return none(`no reviewer of another family than every contributor (${describeContributors(contributors)}): ${tried}`, passedOver);
}

function position(source: Source, input: PickInput): string {
  if (source.kind === "previous") return "Reviewed the previous round; a re-review goes to the same reviewer first";
  if (source.kind === "routed") return "The plan's routed reviewer for this part";
  if (source.kind === "alternate") return `Alternate ${source.index + 1} in the plan's routing for this part`;
  return input.route
    ? "From the pool, after the plan's routing named no model that qualifies; the pool goes by model id, then actor name"
    : "From the pool, which goes by model id, then actor name";
}

// Every rule is applied, so a model passed over is shown with all the rules
// it failed, and a chosen one with all it passed.
function judge(entry: ModelEntry, contributors: readonly string[], input: PickInput): { failed: string[]; passed: string[] } {
  const actor = actorOf(entry);
  const names = namesOf(entry);
  const failed: string[] = [];
  const passed: string[] = [];
  const policy = input.policy;

  // A contributor under another letter case, profile or registered name of
  // this entry's model, in the same harness, is this entry.
  if (contributors.some((c) => names.some((name) => sameActor(name, c)))) failed.push("contributed to this item, and nobody reviews their own work");
  else {
    const family = familyRefusal(actor, contributors);
    if (family) failed.push(family);
    else passed.push(`Another family (${actorFamily(actor)}) than every contributor: ${describeContributors(contributors)}`);
  }

  const avoided = input.avoid?.find((a) => names.includes(a.actor.toLowerCase()));
  if (avoided) failed.push(avoided.reason);

  // Under a governed policy the gate counts only an assessor's review. Without
  // one, addReview refuses a review from a harness the project does not make
  // eligible, so the claim's rule applies to reviewers too.
  if (policy.agents) {
    if (hasRole(actor, policy, "assessor")) passed.push("Governed policy: holds the assessor role");
    else failed.push(`${actor} needs an available agent with the assessor role`);
  } else {
    const refusal = eligibility(actor, policy, input.owner ?? DEFAULT_OWNER);
    if (refusal) failed.push(`${refusal}, so the ledger would refuse its review`);
  }

  const status = entry.status;
  if (status?.state === "refused") failed.push(`status refused, reported by ${status.by} at ${status.at}${status.detail ? `: ${status.detail}` : ""}`);
  else passed.push(status ? `Status ${status.state}, reported by ${status.by} at ${status.at}` : "Status not checked yet");

  const { allowPaid, spend } = input;
  if (!paidPerToken(entry)) passed.push(`No per-token cost (${entry.provider})`);
  else if (!allowPaid) failed.push(`paid per token (${entry.provider}); ${input.part ? "the plan was not approved with allowPaid" : "paid models are not allowed for this review"}`);
  else if (spend && spend.used >= spend.cap) failed.push(`paid per token (${entry.provider}); spend ${spend.used} has reached the cap ${spend.cap}`);
  else passed.push(`Paid per token (${entry.provider}), allowed by allowPaid; ${spend ? `spend ${spend.used} of cap ${spend.cap}` : "no spend cap"}`);

  // A review is counted as work of the part's kind, since the reviewer reads
  // the same change; a review outside a plan has no kind, so a tool reserved
  // for named kinds of work is kept for them.
  const availability = lookup(input.availability, actor) ?? lookup(input.availability, entry.harness);
  if (!availability) passed.push("Availability not set; treated as available");
  else if (availability.value.state === "paused") failed.push(`paused (availability of ${availability.key})`);
  else if (availability.value.state === "reserved") {
    const kinds = availability.value.for;
    const held = `reserved for ${kinds.length ? kinds.join(", ") : "nothing"} (availability of ${availability.key}); ${input.part ? `this part is ${input.part.taskKind} work` : "a review outside a plan is of no named kind"}`;
    if (input.part && kinds.includes(input.part.taskKind)) passed.push(held[0].toUpperCase() + held.slice(1));
    else failed.push(held);
  } else passed.push(`Available (availability of ${availability.key})`);

  // The reviewer of a size M part reads the same scope as its builder.
  if (input.part?.size === "M") {
    const window = contextWindow(entry, input.profiles ?? MODEL_PROFILES);
    if (window !== null && window < SIZE_M_CONTEXT) failed.push(`context window ${window} tokens; a size M part needs ${SIZE_M_CONTEXT} or an unknown window`);
    else passed.push(window === null ? "Context window unknown; size M allowed" : `Context window ${window} tokens, enough for size M`);
  }
  return { failed, passed };
}

function eligibility(actor: string, policy: ProjectPolicy, owner: string): string | null {
  try {
    assertEligible(actor, policy, owner);
    return null;
  } catch (err) {
    const rule = parseRuleError(err);
    if (!rule) throw err;
    return rule.detail;
  }
}

// An actor's entry wins over its harness's, whatever the case of the key; of
// two keys that differ only in case, the later one counts, as in routing.
function lookup(map: PickInput["availability"], name: string): { key: string; value: Availability } | undefined {
  let found: { key: string; value: Availability } | undefined;
  for (const [key, value] of Object.entries(map ?? {})) if (key.toLowerCase() === name.toLowerCase()) found = { key, value };
  return found;
}

function contextWindow(entry: ModelEntry, profiles: readonly ModelProfile[]): number | null {
  const names = [entry.id, ...entry.aliases].map((name) => name.toLowerCase());
  return profiles.find((profile) => names.includes(profile.id.toLowerCase()))?.contextWindow ?? null;
}
