// Diagnostics are observations only. Unknown data never establishes absence.
import type { Item } from "../rules.ts";
import type { LedgerEvent, LandingWorkflowRecord } from "../ledger.ts";
import { GAVE_UP, coreHold, coreOrphans, OFFER_REFRESH_MS, orphanedBy, RUNNER_GONE_MS, shellWord, type RunnerPolls, type SeenOffer } from "../dispatch/rules.ts";
import { landingLeaseLapsed, type LandingLease } from "../landing-lease.ts";
import type { RunReport } from "../models/reliability.ts";
import { inScope } from "../tokens.ts";
import { detectStuck, holdStart, pushObservedAt } from "./rules.ts";

export const REPORT_DEFAULTS = { noPushHours: 6, unansweredHours: 24, leaseWaitMinutes: 30, conflictWaitMinutes: 30, coreHoldMinutes: 30, runnerPollMinutes: RUNNER_GONE_MS / 60_000, reviewAnswerHours: 2 };
export type ReportLimits = typeof REPORT_DEFAULTS;
export function reportLimits(values: Record<string, unknown> = {}): ReportLimits {
  const limits = { ...REPORT_DEFAULTS };
  for (const key of Object.keys(limits) as (keyof ReportLimits)[]) {
    if (values[key] === undefined) continue;
    const value = Number(values[key]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive finite number`);
    limits[key] = value;
  }
  return limits;
}
export interface ReviewObservation { id: number; item: string; head: string; claimedBy: string; claimedAt: string; runner: string | null }
export interface Snapshot {
  items: Item[]; events: LedgerEvent[]; coreFiles?: string[]; lease: LandingLease | null;
  workflows: { item: string; record: LandingWorkflowRecord; status?: string }[];
  reviews: ReviewObservation[]; openReviewItems?: string[];
}
export interface Entry { kind: string; subject: string; reason: string; since: string; ageMs: number; evidence: string; recovery: string }
export function stuckReport(project: string, origin: string, now: Date, limits: ReportLimits, snapshot: Snapshot | null,
  offers: SeenOffer[] | null, runs: RunReport[] | null, activeRunners: string[] | null, unavailable: string[] = [], names: string[] = [project]) {
  const entries: Entry[] = [], checks: Entry[] = [];
  const time = now.getTime(), age = (at: string) => time - Date.parse(at);
  const base = `${origin}/p/${encodeURIComponent(project)}`;
  // Recovery is shell text: preserve literal notes, including quotes and $.
  const quote = (value: string) => /^[a-zA-Z0-9_./:@+-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const redispatch = (item: Item, overlapOk: boolean) => {
    const d = item.dispatch;
    if (!d) return `dispatch ${item.id}`;
    const flags = [`dispatch ${item.id}`, `--to ${quote(d.to)}`];
    if (d.agent !== null) flags.push(`--agent ${quote(d.agent)}`);
    if (d.model !== null) flags.push(`--model ${quote(d.model)}`);
    flags.push(`--note ${quote(d.note)}`);
    if (d.job === "merge-main") {
      flags.push("--job merge-main");
      if (d.head) flags.push(`--head ${quote(d.head)}`);
    }
    return `${flags.join(" ")}${overlapOk ? " --overlap-ok" : ""}`;
  };
  const heldDispatch = (item: Item) => redispatch(item, true);
  const projectFlag = `--project ${shellWord(project)}`;
  const command = (cmd: string) => `atelier ${cmd} ${projectFlag}`;
  const add = (kind: string, subject: string, reason: string, since: string, recovery: string, evidence = `${base}/${subject}`) => {
    entries.push({ kind, subject, reason, since, ageMs: age(since), evidence, recovery });
  };
  // The runners' last polls, as /api/runners records them, judge a claim
  // orphaned by its runner (t537): it holds no dispatch, so no core hold is
  // reported against it, and it is reported itself. The judgement is the
  // ledger's own, at RUNNER_GONE_MS: --runner-poll-minutes sets only the
  // idle-runner limit, so the report never calls a claim orphaned that
  // still holds, or the reverse.
  const runners: RunnerPolls | null = offers ? { polls: offers } : null;
  if (snapshot) {
    const { items, events, lease, workflows, reviews } = snapshot;
    const live = items.filter((i) => i.state !== "blocked");
    const requeue = (id: string) => {
      const item = live.find((i) => i.id === id);
      if (!item?.kind) return command(`dispatch ${id}`);
      // Plans own their routing; ordinary dispatch is refused for a plan or part.
      const retry = command(`plan retry ${id}`);
      if (item.state === "open") return retry;
      const release = command(`release ${id} --note "Requeue stuck work after checking with its holder"`);
      return item.state === "accepted" && item.owner
        ? `${command(`handoff ${id} --to ${item.owner}`)}; ${release}; ${retry}`
        : `${release}; ${retry}`;
    };
    for (const f of detectStuck(live, events, now, limits))
      add("task", f.itemId, f.reason, f.since, f.suggestion === "hand off"
        ? `hand off: choose the next agent H/M, then ${command(`handoff ${f.itemId} --to H/M`)}`
        : `check in with the holder${f.owner ? ` (${f.owner})` : ""}: inspect ${command(`show ${f.itemId} --reviews`)} and contact them before handing the task to another agent`);
    for (const w of workflows) {
      if (!live.some((i) => i.id === w.item && i.state !== "merged" && i.state !== "abandoned")) continue;
      if (w.record.stage === "conflict" && !["complete", "errored", "terminated", "absent"].includes(w.status ?? "") && age(w.record.stageAt) > limits.conflictWaitMinutes * 60_000)
        add("workflow-conflict", w.item, `Workflow ${w.record.instance} paused at conflict; status ${w.status ?? "indeterminate"}${w.record.files?.length ? `; files: ${w.record.files.join(", ")}` : ""}`, w.record.stageAt, `Resolve and commit the conflicts in the task workspace, then ${command(`land ${w.item} --workflow`)}`);
      if (w.record.stage === "lease" && !["complete", "errored", "terminated", "absent"].includes(w.status ?? "") && age(w.record.stageAt) > limits.leaseWaitMinutes * 60_000)
        add("lease-wait", w.item, `Workflow ${w.record.instance} waiting for lease; status ${w.status ?? "indeterminate"}`, w.record.stageAt, command(`land ${w.item} --workflow`));
    }
    if (lease && !landingLeaseLapsed(lease, time)) {
      const item = items.find((i) => i.id === lease.item);
      const workflow = workflows.find((w) => w.item === lease.item);
      // No remembered Workflow means a CLI landing, not an absent holder.
      const closed = !item || ["merged", "abandoned"].includes(item.state);
      // A terminal old Workflow does not establish who holds a newer CLI lease.
      const terminal = workflow && Date.parse(workflow.record.stageAt) >= Date.parse(lease.at)
        && ["complete", "errored", "terminated", "absent"].includes(workflow.status ?? "");
      if (item?.state !== "blocked" && (closed || terminal))
        add("orphan-lease", lease.item, "unexpired lease with positively absent or terminal holder", lease.renewedAt ?? lease.at, command(`land ${lease.item} --release-lease`));
    }
    // A claim ages from when it began. Renewals rewrite claimedAt every 30 s,
    // so the start is the review.claimed event naming this request: the id is
    // the claim generation, and a re-claim after expiry is a new request.
    // Without that event, the last renewal is the only bound known.
    const claimStart = (r: ReviewObservation) => events.find((e) => e.kind === "review.claimed" && e.itemId === r.item && e.data.request === r.id)?.at ?? r.claimedAt;
    for (const r of reviews) {
      const item = live.find((i) => i.id === r.item && i.head === r.head && !["merged", "abandoned"].includes(i.state));
      const since = claimStart(r);
      if (item && age(since) > limits.reviewAnswerHours * 3_600_000)
        add("review", r.item, `review request ${r.id} claimed by ${r.claimedBy}`, since, `${command(`review-release ${r.item} --note "Release stalled review claim"`)} --as ${r.claimedBy}`);
    }
    for (const item of live.filter((i) => i.state === "open" && i.dispatch)) {
      // Since t473 a submitted blocker holds only while the landing lease names it.
      const held = coreHold(item, live, snapshot.coreFiles, lease, time, runners);
      const blocker = held && live.find((i) => i.id === held.id);
      if (!blocker) continue;
      const hold = holdStart(blocker, events), push = pushObservedAt(blocker, events);
      const since = push && push > hold ? push : hold;
      // Plain land refuses accepted tasks: their next step is the merge.
      const landing = command(`${blocker.state === "accepted" ? "merge" : "land"} ${blocker.id}`);
      if (age(since) > limits.coreHoldMinutes * 60_000)
        add("core-hold", item.id, `dispatch held by ${blocker.id} (${held!.core})`, since, `Land the blocker with ${landing}; or, if the overlap is harmless, ${command(heldDispatch(item))}`, `${base}/${blocker.id}`);
    }
    const waiting = live.filter((i) => i.state === "open" && i.dispatch);
    for (const item of live) {
      const gone = orphanedBy(item, runners, time);
      if (!gone) continue;
      const freed = waiting.filter((w) => coreOrphans(w, [item], snapshot.coreFiles, lease, time, runners).length).map((w) => w.id);
      // Dispatching it again releases the claim; a part is the plan's to route.
      const recovery = item.kind ? requeue(item.id) : command(redispatch(item, false));
      add("orphaned-claim", item.id, `claim by ${item.owner ?? "no one"} orphaned by its runner ${gone.runner}, which last polled at ${gone.lastPoll}${freed.length ? `; it no longer holds ${freed.join(", ")}` : ""}`, gone.lastPoll, recovery, `${origin}/api/runners`);
    }
    const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
    for (const e of ordered) {
      if (!e.itemId || e.kind !== "evidence.observed" || e.data.passed !== false || age(e.at) < 0 || age(e.at) >= 86_400_000) continue;
      checks.push({ kind: "check", subject: e.itemId ?? "project", reason: `failed observed command: ${String(e.data.claim ?? "unnamed command")} at ${String(e.data.head ?? "unknown head")}`, since: e.at, ageMs: age(e.at), evidence: `${base}/${e.itemId}`, recovery: command(`check ${e.itemId}`) });
    }
    // A release without a push during that attempt is a runner give-up, and so
    // is a release whose note says the runner gave up (t584), which comes after
    // the push of what it had committed.
    for (const item of live.filter((i) => !["merged", "abandoned", "accepted"].includes(i.state))) {
      const mine = ordered.filter((e) => e.itemId === item.id);
      const release = mine.filter((e) => e.kind === "item.released" || e.kind === "item.gave_up").pop();
      if (!release) continue;
      const claim = mine.filter((e) => ["item.claimed", "item.handoff"].includes(e.kind) && e.seq < release.seq).pop();
      if (!claim?.data.runner || mine.some((e) => e.seq > release.seq && ["item.claimed", "item.handoff", "push.observed", "item.submitted", "item.dispatched"].includes(e.kind))) continue;
      const said = typeof release.data.note !== "string" ? null : release.kind === "item.gave_up" ? release.data.note : release.data.note.startsWith(GAVE_UP) ? release.data.note.slice(GAVE_UP.length) : null;
      if (said === null && mine.some((e) => e.seq > claim.seq && e.seq < release.seq && e.kind === "push.observed")) continue;
      add("runner-give-up", item.id, said === null ? `runner ${claim.data.runner} released without a push` : `runner ${claim.data.runner} gave it up: ${said}`, release.at, requeue(item.id), `${base}/${item.id}`);
    }
    for (const run of runs ?? []) {
      if (run.project !== project || !run.item || run.runner === "owner") continue;
      if (run.role === "review" && !snapshot.openReviewItems?.includes(run.item) && !reviews.some((r) => r.item === run.item && items.some((i) => i.id === r.item && i.head === r.head))) continue;
      const item = live.find((i) => i.id === run.item && !["merged", "abandoned", "accepted"].includes(i.state));
      if (!item || events.some((e) => e.itemId === run.item && Date.parse(e.at) >= Date.parse(run.at) && ["item.claimed", "item.handoff", "push.observed", "item.submitted", "item.dispatched", "review.claimed", "review.approved", "review.rejected"].includes(e.kind))) continue;
      if ((activeRunners ?? []).includes(run.runner)) continue;
      add("runner-give-up", item.id, `${run.runner}: ${run.role} run ${run.outcome}`, run.at, requeue(item.id), `${origin}/api/runs`);
    }
  }
  // Active jobs across projects are required before concluding a runner is idle.
  // A runner whose token serves other projects is no idle runner of this one (t669).
  if (offers && activeRunners) for (const offer of offers) {
    // An offer lists a project by the name it had when the runner last polled.
    if (!inScope({ projects: offer.projects }, names)) continue;
    if (activeRunners.includes(offer.runner)) continue;
    if (age(offer.at) - OFFER_REFRESH_MS > limits.runnerPollMinutes * 60_000)
      add("idle-runner", offer.runner, "no active job; last poll exceeds limit including timestamp coarsening", offer.at, `atelier runner --name ${JSON.stringify(offer.runner)} --once`, `${origin}/api/runners`);
  }
  const dedup = new Map<string, Entry>();
  for (const entry of entries.sort((a, b) => a.since.localeCompare(b.since) || a.reason.localeCompare(b.reason))) dedup.set(`${entry.kind}:${entry.subject}:${["task", "review"].includes(entry.kind) ? entry.reason : ""}`, entry);
  return { project, observedAt: now.toISOString(), limits, complete: snapshot !== null && offers !== null && runs !== null && activeRunners !== null && unavailable.length === 0, unavailable: [...new Set(unavailable)].sort(), entries: [...dedup.values()].sort((a, b) => a.since.localeCompare(b.since) || a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject)), failedChecksLastDay: snapshot ? checks : null };
}
