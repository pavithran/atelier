// Dispatch: the project owner (and, later, an orchestrator holding an approved
// plan) puts an open task in a queue for a kind of runner. Runners do not get
// work pushed to them; they ask for it, describing what they can run, and then
// claim it through the ordinary atomic claim. A runner at home therefore only
// ever makes outgoing requests, and every runner's work is judged the same way.

import { DEFAULT_OWNER, harnessRefusal, overlappingLive, overlappingRefusal, roleRefusal, RuleError, samePlan, scopesOverlapWithin, validActor, type Item, type ItemState, type ProjectPolicy } from "../rules.ts";
import { assertLength, OWNER_TEXT_MAX } from "../text.ts";

export type RunnerKind = "cloud" | "home";
export const RUNNER_KINDS: RunnerKind[] = ["cloud", "home"];

export interface Dispatch {
  to: RunnerKind | "any";
  agent: string | null;   // an agent harness family, e.g. "claude-code", "codex", "opencode"; null for any
  model: string | null;   // a model id as the runner names it; null for the runner's choice
  by: string;
  at: string;
  note: string;
  // A job other than building the item: "plan" asks the runner to write the
  // plan item's plan document (docs/orchestrator.md, section 2), "integrate"
  // and "refresh" ask atelier/integrator to merge a part onto the plan's
  // branch or main into it (section 5), and "merge-main" asks the builder of
  // a part or a task to merge main into its workspace and resolve what
  // conflicts. "review" is the review dispatch a review request carries
  // (section 4): it is stored with the request, not on the item, and offered
  // to a runner whose offer lists the job. Absent for ordinary work. The
  // owner writes none of these by hand but merge-main (t243): the plan's own
  // jobs are the plan's.
  job?: "plan" | "review" | "integrate" | "refresh" | "merge-main";
  // For an integrate job: the part key to merge, its verified head, and the
  // part's item id, so the integrator can fetch the head to merge. For a
  // refresh job, `head` is the main head to merge. For merge-main it is
  // the dispatch-time head; the runner resolves the baseline branch after
  // claiming and records the actual target in its submission summary.
  part?: string;
  head?: string;
  partId?: string;
  // For a part sent back because its integration conflicted with the plan's
  // branch: the plan branch's head, which the runner merges into the part's
  // workspace before the builder starts. Only a runner that offers the
  // "merge-plan" job takes such a dispatch.
  planHead?: string;
  // Set on a merge-main job the owner dispatched for a task outside a plan
  // (t243), whose runner reads main through the task's own base token rather
  // than a plan's. A runner from before t243 offers merge-main but refuses
  // such an assignment, so only a runner that offers the "merge-main-task"
  // job takes it.
  task?: true;
  // The owner's override of the core-file hold (coreHold): the queue offers
  // the dispatch although its scope overlaps a live item's within a core
  // file. Set only by the owner's own dispatch (atelier dispatch ID
  // --overlap-ok); a plan's dispatches never carry it.
  overlapOk?: true;
}

// What a runner says it can run when it asks for work. `jobs` names every
// job it takes, build among them; a dispatch for a job the list lacks is
// never offered to it, a plain build included (t252). An offer that names no
// job at all is an older runner's, which took builds before jobs were named,
// so build needs no naming there (missingJob below).
export interface RunnerOffer {
  runner: string;          // "home:studio", "cloud:atelier"
  kind: RunnerKind;
  agents: { agent: string; models: string[] }[];
  jobs?: string[];
  // When the runner's process started, as it says: what it passes by after
  // failures or a refused claim it forgets on a restart, so the reasons
  // that name it count only from then (skippedBy, refusedBy).
  started?: string;
}

export interface Assignment {
  agent: string;
  model: string;
  actor: string;           // the name the runner claims under: agent/model
}

const NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const AGENT = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// Every name a runner could be told to claim under must be one a claim accepts.
function claimable(agent: string, model: string): boolean {
  return AGENT.test(agent) && NAME.test(model) && validActor(`${agent}/${model}`);
}

