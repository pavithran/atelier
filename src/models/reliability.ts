// Each model's reliability across every project: how its work fared at
// review, how its own reviews held up, and how the runs it was given ended.
// Pure functions over each project's ledger events and the runners' reports,
// so the Models page, the Usage page, the API and routing read one record and
// the tests check the arithmetic without a Durable Object.
//
// A model is keyed by modelKey (src/rules.ts): the same model under two
// harnesses, a profile suffix or a registered alias is one record, and the
// harness/model names it acted under are kept beside it.
//
// Its work is what it held: the outcome of a review, a merge or a defect is
// the model's that held the item when the reviewed revision was submitted.
// Its verdicts are the reviews it recorded. The project owner's approvals are
// never a model's verdict: they are counted apart, per model whose work they
// approved, by where they were recorded (src/ledger.ts addReview): on the
// task page, which only the signed-in owner reaches, or through the API with
// the owner token, as the orchestrator records them. An approval recorded
// before the ledger kept the two apart is counted as unrecorded.
//
// An event the owner annotated as served by another model (src/models/served.ts)
// counts under that model, as buildRecord counts it.

import type { LedgerEvent } from "../ledger.ts";
import { familyOf, redactKeys, type PoolFamily } from "./pool.ts";
import { modelKey, RuleError, sameActor, validActor } from "../rules.ts";
import { TEXT_CONTROLS } from "../text.ts";
import { SERVED, servedActor, servedBy } from "./served.ts";

