// The landing pipeline as a Cloudflare Workflow (t280), behind the opt-in
// `atelier land ID --workflow`; `atelier land ID` without it runs the whole
// pipeline on the owner's Mac as before (cli/land.mjs, docs/landing.md).
//
// One instance lands one task. The steps the server can do alone are durable
// Workflow steps with retries: the wait for the required checks' observed
// results, the submission, the review request and the wait for its verdict, taking the
// project's landing lease (queueing for it in the order the landings asked,
// t249), the acceptance, and the watch for the merge. Each reads and writes the Ledger
// Durable Object directly, with no token, so an expired write token cannot
// end them, and each retries on its own when the Ledger or
// Artifacts fails it transiently (a 503). The verdict wait and the merge
// watch hibernate between polls, so a closed laptop costs nothing while
// they wait.
//
// Two kinds of step need Git with a working tree, which a Worker does not
// have, and stay on the machine that holds the task's workspace: merging
// main into the workspace (with the regenerate command and the route-level
// raise, t248) and pushing it, and the final merge into the registered
// checkout (`atelier merge`, which publishes to the baseline). The Workflow
// waits for them durably: it writes its stage to the Ledger
// (setLandingWorkflowStage), and `atelier land ID --workflow`, the executor,
// polls that stage, does the workspace steps when the stage is `workspace`
// and reports them as a `workspace` event, and runs `atelier merge` when the
// stage is `merge`. A merge of main that stops on conflicts is reported as
// such: the Workflow pauses at stage `conflict`, holding no lease, naming
// the files, until the owner resolves them and runs the command again,
// which sends a `resume` event; the Workflow then asks for the workspace
// steps again (a new round, since main may have moved while it waited).
//
// Review before the runway (t550): the lease is held for the merge alone.
// The workspace steps, the checks, the submission and the review all run
// without it, beside any other task's landing; a conflict, a failed check,
// a stopped triage or a rejection ends (or pauses) the landing with the
// lease never taken. Only once the gate holds the pushed head with its
// checks passing and an approval it counts does the Workflow queue for the
// lease (stage `lease`), and under it confirm that main is still the commit
// the executor merged; where main moved, it releases the lease without
// accepting and begins a new round from the merge of main. The server
// carries an approval over that merge, when the executor pushes it, only as
// far as the review-retention rule lets it (t56, retentionVerdict in
// src/rules.ts): a merge that leaves the task's files alone. The round's
// review step then finds the approval standing at the new head and asks for
// no review; any other merge asks for a new one.
// Each lease step records the time the round spent before the lease and in
// the queue, and each release step the time the lease was held.
//
// The required checks run on the machine holding the workspace: the
// executor runs them in a clean clone (`atelier check`, as the plain landing
// does) after it pushes and before it reports the head, and the server
// records each result as observed evidence at that head. The Workflow runs no
// container: it reads the Ledger until every required check has observed
// evidence at the exact pushed head, counted as the gate counts it
// (evidenceAt), so a report, a merged run or a run at another head never
// passes it. A failing result ends the landing; no result within the checks
// timeout ends it too. (Until t768 the landing could run them in a
// Cloudflare container instead; that mode is gone.)
//
// Each step is recorded as the same land.* events the CLI's own landing
// writes (t186): the Workflow records the lease, the checks, the
// submission, the review and the acceptance; the executor records the
// merge, the regeneration, the push and the merged head, which only it can
// know. The verdict is judged by src/landing-verdict.ts, which the CLI's
// landing uses too.

import { suggestionRecords } from "./models/suggestion-records.ts";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { baseRepoOf } from "./plans/integrate";
import { evidenceAt, parseRuleError, type Evidence } from "./rules";
import { WORKSPACE_REASON_MAX, effectiveFailures, failureDetail, resolveFailures } from "./check-failure.ts";
import { getLarge } from "./large.ts";
import { landingLeasePollMs, type LandingLease } from "./landing-lease.ts";
import { LANDING_LEASE_WAIT_LIMIT_MS, leaseTimeout } from "./landing/lease-wait.ts";
import { LANDING_DETAIL_MAX, type LandingWorkflowStage } from "./ledger.ts";
import { approvalsMissing, landingVerdict, allSkipped, recordedApproval, rejectionText, reviewStall, type RecordedDetail, type LandingReview, type LandingUnparsable, type ReviewStall } from "./landing-verdict.ts";
import { triageStandsRefusal, type TriageBinding, type TriageEvent } from "./review/triage.ts";
import { fenceText, type PrereviewFence } from "./dispatch/prereview.ts";
import { offersFor } from "./dispatch/rules.ts";
import type { Finding } from "./rules.ts";

// What the landing-workflow route passes when it creates the instance.
// `key` is the project's storage key; `actor` is the project owner;
// `origin` is the request's origin, so notifications link back as the
// route's own calls do. The timeouts default as the CLI's do and can be set
// per landing (the tests use small ones); `pollMs` paces every poll,
// `mergePollMs` the slower watch for the merge.
export interface LandingWorkflowParams {
  project: string;
  key: string;
  item: string;
  actor: string;
  reviewer?: string | null;
  noReview?: boolean;
  origin?: string;
  pollMs?: number;
  mergePollMs?: number;
  waitTimeoutMs?: number;
  workspaceTimeoutMs?: number;
  conflictTimeoutMs?: number;
  reviewTimeoutMs?: number;
  mergeTimeoutMs?: number;
  // `checksTimeoutMs` bounds the wait for the observed results of the
  // required checks (see the head of this file).
  checksTimeoutMs?: number;
  // The landing triages before its review (t475, src/review/triage.ts): the
  // executor triages the pushed head before it reports it, and reports the
  // binding the triage stands for; the Workflow submits, and asks for the
  // review, only while the Ledger holds a triage at that binding that lets
  // the landing go on, and the task's head and criteria are still those.
  triage?: boolean;
}

// What the executor reports for the workspace steps of one round: the head
// it pushed after merging main (and the main head it merged, for the
// submission's summary); or, with `conflict`, the files the merge of main
// stopped on, left in the workspace for the owner; or, with `failed`, that
// a workspace step stopped for another reason, with the CLI's message.
export interface WorkspaceReport {
  round: number;
  head?: string;
  mainHead?: string | null;
  mergedIn?: boolean;
  conflict?: boolean;
  files?: string[];
  failed?: boolean;
  reason?: string;
  // The triage's binding beside the head: the merge base and the criteria
  // hash the triage read (t475).
  triage?: { base?: string; criteria?: string } | null;
}

