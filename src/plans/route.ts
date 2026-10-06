// Routing a plan's parts: which model builds each part, which two stand in
// if it fails, and which model of another family reviews it. Atelier
// computes this from the pool, the registry's evidence and the ledger's
// track record; the planner may only prefer. Every choice carries its
// reasons, because the owner reads "why this model?" on the task page, and
// a part no model can take is returned unrouted with the reason.

import type { LedgerEvent } from "../ledger.ts";
import { familyOf, type ModelEntry, type PoolFamily } from "../models/pool.ts";
import { buildRecord, type ActorRecord, type ModelRecord } from "../models/record.ts";
import { MODEL_PROFILES, type Family, type Harness, type ModelProfile, type TaskKind } from "../models/registry.ts";
import { route, type Candidate } from "../models/routing.ts";
import { assertEligible, hasRole, modelKey, parseRuleError, type ProjectPolicy } from "../rules.ts";
import type { Plan, PlanPart } from "./schema.ts";

// What the owner knows about a tool's usage limits, keyed by actor
// (harness/model) or by harness; an actor's entry wins over its harness's.
// A reserved tool is near its limit and kept for the named kinds of work.
// A paused one gets nothing.
export type Availability =
  | { state: "available" }
  | { state: "reserved"; for: readonly TaskKind[] }
  | { state: "paused" };

export interface RouteInput {
  pool: readonly ModelEntry[];
  events: readonly LedgerEvent[];         // the project's ledger; buildRecord() makes the track record
  policy: ProjectPolicy;                  // governed when it names agents
  allowPaid: boolean;                     // the owner's approval of paid-per-token models
  spend?: { cap: number; used: number };  // for paid models, in the owner's unit; paid models are excluded once used reaches cap
  availability?: Readonly<Record<string, Availability>>;
  profiles?: readonly ModelProfile[];     // the registry's evidence and context windows; MODEL_PROFILES by default
}

export interface Choice { actor: string; reasons: string[] }

// The invariant: unrouted is null exactly when builder and reviewer are
// both set. A part with a builder but no reviewer keeps the builder, so the
// owner can see who would have built it, and says why it is unrouted.
export interface PartRoute {
  key: string;
  builder: Choice | null;
  alternates: Choice[];      // the next two eligible builders, in rank order
  reviewer: Choice | null;
  excluded: Choice[];        // pool actors that may not build this part, with the rules they failed
  unrouted: string | null;   // why the part has no builder or no reviewer; null when routed
}

// A size M part needs this much context, or a window the registry does not know.
export const SIZE_M_CONTEXT = 64 * 1024;

// Billed per token: an API reached with a key. The Studio and a harness
// sign-in (a subscription) cost nothing per call. An OpenAI-compatible
// server is paid in the cloud; at home it is the owner's own server.
export function paidPerToken(entry: Pick<ModelEntry, "provider" | "where">): boolean {
  if (entry.provider === "ai-studio" || entry.provider === "subscription") return false;
  return entry.provider !== "openai-compatible" || entry.where === "cloud";
}

const actorOf = (entry: ModelEntry) => `${entry.harness}/${entry.id}`;

// One registry-shaped profile per pool entry, so route() scores the pool.
// The registry supplies evidence and the context window when it knows the
// model, by id or alias; otherwise the model has no evidence and an unknown
// window. The registry's Harness and Family types predate the pool, and
// route() reads only ids, harness names and evidence, so the pool's wider
// names pass through.
export function profileFor(entry: ModelEntry, profiles: readonly ModelProfile[]): ModelProfile {
  const names = [entry.id, ...entry.aliases].map((name) => name.toLowerCase());
  const known = profiles.find((profile) => names.includes(profile.id.toLowerCase()));
  return {
    id: entry.id, displayName: entry.id, family: entry.family as Family, harnesses: [entry.harness as Harness],
    where: entry.where, dataStaysLocal: entry.where === "home",
    contextWindow: known?.contextWindow ?? null, costClass: known?.costClass ?? "unknown",
    evidence: known?.evidence ?? [], notes: known?.notes ?? [],
  };
}

