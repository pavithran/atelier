// `atelier situation` (Atelier 2.0, lessons gap G4): one read of where a
// project stands, for a person as text and for a model as JSON. Every field
// is a recorded fact: the project Ledger's items, events, review requests,
// landing records and evidence (Ledger.situationFacts), the index's runner
// offers and runner tokens, the commit the server runs and the free disk
// where it runs. Nothing here decides or acts; the flags (a runner silent, a
// runner on another commit, free disk under a tenth) are facts measured
// against a stated limit, which the reader may weigh as it likes.
import { checkLimits, type CheckLimits } from "./check-limit.ts";
import { OFFER_REFRESH_MS, servesProject, type CoreHold, type Dispatch, type SeenOffer } from "./dispatch/rules.ts";
import type { Decision } from "./decisions.ts";
import type { LandingLease } from "./landing-lease.ts";
import type { LandingRecord, ProjectRecord } from "./ledger";
import type { Block, Item } from "./rules";
import type { AgentToken } from "./tokens.ts";

// A runner whose last poll is older than this is shown as silent. The offer's
// time lags its last poll by up to OFFER_REFRESH_MS (askQueue rewrites an
// unchanged offer once a minute), so that minute is allowed on top, as the
// stuck report allows it: a runner flagged silent has been silent 5 minutes.
export const RUNNER_SILENT_MS = 5 * 60_000;
// Free disk under this share of the volume the server's data lives on is
// shown as a warning.
export const DISK_WARN_PERCENT = 10;

// What the project Ledger records, read in one call (Ledger.situationFacts).
export interface SituationFacts {
  project: Pick<ProjectRecord, "name" | "policy">;
  mode: { mode: string; line: string };
  items: Item[];
  // The stage each listed task's newest event recorded (events.stage), and
  // the time of the oldest event in the unbroken run of that stage.
  stages: Record<string, { stage: string; since: string }>;
  // The dispatched tasks the queue holds back, with what holds each.
  held: { id: string; held: CoreHold }[];
  reviewRequests: { id: number; item: string; head: string; state: string; dispatch: Dispatch; claimedBy: string | null; runner: string | null; claimedAt: string | null; tier: boolean }[];
  landingLease: LandingLease | null;
  landJobs: { item: string; by: string; at: string }[];
  landings: Record<string, LandingRecord>;
  lastChecks: Record<string, { claim: string; passed: boolean | null; head: string; at: string; by: string; stopped?: { kind: string; minutes: number } }>;
  standing: Decision[];
  // Each listed task's blockers (G3), merged ones included, with their states.
  blockers: Record<string, Blocker[]>;
}

// A task another waits on (G3), as the waiting task lists it.
export interface Blocker { id: string; state: string; title: string }

export interface DiskFacts { path: string; freeBytes: number; totalBytes: number }

export interface SituationInput {
  facts: SituationFacts;
  offers: SeenOffer[] | null;            // null: the index could not be read
  tokens: Omit<AgentToken, "hash">[] | null;
  names: string[];                        // every name the project has had
  commit: string | null;                  // the commit this server runs (DEPLOYED_MAIN)
  disk: DiskFacts | null;                 // null where it cannot be read (a Worker)
  now: Date;
}

const ageMs = (at: string | null | undefined, now: Date): number | null => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? Math.max(0, now.getTime() - t) : null;
};
const actorOf = (d: Pick<Dispatch, "agent" | "model"> | null | undefined): string | null => (d?.agent && d.model ? `${d.agent}/${d.model}` : null);
const dispatchJson = (d: Dispatch | null | undefined) => d ? { to: d.to ?? null, agent: d.agent ?? null, model: d.model ?? null, job: d.job ?? "build", at: d.at } : null;

// Who lifts a block, in words, and the command: a fact (a run stopped at its
// limit, G7) is lifted by any model; anything else needs the developer's words.
export function blockLift(id: string, b: Block): { liftedBy: string; next: string } {
  return b.fact
    ? { liftedBy: "any model: the block is a fact about a run", next: `atelier unblock ${id}` }
    : { liftedBy: "the developer's words", next: `atelier unblock ${id} --quote "the developer's words"` };
}

