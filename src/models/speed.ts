// How fast each model works, from the ledger's own timestamps (t260): per
// model and role, the time from claim to submission for builds, from a
// review claim to the verdict for reviews, and from a task's first claim to
// its merge, as medians over a stated window with the number of samples,
// and the share of runs that stalled. A pure function over each project's
// events and the runners' reports, as the reliability record is
// (src/models/reliability.ts), so the Models page, GET /api/reliability,
// `atelier runner --usage` and routing read one record and the tests check
// the arithmetic without a Durable Object. Nothing new is stored.
//
// A model is keyed by modelKey (src/rules.ts), and an event the owner
// annotated as served by another model counts under that model
// (src/models/served.ts). Only agents count: the owner and Atelier's own
// recorder open no row.
//
// A sample belongs to the window when the run ended in it: the submission,
// the verdict or the merge. A median is given only over SPEED_MIN_SAMPLES
// or more samples; below that the record states n and no median, since one
// or two runs say little about a model's pace.

import type { LedgerEvent } from "../ledger.ts";
import { modelKey } from "../rules.ts";
import { isAgent, type ProjectEvents, type RunReport } from "./reliability.ts";
import { SERVED, servedActor, servedBy } from "./served.ts";

export const SPEED_DAYS = 14;
export const SPEED_MIN_SAMPLES = 3;

// The run reports that count as a stall: the harness made nothing and
// stopped, or ran past its time limit without a result. Refusals, permission
// stops and the rest are failures of another kind and are not stalls.
export const STALL_OUTCOMES: readonly RunReport["outcome"][] = ["stalled", "timed-out"];

// Seconds, over n samples in the window; median null below SPEED_MIN_SAMPLES.
export interface Measure { n: number; median: number | null }

// A role's measure, with its runs in the window: the runs that ended with a
// result (a submission or a verdict) and every run a runner or the owner
// reported as ending without one, and of those the stalls.
export interface RoleSpeed extends Measure { runs: number; stalled: number }

export interface ModelSpeed {
  model: string;        // modelKey
  actors: string[];     // the harness/model names it acted under
  build: RoleSpeed;     // its claim to its submission
  review: RoleSpeed;    // its review claim to its verdict
  task: Measure;        // the task's first claim, which it made, to the merge
}

export interface SpeedRecord {
  days: number;
  since: string;        // ISO, the window's start
  until: string;        // ISO, the window's end: when the record was read
  minSamples: number;
  models: ModelSpeed[]; // in model order; only models with a sample or a run in the window
}

const median = (xs: number[]): number | null => {
  if (xs.length < SPEED_MIN_SAMPLES) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

interface Bin { actors: Set<string>; build: number[]; review: number[]; task: number[]; buildRuns: number; reviewRuns: number; buildStalled: number; reviewStalled: number }

export function buildSpeed(projects: readonly ProjectEvents[], runs: readonly RunReport[], owner: string, now: number, days = SPEED_DAYS): SpeedRecord {
  const since = now - days * 86_400_000;
  const inWindow = (at: string) => { const t = Date.parse(at); return t >= since && t <= now; };
  const bins = new Map<string, Bin>();
  const bin = (actor: string): Bin => {
    const key = modelKey(actor);
    let b = bins.get(key);
    if (!b) bins.set(key, (b = { actors: new Set(), build: [], review: [], task: [], buildRuns: 0, reviewRuns: 0, buildStalled: 0, reviewStalled: 0 }));
    b.actors.add(actor);
    return b;
  };
  const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;

  for (const { events } of projects) replay(events, owner, inWindow, bin, seconds);
  for (const run of runs) {
    if ((run.role !== "build" && run.role !== "review") || !isAgent(run.actor, owner) || !inWindow(run.at)) continue;
    const b = bin(run.actor);
    const stalled = STALL_OUTCOMES.includes(run.outcome) ? 1 : 0;
    if (run.role === "build") { b.buildRuns++; b.buildStalled += stalled; }
    else { b.reviewRuns++; b.reviewStalled += stalled; }
  }
  const models = [...bins.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, b]): ModelSpeed => ({
    model, actors: [...b.actors].sort(),
    build: { n: b.build.length, median: median(b.build), runs: b.buildRuns, stalled: b.buildStalled },
    review: { n: b.review.length, median: median(b.review), runs: b.reviewRuns, stalled: b.reviewStalled },
    task: { n: b.task.length, median: median(b.task) },
  }));
  return { days, since: new Date(since).toISOString(), until: new Date(now).toISOString(), minSamples: SPEED_MIN_SAMPLES, models };
}