const RUNNER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// A runner is exactly kind:name, with no further colon, and is returned
// normalized, all in lower case, so what is stored is what was matched and
// home:Studio and home:studio are one runner.
export function parseRunner(header: string | null): { runner: string; kind: RunnerKind } | null {
  if (!header) return null;
  const at = header.indexOf(":");
  const kind = header.slice(0, at), name = header.slice(at + 1);
  if (at < 0 || !RUNNER_KINDS.includes(kind.toLowerCase() as RunnerKind) || !RUNNER_NAME.test(name)) {
    throw new RuleError("bad_runner", `"${header}" is not a runner; use cloud:NAME or home:NAME`, 400);
  }
  return { runner: header.toLowerCase(), kind: kind.toLowerCase() as RunnerKind };
}

export function makeDispatch(input: { to?: unknown; agent?: unknown; model?: unknown; note?: unknown; job?: unknown; head?: unknown; overlapOk?: unknown }, by: string, at: string): Dispatch {
  const to = String(input.to ?? "any");
  if (to !== "any" && !RUNNER_KINDS.includes(to as RunnerKind)) {
    throw new RuleError("bad_dispatch", `send to cloud, home or any, not "${to}"`, 400);
  }
  const optional = (v: unknown, what: string) => {
    if (v === undefined || v === null || v === "") return null;
    const s = String(v);
    if (!NAME.test(s)) throw new RuleError("bad_dispatch", `"${s}" is not a valid ${what}`, 400);
    return s;
  };
  const agent = optional(input.agent, "agent");
  const model = optional(input.model, "model");
  if (agent && !AGENT.test(agent)) throw new RuleError("bad_dispatch", `"${agent}" is not a valid agent`, 400);
  if (model && !claimable(agent ?? "agent", model)) throw new RuleError("bad_dispatch", `no runner could claim as "${agent ?? "agent"}/${model}"`, 400);
  // One job the owner may dispatch by hand: merge-main, a task's builder
  // merging main at a named head into its workspace and resolving what
  // conflicts (t243), as a conflicted plan's part does. The plan, integrate
  // and refresh jobs are dispatched by the plan itself, never written here.
  const job = input.job === undefined || input.job === null || input.job === "" ? null : String(input.job);
  if (job !== null && job !== "merge-main") {
    throw new RuleError("bad_dispatch", `"${job}" is not a job a dispatch names; only merge-main is dispatched by hand (atelier dispatch ID --job merge-main), and the plan, integrate and refresh jobs are the plan's own`, 400);
  }
  const head = input.head === undefined || input.head === null || input.head === "" ? null : String(input.head);
  if (job === "merge-main" && !/^[a-f0-9]{40,64}$/.test(head ?? "")) {
    throw new RuleError("bad_head", "a merge-main dispatch names main's head to merge as the full commit hash git rev-parse prints", 400);
  }
  if (job === null && head !== null) {
    throw new RuleError("bad_dispatch", `head names the main head a merge-main job merges; give it with --job merge-main, not alone`, 400);
  }
  // The note is the owner's and is stored with the dispatch for every runner
  // to read, so one over its limit is refused, never cut.
  const note = String(input.note ?? "");
  assertLength(note, OWNER_TEXT_MAX, "the dispatch note");
  if (input.overlapOk !== undefined && input.overlapOk !== null && typeof input.overlapOk !== "boolean") {
    throw new RuleError("bad_dispatch", "overlapOk must be true or false", 400);
  }
  return { to: to as Dispatch["to"], agent, model, by, at, note, ...(job ? { job, head: head!, task: true as const } : {}), ...(input.overlapOk === true ? { overlapOk: true as const } : {}) };
}