const DAY = 86_400_000;
// Five tries, 2, 4, 8 and 16 seconds apart: enough to outlast a brief 503
// from Artifacts or a Durable Object reset, short enough that a lasting
// fault ends the landing with its own message.
// The most reviews one landing asks (t143), as REVIEW_PASSES in cli/land.mjs.
const REVIEW_PASSES = 4;
const RETRIES = { retries: { limit: 5, delay: 2000, backoff: "exponential" as const }, timeout: "5 minutes" as const };
// The workspace and a conflict are waited for in chunks of this length
// (step.waitForEvent throws when its timeout passes, so each chunk is one
// wait whose timeout is caught); an event sent between chunks is buffered
// by the Workflow and answered by the next.
const EVENT_CHUNK_MS = 60 * 60_000;
// How long the Ledger may take to observe the head the executor says it
// pushed: the executor's push records the head before it reports, so this
// only bridges a slow answer.
const PUSH_SEEN_MS = 5 * 60_000;

// How many times main may move under the lease before the landing stops
// (t550), as the CLI's own landing bounds it: each time the lease is
// released and the head merged with main, checked and reviewed again.
const MAIN_MOVED_ROUNDS = 5;

const HASH = /^[a-f0-9]{40,64}$/;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : "—");
const span = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} seconds` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 3_600_000)} hours`;
const bounded = (v: unknown, def: number) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 30 * DAY ? (v as number) : def;