export const RUN_OUTCOMES = ["stalled", "timed-out", "refused"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export const RUN_ROLES = ["build", "review"] as const;
export type RunRole = (typeof RUN_ROLES)[number];

// A run that ended without a result the ledger could record, as the runner
// that ran it reports it: the harness made nothing and stopped (stalled),
// ran past its time limit (timed-out), or the harness or its provider
// refused the run (refused). A review run that ends this way is a review
// that never reached a verdict.
export interface RunReport {
  actor: string;            // harness/model, the agent the runner ran
  role: RunRole;
  outcome: RunOutcome;
  project: string | null;
  item: string | null;
  detail: string;
  runner: string;           // kind:name, from X-Atelier-Runner
  at: string;               // when the server received it
}

// One recorded cause: a rejection's note, a defect's note, a run's detail.
export interface Cause { project: string; item: string | null; by: string; note: string; at: string }

export type OwnerChannel = "page" | "api" | "unrecorded";

export interface ModelReliability {
  model: string;                  // modelKey
  family: PoolFamily;
  actors: string[];               // the harness/model names it acted under
  projects: string[];
  // Its work, as the holder.
  firstReviews: number;           // pieces of its work that reached a model's review
  approvedFirst: number;          // of those, approved at that first review
  merged: number;                 // items merged while it held them
  mergedReviewed: number;         // of those, items a model reviewed
  rounds: number;                 // revisions a model reviewed, summed over mergedReviewed
  rejections: Cause[];            // its work sent back, with the note that said why
  defects: Cause[];               // defects the owner traced to its accepted work
  ownerApprovals: Record<OwnerChannel, number>;
  // Its verdicts, as a reviewer.
  approvals: number;
  rejectionsGiven: number;
  contradicted: Cause[];          // its approvals of a revision a defect was later traced to
  // Runs the runners reported.
  runs: Record<RunOutcome, number>;
  unfinishedReviews: number;      // review runs among them: reviews that never reached a verdict
  runCauses: Cause[];
}

export type Reliability = ReadonlyMap<string, ModelReliability>;
export interface ProjectEvents { project: string; events: readonly LedgerEvent[] }

const empty = (model: string): ModelReliability => ({
  model, family: familyOf(model), actors: [], projects: [],
  firstReviews: 0, approvedFirst: 0, merged: 0, mergedReviewed: 0, rounds: 0, rejections: [], defects: [],
  ownerApprovals: { page: 0, api: 0, unrecorded: 0 },
  approvals: 0, rejectionsGiven: 0, contradicted: [],
  runs: { stalled: 0, "timed-out": 0, refused: 0 }, unfinishedReviews: 0, runCauses: [],
});

const str = (v: unknown) => (typeof v === "string" ? v : "");
const newestFirst = (a: Cause, b: Cause) => b.at.localeCompare(a.at);

// An agent: harness/model, not Atelier's own recorder and not the owner.
function isAgent(actor: string, owner: string): boolean {
  return actor !== owner && actor.includes("/") && !actor.startsWith("atelier/") && validActor(actor);
}

export function buildReliability(projects: readonly ProjectEvents[], runs: readonly RunReport[], owner: string): Reliability {
  const records = new Map<string, ModelReliability>();
  const get = (actor: string, project?: string): ModelReliability => {
    const key = modelKey(actor);
    let r = records.get(key);
    if (!r) records.set(key, (r = empty(key)));
    if (!r.actors.some((a) => a.toLowerCase() === actor.toLowerCase())) r.actors.push(actor);
    if (project && !r.projects.includes(project)) r.projects.push(project);
    return r;
  };
  for (const { project, events } of projects) replay(project, events, owner, get);
  for (const run of runs) {
    if (!isAgent(run.actor, owner)) continue;
    const r = get(run.actor, run.project ?? undefined);
    r.runs[run.outcome]++;
    if (run.role === "review") r.unfinishedReviews++;
    r.runCauses.push({ project: run.project ?? "", item: run.item, by: run.runner, note: `${run.role} run ${run.outcome}${run.detail ? `: ${run.detail}` : ""}`, at: run.at });
  }
  for (const r of records.values()) {
    for (const list of [r.rejections, r.defects, r.contradicted, r.runCauses]) list.sort(newestFirst);
    r.actors.sort();
    r.projects.sort();
  }
  return new Map([...records].sort(([a], [b]) => a.localeCompare(b)));
}

// One project's events in sequence. A partial history attributes an outcome
// only once a claim or handoff has named the holder, as buildRecord does.
function replay(project: string, events: readonly LedgerEvent[], owner: string, get: (actor: string, project?: string) => ModelReliability): void {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const served = servedBy(sorted);
  // The holder as recorded, which its own later events name, and the actor
  // its work is counted under.
  const holders = new Map<string, { recorded: string; serving: string }>();
  const builtAt = new Map<string, Map<string, string>>();     // item, head: who submitted that revision
  const lastBuilder = new Map<string, string>();               // item: who submitted or merged it last
  const reviewedHeads = new Map<string, Set<string>>();        // item: revisions a model reviewed
  const approvedAt = new Map<string, { reviewer: string; head: string }[]>();
  const firstReview = new Set<string>();                       // item and builder model already counted
  const ownerSeen = new Set<string>();                         // item and revision the owner approved
  const builderOf = (item: string, head: string) => builtAt.get(item)?.get(head) ?? holders.get(item)?.serving ?? lastBuilder.get(item);

  for (const event of sorted) {
    const { itemId: item, kind, data } = event;
    if (item === null || kind === SERVED) continue;
    const actor = servedActor(event, served);
    const holder = holders.get(item);
    if (kind === "item.claimed") {
      holders.set(item, { recorded: event.actor, serving: actor });
      get(actor, project);
      continue;
    }
    if (kind === "item.handoff") {
      const to = str(data.to);
      if (to) holders.set(item, { recorded: to, serving: to });
      else holders.delete(item);
      continue;
    }
    if (kind === "item.released" || kind === "item.abandoned") {
      holders.delete(item);
      continue;
    }
    // The holder's own action: its work from here on is counted under the
    // model that served this action.
    if (holder && sameActor(event.actor, holder.recorded)) holder.serving = served.has(event.seq) ? actor : holder.recorded;
    const head = str(data.head);
    if (kind === "item.submitted" && holder) {
      const heads = builtAt.get(item) ?? new Map<string, string>();
      heads.set(head, holder.serving);
      builtAt.set(item, heads);
      lastBuilder.set(item, holder.serving);
    } else if (kind === "review.approved" || kind === "review.rejected") {
      const approve = kind === "review.approved";
      const builder = builderOf(item, head);
      if (actor === owner) {
        if (!builder) continue;
        if (approve) {
          if (ownerSeen.has(`${item} ${head}`)) continue;
          ownerSeen.add(`${item} ${head}`);
          const recorded = data.via;
          const via: OwnerChannel = recorded === "page" || recorded === "api" ? recorded : "unrecorded";
          get(builder, project).ownerApprovals[via]++;
        } else get(builder, project).rejections.push({ project, item, by: actor, note: str(data.note), at: event.at });
        continue;
      }
      if (!isAgent(actor, owner)) continue;
      const reviewer = get(actor, project);
      if (approve) {
        reviewer.approvals++;
        approvedAt.set(item, [...(approvedAt.get(item) ?? []), { reviewer: actor, head }]);
      } else reviewer.rejectionsGiven++;
      if (!builder) continue;
      const built = get(builder, project);
      const first = `${item} ${modelKey(builder)}`;
      if (!firstReview.has(first)) {
        firstReview.add(first);
        built.firstReviews++;
        if (approve) built.approvedFirst++;
      }
      reviewedHeads.set(item, (reviewedHeads.get(item) ?? new Set()).add(head));
      if (!approve) built.rejections.push({ project, item, by: actor, note: str(data.note), at: event.at });
    } else if (kind === "item.merged") {
      const builder = holder?.serving ?? lastBuilder.get(item);
      holders.delete(item);
      if (!builder) continue;
      lastBuilder.set(item, builder);
      const r = get(builder, project);
      r.merged++;
      const rounds = reviewedHeads.get(item)?.size ?? 0;
      if (rounds) {
        r.mergedReviewed++;
        r.rounds += rounds;
      }
    } else if (kind === "item.defect") {
      // A defect the owner traced to the accepted revision: it counts against
      // the model that built that revision, and against every model that
      // approved that revision before the defect was traced.
      const cause = { project, item, by: actor, note: str(data.note), at: event.at };
      const builder = builderOf(item, head);
      if (builder) get(builder, project).defects.push(cause);
      for (const a of approvedAt.get(item) ?? []) if (a.head === head) get(a.reviewer, project).contradicted.push(cause);
    }
  }
}

// ── the tie-breaker routing reads ──────────────────────────────────────────

// Outcomes in favour of a model and against it. In favour: work approved at
// its first review, and work merged. Against: work sent back, defects traced
// to its work, its approvals a defect contradicted, and runs that stalled,
// timed out or were refused. The owner's approvals are neither.
export interface Outcomes { good: number; bad: number }

export function outcomesOf(r: ModelReliability): Outcomes {
  return {
    good: r.approvedFirst + r.merged,
    bad: r.rejections.length + r.defects.length + r.contradicted.length + r.runs.stalled + r.runs["timed-out"] + r.runs.refused,
  };
}

// The share of outcomes in favour, with one of each added so a model with no
// record sits at one half and a single outcome moves it only part way.
export const tiebreak = (o: Outcomes) => (o.good + 1) / (o.good + o.bad + 2);

// ── words ──────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function roundsPerMerge(r: ModelReliability): string | null {
  return r.mergedReviewed ? (r.rounds / r.mergedReviewed).toFixed(1) : null;
}