// The owner's release of an overlap-held dispatch (atelier dispatch ID
// --overlap-ok on a task already waiting): the dispatch stays as it is, with
// its builder, destination, job, head, note and queue position (`at`), and
// gains only the overlap override. An agent or model given replaces just that
// field; the pair that results is validated as a dispatch's own is, before
// anything is written. Releasing a dispatch already released changes nothing.
export function retainDispatch(item: Item, input: { agent?: unknown; model?: unknown; retainAt?: unknown }, items: readonly Item[], policy: ProjectPolicy, owner = DEFAULT_OWNER): Dispatch {
  if (item.owner || item.state !== "open") {
    throw new RuleError("not_open", `${item.id} is ${item.owner ? `owned by ${item.owner}` : item.state}, so it has no waiting dispatch to release; dispatch it again instead`, 409);
  }
  const d = item.dispatch;
  if (!d) throw new RuleError("not_dispatched", `${item.id} is not queued for a runner, so there is no dispatch to release`, 409);
  if (input.retainAt !== undefined && input.retainAt !== d.at) {
    throw new RuleError("stale_dispatch", `${item.id}'s dispatch has changed; read it again before releasing its hold`, 409);
  }
  const given = (v: unknown, what: string) => {
    if (v === undefined || v === null || v === "") return undefined;
    const s = String(v);
    if (!NAME.test(s)) throw new RuleError("bad_dispatch", `"${s}" is not a valid ${what}`, 400);
    return s;
  };
  const agent = given(input.agent, "agent") ?? d.agent, model = given(input.model, "model") ?? d.model;
  if (agent && !AGENT.test(agent)) throw new RuleError("bad_dispatch", `"${agent}" is not a valid agent`, 400);
  if (model && !claimable(agent ?? "agent", model)) throw new RuleError("bad_dispatch", `no runner could claim as "${agent ?? "agent"}/${model}"`, 400);
  const next: Dispatch = { ...d, agent, model, overlapOk: true };
  if (next.agent !== d.agent || next.model !== d.model) assertDispatchClaimable(item, items, policy, next, owner);
  return next;
}

// The live item a held dispatch waits on: its id, holder, state and title,
// and the core-file glob both scopes reach.
export interface CoreHold {
  id: string;
  owner: string | null;
  state: ItemState;
  title: string;
  core: string;
}

// Why the queue does not offer a dispatch yet, or null when it may. A
// dispatch that builds — a task's or a part's, the merge-main job and a
// part's merge of the plan's branch included — is held while its scope
// overlaps, within one of the project's core files (policy.coreFiles), the
// scope of a live item: one claimed, submitted or accepted, so its changes
// have not reached main. The oldest such item is named. A plan item claimed
// by its planner or the integrator writes the plan or merges a part onto the
// plan's branch, neither of which changes main, so it holds nothing; its
// parts do. Items of one plan never hold each other: a plan's parts whose
// scopes overlap are ordered by their dependencies (src/plans/validate.ts),
// which already serialises them. The plan, integrate, refresh and review
// jobs change no workspace of their own and are never held, and the owner's
// override (overlapOk) lets a dispatch through.
export function coreHold(item: Item, items: readonly Item[], coreFiles: readonly string[] | undefined): CoreHold | null {
  const d = item.dispatch;
  if (!d || d.overlapOk || !coreFiles?.length || item.kind === "plan") return null;
  if (d.job !== undefined && d.job !== "merge-main") return null;
  for (const o of items) {
    if (o.id === item.id || samePlan(item, o)) continue;
    if (o.state !== "claimed" && o.state !== "submitted" && o.state !== "accepted") continue;
    if (o.kind === "plan" && o.state === "claimed") continue;
    const core = scopesOverlapWithin(item.scope, o.scope, [...coreFiles]);
    if (core) return { id: o.id, owner: o.owner, state: o.state, title: o.title, core };
  }
  return null;
}

// What a held dispatch waits on, in words: the item, its holder and state,
// and the core-file glob both scopes reach.
export function holdText(h: CoreHold): string {
  return `waits on ${h.id} (${h.state}${h.owner ? ` by ${h.owner}` : ""}): both scopes reach core file ${h.core}`;
}

// The live item a dispatched task's claim would be refused against, when the
// project refuses overlapping claims (policy.refuseOverlap). It is the
// claim's own test (overlappingLive in src/rules.ts, which assertClaimAllowed
// refuses on): a claimed, submitted or accepted item outside the task's
// plan whose scope overlaps the task's, unless the dispatch's claimant
// (dispatchClaimant) already holds it. So it follows the claim, not
// coreHold: the owner's --overlap-ok lets a dispatch past the core-file
// hold but not past this refusal, and a plan's planner claim is refused like
// a build's. Only atelier/integrator's integrate and refresh jobs, exempt
// from the claim policy, and review requests, which claim nothing, are
// never refused.
export interface OverlapRefusal {
  id: string;
  owner: string | null;
  title: string;
  state: ItemState;
}

