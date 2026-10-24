import { executePostMerge } from "./post-merge.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkEnv } from "./check-env.mjs";
import { runGroup } from "./group.mjs";
import { describeConflicts, mergeThrough, previewMerge } from "./merge-pipeline.mjs";
import { excludeScratch } from "./scratch.mjs";
import { runCommand } from "./ship.mjs";
import { COMMAND_CAPABILITIES, checkCapabilities } from "../src/route-level.ts";
import { LANDING_LEASE_EXPIRY_MS, landingLeaseLapsed } from "../src/landing-lease.ts";
import { assign, liveOffers, unoffered } from "../src/dispatch/rules.ts";
import { fenceText, prereviewClause } from "../src/dispatch/prereview.ts";
import { contributorsOf, roleRefusal, sameActor } from "../src/rules.ts";
import { approvalsMissing, landingVerdict, allSkipped, recordedApproval, rejectionText, reviewStall } from "../src/landing-verdict.ts";
import { criteriaOf } from "../src/criteria.ts";
import { decideTriage, parseTriage, recordedTriage, resolveTriage, sameBinding, triageBrief, triageCriteria, triageLines, triageModelRefusal, triageRecord } from "../src/review/triage.ts";
import { WORKSPACE_REASON_MAX, effectiveFailures, failureDetail, failureSummary, resolveFailures } from "../src/check-failure.ts";
import { DETECTOR_ENV, describeAmbiguous, describeFinding, detectMovedEditsAsync, findingKey } from "../src/moved-code.ts";
import { appendMovedCodeRecord, prepareRecordedWorkspace } from "./landing.mjs";
import { workspaceNotice } from "./review-notice.mjs";

// atelier land (t187): the project owner lands one task whole, taking the
// project's landing lease on the server so two sessions never race main.
//
// Review before the runway (t550): the lease is held for the merge alone.
// The merge of main, the push, the triage, the checks, the submission and
// the review below all run without it, beside any other task's landing, so
// two landings check and review at the same time and only their merges
// take turns; a conflict, a failed check, a stopped triage or a rejection
// ends the landing with the lease never taken. Once the gate holds the
// pushed head with its checks passing and an approval it counts, the
// landing queues for the lease (every landing, --wait or not, since what it
// waits behind is a merge), confirms under it that main is still the commit
// the head was merged with, checked and reviewed against, and accepts and
// merges. Where main moved meanwhile it releases the lease without
// accepting and goes again from the merge of main: the review request on
// that round is where the server carries the approval over a merge of
// main that leaves the task's files alone (retainApprovals in
// src/ledger.ts, on the facts src/retention.ts reads), or asks for a new
// review. The lease step records the time spent before the lease and in
// the queue, and the release step the time it was held.
//
// In the task's workspace it merges main (stopping on conflicts, which it
// leaves for the owner to resolve, naming the files — or sends back to the
// task's builder with atelier dispatch ID --job merge-main, whose runner
// merges main again and leaves the conflicts for the builder, where a plain
// rework would reset the workspace to a head that cannot reach main, t243 —
// unless every conflicted file is one the project's regenerate command
// rewrites, when it takes either side, regenerates and goes on), regenerates
// the project's fixtures when its policy declares how, then pushes and runs
// the required checks through the CLI's own commands, each as a child
// process so a failure can still release the lease and record the step. It
// asks the server for the independent review the gate needs, or the one the
// owner names with --reviewer whether or not the gate needs it, and waits
// for the verdict, then accepts and merges. It waits for the gate's review
// only, which the server routes to the review tier first so one review serves
// both; a separate tier review asked beside it (src/review/tier.ts) stops
// the landing when it rejects, never holds it, and the server withdraws a
// tier request still open when the task is accepted. Every step, its duration and the
// commits that came from main are recorded on the ledger as land.* events
// (t186 reads them for the integration cost), and the server must be at this
// CLI's route level or newer, or the landing refuses before it starts,
// saying to deploy.
//
// The merged route level keeps meaning one set of routes (t248): two tasks
// that each raise it from one base merge cleanly to the number they share
// (t238 and t240 both set 8, 2026-10-07; t233 and t236 both set 6 earlier,
// caught by hand), and the number then names the routes of either side
// alone while the merged CLI calls both. Wherever the workspace's HEAD
// holds main the landing therefore compares src/route-level.ts at the
// task's fork point, at the task's head before the merge and at main's
// head — after its own merge, and on a rerun whose conflicted merge the
// owner resolved by hand, which finds main already merged and would else
// skip the comparison — and where each side raised it from the fork
// point, raises the merged level to main's plus the task's own raise,
// commits that as its own commit and says to deploy before the next
// landing, so each number keeps naming the routes of the CLI that
// reports it.
//
// The lease never strands the project (t214): a landing renews it every
// LEASE_RENEW_MS while it runs, the server treats a lease not renewed for
// LANDING_LEASE_EXPIRY_MS (src/landing-lease.ts) as free, SIGINT and SIGTERM
// release it before the command ends, and `atelier land ID --release-lease`
// frees it by hand, saying which task held it since when.
//
// While another task's landing holds the lease, a landing whose head is
// checked and approved queues for it (t223, with or without --wait since
// t550), saying whose landing it waits behind, and takes it as soon as the
// lease is free, so several landings started at once merge in turn.
//
// A landing queued with --wait takes the lease in its turn, not whichever
// queued landing's poll happens to land first (t249): t247 once took it
// ahead of t245, which had waited longer and was the one its plan needed.
// The server keeps a queue of the landings waiting for the lease, one row
// per task in the order they queued, and hands the lease to the first of
// them when it frees. While it waits the landing asks the server again on
// every poll, which refreshes its place, and a landing that stops asking —
// killed, or ended by a signal, or gave up after its limit and left the
// queue — drops out once its last ask is older than the lease's own expiry,
// so the queue never waits on a peer that is gone.
//
// A landing that loses the lease stops (t232): a Mac can sleep through a
// landing, pausing the timers, so the lease lapses and a landing queued with
// --wait takes it over, and the first landing, woken, would otherwise go on
// to accept and merge beside the second. A renewal the server refuses ends
// the landing at the next step (and the wait for a verdict with it), the
// lease is asked for by hand again before the steps that publish to main,
// and the server refuses a merge while another task's landing holds the
// lease (beginLanding), so two landings never race on main however the
// loss is missed.
//
// The release at the end can find the lease another landing's (t237): the
// server treats a merged task's lease as free (landingLive, src/ledger.ts),
// so a landing queued with --wait takes it in the moment between the merge
// and this landing's release, and the cancel is refused naming the landing
// that holds it now. That refusal is the handover working as designed, said
// as such rather than warned of: the lease is left with the landing that
// took it, which renews it. Only a release that cannot ask the server
// warns, for then the lease really does stand in this task's name until it
// lapses.
//
// Post-merge work has a durable Ledger reservation, created before publish
// and checked by every merge entry point. CLI and Workflow resolve the same
// run, with a snapshotted policy and before/after SHAs. Lease release, expiry
// and merged task state never release it. Future batching reuses its member
// list and landing identity; it does not change per-merge completion today.
//
// The push uses the workspace's write token, which lapses 8 hours after the
// claim that minted it (t275), and a push refused for it would end a landing
// that has already merged main. So before the merge of main (the Workflow's
// too, whose push runs here, and again on each round) a token
// that has lapsed or lapses within TOKEN_WINDOW_MS is refreshed, and a push
// still refused as expired is refreshed and tried once more. A refresh re-claims
// the task as its current holder, never changing claim ownership; an
// unclaimed task cannot be reclaimed just to obtain credentials.
//
// Before the review is asked for, a landing with a triage model (t475:
// --triage H/M, else the project's triage setting; neither is none) has
// that model read the pushed head's diff against its merge base with main
// and the task's acceptance criteria as they are now, and goes on only when
// it calls every criterion met. Anything else — a criterion not met or
// unsure, no criteria, a reply that cannot be read, a timeout, a model the
// pool refuses or that cannot be run — stops the landing before the task is
// submitted (in a Workflow landing, before the head is reported, so the
// Workflow submits nothing): the findings are shown with the commands to
// run it again, the lease never taken and the task its holder's, its
// work pushed. The owner may bypass the triage (--no-triage REASON) or go
// past a stop (--override-triage REASON); either is recorded on the ledger,
// with the head and the criteria binding, before the landing goes on, and a
// record the server refuses stops it. Triage is kept as land.triage events
// (src/review/triage.ts), never as reviews, so the gate, the review rounds
// and the review rules after it are what they were.
//
// A landing finds edits that main moved to another file (t471): before the
// merge of main, in both landings, the task's head and the freshly fetched
// main are compared with their merge base (src/moved-code.ts), and a task
// edit lying in a block main moved to another file stops the landing with
// Git and the workspace unchanged, naming each source and destination with
// the matching lines and how to port the edits. The plain landing ends, the
// lease never taken; the Workflow landing pauses at its conflict stage,
// holding no lease, with no merge left in the workspace. The
// revisions compared and the merge base are recorded with the merge step,
// and every comparison and approval in the workspace's moved-code log
// (cli/landing.mjs). `--moved-ok` lets the owner go on past exactly the
// findings this run detected, recorded first on the ledger and in that log
// with the owner, the findings and the revisions; findings at other
// revisions (a later round of the Workflow) need a fresh approval, and Git's
// own conflicts still stop the landing. A retry compares afresh, so ported
// edits clear their findings; where main is already merged there is nothing
// to compare, which the landing says rather than implying no move was missed.
//
// A workspace a runner claimed with its runner token pushes through the
// runner route (t488): its origin is ORIGIN/git/runner/PROJECT/ITEM.git, and
// the header it carries is the runner's own Git credential, which the server
// honours for the runner's token and claim alone. The owner's landing cannot
// push there as itself, and the runner's credential lapses with the runner
// token, not with the task's write token. So before the lease, and before a
// Workflow starts — for a task not yet accepted, whatever expiry the
// workspace records — a runner route found as origin's fetch or push URL is
// re-claimed for the task's holder with its runner identity, under the
// owner's credential, which the server answers with the fork remote and a
// write token of its own; the fork replaces the route as origin's one
// destination, the route's header goes with it, the expiry is recorded and
// the fork is fetched, all before anything is leased, pushed or started. The
// next landing finds the fork and refreshes nothing it need not. A holder the
// workspace was not claimed by, a re-claim the server refuses, a claim that
// answers no remote or token, or a remote that cannot be adopted stops the
// landing there, with the commits untouched; a dry run reads the remotes and
// writes nothing.

const POLL_MS = Number(process.env.ATELIER_LAND_POLL_MS ?? 5000);
// How long a wait on a landing Workflow keeps reading it again after reads
// fail, backing off between tries, before it gives up (t368: one failed read
// of a live instance ended a wait that a minute later attached to it).
const READ_WINDOW_MS = Number(process.env.ATELIER_LAND_READ_WINDOW_MS ?? 5 * 60_000);
const READ_BACKOFF_MAX_MS = 30_000;
// The review wait outlasts a build on the runner (its task timeout is 45
// minutes), since a review queues behind every older build.
const REVIEW_TIMEOUT_MS = Number(process.env.ATELIER_LAND_REVIEW_TIMEOUT ?? 60 * 60_000);
const CHECK_TIMEOUT_MS = Number(process.env.ATELIER_CHECK_TIMEOUT ?? 20 * 60_000);
const LEASE_RENEW_MS = Number(process.env.ATELIER_LAND_RENEW_MS ?? 60_000);
// How long --wait queues for the landing lease before it gives up, so a
// landing left holding the lease does not keep a queued one waiting for ever.
const WAIT_TIMEOUT_MS = Number(process.env.ATELIER_LAND_WAIT_TIMEOUT ?? 3 * 60 * 60_000);
// A write token lapsing within this span is refreshed before the lease, so
// it outlasts the merge, the regeneration and the push that follow.
const TOKEN_WINDOW_MS = Number(process.env.ATELIER_LAND_TOKEN_WINDOW_MS ?? 30 * 60_000);
// How long the triage model may take before the landing stops for it.
const TRIAGE_TIMEOUT_MS = Number(process.env.ATELIER_LAND_TRIAGE_TIMEOUT ?? 30 * 60_000);
// How Artifacts refuses a push whose token has lapsed or was revoked.
const EXPIRED_TOKEN = /Invalid or expired token/i;

// How many times main may move under the lease before the landing stops
// (t550): each time it releases the lease, merges main again, checks and
// asks for the review again, so a main that never settles cannot keep a
// landing going round for ever.
const MAIN_MOVED_ROUNDS = Number(process.env.ATELIER_LAND_MAIN_MOVED_ROUNDS ?? 5);
// The capability of a server that reviews before the lease (t550): its
// landing Workflow takes the lease for the merge alone, and its land step
// route records the release step and the time before the lease.
const REVIEW_FIRST = "land.review-first.v1";

const short = (sha) => (sha ? sha.slice(0, 8) : "—");

// A step that failed carries its own event data beside the failure: the files
// a conflict stopped on, or which check failed.
export class StepError extends Error {
  constructor(message, data = {}) { super(message); this.data = data; }
}

