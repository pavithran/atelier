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
import { redactKeys } from "./models/pool.ts";
import type { RunReport } from "./models/reliability.ts";
import { cleanRunFacts } from "./run-facts.ts";
import { toolName } from "./tool-names.ts";
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
// A running build whose progress has not changed for this long while no
// child process of its model is alive is flagged as a stall (G21, miqra's
// rule); one that has completed no command this long after it started, as
// stuck at its start (the launchd privacy prompt that hangs claude -p).
export const STALL_MS = 30 * 60_000;
export const STARTUP_MS = 5 * 60_000;

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
  // Each listed task's progress line as its runner last reported it (G21).
  progress?: Record<string, ProgressRecord>;
}

// A build's progress as the runner reports it with its poll (cli/progress.mjs)
// and the Ledger keeps it (Ledger.recordProgress): the runner's figures, the
// time the server received them and the time they last changed, and the
// spend of each run of the task.
export interface ProgressRecord {
  task: string; actor: string; runner: string;
  log?: string | null;
  attempt?: number; // Optional for records written before attempt numbering.
  // The harness, and whether it reports commands (only Claude Code's
  // stream-json log does); without telemetry the command counts are unknown.
  harness: string | null; telemetry: boolean;
  startedAt: string; endedAt: string | null; at: string;
  commands: { started: number; completed: number };
  current: { name: string; summary: string | null; since: string } | null;
  last: { name: string; summary: string | null; at: string; error: boolean } | null;
  childAlive: boolean | null;
  commits: number; changedFiles: number; logBytes: number;
  tokens: number | null; costUsd: number | null; parts?: TokenParts;
  receivedAt: string; changedAt: string;
  runs: { actor: string; startedAt: string; costUsd: number | null; tokens: number | null; parts?: TokenParts }[];
}

// A run's tokens by kind, as the weights need them.
export interface TokenParts { input: number; cacheWrite: number; cacheRead: number; output: number }
const RUNS_KEPT = 20;
// Apart from the bounded log path, no free text a runner reports is kept: the actor must be a harness/model
// name, a tool a bare tool name, a command its program's name; anything
// else in their place is dropped, never stored or shown.
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// A step's tool is kept by name only if it is a known tool's (src/tool-names.ts), else as "tool".
const tool = (v: unknown): string | null => typeof v === "string" ? toolName(v) : null;
// A command is kept as its program's name alone (npm, git), never its
// arguments; anything else a runner sends in its place is dropped.
// The shared redactor runs over it too, as a second line of defence.
const program = (v: unknown): string | null => typeof v === "string" && /^[A-Za-z0-9._+-]{1,40}$/.test(v) && redactKeys(v) === v ? v : null;
const time = (v: unknown): string | null => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const count = (v: unknown): number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e9 ? v : 0;
const amount = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e6 ? v : null;

// The runner's four usage counts, each bounded like count(); absent unless it sent them as an object.
const partsOf = (v: unknown): TokenParts | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  return { input: count(p.input_tokens), cacheWrite: count(p.cache_creation_input_tokens), cacheRead: count(p.cache_read_input_tokens), output: count(p.output_tokens) };
};