// One project's events in sequence. A build is timed from each agent's
// claim to the first submission while that claim holds; a handoff, release
// or abandonment ends it untimed. A review is timed from the reviewer's
// newest review claim on the item to its verdict there; a release of the
// claim ends it untimed. A verdict recorded without a claim (before t215)
// is a review that ended with a result but has no time. A task is timed
// from its first agent claim to its merge, under the model that claimed it.
// The reviewer a review claim belongs to, as the ledger matches a verdict to
// its claim (sameActor in src/rules.ts): the harness and the model. Two
// harnesses serving one model (zcode/glm-5.3 and opencode/glm-5.3) are two
// reviewers, each with its own claim, though their samples count under the
// one model.
const reviewerKey = (actor: string) => `${actor.includes("/") ? actor.slice(0, actor.indexOf("/")).toLowerCase() : ""}/${modelKey(actor)}`;

function replay(events: readonly LedgerEvent[], owner: string, inWindow: (at: string) => boolean, bin: (actor: string) => Bin, seconds: (a: string, b: string) => number): void {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const served = servedBy(sorted);
  const building = new Map<string, { at: string; model: string }>();        // item: the open claim
  const firstClaim = new Map<string, { at: string; model: string }>();      // item: its first agent claim
  const reviewing = new Map<string, Map<string, string>>();                 // item: reviewerKey -> claimed at
  for (const event of sorted) {
    const { itemId: item, kind } = event;
    if (item === null || kind === SERVED) continue;
    const actor = servedActor(event, served);
    if (kind === "item.claimed") {
      if (!isAgent(actor, owner)) { building.delete(item); continue; }
      building.set(item, { at: event.at, model: actor });
      if (!firstClaim.has(item)) firstClaim.set(item, { at: event.at, model: actor });
    } else if (kind === "item.handoff" || kind === "item.released") {
      building.delete(item);
    } else if (kind === "item.abandoned") {
      // An abandoned item ends its build and every open review claim untimed.
      building.delete(item);
      reviewing.delete(item);
    } else if (kind === "item.submitted") {
      const claim = building.get(item);
      building.delete(item);
      if (claim && inWindow(event.at)) {
        const b = bin(claim.model);
        b.build.push(seconds(claim.at, event.at));
        b.buildRuns++;
      }
    } else if (kind === "item.merged") {
      // A merge ends any review still claimed on the item; none can follow.
      building.delete(item);
      reviewing.delete(item);
      const first = firstClaim.get(item);
      if (first && inWindow(event.at)) bin(first.model).task.push(seconds(first.at, event.at));
    } else if (kind === "review.claimed") {
      if (!isAgent(actor, owner)) continue;
      reviewing.set(item, (reviewing.get(item) ?? new Map()).set(reviewerKey(event.actor), event.at));
    } else if (kind === "review.released") {
      reviewing.get(item)?.delete(reviewerKey(event.actor));
    } else if (kind === "review.approved" || kind === "review.rejected") {
      if (!isAgent(actor, owner)) continue;
      const claims = reviewing.get(item);
      const at = claims?.get(reviewerKey(event.actor));
      claims?.delete(reviewerKey(event.actor));
      if (!inWindow(event.at)) continue;
      const b = bin(actor);
      b.reviewRuns++;
      if (at !== undefined) b.review.push(seconds(at, event.at));
    }
  }
}

// ── words ──────────────────────────────────────────────────────────────────

// A duration in a compact form: "45s", "12m", "2.5h".
export function pace(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

// A measure as words: the median with its n, or only n when there are
// fewer samples than a median is given over.
export function measureText(m: Measure): string {
  if (!m.n) return "none";
  return m.median === null ? `n=${m.n}, too few for a median` : `median ${pace(m.median)}, n=${m.n}`;
}

// The stalled share of a role's runs: "1 of 4 stalled (25%)", or "no runs".
export function stalledText(r: RoleSpeed): string {
  if (!r.runs) return "no runs";
  return `${r.stalled} of ${r.runs} run${r.runs === 1 ? "" : "s"} stalled (${Math.round((r.stalled / r.runs) * 100)}%)`;
}

// A model's speed in one line, for the CLI and a routing reason.
export function speedLine(m: ModelSpeed): string {
  return `builds ${measureText(m.build)}, ${stalledText(m.build)}; reviews ${measureText(m.review)}, ${stalledText(m.review)}; claim to merge ${measureText(m.task)}`;
}