export async function runLand(io) {
  const { args, name, id, p, request, git, die, print } = io;
  if (args["post-merge"] === undefined && (args.reason !== undefined || args.resolution !== undefined)) die("--reason and --resolution require --post-merge");
  if (args["post-merge"] !== undefined) {
    if (["dry-run", "release-lease", "no-review", "wait", "reviewer", "workflow", "checks"].some(k => args[k] !== undefined)) die("--post-merge recovery is a separate action; omit the landing flags");
    const action = args["post-merge"];
    if (!["status", "resume", "retry", "skip", "reconcile"].includes(action)) die("--post-merge takes status, resume, retry, skip or reconcile");
    // The recovery calls the post-merge routes alone, so it asks for their
    // capability alone, before its first request to them.
    let version = null;
    try { version = await request("GET", "/version"); } catch { /* a server with no version route is one that predates it */ }
    const check = checkCapabilities(version, ["land.post-merge.v1"]);
    if (!check.ok) die(`${check.message}, then run atelier land ${id} --post-merge ${action} again`);
    const path = `/projects/${encodeURIComponent(name)}/post-merge/${encodeURIComponent(id)}`;
    const { run } = await request("GET", path);
    if (!run) { print("No post-merge run recorded."); return; }
    if (action === "status") { print(JSON.stringify(run, null, 2)); return; }
    if (action !== "resume") {
      const { run: recovered } = await request("POST", path, { run: run.id, action, reason: args.reason, resolution: args.resolution });
      if (action === "skip" && recovered?.state === "reserved") {
        print(`Post-merge run ${recovered.id}: step waived; remaining steps still need diff preparation or a developer waiver.`);
        return;
      }
    }
    if (action !== "reconcile") await executePostMerge({ request, git, name, id, env: io.env, print });
    return;
  }
  const dryRun = args["dry-run"] === true;
  const noReview = args["no-review"] === true;
  const wait = args.wait === true;
  const releaseLease = args["release-lease"] === true;
  const workflow = args.workflow === true;
  const reviewer = args.reviewer;
  const movedOk = args["moved-ok"] === true;
  // A Workflow landing runs the required checks here in a clean clone, as the
  // plain landing does, and the Workflow waits for their observed results.
  // t768 removed the other mode, the Workflow running them in a container;
  // --checks local is still accepted, since it names what now always happens.
  if (args.checks !== undefined && !workflow) die("--checks local is the only mode, and it applies to a Workflow landing; give it with --workflow, or leave it out (the plain landing always runs the checks here, in a clean clone)");
  if (args.checks !== undefined && args.checks !== "local") die(`--checks container is gone: the required checks always run on this machine, in a clean clone (t768). Leave --checks out: atelier land ${id} --workflow`);
  const triageFlags = { triage: args.triage, noTriage: args["no-triage"], override: args["override-triage"] };
  if (releaseLease && (dryRun || noReview || wait || reviewer !== undefined || workflow || movedOk || Object.values(triageFlags).some((v) => v !== undefined))) die("--release-lease frees the project's landing lease and does nothing else; give it alone");
  if (workflow && dryRun) die("--dry-run and --workflow together say two things: --dry-run prints what a landing would do and changes nothing, and --workflow starts the landing as a Cloudflare Workflow that does it; give one or the other");
  if (reviewer !== undefined && (typeof reviewer !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(reviewer))) {
    die(`--reviewer needs harness/model, such as codex/gpt-6-astra: atelier land ${id} --reviewer H/M`);
  }
  if (noReview && reviewer !== undefined) die("--reviewer and --no-review together say two things; name the reviewer, or give --no-review to leave the task submitted");

  const itemPath = `/projects/${encodeURIComponent(name)}/items/${encodeURIComponent(id)}`;
  const leasePath = `/projects/${encodeURIComponent(name)}/landing-lease`;
  const dir = io.workspacePath(name, id);
  const since = (lease) => `${String(lease.at).slice(0, 16).replace("T", " ")} UTC`;
  // The landings queued ahead of this one, as the server's queue holds them
  // (t249): the rows before this landing's own — all of them when it has not
  // queued yet. The server prunes the queue before answering (a row whose
  // landing stopped asking for the expiry's span, or whose task has closed,
  // no longer counts), so they are read as the server judged them; no clock
  // here re-judges them, for one running ahead of the server's would drop a
  // live row. The server decides who takes the lease; this is what the
  // waiting messages say.
  const aheadOf = (waiting) => {
    const rows = Array.isArray(waiting) ? waiting.filter((w) => w && typeof w.item === "string") : [];
    const mine = rows.findIndex((w) => w.item === id);
    return rows.slice(0, mine === -1 ? rows.length : mine);
  };

  // --release-lease: the lease is freed before the version check, since a
  // server older than this CLI still answers the cancel, and a stranded
  // lease is what the owner most needs to free. A lease held for another
  // task is named, with the command that frees it, rather than freed from
  // under that task.
  if (releaseLease) {
    const { lease, postMerge } = await request("GET", leasePath);
    if (!lease) { print(`No landing lease is held in ${name}; nothing to release.`); return; }
    if (lease.item !== id) die(`the landing lease in ${name} is held for ${lease.item}, not ${id}: ${lease.holder} has been landing ${lease.item} since ${since(lease)}. Free it with atelier land ${lease.item} --release-lease`);
    // The cancel names the task, so the server frees ${id}'s lease alone.
    const { lease: freed } = await request("POST", leasePath, { cancel: true, item: id });
    print(`Released the landing lease of ${name}: ${(freed ?? lease).holder} held it for ${id} since ${since(freed ?? lease)}. ${postMerge ? `Post-merge run ${postMerge.id} remains ${postMerge.state}; later merges stay blocked.` : "Another task may land."}`);
    return;
  }

  // The server's capabilities against the ones this command declares
  // (COMMAND_CAPABILITIES, src/route-level.ts): a server short of them would
  // fail the routes one by one, so the landing refuses here instead, naming
  // what is missing and saying to deploy, before the lease or any workspace
  // changes. Which commit either side runs says nothing, since every merge
  // moves the CLI past the deployed one.
  let version = null;
  try { version = await request("GET", "/version"); } catch { /* a server with no version route is one that predates it */ }
  const check = checkCapabilities(version, COMMAND_CAPABILITIES.land);
  if (!check.ok) die(`${check.message}, then run atelier land ${id} again`);
  // A merged task whose post-merge run is still open resumes it (t477); the
  // server publishes the post-merge routes as land.post-merge.v1, which the
  // check above required.
  const detail = await request("GET", itemPath);
  if (detail.item.state === "merged" && detail.postMerge) {
    if (dryRun) { print(`Post-merge run ${detail.postMerge.id} is ${detail.postMerge.state} at ${detail.postMerge.after}; a resume would execute only pending steps.`); return; }
    await executePostMerge({ request, name, id, env: io.env, print });
    return;
  }

  // The lease is read, not taken, so the checks that only refuse are asked
  // before anything changes. A lease held for another live task refuses the
  // landing with who holds it and since when; with --wait (t223) the landing
  // queues behind it instead. The landings queued for the lease come with
  // the read, so a dry run can say where it would queue (t249).
  const { lease, waiting: waitingRows = [] } = await request("GET", leasePath);
  // Whether a lease still guards the project, judged as the server judges
  // it: held for another task, renewed within the expiry, and for a task
  // that is still open. The server decides when the landing asks for the
  // lease below; this machine's clock judges only for the dry run's message
  // and for --wait's queue, which a refusal from the server sends back to
  // waiting.
  const blocking = async (held) => {
    if (!held || held.item === id || landingLeaseLapsed(held, Date.now())) return null;
    let holder = null;
    try { holder = await request("GET", `/projects/${encodeURIComponent(name)}/items/${encodeURIComponent(held.item)}`); } catch { /* an item that cannot be read still holds the lease, as the server sees it */ }
    return holder && ["merged", "abandoned"].includes(holder.item?.state) ? null : held;
  };
  // A lease held by another landing no longer stops a landing from starting
  // (t550): the merge of main, the checks and the review run without the
  // lease, so the holder is only who this landing would wait behind for its
  // merge, which the dry run says.
  const waitingOn = dryRun ? await blocking(lease) : null;

  // The refusals that stop a landing before it takes the lease, each
  // offering the next step. When this task's own lease is still held, from
  // a landing that was killed, each refusal also says how to free it, so no
  // state of the task leaves the lease out of reach (t214). They are asked
  // again after a wait, since the task or its workspace may have changed
  // while it queued; that second asking throws its refusal instead of ending
  // the process at once (throwing), so the landing's own ending leaves the
  // queue it holds a place in, exactly as it releases a lease it took.
  const heldNote = lease && lease.item === id ? ` The landing lease of ${name} is still held for ${id} since ${since(lease)}, from an earlier landing; atelier land ${id} --release-lease frees it.` : "";
  const refuse = (message) => die(message + heldNote);
  let needsPreparation = false;
  const preflight = async (throwing = false, prepare = false) => {
    const no = (message) => { if (throwing) throw new StepError(message + heldNote); refuse(message); };
    const d = throwing ? await request("GET", itemPath) : detail;
    if (["merged", "abandoned"].includes(d.item.state)) no(`${id} is ${d.item.state}; there is nothing to land.`);
    // A plan's branch holds only the integrator's recorded integrations and
    // refreshes; the merge of main a landing makes would put a commit beside
    // them, and planGate refuses a plan whose head is not its integration head.
    if (d.item.kind === "plan") no(`${id} is a plan, which atelier land does not land: a plan lands with atelier merge ${id} --head INTEGRATION_HEAD, the integration head atelier plan show ${id} prints, and a plan branch that is behind main takes main through atelier plan refresh ${id}.`);
    // Through the Workflow an accepted task is not a refusal but a resume:
    // its workspace work is behind it, and the landing goes on from the
    // acceptance (the merge the Workflow waits for).
    // The plain landing finishes it: the accept is held, so the merge is all
    // that is left, and it needs no workspace (t188).
    if (d.item.state === "accepted" && !workflow) return d;
    // Inspect before queuing, but replace a workspace only while holding the lease.
    needsPreparation = await prepareRecordedWorkspace(prepare || dryRun ? io : { ...io, print: () => {} }, { dir, itemPath, detail: d, dryRun: !prepare });
    if (!prepare && needsPreparation) return d;
    if (!existsSync(join(dir, ".git"))) no(`${id} has no workspace on this Mac (${dir}); it has nothing to land. Run atelier claim ${id} --as H/M first, or land a task that has one.`);
    const held = { project: git(["config", "--local", "atelier.project"], { cwd: dir, allowFail: true }).stdout?.trim(), item: git(["config", "--local", "atelier.item"], { cwd: dir, allowFail: true }).stdout?.trim() };
    if (held.project !== name || held.item !== id) no(`${dir} is not ${id}'s workspace (its Git config names ${held.project ?? "no project"}/${held.item ?? "no item"}); land ${id} from the machine holding its workspace.`);
    if (existsSync(join(dir, ".git", "MERGE_HEAD"))) no(`a Git merge is already in progress in ${id}'s workspace; resolve, commit and push it with atelier push (or git merge --abort), then run atelier land ${id} again.`);
    // An agent's notes and a harness's logs under .scratch/ are not work to
    // commit (excludeScratch, t257).
    excludeScratch(dir);
    if (git(["status", "--porcelain"], { cwd: dir })) no(`${id}'s workspace has uncommitted changes; commit or set them aside before landing.`);
    return d;
  };
  let d0 = await preflight();
  // A landing a blocking pre-review fenced (t524) is refused the lease until
  // `atelier unblock`; said here, before a merge, a check or a review is
  // spent on a landing that could not take the lease for its merge.
  if (d0.prereviewFence) refuse(fenceText(id, d0.prereviewFence));
  if (d0.item.head) print(`Landing ${id} from recorded source ${d0.item.head}.`);
  // A reviewer who contributed to the task can never review it, whatever the
  // change class, so the ledger's answer is known before the lease is taken
  // or a check runs (t354). Same-family contributors are left to the server:
  // only a protected change refuses them, and the class is not known yet.
  if (reviewer !== undefined) {
    const contributed = contributorsOf(d0.item).find((c) => sameActor(c, reviewer));
    const single = d0.policy?.familyMode?.single ?? null;
    if (contributed) die(`${reviewer} contributed to ${id} (as ${contributed}) and cannot review it; name another reviewer with --reviewer H/M, ${single ? `a different ${single} model from every contributor (single-family mode)` : "of another family than every contributor"}.`);
    // A reviewer the project's policy would not count is refused before the
    // lease or a check runs (t405): under a governed policy an agent marked
    // unavailable or without the assessor role, otherwise an ineligible
    // harness, whose approval would not be the independent review the gate
    // counts. The refusal names the agents that would count.
    if (d0.policy) {
      const refusal = roleRefusal(reviewer, d0.policy, "assessor", d0.ownerActor);
      if (refusal) die(`${reviewer}'s approval would not count in ${name}: ${refusal}. Name another reviewer with --reviewer H/M. The developer can admit a registered model with atelier models admit ID --project ${name} --reason TEXT.`);
    }
  }
  const regenerate = typeof d0.policy?.regenerate === "string" ? d0.policy.regenerate : null;
  // The triage this landing runs: --triage, then the project's setting (its
  // policy's, else this Mac's registration of the project), else none.
  // Conflicting flags are refused here, before the lease or any change.
  const triage = resolveTriage({ ...triageFlags, project: d0.policy?.triage ?? p?.triage ?? undefined });
  if ("error" in triage) die(triage.error);
  // A review the change will need is said now, before the lease, the merge
  // and the checks, with the policy that requires it (t422). A dry run skips
  // it: measuring needs a baseline fetch into the workspace, and a dry run
  // changes nothing.
  if (!noReview && !dryRun && !needsPreparation) {
    const baseline = await request("POST", `/projects/${encodeURIComponent(name)}/items/${encodeURIComponent(id)}/base-token`, { scope: "read" }).catch(() => undefined);
    const notice = workspaceNotice((argv, o) => git(argv, { allowFail: true, ...o }), dir, d0.policy, { baseline, part: d0.item?.kind === "part" });
    if (notice) for (const line of notice) print(line);
  }
  // The moved-code comparison's state across this run's merges of main: the
  // owner's --moved-ok, the approval it recorded (revisions and findings),
  // and the command a stopped landing is run again with.
  const moved = { ok: movedOk, approved: null, again: `atelier land ${id}${workflow ? " --workflow" : ""}` };

  if (dryRun && d0.item.state === "accepted") {
    print(`Dry run: ${id} is accepted at ${short(d0.item.acceptedHead)}; atelier land ${id} would take the landing lease, merge it in ${p.path} (fetching again after a transient failure) and release the lease. Nothing was changed.`);
    return;
  }
  if (dryRun) {
    // Where the dry run would wait: behind the holder of the lease, and
    // behind the landings queued for it ahead of this one (t249).
    const ahead = aheadOf(waitingRows);
    const queuedAhead = ahead.length ? `${ahead.length} landing${ahead.length === 1 ? "" : "s"} queued ahead of ${id}: ${ahead.map((w) => `${w.item} (queued ${since(w)})`).join(", ")}` : null;
    print(`Dry run: atelier land ${id} in ${name} would:`);
    const route = d0.item.state === "accepted" ? null : runnerRouteOf(io, dir);
    if (route) print(`  (first) re-claim ${id} for its holder ${d0.item.owner ?? "(its workspace's builder)"}${d0.item.runner ? ` on ${d0.item.runner}` : ""}, since its workspace ${routeUse(io, dir, route)} the runner route ${shownRemote(route)} with the runner's Git credential, and take the fork remote and write token the claim answers as origin (a dry run claims nothing and leaves the workspace's remotes and credentials as they are)`);
    print(`  Without the landing lease (t550), beside any other task's landing:`);
    print(`  1. merge main into ${id}'s workspace (${dir}) once a comparison from their merge base finds none of ${id}'s edits in code main moved to another file (one it finds stops the landing before the merge, naming source and destination${movedOk ? "; --moved-ok records your approval of exactly the findings it detects, then goes on" : ""}), through the merge pipeline: declared record files unite by key and declared generated outputs are regenerated once the sources merge; on source or record conflicts, stop before generating anything and leave them for you to resolve, naming the files, or send them to the task's builder: atelier dispatch ${id} --job merge-main; where main and the task each raised the route level (src/route-level.ts) from one base, raise the merged level past both, wherever the workspace's HEAD holds main — this landing's own merge, a rerun of one you resolved by hand, or a merge that brought main in through a side branch`);
    const preview = await previewLanding(io, { dir, id, name });
    if (preview) print(`     ${preview.split("\n").join("\n     ")}`);
    print(`  2. ${regenerate ? `regenerate the project's fixtures with \`${regenerate}\` and commit what changes; where the project declares no merge manifest, a merge that conflicts only in files that command rewrites is settled by taking either side and regenerating` : "regenerate nothing (the project declares no regenerate command)"}`);
    print(`  3. push the merged head to ${id}'s fork`);
    print(`  4. ${await dryRunTriage(io, triage, d0.item)}run the required checks (${d0.policy?.checks?.join(", ") || "none"}) in a clean clone of the pushed head`);
    print(`  5. submit ${id} with a summary of the merge`);
    print(noReview
      ? "  6. skip the review (--no-review): leave the task submitted for you to settle by hand, never taking the lease"
      : `  6. ${reviewer ? `ask ${reviewer} to review` : "ask the server for the independent review the gate needs and wait for"} the verdict at the pushed head, for up to ${Math.round(REVIEW_TIMEOUT_MS / 60000)} minutes; a rejection, a failed check or a conflict ends the landing here, the lease never taken`);
    if (!noReview) {
      print(`  Then, with the head checked and approved, for the merge alone:`);
      print(`  7. ${waitingOn || queuedAhead ? `wait behind ${[waitingOn ? `${waitingOn.holder}'s landing of ${waitingOn.item} (since ${since(waitingOn)})` : null, queuedAhead].filter(Boolean).join(", and ")} (as the lease stands now), then ` : ""}take the project's landing lease for ${id} (one merge at a time in ${name}, in the order the landings queued)`);
      print(`  8. confirm main is still the commit merged in step 1; if it moved, release the lease without merging and go again from step 1, where the server says whether the approval carries over the clean merge of main or asks for a new review`);
      print(`  9. accept ${id} at the pushed head`);
      print(` 10. merge ${id} in ${p.path} and publish the merge to the baseline`);
    }
    print(`${noReview ? "  7" : " 11"}. record each step, its duration, the commits from main, the time before the lease and the time holding it as land.* events${noReview ? "" : `; release the lease (renewed every ${Math.round(LEASE_RENEW_MS / 1000)}s meanwhile, and released on SIGINT or SIGTERM)`}`);
    print("Nothing was changed.");
    return;
  }

  // The Workflow landing (t280): everything below is the CLI's own
  // pipeline, unchanged; --workflow hands the same pipeline to a
  // Cloudflare Workflow and stays as its executor instead. --wait needs
  // no separate handling there: the Workflow queues for the lease by
  // itself, in the order the landings asked.
  if (workflow) {
    // A Workflow from before t550 takes the lease first and expects this
    // executor to renew it through the workspace steps, which this one no
    // longer does; such a server is told to deploy rather than lapse.
    const reviewFirst = checkCapabilities(version, [REVIEW_FIRST]);
    if (!reviewFirst.ok) die(`${reviewFirst.message}, then run atelier land ${id} --workflow again (or land without --workflow, which needs no deploy)`);
    if (wait) print("--wait is the Workflow's own behaviour: it queues for the lease in the order the landings asked, and takes it when its turn comes.");
    if (!needsPreparation) await ensureWorkspaceToken(io, { dir, id, itemPath, item: d0.item });
    return runLandWorkflow(io, { d0, itemPath, dir, regenerate, triage, moved });
  }
  if (!needsPreparation) await ensureWorkspaceToken(io, { dir, id, itemPath, item: d0.item });

  // From here every failure throws rather than dying, so a lease taken is
  // released and the step recorded before the command ends. The recorder
  // is the module's own (below), shared with the Workflow executor (t280).
  const record = landRecorder(io, itemPath);
  // Whether the server records the time a landing held the lease (the
  // release step) and the time before it (t550); an older server refuses
  // both, so they are printed here alone rather than warned of.
  const timing = Array.isArray(version?.capabilities) && version.capabilities.includes(REVIEW_FIRST);
  // The heartbeat renews the lease while the landing holds it; the timer
  // never keeps the process alive on its own (unref), and a renewal the
  // server refuses says the lease is no longer this landing's, which is
  // reported once rather than retried.
  let leased = false, beating = false, takenOverBy = null, everQueued = false, leasedAt = null, heldMs = 0;
  // A landing waiting for the lease leaves the server's queue when its wait
  // ends without a lease, so the landings behind it do not wait for a peer
  // that no longer waits; one that took the lease has no row to leave (its
  // taking spent it). A leave that cannot be asked only costs the wait, not
  // the order: the row lapses on its own once the expiry passes without an
  // ask.
  const leaveQueue = async () => {
    try { await request("POST", leasePath, { item: id, queued: true, leave: true }); }
    catch { /* the row lapses on its own after the expiry */ }
  };
  // `why` is what the release step records: the merge, main moving under
  // the lease, or the failure that ended the landing. Releases run one at a
  // time, and each caller waits for every release asked before its own
  // (t590): one marks the lease released before the server answers its
  // cancel, so a second caller (a signal during the failed landing's
  // release, or a second signal during the first's) that found nothing left
  // to release would otherwise go on, and end the landing, while the
  // cancel is still unanswered.
  let releasing = Promise.resolve();
  const release = (why = "the landing ended") => {
    const next = releasing.then(() => releaseNow(why));
    releasing = next.catch(() => {});
    return next;
  };
  const releaseNow = async (why) => {
    beating = false;
    if (everQueued && !leased) { everQueued = false; await leaveQueue(); }
    if (!leased) return;
    leased = false;
    const held = Date.now() - leasedAt;
    heldMs += held;
    // The cancel names this task: a lease that lapsed, or whose task has
    // merged, was free for another landing to take, and the server leaves
    // the taker's lease alone. A refusal naming that landing is the
    // handover (t237) — a landing waiting for the lease took it in the
    // moment after this task's merge, before this release — so it is said
    // as such, not warned of: the lease stands with the landing that took
    // it, which renews it. Any other failure (the server unreachable or
    // failing) warns as before, for then the lease is still this task's
    // until it lapses.
    try { await request("POST", leasePath, { cancel: true, item: id }); }
    catch (error) {
      const taken = error.status === 409 ? /^landing_lease: the landing lease is held for ([^,\s]+), not /.exec(error.message) : null;
      if (taken) {
        takenOverBy = taken[1];
        print(`The landing lease of ${name} is held for ${takenOverBy}'s landing now, so this release left it alone: the server treats a merged task's lease (a lapsed one the same way) as free, so a landing waiting for it takes it in the moment after the merge, and that landing holds and renews it. Nothing of ${id}'s landing is stranded.`);
      } else print(`Warning: the landing lease could not be released; a later landing of ${id} takes it over, and it lapses on its own after ${Math.round(LANDING_LEASE_EXPIRY_MS / 60000)} minutes: ${error.message}`);
    }
    if (timing) await record("release", held, { reason: why });
  };
  // A signal releases the lease, then ends the command with the signal's
  // conventional status, so a landing stopped by Ctrl-C or kill leaves no
  // lease behind. A Ctrl-C reaches the step's child process through the
  // process group as well. Before the lease nothing is held, so a signal
  // releases no lease, but it leaves the queue the landing holds a place in
  // (t249). A terminal hang-up is taken the same way, so the regenerate
  // command's group (runRegenerateIn) ends with the landing.
  //
  // The signal also SIGKILLs the process group of the step under way
  // (cli/group.mjs), so that step fails while the release is still asked,
  // and the landing's failure path below runs beside it. That path waits
  // for the signal's ending (`stopping`) rather than end the landing itself
  // with exit 1, the lease still held (t590). The signal's release waits
  // for any release already in flight (above). The handlers stay for the
  // signals that follow (t590): a second one, of any kind, says the release
  // is still going and keeps waiting for it, so a second Ctrl-C does not
  // end the landing with the cancel unanswered; a third forces the exit,
  // and the lease then lapses on its own, as an unreleased lease does. The
  // first signal's status stands unless the exit is forced.
  let stopping = null, signals = 0;
  const statusOf = (signal) => signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
  const lapses = `The landing lease of ${name} lapses on its own after ${Math.round(LANDING_LEASE_EXPIRY_MS / 60000)} minutes, unless atelier land ${id} --release-lease frees it first.`;
  const onSignal = (signal) => {
    signals++;
    if (stopping && signals === 2) return print(`${signal} received again; still releasing the landing lease of ${name}; press again to force quit, and the lease then lapses on its own.`);
    if (stopping) { print(`${signal} received a third time; quitting without waiting for the release. ${lapses}`); process.exit(statusOf(signal)); }
    print(`${signal} received; releasing the landing lease of ${name}…`);
    stopping = release(`${signal} ended the landing`).finally(() => process.exit(statusOf(signal)));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, onSignal);

  // The wait for the lease, once the head is checked and approved (t550):
  // the landing polls for the lease until no live task holds it and no
  // landing queued earlier still waits, saying whose landing it waits
  // behind each time that changes, and gives up after WAIT_TIMEOUT_MS from
  // when it began to queue. Each poll asks the server as a landing queued
  // for the lease (t249): the ask refreshes this landing's place in the
  // server's queue — the order the landings queued, which the lease is
  // handed down — and answers the lease and the queue as the server sees
  // them. Nothing is taken by an ask, so ending the command while it
  // queues leaves no lease to release, only the queue place, which a leave
  // (above) or the expiry clears. Every landing waits its turn here, --wait
  // or not: what it waits behind is another landing's merge, never its
  // checks or its review.
  let queuedSince = null;
  const timedOut = async (current, first = null) => {
    await leaveQueue();
    everQueued = false;
    const within = WAIT_TIMEOUT_MS < 60_000 ? `${Math.round(WAIT_TIMEOUT_MS / 1000)} seconds` : `${Math.round(WAIT_TIMEOUT_MS / 60_000)} minutes`;
    throw new StepError(current || !first
      ? `the landing lease was not free within ${within}${current ? `: ${current.holder} still holds it for ${current.item}` : ""}. ${id} is checked and approved but not merged; run atelier land ${current?.item ?? id} again to finish or release that landing, or free it with atelier land ${current?.item ?? "ID"} --release-lease, then atelier land ${id} again`
      : `the landing lease was not ${id}'s within ${within}: ${first.holder}'s landing of ${first.item} is still first in the queue for it. ${id} is checked and approved but not merged; run atelier land ${id} again to queue once more, or wait for ${first.item}'s landing to take the lease and finish`);
  };
  let shown = null;
  const queue = async () => {
    everQueued = true;
    for (;;) {
      const { lease: held, waiting = [] } = await request("POST", leasePath, { item: id, queued: true });
      const current = await blocking(held);
      const ahead = aheadOf(waiting);
      if (!current && !ahead.length) return;
      const list = ahead.map((w) => `${w.item} (queued ${since(w)})`).join(", ");
      // This landing's own pre-review (t524), as the server's queue row
      // carries it: said with the wait line, and again whenever it changes.
      const own = (Array.isArray(waiting) ? waiting : []).find((w) => w?.item === id)?.prereview;
      const pre = own && typeof own.request === "number" && own.binding ? ` Its ${prereviewClause(own)}.` : "";
      const key = `${current?.holder ?? ""} ${current?.item ?? ""} ${current?.at ?? ""}|${list}|${pre}`;
      if (key !== shown) {
        print((current
          ? `Waiting behind ${current.holder}'s landing of ${current.item} (since ${since(current)})${ahead.length ? `, with ${ahead.length} landing${ahead.length === 1 ? "" : "s"} queued ahead of ${id}: ${list}` : ""}; ${id} takes the lease for its merge ${ahead.length ? "when its turn comes, in the order the landings queued" : "as soon as the lease is free"}.`
          : `Waiting for the lease behind ${ahead.length} landing${ahead.length === 1 ? "" : "s"} queued ahead of ${id}: ${list}; ${id} takes the lease for its merge when its turn comes, in the order the landings queued.`) + pre);
        shown = key;
      }
      if (Date.now() - queuedSince >= WAIT_TIMEOUT_MS) await timedOut(current, ahead[0] ?? null);
      await new Promise((ok) => setTimeout(ok, POLL_MS));
    }
  };
  // Takes the lease, queueing for it while another landing's merge holds
  // it or landings queued earlier wait. Answers how long it waited in the
  // queue and how long the taking itself took.
  const takeLease = async () => {
    const asked = Date.now();
    queuedSince = asked;
    shown = null;
    let queued = false;
    for (;;) {
      if (queued) await queue();
      const ask = Date.now();
      try {
        const { item, expired } = await request("POST", leasePath, { item: id });
        leased = true;
        everQueued = false;
        leasedAt = Date.now();
        if (expired) print(`Took over the landing lease of ${name} from ${expired.holder}, which had been landing ${expired.item} since ${since(expired)} and stopped renewing it ${Math.round((Date.now() - Date.parse(expired.renewedAt ?? expired.at)) / 60000)} minutes ago; that landing is treated as ended.`);
        print(`Landing lease taken for ${id} (${item.state}) for its merge alone; one merge at a time in ${name}.`);
        return { waited: ask - asked, took: leasedAt - ask };
      } catch (error) {
        const refused = /^(landing_lease|post_merge_blocked): /.test(error.message);
        // Another landing holds the lease, another queued landing took it
        // between the poll and this request, the server judged live a lease
        // this machine's clock judged lapsed, or a landing that queued
        // earlier is still first for it (t249), or another landing's
        // post-merge work is still running (t477): this one waits a beat and
        // queues again behind it.
        if (refused) {
          if (Date.now() - queuedSince >= WAIT_TIMEOUT_MS) await timedOut(null);
          if (queued) await new Promise((ok) => setTimeout(ok, POLL_MS));
          queued = true;
          continue;
        }
        // A blocking pre-review's fence (t524) refuses the lease whatever
        // the queue; said as the server said it, with the head left checked
        // and approved.
        const why = error.message.replace(/^prereview_blocked: /, "") || `the landing lease could not be taken: ${error.message}`;
        throw new StepError(`${why.replace(/\.$/, "")}. ${id} is checked and approved but the lease was not taken, so nothing was merged`);
      }
    }
  };

  // A renewal the server refuses (a 4xx, such as no_lease) says the lease
  // is no longer this landing's: the heartbeat stops, the loss is said
  // once, and the release at the end leaves the lease alone, since it is
  // another landing's now. A renewal that fails to reach the server, or
  // that the server fails (a 5xx), is retried on the next beat and warned
  // of once, until a renewal succeeds again.
  // A landing that has lost the lease stops (t232): the loss is learned
  // here or by the renewal before the publishing steps, and guardLease
  // stops the next step, so the landing never accepts or merges beside the
  // landing that holds the lease now.
  let renewFailing = false, lostLease = null, beatOf = 0;
  // `why` is the server's word on the refusal, kept for the guard's error;
  // the warning names the loss in the heartbeat's own phrase, said once.
  const loseLease = (why) => {
    beating = false;
    leased = false;
    lostLease = why;
  };
  const guardLease = () => {
    if (!lostLease) return;
    throw new StepError(`another landing took the landing lease of ${name} over, so this landing stops without accepting or merging ${id}: the server said, when this landing last asked to renew it, "${lostLease}". Nothing was merged; run atelier land ${id} again once the other landing ends, or atelier merge ${id} if it is already accepted.`);
  };
  // Before the lease there is nothing to lose: the merge of main, the
  // checks and the review are guarded by nothing (t550).
  const unleased = () => {};
  // The steps that publish to main ask for the lease by hand first, so a
  // landing whose heartbeat has not had a beat since the loss (the Mac
  // slept through the takeover) learns it here and stops before accepting.
  // A renewal that cannot reach the server, or that the server fails,
  // decides nothing here: the accept and the merge call the server
  // themselves and stop if it still cannot be asked.
  const renewBeforePublish = async () => {
    guardLease();
    try {
      await request("POST", leasePath, { item: id, renew: true });
      if (renewFailing) { renewFailing = false; print("The landing lease is renewed again."); }
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        loseLease(error.message);
        throw new StepError(`the landing lease is no longer ${id}'s (${error.message}); this landing stops before accepting or merging ${id}. Nothing was merged; run atelier land ${id} again once the other landing ends, or atelier merge ${id} if it is already accepted.`);
      }
      print(`Warning: the landing lease could not be renewed before this step (${error.message}); the merge asks the server again itself.`);
    }
  };
  // One beat at a time: each beat waits for its renewal's answer before
  // scheduling the next, so beats never overlap, and a heartbeat that has
  // stopped — the lease released, or lost — sends no further renewal,
  // whatever a slow beat was still answering when it stopped. Each taking
  // of the lease starts a heartbeat of its own (`beatOf`), so one left from
  // a lease released when main moved never beats beside the next.
  const beat = async (mine) => {
    if (!beating || mine !== beatOf) return;
    try {
      await request("POST", leasePath, { item: id, renew: true });
      if (renewFailing) { renewFailing = false; print("The landing lease is renewed again."); }
    } catch (error) {
      if (mine !== beatOf) return;
      if (error.status >= 400 && error.status < 500) {
        // Said once, even where a slow beat's refusal lands after the loss
        // was already learned (a guard, or the renewal before publishing).
        const said = lostLease !== null;
        loseLease(error.message);
        if (!said) print(`Warning: the landing lease is no longer ${id}'s (${error.message}); this landing stops when the step it runs ends, and accepts and merges nothing. Run atelier land ${id} again once the other landing ends, or atelier merge ${id} if it is already accepted.`);
      } else if (!renewFailing) {
        renewFailing = true;
        print(`Warning: the landing lease could not be renewed (${error.message}); trying again every ${Math.round(LEASE_RENEW_MS / 1000)}s. It lapses after ${Math.round(LANDING_LEASE_EXPIRY_MS / 60000)} minutes without a renewal.`);
      }
    }
    if (beating && mine === beatOf) { const next = setTimeout(() => beat(mine), LEASE_RENEW_MS); next.unref(); }
  };
  const startBeating = () => {
    const mine = ++beatOf;
    lostLease = null;
    renewFailing = false;
    beating = true;
    const first = setTimeout(() => beat(mine), LEASE_RENEW_MS);
    first.unref();
  };

  const began = Date.now();
  try {
    for (let round = 0; ; round++) {
      // An accepted task has only its merge left (t188): under the lease,
      // as the merge of a fresh landing is, with the retries landStep gives it.
      if (d0.item.state === "accepted") {
        const { waited, took } = await takeLease();
        startBeating();
        await record("lease", took, { head: d0.item.acceptedHead, waited });
        print(`${id} is accepted at ${short(d0.item.acceptedHead)}; merging it.`);
        await renewBeforePublish();
        guardLease();
        const mergeHead = () => git(["rev-parse", `refs/heads/${p.branch}`], { cwd: p.path });
        await landStep(io, record, "merged", ["merge", id], p.path, () => ({ mergeCommit: mergeHead() }));
        print(`${id} landed: merged as ${short(mergeHead())}.`);
        break;
      }
      // ── Before the lease (t550) ──────────────────────────────────────
      // The merge of main, the push, the triage, the checks, the submission
      // and the review run without the landing lease, beside any other
      // task's landing; a conflict, a failed check, a stopped triage or a
      // rejection ends the landing here with the lease never taken.
      const roundBegan = Date.now();
      d0 = await preflight(true, true);
      if (d0.prereviewFence) throw new StepError(fenceText(id, d0.prereviewFence));
      await ensureWorkspaceToken(io, { dir, id, itemPath, item: d0.item });

      // Merge main into the workspace, no-ff, so the task carries main's
      // commits as a merge of their own; settle what the project's
      // regenerate command can settle, raise the merged route level where
      // both sides raised it and regenerate the fixtures — the workspace half
      // of a landing, shared with the Workflow executor (t280).
      const { head, mainHead, mergedIn, target } = await mergeMainAndRegenerate(io, { dir, id, name, regenerate, record, guard: unleased, d0, moved });

      // Push, checks and submission run as this CLI's own commands in the
      // workspace, so their output is their own and a failure still ends the
      // landing here, with the step recorded.
      const step = (kind, argv, cwd, data = {}) => { guardLease(); return landStep(io, record, kind, argv, cwd, data); };
      await recordedHeadStillStands(io, itemPath, d0.item.head);
      await pushRefreshing(io, { dir, id, itemPath }, () => step("push", ["push"], dir, { head }));
      print(`Pushed ${short(head)} to ${id}'s fork.`);
      // The triage, before the checks and the submission (t475): each can
      // draw a review request. A submission asks for the review, and the
      // checks' passing evidence asks again, at the pushed head, for a review
      // request the push withdrew from a task already submitted at an older
      // head (Ledger.reaskReview). So a triage that stops has asked nothing
      // of a reviewer. The gate reads the criteria again after the model
      // answers, and once more here: criteria changed meanwhile triage again,
      // still with nothing asked.
      const triageAt = { triage, dir, id, itemPath, head, mainHead, target, record, guard: unleased };
      let triaged = await triageGate(io, triageAt);
      triaged = await triageGate(io, { ...triageAt, previous: triaged });
      await checkStep(io, itemPath, id, step, dir);
      await step("submit", ["submit", "--summary", mergedIn ? `Merged with main at ${short(mainHead)}; the required checks pass.` : "The required checks pass."], dir);

      // The review: the server says whether the gate needs one and who
      // reviews; --no-review leaves the task submitted for the owner to
      // settle by hand, and never takes the lease. On a later round (main
      // moved under the lease) the same ask is where an approval carries
      // over a merge of main that leaves the task's files alone
      // (retainApprovals in src/ledger.ts): the server answers that none
      // is needed, or asks for a new review, which this landing waits for
      // as any other.
      if (noReview) {
        print(`${id} is submitted and left for you to settle the review by hand (--no-review): atelier review ${id} --approve --as H/M --note "…", then atelier accept ${id} and atelier merge ${id} (main is already merged; run atelier land ${id} again if the head moves). The landing lease was never taken.`);
        await record("review", 0, { skipped: true });
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, onSignal);
        return;
      }
      await triageStillStands(io, { triaged, id, itemPath, head, retry: triageRetry(io, triage, id) });
      await reviewStep(io, { id, name, itemPath, reviewer, head, record });

      // The gate as accept will read it, asked before the lease: the head
      // the landing merges must be the one checked and approved, with the
      // checks passing and an approval the gate counts (or none needed).
      // Anything else ends the landing here, the lease never taken.
      await gateStands(io, { id, itemPath, head });

      // ── Under the lease, for the merge alone ─────────────────────────
      const beforeLease = Date.now() - roundBegan;
      // The lease step's duration is the taking alone: time spent queued
      // behind another landing's merge is not this task's cost of landing,
      // and is recorded beside it (`waited`), with the time spent before it.
      const { waited, took } = await takeLease();
      startBeating();
      await record("lease", took, timing ? { head, main: mainHead, beforeLease, waited } : { head });
      print(`${short(head)} was merged with main, checked and reviewed in ${span(beforeLease)} without the lease${waited >= 1000 ? `; ${id} waited ${span(waited)} for its turn` : ""}.`);

      // Main must be the commit the head was checked and reviewed against.
      // Where it moved meanwhile (another landing merged), the lease is
      // released without accepting or merging, and the landing goes again
      // from the merge of main: only a merge that leaves the task's files
      // alone carries the approval (retainApprovals in src/ledger.ts), and
      // otherwise the new head is reviewed again; a conflict ends it.
      guardLease();
      let mainNow = await readMain(io, { dir, id, name });
      guardLease();
      // The server reads main itself and records it with the head (t550),
      // so the merge of this head into any other main is refused even if
      // this landing loses the lease before it merges; one that finds main
      // moved meanwhile says so, and the landing goes round again.
      if (mainNow === mainHead && timing) {
        try { await request("POST", leasePath, { item: id, confirm: true, main: mainHead }); }
        catch (error) {
          // A takeover the heartbeat has not reported is learned here, as
          // the renewal before publishing would learn it (t232).
          if (/^(no_lease|landing_lease|stale_landing): /.test(error.message)) {
            loseLease(error.message);
            throw new StepError(`the landing lease is no longer ${id}'s (${error.message}); this landing stops before accepting or merging ${id}. Nothing was merged; run atelier land ${id} again once the other landing ends, or atelier merge ${id} if it is already accepted.`);
          }
          const moved = /^main_moved: main is at ([a-f0-9]{8})/.exec(error.message);
          if (!moved) throw new StepError(`main ${short(mainHead)} could not be recorded under the lease, so ${id} is not accepted or merged: ${error.message}`);
          mainNow = await readMain(io, { dir, id, name });
          if (mainNow === mainHead) throw new StepError(`the server reads main at ${moved[1]}, not ${short(mainHead)} as this machine fetched it, so ${id} is not accepted or merged; run atelier land ${id} again`);
        }
      }
      if (mainNow !== mainHead) {
        await release(`main moved from ${mainHead} to ${mainNow}`);
        if (round + 1 >= MAIN_MOVED_ROUNDS) throw new StepError(`main moved under the lease ${MAIN_MOVED_ROUNDS} times (now at ${short(mainNow)}, where ${short(head)} was checked and reviewed against ${short(mainHead)}), so the landing stops without merging ${id}; ${id} stays submitted. Run atelier land ${id} again once main settles`);
        print(`main moved from ${short(mainHead)} to ${short(mainNow)} while ${id} was checked and reviewed, so ${short(head)} is not what main would become: released the lease without accepting or merging, and merging main again. The server says whether the approval carries over a clean merge of main or asks for a new review.`);
        continue;
      }
      print(`main is still at ${short(mainHead)}, the commit ${short(head)} was checked and reviewed against.`);

      // Accept and merge, again as this CLI's own commands. merge runs in
      // the registered checkout's project, publishes the merge to the
      // baseline and records it on the ledger. The lease is asked for by
      // hand first: these are the steps that publish to main, and a landing
      // that slept through losing it stops here rather than merge beside the
      // landing that holds the lease now (t232).
      await renewBeforePublish();
      await recordedHeadStillStands(io, itemPath, head);
      await step("accept", ["accept", id], p.path);
      await recordedHeadStillStands(io, itemPath, head);
      const mergeHead = () => git(["rev-parse", `refs/heads/${p.branch}`], { cwd: p.path });
      await step("merged", ["merge", id], p.path, () => ({ mergeCommit: mergeHead() }));
      print(`${id} landed: merged as ${short(mergeHead())}.`);
      break;
    }
  } catch (error) {
    // A step the signal ended fails here before its release is answered,
    // and a signal can come while this release is: either way the signal's
    // handler ends the landing, with the signal's status.
    await release(`stopped: ${String(error.message).split("\n")[0]}`);
    if (stopping) await stopping;
    die(error.message);
  }
  await release("merged");
  if (stopping) await stopping;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, onSignal);
  print(`${id} spent ${span(Date.now() - began - heldMs)} landing without the lease and held it ${span(heldMs)}.`);
  // When another landing took the lease over, release() has said where it
  // stands; claiming a release here would say what did not happen.
  if (takenOverBy === null) print(`The landing lease for ${name} is released; another task may merge.`);
}

