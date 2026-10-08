// Routing a plan's parts: which model builds each part, which two stand in
// if it fails, and which model of another family reviews it. Atelier
// computes this from the pool, the registry's evidence, the ledger's track
// record and the offers live runners made; the planner may only prefer.
// Every choice carries its reasons, because the owner reads "why this
// model?" on the task page, and a part no model can take is returned
// unrouted with the reason.
//
// Models the ranking cannot tell apart (the same score and tie-breaker, so
// only the model id orders them) share the plan: each part goes to the tied
// model with the fewest parts of the plan so far, then the fewest in its
// family, so one model is never the whole plan when others are as good.
// Reviewers spread the same way. A better score still wins outright.
//
// Reviewers are ordered first by their precision on blocking findings
// (src/models/precision.ts) when the caller gives it, and only among those
// that already qualify: another family than the builder, offered, available
// and allowed. A reviewer with too few judged findings orders as neutral, so
// precision moves only a reviewer whose findings the owner has judged often
// enough; between equal precision terms the rank and the spread decide.
//
// The offers live runners made bind the routing twice over. A model no live
// runner offers cannot build or review at all, because no runner could
// claim its dispatch (offeredActors in src/dispatch/rules.ts, t246); a
// reviewer is besides routed only to a model a live runner offers for the
// review job (offering in src/dispatch/rules.ts), because the queue offers
// a review to such a runner alone; a model only a build runner offers would
// sit unclaimed however long the review waited (the t210 case, 2026-10-07).
// When no runner is live the pool stands and the choice says so with a
// warning.

import type { LedgerEvent } from "../ledger.ts";
import { liveOffers, offering, offeredActors, type Dispatch, type Offering, type SeenOffer } from "../dispatch/rules.ts";
import { familyOf, type ModelEntry, type PoolFamily } from "../models/pool.ts";
import { buildRecord, type ActorRecord, type ModelRecord } from "../models/record.ts";
import { MODEL_PROFILES, type Family, type Harness, type ModelProfile, type TaskKind } from "../models/registry.ts";
import { outcomesOf, reliabilityLine, tiebreak, type Reliability } from "../models/reliability.ts";
import { byPrecision, precisionLine, precisionOf, precisionTerm, type PrecisionRecord } from "../models/precision.ts";
import { route, tied, type Candidate, type Tiebreak } from "../models/routing.ts";
import { measureText, stalledText, type SpeedRecord } from "../models/speed.ts";
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
  reliability?: Reliability;              // each model's record across every project; orders equal scores only
  precision?: PrecisionRecord | null;     // reviewers' precision on blocking findings; orders qualifying reviewers only
  // Each model's speed over its window (src/models/speed.ts), when the plan
  // asks to prefer faster models. Off when absent. It orders only models
  // the score and the reliability tie-breaker cannot tell apart (pacesFor).
  speed?: SpeedRecord;
  // The offers the runners made as the index recorded them, raw with when
  // each asked, or null when the caller read none. A model no live runner
  // offers cannot build or review, because no runner could claim its
  // dispatch; a model some runner offers says which. When the caller read
  // no offers nothing is known to be offered, so routing restricts nothing
  // and falls back to the whole pool, and a project run entirely by hand
  // still routes; when the offers were read but every ask has gone stale,
  // routing falls back the same way rather than strand the plan on models
  // nothing live could claim, and the reviewer's reasons carry the warning.
  // The reviewer's own question is per job, not per model (offering in
  // src/dispatch/rules.ts): whether a runner runs the review job a review
  // dispatch names is judged there, not here.
  offers?: readonly SeenOffer[] | null;
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
  // Set when the plan tick replaced the reviewer routed at approval: who was
  // routed and why that reviewer could no longer review the part.
  reviewerChange?: { from: string | null; reason: string; at: string };
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
// Each entry's reliability across every project, under the actor route()
// looks up: its model by modelKey, with an alias the registry reads as
// another model summed in. It breaks ties and never changes a score, so the
// project's own track record and the evidence still decide.
function tiebreaksFor(pool: readonly ModelEntry[], reliability: Reliability): Map<string, Tiebreak> {
  const out = new Map<string, Tiebreak>();
  for (const entry of pool) {
    const records = [...new Set([entry.id, ...entry.aliases].map((id) => modelKey(`${entry.harness}/${id}`)))].flatMap((k) => reliability.get(k) ?? []);
    const o = records.map(outcomesOf).reduce((a, b) => ({ good: a.good + b.good, bad: a.bad + b.bad }), { good: 0, bad: 0 });
    const value = tiebreak(o);
    const said = records.length ? records.map((r) => `${r.model}, ${reliabilityLine(r)}`).join(" ") : "none recorded.";
    out.set(actorOf(entry), { value, reason: `Reliability across projects: ${said} Outcomes in its favour ${o.good}, against ${o.bad}; tie-breaker ${value.toFixed(2)}, which orders only equal scores.` });
  }
  return out;
}