// The name a dispatch's claim is judged under ahead of the claim: its
// agent/model when the dispatch names both, so an item that claimant holds
// is not counted against it, as the claim does not count it; otherwise no
// actor's, since the runner that will claim is not yet known, and every
// overlapping live item counts.
export function dispatchClaimant(d: Dispatch): string {
  return d.agent && d.model ? `${d.agent}/${d.model}` : "\u0000dispatch";
}

export function overlapRefusal(item: Item, items: readonly Item[]): OverlapRefusal | null {
  const d = item.dispatch;
  if (!d || d.job === "review" || d.job === "integrate" || d.job === "refresh") return null;
  const o = overlappingLive(item, items, dispatchClaimant(d))[0];
  return o ? { id: o.id, owner: o.owner, title: o.title, state: o.state } : null;
}

// The runners that gave one item up: cli/runner.mjs passes a task by once
// it has failed it SKIP_AFTER times under one dispatch (failureCount, keyed
// by taskKey), until the task is dispatched again or that runner restarts.
// The server sees those failures as the build run reports each runner sends
// (runOutcome), counted per runner, and counts only those since the
// dispatch (`since`, the dispatch's time) and since the runner's process
// started (its offer's `started`), so a failure that runner has forgotten
// never names it. A runner whose offer is no longer live skips nothing, so
// with the offers known only live runners are named.
export const SKIP_AFTER = 2;
const FAILED_OUTCOMES = new Set(["stalled", "timed-out", "refused", "harness_failed"]);

export type RunSeen = { project: string | null; item: string | null; role: string; outcome: string; runner: string; at: string };

export interface SkippedBy {
  runner: string;
  failures: number;
  last: string;      // the newest failure's outcome
}

// When each runner's process started, from the offers that say so.
function startedOf(offers: readonly SeenOffer[] | null | undefined): Map<string, string> {
  return new Map((offers ?? []).flatMap((o) => typeof o.started === "string" ? [[o.runner, o.started] as [string, string]] : []));
}

export function skippedBy(runs: readonly RunSeen[], project: string, item: string, offers?: readonly SeenOffer[] | null, now = new Date(), since?: string): SkippedBy[] {
  const live = offers ? new Set(liveOffers(offers, now).map((o) => o.runner)) : null;
  const started = startedOf(offers);
  const by = new Map<string, { failures: number; last: string; at: string }>();
  for (const r of runs) {
    if (r.project !== project || r.item !== item || r.role !== "build" || !FAILED_OUTCOMES.has(r.outcome)) continue;
    if (since && r.at < since || r.at < (started.get(r.runner) ?? "")) continue;
    const seen = by.get(r.runner) ?? { failures: 0, last: r.outcome, at: r.at };
    // The index lists runs newest first, so a tie keeps the one seen first.
    by.set(r.runner, { failures: seen.failures + 1, ...(r.at > seen.at ?{ last: r.outcome, at: r.at } : { last: seen.last, at: seen.at }) });
  }
  return [...by].filter(([runner, s]) => s.failures >= SKIP_AFTER && (!live || live.has(runner)))
    .map(([runner, s]) => ({ runner, failures: s.failures, last: s.last }))
    .sort((a, b) => a.runner.localeCompare(b.runner));
}

// A claim the server refused a runner for a dispatched task, as the Ledger
// records it when the claim fails (noteClaimRefusal in src/ledger.ts): the
// runner passes the task by until the task changes (refusedKey in
// cli/runner.mjs), so without this record the refusal would be seen only in
// that runner's log. It counts under the dispatch it was refused for, and
// only from a live runner since its process started, as skippedBy counts.
export interface ClaimRefusal {
  runner: string;
  actor: string;
  error: string;        // the refusal's code, e.g. runner_forbidden, overlap_refused
  detail: string;       // why, in words
  dispatchAt: string;   // the dispatch the claim was refused under
  at: string;
}