// The record in one sentence, for a model's card and a routing reason.
export function reliabilityLine(r: ModelReliability): string {
  const rounds = roundsPerMerge(r);
  const work = [
    r.firstReviews ? `${r.approvedFirst} of ${r.firstReviews} approved at first review` : "no work reviewed yet",
    r.merged ? `${plural(r.merged, "merge")}${rounds ? `, ${rounds} review rounds each on average` : ", none reviewed by a model"}` : "",
    plural(r.rejections.length, "rejection"),
    plural(r.defects.length, "defect traced to its work", "defects traced to its work"),
  ].filter(Boolean);
  const verdicts = `as a reviewer ${r.contradicted.length} of ${plural(r.approvals, "approval")} contradicted by a defect, ${plural(r.unfinishedReviews, "review")} without a verdict`;
  const runs = `runs ${r.runs.stalled} stalled, ${r.runs["timed-out"]} timed out, ${r.runs.refused} refused`;
  return `${work.join(", ")}; ${verdicts}; ${runs}.`;
}

// ── run reports ────────────────────────────────────────────────────────────

const PROJECT = /^[^\s/:]{1,100}$/;
const ITEM = /^t[0-9]{1,9}$/;
const SECRET_FIELDS = ["key", "apiKey", "token", "authorization", "header", "headers"];
const plain = (s: string, max: number) => redactKeys(s.replace(TEXT_CONTROLS, " ")).replace(/\s+/g, " ").trim().slice(0, max);

