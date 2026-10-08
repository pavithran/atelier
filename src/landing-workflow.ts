// The landing pipeline as a Cloudflare Workflow (t280), behind the opt-in
// `atelier land ID --workflow`; `atelier land ID` without it runs the whole
// pipeline on the owner's Mac as before (cli/land.mjs, docs/landing.md).
//
// One instance lands one task. The steps the server can do alone are durable
// Workflow steps with retries: taking the project's landing lease (queueing
// for it in the order the landings asked, t249), the required checks in a
// Cloudflare container (the CheckRunner `atelier check --sandbox` starts),
// the submission, the review request and the wait for its verdict, the
// acceptance, and the watch for the merge. Each reads and writes the Ledger
// Durable Object directly, with no token, so an expired write token cannot
// end them, and each retries on its own when the Ledger, the container or
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
// such: the Workflow releases the lease and pauses at stage `conflict`,
// naming the files, until the owner resolves them and runs the command
// again, which sends a `resume` event; the Workflow then queues for the
// lease once more and asks for the workspace steps again (a new round, since
// main may have moved while it waited).
//
// Each step is recorded as the same land.* events the CLI's own landing
// writes (t186): the Workflow records the lease, the checks, the
// submission, the review and the acceptance; the executor records the
// merge, the regeneration, the push and the merged head, which only it can
// know. The verdict is judged by src/landing-verdict.ts, which the CLI's
// landing uses too.

import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { refusalOf, refusalText } from "./checks";
import { baseRepoOf } from "./plans/integrate";
import { parseRuleError } from "./rules";
import type { LandingLease } from "./landing-lease.ts";
import type { LandingWorkflowStage } from "./ledger.ts";
import { landingVerdict, type LandingReview } from "./landing-verdict.ts";
import type { RunRequest } from "./sandbox/runner";

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
}