export function refusedBy(refusals: readonly ClaimRefusal[], item: Item, offers?: readonly SeenOffer[] | null, now = new Date()): ClaimRefusal[] {
  const live = offers ? new Set(liveOffers(offers, now).map((o) => o.runner)) : null;
  const started = startedOf(offers);
  return refusals.filter((r) => r.dispatchAt === item.dispatch?.at && (!live || live.has(r.runner)) && r.at >= (started.get(r.runner) ?? ""))
    .sort((a, b) => a.runner.localeCompare(b.runner));
}

// Why a dispatched task the queue offers is not being taken, each reason in
// words, ready to print. The queue checks them in this order: the core-file
// hold, the overlap the project's policy refuses, a claim a runner was
// refused, the failures a runner gave up at, and no live runner offering the
// model or job. Asked for one runner (`offer`, a runner's own poll with
// `why`), a dispatch no other reason holds that this runner is not offered
// says so: it is for another runner. A task may carry several; `atelier
// status`, `atelier show` and an idle runner print one line each.
export type UnclaimedKind = "held" | "overlap" | "refused" | "skipped" | "unoffered" | "elsewhere";

export interface UnclaimedReason {
  kind: UnclaimedKind;
  line: string;
}

export function unclaimed(
  item: Item,
  input: {
    held?: CoreHold | null;
    overlap?: OverlapRefusal | null;
    refusals?: readonly ClaimRefusal[] | null;
    offers?: readonly SeenOffer[] | null;
    runs?: readonly RunSeen[] | null;
    project?: string;
    offer?: RunnerOffer | null;
    now?: Date;
  },
): UnclaimedReason[] {
  const out: UnclaimedReason[] = [];
  if (input.held) out.push({ kind: "held", line: heldReasonLine(item, input.held) });
  if (input.overlap) out.push({ kind: "overlap", line: overlapReasonLine(input.overlap, item) });
  for (const r of refusedBy(input.refusals ?? [], item, input.offers, input.now)) out.push({ kind: "refused", line: refusedReasonLine(r, item) });
  if (input.runs && input.project) {
    for (const s of skippedBy(input.runs, input.project, item.id, input.offers, input.now, item.dispatch?.at)) out.push({ kind: "skipped", line: skippedReasonLine(s, item) });
  }
  if (item.dispatch && input.offers) {
    const dead = unoffered(item.dispatch, input.offers, input.now);
    if (dead) out.push({ kind: "unoffered", line: unofferedReasonLine(dead, item) });
  }
  if (item.dispatch && input.offer && !out.length && !assign(item.dispatch, input.offer)) {
    out.push({ kind: "elsewhere", line: `Not for ${input.offer.runner}: it is dispatched to ${describe(item.dispatch)}${item.dispatch.job ? ` (a ${item.dispatch.job} job)` : ""}, which this runner does not offer, and a live runner that does will take it.` });
  }
  return out;
}

// The owner's command that dispatches a task again as it stands, which
// clears what a runner remembers of it: a refused claim (the task changes)
// and the failures it counted under the old dispatch.
function redispatch(item: Item): string {
  const d = item.dispatch;
  if (!d) return `atelier dispatch ${item.id}`;
  return [`atelier dispatch ${item.id}`, `--to ${d.to}`, d.agent ? `--agent ${d.agent}` : "", d.model ? `--model ${d.model}` : "",
    d.job === "merge-main" ? `--job merge-main${d.head ? ` --head ${d.head}` : ""}` : "", d.overlapOk ? "--overlap-ok" : ""].filter(Boolean).join(" ");
}

function refusedReasonLine(r: ClaimRefusal, item: Item): string {
  return `Claim refused: ${r.runner} claimed it as ${r.actor} and was refused (${r.error}: ${r.detail}); that runner passes it by until it changes, so once that is fixed, dispatch it again with ${redispatch(item)}.`;
}

function heldReasonLine(item: Item, h: CoreHold): string {
  const next = item.kind === "part" ? "" : `, or at once with atelier dispatch ${item.id} --overlap-ok`;
  return `Held: ${holdText(h)}; offered once ${h.id} merges or is abandoned${next}.`;
}

