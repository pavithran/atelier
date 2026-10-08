// Dispatch: the project owner (and, later, an orchestrator holding an approved
// plan) puts an open task in a queue for a kind of runner. Runners do not get
// work pushed to them; they ask for it, describing what they can run, and then
// claim it through the ordinary atomic claim. A runner at home therefore only
// ever makes outgoing requests, and every runner's work is judged the same way.

import { RuleError, samePlan, scopesOverlapWithin, validActor, type Item, type ItemState } from "../rules.ts";
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
  // refresh or merge-main job, `head` is the main head to merge.
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

export function assertDispatchable(item: Item): void {
  if (item.state !== "open" || item.owner) {
    throw new RuleError("not_open", `${item.id} is ${item.owner ? `owned by ${item.owner}` : item.state}; only an open task can be sent to a runner`);
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