// Speed as a routing term, deliberately weak: a model's median, for builds
// (claim to submission) or reviews (claim to verdict), is put in a bucket a
// factor of two wide (log2 of the seconds, rounded) and compared by bucket,
// so close medians count as the same pace and noise in a few runs does not
// reorder models. It is compared only between candidates
// tied on score and reliability, after both, so it never outweighs the
// evidence, the project's record or a model's reliability: two models equally
// good at the work go to the faster, and within one bucket the plan still
// spreads its parts. A model without a median (fewer than the minimum
// samples in the window) sorts after those with one among the tied, since
// nothing says it is fast. Its reason states the medians, n and window.
interface Pace { build: number; review: number; reason: string }
const UNKNOWN_PACE = Number.POSITIVE_INFINITY;
const bucket = (median: number | null) => (median === null ? UNKNOWN_PACE : Math.round(Math.log2(Math.max(median, 1))));

function pacesFor(pool: readonly ModelEntry[], speed: SpeedRecord): Map<string, Pace> {
  const out = new Map<string, Pace>();
  const byModel = new Map(speed.models.map((m) => [m.model, m]));
  const window = `the last ${speed.days} days (${speed.since.slice(0, 10)} to ${speed.until.slice(0, 10)})`;
  for (const entry of pool) {
    const m = [entry.id, ...entry.aliases].map((id) => byModel.get(modelKey(`${entry.harness}/${id}`))).find(Boolean);
    const said = m ? `builds ${measureText(m.build)}, ${stalledText(m.build)}; reviews ${measureText(m.review)}, ${stalledText(m.review)}` : "no runs recorded";
    out.set(actorOf(entry), {
      build: bucket(m?.build.median ?? null), review: bucket(m?.review.median ?? null),
      reason: `Speed over ${window}: ${said}; orders only models tied on score and reliability, the faster first.`,
    });
  }
  return out;
}

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
  tiebreaks: Map<string, Tiebreak>;
  paces: Map<string, Pace> | null;         // null unless the input asks for speed
  availability: Map<string, { key: string; value: Availability }>;
  offered: Map<string, string[]> | null;   // actors live runners offer, whatever job; null when the offers were not read or none is live, and routing restricts nothing
  governed: boolean;
  reviewOffered: Offering | null;          // what the live runners offer for the review job; null when none were read or no runner is live
  offersRead: boolean;                     // whether the caller read runner offers at all
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
  reviewOffer: string | null;   // the runners offering it for the review job, when offers were read and a runner is live
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

  // A model no live runner offers cannot take the part: its dispatch would
  // wait in the queue for a runner that never asks for it. The actor is the
  // name the dispatch would name, so an alias a runner offers does not reach
  // the pool's id — the claim would be refused anyway. The map is read for
  // whether it was computed at all, never for whether it is truthy: one that
  // is empty says live runners offer nothing claimable, and every model
  // fails; null says the offers were not read or no runner is live, and
  // nothing is restricted.
  if (ctx.offered !== null) {
    const runners = ctx.offered.get(actor.toLowerCase());
    if (runners) passed.push(`Offered by ${runners.join(", ")}`);
    else both.push(`no live runner offers ${actor}, so no runner could claim its dispatch`);
  }

  const window = candidate.profile.contextWindow;
  if (part.size === "M") {
    if (window !== null && window < SIZE_M_CONTEXT) both.push(`context window ${window} tokens; a size M part needs ${SIZE_M_CONTEXT} or an unknown window`);
    else passed.push(window === null ? "Context window unknown; size M allowed" : `Context window ${window} tokens, enough for size M`);
  }

  const refusal = claimRefusal(actor, ctx.input.policy);
  const build = refusal ? [...both, refusal] : [...both];
  const review = ctx.governed && !hasRole(actor, ctx.input.policy, "assessor") ? [...both, `${actor} needs an available agent with the assessor role`] : [...both];
  // The offer the review job asks of a runner: a review is claimed only by
  // a runner that offers the job and can claim as the model, so a reviewer
  // no live runner so offers would wait forever, whatever runner names the
  // model for other work (the t210 case, 2026-10-07). The rule binds only
  // where offers were read and a runner is live; otherwise the pool stands
  // and the reviewer's reasons say so in routePart. A model no live runner
  // offers at all is already excluded above, by the claim's own rule; what
  // this adds is the model a runner does offer, for other work, naming
  // what that runner lacks for the review job.
  let reviewOffer: string | null = null;
  if (ctx.reviewOffered) {
    const runners = ctx.reviewOffered.actors.get(actor.toLowerCase());
    if (runners) reviewOffer = `Offered for the review job by ${[...new Set(runners)].join(", ")}`;
    else if (ctx.offered?.has(actor.toLowerCase()))
      review.push(`no live runner offers ${actor} for the review job: ${ctx.reviewOffered.instead.join("; ")}`);
  }
  // The family as the gate reads it, by modelKey, so a profile suffix never
  // makes a reviewer look like another family than the builder.
  return { actor, family: familyOf(modelKey(actor)), candidate, passed, build, review, reviewOffer };
}