function overlapReasonLine(o: OverlapRefusal, item: Item): string {
  return `Overlap refused: ${o.id} (${o.state}${o.owner ? ` by ${o.owner}` : ""}) holds a scope that overlaps this one, and the project refuses overlapping claims; a runner can take it once ${o.id} merges or is abandoned, or the owner narrows a scope with atelier edit ${item.id} --scope GLOB (or atelier edit ${o.id} --scope GLOB), or allows overlaps with atelier init --refuse-overlap=false.`;
}

function skippedReasonLine(s: SkippedBy, item: Item): string {
  return `Skipped by ${s.runner} after ${s.failures} failed runs under this dispatch (the last ${s.last}); that runner passes it by until it is dispatched again or the runner restarts: fix the cause, then ${redispatch(item)}.`;
}

function unofferedReasonLine(dead: string, item: Item): string {
  return `${dead[0].toUpperCase()}${dead.slice(1)}. Dispatch it to a model a live runner offers (atelier dispatch ${item.id} --agent H --model M), or start a runner that offers it.`;
}

export function assertDispatchable(item: Item): void {
  if (item.state !== "open" || item.owner) {
    throw new RuleError("not_open", `${item.id} is ${item.owner ? `owned by ${item.owner}` : item.state}; only an open task can be sent to a runner`);
  }
}

// The claim rules a dispatch names ahead of the claim, so the owner is told
// a dispatch no runner could claim is refused now rather than costing a
// runner attempt (t405). A dispatch that names both agent and model is
// checked against the project's policy exactly as a claim by that actor
// would be: the executor role under a governed policy, or the eligible
// harnesses otherwise. A dispatch that names only a harness is checked for
// the restrictions that harness alone decides (harnessRefusal). A dispatch
// whose scope overlaps a live item's under a refuseOverlap policy is refused
// with the claim's own reason, naming the live item: no runner that does not
// already hold the overlapping item could claim it, and the named actor is
// used where one is named so a runner that does hold it is not refused.
export function assertDispatchClaimable(item: Item, items: readonly Item[], policy: ProjectPolicy, d: Dispatch, owner = DEFAULT_OWNER): void {
  if (d.agent && d.model) {
    const refusal = roleRefusal(`${d.agent}/${d.model}`, policy, "executor", owner);
    if (refusal) throw new RuleError("ineligible", refusal, 403);
  } else if (d.agent) {
    const refusal = harnessRefusal(d.agent, policy, "executor", owner);
    if (refusal) throw new RuleError("ineligible", refusal, 403);
  }
  if (policy.refuseOverlap) {
    const refusal = overlappingRefusal(item, items, dispatchClaimant(d));
    if (refusal) throw new RuleError("overlap", refusal);
  }
}

// What unoffered's and offering's helpers ask of a dispatch: the kind of
// runner asked for, and everything missingJob() reads in it, so the narrow
// dispatch a plan routes by (Pick<Dispatch, "to" | "job">) asks as fully as
// a whole one.
type OfferAsk = Pick<Dispatch, "to" | "job" | "planHead" | "task">;

// The jobs a runner must offer to take a dispatch: its job, "merge-plan"
// when it carries a plan head to merge, "merge-main-task" in place of
// "merge-main" for a task's merge-main job (t243), which is how the runner
// names that job (jobOf in cli/runner.mjs), and "build" for a plain build, which an offer names
// like any other job — a runner kept for reviews alone must never be handed
// one, or a single long build on it holds every review behind it while
// unoffered() stays silent (t252). An offer naming no job at all is an older
// runner's, which offered none before jobs were named and took builds, so
// "build" alone defaults to offered there. Returns the first the offer
// lacks, or null when it offers them all.
function missingJob(d: Pick<Dispatch, "job" | "planHead" | "task">, offer: RunnerOffer): string | null {
  const jobs = offer.jobs ?? [];
  const taskMerge = d.job === "merge-main" && d.task;
  const needs = [taskMerge ? null : d.job, d.planHead ? "merge-plan" : null, taskMerge ? "merge-main-task" : null,
    d.job === undefined && !d.planHead ? "build" : null];
  return needs.find((job): job is string => !!job && !jobs.includes(job) && !(job === "build" && !jobs.length)) ?? null;
}