const DAY = 86_400_000;
// Five tries, 2, 4, 8 and 16 seconds apart: enough to outlast a brief 503
// from Artifacts or a Durable Object reset, short enough that a lasting
// fault ends the landing with its own message.
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
      wait: bounded(raw.waitTimeoutMs, 3 * 3_600_000), workspace: bounded(raw.workspaceTimeoutMs, 24 * 3_600_000),
      conflict: bounded(raw.conflictTimeoutMs, 7 * DAY),
      review: bounded(raw.reviewTimeoutMs, 3_600_000), merge: bounded(raw.mergeTimeoutMs, 24 * 3_600_000),
    };
    const L = this.env.LEDGER.get(this.env.LEDGER.idFromName(`project:${p.key}`));
    let round = 0;
    try {
      // The refusals the CLI's preflight makes, asked again here: a closed
      // task, a plan (which lands with atelier merge) and an accepted task
      // (whose landing is only its merge) stop at once.
      await step.do("read the task to land", RETRIES, async () => {
        const item = await L.item(p.item);
        if (item.state === "merged" || item.state === "abandoned") throw new NonRetryableError(`${p.item} is ${item.state}; there is nothing to land.`);
        if (item.kind === "plan") throw new NonRetryableError(`${p.item} is a plan, which lands with atelier merge ${p.item} --head INTEGRATION_HEAD, the integration head atelier plan show ${p.item} prints.`);
        if (item.state === "accepted") throw new NonRetryableError(`${p.item} is accepted at ${short(item.acceptedHead)}; merge it with: atelier merge ${p.item}.`);
        return { state: item.state };
      });

      // The workspace rounds: take the lease, ask the executor for the
      // merge of main and the push, and either go on with the head it
      // pushed or, on conflicts, release the lease and pause until the
      // owner resolves them, then begin a new round.
      let report: { head: string; mainHead: string | null; mergedIn: boolean };
      for (;;) {
        await this.stage(step, L, p, "lease", round);
        await this.takeLease(step, L, p, `r${round}`, round === 0);
        await this.stage(step, L, p, "workspace", round, "waiting for the machine holding the workspace to merge main and push");
        const got = await this.waitForWorkspace(step, p, round);
        if ("conflict" in got) {
          await this.stage(step, L, p, "conflict", round, got.reason, got.files);
          await this.release(step, L, p, `release the landing lease for the conflict r${round}`);
          await this.waitForResume(step, p, round);
          round++;
          continue;
        }
        report = got;
        break;
      }
      const head = report.head;
      await this.seeHeadPushed(step, L, p, head);

      // The checks, in the same Cloudflare container `atelier check
      // --sandbox` starts, from the fork at the pushed head. The lease is
      // renewed first: a lease another landing took over while the
      // workspace worked stops this landing here.
      await this.stage(step, L, p, "checks", round);
      await step.do("renew the lease before the checks", RETRIES, async () => { await this.renewOrStop(L, p); return {}; });
      await this.runChecks(step, L, p, head);

      // The submission, in the name of the task's holder, as `atelier
      // submit` run in the workspace submits it with the owner's token; it
      // is skipped where the Ledger already holds it, so a retried step
      // never submits twice.
      await step.do("submit the merged head", RETRIES, async () => {
        const item = await L.item(p.item);
        if (item.head !== head) throw new NonRetryableError(`${p.item}'s head moved to ${short(item.head)}; start the landing again`);
        if (["submitted", "accepted", "merged"].includes(item.state)) return { skipped: true };
        if (!item.owner) throw new NonRetryableError(`${p.item} has no holder to submit it; claim it, then run atelier land ${p.item} --workflow again`);
        const t0 = Date.now();
        try {
          await L.submit(p.item, item.owner, report.mergedIn && report.mainHead ? `Merged with main at ${short(report.mainHead)}; the required checks pass.` : "The required checks pass.", p.origin);
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
      // the task submitted for the owner to settle by hand.
      await this.stage(step, L, p, "review", round);
      if (p.noReview) {
        await step.do("record the skipped review", RETRIES, async () => { await this.note(L, p, "review", 0, { skipped: true }); return {}; });
        await this.release(step, L, p, "release the landing lease");
        await this.stage(step, L, p, "done", round, "submitted; the review is left to the owner (--no-review)");
        return { item: p.item, workflow: p.instance, review: "skipped" };
      }
      await this.review(step, L, p, head);

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
      await this.release(step, L, p, "release the landing lease");
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
          try { await L.cancelProjectLanding(p.item, p.actor); } catch (err) { if (parseRuleError(err)?.code === "landing_lease") return { handedOver: true }; throw err; }
          await L.setLandingWorkflowStage(p.item, p.instance, "failed", round, message);
          return { released: true };
        });
      } catch { /* the lease lapses on its own; the error that ends the run is the one to keep */ }
      throw error;
    }
  }

  // ── the stage and the lease ───────────────────────────────────────────

  private async stage(step: WorkflowStep, L: LedgerStub, p: Landing, stage: LandingWorkflowStage, round: number, detail?: string, files?: string[]): Promise<void> {
    await step.do(`stage ${stage} r${round}`, RETRIES, async () => {
      await L.setLandingWorkflowStage(p.item, p.instance, stage, round, detail, files);
      return {};
    });
  }

  // Asks for the project's landing lease until it is this task's: each ask
  // refreshes the landing's place in the server's queue (t249) and tries
  // the take; a refusal names whose landing stands in the way, and the
  // Workflow sleeps and asks again until the wait's limit, when it leaves
  // the queue and ends. `record` writes the land.lease event for the first
  // take alone; a retake in a later round is a resume, not a second lease.
  private async takeLease(step: WorkflowStep, L: LedgerStub, p: Landing, label: string, record: boolean): Promise<void> {
    const maxAsks = Math.max(1, Math.floor(p.wait / p.poll));
    for (let i = 0; ; i++) {
      const ask = await step.do(`ask for the landing lease ${label} #${i}`, RETRIES, async () => {
        const t0 = Date.now();
        await L.queueProjectLanding(p.item, p.actor);
        try {
          const { expired }: { expired: LandingLease | null } = await L.beginProjectLanding(p.item, p.actor);
          return { took: true as const, t0, expired: expired ? expired.item : null };
        } catch (error) {
          const parsed = parseRuleError(error);
          if (parsed?.code === "landing_lease") return { took: false as const, why: parsed.detail };
          if (parsed && parsed.status >= 400 && parsed.status < 500) throw new NonRetryableError(parsed.detail);
          throw error;
        }
      });
      if (ask.took) {
        if (record) {
          await step.do(`record the lease step ${label}`, RETRIES, async () => {
            await this.note(L, p, "lease", Math.max(0, Date.now() - ask.t0), ask.expired ? { expired: ask.expired } : {});
            return {};
          });
        }
        return;
      }
      if (i + 1 >= maxAsks) {
        await step.do(`leave the landing queue ${label}`, RETRIES, async () => { await L.queueProjectLanding(p.item, p.actor, true); return {}; });
        throw new NonRetryableError(`the landing lease was not ${p.item}'s within ${span(p.wait)}: ${ask.why}. Nothing was changed; run atelier land ${p.item} --workflow again to queue once more`);
      }
      await step.sleep(`wait for the landing lease ${label} #${i}`, p.poll);
    }
  }

  // The holder's heartbeat and its loss, asked inside a step: a renewal
  // the server refuses says another landing holds the lease now, and this
  // landing stops without accepting or merging beside it (t232); a renewal
  // that cannot be asked retries with the step.
  private async renewOrStop(L: LedgerStub, p: Landing): Promise<void> {
    try {
      await L.renewProjectLanding(p.item, p.actor);
    } catch (error) {
      const parsed = parseRuleError(error);
      if (parsed && (parsed.code === "no_lease" || parsed.code === "landing_lease")) {
        throw new NonRetryableError(`another landing took the landing lease of ${p.project} over, so this landing stops without accepting or merging ${p.item}: the server said "${parsed.detail}". Nothing was merged; run atelier land ${p.item} --workflow again once the other landing ends.`);
      }
      throw error;
    }
  }

  private async release(step: WorkflowStep, L: LedgerStub, p: Landing, name: string): Promise<void> {
    await step.do(name, RETRIES, async () => {
      try { await L.cancelProjectLanding(p.item, p.actor); } catch (err) { if (parseRuleError(err)?.code === "landing_lease") return { handedOver: true }; throw err; }
      return { released: true };
    });
  }

  // ── the workspace steps, on the machine that holds the workspace ──────

  // Waits for the executor's report of this round. A report naming another
  // round (one the Workflow buffered from an earlier pass) is passed over,
  // and the wait goes on. A report that a step failed carries the CLI's own
  // message, which already says what to do; one of conflicts pauses the
  // landing (run, above).
  private async waitForWorkspace(step: WorkflowStep, p: Landing, round: number): Promise<{ head: string; mainHead: string | null; mergedIn: boolean } | { conflict: true; files: string[]; reason: string }> {
    const chunks = Math.max(1, Math.ceil(p.workspace / EVENT_CHUNK_MS));
    for (let i = 0; ; i++) {
      let payload: WorkspaceReport | null = null;
      try {
        const got = await step.waitForEvent<WorkspaceReport>(`wait for the workspace r${round} #${i}`, { type: "workspace", timeout: Math.min(EVENT_CHUNK_MS, p.workspace) });
        payload = got.payload as WorkspaceReport;
      } catch { /* nothing in this chunk; the next chunk waits on */ }
      if (payload && payload.round === round) {
        if (payload.failed === true) throw new NonRetryableError(String(payload.reason ?? "a workspace step of the landing failed").slice(0, 2000));
        if (payload.conflict === true) {
          const files = Array.isArray(payload.files) ? payload.files.map(String) : [];
          return { conflict: true, files, reason: String(payload.reason ?? `the merge of main stopped on conflicts in ${files.join(", ")}`).slice(0, 2000) };
        }
        const head = String(payload.head ?? "");
        if (!HASH.test(head)) throw new NonRetryableError(`the workspace report is malformed (its head is not a commit hash); run atelier land ${p.item} --workflow again`);
        const mainHead = String(payload.mainHead ?? "");
        return { head, mainHead: HASH.test(mainHead) ? mainHead : null, mergedIn: payload.mergedIn === true };
      }
      if (i + 1 >= chunks) {
        throw new NonRetryableError(`the workspace did not report the merge of main and the push within ${span(p.workspace)}, so the landing stops without submitting ${p.item}; the lease is released and nothing was merged. Run atelier land ${p.item} --workflow again from the machine holding its workspace`);
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

  // Starts the container run the sandbox route starts (refusing the same
  // checks it refuses), with a run id named by this instance and head, so a
  // retry of the step resumes the run it began (CheckRunner.start answers
  // an existing run as it stands), and polls it to its end. A project with
  // no required checks skips the container, recorded as skipped.
  private async runChecks(step: WorkflowStep, L: LedgerStub, p: Landing, head: string): Promise<void> {
    const started = await step.do("run the required checks in a Cloudflare container", RETRIES, async () => {
      const item = await L.item(p.item);
      const project = await L.project();
      if (item.head !== head) throw new NonRetryableError(`${p.item}'s head moved to ${short(item.head)}; start the landing again`);
      if (!project.policy.checks.length) return { none: true as const, t0: Date.now(), runId: "", seconds: 0 };
      if (!item.fork || !item.head) throw new NonRetryableError(`${p.item} has nothing pushed to check`);
      const refused = project.policy.checks.flatMap((claim) => { const why = refusalOf(claim); return why ? [refusalText(claim, why)] : []; });
      if (refused.length) throw new NonRetryableError(`${refused.join(". ")}. The project owner replaces it with atelier init --check; the landing Workflow runs checks only in the container, so land ${p.item} without --workflow until then.`);
      const planFork = item.kind === "part" && item.plan ? (await L.item(item.plan)).fork : null;
      const runId = `${p.key}:${p.item}:${head.slice(0, 12)}:wf-${p.instance}`;
      const request: RunRequest = {
        runId, project: p.key, itemId: p.item,
        baselineRepo: baseRepoOf(item, project.repo, planFork),
        fork: item.fork, head, checks: [...project.policy.checks], requestedBy: p.actor,
        ...(project.policy.checkPaths?.length ? { checkPaths: project.policy.checkPaths } : {}),
      };
      if (p.origin) await L.setNotificationOrigin(p.item, p.origin);
      await this.env.RUNNER.get(this.env.RUNNER.idFromName(runId)).start(request);
      return { none: false as const, t0: Date.now(), runId, seconds: project.policy.checks.length * 600 + 120 };
    });
    if (started.none) {
      await step.do("record the check step", RETRIES, async () => { await this.note(L, p, "check", Date.now() - started.t0, { skipped: true }); return {}; });
      return;
    }
    const maxPolls = Math.max(1, Math.ceil((started.seconds + 300) * 1000 / p.poll));
    for (let i = 0; ; i++) {
      const state = await step.do(`read the check run #${i}`, RETRIES, async () => {
        const s = await this.env.RUNNER.get(this.env.RUNNER.idFromName(started.runId)).state();
        // A step returns serializable state alone, narrowed to what the
        // decision below reads.
        return s ? { status: s.status, error: String(s.error ?? ""), recorded: s.recorded === true, results: (s.results ?? []).map((r) => ({ claim: r.claim, passed: r.passed, outputTail: String(r.outputTail ?? "") })) } : null;
      });
      if (state?.status === "done") {
        const failed = state.results.filter((r) => r.passed === false);
        await step.do("record the check step", RETRIES, async () => {
          await this.note(L, p, "check", Date.now() - started.t0, failed.length ? { failed: true, reason: failed.map((r) => r.claim).join(", ").slice(0, 500) } : {});
          return {};
        });
        if (!state.recorded) throw new NonRetryableError(`the checks ran but the ledger did not record them; run atelier land ${p.item} --workflow again`);
        if (failed.length) {
          const why = failed.map((r) => `${r.claim} (${r.outputTail.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 200)})`).join("; ");
          throw new NonRetryableError(`the required checks failed at ${short(head)} in the Cloudflare container: ${why}. The merge of main stays in the workspace; fix the failures, commit, and run atelier land ${p.item} --workflow again`);
        }
        return;
      }
      if (state?.status === "failed") throw new NonRetryableError(`the check run failed: ${state.error || "unknown error"}. Run atelier land ${p.item} --workflow again`);
      if (i + 1 >= maxPolls) throw new NonRetryableError(`the checks were still ${state?.status ?? "unread"} after ${span(maxPolls * p.poll)}; run atelier land ${p.item} --workflow again`);
      await step.sleep(`wait for the check run #${i}`, p.poll);
    }
  }

  private async review(step: WorkflowStep, L: LedgerStub, p: Landing, head: string): Promise<void> {
    const ask = await step.do("request the review", RETRIES, async () => {
      const pool = await this.env.LEDGER.get(this.env.LEDGER.idFromName("__index")).models();
      try {
        const r = await L.requestReview(p.item, p.actor, p.reviewer, pool, p.reviewer !== null);
        return { needed: r.needed, reason: r.reason, at: r.at ?? new Date().toISOString(), reviewer: r.reviewer ?? null };
      } catch (error) {
        throw new NonRetryableError(this.refusal(error));
      }
    });
    if (!ask.needed && p.reviewer) throw new NonRetryableError(`the server made no review request for ${p.reviewer} (${ask.reason}); ${p.item} stays submitted`);
    if (!ask.needed) {
      await step.do("record the review none needed", RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: "none-needed", reason: String(ask.reason ?? "").slice(0, 500) }); return {}; });
      return;
    }
    const maxPolls = Math.max(1, Math.floor(p.review / p.poll));
    for (let i = 0; ; i++) {
      const poll = await step.do(`wait for the verdict #${i}`, RETRIES, async () => {
        await this.renewOrStop(L, p);
        // The Ledger's detail is a wide view; the step keeps what it reads.
        const d = (await L.detail(p.item)) as unknown as { item: { head: string | null }; reviews: LandingReview[] };
        if (d.item.head !== head) throw new NonRetryableError(`${p.item}'s head moved to ${short(d.item.head)} while waiting for the review; start the landing again`);
        const { verdict } = landingVerdict(d.reviews ?? [], head, ask.at);
        return verdict ? { approve: verdict.approve, by: verdict.by, note: String(verdict.note ?? ""), tier: verdict.tier === true } : null;
      });
      if (poll) {
        if (!poll.approve) {
          await step.do("record the rejected review", RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: "reject", reviewer: poll.by, resolvedBy: poll.by }); return {}; });
          throw new NonRetryableError(`${poll.by}${poll.tier ? " (tier review)" : ""} rejected ${p.item} at ${short(head)}: ${poll.note || "(no note)"}. The task goes back to its holder with the findings; the merge of main stays in its workspace`);
        }
        await step.do("record the approved review", RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: "approve", reviewer: poll.by, resolvedBy: poll.by }); return {}; });
        return;
      }
      if (i + 1 >= maxPolls) {
        await step.do("record the review timeout", RETRIES, async () => { await this.note(L, p, "review", 0, { verdict: "timeout", ...(ask.reviewer ? { reviewer: ask.reviewer } : {}) }); return {}; });
        throw new NonRetryableError(`no verdict${ask.reviewer ? ` from ${ask.reviewer}` : ""} within ${span(p.review)}; the review request stays open and ${p.item} stays submitted. Review by hand, then atelier accept ${p.item} and atelier merge ${p.item}, or run atelier land ${p.item} --workflow again to wait once more`);
      }
      await step.sleep(`wait for the verdict to settle #${i}`, p.poll);
    }
  }

  // Watches the Ledger for the merge the executor records. The wait leaves
  // the lease unrenewed, so a checkout that never comes (a closed laptop)
  // does not hold the project: the lease lapses after its expiry, a merge
  // refused meanwhile because another landing took it (t232) is retried by
  // the executor, and this wait times out into the by-hand command.
  private async waitForMerge(step: WorkflowStep, L: LedgerStub, p: Landing): Promise<void> {
    const maxPolls = Math.max(1, Math.floor(p.merge / p.mergePoll));
    for (let i = 0; ; i++) {
      const done = await step.do(`wait for the merge #${i}`, RETRIES, async () => (await L.item(p.item)).state === "merged");
      if (done) return;
      if (i + 1 >= maxPolls) {
        throw new NonRetryableError(`${p.item}'s merge was not recorded within ${span(p.merge)}; it stays accepted. Merge it by hand: atelier merge ${p.item}`);
      }
      await step.sleep(`wait for the merge to record #${i}`, p.mergePoll);
    }
  }

  // ── small pieces ──────────────────────────────────────────────────────

  private refusal(error: unknown): string {
    const parsed = parseRuleError(error);
    return parsed ? parsed.detail : String((error as Error)?.message ?? error);
  }

  // A land.* event, recorded as the CLI records it: a ledger that cannot
  // take it does not fail the step that did the work.
  private async note(L: LedgerStub, p: Landing, kind: string, ms: number, data: Record<string, unknown>): Promise<void> {
    try { await L.landEvent(p.item, p.actor, kind, Math.max(0, Math.round(ms)), data); } catch { /* the record is not the step */ }
  }
}

type LedgerStub = ReturnType<Env["LEDGER"]["get"]>;
type Landing = {
  project: string; key: string; item: string; actor: string; instance: string;
  reviewer: string | null; noReview: boolean; origin?: string;
  poll: number; mergePoll: number; wait: number; workspace: number; conflict: number; review: number; merge: number;
};