export class LandingWorkflow extends WorkflowEntrypoint<Env, LandingWorkflowParams> {
  async run(event: WorkflowEvent<LandingWorkflowParams>, step: WorkflowStep) {
    const raw = event.payload ?? ({} as LandingWorkflowParams);
    const p: Landing = {
      project: String(raw.project), key: String(raw.key ?? raw.project), item: String(raw.item), actor: String(raw.actor),
      instance: event.instanceId,
      reviewer: typeof raw.reviewer === "string" && raw.reviewer ? raw.reviewer : null,
      noReview: raw.noReview === true, origin: typeof raw.origin === "string" ? raw.origin : undefined,
      poll: bounded(raw.pollMs, 15_000), mergePoll: bounded(raw.mergePollMs, 60_000),
      // The lease wait is capped at the limit the route replaces an instance
      // past (src/landing/lease-wait.ts), so a healthy instance ends first.
      wait: Math.min(bounded(raw.waitTimeoutMs, LANDING_LEASE_WAIT_LIMIT_MS), LANDING_LEASE_WAIT_LIMIT_MS), workspace: bounded(raw.workspaceTimeoutMs, 24 * 3_600_000),
      conflict: bounded(raw.conflictTimeoutMs, 7 * DAY),
      review: bounded(raw.reviewTimeoutMs, 3_600_000), merge: bounded(raw.mergeTimeoutMs, 24 * 3_600_000),
      // The executor has already run the checks when it reports the push,
      // so the wait only bridges a slow record; half an hour, renewed lease.
      checksWait: bounded(raw.checksTimeoutMs, 30 * 60_000),
      triage: raw.triage === true,
      sfx: "",
    };
    const L = this.env.LEDGER.get(this.env.LEDGER.idFromName(`project:${p.key}`));
    let round = 0;
    // When this landing took the lease it holds, for the time it held it.
    let leasedAt: number | null = null;
    try {
      // The refusals the CLI's preflight makes, asked again here: a closed
      // task, a plan (which lands with atelier merge) and an accepted task
      // (whose landing is only its merge) stop at once.
      await step.do("read the task to land", RETRIES, async () => {
        const item = await L.item(p.item);
        if (item.state === "merged" || item.state === "abandoned") throw new NonRetryableError(`${p.item} is ${item.state}; there is nothing to land.`);
        if (item.kind === "plan") throw new NonRetryableError(`${p.item} is a plan, which lands with atelier merge ${p.item} --head INTEGRATION_HEAD, the integration head atelier plan show ${p.item} prints.`);
        if (item.state === "accepted") throw new NonRetryableError(`${p.item} is accepted at ${short(item.acceptedHead)}; merge it with: atelier merge ${p.item}.`);
        // A landing a blocking pre-review fenced (t524) is refused the lease
        // until `atelier unblock`, so it ends here, before a check or a
        // review is spent on a landing that could not merge.
        const fence = ((await L.detail(p.item)) as unknown as { prereviewFence?: PrereviewFence | null }).prereviewFence;
        if (fence) throw new NonRetryableError(fenceText(p.item, fence));
        return { state: item.state };
      });

      // The rounds (t550): ask the executor for the merge of main and the
      // push, check, submit and review the head it pushed — all without the
      // lease, beside any other task's landing — and only then take the
      // lease and confirm main is still the commit that head was merged
      // with. A conflict pauses the landing (no lease is held) until the
      // owner resolves it; main moving before the lease releases the lease
      // and begins a new round. The server carries an approval over the
      // merge the executor pushes only as the review-retention rule lets it
      // (t56, retentionVerdict in src/rules.ts); the round's review step then
      // finds it standing at the new head and asks for none, and any other
      // merge asks for a new review. Each round's
      // steps are named for it (`p.sfx`), so none answers from a cached
      // step of an earlier round.
      let report: Reported;
      let moves = 0;
      let movedNote: string | undefined;
      for (;;) {
        p.sfx = round ? ` r${round}` : "";
        const roundAt = await step.do(`note the start of the round${p.sfx || " r0"}`, RETRIES, async () => Date.now());
        await this.stage(step, L, p, "workspace", round, movedNote ?? "waiting for the machine holding the workspace to merge main and push; no lease is held");
        const got = await this.waitForWorkspace(step, p, round);
        if ("conflict" in got) {
          await this.stage(step, L, p, "conflict", round, got.reason, got.files);
          await this.waitForResume(step, p, round);
          round++;
          movedNote = undefined;
          continue;
        }
        report = got;
        const head = report.head;
        await this.seeHeadPushed(step, L, p, head);

        // The checks: the observed results the executor's clean-clone run
        // recorded at that head, read from the Ledger.
        await this.stage(step, L, p, "checks", round, `waiting for the observed results of the required checks at ${short(head)}, run in a clean clone on the machine holding the workspace`);
        await this.awaitObservedChecks(step, L, p, head);

        // The submission, in the name of the task's holder, as `atelier
        // submit` run in the workspace submits it with the owner's token; it
        // is skipped where the Ledger already holds it, so a retried step
        // never submits twice. A landing that triages submits only while its
        // triage stands at the reported binding (t475).
        const reported = report;
        await step.do(`submit the merged head${p.sfx}`, RETRIES, async () => {
          await this.stillCurrent(L, p);
          const item = await L.item(p.item);
          if (item.head !== head) throw new NonRetryableError(`${p.item}'s head moved to ${short(item.head)}; start the landing again`);
          if (["submitted", "accepted", "merged"].includes(item.state)) return { skipped: true };
          await this.triageStands(L, p, reported, `so the landing stops before the submission: nothing was submitted and no review was asked for, and ${p.item} stays with its holder`);
          if (!item.owner) throw new NonRetryableError(`${p.item} has no holder to submit it; claim it, then run atelier land ${p.item} --workflow again`);
          const t0 = Date.now();
          try {
            await L.submit(p.item, item.owner, reported.mergedIn && reported.mainHead ? `Merged with main at ${short(reported.mainHead)}; the required checks pass.` : "The required checks pass.", p.origin);
          } catch (error) {
            const parsed = parseRuleError(error);
            if (parsed && parsed.status < 500) throw new NonRetryableError(parsed.detail);
            throw error;
          }
          await this.note(L, p, "submit", Date.now() - t0, {});
          return {};
        });

        // The review: requested of the reviewer the owner named or the one
        // the gate picks, then waited for on the server. --no-review leaves
        // the task submitted for the owner to settle by hand, and never
        // takes the lease.
        await this.stage(step, L, p, "review", round);
        if (p.noReview) {
          await step.do("record the skipped review", RETRIES, async () => { await this.note(L, p, "review", 0, { skipped: true }); return {}; });
          await this.stage(step, L, p, "done", round, "submitted; the review is left to the developer (--no-review); the landing lease was never taken");
          return { item: p.item, workflow: p.instance, review: "skipped" };
        }
        await this.review(step, L, p, head, round, report);

        // The gate as the acceptance will read it, asked before the lease:
        // the head must be the one checked and approved, with the required
        // checks passing and an approval the gate counts (or none needed).
        await step.do(`confirm the gate before the lease${p.sfx}`, RETRIES, async () => {
          await this.stillCurrent(L, p);
          const d = (await L.detail(p.item)) as unknown as { item: { head: string | null }; gate?: { ready: boolean; blockers?: string[] } };
          if (d.item.head !== head) throw new NonRetryableError(`${p.item}'s head moved to ${short(d.item.head)} after ${short(head)} was checked and reviewed, so the landing stops before taking the lease; run atelier land ${p.item} --workflow again`);
          if (d.gate && !d.gate.ready) throw new NonRetryableError(`${p.item} at ${short(head)} is not ready to accept, so the landing stops before taking the lease: ${(d.gate.blockers ?? []).join("; ") || "the gate gave no reason"}. Nothing was merged`);
          return {};
        });

        // The lease, for the merge alone: queued for in the order the
        // landings asked (t249), with the time spent before it and in the
        // queue recorded on the lease step.
        await this.stage(step, L, p, "lease", round, `${short(head)} is checked and approved; waiting for the landing lease for the merge`);
        const taken = await this.takeLease(step, L, p, `r${round}`, roundAt, report);
        leasedAt = taken.at;

        // Main must be the commit the head was merged with, checked and
        // reviewed against. Where it moved, the lease is released without
        // accepting and the landing goes round again from the merge of main.
        const main = await step.do(`confirm main has not moved${p.sfx}`, RETRIES, async () => {
          await this.renewOrStop(L, p);
          return { main: await this.mainHead(L, p) };
        });
        if (main.main === report.mainHead) {
          // Recorded on the Ledger with the head, so the merge of this head
          // is refused into any other main (beginLanding), whatever happens
          // to the lease before the executor merges.
          await step.do(`record the confirmed main${p.sfx}`, RETRIES, async () => {
            try { await L.confirmLeaseMain(p.item, p.actor, main.main, p.instance); }
            catch (error) {
              const parsed = parseRuleError(error);
              if (parsed && parsed.status < 500) throw new NonRetryableError(`the landing could not record main ${short(main.main)} under its lease, so it stops without accepting ${p.item}: ${parsed.detail}. Run atelier land ${p.item} --workflow again`);
              throw error;
            }
            return {};
          });
          break;
        }
        moves++;
        await this.release(step, L, p, `release the landing lease, main moved r${round}`, leasedAt, `main moved from ${report.mainHead} to ${main.main}`);
        leasedAt = null;
        if (moves >= MAIN_MOVED_ROUNDS) throw new NonRetryableError(`main moved under the lease ${MAIN_MOVED_ROUNDS} times (now at ${short(main.main)}, where ${short(head)} was checked and reviewed against ${short(report.mainHead)}), so the landing stops without merging ${p.item}; it stays submitted. Run atelier land ${p.item} --workflow again once main settles`);
        movedNote = `main moved from ${short(report.mainHead)} to ${short(main.main)} while ${short(head)} was checked and reviewed, so the lease was released without accepting; waiting for the machine holding the workspace to merge main again and push`;
        round++;
      }
      const head = report.head;

      // The acceptance: the fork's head is read from Artifacts and must be
      // the reviewed head (as the accept route checks it), and the lease
      // must still be this landing's.
      await step.do("confirm the fork's head", RETRIES, async () => {
        const item = await L.item(p.item);
        if (!item.fork) return { head };
        using repo = await this.env.ARTIFACTS.get(item.fork);
        const [top] = await repo.log({ limit: 1 });
        if (top?.hash !== head) throw new NonRetryableError(`${p.item}'s fork is at ${short(top?.hash)}, not the reviewed ${short(head)}: the workspace pushed again. Run atelier land ${p.item} --workflow again`);
        return { head };
      });
      await step.do("accept the reviewed head", RETRIES, async () => {
        // Under the lease taken above, renewed here: a landing that lost it
        // stops before accepting.
        await this.renewOrStop(L, p);
        const item = await L.item(p.item);
        if (item.state === "merged") return { done: "merged" };
        if (item.state === "accepted" && item.acceptedHead === head) return { done: "accepted" };
        const t0 = Date.now();
        try {
          await L.accept(p.item, p.actor, head);
        } catch (error) {
          throw new NonRetryableError(this.refusal(error));
        }
        await this.note(L, p, "accept", Date.now() - t0, {});
        return {};
      });

      // The merge itself is Git in the owner's checkout (atelier merge, run
      // by the executor when it sees this stage); the Workflow watches the
      // Ledger until the merge is recorded.
      await this.stage(step, L, p, "merge", round, `accepted at ${short(head)}; waiting for atelier merge ${p.item} in the registered checkout`);
      await this.waitForMerge(step, L, p);
      await this.release(step, L, p, "release the landing lease", leasedAt, "merged");
      await this.stage(step, L, p, "done", round, "merged");
      return { item: p.item, workflow: p.instance, landed: true };
    } catch (error) {
      // Every ending that is not the landing's success releases the lease
      // before the instance errors, as the CLI's landing does before it
      // dies, and writes the stage `failed` with the reason. A lease
      // another landing already took over (t237) is left with it; a release
      // that cannot be asked is left to lapse on its own after the expiry.
      const message = String((error as Error)?.message ?? error);
      try {
        await step.do("release the landing lease after the failure", RETRIES, async () => {
          // A replaced instance (t430) leaves the lease and the stage to its
          // replacement, as a lease handed over is left to its new holder.
          // A lease held by another landing still gets this landing's stage
          // `failed` and its reason (a lease-wait timeout names that holder).
          let outcome: { released?: true; handedOver?: true } = { released: true };
          try { await L.cancelProjectLanding(p.item, p.actor, p.instance); } catch (err) { const code = parseRuleError(err)?.code; if (code === "stale_landing") return { replaced: true }; if (code !== "landing_lease") throw err; outcome = { handedOver: true }; }
          if (leasedAt !== null && outcome.released) await this.note(L, p, "release", Date.now() - leasedAt, { reason: `stopped: ${message.split("\n")[0]}`.slice(0, 500) });
          await L.setLandingWorkflowStage(p.item, p.instance, "failed", round, message);
          return outcome;
        });
      } catch { /* the lease lapses on its own; the error that ends the run is the one to keep */ }
      throw error;
    }
  }