// The agent and model a runner should use for a dispatch, or null if it cannot.
export function assign(d: Dispatch, offer: RunnerOffer): Assignment | null {
  // The integrate and refresh jobs always run as the reserved integrator,
  // which the queue returns to a runner that offers the job.
  if (d.job === "integrate" || d.job === "refresh") {
    if (!(offer.jobs ?? []).includes(d.job)) return null;
    if (d.to !== "any" && d.to !== offer.kind) return null;
    return { agent: "atelier", model: "integrator", actor: "atelier/integrator" };
  }
  if (d.to !== "any" && d.to !== offer.kind) return null;
  if (missingJob(d, offer)) return null;
  for (const { agent, models } of offer.agents) {
    if (d.agent && agent !== d.agent) continue;
    const usable = models.filter((m) => claimable(agent, m));
    const model = d.model ? (usable.includes(d.model) ? d.model : null) : usable[0] ?? null;
    if (model) return { agent, model, actor: `${agent}/${model}` };
  }
  return null;
}

// A dispatched task may be claimed only by a matching runner, under a name
// that matches the agent and model asked for. An undispatched task is claimed
// as before, by anyone eligible.
export function assertDispatchedClaim(item: Item & { dispatch?: Dispatch | null }, actor: string, runner: { runner: string; kind: RunnerKind } | null): void {
  const d = item.dispatch;
  if (!d || item.state !== "open") return;
  if (!runner) {
    throw new RuleError("dispatched", `${item.id} is waiting for a ${d.to === "any" ? "" : `${d.to} `}runner; withdraw the dispatch to claim it by hand`);
  }
  if (d.to !== "any" && d.to !== runner.kind) {
    throw new RuleError("wrong_runner", `${item.id} is for a ${d.to} runner, not ${runner.runner}`, 403);
  }
  const [harness, model] = actor.split("/");
  if (d.agent && harness !== d.agent) throw new RuleError("wrong_agent", `${item.id} asks for ${d.agent}, not ${harness}`, 403);
  if (d.model && model !== d.model) throw new RuleError("wrong_model", `${item.id} asks for ${d.model}, not ${model ?? "no model"}`, 403);
}

export function describe(d: Dispatch): string {
  const where = d.to === "any" ? "any runner" : `a ${d.to} runner`;
  const what = d.agent ? `${d.agent}${d.model ? ` with ${d.model}` : ""}` : d.model ? d.model : "its choice of agent";
  return `${where}, ${what}`;
}

// An offer as the server holds it (putRunnerOffer): what a runner can run
// and when it last asked for work with that offer.
export interface SeenOffer extends RunnerOffer {
  at: string;   // ISO time the runner last polled the queue with this offer, to within OFFER_REFRESH_MS
}

// How long after its last ask an offer still counts as live. A runner asks
// every 30 seconds, but it runs one task at a time and asks again only when
// the task ends, so the window covers a task at the default timeouts
// (cli/runner-config.mjs: 45 minutes of harness, 60 of finish) and the check
// that may follow. An offer older than this says its runner stopped, and
// counts for no more than one never made.
export const OFFER_LIVE_MS = 2 * 60 * 60 * 1000;

// How often a runner's unchanged offer is written again as it polls
// (askQueue in src/ledger.ts): a changed offer is written at once, an
// unchanged one at most once in this window, so its `at` lags the last ask
// by less than this, far inside OFFER_LIVE_MS.
export const OFFER_REFRESH_MS = 60 * 1000;

export function liveOffers(offers: readonly SeenOffer[], now = new Date()): SeenOffer[] {
  const until = now.getTime() - OFFER_LIVE_MS;
  return offers.filter((o) => Number.isFinite(Date.parse(o.at)) && Date.parse(o.at) >= until);
}