// One report from a runner's poll, checked and bounded, or null when it is not
// one: a task id, an actor and a start time are required.
export function parseProgress(raw: unknown): Omit<ProgressRecord, "runner" | "receivedAt" | "changedAt" | "runs"> | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const task = typeof r.task === "string" && /^t[1-9][0-9]*$/.test(r.task) ? r.task : null;
  const actor = typeof r.actor === "string" && ACTOR.test(r.actor) ? r.actor : null, startedAt = time(r.startedAt);
  if (!task || !actor || !startedAt) return null;
  const c = (r.commands ?? {}) as Record<string, unknown>, cur = r.current as Record<string, unknown> | null, last = r.last as Record<string, unknown> | null;
  return {
    task, actor, log: cleanRunFacts({ log: r.log })?.log ?? null, harness: program(r.harness), telemetry: r.telemetry !== false, startedAt, endedAt: time(r.endedAt), at: time(r.at) ?? startedAt,
    commands: { started: count(c.started), completed: count(c.completed) },
    current: cur && typeof cur === "object" && tool(cur.name) ? { name: tool(cur.name)!, summary: program(cur.summary), since: time(cur.since) ?? startedAt } : null,
    last: last && typeof last === "object" && tool(last.name) ? { name: tool(last.name)!, summary: program(last.summary), at: time(last.at) ?? startedAt, error: last.error === true } : null,
    childAlive: typeof r.childAlive === "boolean" ? r.childAlive : null,
    commits: count(r.commits), changedFiles: count(r.changedFiles), logBytes: count(r.logBytes),
    tokens: amount(r.tokens), costUsd: amount(r.costUsd), ...(partsOf(r.parts) ? { parts: partsOf(r.parts) } : {}),
  };
}

// The record kept after a report: what changed is dated now, and the run's
// spend is kept beside earlier runs' (by start time, newest RUNS_KEPT).
export function nextProgress(prev: ProgressRecord | null, report: NonNullable<ReturnType<typeof parseProgress>>, runner: string, now: string): ProgressRecord {
  const sig = (p: Pick<ProgressRecord, "commands" | "commits" | "changedFiles" | "logBytes" | "current" | "endedAt">) => JSON.stringify([p.commands, p.commits, p.changedFiles, p.logBytes, p.current?.name ?? null, p.current?.since ?? null, p.endedAt]);
  const same = !!prev && prev.startedAt === report.startedAt && sig(prev) === sig(report);
  const runs = [...(prev?.runs ?? []).filter((x) => x.startedAt !== report.startedAt), { actor: report.actor, startedAt: report.startedAt, costUsd: report.costUsd, tokens: report.tokens, ...(report.parts ? { parts: report.parts } : {}) }]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-RUNS_KEPT);
  const attempt = prev ? (prev.attempt ?? prev.runs.length) + (prev.startedAt === report.startedAt ? 0 : 1) : 1;
  return { ...report, runner, attempt, receivedAt: now, changedAt: same ? prev!.changedAt : now, runs };
}

