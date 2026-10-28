// Diagnostics are observations only. Unknown data never establishes absence.
import type { Item } from "../rules.ts";
import type { Dispatch } from "../dispatch/rules.ts";
import type { LedgerEvent, LandingWorkflowRecord } from "../ledger.ts";
import { GAVE_UP, assign, coreHold, coreOrphans, liveOffers, OFFER_REFRESH_MS, orphanedBy, reportedSkips, RUNNER_GONE_MS, shellWord, type RunSkip, type RunnerPolls, type SeenOffer } from "../dispatch/rules.ts";
import { landingLeaseLapsed, type LandingLease } from "../landing-lease.ts";
import type { RunReport } from "../models/reliability.ts";
import { SIZE_FIX, SIZE_REFUSED } from "../large-diff.ts";
import { inScope } from "../tokens.ts";
import { stalledForks } from "./forks.ts";
import { detectStuck, holdStart, pushObservedAt } from "./rules.ts";

export const REPORT_DEFAULTS = { noPushHours: 6, unansweredHours: 24, leaseWaitMinutes: 30, conflictWaitMinutes: 30, coreHoldMinutes: 30, runnerPollMinutes: RUNNER_GONE_MS / 60_000, reviewAnswerHours: 2 };
const IDLE_RUNNER_MAX_MS = 48 * 3_600_000;
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
export interface RequestObservation { id: number; item: string; head: string; dispatch: Dispatch; stopped?: { at: string; text: string } }
// How long an open review request may name a reviewer no live runner offers
// before it is reported (t220).
export const REVIEW_OFFER_MINUTES = 15;
export interface Snapshot {
  items: Item[]; events: LedgerEvent[]; coreFiles?: string[]; lease: LandingLease | null;
  workflows: { item: string; record: LandingWorkflowRecord; status?: string }[];
  reviews: ReviewObservation[]; openReviewItems?: string[]; runSkips?: (RunSkip & { item: string })[]; openRequests?: RequestObservation[];
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
    for (const f of stalledForks(live, events, now))
      add("fork-stalled", f.item, `no fork became ready after the tick replaced it: ${f.forks.map((k) => `${k.name} (${Math.floor(k.ageMs / 60_000)} min)`).join(", ")}`, f.since,
        `request a fresh fork: ${command(`release ${f.item} --note "Fresh fork after the replacements stalled"`)}, then claim it again with ${command(`start ${f.item} --as H/M`)}; the release starts the count of replacement forks again, the task keeps its history, and Atelier deletes no repository`);
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
    // An open request whose reviewer no live runner offers for the review job
    // is claimed by no one, however long it waits, and holds the landing.
    // Unknown offers prove nothing, so none are reported without them.
    if (offers) for (const r of snapshot.openRequests ?? []) {
      const item = live.find((i) => i.id === r.item);
      const reviewer = r.dispatch.agent && r.dispatch.model ? `${r.dispatch.agent}/${r.dispatch.model}` : null;
      if (!item || !reviewer || age(r.dispatch.at) <= REVIEW_OFFER_MINUTES * 60_000) continue;
      if (liveOffers(offers, now).some((offer) => names.some((n) => assign(r.dispatch, offer, n) !== null))) continue;
      add("review-unoffered", r.item, `review request ${r.id} asks ${reviewer}, which no live runner offers for the review job`, r.dispatch.at,
        `reroute to a reviewer a live runner offers, of another family than the task's contributors: ${command(`review-request ${r.item} --reviewer H/M`)}; or withdraw it: ${command(`review-withdraw ${r.item} --request ${r.id} --reason "No live runner offers ${reviewer}"`)}`, `${origin}/api/runners`);
    }
    // An open request that carries a stop (t238) was released without a
    // verdict twice at this head: no runner serves it, so it waits on a
    // decision the developer must make. The stop is read from the live
    // request, which every release carries it to.
    for (const r of snapshot.openRequests ?? []) {
      if (!r.stopped || !live.some((i) => i.id === r.item)) continue;
      add("review-skipped", r.item, `review request ${r.id}: ${r.stopped.text}`, r.stopped.at || r.dispatch.at,
        `decide, then act: ${command(`review-request ${r.item} --reviewer H/M`)} asks another reviewer; ${command(`review-withdraw ${r.item} --request ${r.id} --reason "Reviewer stopped without a verdict"`)} withdraws it`);
    }
    // A runner that skipped an open request for its own reason recorded a
    // review.skipped event naming it; the report says that reason as it is.
    for (const r of snapshot.openRequests ?? []) {
      if (!live.some((i) => i.id === r.item)) continue;
      for (const e of events) {
        if (e.kind !== "review.skipped" || e.itemId !== r.item || e.data.request !== r.id) continue;
        const note = typeof e.data.note === "string" && e.data.note ? `: ${e.data.note}` : "";
        add("review-skipped", r.item, `review request ${r.id} was skipped by ${String(e.data.runner ?? "a runner")}${note}`, e.at,
          `re-ask another reviewer of another family than the task's contributors: ${command(`review-request ${r.item} --reviewer H/M`)}; or withdraw it: ${command(`review-withdraw ${r.item} --request ${r.id} --reason "Reviewer stopped without a verdict"`)}`);
      }
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
    // A task a live runner gave up after its failed runs or infrastructure
    // failures passes by that runner until it is dispatched again or its head
    // changes; the runner's own log was the only other place that said so (t281).
    for (const item of waiting) {
      const skips = reportedSkips((snapshot.runSkips ?? []).filter((s) => s.item === item.id), item, offers, now);
      if (!skips.length) continue;
      const said = (k: RunSkip) => k.kind === "skipped" ? `skipped by ${k.runner}${k.note ? `: ${k.note}` : ""}`
        : `skipped by ${k.runner} after ${k.failures} ${k.kind === "infrastructure" ? "infrastructure failures in a row" : "failed runs"}${k.note ? ` (the last: ${k.note})` : ""}`;
      add("runner-skip", item.id, skips.map(said).join("; "), skips.map((k) => k.at).sort()[0],
        `fix the cause, then ${command(redispatch(item, false))}; a push to the task's head clears the skip too`);
    }
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
    // A harness that refused a review's input for its size is not retried as
    // it is (t230); the release stays until the review is asked for again.
    for (const item of live.filter((i) => !["merged", "abandoned", "accepted"].includes(i.state))) {
      const mine = ordered.filter((e) => e.itemId === item.id && e.kind.startsWith("review."));
      const refused = mine.filter((e) => e.kind === "review.released" && typeof e.data.note === "string" && e.data.note.includes(SIZE_REFUSED)).pop();
      if (!refused || mine.some((e) => e.seq > refused.seq && ["review.requested", "review.withdrawn", "review.claimed"].includes(e.kind))) continue;
      add("review-input-size", item.id, String(refused.data.note), refused.at, `${SIZE_FIX}; then ${command(`review-request ${item.id} --reviewer H/M`)}`);
    }
    for (const run of runs ?? []) {
      if (run.project !== project || !run.item || run.runner === "owner") continue;
      if (run.role === "review" && !snapshot.openReviewItems?.includes(run.item) && !reviews.some((r) => r.item === run.item && items.some((i) => i.id === r.item && i.head === r.head))) continue;
      const item = live.find((i) => i.id === run.item && !["merged", "abandoned", "accepted"].includes(i.state));
      // A report from before the task was created belongs to an earlier task of that id.
      if (!item || Date.parse(run.at) < Date.parse(item.createdAt) || events.some((e) => e.itemId === run.item && Date.parse(e.at) >= Date.parse(run.at) && ["item.claimed", "item.handoff", "push.observed", "item.submitted", "item.dispatched", "review.claimed", "review.approved", "review.rejected"].includes(e.kind))) continue;
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
    // A runner not polled for IDLE_RUNNER_MAX_MS is gone, not idle: nothing to restart.
    if (age(offer.at) > IDLE_RUNNER_MAX_MS) continue;
    if (age(offer.at) - OFFER_REFRESH_MS > limits.runnerPollMinutes * 60_000)
      add("idle-runner", offer.runner, "no active job; last poll exceeds limit including timestamp coarsening", offer.at, `atelier runner --name ${JSON.stringify(offer.runner)} --once`, `${origin}/api/runners`);
  }
  const dedup = new Map<string, Entry>();
  for (const entry of entries.sort((a, b) => a.since.localeCompare(b.since) || a.reason.localeCompare(b.reason))) dedup.set(`${entry.kind}:${entry.subject}:${["task", "review", "review-unoffered", "review-skipped"].includes(entry.kind) ? entry.reason : ""}`, entry);
  return { project, observedAt: now.toISOString(), limits, complete: snapshot !== null && offers !== null && runs !== null && activeRunners !== null && unavailable.length === 0, unavailable: [...new Set(unavailable)].sort(), entries: [...dedup.values()].sort((a, b) => a.since.localeCompare(b.since) || a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject)), failedChecksLastDay: snapshot ? checks : null };
}