// A run report from the route body, validated, or a RuleError saying what is
// wrong. `at` and `runner` are the server's, as a usage report takes them.
export function cleanRun(body: Record<string, unknown>, at: string, runner: string): RunReport {
  const bad = (detail: string) => new RuleError("bad_run", detail, 400);
  if (SECRET_FIELDS.some((f) => f in body)) throw bad("a run report carries what happened, never a key or a header");
  const actor = str(body.actor).trim();
  if (!validActor(actor) || !actor.includes("/") || actor.startsWith("atelier/")) throw bad("actor must be the harness/model the runner ran, such as opencode/glm-5.3");
  const role = body.role === undefined ? "build" : str(body.role);
  if (!RUN_ROLES.includes(role as RunRole)) throw bad("role must be build or review");
  const outcome = str(body.outcome);
  if (!RUN_OUTCOMES.includes(outcome as RunOutcome)) throw bad("outcome must be stalled, timed-out or refused");
  const project = body.project === undefined || body.project === null ? null : str(body.project).trim();
  if (project !== null && !PROJECT.test(project)) throw bad("project must be a project's name");
  const item = body.item === undefined || body.item === null ? null : str(body.item).trim();
  if (item !== null && !ITEM.test(item)) throw bad("item must be a task id such as t12");
  return { actor, role: role as RunRole, outcome: outcome as RunOutcome, project, item, detail: plain(str(body.detail), 300), runner, at };
}

// ── defects ────────────────────────────────────────────────────────────────

export const DEFECT_NOTE_MAX = 500;
const FOUND_IN = /^([^\s/:]{1,100}\/)?t[0-9]{1,9}$/;

// What tracing a defect to an accepted change records: what the defect is,
// and optionally the task it was found or fixed in. A missing or blank note
// is refused, because the note is the cause the record shows.
export function cleanDefect(body: Record<string, unknown>): { note: string; foundIn: string | null } {
  const note = str(body.note).replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim();
  if (!note) throw new RuleError("defect_note", "a defect needs a note saying what is wrong", 400);
  if (note.length > DEFECT_NOTE_MAX) throw new RuleError("defect_note", `a defect's note is at most ${DEFECT_NOTE_MAX} characters`, 400);
  const foundIn = body.foundIn === undefined || body.foundIn === null || body.foundIn === "" ? null : str(body.foundIn).trim();
  if (foundIn !== null && !FOUND_IN.test(foundIn)) throw new RuleError("defect_found_in", "foundIn must name a task, such as t12 or atelier/t12", 400);
  return { note, foundIn };
}

// The record as JSON: one entry per model, in model order.
export const reliabilityJson = (r: Reliability) => [...r.values()];