function choice(verdict: Verdict, lead: string[], role: string, ctx: Context): Choice {
  const reasons = [...lead];
  if (ctx.governed) reasons.push(`Governed policy: holds the ${role} role`);
  const pace = ctx.paces?.get(verdict.actor);
  return { actor: verdict.actor, reasons: [...reasons, ...verdict.passed, ...verdict.candidate.reasons, ...(pace ? [pace.reason] : [])] };
}

// The verdicts in rank order with speed applied when the input asks for it:
// among candidates tied on score and reliability the faster pace for the
// role comes first; the sort is stable, so the rest keep route()'s order.
function byPace(ranked: Verdict[], ctx: Context, key: "build" | "review"): Verdict[] {
  const paces = ctx.paces;
  if (!paces) return ranked;
  const pace = (v: Verdict) => paces.get(v.actor)?.[key] ?? UNKNOWN_PACE;
  const order = (a: Verdict, b: Verdict) => b.candidate.score - a.candidate.score || b.candidate.tiebreak - a.candidate.tiebreak
    || (pace(a) === pace(b) ? 0 : pace(a) < pace(b) ? -1 : 1);
  return [...ranked].sort(order);
}

// How many parts of the plan each actor, and each family, has been given in
// one role so far, as the parts are routed in plan order.
class Load {
  private readonly actors = new Map<string, number>();
  private readonly families = new Map<PoolFamily, number>();
  of(v: Verdict): { actor: number; family: number } {
    return { actor: this.actors.get(v.actor) ?? 0, family: this.families.get(v.family) ?? 0 };
  }
  add(v: Verdict): void {
    this.actors.set(v.actor, this.of(v).actor + 1);
    this.families.set(v.family, this.of(v).family + 1);
  }
}