  // ── the stage and the lease ───────────────────────────────────────────

  private async stage(step: WorkflowStep, L: LedgerStub, p: Landing, stage: LandingWorkflowStage, round: number, detail?: string, files?: string[]): Promise<void> {
    await step.do(`stage ${stage} r${round}`, RETRIES, async () => {
      const record = await L.setLandingWorkflowStage(p.item, p.instance, stage, round, detail, files);
      // The first stage this instance writes (the workspace, since t550)
      // waits for the record the route makes when it creates the instance.
      if (!record && stage === "workspace" && round === 0) {
        throw new Error("the landing instance is waiting for its record after creation");
      }
      return {};
    });
  }

  // Asks for the project's landing lease until it is this task's: each ask
  // refreshes the landing's place in the server's queue (t249) and tries
  // the take; a refusal names whose landing stands in the way, and the
  // Workflow sleeps and asks again until the wait's limit, when it leaves
  // the queue and ends. Each take is the lease for one round's merge (t550),
  // recorded as a land.lease event with the time the round spent before it
  // (from `roundAt`: the merge of main, the checks and the review) and the
  // time it waited in the queue. Answers when the lease was taken.
  private async takeLease(step: WorkflowStep, L: LedgerStub, p: Landing, label: string, roundAt: number, report: Reported): Promise<{ at: number }> {
    const asked = await step.do(`note the ask for the landing lease ${label}`, RETRIES, async () => Date.now());
    // Bound replay/step pressure during a long lease queue without letting
    // its heartbeat approach the Ledger's fifteen-minute queue expiry.
    // Small test/short-wait polls retain their requested cadence.
    const poll = landingLeasePollMs(p.wait, p.poll);
    const maxAsks = Math.max(1, Math.ceil(p.wait / poll));
    for (let i = 0; ; i++) {
      const ask = await step.do(`ask for the landing lease ${label} #${i}`, RETRIES, async () => {
        const t0 = Date.now();
        // A landing a blocking pre-review fenced (t524) is refused the queue
        // until `atelier unblock`; no retry of the ask lifts it, so it ends
        // the Workflow at once rather than after every retry.
        try { await L.queueProjectLanding(p.item, p.actor, false, p.instance); }
        catch (error) {
          const parsed = parseRuleError(error);
          if (parsed?.code === "prereview_blocked") throw new NonRetryableError(parsed.detail);
          throw error;
        }
        try {
          const { expired }: { expired: LandingLease | null } = await L.beginProjectLanding(p.item, p.actor, p.instance);
          return { took: true as const, t0, at: Date.now(), expired: expired ? expired.item : null };
        } catch (error) {
          const parsed = parseRuleError(error);
          // The holder at this attempt, read after the refusal: the final
          // attempt's is what a timeout reports, or that nobody held it.
          if (parsed?.code === "landing_lease") {
            const held: LandingLease | null = await L.liveProjectLanding();
            return { took: false as const, why: parsed.detail, at: new Date().toISOString(), holder: held ? { item: held.item, holder: held.holder, since: held.at } : null };
          }
          // Unfinished post-merge work blocks the take; no landing holds the
          // lease then, so the refusal names the run instead of a holder.
          if (parsed?.code === "post_merge_blocked") return { took: false as const, why: parsed.detail, at: new Date().toISOString() };
          if (parsed && parsed.status >= 400 && parsed.status < 500) throw new NonRetryableError(parsed.detail);
          throw error;
        }
      });
      if (ask.took) {
        await step.do(`record the lease step ${label}`, RETRIES, async () => {
          await this.note(L, p, "lease", Math.max(0, ask.at - ask.t0), {
            head: report.head, main: report.mainHead,
            beforeLease: Math.max(0, asked - roundAt), waited: Math.max(0, ask.t0 - asked),
            ...(ask.expired ? { reason: `took over the lapsed lease of ${ask.expired}` } : {}),
          });
          return {};
        });
        return { at: ask.at };
      }
      if (i + 1 >= maxAsks) {
        await step.do(`leave the landing queue ${label}`, RETRIES, async () => { await L.queueProjectLanding(p.item, p.actor, true, p.instance); return {}; });
        throw new NonRetryableError(leaseTimeout(p.item, p.wait, ask));
      }
      await step.sleep(`wait for the landing lease ${label} #${i}`, poll);
    }
  }

  // The holder's heartbeat and its loss, asked inside a step: a renewal
  // the server refuses says another landing holds the lease now, and this
  // landing stops without accepting or merging beside it (t232); a renewal
  // that cannot be asked retries with the step.
  private async renewOrStop(L: LedgerStub, p: Landing): Promise<void> {
    try {
      await L.renewProjectLanding(p.item, p.actor, p.instance);
    } catch (error) {
      const parsed = parseRuleError(error);
      if (parsed?.code === "stale_landing") throw new NonRetryableError(`this landing Workflow was replaced, so it stops without advancing ${p.item}: ${parsed.detail}`);
      if (parsed && (parsed.code === "no_lease" || parsed.code === "landing_lease")) {
        throw new NonRetryableError(`another landing took the landing lease of ${p.project} over, so this landing stops without accepting or merging ${p.item}: the server said "${parsed.detail}". Nothing was merged; run atelier land ${p.item} --workflow again once the other landing ends.`);
      }
      throw error;
    }
  }