// The track record of an entry counts its aliases, as the Models page does,
// under the actor route() looks up: harness/id.
const add = (a: ActorRecord, b: ActorRecord): ActorRecord => ({
  itemsClaimed: a.itemsClaimed + b.itemsClaimed, checkPasses: a.checkPasses + b.checkPasses, checkFailures: a.checkFailures + b.checkFailures,
  reviewsApproved: a.reviewsApproved + b.reviewsApproved, reviewsRejected: a.reviewsRejected + b.reviewsRejected,
  handoffsAway: a.handoffsAway + b.handoffsAway, merges: a.merges + b.merges,
});
export function recordFor(pool: readonly ModelEntry[], events: readonly LedgerEvent[]): ModelRecord {
  const record = buildRecord(events);
  const merged = new Map<string, ActorRecord>();
  for (const entry of pool) {
    const records = [entry.id, ...entry.aliases].flatMap((id) => record.get(`${entry.harness}/${id}`) ?? []);
    if (records.length) merged.set(actorOf(entry), records.reduce(add));
  }
  return merged;
}

// The rule a claim applies, so routing never names a builder the claim
// would refuse: under a governed policy the executor role, otherwise the
// project's eligible harnesses.
function claimRefusal(actor: string, policy: ProjectPolicy): string | null {
  try {
    assertEligible(actor, policy);
    return null;
  } catch (err) {
    const rule = parseRuleError(err);
    if (!rule) throw err;
    return rule.detail;
  }
}

// The gate counts a review as cross-family only when both families are
// recognised and differ (gate() in src/rules.ts); routing picks by the same rule.
const crossFamily = (a: PoolFamily, b: PoolFamily) => a !== "other" && b !== "other" && a !== b;

interface Context {
  input: RouteInput;
  entries: Map<string, ModelEntry>;
  profiles: ModelProfile[];
  record: ModelRecord;
  availability: Map<string, { key: string; value: Availability }>;
  governed: boolean;
}

// One pool actor judged for one part: the rules it passed, for the reasons
// of a choice, and the rules that keep it from building or from reviewing.
// The family rule for reviewers waits until the builder is known.
interface Verdict {
  actor: string;
  family: PoolFamily;
  candidate: Candidate;
  passed: string[];
  build: string[];
  review: string[];
}

function judge(candidate: Candidate, entry: ModelEntry, part: PlanPart, ctx: Context): Verdict {
  const actor = actorOf(entry);
  const passed: string[] = [];
  const both: string[] = [];
  const status = entry.status;
  if (status?.state === "refused") both.push(`status refused, reported by ${status.by} at ${status.at}${status.detail ? `: ${status.detail}` : ""}`);
  else passed.push(status ? `Status ${status.state}, reported by ${status.by} at ${status.at}` : "Status not checked yet");

  const { allowPaid, spend } = ctx.input;
  if (!paidPerToken(entry)) passed.push(`No per-token cost (${entry.provider})`);
  else if (!allowPaid) both.push(`paid per token (${entry.provider}); the plan was not approved with allowPaid`);
  else if (spend && spend.used >= spend.cap) both.push(`paid per token (${entry.provider}); spend ${spend.used} has reached the cap ${spend.cap}`);
  else passed.push(`Paid per token (${entry.provider}), allowed by allowPaid; ${spend ? `spend ${spend.used} of cap ${spend.cap}` : "no spend cap"}`);

  const availability = ctx.availability.get(actor.toLowerCase()) ?? ctx.availability.get(entry.harness.toLowerCase());
  if (!availability) passed.push("Availability not set; treated as available");
  else if (availability.value.state === "paused") both.push(`paused (availability of ${availability.key})`);
  else if (availability.value.state === "reserved") {
    const kinds = availability.value.for;
    const held = `reserved for ${kinds.length ? kinds.join(", ") : "nothing"} (availability of ${availability.key}); this part is ${part.taskKind} work`;
    if (kinds.includes(part.taskKind)) passed.push(held[0].toUpperCase() + held.slice(1));
    else both.push(held);
  } else passed.push(`Available (availability of ${availability.key})`);

  const window = candidate.profile.contextWindow;
  if (part.size === "M") {
    if (window !== null && window < SIZE_M_CONTEXT) both.push(`context window ${window} tokens; a size M part needs ${SIZE_M_CONTEXT} or an unknown window`);
    else passed.push(window === null ? "Context window unknown; size M allowed" : `Context window ${window} tokens, enough for size M`);
  }

  const refusal = claimRefusal(actor, ctx.input.policy);
  const build = refusal ? [...both, refusal] : [...both];
  const review = ctx.governed && !hasRole(actor, ctx.input.policy, "assessor") ? [...both, `${actor} needs an available agent with the assessor role`] : [...both];
  // The family as the gate reads it, by modelKey, so a profile suffix never
  // makes a reviewer look like another family than the builder.
  return { actor, family: familyOf(modelKey(actor)), candidate, passed, build, review };
}