// The pick from a list in rank order: the first, unless others are tied with
// it, when the tied model with the fewest parts of the plan in this role so
// far builds or reviews, then the fewest in its family, then the first in rank
// order. The lead reason says what the tie was and why this model took it.
// Models tie only at an equal pace for the role when the input asks for
// speed, and `same` narrows the tie further: reviewers tie only at an equal
// precision term.
function spread(ranked: readonly Verdict[], load: Load, role: "builds" | "reviews", ctx: Context, same: (a: Verdict, b: Verdict) => boolean = () => true): { pick: Verdict; lead: string | null } {
  const first = ranked[0];
  const key = role === "builds" ? "build" : "review";
  const pace = (v: Verdict) => ctx.paces?.get(v.actor)?.[key] ?? UNKNOWN_PACE;
  const group = ranked.filter((v) => tied(v.candidate, first.candidate) && pace(v) === pace(first) && same(v, first));
  if (group.length < 2) return { pick: first, lead: null };
  const pick = group.reduce((best, v) => {
    const a = load.of(best), b = load.of(v);
    return b.actor < a.actor || (b.actor === a.actor && b.family < a.family) ? v : best;
  });
  const others = group.filter((v) => v !== pick).map((v) => `${v.actor} ${load.of(v).actor}`).join(", ");
  const own = load.of(pick);
  const lead = `Spread across the ${group.length} models tied at score ${first.candidate.score}: ${role} ${own.actor} ${own.actor === 1 ? "part" : "parts"} of this plan so far and its family ${pick.family} ${own.family} (${others})`;
  return { pick, lead };
}

function routePart(part: PlanPart, ctx: Context, builds: Load, reviews: Load): PartRoute {
  const none = (unrouted: string, excluded: Choice[] = []): PartRoute => ({ key: part.key, builder: null, alternates: [], reviewer: null, excluded, unrouted });
  if (!ctx.profiles.length) return none("no models in the pool");
  // route() ranks by score, then the reliability tie-breaker, then model id,
  // then actor name, so the order is the same whatever order the pool is given in.
  const ranked = route({ kind: part.taskKind }, ctx.profiles, ctx.record, { localOnly: false, allowedWhere: "any" }, ctx.tiebreaks);
  // Every synthesized profile names one harness, so each candidate has an actor.
  const verdicts = ranked.map((candidate) => judge(candidate, ctx.entries.get(candidate.actor!)!, part, ctx));
  const excluded = verdicts.filter((v) => v.build.length).map((v) => ({ actor: v.actor, reasons: v.build }));
  const able = byPace(verdicts.filter((v) => !v.build.length), ctx, "build");
  const order = [ctx.input.reliability ? "reliability across projects" : "", ctx.paces ? "speed" : "", "model id, then actor name"].filter(Boolean).join(", then ");
  const rank = (v: Verdict) => `Rank ${able.indexOf(v) + 1} of ${able.length} eligible for ${part.taskKind} work, score ${v.candidate.score}; equal scores spread across the plan's parts, then go by ${order}`;

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
  if (!builder && able.length) {
    const picked = spread(able, builds, "builds", ctx);
    builder = picked.pick;
    if (picked.lead) lead.push(picked.lead);
  }
  if (!builder) return none(`no eligible builder: ${excluded.map((e) => `${e.actor} (${e.reasons.join("; ")})`).join(", ")}`, excluded);
  builds.add(builder);
  const alternates = able.filter((v) => v !== builder).slice(0, 2).map((v) => choice(v, [rank(v)], "executor", ctx));
  const chosen = choice(builder, [...lead, rank(builder)], "executor", ctx);

  const others = verdicts.filter((v) => v !== builder);
  // Precision and speed order only the reviewers that pass every rule; the
  // filter comes first, so a same-family or unavailable model is never a
  // reviewer however precise or fast. Speed orders within ties of score and
  // reliability (byPace), then precision orders the qualifying reviewers,
  // keeping that order among equal precision terms (byPrecision is stable).
  const precision = ctx.input.precision ?? null;
  const namesOfVerdict = (v: Verdict) => { const entry = ctx.entries.get(v.actor)!; return [entry.id, ...entry.aliases].map((id) => `${entry.harness}/${id}`); };
  const termOf = (v: Verdict) => precisionTerm(precisionOf(precision, namesOfVerdict(v)));
  const reviewers = byPrecision(byPace(others.filter((v) => !v.review.length && crossFamily(v.family, builder.family)), ctx, "review"), namesOfVerdict, precision);
  const reviewer = reviewers.length ? spread(reviewers, reviews, "reviews", ctx, (a, b) => !precision || termOf(a) === termOf(b)) : null;
  if (!reviewer) {
    const why = builder.family === "other"
      ? `no reviewer can be of another family than ${builder.actor}, whose family is not recognised from its name`
      : `no reviewer of another family than ${builder.family} (${builder.actor}): ${others.length ? others.map((v) => `${v.actor} (${v.review.length ? v.review.join("; ") : v.family === "other" ? "family not recognised from its name" : `same family, ${v.family}`})`).join(", ") : "no other model in the pool"}`;
    return { key: part.key, builder: chosen, alternates, reviewer: null, excluded, unrouted: why };
  }
  reviews.add(reviewer.pick);
  const family = `Another family (${reviewer.pick.family}) than the builder's (${builder.family})`;
  const first = precision ? "the first such model by review precision, then rank order" : "the first such model in rank order";
  const said = [reviewer.lead ? `${family}; ${reviewer.lead[0].toLowerCase()}${reviewer.lead.slice(1)}` : `${family}; ${first}`];
  if (precision) said.push(precisionLine(precisionOf(precision, namesOfVerdict(reviewer.pick)), precision.window));
  // What the runner offers said of the reviewer: the runners that offer it
  // for the review job, or, offers read but no runner live, the warning
  // that the pool stood in for them, since the review cannot be claimed
  // until such a runner asks for work.
  if (reviewer.pick.reviewOffer) said.push(reviewer.pick.reviewOffer);
  else if (ctx.offersRead) said.push(`No runner is live; routed from the pool, and the review waits until a runner that offers ${reviewer.pick.actor} for the review job asks for work`);
  const reviewing = choice(reviewer.pick, said, "assessor", ctx);
  return { key: part.key, builder: chosen, alternates, reviewer: reviewing, excluded, unrouted: null };
}