  // The fence a replaced instance meets before the lease (t430, t550): the
  // steps before the lease hold none to renew, so each asks the record
  // whether this instance is still the task's landing, and one that was
  // replaced stops without checking, submitting or reviewing anything.
  private async stillCurrent(L: LedgerStub, p: Landing): Promise<void> {
    const record = await L.landingWorkflowOf(p.item);
    if (record && record.instance !== p.instance) throw new NonRetryableError(`this landing Workflow was replaced, so it stops without advancing ${p.item}: ${record.instance} is ${p.item}'s landing Workflow now`);
  }

  // Releases the lease this landing holds, recording the time it held it
  // (from `since`) and why it let it go as a land.release event (t550).
  private async release(step: WorkflowStep, L: LedgerStub, p: Landing, name: string, since: number | null = null, why = "released"): Promise<void> {
    await step.do(name, RETRIES, async () => {
      // A lease handed over (t237) to a landing that took it after this
      // task merged was still held until then, and is recorded so.
      let outcome: { released?: true; handedOver?: true } = { released: true };
      try { await L.cancelProjectLanding(p.item, p.actor, p.instance); } catch (err) { const code = parseRuleError(err)?.code; if (code === "stale_landing") return { replaced: true }; if (code !== "landing_lease") throw err; outcome = { handedOver: true }; }
      if (since !== null) await this.note(L, p, "release", Date.now() - since, { reason: why.slice(0, 500) });
      return outcome;
    });
  }

  // Main's head as the baseline holds it now: the project's repository, or
  // a part's plan branch, read from Artifacts as the merge of main reads it.
  private async mainHead(L: LedgerStub, p: Landing): Promise<string> {
    const item = await L.item(p.item);
    const project = await L.project();
    const planFork = item.kind === "part" && item.plan ? (await L.item(item.plan)).fork : null;
    using repo = await this.env.ARTIFACTS.get(baseRepoOf(item, project.repo, planFork));
    const [top] = await repo.log({ limit: 1 });
    if (!top || !HASH.test(top.hash)) throw new Error(`main's head could not be read for ${p.item}`);
    return top.hash;
  }

  // ── the workspace steps, on the machine that holds the workspace ──────

  // Waits for the executor's report of this round. A report naming another
  // round (one the Workflow buffered from an earlier pass) is passed over,
  // and the wait goes on. A report that a step failed carries the CLI's own
  // message, which already says what to do; one of conflicts pauses the
  // landing (run, above).
  private async waitForWorkspace(step: WorkflowStep, p: Landing, round: number): Promise<Reported | { conflict: true; files: string[]; reason: string }> {
    const chunks = Math.max(1, Math.ceil(p.workspace / EVENT_CHUNK_MS));
    for (let i = 0; ; i++) {
      let payload: WorkspaceReport | null = null;
      try {
        const got = await step.waitForEvent<WorkspaceReport>(`wait for the workspace r${round} #${i}`, { type: "workspace", timeout: Math.min(EVENT_CHUNK_MS, p.workspace) });
        payload = got.payload as WorkspaceReport;
      } catch { /* nothing in this chunk; the next chunk waits on */ }
      if (payload && payload.round === round) {
        if (payload.failed === true) throw new NonRetryableError(String(payload.reason ?? "a workspace step of the landing failed").slice(0, WORKSPACE_REASON_MAX));
        if (payload.conflict === true) {
          const files = Array.isArray(payload.files) ? payload.files.map(String) : [];
          return { conflict: true, files, reason: String(payload.reason ?? `the merge of main stopped on conflicts in ${files.join(", ")}`).slice(0, WORKSPACE_REASON_MAX) };
        }
        const head = String(payload.head ?? "");
        if (!HASH.test(head)) throw new NonRetryableError(`the workspace report is malformed (its head is not a commit hash); run atelier land ${p.item} --workflow again`);
        // The main the head was merged with is what the lease confirms main
        // is still at (t550); a report without it cannot be merged safely.
        const mainHead = String(payload.mainHead ?? "");
        if (!HASH.test(mainHead)) throw new NonRetryableError(`the workspace report names no main head the push was merged with, so the landing cannot confirm main has not moved before it merges; run atelier land ${p.item} --workflow again with this CLI`);
        const t = payload.triage;
        const triage = t && typeof t === "object" && HASH.test(String(t.base ?? "")) && /^[a-f0-9]{64}$/.test(String(t.criteria ?? "")) ? { head, base: String(t.base), criteria: String(t.criteria) } : null;
        return { head, mainHead, mergedIn: payload.mergedIn === true, triage };
      }
      if (i + 1 >= chunks) {
        throw new NonRetryableError(`the workspace did not report the merge of main and the push within ${span(p.workspace)}, so the landing stops without submitting ${p.item}; no lease was held and nothing was merged. Run atelier land ${p.item} --workflow again from the machine holding its workspace`);
      }
    }
  }

  // The pause on a conflict: waits for the owner's `resume` of this round,
  // sent by `atelier land ID --workflow` once the conflicts are resolved and
  // committed, for up to the conflict timeout (a week by default).
  private async waitForResume(step: WorkflowStep, p: Landing, round: number): Promise<void> {
    const chunks = Math.max(1, Math.ceil(p.conflict / EVENT_CHUNK_MS));
    for (let i = 0; ; i++) {
      let payload: { round?: number } | null = null;
      try {
        const got = await step.waitForEvent<{ round: number }>(`wait for the conflict to be resolved r${round} #${i}`, { type: "resume", timeout: Math.min(EVENT_CHUNK_MS, p.conflict) });
        payload = got.payload as { round?: number };
      } catch { /* nothing in this chunk */ }
      if (payload && payload.round === round) return;
      if (i + 1 >= chunks) {
        throw new NonRetryableError(`the conflicts in ${p.item}'s merge of main were not resolved within ${span(p.conflict)}; the landing ends with nothing submitted. Resolve them, commit, and run atelier land ${p.item} --workflow again`);
      }
    }
  }

