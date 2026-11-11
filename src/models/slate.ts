// The model slate builder (t598, model slate C): for each of six jobs, the
// model to use, up to two alternates, and each model passed over with why.
//
// This module is pure. It takes the approved order, the pool, readings,
// offers, readiness, pauses and the clock (`now`) as arguments, and reads no
// ledger, no network and no clock. src/models/slate-store.ts keeps the
// records; availabilityOf (usage-readings.ts) says whether a model is
// available.
//
// The approved order is the developer's, per job. Nothing outside it is ever
// recommended: other pool models with the job's role come back as pending
// proposals, for the developer to approve.

import type { Dispatch, SeenOffer } from "../dispatch/rules.ts";
import { actorFamily, type ProjectPolicy } from "../rules.ts";
import type { ProviderPause } from "../runners/memory.ts";
import { standingRefusal, type ModelEntry, type ModelRole } from "./pool.ts";
import { ranked, type RecordSummary } from "./suggest.ts";
import { availabilityOf, type ReadinessByRunner, type Readings } from "./usage-readings.ts";

export const SLATE_JOBS = ["build", "small-build", "hard-round", "review-claude", "review-openai", "criteria-review"] as const;
export type SlateJob = (typeof SLATE_JOBS)[number];
export type SlateOrder = Record<SlateJob, string[]>;   // harness/model, in the developer's order

// A task's job for the slate. A verdict is one review's: the head it judged,
// whether it approved, and its review role (a verdict with none is review).
export interface SlateVerdict { head: string; approve: boolean; role?: string }
const GLOB = /[*?[\]{}]/;
const MAX_SMALL = 5;

export function jobOf(task: { scope: readonly string[] }, verdicts: readonly SlateVerdict[]): "hard-round" | "small-build" | "build" {
  const rejectedHeads = new Set(verdicts.filter((v) => !v.approve && (v.role ?? "review") === "review").map((v) => v.head));
  if (rejectedHeads.size >= 2) return "hard-round";
  const files = task.scope.length >= 1 && task.scope.length <= MAX_SMALL && task.scope.every((p) => p !== "" && !GLOB.test(p) && !p.endsWith("/"));
  return files ? "small-build" : "build";
}

export interface Proposal { actor: string; flags: string[]; reason: string }
export interface JobSlate {
  recommended: string | null;
  alternates: string[];                         // at most two, in the approved order
  dropped: { actor: string; reason: string }[]; // approved models passed over
  flags: Record<string, string[]>;              // of the recommended and the alternates, when they have any
  proposals: Proposal[];                        // pool models outside the order, pending the developer's approval
}
export type Slate = Record<SlateJob, JobSlate>;

export interface SlateInput {
  approved: { order: SlateOrder };
  pool: readonly ModelEntry[];
  project: string;
  policy: ProjectPolicy;
  owner?: string;
  readings: Readings;
  offers: readonly SeenOffer[] | null;
  readiness: ReadinessByRunner;
  pauses: readonly ProviderPause[];
  // The families the project's vendor limits allow, or null for no row: no limit.
  limits: readonly string[] | null;
  // The recorded authors of the task's criteria (harness/model), as criteria review reads them.
  authors: readonly string[];
  now: number | Date;
  summary?: RecordSummary;
}

const REVIEW_OF: Partial<Record<SlateJob, string>> = { "review-claude": "anthropic", "review-openai": "openai" };
const roleOf = (job: SlateJob): ModelRole => (job.startsWith("review") || job === "criteria-review" ? "review" : "build");
const dispatchJob = (job: SlateJob): Dispatch["job"] | "build" => (job === "criteria-review" ? "criteria-review" : roleOf(job) === "review" ? "review" : "build");
const actorOf = (e: ModelEntry) => `${e.harness}/${e.id}`;
// Argon (harness antigravity) is a fallback: it comes after every other model.
const isArgon = (e: ModelEntry) => e.harness === "antigravity";

export function buildSlate(input: SlateInput): Slate {
  const byActor = new Map(input.pool.map((e) => [actorOf(e), e]));
  const authorFamilies = new Set(input.authors.map((a) => actorFamily(a) as string));
  const ask = (job: SlateJob) => ({ project: input.project, job: dispatchJob(job), policy: input.policy, owner: input.owner });

  // Why a job may not use a model whatever its availability, or null.
  const excluded = (job: SlateJob, e: ModelEntry): string | null => {
    const barred = REVIEW_OF[job];
    if (barred && e.family === barred) return `family ${barred}: ${job} is reviewed by another company's model`;
    if (job === "criteria-review" && authorFamilies.has(e.family)) return `family ${e.family}: the criteria's author is of that company, and criteria are reviewed by another company's model`;
    if (input.limits && !input.limits.includes(e.family)) return `vendor limit: the project allows ${input.limits.join(", ") || "no vendor"}, not ${e.family}`;
    return null;
  };

  const slate = {} as Slate;
  for (const job of SLATE_JOBS) {
    const order = input.approved.order[job] ?? [];
    const dropped: JobSlate["dropped"] = [];
    const flags: Record<string, string[]> = {};
    const usable: { entry: ModelEntry; flags: string[] }[] = [];
    for (const actor of order) {
      const entry = byActor.get(actor);
      if (!entry) { dropped.push({ actor, reason: "not in the pool" }); continue; }
      const barred = excluded(job, entry);
      if (barred) { dropped.push({ actor, reason: barred }); continue; }
      const a = availabilityOf(entry, ask(job), input.readings, input.offers, input.readiness, input.pauses, input.now);
      if (!a.available) { dropped.push({ actor, reason: a.reason! }); continue; }
      usable.push({ entry, flags: a.flags });
    }
    const chosen = [...usable.filter((u) => !isArgon(u.entry)), ...usable.filter((u) => isArgon(u.entry))].slice(0, 3);
    for (const c of chosen) if (c.flags.length) flags[actorOf(c.entry)] = c.flags;

    // Pool models outside the order: only proposals, known usage first, then by ranking.
    const inOrder = new Set(order);
    const candidates = input.pool.filter((e) => !inOrder.has(actorOf(e)) && standingRefusal(e, roleOf(job)) === null && excluded(job, e) === null);
    const proposals: Proposal[] = [];
    for (const { entry, reason } of ranked({ pool: candidates, owner: input.owner, summary: input.summary, sources: [], runs: [] })) {
      const a = availabilityOf(entry, ask(job), input.readings, input.offers, input.readiness, input.pauses, input.now);
      if (a.available) proposals.push({ actor: actorOf(entry), flags: a.flags, reason });
    }
    const known = proposals.filter((p) => !p.flags.length);

    slate[job] = {
      recommended: chosen[0] ? actorOf(chosen[0].entry) : null,
      alternates: chosen.slice(1).map((c) => actorOf(c.entry)),
      dropped, flags,
      proposals: [...known, ...proposals.filter((p) => p.flags.length)],
    };
  }
  return slate;
}