// Which runners offer each actor, keyed by the name a claim would use
// (agent/model, lowercased): only claimable pairs count, since those are the
// names a dispatch may name and a claim accept. Plan routing reads it over
// the live offers (src/plans/route.ts, pickPlanner in src/plans/state.ts):
// a dispatch no live runner could claim never starts, so a model no live
// runner offers gets no part (t246). Read per model, whatever job the
// runner would run: whether a runner runs the job a dispatch names is
// offering's question, below.
export function offeredActors(offers: readonly SeenOffer[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const offer of offers) {
    for (const { agent, models } of offer.agents) {
      for (const model of models.filter((m) => claimable(agent, m))) {
        const actor = `${agent}/${model}`.toLowerCase();
        out.set(actor, [...(out.get(actor) ?? []), offer.runner]);
      }
    }
  }
  return out;
}

// The names a runner offers for a dispatch's job, or null when the offer
// cannot take the job at all: it is the wrong kind of runner, or it offers
// no such job. The names are the claimable agent/model pairs assign() could
// hand the job to under this offer, whatever harness was asked — the useful
// fact is what could take the job instead, not which harness is missing.
function offeredNames(d: OfferAsk, offer: RunnerOffer): string[] | null {
  if (d.to !== "any" && d.to !== offer.kind) return null;
  if (missingJob(d, offer)) return null;
  const names: string[] = [];
  for (const { agent, models } of offer.agents) {
    for (const model of models) if (claimable(agent, model)) names.push(`${agent}/${model}`);
  }
  return names;
}

// One line per live runner naming what it offers for a dispatch's job
// instead of taking it, in the order the server lists the runners.
function insteadLines(d: OfferAsk, live: readonly SeenOffer[]): string[] {
  return live.map((offer) => {
    const names = offeredNames(d, offer);
    if (names === null) {
      if (d.to !== "any" && d.to !== offer.kind) return `${offer.runner} is a ${offer.kind} runner, not a ${d.to} one`;
      return `${offer.runner} offers no ${missingJob(d, offer)} job`;
    }
    return `${offer.runner} offers ${d.job ?? "build"} as ${names.length ? names.join(", ") : "nothing it could claim as"}`;
  });
}

// Why a dispatch no live runner offers will never be claimed, or null when a
// live runner would take it. The queue offers a dispatch only to a runner
// whose offer can run it, so a review routed to a model no live runner's
// config lists — or a dispatch for a job none offers — sits unclaimed however
// long it waits, and this says so: each live runner is named with what it
// offers instead, or that no runner is live at all.
export function unoffered(d: Dispatch, offers: readonly SeenOffer[], now = new Date()): string | null {
  const live = liveOffers(offers, now);
  if (live.some((offer) => assign(d, offer) !== null)) return null;
  if (!live.length) {
    const last = offers.map((o) => o.at).sort().at(-1);
    return last
      ? `no runner is live; the last to ask for work did so at ${last.slice(0, 16).replace("T", " ")} UTC`
      : "no runner has asked the server for work";
  }
  return `no live runner can take it: ${insteadLines(d, live).join("; ")}`;
}

// What the live runners offer for a dispatch's job: every claimable actor a
// live runner of the dispatched kind that offers the job lists, with the
// runners offering it, and one line per live runner naming what it offers
// for the job instead. Null when no runner is live, so the caller falls
// back to what it knows apart from the runners; plan routing falls back to
// the pool and says so (src/plans/route.ts). The job is part of the
// question: a model counts only when a live runner that offers the job
// lists it, never because some other runner names the model for other
// work, so a review is not routed to a model only a build runner offers
// (the t210 case, 2026-10-07). The per-model half of the question, which
// runners offer an actor at all, is offeredActors above.
export interface Offering {
  actors: Map<string, string[]>;   // claimable "agent/model", lower case, -> the runners offering it for the job
  instead: string[];               // what each live runner offers for the job instead, as unoffered says it
}

export function offering(d: OfferAsk, offers: readonly SeenOffer[], now = new Date()): Offering | null {
  const live = liveOffers(offers, now);
  if (!live.length) return null;
  const out: Offering = { actors: new Map(), instead: insteadLines(d, live) };
  for (const offer of live) {
    for (const name of offeredNames(d, offer) ?? []) {
      const key = name.toLowerCase();
      out.actors.set(key, [...(out.actors.get(key) ?? []), offer.runner]);
    }
  }
  return out;
}