  // The Ledger must observe the head the executor says it pushed before
  // anything runs on it.
  private async seeHeadPushed(step: WorkflowStep, L: LedgerStub, p: Landing, head: string): Promise<void> {
    const maxPolls = Math.max(1, Math.floor(PUSH_SEEN_MS / p.poll));
    for (let i = 0; ; i++) {
      const seen = await step.do(`see the merged head pushed ${short(head)} #${i}`, RETRIES, async () => (await L.item(p.item)).head);
      if (seen === head) return;
      if (i + 1 >= maxPolls) throw new NonRetryableError(`the ledger never observed ${short(head)} as ${p.item}'s pushed head; the workspace and the fork disagree. Run atelier land ${p.item} --workflow again`);
      await step.sleep(`wait for the pushed head ${short(head)} #${i}`, p.poll);
    }
  }

  // ── the checks, the review, the merge ────────────────────────────────

  // The checks: the executor ran them in a clean clone before
  // it reported the push, and the server recorded each as observed evidence
  // at the head it read from Artifacts. The Workflow trusts none of that by
  // word: it reads the evidence from the Ledger and judges it with
  // evidenceAt, the gate's own reading, which counts only observed results
  // (never a report), at exactly this head, not a merged run, the latest per
  // check. Every required check
  // that applies must pass; a failing one ends the landing; one with no
  // result is waited for until the checks timeout. No lease is held while
  // it waits (t550).
  private async awaitObservedChecks(step: WorkflowStep, L: LedgerStub, p: Landing, head: string): Promise<void> {
    const t0 = await step.do(`note the start of the observed checks wait${p.sfx}`, RETRIES, async () => Date.now());
    const maxPolls = Math.max(1, Math.floor(p.checksWait / p.poll));
    for (let i = 0; ; i++) {
      const seen = await step.do(`read the observed checks at ${short(head)} #${i}${p.sfx}`, RETRIES, async () => {
        await this.stillCurrent(L, p);
        const item = await L.item(p.item);
        if (item.head !== head) throw new NonRetryableError(`${p.item}'s head moved to ${short(item.head)}; start the landing again`);
        const { policy } = await L.project();
        const view = evidenceAt(policy, await L.evidenceFor(p.item), head);
        return { checks: view.checks.map((c) => ({ claim: c.claim, observed: c.grade === "observed", passed: c.passed === true })) };
      });
      const failed = seen.checks.filter((c) => c.observed && !c.passed);
      if (failed.length) {
        const why = `the required checks failed at ${short(head)} in a clean clone on the machine holding the workspace: ${failed.map((c) => c.claim).join("; ")}. The merge of main stays in the workspace; fix the failures, commit, and run atelier land ${p.item} --workflow again.`;
        const { detail } = await step.do(`record the failed observed checks${p.sfx}`, RETRIES, async () => {
          await this.note(L, p, "check", Date.now() - t0, { failed: true, head, reason: failed.map((c) => c.claim).join(", ").slice(0, 500) });
          return { detail: await this.failureText(L, p, head, why) };
        });
        throw new NonRetryableError(detail || why);
      }
      const pending = seen.checks.filter((c) => !c.observed);
      if (!pending.length) return;
      if (i + 1 >= maxPolls) {
        throw new NonRetryableError(`no observed result at ${short(head)} for ${pending.map((c) => c.claim).join("; ")} within ${span(p.checksWait)}: the machine holding the workspace runs the required checks in a clean clone (atelier check) after it pushes, and the server records them. Nothing was submitted; run atelier land ${p.item} --workflow again from that machine`);
      }
      await step.sleep(`wait for the observed checks at ${short(head)} #${i}${p.sfx}`, p.poll);
    }
  }

  // The reviews the gate needs, one at a time (t143), as the CLI's landing
  // asks them (reviewStep in cli/land.mjs): where the project states
  // riskReviews one approval can leave the change short of its class, so the
  // next review is asked only after the last approved, for the approvals
  // still missing, and a rejection ends the landing before any later one is
  // asked. With a reviewer named, or without riskReviews, one review is asked
  // as it always was.
  private async review(step: WorkflowStep, L: LedgerStub, p: Landing, head: string, round: number, report: Reported): Promise<void> {
    for (let pass = 1; ; pass++) {
      if (!await this.reviewOnce(step, L, p, head, round, report, pass) || p.reviewer !== null) return;
      const sfx = pass > 1 ? `${p.sfx} (review ${pass})` : p.sfx;
      const missing = await step.do(`count the approvals still missing${sfx}`, RETRIES, async () => approvalsMissing({ ...((await L.detail(p.item)) as unknown as RecordedDetail), ownerActor: p.actor }, head));
      if (!missing) return;
      if (pass >= REVIEW_PASSES) throw new NonRetryableError(`${p.item} still needs ${missing} more approval${missing === 1 ? "" : "s"} at ${short(head)} after ${pass} reviews; the landing stops. Run atelier show ${p.item} for what the gate counts`);
    }
  }