// What a duration reads as in a message.
const span = (ms) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`;

// Main's head as the baseline holds it now, fetched as the merge of main
// fetches it, for the comparison under the lease (t550).
async function readMain(io, { dir, id, name }) {
  const read = await io.request("POST", `/projects/${encodeURIComponent(name)}/items/${encodeURIComponent(id)}/base-token`, { scope: "read" });
  await io.git(["fetch", "--quiet", read.remote, read.defaultBranch], { cwd: dir, token: read.token });
  return await io.git(["rev-parse", "FETCH_HEAD"], { cwd: dir });
}

// Before the lease (t550): the server's gate, as accept reads it, must hold
// the head this landing checked and reviewed, with nothing blocking it — the
// required checks passing at that head and the independent approval counted
// (or none needed). Otherwise the landing stops with the lease never taken.
async function gateStands(io, { id, itemPath, head }) {
  const d = await io.request("GET", itemPath);
  if (d.item?.head !== head) throw new StepError(`${id}'s head moved to ${short(d.item?.head)} after ${short(head)} was checked and reviewed, so the landing stops before taking the lease; run atelier land ${id} again`);
  if (d.gate && d.gate.ready === false) throw new StepError(`${id} at ${short(head)} is not ready to accept, so the landing stops before taking the lease: ${(d.gate.blockers ?? []).join("; ") || "the gate gave no reason"}. Nothing was merged`);
}