// How a progress record reads now: its figures, its ages and the stall it shows.
export function progressView(p: ProgressRecord, now: Date) {
  const ended = !!p.endedAt;
  const quietMs = ageMs(p.changedAt, now) ?? 0;
  const runMs = Math.max(0, (ended ? Date.parse(p.endedAt!) : now.getTime()) - Date.parse(p.startedAt));
  const stall = ended ? null
    : p.telemetry !== false && p.commands.completed === 0 && runMs >= STARTUP_MS ? `no command completed in ${Math.floor(runMs / 60_000)} minutes since the build started`
    : quietMs >= STALL_MS && p.childAlive === false ? `no change in ${Math.floor(quietMs / 60_000)} minutes and no child process alive`
    : null;
  return {
    task: p.task, actor: p.actor, runner: p.runner, log: p.log ?? null, attempt: p.attempt ?? p.runs.length, startedAt: p.startedAt, endedAt: p.endedAt, ended,
    harness: p.harness ?? null, telemetry: p.telemetry !== false,
    commands: p.telemetry === false ? null : p.commands, commits: p.commits, changedFiles: p.changedFiles,
    current: p.current && !ended ? { ...p.current, ageMs: ageMs(p.current.since, now) } : null,
    last: p.last, childAlive: ended ? false : p.childAlive,
    elapsedMs: runMs, tokens: p.tokens, costUsd: p.costUsd, logBytes: p.logBytes,
    reportedAt: p.receivedAt, reportedAgoMs: ageMs(p.receivedAt, now), changedAt: p.changedAt, quietMs,
    stall,
  };
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
  // Each listed task's newest run report (the index's), whose output stays
  // in a log on the runner's host: its facts and where that log is.
  runs?: Record<string, RunReport | undefined>;
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
      progress: facts.progress?.[i.id] ? progressView(facts.progress[i.id], now) : null,
      lastRun: lastRunOf(input.runs?.[i.id]),
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
  // The checks every task needs, and the runs the deploy gate needs beside
  // them (atelier ship: policy.shipRuns), so a gap shows before a deploy.
  const limits: CheckLimits & { checks: string[]; deployGate: string[]; mode: string; modeLine: string } = {
    ...checkLimits(policy), checks: [...(policy.checks ?? [])], deployGate: [...(policy.shipRuns ?? [])], mode: facts.mode.mode, modeLine: facts.mode.line,
  };
  const disk = input.disk && input.disk.totalBytes > 0
    ? { ...input.disk, freePercent: Math.round((input.disk.freeBytes / input.disk.totalBytes) * 1000) / 10, warning: input.disk.freeBytes / input.disk.totalBytes < DISK_WARN_PERCENT / 100 }
    : null;
  return {
    project, observedAt: now.toISOString(),
    server: { commit: input.commit, disk },
    tasks, holds, reviewRequests, runners, landings, blocks, limits,
    standing: facts.standing.filter((d) => !d.standing).map((d) => ({ id: d.id, text: d.text, quote: d.quote, by: d.by, at: d.at, ...(d.acting ? { acting: d.acting } : {}) })),
    // The standing instructions the developer recorded (G6, atelier decide
    // --standing KEY VALUE), each with whether its mode permits it to act.
    // dispatch-on-criteria acts in either mode. A session withdraws one
    // with atelier decisions withdraw ID.
    standingInstructions: facts.standing.filter((d) => d.standing).map((d) => ({
      id: d.id, key: d.standing!.key, value: d.standing!.value, acts: d.standing!.key === "dispatch-on-criteria" || facts.mode.mode === "fast", quote: d.quote, by: d.by, at: d.at, ...(d.acting ? { acting: d.acting } : {}),
    })),
    // What each task's runs cost per model, as the runners reported it from
    // the builder's log (G21); a run that reported none is null, never guessed.
    spend: spendOf(facts),
    // Running builds whose progress shows a stall (G21), with the rule met.
    stalls: tasks.flatMap((t) => t.progress?.stall ? [{ task: t.id, reason: t.progress.stall, runner: t.progress.runner, childAlive: t.progress.childAlive }] : []),
    // A source that could not be read, said, so nothing missing reads as nothing there.
    unavailable: [...(input.offers === null ? ["runner offers"] : []), ...(input.tokens === null ? ["runner tokens"] : []), ...(input.disk === null ? ["free disk"] : [])],
  };
}

export type Situation = ReturnType<typeof situationOf>;

// A run report as situation and show give it: what ended, when, on which
// runner, and its facts, with the log's host and path; never its output.
export function lastRunOf(r: RunReport | null | undefined) {
  if (!r) return null;
  const f = cleanRunFacts(r.facts);
  return { outcome: r.outcome, role: r.role, actor: r.actor, runner: r.runner, at: r.at, exitCode: f?.exitCode ?? null, signal: f?.signal ?? null, program: f?.program ?? null, lines: f?.lines ?? null, bytes: f?.bytes ?? null, log: f?.log ?? null, host: f?.host ?? null };
}

function spendOf(facts: SituationFacts) {
  const out: { task: string; model: string; runs: number; costUsd: number | null; tokens: number | null }[] = [];
  for (const [task, p] of Object.entries(facts.progress ?? {})) {
    const byModel = new Map<string, typeof out[number]>();
    for (const r of p.runs) {
      const row = byModel.get(r.actor) ?? { task, model: r.actor, runs: 0, costUsd: null, tokens: null };
      row.runs++;
      if (r.costUsd !== null) row.costUsd = (row.costUsd ?? 0) + r.costUsd;
      if (r.tokens !== null) row.tokens = (row.tokens ?? 0) + r.tokens;
      byModel.set(r.actor, row);
    }
    out.push(...byModel.values());
  }
  return out;
}

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