function choice(verdict: Verdict, lead: string[], role: string, ctx: Context): Choice {
  const reasons = [...lead];
  if (ctx.governed) reasons.push(`Governed policy: holds the ${role} role`);
  return { actor: verdict.actor, reasons: [...reasons, ...verdict.passed, ...verdict.candidate.reasons] };
}

function routePart(part: PlanPart, ctx: Context): PartRoute {
  const none = (unrouted: string, excluded: Choice[] = []): PartRoute => ({ key: part.key, builder: null, alternates: [], reviewer: null, excluded, unrouted });
  if (!ctx.profiles.length) return none("no models in the pool");
  // route() ranks by score, then model id, then actor name, so the order is
  // the same whatever order the pool is given in.
  const ranked = route({ kind: part.taskKind }, ctx.profiles, ctx.record, { localOnly: false, allowedWhere: "any" });
  // Every synthesized profile names one harness, so each candidate has an actor.
  const verdicts = ranked.map((candidate) => judge(candidate, ctx.entries.get(candidate.actor!)!, part, ctx));
  const excluded = verdicts.filter((v) => v.build.length).map((v) => ({ actor: v.actor, reasons: v.build }));
  const able = verdicts.filter((v) => !v.build.length);
  const rank = (v: Verdict) => `Rank ${able.indexOf(v) + 1} of ${able.length} eligible for ${part.taskKind} work, score ${v.candidate.score}; equal scores go by model id, then actor name`;

  // The plan's preference wins only when that actor passes every rule; the
  // builder's reasons say what became of it either way.
  const lead: string[] = [];
  let builder: Verdict | undefined;
  if (part.prefer) {
    const { actor, reason } = part.prefer;
    const wanted = verdicts.find((v) => {
      const entry = ctx.entries.get(v.actor)!;
      return [entry.id, ...entry.aliases].some((id) => `${entry.harness}/${id}`.toLowerCase() === actor.toLowerCase());
    });
    if (!wanted) lead.push(`The plan preferred ${actor} (${reason}); it is not in the pool`);
    else if (wanted.build.length) lead.push(`The plan preferred ${wanted.actor} (${reason}); not chosen: ${wanted.build.join("; ")}`);
    else {
      builder = wanted;
      lead.push(`Preferred by the plan (${reason}); passes every rule`);
    }
  }
  builder ??= able[0];
  if (!builder) return none(`no eligible builder: ${excluded.map((e) => `${e.actor} (${e.reasons.join("; ")})`).join(", ")}`, excluded);
  const alternates = able.filter((v) => v !== builder).slice(0, 2).map((v) => choice(v, [rank(v)], "executor", ctx));
  const chosen = choice(builder, [...lead, rank(builder)], "executor", ctx);

  const others = verdicts.filter((v) => v !== builder);
  const reviewer = others.find((v) => !v.review.length && crossFamily(v.family, builder.family));
  if (!reviewer) {
    const why = builder.family === "other"
      ? `no reviewer can be of another family than ${builder.actor}, whose family is not recognised from its name`
      : `no reviewer of another family than ${builder.family} (${builder.actor}): ${others.length ? others.map((v) => `${v.actor} (${v.review.length ? v.review.join("; ") : v.family === "other" ? "family not recognised from its name" : `same family, ${v.family}`})`).join(", ") : "no other model in the pool"}`;
    return { key: part.key, builder: chosen, alternates, reviewer: null, excluded, unrouted: why };
  }
  const reviewing = choice(reviewer, [`Another family (${reviewer.family}) than the builder's (${builder.family}); the first such model in rank order`], "assessor", ctx);
  return { key: part.key, builder: chosen, alternates, reviewer: reviewing, excluded, unrouted: null };
}

export function routeParts(plan: Plan, input: RouteInput): PartRoute[] {
  const pool = [...input.pool];
  const ctx: Context = {
    input,
    entries: new Map(pool.map((entry) => [actorOf(entry), entry])),
    profiles: pool.map((entry) => profileFor(entry, input.profiles ?? MODEL_PROFILES)),
    record: recordFor(pool, input.events),
    availability: new Map(Object.entries(input.availability ?? {}).map(([key, value]) => [key.toLowerCase(), { key, value }])),
    governed: input.policy.agents !== undefined,
  };
  return plan.parts.map((part) => routePart(part, ctx));
}