// The review the gate needs, asked for and waited for before the lease
// (t550). A named reviewer is a review the owner asks for, so the server
// makes the request even where the gate needs none, and refuses, with its
// reason, where the gate cannot proceed at all. A rejection, a timeout or a
// request no runner will serve throws, ending the landing with the lease
// never taken.
// The reviews the gate needs, one at a time (t143). Where the project states
// riskReviews, one approval can leave the change short of what its class
// needs, so the next review is asked only after the last approved, and only
// for the approvals still missing: the server leaves out every model already
// counted. A rejection ends the landing at once, so no later reviewer is
// asked. With --reviewer, or without riskReviews, one review is asked as it
// always was. REVIEW_PASSES bounds the asks: a class needs at most three
// approvals, so a gate still short after more has a count this loop cannot
// move, and the landing stops rather than asking on.
const REVIEW_PASSES = 4;
async function reviewStep(io, args) {
  for (let pass = 1; ; pass++) {
    if (await reviewOnce(io, args) !== "approved" || args.reviewer) return;
    const { request, print } = io;
    const missing = approvalsMissing(await request("GET", args.itemPath), args.head);
    if (!missing) return;
    if (pass >= REVIEW_PASSES) throw new StepError(`${args.id} still needs ${missing} more approval${missing === 1 ? "" : "s"} at ${short(args.head)} after ${pass} reviews; the landing stops. Run atelier show ${args.id} for what the gate counts`);
    print(`${args.id} still needs ${missing} more approval${missing === 1 ? "" : "s"} under the project's riskReviews; asking the next reviewer.`);
  }
}

// One review: "approved" when a reviewer approved it, undefined when none was
// needed or the gate already counted one.
async function reviewOnce(io, { id, name, itemPath, reviewer, head: pushed, record }) {
  const { request, print } = io;
  const t0 = Date.now();
  // A qualifying approval already recorded at the pushed head, which the
  // gate holds ready to accept (what `atelier show` recommends accept on),
  // settles the review before any request (t628): a new request would count
  // only verdicts given after it, and wait its hour for one.
  const now = await request("GET", itemPath);
  const held = recordedApproval(now, pushed, reviewer ?? null);
  if (held) {
    print(`${held.by} already approved ${id} at ${short(pushed)}, and the gate counts it: no review request was needed.`);
    await record("review", Date.now() - t0, { verdict: "approve", reviewer: held.by, resolvedBy: held.by, reason: "approval recorded at the head before the landing asked for a review" });
    return;
  }
  const ask = await request("POST", `${itemPath}/review-request`, reviewer ? { reviewer, wanted: true } : {});
  if (!ask.needed && reviewer) throw new StepError(`the server made no review request for ${reviewer} (${ask.reason}); ${id} stays submitted`);
  if (!ask.needed) {
    // The server answers a direct or coordinated change only when no
    // protected path changed (src/review/needed.ts), so those two say so
    // plainly; any other reason is printed as the server gave it.
    const why = String(ask.reason ?? "");
    print(/approval/i.test(why)
      ? "No review request was needed: an independent approval already covers this change."
      : /^an? (direct|coordinated) change needs no review/.test(why)
        ? "No review was needed: this change touched no protected paths."
        : `No review request was needed: ${(why || "the server gave no reason").replace(/\.*$/, "")}.`);
    await record("review", Date.now() - t0, { verdict: "none-needed", reason: String(ask.reason ?? "").slice(0, 500) });
    return;
  }
  const head = ask.head ?? pushed, since = ask.at;
  // When this landing asked (t613): only a reply with no readable verdict
  // given since then ends its wait, as the Workflow reads it.
  const askedAt = new Date().toISOString();
  // The named reviewer redirected an unclaimed request for another (t627).
  for (const w of Array.isArray(ask.withdrew) ? ask.withdrew : []) print(`Withdrew the unclaimed review request ${w.request}${w.reviewer ? ` for ${w.reviewer}` : ""}, since --reviewer names ${reviewer}.`);
  print(`${ask.requested === false ? "A review request is already open" : "Review requested"}${ask.reviewer ? ` for ${ask.reviewer}` : ""}: ${String(ask.reason ?? "").replace(/\.*$/, "")}. Waiting for the verdict…`);
  // While no runner has claimed the request, the landing says what the
  // runners are busy with and what waits ahead in the queue, once and
  // again when that changes, so a long wait is explained rather than
  // silent (a review queues behind every older build on a runner). A
  // request no live runner offers — a reviewer whose model no runner's
  // config lists, or a runner that offers no review job — can never be
  // claimed, however long it waits, and is said as that instead, with
  // what would change it; a review of t210 routed to fable-5.1 once sat
  // queued for hours this way (plan t197, 2026-10-07).
  let busyLine = null;
  const tierSeen = new Set();
  const explainWait = async (d) => {
    const claimed = (d.events ?? []).some((e) => e.kind === "review.claimed" && !e.data?.tier && e.data?.head === head && Date.parse(e.at) >= Date.parse(since));
    if (claimed) return;
    let offers = null;
    try { offers = await request("GET", "/runners"); } catch { /* without the offers the wait is explained as before */ }
    const slash = (ask.reviewer ?? "").indexOf("/");
    const asked = slash > 0 ? { to: "home", agent: ask.reviewer.slice(0, slash), model: ask.reviewer.slice(slash + 1), by: "atelier/orchestrator", at: since, note: "", job: "review" } : null;
    const dead = offers && asked ? unoffered(asked, Array.isArray(offers) ? offers : [], new Date(), name) : null;
    // Only the jobs the runners that offer this reviewer could also take are
    // ahead of it (t220): a job for a model or project they do not serve
    // never delays it. Without the offers every older job is counted; offers
    // that are known but leave no runner for this project were said as dead.
    const known = asked && Array.isArray(offers);
    const servers = known ? liveOffers(offers).filter((o) => assign(asked, o, name) !== null) : [];
    const servable = (q) => !known || servers.some((o) => q.item?.dispatch && assign(q.item.dispatch, o, q.project) !== null);
    let line;
    if (dead) {
      line = `The review request is not claimed yet, and ${dead}. It will not be claimed until a runner that offers ${ask.reviewer} for the review job asks the server for work. Review it by hand (atelier review ${id} --approve --as ${ask.reviewer} --note "…"), then atelier accept ${id} and atelier merge ${id}, or run atelier land ${id} again with --reviewer H/M to ask a model a live runner offers.`;
    } else try {
      const [items, queued] = await Promise.all([request("GET", `/projects/${encodeURIComponent(name)}/items`), request("GET", "/queue")]);
      const busy = (Array.isArray(items) ? items : []).filter((i) => i.runner && i.state === "claimed" && i.id !== id)
        .map((i) => `${i.runner} is busy with ${i.id} (${i.dispatch?.job ?? "build"}, ${i.owner}) since ${String(i.updatedAt).slice(0, 16).replace("T", " ")} UTC`);
      const ahead = (Array.isArray(queued) ? queued : []).filter((q) => !(q.project === name && q.item?.id === id) && (q.item?.dispatch?.at ?? "") < since && servable(q))
        .map((q) => `${q.project}/${q.item.id} (${q.item.dispatch?.job ?? "build"})`);
      line = `The review request is not claimed yet. ${busy.length ? busy.join("; ") : "No runner is busy with a job of this project"}; ${ahead.length ? `${ahead.length} job${ahead.length === 1 ? "" : "s"} queued ahead of it: ${ahead.join(", ")}` : "nothing is queued ahead of it"}.`;
    } catch (error) { line = `The review request is not claimed yet (the queue could not be read: ${error.message}).`; }
    if (line !== busyLine) { busyLine = line; print(line); }
  };
  for (let waited = 0; ; waited += POLL_MS) {
    const d = await request("GET", itemPath);
    // The landing waits for the gate's review alone. A tier review
    // (src/review/tier.ts) beside it is a second opinion: its approval
    // never satisfies the gate, so it is said and the wait goes on; its
    // rejection sends the task back as any rejection does.
    // Any rejection among the fresh verdicts decides, whatever came
    // after it (src/landing-verdict.ts, which the landing Workflow
    // shares): a tier rejection and the gate's approval that arrive
    // between two polls leave the task rejected on the server.
    const { verdict, tierApprovals } = landingVerdict(d.reviews ?? [], head, since);
    for (const v of tierApprovals.filter((v) => !tierSeen.has(`${v.by}\n${v.at}`))) {
      tierSeen.add(`${v.by}\n${v.at}`);
      print(`${v.by} approved ${id} at ${short(head)} as its tier review; the landing still waits for the gate's review.`);
    }
    if (verdict) {
      if (!verdict.approve) {
        await record("review", Date.now() - t0, { verdict: "reject", reviewer: verdict.by, resolvedBy: verdict.by });
        throw new StepError(`${verdict.by}${verdict.tier ? " (tier review)" : ""} rejected ${id} at ${short(head)}: ${rejectionText(verdict)}. The task goes back to its holder with the findings; the merge of main stays in its workspace, and the landing lease was never taken`);
      }
      print(`${verdict.by} approved ${id} at ${short(head)}${verdict.topTier ? ", as the gate review and the top tier's" : ""}.`);
      await record("review", Date.now() - t0, { verdict: "approve", reviewer: verdict.by, resolvedBy: verdict.by });
      return "approved";
    }
    if (d.item.head !== head) throw new StepError(`${id}'s head moved to ${short(d.item.head)} while waiting for the review; start the landing again`);
    // No verdict: the wait goes on only while one can still come (t613, as
    // the Workflow's reviewStall, t574). The live request and the verdicts
    // come in one detail, so a verdict that closed the request is seen
    // above, never taken for a request gone unanswered. A server that does
    // not send liveReview is not judged on it.
    const stall = reviewStall(head, askedAt, ask.reviewer ?? null, "liveReview" in d ? d.liveReview ?? null : { reviewer: "" }, d.unparsable ?? []);
    if (stall) {
      await record("review", Date.now() - t0, { verdict: stall.kind === "unparsable" ? "unparsable" : "no-request", ...(ask.reviewer ? { reviewer: ask.reviewer } : {}) });
      const byHand = `review by hand (atelier review ${id} --approve --as H/M --note "…"), then atelier accept ${id} and atelier merge ${id}`;
      if (stall.kind === "unparsable") throw new StepError(`${stall.by} replied to the review of ${id} at ${short(head)} with no verdict the server could read (${stall.note.slice(0, 300) || "no note"}); the reply is kept on the task (atelier show ${id}). The request stays asked of ${stall.by} and ${id} stays submitted. Run atelier land ${id} --reviewer H/M to ask another reviewer, which replaces that request, or ${byHand}`);
      throw new StepError(`no review request of ${id} at ${short(head)} is open or claimed and no verdict was given, so none will come; ${id} stays submitted. Run atelier land ${id}${ask.reviewer ? ` --reviewer ${ask.reviewer}` : ""} to ask again, or ${byHand}`);
    }
    // A review request every runner that offers the reviewer has skipped
    // will never be claimed, however long the wait runs (t353). Read as
    // the Workflow reads it: the skips recorded against this very
    // request, by its number — an earlier request's at the same head
    // count for nothing — against the live runners offering the
    // reviewer for the review job; and say so by runner name instead of
    // waiting out the hour.
    if (ask.reviewer && typeof ask.request === "number") {
      const skips = (d.events ?? [])
        .filter((e) => e.kind === "review.skipped" && e.data?.request === ask.request)
        .map((e) => ({ runner: e.data?.runner }));
      if (skips.length) {
        let offers = null;
        try { offers = await request("GET", "/runners"); } catch { /* without the offers nothing is known to have skipped */ }
        const stuck = allSkipped(ask.reviewer, Array.isArray(offers) ? offers : [], skips);
        if (stuck) {
          await record("review", Date.now() - t0, { verdict: "skipped", reviewer: ask.reviewer, runners: stuck });
          throw new StepError(`every runner that offers ${ask.reviewer} for the review of ${id} at ${short(head)} has skipped it: ${stuck.join(", ")}. The review request stays open and ${id} stays submitted. Review by hand (atelier review ${id} --approve --as ${ask.reviewer} --note "…"), then atelier accept ${id} and atelier merge ${id}, or run atelier land ${id} again once a runner can serve ${ask.reviewer}`);
        }
      }
    }
    await explainWait(d);
    if (waited >= REVIEW_TIMEOUT_MS) {
      await record("review", Date.now() - t0, { verdict: "timeout", reviewer: ask.reviewer ?? undefined });
      throw new StepError(`no verdict${ask.reviewer ? ` from ${ask.reviewer}` : ""} within ${Math.round(REVIEW_TIMEOUT_MS / 60000)} minutes; the review request stays open and ${id} stays submitted. Review by hand (atelier review ${id} --approve --as ${ask.reviewer ?? "H/M"} --note "…"), then atelier accept ${id} and atelier merge ${id}, or run atelier land ${id} again to wait once more`);
    }
    await new Promise((ok) => setTimeout(ok, POLL_MS));
  }
}

// ── the pieces both landings share (t280) ──────────────────────────────────

export async function recordedHeadStillStands(io, itemPath, expected) {
  if (!expected) return;
  const { item } = await io.request("GET", itemPath);
  if (item.head !== expected) throw new StepError(`${io.id}'s recorded head changed from ${expected} to ${item.head ?? "none"}; landing stopped, retry from the recorded head`);
}

// A land.* step recorder: a ledger that cannot take the record warns and
// the landing goes on, for the record is not the step.
function landRecorder(io, itemPath) {
  return async (step, ms, data = {}) => {
    try { await io.request("POST", `${itemPath}/land`, { step, ms: Math.max(0, Math.round(ms)), ...data }); }
    catch (error) { io.print(`Warning: the landing's ${step} step could not be recorded: ${error.message}`); }
  };
}

// ── the triage before the review (t475) ─────────────────────────────────────

// The adapter each harness's triage runs through (bin/harness), as a runner
// runs a review: read-only, the prompt on standard input, the answer to a file.
const TRIAGE_ADAPTERS = { "claude-code": "atelier-claude.mjs", codex: "atelier-codex.mjs", opencode: "atelier-opencode.mjs", antigravity: "atelier-agy.mjs" };

// What the dry run says of the triage: the choice and where it came from,
// and whether the pool would let the model triage, read without calling it.
async function dryRunTriage(io, triage, item) {
  if (triage.mode === "off") return "run no triage (no --triage, and the project sets no triage), then ";
  if (triage.mode === "bypass") return `record your bypass of the triage (--no-triage: "${triage.reason}") with the pushed head and the criteria binding, stopping if the server does not record it, then `;
  const count = triageCriteria(item?.accept ?? [], item?.partAccept ?? null).length;
  let access = "";
  try {
    const refusal = triageModelRefusal(triage.actor, await io.request("GET", "/models"));
    if (refusal) access = `; as the pool stands it would stop: ${refusal}`;
  } catch (error) { access = `; the model pool could not be read (${error.message})`; }
  const against = count ? `${io.id}'s ${count} acceptance criteri${count === 1 ? "on" : "a"}` : `${io.id}'s acceptance criteria, of which it has none, so the triage would stop and say so`;
  return `triage the pushed head's diff against its merge base with main and ${against} with ${triage.actor} (from ${triage.source})${access}, going on only when every criterion is met and otherwise stopping before any review request${triage.override ? `, unless the stop is overridden (--override-triage: "${triage.override}"), which is recorded first` : ""}; then `;
}