  private async reviewOnce(step: WorkflowStep, L: LedgerStub, p: Landing, head: string, round: number, report: Reported, pass: number): Promise<boolean> {
    // Each pass is its own set of steps, so a later one never replays an earlier.
    const sfx = pass > 1 ? `${p.sfx} (review ${pass})` : p.sfx;
    const ask = await step.do(`request the review${sfx}`, RETRIES, async () => {
      await this.stillCurrent(L, p);
      // The triage is asked again whether it stands: criteria changed since
      // the submission stop the landing before any review is asked for.
      await this.triageStands(L, p, report, `so no review was asked for: ${p.item} is submitted at ${short(head)} and stays with its holder`);
      // A qualifying approval already recorded at this head, which the gate
      // holds ready to accept (`atelier show`'s accept), settles the review
      // before any request (t628), as the CLI's landing reads it.
      const now = (await L.detail(p.item)) as unknown as RecordedDetail;
      const held = recordedApproval({ ...now, ownerActor: p.actor }, head, p.reviewer);
      if (held) return { needed: false, held: held.by, reason: `${held.by} already approved ${short(head)}, and the gate counts it`, at: "", asked: "", reviewer: null, request: null };
      const index = this.env.LEDGER.get(this.env.LEDGER.idFromName("__index"));
      const pool = await index.models();
      const records = p.reviewer === null ? { ...await suggestionRecords(index, (project) => this.env.LEDGER.get(this.env.LEDGER.idFromName(`project:${project.key ?? project.name}`))), project: (await index.resolveProject(p.project)).key } : undefined;
      try {
        // A named reviewer is wanted even where the gate needs none; with
        // none named the gate decides, and the Ledger suggests the reviewer
        // from the records when it needs one.
        // The live offers go with the ask (t353): a request at this head
        // every runner offering its reviewer has skipped, left by an earlier
        // landing, is withdrawn and asked anew, so the runners serve it again.
        const r = await L.requestReview(p.item, p.actor, p.reviewer, pool, p.reviewer !== null, false, records, await index.runnerOffers());
        // An unclaimed request for another reviewer the named one replaced is said too (t627).
        const withdrew = (r.withdrew ?? []).map((w) => `Withdrew the unclaimed review request ${w.request}${w.reviewer ? ` for ${w.reviewer}` : ""}. `).join("");
        if (r.needed && r.reviewer) await L.setLandingWorkflowStage(p.item, p.instance, "review", round, `${withdrew}Reviewer: ${r.reviewer}. ${r.reason}`);
        // The request's number travels with the ask (t353): the skips the
        // wait counts are that request's alone.
        // `asked` is when this landing asked (t574): only a reply with no
        // readable verdict given since then ends its wait, not one an earlier
        // landing already stopped on.
        const asked = new Date().toISOString();
        return { needed: r.needed, held: null as string | null, reason: r.reason, at: r.at ?? asked, asked, reviewer: r.reviewer ?? null, request: r.request ?? null };
      } catch (error) {
        throw new NonRetryableError(this.refusal(error));
      }
    });
    if (ask.held) {
      const by = ask.held;
      await step.do(`record the review already approved${sfx}`, RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: "approve", reviewer: by, resolvedBy: by, reason: "approval recorded at the head before the landing asked for a review" }); return {}; });
      return false;
    }
    if (!ask.needed && p.reviewer) throw new NonRetryableError(`the server made no review request for ${p.reviewer} (${ask.reason}); ${p.item} stays submitted`);
    if (!ask.needed) {
      await step.do(`record the review none needed${sfx}`, RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: "none-needed", reason: String(ask.reason ?? "").slice(0, 500) }); return {}; });
      return false;
    }
    const maxPolls = Math.max(1, Math.floor(p.review / p.poll));
    for (let i = 0; ; i++) {
      const poll = await step.do(`wait for the verdict #${i}${sfx}`, RETRIES, async () => {
        await this.stillCurrent(L, p);
        // The live request is read before the verdicts (t574): a verdict
        // closes the request it answers, so one recorded between the reads is
        // seen in the detail rather than taken for a request gone unanswered.
        const live = await L.liveReviewRequest(p.item, head);
        // The Ledger's detail is a wide view; the step keeps what it reads.
        const d = (await L.detail(p.item)) as unknown as { item: { head: string | null }; reviews: LandingReview[]; unparsable?: LandingUnparsable[] };
        if (d.item.head !== head) throw new NonRetryableError(`${p.item}'s head moved to ${short(d.item.head)} while waiting for the review; start the landing again`);
        const { verdict } = landingVerdict(d.reviews ?? [], head, ask.at);
        if (verdict) return { approve: verdict.approve, by: verdict.by, note: String(verdict.note ?? ""), findings: (verdict.findings ?? []) as Finding[], tier: verdict.tier === true };
        // No verdict: the wait goes on only while one can still come.
        const stall = reviewStall(head, ask.asked ?? ask.at, ask.reviewer, live, d.unparsable ?? []);
        return stall ? { stall } : null;
      });
      if (poll && "stall" in poll) {
        const stall = poll.stall as ReviewStall;
        await step.do(`record the stalled review${sfx}`, RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: stall.kind === "unparsable" ? "unparsable" : "no-request", ...(ask.reviewer ? { reviewer: ask.reviewer } : {}) }); return {}; });
        const byHand = `review by hand (atelier review ${p.item} --approve --as H/M --note "…"), then atelier accept ${p.item} and atelier merge ${p.item}`;
        if (stall.kind === "unparsable") {
          throw new NonRetryableError(`${stall.by} replied to the review of ${p.item} at ${short(head)} with no verdict the server could read (${stall.note.slice(0, 300) || "no note"}); the reply is kept on the task (atelier show ${p.item}). The request stays asked of ${stall.by} and ${p.item} stays submitted. Run atelier land ${p.item} --workflow --reviewer H/M to ask another reviewer, which replaces that request, or ${byHand}`);
        }
        throw new NonRetryableError(`no review request of ${p.item} at ${short(head)} is open or claimed and no verdict was given, so none will come; ${p.item} stays submitted. Run atelier land ${p.item} --workflow${ask.reviewer ? ` --reviewer ${ask.reviewer}` : ""} to ask again, or ${byHand}`);
      }
      if (poll) {
        if (!poll.approve) {
          await step.do(`record the rejected review${sfx}`, RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: "reject", reviewer: poll.by, resolvedBy: poll.by }); return {}; });
          throw new NonRetryableError(`${poll.by}${poll.tier ? " (tier review)" : ""} rejected ${p.item} at ${short(head)}: ${rejectionText({ note: poll.note, findings: poll.findings })}. The task goes back to its holder with the findings; the merge of main stays in its workspace`);
        }
        await step.do(`record the approved review${sfx}`, RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: "approve", reviewer: poll.by, resolvedBy: poll.by }); return {}; });
        return true;
      }
      // t353: a review request every runner that offers the reviewer has
      // skipped will never be claimed, however long the wait runs. Asked once
      // a poll, so the landing says so by runner name instead of waiting out
      // the hour. The skips counted are this request's alone, by its number:
      // an earlier request's at the same head are that request's.
      if (ask.reviewer && ask.request !== null) {
        const stuck = await step.do(`see whether every reviewer skipped #${i}${sfx}`, RETRIES, async () => {
          const [offers, project] = await Promise.all([this.env.LEDGER.get(this.env.LEDGER.idFromName("__index")).runnerOffers(), L.project()]);
          const live = await L.liveReviewRequest(p.item, head);
          if (!live) return null;
          // Only the runners that serve this project count (offersFor, t652).
          const runners = allSkipped(live.reviewer, offersFor(offers, project.name), await L.reviewSkips(p.item, live.request));
          return runners ? { runners } : null;
        });
        if (stuck) {
          await step.do(`record the skipped review${sfx}`, RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: "skipped", reviewer: ask.reviewer, runners: stuck.runners }); return {}; });
          throw new NonRetryableError(`every runner that offers ${ask.reviewer} for the review of ${p.item} at ${short(head)} has skipped it: ${stuck.runners.join(", ")}. The review request stays open and ${p.item} stays submitted. Review by hand (atelier review ${p.item} --approve --as ${ask.reviewer} --note "…"), then atelier accept ${p.item} and atelier merge ${p.item}, or run atelier land ${p.item} --workflow again, which asks the review anew for the runners to serve`);
        }
      }
      if (i + 1 >= maxPolls) {
        await step.do(`record the review timeout${sfx}`, RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: "timeout", ...(ask.reviewer ? { reviewer: ask.reviewer } : {}) }); return {}; });
        throw new NonRetryableError(`no verdict${ask.reviewer ? ` from ${ask.reviewer}` : ""} within ${span(p.review)}; the review request stays open and ${p.item} stays submitted. Review by hand, then atelier accept ${p.item} and atelier merge ${p.item}, or run atelier land ${p.item} --workflow again to wait once more`);
      }
      await step.sleep(`wait for the verdict to settle #${i}${sfx}`, p.poll);
    }
  }

  // Watches the Ledger for the merge the executor records, renewing the
  // lease on each poll until it is recorded (t550): a lease left to lapse
  // here once let a queued landing take it, merge, and move main under this
  // accepted head, which the executor then merged unchecked. A checkout
  // that never comes (a closed laptop) now holds the project until the
  // wait times out into the by-hand command, or until the owner frees the
  // lease with atelier land ID --release-lease, which ends this landing at
  // its next poll; and the merge of a head into a main other than the one
  // confirmed under the lease is refused by the Ledger (beginLanding).
  private async waitForMerge(step: WorkflowStep, L: LedgerStub, p: Landing): Promise<void> {
    const maxPolls = Math.max(1, Math.floor(p.merge / p.mergePoll));
    for (let i = 0; ; i++) {
      const done = await step.do(`wait for the merge #${i}`, RETRIES, async () => {
        // The lease is renewed while the merge is awaited (t550), so it
        // cannot lapse to a queued landing that would merge first and move
        // main under this accepted head. Once merged the lease guards
        // nothing and may already be another landing's, so it is left alone.
        if ((await L.item(p.item)).state !== "merged") {
          try { await L.renewProjectLanding(p.item, p.actor, p.instance); }
          catch (error) {
            const parsed = parseRuleError(error);
            if (parsed?.code === "stale_landing") throw new NonRetryableError(`this landing Workflow was replaced, so it stops without advancing ${p.item}: ${parsed.detail}`);
            if (!parsed || (parsed.code !== "no_lease" && parsed.code !== "landing_lease")) throw error;
            // Merged between the read and the renewal: the lease went with it.
            if ((await L.item(p.item)).state !== "merged") throw new NonRetryableError(`the landing lease of ${p.project} was lost while ${p.item} waited to merge (the server said "${parsed.detail}"); ${p.item} stays accepted, and its merge is refused if main has moved from the commit it was checked against. Run atelier land ${p.item} --workflow again`);
          }
          return false;
        }
        const run = await L.postMergeRun(p.item);
        return !run || run.state === "complete";
      });
      if (done) return;
      if (i + 1 >= maxPolls) {
        const run = await L.postMergeRun(p.item);
        throw new NonRetryableError(run && run.state !== "complete"
          ? `${p.item} has unresolved post-merge run ${run.id} (${run.state}); later merges remain blocked. Inspect with atelier land ${p.item} --post-merge status`
          : `${p.item}'s merge was not recorded within ${span(p.merge)}; it stays accepted. Merge it by hand: atelier merge ${p.item}`);
      }
      await step.sleep(`wait for the merge to record #${i}`, p.mergePoll);
    }
  }

  // ── the triage (t475) ─────────────────────────────────────────────────

  // A landing that triages goes on only while the Ledger says the triage
  // stands: the task's head and criteria are the reported binding's, and a
  // land.triage record at that binding passed, or the owner's bypass or
  // override was recorded there. Otherwise the landing ends, saying what
  // moved, with `after` saying where it stopped, and the command that
  // triages again.
  private async triageStands(L: LedgerStub, p: Landing, report: Reported, after: string): Promise<void> {
    if (!p.triage) return;
    const item = await L.item(p.item);
    const events = (await L.events(p.item)) as unknown as TriageEvent[];
    const why = triageStandsRefusal(item, events, report.triage);
    if (why) throw new NonRetryableError(`the triage of ${p.item} no longer stands: ${why}, ${after}. Run atelier land ${p.item} --workflow again, which triages the change as it is now`);
  }

  // ── small pieces ──────────────────────────────────────────────────────

  private refusal(error: unknown): string {
    const parsed = parseRuleError(error);
    return parsed ? parsed.detail : String((error as Error)?.message ?? error);
  }

  // The failure summary every landing prints (src/check-failure.ts, t436):
  // the failed checks as the gate reads them at the head, from the Ledger's
  // evidence, each stored log read from R2 by its reference. It returns the
  // whole error that ends the instance: `why`, the line naming the failed
  // checks, then the summary. The Ledger keeps that error as the stage's
  // detail, cut at LANDING_DETAIL_MAX characters, so failureDetail fits it
  // to that size (cutting a `why` too long to leave the summary its
  // check-log line), and the cut never drops a failed check or that line.
  // A summary that cannot be read says so; the failure itself is already
  // known.
  private async failureText(L: LedgerStub, p: Landing, head: string, why: string): Promise<string> {
    try {
      const { policy } = await L.project();
      const failures = effectiveFailures(policy, (await L.evidenceFor(p.item)) as Evidence[], head);
      const resolved = await resolveFailures(failures, (ref) => getLarge(this.env.LARGE, ref.key));
      return failureDetail(why, p.item, head, resolved, LANDING_DETAIL_MAX);
    } catch (error) {
      return `${why}\nThe failure summary could not be read: ${String((error as Error)?.message ?? error).slice(0, 300)}`;
    }
  }

  // A land.* event, recorded as the CLI records it: a ledger that cannot
  // take it does not fail the step that did the work.
  private async note(L: LedgerStub, p: Landing, kind: string, ms: number, data: Record<string, unknown>): Promise<void> {
    try { await L.landEvent(p.item, p.actor, kind, Math.max(0, Math.round(ms)), data); } catch { /* the record is not the step */ }
  }
}

type LedgerStub = ReturnType<Env["LEDGER"]["get"]>;
type Reported = { head: string; mainHead: string; mergedIn: boolean; triage: TriageBinding | null };
type Landing = {
  project: string; key: string; item: string; actor: string; instance: string;
  reviewer: string | null; noReview: boolean; origin?: string;
  poll: number; mergePoll: number; wait: number; workspace: number; conflict: number; review: number; merge: number;
  checksWait: number; triage: boolean;
  // The suffix of this round's step names (t550): empty in the first round,
  // " rN" after, so a step of a later round never answers from the cache of
  // an earlier one's.
  sfx: string;
};