// The dispatch a review request carries (reviewTick in src/ledger.ts): a
// home runner that offers the review job. Routing asks the offers what
// such a runner would take, so a reviewer is routed only to a model one
// lists, which is the claim's own rule applied ahead of the claim.
const REVIEW_JOB: Pick<Dispatch, "to" | "job"> = { to: "home", job: "review" };

export function routeParts(plan: Plan, input: RouteInput): PartRoute[] {
  const pool = [...input.pool];
  // The live half of the recorded offers, read once for both questions: an
  // empty one, whether from offers never made or every ask gone stale, is
  // no runner being live, and routing then restricts nothing and falls back
  // to the whole pool (routable in src/ledger.ts decides the same for the
  // ledger's own reads).
  const live = input.offers != null ? liveOffers(input.offers) : [];
  const ctx: Context = {
    input,
    entries: new Map(pool.map((entry) => [actorOf(entry), entry])),
    profiles: pool.map((entry) => profileFor(entry, input.profiles ?? MODEL_PROFILES)),
    record: recordFor(pool, input.events),
    tiebreaks: input.reliability ? tiebreaksFor(pool, input.reliability) : new Map(),
    paces: input.speed ? pacesFor(pool, input.speed) : null,
    availability: new Map(Object.entries(input.availability ?? {}).map(([key, value]) => [key.toLowerCase(), { key, value }])),
    offered: live.length ? offeredActors(live) : null,
    governed: input.policy.agents !== undefined,
    reviewOffered: input.offers != null ? offering(REVIEW_JOB, input.offers) : null,
    offersRead: input.offers != null,
  };
  // Parts route in plan order; each sees how many parts the earlier ones gave each model.
  const builds = new Load(), reviews = new Load();
  return plan.parts.map((part) => routePart(part, ctx, builds, reviews));
}