export function situationOf(input: SituationInput) {
  const { facts, now } = input;
  const project = facts.project.name;
  const items = facts.items;
  const tasks = items.map((i) => {
    const stage = facts.stages[i.id] ?? null;
    return {
      id: i.id, title: i.title, state: i.state, owner: i.owner, runner: i.runner ?? null, head: i.head, scope: i.scope,
      stage: stage?.stage ?? null, stageSince: stage?.since ?? null, stageAgeMs: ageMs(stage?.since, now),
      createdAt: i.createdAt, updatedAt: i.updatedAt, lastPushAt: i.lastPushAt,
      dispatch: dispatchJson(i.dispatch),
      blockedBy: (facts.blockers?.[i.id] ?? []).map((b) => ({ id: b.id, state: b.state })),
      lastCheck: facts.lastChecks[i.id] ?? null,
    };
  });
  const holds = [
    ...facts.held.map(({ id, held }) => ({
      task: id, kind: "core-file" as const,
      blockers: (held.blockers ?? [held]).map((b) => ({ id: b.id, state: b.state as string, owner: b.owner as string | null, file: b.core as string | null })),
      since: held.since ?? null, ageMs: held.elapsedMs ?? ageMs(held.since, now),
    })),
    // A live task waits on every blocker not yet merged (G3); an abandoned
    // one stays listed, so the task is never released silently.
    ...items.filter((i) => i.state !== "merged" && i.state !== "abandoned").flatMap((i) => {
      const waits = (facts.blockers?.[i.id] ?? []).filter((b) => b.state !== "merged");
      return waits.length ? [{ task: i.id, kind: "blocked-by" as const, blockers: waits.map((b) => ({ id: b.id, state: b.state, owner: null as string | null, file: null as string | null })), since: null as string | null, ageMs: null as number | null }] : [];
    }),
  ];
  const reviewRequests = facts.reviewRequests.map((r) => ({
    id: r.id, task: r.item, head: r.head, state: r.state, reviewer: actorOf(r.dispatch), claimedBy: r.claimedBy, runner: r.runner,
    requestedAt: r.dispatch.at ?? null, ageMs: ageMs(r.dispatch.at, now), claimedAt: r.claimedAt, ...(r.tier ? { tier: true } : {}),
  }));
  const runners = runnersOf(input);
  const landings = {
    lease: facts.landingLease ? { task: facts.landingLease.item, holder: facts.landingLease.holder, since: facts.landingLease.at, renewedAt: facts.landingLease.renewedAt ?? null } : null,
    queued: facts.landJobs.map((j) => ({ task: j.item, by: j.by, at: j.at, ageMs: ageMs(j.at, now) })),
    records: Object.entries(facts.landings).map(([task, r]) => ({ task, attempt: r.attempt, step: r.step, failedStep: r.failedStep, head: r.head, at: r.at })),
  };
  const blocks = items.filter((i) => i.state === "blocked" && i.blocked).map((i) => ({
    task: i.id, reason: i.blocked!.reason, by: i.blocked!.by, since: i.blocked!.at, ageMs: ageMs(i.blocked!.at, now),
    until: i.blocked!.until ?? null, fact: i.blocked!.fact ?? null, ...blockLift(i.id, i.blocked!),
  }));
  const policy = facts.project.policy ?? {};
  const limits: CheckLimits & { checks: string[]; mode: string; modeLine: string } = {
    ...checkLimits(policy), checks: [...(policy.checks ?? [])], mode: facts.mode.mode, modeLine: facts.mode.line,
  };
  const disk = input.disk && input.disk.totalBytes > 0
    ? { ...input.disk, freePercent: Math.round((input.disk.freeBytes / input.disk.totalBytes) * 1000) / 10, warning: input.disk.freeBytes / input.disk.totalBytes < DISK_WARN_PERCENT / 100 }
    : null;
  return {
    project, observedAt: now.toISOString(),
    server: { commit: input.commit, disk },
    tasks, holds, reviewRequests, runners, landings, blocks, limits,
    standing: facts.standing.map((d) => ({ id: d.id, text: d.text, quote: d.quote, by: d.by, at: d.at, ...(d.acting ? { acting: d.acting } : {}) })),
    // Spend is recorded per run once runners report it (G21); none is
    // recorded for any task yet, so the list is empty, never guessed.
    spend: [] as { task: string; model: string; costUsd: number | null; tokens: number | null }[],
    // A source that could not be read, said, so nothing missing reads as nothing there.
    unavailable: [...(input.offers === null ? ["runner offers"] : []), ...(input.tokens === null ? ["runner tokens"] : []), ...(input.disk === null ? ["free disk"] : [])],
  };
}

export type Situation = ReturnType<typeof situationOf>;

// The runners that serve this project: every offer whose projects include
// one of its names (or that names none), and every live runner token scoped
// to it that has never polled ("never").
function runnersOf({ facts, offers, tokens, names, commit, now }: SituationInput) {
  const serving = (offers ?? []).filter((o) => names.some((n) => servesProject(o, n)));
  const jobs = (runner: string) => [
    ...facts.items.filter((i) => i.runner && i.owner && i.state === "claimed" && i.runner.toLowerCase() === runner.toLowerCase()).map((i) => ({ task: i.id, job: i.dispatch?.job ?? "build", actor: i.owner })),
    ...facts.reviewRequests.filter((r) => r.state === "claimed" && r.runner?.toLowerCase() === runner.toLowerCase()).map((r) => ({ task: r.item, job: "review", actor: r.claimedBy })),
  ];
  const seen = serving.map((o) => {
    const silentMs = ageMs(o.at, now);
    const own = o.commit ?? null;
    return {
      runner: o.runner, lastPoll: o.at, silentMs, silent: silentMs !== null && silentMs > RUNNER_SILENT_MS + OFFER_REFRESH_MS, never: false,
      currentJobs: jobs(o.runner), projects: o.projects ?? null, models: o.agents.flatMap((a) => a.models.map((m) => `${a.agent}/${m}`)), jobs: o.jobs ?? [],
      commit: own, otherCommit: !!own && !!commit && own !== commit,
    };
  });
  const known = new Set(seen.map((r) => r.runner.toLowerCase()));
  const never = (tokens ?? [])
    .filter((t) => t.runner && !t.revokedAt && Date.parse(t.expiresAt) > now.getTime() && (!t.projects || names.some((n) => t.projects!.includes(n))) && !known.has(t.runner.toLowerCase()))
    .map((t) => t.runner!.toLowerCase())
    .filter((r, i, all) => all.indexOf(r) === i)
    .map((runner) => ({ runner, lastPoll: null, silentMs: null, silent: true, never: true, currentJobs: jobs(runner), projects: null, models: [] as string[], jobs: [] as string[], commit: null, otherCommit: false }));
  return [...seen, ...never].sort((a, b) => a.runner.localeCompare(b.runner));
}

// The free disk where the server runs: the Node runtime gives a DISK
// binding over its data directory; a Worker has none.
export function diskOf(env: unknown): DiskFacts | null {
  const disk = (env as { DISK?: { read?: () => DiskFacts | null } }).DISK;
  try { return disk?.read?.() ?? null; } catch { return null; }
}