// The triage gate. Answers the binding the triage stands for (null when the
// landing runs none), or throws the StepError that stops the landing before
// the review request. `previous` is a binding triaged earlier in this
// landing: while the head, the merge base and the criteria are still those,
// it stands and nothing is asked again.
async function triageGate(io, { triage, dir, id, itemPath, head, mainHead, target, record, guard, previous = null }) {
  if (triage.mode === "off") return null;
  const { request, git, print } = io;
  const retry = triageRetry(io, triage, id);
  const base = await git(["merge-base", head, mainHead], { cwd: dir });
  // A record the landing cannot go on without: the owner's bypass or
  // override. The server records it only from the signed-in project owner,
  // with the actor it authenticated; any failure stops the landing.
  const recordStrict = async (ms, data, what) => {
    try { await request("POST", `${itemPath}/land`, { step: "triage", ms: Math.max(0, Math.round(ms)), ...data }); }
    catch (error) { throw new StepError(`${what} could not be recorded on the ledger, so the landing stops before the review request: ${error.message}. Only the developer, signed in, may record it; ${leftAs()}. Run ${retry} again once the server records it`); }
  };
  // Where a stop leaves the task. This landing has submitted nothing and
  // asked for no review by then; a task submitted before it stays
  // submitted, which the stop says rather than claim nothing is, with what
  // became of a review request it already had (the push withdraws one at
  // an older head; one at this very head stays open).
  let submittedBefore = false;
  const leftAs = (pushed = "") => submittedBefore
    ? `this landing submitted nothing and asked for no review${pushed ? `; ${pushed}` : ""}; ${id} was submitted before it and stays submitted with its holder (a review request open at an earlier head was withdrawn when the push moved its head; one already open at ${short(head)} stays open)`
    : `nothing was submitted for review, ${pushed ? `${pushed}, ` : ""}and ${id} stays with its holder`;
  let stale = previous;
  for (let attempt = 1; ; attempt++) {
    guard();
    const d = await request("GET", itemPath);
    submittedBefore = d.item?.state === "submitted";
    const binding = { head, base, criteria: criteriaOf(d.item ?? {}) };
    if (stale && sameBinding(stale, binding)) return stale;
    if (stale) {
      if (attempt > 3) throw new StepError(`${id}'s acceptance criteria kept changing while it was triaged (now bound to ${short(binding.criteria)}), so the landing stops before the review request; ${leftAs()}. Run ${retry} again once the criteria settle`);
      print(`${id}'s acceptance criteria changed since the triage (binding ${short(stale.criteria)}, now ${short(binding.criteria)}); triaging again at ${short(head)}.`);
    }
    const t0 = Date.now();
    if (triage.mode === "bypass") {
      guard();
      await recordStrict(Date.now() - t0, triageRecord(binding, "bypassed", { reason: triage.reason }), "The bypass of the triage (--no-triage)");
      print(`Triage bypassed by the developer (--no-triage: ${triage.reason}); recorded at ${short(head)} with criteria binding ${short(binding.criteria)}. The review rules apply as before.`);
      return binding;
    }
    const criteria = triageCriteria(d.item?.accept ?? [], d.item?.partAccept ?? null);
    const outcome = await runTriage(io, { triage, dir, id, item: d.item ?? {}, events: d.events ?? [], binding, criteria, target });
    // Criteria changed while the model read them: its result is for
    // criteria no longer the task's, so the triage runs again on the new.
    if (!outcome.reused) {
      const now = await request("GET", itemPath);
      if (criteriaOf(now.item ?? {}) !== binding.criteria) { stale = binding; continue; }
    }
    const lines = outcome.results ? triageLines(outcome.results, criteria) : [];
    const unverified = outcome.unverified?.length ? [`Runtime behaviour the triage could not verify: ${outcome.unverified.join("; ")}`] : [];
    guard();
    if (outcome.passed) {
      if (outcome.reused) print(`The triage by ${triage.actor} already found every criterion met at ${short(head)} (merge base ${short(base)}, criteria ${short(binding.criteria)}); it stands.`);
      else {
        await record("triage", Date.now() - t0, triageRecord(binding, "passed", { triager: triage.actor, statuses: outcome.results }));
        print([`Triage by ${triage.actor}: every one of the ${criteria.length} criteri${criteria.length === 1 ? "on is" : "a are"} met at ${short(head)} (merge base ${short(base)}, criteria ${short(binding.criteria)}).`, ...lines, ...unverified].join("\n"));
      }
      return binding;
    }
    if (!outcome.reused) await record("triage", Date.now() - t0, triageRecord(binding, "stopped", { triager: triage.actor, statuses: outcome.results ?? undefined, reason: outcome.why }));
    const findings = [`The triage of ${id} by ${triage.actor} stopped at ${short(head)} (merge base ${short(base)}, criteria ${short(binding.criteria)}): ${outcome.why}.`, ...lines, ...unverified];
    if (triage.override) {
      await recordStrict(Date.now() - t0, triageRecord(binding, "overridden", { triager: triage.actor, reason: triage.override }), "The override of the stopped triage (--override-triage)");
      print([...findings, `The developer overrode the stopped triage (--override-triage: ${triage.override}); recorded at ${short(head)} with criteria binding ${short(binding.criteria)}. The review rules apply as before.`].join("\n"));
      return binding;
    }
    throw new StepError([...findings,
      `The landing stops before the review request: ${leftAs(`the merged head stays pushed to ${id}'s fork`)}. Fix what the triage found and run ${retry} again, which triages the new head; or, as the developer, ${triageBypass(retry, triage)}.`].join("\n"));
  }
}

// The owner's ways past a stopped triage, each a command that runs as
// given. A triage named with --triage H/M cannot also be skipped with
// --no-triage, which that flag refuses, and without it the project may
// have no triage to skip; the override needs neither, and goes past the
// stop recorded at this head without asking the model again.
function triageBypass(retry, triage) {
  const override = `go past this stop with ${retry} --override-triage "REASON", which overrides the stop recorded at this head and criteria without asking ${triage.actor} again`;
  if (triage.source === "--triage") return `${override}; it is recorded with the head and the criteria binding before the landing goes on`;
  return `${override}, or skip the triage with ${retry} --no-triage "REASON" — either is recorded with the head and the criteria binding before the landing goes on`;
}

// The command that runs the landing again, triaging as this one did.
const triageRetry = (io, triage, id) => `atelier land ${id}${io.args?.workflow === true ? " --workflow" : ""}${triage.mode === "model" && triage.source === "--triage" ? ` --triage ${triage.actor}` : ""}`;

// After the submission, before the review request: the binding the triage
// stood for must still be the task's. Nothing is triaged here, since the
// task is already submitted; criteria changed since then stop the landing
// before any review is asked for, saying the task is submitted.
async function triageStillStands(io, { triaged, id, itemPath, head, retry }) {
  if (!triaged) return;
  const d = await io.request("GET", itemPath);
  const now = { head: d.item?.head ?? null, base: triaged.base, criteria: criteriaOf(d.item ?? {}) };
  if (sameBinding(triaged, now)) return;
  const what = now.head !== triaged.head
    ? `its head moved from the triaged ${short(triaged.head)} to ${short(now.head)}`
    : `its acceptance criteria changed after the triage (binding ${short(triaged.criteria)}, now ${short(now.criteria)})`;
  throw new StepError(`${id} was submitted at ${short(head)}, but ${what}, so the landing stops before the review request: no review was asked for, and ${id} stays submitted with its holder. Run ${retry} again, which triages the change against the criteria as they are now before it asks for the review`);
}

// One triage: the model's answer for the binding, or why there is none.
// Answers { passed, results?, unverified?, why?, reused? }.
async function runTriage(io, { triage, dir, id, item, events, binding, criteria, target }) {
  if (!criteria.length) return { passed: false, why: `${id} has no acceptance criteria (its list is empty), so the triage has nothing to judge the change against` };
  if (recordedTriage(events, binding, "passed", triage.actor)) return { passed: true, reused: true };
  // The stop the owner saw and now overrides, recorded at this very binding
  // by this model: it is overridden as recorded, not asked for again.
  const stop = triage.override ? recordedTriage(events, binding, "stopped", triage.actor) : null;
  if (stop) return { passed: false, reused: true, why: `${String(stop.data?.reason ?? "it stopped")} (as recorded at this head, merge base and criteria)` };
  let pool;
  try { pool = await io.request("GET", "/models"); }
  catch (error) { return { passed: false, why: `the triage is unavailable: the model pool could not be read (${error.message})` }; }
  const refusal = triageModelRefusal(triage.actor, Array.isArray(pool) ? pool : []);
  if (refusal) return { passed: false, why: `the triage is unavailable: ${refusal}` };
  const slash = triage.actor.indexOf("/");
  const diff = await io.git(["diff", binding.base, binding.head, "--"], { cwd: dir, raw: true });
  const changedPaths = (await io.git(["diff", "--name-only", "-z", binding.base, binding.head, "--"], { cwd: dir, raw: true })).split("\0").filter(Boolean);
  const brief = triageBrief({ project: io.name, id, title: String(item.title ?? id), brief: String(item.brief ?? ""), task: item.accept ?? [], part: item.partAccept ?? null, binding, target: target ?? "main", changedPaths });
  const limit = io.triageTimeoutMs ?? TRIAGE_TIMEOUT_MS;
  const ask = { actor: triage.actor, harness: triage.actor.slice(0, slash), model: triage.actor.slice(slash + 1), brief, diff, dir, timeoutMs: limit };
  const run = io.triage ?? ((req) => runTriageModel(io, req));
  let timer;
  const answer = await Promise.race([
    Promise.resolve().then(() => run(ask)).catch((error) => ({ error: error?.message ?? String(error) })),
    new Promise((ok) => { timer = setTimeout(() => ok({ timedOut: true }), limit); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  const minutes = limit < 1000 ? `${limit} ms` : limit < 60_000 ? `${Math.round(limit / 1000)} seconds` : `${Math.round(limit / 60_000)} minutes`;
  if (answer?.timedOut) return { passed: false, why: `the triage timed out: ${triage.actor} gave no answer within ${minutes}` };
  if (answer?.error || typeof answer?.reply !== "string") return { passed: false, why: `the triage is unavailable: ${triage.actor} could not be run (${answer?.error ?? "it gave no answer"})` };
  const parsed = parseTriage(answer.reply, criteria.length);
  if (!parsed.ok) return { passed: false, why: `the triage's reply could not be read: ${parsed.error}` };
  const { proceed, notMet, unsure } = decideTriage(parsed.results);
  if (proceed) return { passed: true, results: parsed.results, unverified: parsed.unverified };
  const said = [notMet.length ? `${notMet.length === 1 ? "criterion" : "criteria"} ${notMet.join(", ")} not met` : null, unsure.length ? `unsure of ${unsure.length === 1 ? "criterion" : "criteria"} ${unsure.join(", ")}` : null].filter(Boolean).join("; ");
  return { passed: false, why: said, results: parsed.results, unverified: parsed.unverified };
}

// The triage model, run through its harness's adapter as a read-only review
// job in the workspace, its own process group bounded by the time limit.
// The brief and the diff are written outside the workspace, so nothing the
// triage reads is left in it to commit.
async function runTriageModel(io, { harness, model, brief, diff, dir, timeoutMs }) {
  const adapter = TRIAGE_ADAPTERS[harness];
  if (!adapter) return { error: `no adapter for ${harness}` };
  const tmp = mkdtempSync(join(tmpdir(), "atelier-triage-"));
  try {
    const briefPath = join(tmp, "brief.md"), diffPath = join(tmp, "diff.patch"), replyPath = join(tmp, "reply.txt");
    writeFileSync(briefPath, brief);
    writeFileSync(diffPath, diff);
    const r = await runGroup([process.execPath, fileURLToPath(new URL(`../bin/harness/${adapter}`, import.meta.url)), model, briefPath, dir, "undefined", diffPath, replyPath], { cwd: dir, env: io.env ?? process.env, timeoutMs });
    if (r.timedOut) return { timedOut: true };
    if (r.error || r.status !== 0) {
      const tail = io.redact ? io.redact(`${r.stderr ?? ""}`, io.secrets?.() ?? []) : `${r.stderr ?? ""}`;
      return { error: `${r.error ? r.error.message : `exit ${r.status}`}${tail.trim() ? `: ${tail.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}` : ""}` };
    }
    if (!existsSync(replyPath)) return { error: "it wrote no answer" };
    return { reply: readFileSync(replyPath, "utf8") };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// The workspace's write token, refreshed by re-claiming the task as the
// holder the server records (t275), whose name the claim must carry exactly:
// the server refreshes a claim only for `item.owner === actor`, and to any
// other name a claim is a takeover. The workspace's own atelier.actor must
// be that holder too, so a workspace left by an earlier holder is never
// given the current one's token. An unclaimed task stops without changing
// ownership or dispatch. The holder's runner rides along, as the server
// refuses a re-claim from any runner but the one holding the task. The new token replaces the old one
// in the workspace (the old one is revoked by the claim) and its expiry is
// recorded. Answers the new expiry.
async function refreshWorkspaceToken(io, { dir, id, itemPath }) {
  const recorded = io.git(["config", "--local", "atelier.actor"], { cwd: dir, allowFail: true }).stdout?.trim() || null;
  const { item } = await io.request("GET", itemPath);
  const holder = item?.owner ?? recorded;
  if (!recorded || (item?.owner && !sameActor(item.owner, recorded))) {
    throw new StepError(`${id} is held by ${holder ?? "nobody"} and its workspace was claimed by ${recorded ?? "no recorded actor"}, so the landing cannot refresh the token for its holder`);
  }
  if (!item.owner) throw new StepError(`${id} is unclaimed; landing cannot claim it or withdraw its dispatch to obtain write credentials`);
  const r = await io.request("POST", `${itemPath}/claim`, {}, holder, item.owner && item.runner ? { "x-atelier-runner": item.runner } : {});
  if (typeof r?.workspace?.token !== "string" || !r.workspace.token) throw new StepError(`the re-claim of ${id} as ${holder} returned no workspace token`);
  // The remote the claim answered is origin's one destination before the
  // header, the expiry and the fetch are taken (t488): a fork workspace
  // keeps the remote it has, and one on a runner route moves to the fork.
  const moved = adoptWorkspaceRemote(io, { dir, id, holder }, r.workspace.remote);
  io.adoptWorkspaceToken(dir, r.workspace);
  return { holder, expiresAt: r.workspace.expiresAt ?? null, remote: r.workspace.remote, moved };
}

// The runner route a workspace claimed under a runner token fetches from and
// pushes to (t488): ORIGIN/git/runner/PROJECT/ITEM.git, which the server
// forwards to the fork for the runner's own Git credential alone.
const RUNNER_ROUTE = /\/git\/runner\/[^/?#]+\/[^/?#]+$/i;
const isRunnerRoute = (url) => typeof url === "string" && RUNNER_ROUTE.test(url.trim().replace(/\/+$/, ""));
// A remote as a message shows it: any userinfo cut, since a URL can carry a
// credential, and no message of a landing prints one.
const shownRemote = (url) => String(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");

// Where origin fetches from and pushes to, as the workspace's Git config
// records them, every value of each key: Git fetches from the first URL
// and pushes to every URL, or to every push URL where any is set apart, so
// a route that is one of several is read where `--get` would answer only
// the last. Each URL is trimmed; blank values are left out.
function originUrls(io, dir) {
  const readAll = (key) => {
    const r = io.git(["config", "--local", "--get-all", key], { cwd: dir, allowFail: true });
    return r && r.status === 0 ? String(r.stdout ?? "").split("\n").map((u) => u.trim()).filter(Boolean) : [];
  };
  const urls = readAll("remote.origin.url"), pushUrls = readAll("remote.origin.pushurl");
  return { urls, pushUrls, url: urls[0] ?? null, destinations: [...urls, ...pushUrls] };
}

// The runner route origin still fetches from or pushes to, among every URL
// it is configured with, or null for a workspace on its fork.
function runnerRouteOf(io, dir) {
  return originUrls(io, dir).destinations.find(isRunnerRoute) ?? null;
}

// How the workspace uses the route, for a message: as its fetch and push
// URL, as a fetch URL alone where push URLs set apart name no route, or as
// a push URL (one of several, or set apart from a fetch URL that is not
// the route).
function routeUse(io, dir, route) {
  const { url, pushUrls } = originUrls(io, dir);
  return isRunnerRoute(url) ? (pushUrls.length && !pushUrls.some(isRunnerRoute) ? "fetches from" : "fetches from and pushes to") : "pushes to";
}

// The remote a re-claim answered, taken as origin's one destination (t488).
// A fork workspace whose origin is that remote alone, with no push URL
// apart, is left as it is. Otherwise every fetch URL of origin is replaced
// by the remote, every push URL set apart is dropped (the fork serves
// both), and any header .git/config holds for a URL origin no longer uses
// is removed, so no request carries the runner's credential to the fork or
// the fork's to the route (the credentials file is rewritten whole by the
// token's adoption that follows). A claim that answers no remote, or
// another runner route — the landing's own credential is a runner's, which
// cannot land — stops here. Answers whether origin moved.
function adoptWorkspaceRemote(io, { dir, id, holder }, remote) {
  if (typeof remote !== "string" || !remote.trim()) throw new StepError(`the re-claim of ${id} as ${holder} returned no workspace remote`);
  if (isRunnerRoute(remote)) throw new StepError(`the re-claim of ${id} as ${holder} answered another runner route (${shownRemote(remote)}) rather than ${id}'s fork, so this landing's own credential is a runner token's; land with the developer's credential`);
  const { urls, pushUrls, destinations } = originUrls(io, dir);
  if (urls.length === 1 && urls[0] === remote && !pushUrls.length) return false;
  const stale = [...new Set(destinations.filter((u) => u !== remote))];
  // --replace-all leaves origin one fetch URL where it held several.
  io.git(urls.length ? ["config", "--local", "--replace-all", "remote.origin.url", remote] : ["remote", "add", "origin", remote], { cwd: dir });
  if (pushUrls.length) {
    const dropped = io.git(["config", "--local", "--unset-all", "remote.origin.pushurl"], { cwd: dir, allowFail: true });
    if (dropped.status !== 0 && dropped.status !== 5) throw new StepError(`origin's push URLs could not be dropped from ${id}'s workspace:\n${String(dropped.stderr ?? "").trim()}`);
  }
  for (const old of stale) {
    // Exit status 5 means .git/config held no such header.
    const unset = io.git(["config", "--local", "--unset-all", `http.${old}.extraHeader`], { cwd: dir, allowFail: true });
    if (unset.status !== 0 && unset.status !== 5) throw new StepError(`the header for ${shownRemote(old)} could not be removed from ${id}'s workspace:\n${String(unset.stderr ?? "").trim()}`);
  }
  return true;
}

// Before the landing takes the lease: a write token that has lapsed or
// lapses within TOKEN_WINDOW_MS is refreshed, and one that cannot be stops
// the landing here before the lease. Release revokes tokens, so unclaimed
// tasks stop without being re-claimed. The expiry is recorded at each
// claim (recordTokenExpiry in cli/atelier.mjs); the server keeps none it
// could answer later, so a workspace claimed before that was recorded has
// an unknown expiry, which is refreshed once — the refresh records it, and
// later landings read it. An accepted task has nothing left to push.
// A workspace on a runner route (t488) is re-claimed whatever expiry it
// records, since the route and its credential are the runner's, not the
// landing's: the claim answers the fork and a write token of its own, which
// replace the route before the lease.
async function ensureWorkspaceToken(io, { dir, id, itemPath, item }) {
  if (item?.state === "accepted") return;
  const route = runnerRouteOf(io, dir);
  const recorded = io.git(["config", "--local", "atelier.write-token-expires-at"], { cwd: dir, allowFail: true }).stdout?.trim() || null;
  const at = recorded ? Date.parse(recorded) : NaN;
  if (!route && item?.owner && Number.isFinite(at) && at - Date.now() > TOKEN_WINDOW_MS) return;
  const when = Number.isFinite(at) ? `${at <= Date.now() ? "expired" : "expires"} ${recorded.slice(0, 16).replace("T", " ")} UTC` : null;
  io.print(route
    ? `${id}'s workspace ${routeUse(io, dir, route)} the runner route ${shownRemote(route)}, with the runner's Git credential${when ? ` (recorded as one that ${when})` : " (its expiry is not recorded)"}, which the developer's landing cannot push through; re-claiming ${id} for its holder to land through its fork, before the landing takes the lease…`
    : when
      ? `${id}'s workspace write token ${when}; refreshing it for its holder before the landing takes the lease…`
      : `${id}'s workspace records no write token expiry (it was claimed before expiries were recorded); refreshing the token for its holder before the landing takes the lease…`);
  let fresh;
  try { fresh = await refreshWorkspaceToken(io, { dir, id, itemPath }); }
  catch (error) {
    throw new StepError(route
      ? `${id}'s workspace could not be moved from the runner route to its fork, so the landing stops before taking the lease: ${error.message}. Its commits are untouched; settle what that names (the task's holder, its claim, or the workspace's remote), then run atelier land ${id} again`
      : `${id}'s workspace write token could not be refreshed, so the landing stops before taking the lease: ${error.message}. Have its builder run atelier claim ${id} in the workspace, then run atelier land ${id} again`);
  }
  const expiry = fresh.expiresAt ? `; it expires ${String(fresh.expiresAt).slice(0, 16).replace("T", " ")} UTC` : "";
  io.print(route || fresh.moved
    ? `Moved ${id}'s workspace to its fork ${shownRemote(fresh.remote)} with a write token for ${fresh.holder}${expiry}; the landing pushes there.`
    : `Refreshed ${id}'s workspace write token for ${fresh.holder}${expiry}.`);
}

// The landing's push, refreshed and tried once more when the server refuses
// the token as expired (it lapsed, or was revoked, after the check before
// the lease). Any other failure, and a second refusal, ends the landing as
// before.
async function pushRefreshing(io, ctx, push) {
  try { return await push(); }
  catch (error) {
    if (!EXPIRED_TOKEN.test(error.message)) throw error;
    io.print(`The push was refused for an expired write token; refreshing ${ctx.id}'s token for its holder and pushing once more…`);
    try { await refreshWorkspaceToken(io, ctx); }
    catch (refresh) { throw new StepError(`${error.message}\n${ctx.id}'s workspace write token could not be refreshed: ${refresh.message}. Have its holder run atelier claim ${ctx.id} in the workspace, then run atelier land ${ctx.id} again`); }
    return await push();
  }
}

// The tail of the log of a generator that stopped the merge, so the stop
// carries its output and not only the log's path.
function generatorOutput(regenerated) {
  const log = regenerated?.at(-1)?.log;
  try { return log ? `\nThe generator's log:\n${readFileSync(log, "utf8").slice(-2000).trimEnd()}` : ""; }
  catch { return ""; }
}

// The policy's regenerate command, run in the workspace the way a check
// runs it, to bring every fixture current with the merged tree. Conflicts
// are no longer settled through it: only the generators the project
// declares (cli/merge-pipeline.mjs) write outputs during a merge. It leads a process group of its own
// (runGroup), ended whole when its shell exits or its time limit passes.
async function runRegenerateIn(dir, regenerate, io) {
  const r = await runGroup(["/bin/sh", "-c", regenerate], { cwd: dir, env: checkEnv(), timeoutMs: CHECK_TIMEOUT_MS });
  const output = io.redact(`${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n[atelier] ${r.error.message}` : ""}`, io.secrets());
  if (output.trim()) process.stdout.write(output.slice(-4000) + "\n");
  return { ok: !r.error && r.status === 0, why: r.error ? r.error.message : `exit ${r.status}` };
}

// The check step of either landing (t436): `atelier check` as a step of its
// own, whose failure is said as the failure summary every landing and
// `atelier show` print (src/check-failure.ts): the failed checks as the gate
// reads them at the head the server records, from the server's evidence,
// each stored log read by reference where the run kept one. The step's own
// output stands, as before, when the server records no failure at that head
// (the check died before it posted, or the server is older than the
// summary), and the step is recorded by `step` as any other. The error's
// message holds the summary whole, for the terminal; its data's
// `workflowReason` is the same failure fitted to WORKSPACE_REASON_MAX by
// failureDetail (the tails give way first, then the names, then later
// checks are counted in one line), which the Workflow landing reports as
// why its workspace failed, so the record keeps every failed check and the
// check-log line however long the first check's output ran. (Its own key:
// a merge stop's data carries a `reason` of its own, the note the ledger's
// merge step records, which is not what the Workflow is told.)
export async function checkStep(io, itemPath, id, step, dir) {
  try { await step("check", ["check"], dir); }
  catch (error) {
    if (!(error instanceof StepError)) throw error;
    const why = String(error.message).split("\n")[0];
    let summary = null;
    try {
      const d = await io.request("GET", itemPath);
      const failures = d?.item?.head && Array.isArray(d.policy?.checks) ? effectiveFailures(d.policy, d.evidence ?? [], d.item.head) : [];
      if (failures.length) {
        const resolved = await resolveFailures(failures, io.readLog ?? (async () => null));
        summary = { whole: failureSummary(id, d.item.head, resolved), reason: failureDetail(why, id, d.item.head, resolved, WORKSPACE_REASON_MAX) };
      }
    } catch (read) { io.print(`Warning: the failed checks could not be read from the server (${read.message}); the check's own output follows.`); }
    if (!summary) throw error;
    throw new StepError(`${why}\n${summary.whole}`, { ...error.data, workflowReason: summary.reason });
  }
}

// One step of a landing that runs a CLI command of its own (the push, or
// the merge below): the command's output is its own, its duration and what
// it settled are recorded, and a failure throws the StepError that ends
// the landing it belongs to.
export async function landStep(io, record, kind, argv, cwd, data = {}) {
  const t = Date.now();
  const quiet = kind === "accept" ? { write() {} } : undefined;
  const run = () => (io.runCommand ?? runCommand)([process.execPath, io.atelier, ...argv, "--project", io.name], { cwd, env: io.env, out: quiet, err: quiet });
  let r = await run();
  // The merge step's fetch can fail on the server's side (an Artifacts 5xx)
  // or answer a revision other than the approved one. The accept is already
  // held and the merge resumes from its journal, so the landing runs the
  // merge again rather than hand it back: a 5xx up to three more times, a
  // revision mismatch once.
  if (kind === "merged") {
    let server = 0, mismatch = 0;
    while (!r.passed) {
      const text = r.output ?? "";
      if (/fetched revision differs from the approval/.test(text) && mismatch < 1) mismatch++;
      else if (/\b(HTTP |status |error: )?5\d\d\b/.test(text) && /fetch|Artifacts|HTTP/i.test(text) && server < 3) { server++; await (io.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(1000 * server); }
      else break;
      r = await run();
    }
  }
  if (!r.passed) {
    await record(kind, r.durationMs, { failed: true, reason: r.output.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 500) });
    throw new StepError(`atelier ${argv[0]} failed (exit ${r.status ?? "ended by a signal"}):\n${r.output.split("\n").filter(Boolean).slice(-12).join("\n")}`);
  }
  // A function names fields only the finished step knows, such as the
  // merge commit the checkout now holds.
  await record(kind, r.durationMs, typeof data === "function" ? data() : data);
  return r;
}

// The dry run's preview of the merge of main into the workspace, from
// merge-tree, which touches neither the index nor the work tree: source
// conflicts apart from the regenerable outputs, and the generators the
// merge would run. null where main cannot be read; the dry run goes on.
async function previewLanding(io, { dir, id, name }) {
  const { request, git } = io;
  try {
    const base = await request("POST", `/projects/${encodeURIComponent(name)}/items/${encodeURIComponent(id)}/base-token`, { scope: "read" });
    git(["fetch", "--quiet", base.remote, base.defaultBranch], { cwd: dir, token: base.token });
    const mainHead = git(["rev-parse", "FETCH_HEAD"], { cwd: dir });
    if (git(["merge-base", "--is-ancestor", mainHead, "HEAD"], { cwd: dir, allowFail: true }).status === 0) return `Preview: the workspace already holds main at ${short(mainHead)}.`;
    const preview = previewMerge(dir, "HEAD", mainHead, { git });
    if (preview.error) return `Preview: merge-tree could not preview the merge (${preview.error}).`;
    const conflicts = describeConflicts(preview);
    const regen = preview.regenerate.length ? `\nIt would regenerate with ${preview.regenerate.join(", ")}.` : "";
    return preview.clean
      ? `Preview: main at ${short(mainHead)} merges cleanly.${conflicts ? `\n${conflicts}` : ""}${regen}`
      : `Preview: main at ${short(mainHead)} would stop the merge, generating nothing.\n${conflicts}`;
  } catch (error) {
    return `Preview: main could not be read (${error.message.split("\n")[0]}).`;
  }
}

// The comparison before the merge of main (t471): the task's head and main's
// head, from their merge base, through src/moved-code.ts. No merge base, or a
// comparison that fails, stops the landing saying so. Ambiguous matches are
// warned of and the landing goes on. Confirmed findings stop it with Git and
// the workspace unchanged, the porting instructions printed, recorded with
// the failed merge step and in the workspace's moved-code log — unless the
// owner gave --moved-ok, whose approval of exactly these findings at these
// revisions is recorded on the ledger and in that log before the landing
// goes on. An approval covers no other revisions or findings, so a later
// round of the Workflow that finds edits in moved code again stops for a
// fresh one. Answers the line the merge step records: the revisions compared
// and the merge base, with what was found.
//
// A build's runner runs the same comparison before it submits (t435):
// its `moved.port` is a function, and findings do not stop its merge. They
// are logged as handed to the builder (`moved.resolver`), given to `port`,
// and the merge goes on, clean or in conflict, so the builder ports each
// edit to its destination in the same run, as it resolves a conflict;
// a finding is never the model's failure. Every git call is awaited,
// since the runner's git runs each command as a child (the landing's
// synchronous git does not mind), and the detector reads through
// detectMovedEditsAsync for the same reason.
async function compareMoved(io, { dir, id, name, record, moved, t0, mainHead }) {
  const { request, git, print } = io;
  const taskHead = await git(["rev-parse", "HEAD"], { cwd: dir });
  // A stop records the failed merge step (`reason`, cut to the ledger's
  // length, the message when none is given) and answers the StepError, whose
  // data adds what only this CLI reads.
  const stop = async (message, { reason = message, ...data } = {}, only = {}) => {
    await record("merge", Date.now() - t0, { failed: true, reason: reason.slice(0, 500), ...data });
    return new StepError(message, { ...data, ...only });
  };
  const based = await git(["merge-base", taskHead, mainHead], { cwd: dir, allowFail: true });
  const mergeBase = based.status === 0 ? String(based.stdout ?? "").trim() : "";
  if (!mergeBase) throw await stop(`${id}'s head ${short(taskHead)} and main at ${short(mainHead)} have no merge base, so the landing cannot compare ${id}'s edits with code main moved to another file, and stops before merging main; Git and the workspace are unchanged.${String(based.stderr ?? "").trim() ? ` Git said: ${String(based.stderr).trim()}` : ""}`);
  const revs = `task ${taskHead}, main ${mainHead}, merge base ${mergeBase}`;
  const shortRevs = `task ${short(taskHead)}, main ${short(mainHead)}, merge base ${short(mergeBase)}`;
  let report;
  try { report = await detectMovedEditsAsync((args) => git(args, { cwd: dir, raw: true, env: DETECTOR_ENV }), { task: taskHead, main: mainHead, mergeBase }); }
  catch (error) { throw await stop(`the comparison of ${id}'s edits with code main moved to another file failed (${shortRevs}), so the landing stops before merging main; Git and the workspace are unchanged: ${error.message}`); }
  // The workspace's moved-code log (cli/landing.mjs), flushed before the
  // landing goes on; one that cannot be written stops it.
  const log = async (entry) => {
    try { appendMovedCodeRecord(await git(["rev-parse", "--absolute-git-dir"], { cwd: dir }), { at: new Date().toISOString(), project: name, item: id, task: taskHead, main: mainHead, mergeBase, ...entry, ambiguous: report.ambiguous }); }
    catch (error) { throw new StepError(`the moved-code comparison (${shortRevs}) could not be written to ${id}'s workspace log, so the landing stops before merging main; Git and the workspace are unchanged: ${error.message}`); }
  };
  for (const a of report.ambiguous) print(`Warning: ${describeAmbiguous(a)}.`);
  const ambiguity = report.ambiguous.length ? `; ${report.ambiguous.length} ambiguous match${report.ambiguous.length === 1 ? "" : "es"}, not taken for a move` : "";
  if (!report.findings.length) {
    print(`Compared ${id}'s edits with code main moved to another file (${shortRevs}): none found${ambiguity}.${moved.ok ? " --moved-ok had nothing to approve." : ""}`);
    await log({ kind: "compared", findings: [] });
    return `moved-code comparison at ${revs}: no edit in moved code${ambiguity}`;
  }
  const n = report.findings.length, findings = `${n} finding${n === 1 ? "" : "s"}`;
  const keys = report.findings.map(findingKey).sort();
  const listed = report.findings.map((f) => `  - ${describeFinding(f)}`).join("\n");
  const paths = [...new Set(report.findings.flatMap((f) => [f.source.path, f.destination.path]))];
  if (typeof moved.port === "function") {
    // A runner's merge before a build's submission (t435): the findings go
    // to the builder, who ports the edits in this run once main is merged.
    const resolver = moved.resolver ?? "the builder";
    print(`${id}'s edits lie in code main moved to another file (${shortRevs}):\n${listed}\nThe merge of main goes on, and ${resolver} ports each edit to its destination in this run.`);
    await log({ kind: "handed", resolver, findings: report.findings });
    await moved.port(report.findings);
    return `moved-code comparison at ${revs}: ${findings} handed to ${resolver} to port after the merge`;
  }
  const approved = moved.approved;
  const same = approved && approved.task === taskHead && approved.main === mainHead && approved.mergeBase === mergeBase && approved.keys.join("\n") === keys.join("\n");
  if (moved.ok && (!approved || same)) {
    if (!approved) {
      // Recorded before the landing goes on: on the ledger, which takes a
      // landing's steps from the project owner alone, and in the log.
      const actor = io.owner ?? "the developer";
      const summary = `--moved-ok: ${actor} approved ${findings} at ${revs}: ${report.findings.map(describeFinding).join("; ")}`;
      try { await request("POST", `/projects/${encodeURIComponent(name)}/items/${encodeURIComponent(id)}/land`, { step: "merge", ms: 0, head: taskHead, resolvedBy: `${actor} with --moved-ok`, conflicts: paths.map((p) => p.slice(0, 200)), reason: summary.slice(0, 500) }); }
      catch (error) { throw new StepError(`the --moved-ok approval of ${findings} (${shortRevs}) could not be recorded on the ledger, so the landing stops before merging main; Git and the workspace are unchanged: ${error.message}`); }
      await log({ kind: "moved-ok", actor, findings: report.findings });
      moved.approved = { task: taskHead, main: mainHead, mergeBase, keys };
    }
    print(`${id}'s edits lie in code main moved to another file (${shortRevs}):\n${listed}\n--moved-ok: your approval of exactly these ${findings} at these revisions is recorded; the landing goes on, and a conflict in Git's merge still stops it.`);
    return `moved-code comparison at ${revs}: ${findings} approved with --moved-ok`;
  }
  const fresh = moved.ok && approved
    ? `--moved-ok approved the findings at task ${short(approved.task)}, main ${short(approved.main)}, merge base ${short(approved.mergeBase)}; this comparison is at other revisions or found other edits, so it needs a fresh approval. `
    : "";
  const instructions = `To port them: merge main into the workspace (in ${JSON.stringify(dir)}, or have the task's builder do it: atelier dispatch ${id} --job merge-main), make each edit again at its destination, commit, push with atelier push, and run ${moved.again} again, which compares afresh. If a finding is wrong, ${moved.again} --moved-ok records your approval of exactly the findings it detects at those revisions and goes on.`;
  await log({ kind: "stopped", findings: report.findings, instructions });
  throw await stop(`${fresh}${id}'s edits lie in code main moved to another file, so the landing stops before merging main; Git and the workspace are unchanged (${shortRevs}):\n${listed}\nA merge would leave each edit in the old place, or stop on a conflict there, and the moved code would never get it. ${instructions}`, {
    reason: `moved-code comparison at ${revs}: ${findings} stopped the landing before the merge; port each edit to its destination, then land again: ${report.findings.map(describeFinding).join("; ")}`,
    conflicts: paths.map((p) => p.slice(0, 200)),
  }, { moved: true });
}

// The workspace half of a landing: merge main into the task's workspace
// (no-ff, so the task carries main's commits as a merge of their own),
// through the merge pipeline, which regenerates declared outputs once the
// sources merge and unites declared record files by key, raise the
// merged route level where main and the task each raised it (t248),
// regenerate the fixtures and commit what changes. The CLI's own landing
// and the Workflow executor (below) run the same code, so a landing
// behaves the same whichever engine drives it. `guard` is the calling
// pipeline's lease guard, which throws once the lease is no longer this
// landing's; every failure throws a StepError carrying the failed
// step's data. Answers the head the workspace reached, main's head and
// whether main was merged at all.
//
// A build's runner runs the same code before it submits (t435,
// prepareBuildSubmission in cli/runner.mjs), so the merge it makes
// regenerates what the landing's would, settles the same conflicts and
// runs the same moved-code comparison: its `git` runs each command as a
// runner child, so every call here is awaited, which the landing's
// synchronous git does not mind; `base` is the baseline token it already
// read through the project's baseline-token route, which a runner token
// may call where the item's base-token answers only for the job it holds,
// so no request is made here; `message` names the merge commit's message
// from main's head, ending in the builder's Agent line where the landing's
// names the landing; and `moved.port` takes the comparison's findings
// instead of stopping, so the merge goes on and the builder ports the
// edits in the same run (compareMoved). A baseline that cannot be fetched
// is the network's or the server's failure, not the build's: the error
// carries `infrastructure`, which the runner counts as such and the
// landing does not read.
export async function mergeMainAndRegenerate(io, { dir, id, name, regenerate, record, guard, d0, base = null, message = null, moved = { ok: false, approved: null, again: `atelier land ${id}` } }) {
  const { request, git, print } = io;
  guard();
  const t0 = Date.now();
  const read = base ?? await request("POST", `/projects/${encodeURIComponent(name)}/items/${encodeURIComponent(id)}/base-token`, { scope: "read" });
  try { await git(["fetch", "--quiet", read.remote, read.defaultBranch], { cwd: dir, token: read.token }); }
  catch (error) { throw Object.assign(error, { infrastructure: true }); }
  const mainHead = await git(["rev-parse", "FETCH_HEAD"], { cwd: dir });
  const mergeMessage = message ? message(mainHead) : `Merge main into ${id}\n\nAtelier land: main at ${mainHead}`;
  let fromMain = [], mergedIn = false, settled = null, settledConflicts = [], routeLevel = null, regenerated = null, movedNote = null;
  if ((await git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], { cwd: dir, allowFail: true })).status === 0) {
    // Main already merged leaves nothing to compare (t471): a move that an
    // earlier merge of main brought in lies behind the merge base.
    movedNote = `moved-code comparison: main ${mainHead} is already in ${id}'s head ${await git(["rev-parse", "HEAD"], { cwd: dir })}, so nothing was compared and edits an earlier merge of main left in moved code cannot be detected`;
    print(`main at ${short(mainHead)} is already merged into ${id}'s workspace. With main already merged there is nothing to compare, so this landing cannot detect edits that an earlier merge of main left in code main had moved to another file.`);
  } else {
    // Edits in code main moved to another file stop the landing here,
    // before Git merges anything (t471); a runner's merge goes on and
    // hands them to the builder (moved.port).
    movedNote = await compareMoved(io, { dir, id, name, record, moved, t0, mainHead });
    const forkPoint = await git(["merge-base", "HEAD", "FETCH_HEAD"], { cwd: dir });
    fromMain = (await git(["rev-list", "--max-count=200", `${forkPoint}..FETCH_HEAD`], { cwd: dir })).split("\n").filter(Boolean);
    // The merge goes through the pipeline (cli/merge-pipeline.mjs): record
    // files unite by key, and outputs the project declares as generated are
    // regenerated once every source has merged, never resolved by hand or
    // taken from a side. Source conflicts, record conflicts and duplicate
    // keys stop the landing with nothing generated, the merge left in the
    // workspace for the owner; a generator that fails, writes outside its
    // outputs or is not deterministic stops it with the merge aborted. A
    // runner's git, which runs each command as a child, goes through it
    // too, and its generators run as the runner's (`runGenerator`).
    const pipeline = () => mergeThrough(dir, "FETCH_HEAD", { git, message: mergeMessage, leave: true, run: io.runGenerator, log: print });
    let r = await pipeline(), unsettled = null;
    // A project that declares nothing (no bin/merge-manifest.json) keeps
    // the regenerate command's settlement: a conflict that lies only in
    // files the command rewrites is not the owner's to settle by hand, so
    // each conflicted file is taken from ours (theirs where the task
    // deleted it), the command runs, and when it rewrote every conflicted
    // file, what it wrote is committed as the resolution; what it changed
    // elsewhere waits for the regenerate step below, which runs it once
    // more. A file the command left exactly as the side taken is not one it
    // rewrites, so the landing stops as it always did: the workspace was
    // clean before the merge began, so a hard reset returns it to where the
    // merge started and the merge made again leaves the conflicts in it for
    // the owner. A project that declares its outputs is held to its
    // declarations alone.
    if (r.state === "conflicts" && !r.manifest && regenerate && r.source.length && !r.records.length && !r.problems.length) {
      const conflicts = r.source;
      print(`The merge stops on conflicts in ${conflicts.join(", ")}; taking either side and regenerating with \`${regenerate}\`…`);
      const shaOf = async (file) => (existsSync(join(dir, file)) ? await git(["hash-object", "--", file], { cwd: dir }) : "gone");
      // Only what the command writes may be staged below, so a file that
      // is dirty already (another agent's, t344) refuses the landing first.
      // The merge's own state is not that: conflicted entries and what the
      // merge staged have a blank or unmerged work-tree column.
      const foreign = dirtyPaths(await git(["status", "--porcelain=v1", "-z", "-uall"], { cwd: dir, raw: true }), { unstaged: true }).filter((f) => !conflicts.includes(f));
      if (foreign.length) throw new StepError(`${id}'s workspace gained uncommitted changes since the landing began (${foreign.join(", ")}); the landing stops before regenerating so it does not commit them. Commit or set them aside, then run atelier land ${id} again`);
      const taken = new Map();
      let either = true, regen = null, unwritten = null;
      for (const file of conflicts) {
        if ((await git(["checkout", "--ours", "--", file], { cwd: dir, allowFail: true })).status !== 0
          && (await git(["checkout", "--theirs", "--", file], { cwd: dir, allowFail: true })).status !== 0) { either = false; break; }
        taken.set(file, await shaOf(file));
      }
      if (either) {
        regen = await runRegenerateIn(dir, regenerate, io);
        if (regen.ok) {
          unwritten = [];
          for (const file of conflicts) if (await shaOf(file) === taken.get(file)) unwritten.push(file);
        }
      }
      if (regen?.ok && !unwritten.length) {
        // Everything the command wrote is staged, not only the conflicts: a
        // file it changed outside them would otherwise stay dirty (t344).
        const produced = dirtyPaths(await git(["status", "--porcelain=v1", "-z", "-uall"], { cwd: dir, raw: true }), { unstaged: true });
        await git(["add", "-A", "--", ...new Set([...conflicts, ...produced])], { cwd: dir });
        await git(["commit", "--quiet", "--no-edit"], { cwd: dir });
        settled = "atelier land, taking either side and regenerating";
        settledConflicts = conflicts;
        print(`The conflicts were all in files \`${regenerate}\` rewrites; took either side and let the command write them again.`);
        r = { state: "merged", regenerated: [], records: [], generated: [] };
      } else {
        unsettled = !either ? "a conflicted file had neither side to take"
          : !regen.ok ? `the regenerate command \`${regenerate}\` failed (${regen.why})`
            : `the regenerate command left ${unwritten.join(", ")} as either side had it`;
        const back = await git(["reset", "--hard", "HEAD"], { cwd: dir, allowFail: true });
        if (back.status !== 0) print(`Warning: the workspace could not be reset after the regeneration did not settle the conflicts (${(back.stderr || back.stdout || "").trim()}); resolve what is there by hand`);
        else r = await pipeline();
      }
    }
    if (r.state === "merged" && (r.regenerated.length || r.records.length)) {
      settled = "atelier land, through the merge pipeline";
      settledConflicts = r.generated;
      regenerated = r.regenerated.map((g) => ({ name: g.name, outputs: g.outputs, log: g.log, logSha: g.logSha }));
      for (const g of r.regenerated) print(`Regenerated ${g.outputs.map((o) => `${o.path} (matches ${o.matches})`).join(", ")} with ${g.command.join(" ")}; its log is ${g.log}.`);
      if (r.records.length) print(`United the records of ${r.records.join(", ")} by key.`);
    }
    if (r.state !== "merged" && r.state !== "held") {
      const conflicts = [...(r.source ?? []), ...(r.records ?? []), ...(r.generated ?? [])];
      const reason = unsettled ?? (r.state === "conflicts" ? (r.problems?.length ? r.problems.join("; ") : null) : r.reason);
      const data = { fromMain, mainHead, ...(conflicts.length ? { conflicts, ...(r.source?.length ? { source: r.source } : {}), ...(r.generated?.length ? { generated: r.generated } : {}), resolvedBy: "the developer, by hand" } : {}), ...(reason ? { reason } : {}) };
      await record("merge", Date.now() - t0, { failed: true, ...data });
      // The conflicts can go back to the task's builder instead of the
      // owner's session (t243): a merge-main dispatch makes a runner
      // merge main here again — the workspace's reset clears the merge
      // this landing left — and brief the builder to resolve it, where a
      // plain rework dispatch would reset the workspace to a head that
      // cannot reach main. The holder is named, for a task that has one.
      const holder = typeof d0?.item?.owner === "string" && d0.item.owner.includes("/") ? d0.item.owner : null;
      throw new StepError(r.state === "conflicts"
        ? `the merge of main at ${short(mainHead)} into ${id}'s workspace stops on conflicts; nothing was regenerated.\n${describeConflicts(r, r.manifest)}\n${unsettled ? `Taking either side and regenerating did not settle them: ${unsettled}. ` : ""}The merge is left in the workspace for you to resolve: cd ${JSON.stringify(dir)}, fix the sources, regenerate the outputs, git add, git commit, then atelier push to record the resolution. Then run atelier land ${id} again. Or send them back to the task's builder${holder ? `, ${holder},` : ""} to resolve in this workspace: atelier dispatch ${id} --job merge-main${holder ? ` --agent ${holder.split("/")[0]} --model ${holder.split("/")[1]}` : ""}; its runner merges main at ${short(mainHead)} into the workspace again and leaves the conflicts for the builder to resolve, commit and push with atelier push, and then atelier land ${id} again.`
        : r.state === "stopped"
          ? `the merge of main at ${short(mainHead)} into ${id}'s workspace stopped: ${r.reason}\nNothing was merged; the merge was aborted and the workspace is where it was.${generatorOutput(r.regenerated)}`
          : `the merge of main at ${short(mainHead)} into ${id}'s workspace failed:\n${r.reason}\nNothing was merged; git left the workspace as it was.`, data);
    }
    mergedIn = r.state === "merged";
    print(`Merged main at ${short(mainHead)} into ${id}'s workspace (${fromMain.length} commit${fromMain.length === 1 ? "" : "s"} from main).`);
  }
  // Where main and the task each raised the route level from the fork
  // point, the merge was clean at the number they share — both sides
  // wrote the same line — so the merged tree carries both sides' routes
  // under a number that names either side's alone (t248). The merged
  // level is compared at the fork point, at the task's head before the
  // merge and at main's head, and raised to main's plus the task's own
  // raise, its own commit, so the number the merged CLI reports keeps
  // meaning the routes it calls. The comparison runs wherever the
  // workspace's HEAD holds main — the landing's own merge above, and a
  // rerun whose conflicted merge the owner resolved by hand, which
  // finds main already merged and would else skip it — and however main
  // reached HEAD: a merge that brought it in through a side branch (main
  // merged into the side branch, the side branch into the task's line)
  // lies off HEAD's first-parent line, so a --first-parent rev-list
  // misses it and the comparison would be skipped exactly where both
  // sides raised the level. The merge that brought main in is therefore
  // found by ancestry: HEAD's first-parent line is walked from HEAD
  // down, each commit tested for holding main
  // (git merge-base --is-ancestor), and the first commit whose history
  // does not hold it is the task's head before the merge — the merge
  // above it on the line, however main reached that merge, is the one
  // that brought main in. Where that head's merge base with main is
  // main itself, the task's line already held everything main had to
  // add, and the levels merge as they always did — as they also do for
  // a repo with no src/route-level.ts, where the comparison is skipped
  // and the landing goes on, or a level one side alone raised.
  const levelAt = async (rev) => {
    const shown = await git(["show", `${rev}:src/route-level.ts`], { cwd: dir, allowFail: true });
    const found = /export const ROUTE_LEVEL = (\d+);/.exec(shown.stdout ?? "");
    return found ? Number(found[1]) : null;
  };
  const holdsMain = async (rev) => (await git(["merge-base", "--is-ancestor", mainHead, rev], { cwd: dir, allowFail: true })).status === 0;
  const line = (await git(["rev-list", "--first-parent", "--max-count=200", "HEAD"], { cwd: dir })).split("\n").map((sha) => sha.trim()).filter(Boolean);
  let stepped = 0;
  while (stepped < line.length && await holdsMain(line[stepped])) stepped++;
  const taskHead = stepped > 0 && stepped < line.length ? line[stepped] : null;
  const based = taskHead ? await git(["merge-base", taskHead, mainHead], { cwd: dir, allowFail: true }) : null;
  const forkPoint = based && based.status === 0 ? String(based.stdout ?? "").trim() : null;
  if (taskHead && forkPoint && forkPoint !== mainHead) {
    const baseLevel = await levelAt(forkPoint), taskLevel = await levelAt(taskHead), mainLevel = await levelAt(mainHead), mergedLevel = await levelAt("HEAD");
    if (baseLevel !== null && taskLevel > baseLevel && mainLevel > baseLevel && mergedLevel !== null) {
      const rightLevel = mainLevel + (taskLevel - baseLevel);
      if (mergedLevel < rightLevel) {
        const levelFile = join(dir, "src", "route-level.ts");
        const named = /\b(?:declare|buildCapabilities)\s*\(/.test(readFileSync(levelFile, "utf8"));
        // Since t522 the level is frozen and a new capability declares no
        // level (t584): when neither side added a declaration that carries
        // one, the numbers say nothing about the capabilities, and the merge
        // stands as it is.
        const levelAdded = async (rev) => /^\+.*\blevel\s*:/m.test((await git(["diff", "-U0", forkPoint, rev, "--", "src/capability-declarations.ts"], { cwd: dir, allowFail: true })).stdout ?? "");
        if (named && !(await levelAdded(taskHead)) && !(await levelAdded(mainHead))) {
          print(`main and ${id} each raised the route level from ${baseLevel}, and neither added a capability declaration with a level, so the merged level ${mergedLevel} stands.`);
        } else {
          // A numeric raise alone would falsely map the task's capabilities to
          // main's old level. Keep the merge for the builder to resolve explicitly.
          if (named) {
            throw new StepError(`main and ${id} each raised the route level from ${baseLevel}; named capability legacy mappings need manual resolution. Move the task's new capability declaration levels above main's ${mainLevel}, set ROUTE_LEVEL to ${rightLevel}, and commit before rerunning atelier land ${id}. Keep main's published mappings unchanged.`);
          }
          writeFileSync(levelFile, readFileSync(levelFile, "utf8").replace(/export const ROUTE_LEVEL = \d+;/, `export const ROUTE_LEVEL = ${rightLevel};`));
          await git(["add", "--", "src/route-level.ts"], { cwd: dir });
          await git(["commit", "--quiet", "-m", `Raise the route level after merging main into ${id}\n\nAtelier land: main and ${id} each raised it from ${baseLevel}, so the merged level is ${rightLevel}`], { cwd: dir });
          routeLevel = { base: baseLevel, main: mainLevel, task: taskLevel, was: mergedLevel, set: rightLevel };
          print(`main and ${id} each raised the route level from ${baseLevel} (main to ${mainLevel}, ${id} to ${taskLevel}), and the merge left it at ${mergedLevel}: the merged CLI calls both sides' routes, so the level is raised to ${rightLevel}. Deploy the server from a checkout at route level ${rightLevel} or newer (npm run deploy, which records the commit it deploys) before the next landing or runner.`);
        }
      }
    }
  }
  await record("merge", Date.now() - t0, { fromMain, ...(routeLevel ? { routeLevel } : {}), ...(settled ? { conflicts: settledConflicts, resolvedBy: settled } : {}), ...(regenerated?.length ? { regenerated } : {}), ...(mergedIn ? {} : { skipped: true }), ...(movedNote ? { reason: movedNote.slice(0, 500) } : {}) });

  // The project's fixtures, regenerated now that both lines sit in one
  // tree, so the checks below see fixtures current with them. The command
  // runs in the workspace as a check runs, and what it changes is
  // committed before the push, as a commit of its own, so the head the
  // checks and the review are bound to holds it.
  if (regenerate) {
    guard();
    // Another agent may have edited the workspace since the landing began
    // (t344): refuse before the command runs, so nothing of theirs can be
    // told apart from what the command writes or be committed with it.
    const dirtyBefore = await git(["status", "--porcelain=v1", "-z", "-uall"], { cwd: dir, raw: true });
    if (dirtyBefore) throw new StepError(`${id}'s workspace gained uncommitted changes since the landing began (${dirtyPaths(dirtyBefore).join(", ")}); the landing stops before regenerating so it does not commit them. Commit or set them aside, then run atelier land ${id} again`);
    const start = Date.now();
    print(`Regenerating with \`${regenerate}\`…`);
    const r = await runRegenerateIn(dir, regenerate, io);
    if (!r.ok) {
      await record("regenerate", Date.now() - start, { command: regenerate, failed: true });
      throw new StepError(`the fixture regeneration command \`${regenerate}\` failed (${r.why}); the merge is left in the workspace. Fix the command (the project's policy declares it: atelier init --regenerate), then run atelier land ${id} again`);
    }
    let changed = false;
    const after = await git(["status", "--porcelain=v1", "-z", "-uall"], { cwd: dir, raw: true });
    if (after) {
      // Only what the command wrote is committed: the tree was clean before
      // it ran (checked above), so the files now dirty are the command's own
      // paths, staged by name, never `git add -A`.
      const toStage = dirtyPaths(after, { unstaged: true });
      if (toStage.length) await git(["add", "-A", "--", ...toStage], { cwd: dir });
      await git(["commit", "--quiet", "-m", `Regenerate after merging main into ${id}`], { cwd: dir });
      changed = true;
      print("Committed what the regeneration changed.");
    }
    await record("regenerate", Date.now() - start, { command: regenerate, changed });
  }
  return { head: await git(["rev-parse", "HEAD"], { cwd: dir }), mainHead, mergedIn, target: read.defaultBranch };
}

// The paths a `git status --porcelain=v1 -z` listing names. Each record is
// two status characters, a space and the path, ended by NUL; a rename or copy
// is followed by a second record holding the old path, which is skipped. The
// listing must be read untrimmed: its first record may start with a space.
// With unstaged, a path whose work-tree column is blank is left out: it is
// already staged, as `git rm` leaves a deletion, and `git add` refuses it.
export function dirtyPaths(listing, { unstaged = false } = {}) {
  const records = listing.split("\0"), paths = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.length < 4) continue;
    if (!unstaged || r[1] !== " ") paths.push(r.slice(3));
    if (r[0] === "R" || r[0] === "C" || r[1] === "R" || r[1] === "C") i++;
  }
  return paths;
}

// ── the landing as a Cloudflare Workflow (t280) ────────────────────────────

// `atelier land ID --workflow` lands the task through a Cloudflare Workflow
// (src/landing-workflow.ts), which runs the server's half of the pipeline as
// durable steps with retries: the required checks (in the checks mode
// `container`) or the reading of their observed results (in the mode
// `local`, the default), the submission, the review wait, then — only once
// the head is checked and approved (t550) — the landing lease, the check
// that main has not moved, the acceptance and the watch for the merge.
// This command starts the instance, or attaches to
// the task's live one, and is both its progress view and its executor for
// the steps that need Git with a working tree: it polls the stage the
// Workflow writes to the Ledger, says each new stage once, and
//   - at `workspace` (the Workflow waits for this machine, holding no
//     lease) merges main into the workspace, regenerates and pushes — the
//     same code as the plain landing — and in the local checks mode runs
//     the required checks in a clean clone (`atelier check`, as the plain
//     landing does), and reports the pushed head, or the conflicts it
//     stopped on, as a `workspace` event naming the round; a new round
//     comes when main moved before the Workflow took the lease, and is
//     worked the same way;
//   - at `conflict` (a pause from an earlier run, whose conflicts the owner
//     has since resolved and committed: the preflight refuses a workspace
//     with a merge in progress or uncommitted changes) sends `resume`;
//   - at `merge` (the Workflow holds the lease and has accepted) runs
//     `atelier merge` in the registered checkout.
// It ends when the instance completes or fails. Closing the laptop stops
// only this view: the Workflow keeps its place, and the same command run
// again attaches and goes on from the stage it reached.
// The retry of a failed read: every failure asks for the next wait, doubling
// from baseMs up to maxMs and never past the window, and says when the
// window has run out; one good read starts the window afresh. The clock is
// injected so a test needs no real time.
export function readRetry({ now = Date.now, windowMs = READ_WINDOW_MS, baseMs = POLL_MS, maxMs = READ_BACKOFF_MAX_MS } = {}) {
  let since = null, attempt = 0;
  return {
    ok() { since = null; attempt = 0; },
    next() {
      const t = now();
      since ??= t;
      const tried = t - since;
      if (tried >= windowMs) return { giveUp: true, tried };
      return { giveUp: false, tried, wait: Math.min(baseMs * 2 ** attempt++, maxMs, windowMs - tried) };
    },
  };
}

// Whether the server has answered that the landing Workflow is gone: the
// ledger remembers none, it names another instance, the read error says the
// instance does not exist, or the last status it saw was an end. Any other
// failed read (a network or 5xx error, an unknown status) says nothing about
// the instance and is read again.
export function workflowIsGone(read, startedInstance) {
  if (!read?.instance) return true;
  if (read.instance !== startedInstance) return true;
  if (/not found|not_found|does not exist|no such/i.test(read.readError ?? "")) return true;
  return !read.status && ["complete", "errored", "terminated"].includes(read.lastStatus?.status);
}

const LIVE = ["queued", "running", "waiting", "waitingForPause", "paused", "rollingBack"];

async function runLandWorkflow(io, { d0, itemPath, dir, regenerate, triage, moved }) {
  const { args, name, id, p, request, git, die, print } = io;
  const reviewer = args.reviewer, noReview = args["no-review"] === true;
  const wfPath = `${itemPath}/landing-workflow`;
  const leasePath = `/projects/${encodeURIComponent(name)}/landing-lease`;
  const record = landRecorder(io, itemPath);
  const sleep = (ms = POLL_MS) => new Promise((ok) => setTimeout(ok, ms));
  const reads = readRetry({ now: io.now });
  const unreadable = async (why) => {
    const step = reads.next();
    if (step.giveUp) return step;
    print(`Warning: the landing Workflow could not be read (${why}); trying again in ${Math.round(step.wait / 1000)}s, for up to ${Math.round(READ_WINDOW_MS / 1000)}s in all.`);
    await sleep(step.wait);
    return null;
  };
  // Each event and lease call names the instance this command attached to,
  // so once the server replaces it (t430) they are refused rather than
  // advance the replacement or touch its lease.
  let started;
  const send = (type, payload) => request("POST", wfPath, { event: { type, payload }, instance: started.instance });

  // Start, or attach to the task's live instance. An accepted task has
  // nothing left but its merge: it is landed through a live instance at
  // its merge stage, and otherwise merged by hand, as the plain landing says.
  let current = null;
  try { current = await request("GET", wfPath); } catch (error) { die(error.message); }
  const live = !!current?.instance && LIVE.includes(current.status?.status);
  if (d0.item.state === "accepted" && !live) die(`${id} is accepted at ${short(d0.item.acceptedHead)}; merge it with: atelier merge ${id}.`);
  // A landing that triages says so, and the Workflow then submits and asks
  // for the review only while the triage it is told of stands (t475).
  try { started = await request("POST", wfPath, { checks: "local", ...(reviewer ? { reviewer } : {}), ...(noReview ? { noReview: true } : {}), ...(triage.mode !== "off" ? { triage: true } : {}) }); }
  catch (error) { die(error.message); }
  // A live instance the server replaced rather than attach to (t430): it
  // waited for the lease past the limit, or the reviewer it was started
  // with is no longer eligible and this run named one who is.
  if (started.replaced) print(`Replaced ${id}'s landing Workflow ${started.replaced.from} with ${started.replaced.to} (${started.replaced.reason}): ${started.replaced.detail}.`);
  if (started.reviewerRefused) print(`Warning: ${started.reviewerRefused}; the live instance keeps its reviewer.`);
  print(started.created || started.replaced
    ? `Landing ${id} as a Cloudflare Workflow (instance ${started.instance}). The Workflow runs the submission and the review on Cloudflare as durable steps without the landing lease, then takes ${name}'s lease for the acceptance and the merge alone; this machine merges main, pushes, runs the required checks in a clean clone and merges when the Workflow asks, and the Workflow goes on only once the server has recorded every check passing at the pushed head. If this command stops, run atelier land ${id} --workflow again to attach.`
    : `Attached to ${id}'s landing Workflow (instance ${started.instance}, at ${started.stage ?? "its start"}).`);
  if (!started.created && !started.replaced && !started.reviewerRefused && ((reviewer && reviewer !== started.reviewer) || (noReview && started.noReview !== true))) print(`The live instance keeps the review options it was started with (${started.noReview ? "--no-review" : started.reviewer ? `reviewer ${started.reviewer}` : "the reviewer the gate picks"}); --reviewer and --no-review apply to a new landing.`);

  // The pause on a conflict, ended: the owner resolved and committed the
  // conflicts (the preflight saw the workspace clean), so the Workflow is
  // told to ask for the workspace steps again.
  if (!started.created && started.stage === "conflict") {
    await send("resume", { round: started.round });
    print(`Resumed the landing after the conflicts of round ${started.round + 1}; the Workflow asks for the merge of main again.`);
  }

  // The workspace steps hold no lease (t550): the Workflow takes it only
  // once the head they report is checked and approved, so nothing here
  // renews it, and nothing can be lost while they run.
  const guard = () => {};

  let lastStatus = started.status, lastInstance = started.instance;
  const queueState = async (read) => {
    if (typeof read?.queued === "boolean") return read.queued ? `${id} is still queued` : `${id} is not queued`;
    try {
      const lease = await request("GET", leasePath);
      return Array.isArray(lease.waiting) ? (lease.waiting.some((row) => row.item === id) ? `${id} is still queued` : `${id} is not queued`) : `whether ${id} is still queued is unknown`;
    } catch { return `whether ${id} is still queued is unknown`; }
  };
  let said = null, workedRound = null, mergedHere = false, saidWait = false;
  for (;;) {
    let read;
    try { read = await request("GET", wfPath); }
    catch (error) {
      const over = await unreadable(error.message);
      if (over) die(`the landing Workflow of ${id} could not be read for ${Math.round(over.tried / 1000)}s (last error: ${error.message}); instance ${lastInstance ?? "none"} is not known to have ended. Its lease lapses on its own. To attach again, run: atelier land ${id} --workflow.`, 1);
      continue;
    }
    const { instance, status, stage, round = 0, detail, files } = read ?? {};
    // A merged task reports no landing instance any more; when this CLI did
    // the merge itself, the landing is over, not lost (t308): say so and free
    // the lease now rather than leaving it to lapse.
    if ((!instance || !status) && mergedHere) {
      try { await request("POST", leasePath, { cancel: true, item: id }); } catch { /* a merged task's lease is already free on the server */ }
      print(`${id} landed through the landing Workflow; the lease is released.`);
      return;
    }
    let tried = "";
    if (!workflowIsGone(read, started.instance) && (!status || status.status === "unknown") && !mergedHere) {
      const over = await unreadable(read?.readError ?? "no status returned");
      if (!over) continue;
      tried = `the read failed for ${Math.round(over.tried / 1000)}s; `;
    } else if (status && status.status !== "unknown") reads.ok();
    if (!instance || !status || status.status === "unknown" || instance !== started.instance) {
      const last = instance === started.instance ? read?.lastStatus ?? lastStatus : lastStatus;
      die(`${tried}the landing Workflow of ${id} can no longer be read (instance ${lastInstance ?? "none"}); last status: ${last?.status ?? "unknown"}; last error: ${last?.error?.message ?? detail ?? "none recorded"}; read error: ${read?.readError ?? (instance && instance !== started.instance ? `replaced by ${instance}` : "no status returned")}; ${await queueState(read)}. Its lease lapses on its own. Inspect it with: npx wrangler workflows instances describe landing ${lastInstance}. To start or attach again, run: atelier land ${id} --workflow (a missing instance is cleared automatically; a live instance is reattached).`, 1);
    }
    lastStatus = status;
    lastInstance = instance;
    if (status.status === "complete") {
      if (noReview || status.output?.review === "skipped") print(`${id} is submitted and left for you to settle the review by hand (--no-review): atelier review ${id} --approve --as H/M --note "…", then atelier accept ${id} and atelier merge ${id}.`);
      else print(`${id} landed through the landing Workflow (instance ${instance}); the lease is released.`);
      return;
    }
    if (status.status === "errored" || status.status === "terminated") {
      die(`the landing Workflow ${instance} ${status.status === "terminated" ? "was terminated" : "failed"}: ${status.error?.message ?? detail ?? "no reason given"}; last status: ${status.status}; ${await queueState(read)}`, 1);
    }
    // A new instance's record begins at `lease` with no detail, before its
    // first step writes `workspace` (t550): said as starting, not as the
    // wait for the lease a checked and approved head makes, which names it.
    const shown = stage === "lease" && !detail ? "starting" : stage;
    const key = `${shown}:${round}:${stage === "review" ? detail ?? "" : ""}`;
    if (key !== said) {
      said = key;
      const what = {
        starting: "is starting",
        lease: "has the head checked and approved, and queues for the landing lease for the merge alone",
        workspace: `waits for this machine to merge main and push, holding no lease${detail ? ` (${detail})` : ""}`,
        conflict: `is paused on conflicts in ${(files ?? []).join(", ") || "the merge of main"}`,
        checks: "reads the observed results of the checks this machine ran",
        review: `waits for the review verdict${detail ? `. ${detail}` : ""}`,
        merge: "has accepted the reviewed head and waits for the merge",
        done: "is done",
        failed: `failed: ${detail ?? ""}`,
      }[shown] ?? `is at ${stage}`;
      print(`The landing Workflow ${what}${round ? ` (round ${round + 1})` : ""}.`);
    }

    if (stage === "workspace" && workedRound !== round) {
      workedRound = round;
      try {
        const current = await io.request("GET", itemPath);
        await prepareRecordedWorkspace(io, { dir, itemPath, detail: current });
        await ensureWorkspaceToken(io, { dir, id, itemPath, item: current.item });
        const merged = await mergeMainAndRegenerate(io, { dir, id, name, regenerate, record, guard, d0, moved });
        guard();
        await recordedHeadStillStands(io, itemPath, current.item.head);
        await pushRefreshing(io, { dir, id, itemPath }, () => { guard(); return landStep(io, record, "push", ["push"], dir, () => ({ head: merged.head })); });
        // The triage, before the checks and before the head is reported:
        // the Workflow submits and asks for the review only once it has the
        // head, and the checks' passing evidence asks again for a review
        // request the push withdrew from a task already submitted at an
        // older head (Ledger.reaskReview), so a triage that stops ends the
        // landing (the failed report below) with nothing submitted and no
        // review asked for. The binding goes with the head, and the
        // Workflow checks it against the Ledger before the submission and
        // again before the review request (t475).
        const triaged = await triageGate(io, { triage, dir, id, itemPath, head: merged.head, mainHead: merged.mainHead, target: merged.target, record, guard });
        guard();
        // The required checks run here, in a clean clone of the pushed head,
        // through the same `atelier check` step as the plain landing, before
        // the head is reported, so the server has recorded their observed
        // results when the Workflow reads them. A failure ends the landing
        // below, reported as a failed workspace.
        print(`Pushed ${short(merged.head)} to ${id}'s fork; running the required checks in a clean clone.`);
        await checkStep(io, itemPath, id, (kind, argv, cwd) => landStep(io, record, kind, argv, cwd), dir);
        guard();
        print(`The required checks pass at ${short(merged.head)}; reporting the head to the landing Workflow.`);
        await send("workspace", { round, head: merged.head, mainHead: merged.mainHead, mergedIn: merged.mergedIn, ...(triaged ? { triage: { base: triaged.base, criteria: triaged.criteria } } : {}) });
      } catch (error) {
        const conflicts = Array.isArray(error.data?.conflicts) && error.data.conflicts.length ? error.data.conflicts : null;
        // A conflict pauses the Workflow (it releases the lease and waits
        // for the owner); any other failure ends it with this message, which
        // the Workflow keeps to WORKSPACE_REASON_MAX: a failed check reports
        // the summary checkStep fitted to that size (its data's
        // workflowReason), so it is never cut here; any other message,
        // conflicts included, is cut at it. Edits in code main moved
        // pause it the same way (t471), naming the moved code's files,
        // though no merge was made: the resume asks for the workspace steps
        // again, which compare afresh.
        const reason = String(typeof error.data?.workflowReason === "string" ? error.data.workflowReason : error.message).slice(0, WORKSPACE_REASON_MAX);
        try { await send("workspace", conflicts ? { round, conflict: true, files: conflicts, reason } : { round, failed: true, reason }); }
        catch { /* the Workflow times out on its own and releases the lease */ }
        die(conflicts && error.data.moved
          ? `${error.message}\nThe landing Workflow is paused at its conflict stage, holding no lease; no merge was made, so nothing is left to resolve in the index. Once the edits are ported, committed and pushed with atelier push, run atelier land ${id} --workflow again: it resumes this landing and compares afresh (with --moved-ok, it records your approval of the findings it detects and goes on).`
          : conflicts
          ? `${error.message}\nThe landing Workflow is paused at its conflict stage, holding no lease. Once the conflicts are resolved, committed and pushed with atelier push, run atelier land ${id} --workflow again: it resumes this landing.`
          : error.message);
      }
    }

    if (stage === "merge" && !mergedHere) {
      mergedHere = true;
      print(`${id} is accepted; merging in ${p.path}…`);
      for (let tried = 0; ; tried++) {
        const r = await runCommand([process.execPath, io.atelier, "merge", id, "--project", name], { cwd: p.path, env: io.env });
        if (r.passed) {
          await record("merged", r.durationMs, { mergeCommit: git(["rev-parse", `refs/heads/${p.branch}`], { cwd: p.path }) });
          print(`${id} merged: ${r.output.split("\n").filter(Boolean).at(-1) ?? "merged"}`);
          break;
        }
        // The server refuses to merge the head into a main other than the
        // one the Workflow confirmed under the lease (t550): it goes back
        // for a merge of the new main, new checks and a review.
        if (/main_moved|since .*'s landing confirmed it under the lease/.test(r.output)) {
          die(`${r.output.split("\n").filter(Boolean).slice(-6).join("\n")}\nNothing was merged: ${id} was checked and reviewed against an older main.`);
        }
        // The Workflow renews the lease while it waits for the merge (t550);
        // a landing_lease refusal means it was freed by hand and another
        // landing took it, which finishes first. The merge is tried after
        // it, and the server refuses it if that landing moved main.
        if (/landing_lease|one landing runs at a time/.test(r.output) && tried < 720) {
          if (!saidWait) { print(`The merge waits: another task's landing holds ${name}'s landing lease. Trying again every ${Math.round(POLL_MS / 1000)}s…`); saidWait = true; }
          await sleep();
          continue;
        }
        die(`atelier merge failed (exit ${r.status ?? "ended by a signal"}):\n${r.output.split("\n").filter(Boolean).slice(-12).join("\n")}\nThe landing Workflow keeps waiting for the merge; fix what failed and run atelier land ${id} --workflow again.`);
      }
    }
    await sleep();
  }
}
