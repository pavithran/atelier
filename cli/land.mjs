import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkEnv } from "./check-env.mjs";
import { excludeScratch } from "./scratch.mjs";
import { runCommand } from "./ship.mjs";
import { ROUTE_LEVEL } from "../src/route-level.ts";
import { LANDING_LEASE_EXPIRY_MS, landingLeaseLapsed } from "../src/landing-lease.ts";
import { unoffered } from "../src/dispatch/rules.ts";
import { sameActor } from "../src/rules.ts";
import { landingVerdict } from "../src/landing-verdict.ts";

// atelier land (t187): the project owner lands one task whole, taking the
// project's landing lease on the server so two sessions never race main.
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
// While another task's landing holds the lease the landing refuses, or with
// --wait (t223) queues for it, saying whose landing it waits behind, and
// starts as soon as the lease is free, so several landings started at once
// run in turn.
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
// The push uses the workspace's write token, which lapses 8 hours after the
// claim that minted it (t275), and a push refused for it would end a landing
// that already holds the lease and has merged main. So before the lease (the
// Workflow's too, whose push runs here, and again after a --wait) a token
// that has lapsed or lapses within TOKEN_WINDOW_MS is refreshed, and a push
// still refused as expired is refreshed and tried once more. A refresh re-claims
// the task as its current holder, as `atelier claim ID` run by the holder
// does, never as the owner, whose claim would take the task over.

const POLL_MS = Number(process.env.ATELIER_LAND_POLL_MS ?? 5000);
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
// How Artifacts refuses a push whose token has lapsed or was revoked.
const EXPIRED_TOKEN = /Invalid or expired token/i;

const short = (sha) => (sha ? sha.slice(0, 8) : "—");

// A step that failed carries its own event data beside the failure: the files
// a conflict stopped on, or which check failed.
class StepError extends Error {
  constructor(message, data = {}) { super(message); this.data = data; }
}

export async function runLand(io) {
  const { args, name, id, p, request, git, die, print } = io;
  const dryRun = args["dry-run"] === true;
  const noReview = args["no-review"] === true;
  const wait = args.wait === true;
  const releaseLease = args["release-lease"] === true;
  const workflow = args.workflow === true;
  const reviewer = args.reviewer;
  // Where a Workflow landing runs the required checks (t305): "local" (the
  // default) runs them here in a clean clone, as the plain landing does, and
  // the Workflow waits for their observed results; "container" has the
  // Workflow run them in the CheckRunner container. Atelier's own suite does
  // not finish in the container's default instance, hence the default.
  const checksMode = args.checks;
  if (checksMode !== undefined && !workflow) die("--checks says where a Workflow landing runs the required checks; give it with --workflow (the plain landing always runs them here, in a clean clone)");
  if (checksMode !== undefined && checksMode !== "local" && checksMode !== "container") die(`--checks takes local or container: atelier land ${id} --workflow --checks local|container`);
  if (releaseLease && (dryRun || noReview || wait || reviewer !== undefined || workflow)) die("--release-lease frees the project's landing lease and does nothing else; give it alone");
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
    const { lease } = await request("GET", leasePath);
    if (!lease) { print(`No landing lease is held in ${name}; nothing to release.`); return; }
    if (lease.item !== id) die(`the landing lease in ${name} is held for ${lease.item}, not ${id}: ${lease.holder} has been landing ${lease.item} since ${since(lease)}. Free it with atelier land ${lease.item} --release-lease`);
    // The cancel names the task, so the server frees ${id}'s lease alone.
    const { lease: freed } = await request("POST", leasePath, { cancel: true, item: id });
    print(`Released the landing lease of ${name}: ${(freed ?? lease).holder} held it for ${id} since ${since(freed ?? lease)}. Another task may land.`);
    return;
  }

  // The server's route level against this CLI's: a server older than the
  // routes this command calls would fail them one by one, so the landing
  // refuses here instead, saying to deploy, before the lease or any
  // workspace changes. The level (src/route-level.ts) rises only when a CLI
  // starts calling a route the server did not have; which commit either
  // side runs says nothing, since every merge moves the CLI past the
  // deployed one.
  let version = null;
  try { version = await request("GET", "/version"); } catch { /* a server with no version route is one that predates it */ }
  const level = Number.isInteger(version?.routeLevel) ? version.routeLevel : null;
  const deploy = (why) => `the server ${typeof version?.commit === "string" && version.commit ? `runs main at ${short(version.commit)}, ` : ""}${level === null ? "reports no route level" : `runs route level ${level}`}, this CLI route level ${ROUTE_LEVEL}: ${why}. Deploy the server from a checkout at route level ${ROUTE_LEVEL} or newer (npm run deploy, which records the commit it deploys), then run atelier land ${id} again`;
  if (!version) die(deploy("the server does not answer GET /api/version"));
  if (level === null) die(deploy("the server is older than route levels"));
  if (level < ROUTE_LEVEL) die(deploy("the server's routes are older than the ones this CLI calls"));

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
  const waitingOn = dryRun || wait ? await blocking(lease) : null;
  if (waitingOn && dryRun && !wait) die(`a landing is already in progress: ${waitingOn.holder} has been landing ${waitingOn.item} since ${since(waitingOn)}. One landing runs at a time in ${name}; wait for it (atelier land ${id} --wait queues behind it), run atelier land ${waitingOn.item} again to finish or release that landing, or free the lease with atelier land ${waitingOn.item} --release-lease`);

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
  const preflight = async (throwing = false) => {
    const no = (message) => { if (throwing) throw new StepError(message + heldNote); refuse(message); };
    const d = await request("GET", itemPath);
    if (["merged", "abandoned"].includes(d.item.state)) no(`${id} is ${d.item.state}; there is nothing to land.`);
    // A plan's branch holds only the integrator's recorded integrations and
    // refreshes; the merge of main a landing makes would put a commit beside
    // them, and planGate refuses a plan whose head is not its integration head.
    if (d.item.kind === "plan") no(`${id} is a plan, which atelier land does not land: a plan lands with atelier merge ${id} --head INTEGRATION_HEAD, the integration head atelier plan show ${id} prints, and a plan branch that is behind main takes main through atelier plan refresh ${id}.`);
    // Through the Workflow an accepted task is not a refusal but a resume:
    // its workspace work is behind it, and the landing goes on from the
    // acceptance (the merge the Workflow waits for).
    if (d.item.state === "accepted" && !workflow) no(`${id} is accepted at ${short(d.item.acceptedHead)}; merge it with: atelier merge ${id}.`);
    if (!existsSync(join(dir, ".git"))) no(`${id} has no workspace on this Mac (${dir}); it has nothing to land. Run atelier claim ${id} --as H/M first, or land a task that has one.`);
    const held = { project: git(["config", "--local", "atelier.project"], { cwd: dir, allowFail: true }).stdout?.trim(), item: git(["config", "--local", "atelier.item"], { cwd: dir, allowFail: true }).stdout?.trim() };
    if (held.project !== name || held.item !== id) no(`${dir} is not ${id}'s workspace (its Git config names ${held.project ?? "no project"}/${held.item ?? "no item"}); land ${id} from the machine holding its workspace.`);
    if (existsSync(join(dir, ".git", "MERGE_HEAD"))) no(`a Git merge is already in progress in ${id}'s workspace; resolve and commit it (or git merge --abort), then run atelier land ${id} again.`);
    // An agent's notes and a harness's logs under .scratch/ are not work to
    // commit (excludeScratch, t257).
    excludeScratch(dir);
    if (git(["status", "--porcelain"], { cwd: dir })) no(`${id}'s workspace has uncommitted changes; commit or set them aside before landing.`);
    return d;
  };
  const d0 = await preflight();
  const regenerate = typeof d0.policy?.regenerate === "string" ? d0.policy.regenerate : null;

  if (dryRun) {
    // Where the dry run would wait: behind the holder of the lease, and
    // behind the landings queued for it ahead of this one (t249).
    const ahead = aheadOf(waitingRows);
    const queuedAhead = ahead.length ? `${ahead.length} landing${ahead.length === 1 ? "" : "s"} queued ahead of ${id}: ${ahead.map((w) => `${w.item} (queued ${since(w)})`).join(", ")}` : null;
    print(`Dry run: atelier land ${id} in ${name} would:`);
    print(`  1. ${waitingOn || queuedAhead ? `wait behind ${[waitingOn ? `${waitingOn.holder}'s landing of ${waitingOn.item} (since ${since(waitingOn)})` : null, queuedAhead].filter(Boolean).join(", and ")}, then ` : ""}take the project's landing lease for ${id} (one landing at a time in ${name}, in the order the landings queued)`);
    print(`  2. merge main into ${id}'s workspace (${dir}); on conflicts, stop and leave them for you to resolve, naming the files, or send them to the task's builder: atelier dispatch ${id} --job merge-main; where main and the task each raised the route level (src/route-level.ts) from one base, raise the merged level past both, wherever the workspace's HEAD holds main — this landing's own merge, a rerun of one you resolved by hand, or a merge that brought main in through a side branch`);
    print(`  3. ${regenerate ? `regenerate the project's fixtures with \`${regenerate}\` and commit what changes; a merge that conflicts only in files that command rewrites is settled by taking either side and regenerating` : "regenerate nothing (the project declares no regenerate command)"}`);
    print(`  4. push the merged head to ${id}'s fork`);
    print(`  5. run the required checks (${d0.policy?.checks?.join(", ") || "none"}) in a clean clone of the pushed head`);
    print(`  6. submit ${id} with a summary of the merge`);
    print(noReview
      ? "  7. skip the review (--no-review): leave the task submitted for you to settle by hand"
      : `  7. ${reviewer ? `ask ${reviewer} to review` : "ask the server for the independent review the gate needs and wait for"} the verdict at the pushed head, for up to ${Math.round(REVIEW_TIMEOUT_MS / 60000)} minutes`);
    if (!noReview) {
      print(`  8. accept ${id} at the pushed head`);
      print(`  9. merge ${id} in ${p.path} and publish the merge to the baseline`);
    }
    print(`${noReview ? "  8" : " 10"}. record each step, its duration and the commits from main as land.* events; release the lease (renewed every ${Math.round(LEASE_RENEW_MS / 1000)}s meanwhile, and released on SIGINT or SIGTERM)`);
    print("Nothing was changed.");
    return;
  }

  // The Workflow landing (t280): everything below is the CLI's own
  // pipeline, unchanged; --workflow hands the same pipeline to a
  // Cloudflare Workflow and stays as its executor instead. --wait needs
  // no separate handling there: the Workflow queues for the lease by
  // itself, in the order the landings asked.
  if (workflow) {
    if (wait) print("--wait is the Workflow's own behaviour: it queues for the lease in the order the landings asked, and takes it when its turn comes.");
    await ensureWorkspaceToken(io, { dir, id, itemPath, item: d0.item });
    return runLandWorkflow(io, { d0, itemPath, dir, regenerate });
  }
  await ensureWorkspaceToken(io, { dir, id, itemPath, item: d0.item });

  // From here every failure throws rather than dying, so the lease is
  // released and the step recorded before the command ends. The recorder
  // is the module's own (below), shared with the Workflow executor (t280).
  const record = landRecorder(io, itemPath);
  // The heartbeat renews the lease while the landing runs; the timer never
  // keeps the process alive on its own (unref), and a renewal the server
  // refuses says the lease is no longer this landing's, which is reported
  // once rather than retried.
  let leased = false, beating = false, takenOverBy = null, everQueued = false;
  // A landing queued with --wait leaves the server's queue when its wait
  // ends without a lease, so the landings behind it do not wait for a peer
  // that no longer waits; one that took the lease has no row to leave (its
  // taking spent it). A leave that cannot be asked only costs the wait, not
  // the order: the row lapses on its own once the expiry passes without an
  // ask.
  const leaveQueue = async () => {
    try { await request("POST", leasePath, { item: id, queued: true, leave: true }); }
    catch { /* the row lapses on its own after the expiry */ }
  };
  const release = async () => {
    beating = false;
    if (everQueued && !leased) await leaveQueue();
    if (!leased) return;
    leased = false;
    // The cancel names this task: a lease that lapsed, or whose task has
    // merged, was free for another landing to take, and the server leaves
    // the taker's lease alone. A refusal naming that landing is the
    // handover (t237) — a landing queued with --wait took the lease in the
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
        print(`The landing lease of ${name} is held for ${takenOverBy}'s landing now, so this release left it alone: the server treats a merged task's lease (a lapsed one the same way) as free, so a landing queued with --wait takes it in the moment after the merge, and that landing holds and renews it. Nothing of ${id}'s landing is stranded.`);
        return;
      }
      print(`Warning: the landing lease could not be released; a later landing of ${id} takes it over, and it lapses on its own after ${Math.round(LANDING_LEASE_EXPIRY_MS / 60000)} minutes: ${error.message}`);
    }
  };
  // A signal releases the lease, then ends the command with the signal's
  // conventional status, so a landing stopped by Ctrl-C or kill leaves no
  // lease behind. A Ctrl-C reaches the step's child process through the
  // process group as well. While --wait queues nothing is held, so a signal
  // then releases no lease, but it leaves the queue the landing holds a
  // place in (t249).
  const onSignal = (signal) => {
    print(`${signal} received; releasing the landing lease of ${name}…`);
    release().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, onSignal);
  // --wait polls for the lease until no live task holds it and no landing
  // queued earlier still waits, saying whose landing it waits behind each
  // time that changes, and gives up after WAIT_TIMEOUT_MS from when it began
  // to queue. Each poll asks the server as a landing queued for the lease
  // (t249): the ask refreshes this landing's place in the server's queue —
  // the order the landings queued, which the lease is handed down — and
  // answers the lease and the queue as the server sees them. Nothing is
  // taken by an ask, so ending the command while it queues leaves no lease
  // to release, only the queue place, which a leave (above) or the expiry
  // clears.
  const queuedSince = Date.now();
  const timedOut = async (current, first = null) => {
    await leaveQueue();
    die(current || !first
      ? `the landing lease was not free within ${WAIT_TIMEOUT_MS < 60_000 ? `${Math.round(WAIT_TIMEOUT_MS / 1000)} seconds` : `${Math.round(WAIT_TIMEOUT_MS / 60_000)} minutes`}${current ? `: ${current.holder} still holds it for ${current.item}` : ""}. Nothing was changed; run atelier land ${current?.item ?? id} again to finish or release that landing, or free it with atelier land ${current?.item ?? "ID"} --release-lease, then atelier land ${id} again`
      : `the landing lease was not ${id}'s within ${WAIT_TIMEOUT_MS < 60_000 ? `${Math.round(WAIT_TIMEOUT_MS / 1000)} seconds` : `${Math.round(WAIT_TIMEOUT_MS / 60_000)} minutes`}: ${first.holder}'s landing of ${first.item} is still first in the queue for it. Nothing was changed; run atelier land ${id} --wait again to queue once more, or wait for ${first.item}'s landing to take the lease and finish`);
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
      const key = `${current?.holder ?? ""} ${current?.item ?? ""} ${current?.at ?? ""}|${list}`;
      if (key !== shown) {
        print(current
          ? `Waiting behind ${current.holder}'s landing of ${current.item} (since ${since(current)})${ahead.length ? `, with ${ahead.length} landing${ahead.length === 1 ? "" : "s"} queued ahead of ${id}: ${list}` : ""}; ${id} starts ${ahead.length ? "when its turn comes, in the order the landings queued" : "as soon as the lease is free"}.`
          : `Waiting for the lease behind ${ahead.length} landing${ahead.length === 1 ? "" : "s"} queued ahead of ${id}: ${list}; ${id} takes the lease when its turn comes, in the order the landings queued.`);
        shown = key;
      }
      if (Date.now() - queuedSince >= WAIT_TIMEOUT_MS) await timedOut(current, ahead[0] ?? null);
      await new Promise((ok) => setTimeout(ok, POLL_MS));
    }
  };

  try {
    let t0 = Date.now();
    let queued = !!waitingOn;
    for (;;) {
      if (queued) {
        await queue();
        await preflight(true);
        // The wait can outlast the token checked before it.
        await ensureWorkspaceToken(io, { dir, id, itemPath, item: d0.item });
      }
      // The lease step's duration is the taking alone: time spent queued
      // behind another landing is not this task's cost of landing.
      t0 = Date.now();
      try {
        const { item, expired } = await request("POST", leasePath, { item: id });
        leased = true;
        if (expired) print(`Took over the landing lease of ${name} from ${expired.holder}, which had been landing ${expired.item} since ${since(expired)} and stopped renewing it ${Math.round((Date.now() - Date.parse(expired.renewedAt ?? expired.at)) / 60000)} minutes ago; that landing is treated as ended.`);
        print(`Landing lease taken for ${id} (${item.state}); one landing at a time in ${name}.`);
        break;
      } catch (error) {
        const refused = /^landing_lease: /.test(error.message);
        // Another queued landing can take the lease between the poll and
        // this request, the server can judge live a lease this machine's
        // clock judged lapsed, or a landing that queued earlier can still
        // be first for it (t249); with --wait this one waits a beat and
        // queues again behind it.
        if (wait && refused) {
          if (Date.now() - queuedSince >= WAIT_TIMEOUT_MS) await timedOut(null);
          queued = true;
          await new Promise((ok) => setTimeout(ok, POLL_MS));
          continue;
        }
        const why = error.message.replace(/^landing_lease: /, "") || `the landing lease could not be taken: ${error.message}`;
        throw new StepError(refused ? `${why.replace(/\.$/, "")}; or atelier land ${id} --wait queues behind it and starts when its turn comes` : why);
      }
    }
    // A renewal the server refuses (a 4xx, such as no_lease) says the lease
    // is no longer this landing's: the heartbeat stops, the loss is said
    // once, and the release at the end leaves the lease alone, since it is
    // another landing's now. A renewal that fails to reach the server, or
    // that the server fails (a 5xx), is retried on the next beat and warned
    // of once, until a renewal succeeds again.
    // A landing that has lost the lease stops (t232): the loss is learned
    // here or by the renewal before the publishing steps, and guardLease
    // stops the next step (the wait for a verdict with it), so the landing
    // never accepts or merges beside the landing that holds the lease now.
    let renewFailing = false, lostLease = null;
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
    // The steps that publish to main ask for the lease by hand first, so a
    // landing whose heartbeat has not had a beat since the loss (the Mac
    // slept through the takeover and woke at the verdict) learns it here and
    // stops before accepting. A renewal that cannot reach the server, or
    // that the server fails, decides nothing here: the accept and the merge
    // call the server themselves and stop if it still cannot be asked.
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
    // stopped — the landing ended, or lost the lease — sends no further
    // renewal, whatever a slow beat was still answering when it stopped.
    const beat = async () => {
      if (!beating) return;
      try {
        await request("POST", leasePath, { item: id, renew: true });
        if (renewFailing) { renewFailing = false; print("The landing lease is renewed again."); }
      } catch (error) {
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
      if (beating) { const next = setTimeout(beat, LEASE_RENEW_MS); next.unref(); }
    };
    beating = true;
    const firstBeat = setTimeout(beat, LEASE_RENEW_MS);
    firstBeat.unref();
    await record("lease", Date.now() - t0);

    // Merge main into the workspace, no-ff, so the task carries main's
    // commits as a merge of their own; settle what the project's
    // regenerate command can settle, raise the merged route level where
    // both sides raised it and regenerate the fixtures — the workspace half
    // of a landing, shared with the Workflow executor (t280).
    const { head, mainHead, mergedIn } = await mergeMainAndRegenerate(io, { dir, id, name, regenerate, record, guard: guardLease, d0 });

    // Push, checks and submission run as this CLI's own commands in the
    // workspace, so their output is their own and a failure still ends the
    // landing here, with the lease released and the step recorded.
    const step = (kind, argv, cwd, data = {}) => { guardLease(); return landStep(io, record, kind, argv, cwd, data); };
    await pushRefreshing(io, { dir, id, itemPath }, () => step("push", ["push"], dir, { head }));
    print(`Pushed ${short(head)} to ${id}'s fork.`);
    await step("check", ["check"], dir);
    await step("submit", ["submit", "--summary", mergedIn ? `Merged with main at ${short(mainHead)}; the required checks pass.` : "The required checks pass."], dir);

    // The review: the server says whether the gate needs one and who reviews;
    // --no-review leaves the task submitted for the owner to settle by hand.
    t0 = Date.now();
    if (noReview) {
      print(`${id} is submitted and left for you to settle the review by hand (--no-review): atelier review ${id} --approve --as H/M --note "…", then atelier accept ${id} and atelier merge ${id} (main is already merged; run atelier land ${id} again if the head moves).`);
      await record("review", Date.now() - t0, { skipped: true });
      await release();
      return;
    } else {
      // A named reviewer is a review the owner asks for, so the server makes
      // the request even where the gate needs none, and refuses, with its
      // reason, where the gate cannot proceed at all.
      guardLease();
      const ask = await request("POST", `${itemPath}/review-request`, reviewer ? { reviewer, wanted: true } : {});
      if (!ask.needed && reviewer) throw new StepError(`the server made no review request for ${reviewer} (${ask.reason}); ${id} stays submitted`);
      if (!ask.needed) {
        print(`No review was requested: ${ask.reason}. The gate decides whether ${id} can be accepted.`);
        await record("review", Date.now() - t0, { verdict: "none-needed", reason: String(ask.reason ?? "").slice(0, 500) });
      } else {
        const head = ask.head, since = ask.at;
        print(`${ask.requested === false ? "A review request is already open" : "Review requested"}${ask.reviewer ? ` for ${ask.reviewer}` : ""}: ${ask.reason}. Waiting for the verdict…`);
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
          const dead = offers && slash > 0
            ? unoffered({ to: "home", agent: ask.reviewer.slice(0, slash), model: ask.reviewer.slice(slash + 1), by: "atelier/orchestrator", at: since, note: "", job: "review" }, Array.isArray(offers) ? offers : [])
            : null;
          let line;
          if (dead) {
            line = `The review request is not claimed yet, and ${dead}. It will not be claimed until a runner that offers ${ask.reviewer} for the review job asks the server for work. Review it by hand (atelier review ${id} --approve --as ${ask.reviewer} --note "…"), then atelier accept ${id} and atelier merge ${id}, or run atelier land ${id} again with --reviewer H/M to ask a model a live runner offers.`;
          } else try {
            const [items, queued] = await Promise.all([request("GET", `/projects/${encodeURIComponent(name)}/items`), request("GET", "/queue")]);
            const busy = (Array.isArray(items) ? items : []).filter((i) => i.runner && i.state === "claimed" && i.id !== id)
              .map((i) => `${i.runner} is busy with ${i.id} (${i.dispatch?.job ?? "build"}, ${i.owner}) since ${String(i.updatedAt).slice(0, 16).replace("T", " ")} UTC`);
            const ahead = (Array.isArray(queued) ? queued : []).filter((q) => !(q.project === name && q.item?.id === id) && (q.item?.dispatch?.at ?? "") < since)
              .map((q) => `${q.project}/${q.item.id} (${q.item.dispatch?.job ?? "build"})`);
            line = `The review request is not claimed yet. ${busy.length ? busy.join("; ") : "No runner is busy with a job of this project"}; ${ahead.length ? `${ahead.length} job${ahead.length === 1 ? "" : "s"} queued ahead of it: ${ahead.join(", ")}` : "nothing is queued ahead of it"}.`;
          } catch (error) { line = `The review request is not claimed yet (the queue could not be read: ${error.message}).`; }
          if (line !== busyLine) { busyLine = line; print(line); }
        };
        for (let waited = 0; ; waited += POLL_MS) {
          // The wait for a verdict is where a sleeping landing wakes: the
          // lease may have been lost whole beats ago, so each poll asks the
          // guard first and a verdict that arrived meanwhile is not taken.
          guardLease();
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
              throw new StepError(`${verdict.by}${verdict.tier ? " (tier review)" : ""} rejected ${id} at ${short(head)}: ${verdict.note || "(no note)"}. The task goes back to its holder with the findings; the merge of main stays in its workspace`);
            }
            print(`${verdict.by} approved ${id} at ${short(head)}${verdict.topTier ? ", as the gate review and the top tier's" : ""}.`);
            await record("review", Date.now() - t0, { verdict: "approve", reviewer: verdict.by, resolvedBy: verdict.by });
            break;
          }
          if (d.item.head !== head) throw new StepError(`${id}'s head moved to ${short(d.item.head)} while waiting for the review; start the landing again`);
          await explainWait(d);
          if (waited >= REVIEW_TIMEOUT_MS) {
            await record("review", Date.now() - t0, { verdict: "timeout", reviewer: ask.reviewer ?? undefined });
            throw new StepError(`no verdict${ask.reviewer ? ` from ${ask.reviewer}` : ""} within ${Math.round(REVIEW_TIMEOUT_MS / 60000)} minutes; the review request stays open and ${id} stays submitted. Review by hand (atelier review ${id} --approve --as ${ask.reviewer ?? "H/M"} --note "…"), then atelier accept ${id} and atelier merge ${id}, or run atelier land ${id} again to wait once more`);
          }
          await new Promise((ok) => setTimeout(ok, POLL_MS));
        }
      }
    }

    // Accept and merge, again as this CLI's own commands. merge runs in the
    // registered checkout's project, publishes the merge to the baseline and
    // records it on the ledger. The lease is asked for by hand first: these
    // are the steps that publish to main, and a landing that slept through
    // losing it stops here rather than merge beside the landing that holds
    // the lease now (t232).
    await renewBeforePublish();
    await step("accept", ["accept", id], p.path);
    const landed = await step("merged", ["merge", id], p.path, () => ({ mergeCommit: git(["rev-parse", `refs/heads/${p.branch}`], { cwd: p.path }) }));
    print(`${id} landed: ${landed.output.split("\n").filter(Boolean).at(-1) ?? "merged"}`);
  } catch (error) {
    await release();
    die(error.message);
  }
  await release();
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, onSignal);
  // When another landing took the lease over, release() has said where it
  // stands; claiming a release here would say what did not happen.
  if (takenOverBy === null) print(`The landing lease for ${name} is released; another task may land.`);
}

// ── the pieces both landings share (t280) ──────────────────────────────────

// A land.* step recorder: a ledger that cannot take the record warns and
// the landing goes on, for the record is not the step.
function landRecorder(io, itemPath) {
  return async (step, ms, data = {}) => {
    try { await io.request("POST", `${itemPath}/land`, { step, ms: Math.max(0, Math.round(ms)), ...data }); }
    catch (error) { io.print(`Warning: the landing's ${step} step could not be recorded: ${error.message}`); }
  };
}

// The workspace's write token, refreshed by re-claiming the task as the
// holder the server records (t275), whose name the claim must carry exactly:
// the server refreshes a claim only for `item.owner === actor`, and to any
// other name a claim is a takeover. The workspace's own atelier.actor must
// be that holder too, so a workspace left by an earlier holder is never
// given the current one's token; a task nobody holds is not claimed. The
// holder's runner rides along, as the server refuses a re-claim from any
// runner but the one holding the task. The new token replaces the old one
// in the workspace (the old one is revoked by the claim) and its expiry is
// recorded. Answers the new expiry.
async function refreshWorkspaceToken(io, { dir, id, itemPath }) {
  const recorded = io.git(["config", "--local", "atelier.actor"], { cwd: dir, allowFail: true }).stdout?.trim() || null;
  const { item } = await io.request("GET", itemPath);
  const holder = item?.owner ?? null;
  if (!holder || !recorded || !sameActor(holder, recorded)) {
    throw new StepError(`${id} is held by ${holder ?? "nobody"} and its workspace was claimed by ${recorded ?? "no recorded actor"}, so the landing cannot refresh the token for its holder`);
  }
  const r = await io.request("POST", `${itemPath}/claim`, {}, holder, item.runner ? { "x-atelier-runner": item.runner } : {});
  if (!r?.workspace?.token) throw new StepError(`the re-claim of ${id} as ${holder} returned no workspace token`);
  io.adoptWorkspaceToken(dir, r.workspace);
  return { holder, expiresAt: r.workspace.expiresAt ?? null };
}

// Before the landing takes the lease: a write token that has lapsed or
// lapses within TOKEN_WINDOW_MS is refreshed, and one that cannot be stops
// the landing here, with nothing changed. The expiry is recorded at each
// claim (recordTokenExpiry in cli/atelier.mjs); the server keeps none it
// could answer later, so a workspace claimed before that was recorded has
// an unknown expiry, which is refreshed once — the refresh records it, and
// later landings read it. An accepted task has nothing left to push.
async function ensureWorkspaceToken(io, { dir, id, itemPath, item }) {
  if (item?.state === "accepted") return;
  const recorded = io.git(["config", "--local", "atelier.write-token-expires-at"], { cwd: dir, allowFail: true }).stdout?.trim() || null;
  const at = recorded ? Date.parse(recorded) : NaN;
  if (Number.isFinite(at) && at - Date.now() > TOKEN_WINDOW_MS) return;
  io.print(Number.isFinite(at)
    ? `${id}'s workspace write token ${at <= Date.now() ? "expired" : "expires"} ${recorded.slice(0, 16).replace("T", " ")} UTC; refreshing it for its holder before the landing takes the lease…`
    : `${id}'s workspace records no write token expiry (it was claimed before expiries were recorded); refreshing the token for its holder before the landing takes the lease…`);
  let fresh;
  try { fresh = await refreshWorkspaceToken(io, { dir, id, itemPath }); }
  catch (error) { throw new StepError(`${id}'s workspace write token could not be refreshed, so the landing stops before taking the lease, with nothing changed: ${error.message}. Have its holder run atelier claim ${id} in the workspace, then run atelier land ${id} again`); }
  io.print(`Refreshed ${id}'s workspace write token for ${fresh.holder}${fresh.expiresAt ? `; it expires ${String(fresh.expiresAt).slice(0, 16).replace("T", " ")} UTC` : ""}.`);
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

// The regenerate command, run in the workspace the way a check runs it.
// Both the merge (to settle conflicts that lie only in generated files)
// and the regenerate step (to bring every generated file current with the
// merged tree) come through here.
function runRegenerateIn(dir, regenerate, io) {
  const r = spawnSync("/bin/sh", ["-c", regenerate], { cwd: dir, env: checkEnv(), timeout: CHECK_TIMEOUT_MS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = io.redact(`${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n[atelier] ${r.error.message}` : ""}`, io.secrets());
  if (output.trim()) process.stdout.write(output.slice(-4000) + "\n");
  return { ok: !r.error && r.status === 0, why: r.error ? r.error.message : `exit ${r.status}` };
}

// One step of a landing that runs a CLI command of its own (the push, or
// the merge below): the command's output is its own, its duration and what
// it settled are recorded, and a failure throws the StepError that ends
// the landing it belongs to.
async function landStep(io, record, kind, argv, cwd, data = {}) {
  const t = Date.now();
  const r = await (io.runCommand ?? runCommand)([process.execPath, io.atelier, ...argv, "--project", io.name], { cwd, env: io.env });
  if (!r.passed) {
    await record(kind, r.durationMs, { failed: true, reason: r.output.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 500) });
    throw new StepError(`atelier ${argv[0]} failed (exit ${r.status ?? "ended by a signal"}):\n${r.output.split("\n").filter(Boolean).slice(-12).join("\n")}`);
  }
  // A function names fields only the finished step knows, such as the
  // merge commit the checkout now holds.
  await record(kind, r.durationMs, typeof data === "function" ? data() : data);
  return r;
}

// The workspace half of a landing: merge main into the task's workspace
// (no-ff, so the task carries main's commits as a merge of their own),
// settle conflicts the project's regenerate command can settle, raise the
// merged route level where main and the task each raised it (t248),
// regenerate the fixtures and commit what changes. The CLI's own landing
// and the Workflow executor (below) run the same code, so a landing
// behaves the same whichever engine drives it. `guard` is the calling
// pipeline's lease guard, which throws once the lease is no longer this
// landing's; every failure throws a StepError carrying the failed
// step's data. Answers the head the workspace reached, main's head and
// whether main was merged at all.
async function mergeMainAndRegenerate(io, { dir, id, name, regenerate, record, guard, d0 }) {
  const { request, git, print } = io;
  guard();
  const t0 = Date.now();
  const base = await request("POST", `/projects/${encodeURIComponent(name)}/items/${encodeURIComponent(id)}/base-token`, { scope: "read" });
  git(["fetch", "--quiet", base.remote, base.defaultBranch], { cwd: dir, token: base.token });
  const mainHead = git(["rev-parse", "FETCH_HEAD"], { cwd: dir });
  let fromMain = [], mergedIn = false, settled = null, settledConflicts = [], routeLevel = null;
  if (git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], { cwd: dir, allowFail: true }).status === 0) {
    print(`main at ${short(mainHead)} is already merged into ${id}'s workspace.`);
  } else {
    const forkPoint = git(["merge-base", "HEAD", "FETCH_HEAD"], { cwd: dir });
    fromMain = git(["rev-list", "--max-count=200", `${forkPoint}..FETCH_HEAD`], { cwd: dir }).split("\n").filter(Boolean);
    const r = git(["merge", "--no-ff", "--no-edit", "-m", `Merge main into ${id}\n\nAtelier land: main at ${mainHead}`, "FETCH_HEAD"], { cwd: dir, allowFail: true });
    if (r.status !== 0) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: dir, raw: true }).split("\0").filter(Boolean);
      // A conflict that lies only in files the regenerate command rewrites
      // is not the owner's to settle by hand: whichever side such a file
      // took, the command writes it again from the merged code, so either
      // side is a place to start. Each conflicted file is taken from ours
      // (theirs where the task deleted the file), the command runs, and
      // when it rewrote every conflicted file, what it wrote is committed
      // as the resolution; what it changed elsewhere waits for the
      // regenerate step below, which runs it once more. A file the command
      // left exactly as the side taken is not one it rewrites, so the
      // landing stops as it always did: the workspace was clean before the
      // merge began, so a hard reset returns it to where the merge started
      // and the merge made again leaves the conflicts in it for the owner.
      let reason = null;
      if (conflicts.length && regenerate) {
        print(`The merge stops on conflicts in ${conflicts.join(", ")}; taking either side and regenerating with \`${regenerate}\`…`);
        const shaOf = (file) => (existsSync(join(dir, file)) ? git(["hash-object", "--", file], { cwd: dir }) : "gone");
        const taken = new Map();
        let either = true, regen = null, unwritten = null;
        for (const file of conflicts) {
          if (git(["checkout", "--ours", "--", file], { cwd: dir, allowFail: true }).status !== 0
            && git(["checkout", "--theirs", "--", file], { cwd: dir, allowFail: true }).status !== 0) { either = false; break; }
          taken.set(file, shaOf(file));
        }
        if (either) {
          regen = runRegenerateIn(dir, regenerate, io);
          unwritten = regen.ok ? conflicts.filter((file) => shaOf(file) === taken.get(file)) : null;
        }
        if (regen?.ok && !unwritten.length) {
          git(["add", "-A", "--", ...conflicts], { cwd: dir });
          git(["commit", "--quiet", "--no-edit"], { cwd: dir });
          settled = "atelier land, taking either side and regenerating";
          settledConflicts = conflicts;
          print(`The conflicts were all in files \`${regenerate}\` rewrites; took either side and let the command write them again.`);
        } else {
          reason = !either ? "a conflicted file had neither side to take"
            : !regen.ok ? `the regenerate command \`${regenerate}\` failed (${regen.why})`
              : `the regenerate command left ${unwritten.join(", ")} as either side had it`;
          const back = git(["reset", "--hard", "HEAD"], { cwd: dir, allowFail: true });
          if (back.status !== 0) print(`Warning: the workspace could not be reset after the regeneration did not settle the conflicts (${(back.stderr || back.stdout || "").trim()}); resolve what is there by hand`);
          else git(["merge", "--no-ff", "--no-edit", "-m", `Merge main into ${id}\n\nAtelier land: main at ${mainHead}`, "FETCH_HEAD"], { cwd: dir, allowFail: true });
        }
      }
      if (!settled) {
        const data = { fromMain, ...(conflicts.length ? { conflicts, resolvedBy: "the project owner, by hand", ...(reason ? { reason } : {}) } : {}) };
        await record("merge", Date.now() - t0, { failed: true, ...data });
        // The conflicts can go back to the task's builder instead of the
        // owner's session (t243): a merge-main dispatch makes a runner
        // merge main here again — the workspace's reset clears the merge
        // this landing left — and brief the builder to resolve it, where a
        // plain rework dispatch would reset the workspace to a head that
        // cannot reach main. The holder is named, for a task that has one.
        const holder = typeof d0?.item?.owner === "string" && d0.item.owner.includes("/") ? d0.item.owner : null;
        throw new StepError(conflicts.length
          ? `the merge of main at ${short(mainHead)} into ${id}'s workspace stops on conflicts in:\n${conflicts.join("\n")}\n${reason ? `Taking either side and regenerating did not settle them: ${reason}. ` : ""}The merge is left in the workspace for you to resolve: cd ${JSON.stringify(dir)}, fix the files, git add, git commit. Then run atelier land ${id} again. Or send them back to the task's builder${holder ? `, ${holder},` : ""} to resolve in this workspace: atelier dispatch ${id} --job merge-main${holder ? ` --agent ${holder.split("/")[0]} --model ${holder.split("/")[1]}` : ""}; its runner merges main at ${short(mainHead)} into the workspace again and leaves the conflicts for the builder to resolve and commit, and then atelier land ${id} again.`
          : `the merge of main at ${short(mainHead)} into ${id}'s workspace failed:\n${(r.stderr || r.stdout).trim()}\nNothing was merged; git left the workspace as it was.`, data);
      }
    }
    mergedIn = true;
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
  const levelAt = (rev) => {
    const shown = git(["show", `${rev}:src/route-level.ts`], { cwd: dir, allowFail: true });
    const found = /export const ROUTE_LEVEL = (\d+);/.exec(shown.stdout ?? "");
    return found ? Number(found[1]) : null;
  };
  const holdsMain = (rev) => git(["merge-base", "--is-ancestor", mainHead, rev], { cwd: dir, allowFail: true }).status === 0;
  const line = git(["rev-list", "--first-parent", "--max-count=200", "HEAD"], { cwd: dir }).split("\n").map((sha) => sha.trim()).filter(Boolean);
  let stepped = 0;
  while (stepped < line.length && holdsMain(line[stepped])) stepped++;
  const taskHead = stepped > 0 && stepped < line.length ? line[stepped] : null;
  const based = taskHead ? git(["merge-base", taskHead, mainHead], { cwd: dir, allowFail: true }) : null;
  const forkPoint = based && based.status === 0 ? String(based.stdout ?? "").trim() : null;
  if (taskHead && forkPoint && forkPoint !== mainHead) {
    const baseLevel = levelAt(forkPoint), taskLevel = levelAt(taskHead), mainLevel = levelAt(mainHead), mergedLevel = levelAt("HEAD");
    if (baseLevel !== null && taskLevel > baseLevel && mainLevel > baseLevel && mergedLevel !== null) {
      const rightLevel = mainLevel + (taskLevel - baseLevel);
      if (mergedLevel < rightLevel) {
        const levelFile = join(dir, "src", "route-level.ts");
        writeFileSync(levelFile, readFileSync(levelFile, "utf8").replace(/export const ROUTE_LEVEL = \d+;/, `export const ROUTE_LEVEL = ${rightLevel};`));
        git(["add", "--", "src/route-level.ts"], { cwd: dir });
        git(["commit", "--quiet", "-m", `Raise the route level after merging main into ${id}\n\nAtelier land: main and ${id} each raised it from ${baseLevel}, so the merged level is ${rightLevel}`], { cwd: dir });
        routeLevel = { base: baseLevel, main: mainLevel, task: taskLevel, was: mergedLevel, set: rightLevel };
        print(`main and ${id} each raised the route level from ${baseLevel} (main to ${mainLevel}, ${id} to ${taskLevel}), and the merge left it at ${mergedLevel}: the merged CLI calls both sides' routes, so the level is raised to ${rightLevel}. Deploy the server from a checkout at route level ${rightLevel} or newer (npm run deploy, which records the commit it deploys) before the next landing or runner.`);
      }
    }
  }
  await record("merge", Date.now() - t0, { fromMain, ...(routeLevel ? { routeLevel } : {}), ...(settled ? { conflicts: settledConflicts, resolvedBy: settled } : {}), ...(mergedIn ? {} : { skipped: true }) });

  // The project's fixtures, regenerated now that both lines sit in one
  // tree, so the checks below see fixtures current with them. The command
  // runs in the workspace as a check runs, and what it changes is
  // committed before the push. Where the merge above already ran it to
  // settle conflicts, running it again changes nothing: what it wrote is
  // committed, and only anything else it changes is committed here.
  if (regenerate) {
    guard();
    const start = Date.now();
    print(`Regenerating with \`${regenerate}\`…`);
    const r = runRegenerateIn(dir, regenerate, io);
    if (!r.ok) {
      await record("regenerate", Date.now() - start, { command: regenerate, failed: true });
      throw new StepError(`the fixture regeneration command \`${regenerate}\` failed (${r.why}); the merge is left in the workspace. Fix the command (the project's policy declares it: atelier init --regenerate), then run atelier land ${id} again`);
    }
    let changed = false;
    if (git(["status", "--porcelain"], { cwd: dir })) {
      git(["add", "-A"], { cwd: dir });
      git(["commit", "--quiet", "-m", `Regenerate after merging main into ${id}`], { cwd: dir });
      changed = true;
      print("Committed what the regeneration changed.");
    }
    await record("regenerate", Date.now() - start, { command: regenerate, changed });
  }
  return { head: git(["rev-parse", "HEAD"], { cwd: dir }), mainHead, mergedIn };
}

// ── the landing as a Cloudflare Workflow (t280) ────────────────────────────

// `atelier land ID --workflow` lands the task through a Cloudflare Workflow
// (src/landing-workflow.ts), which runs the server's half of the pipeline as
// durable steps with retries: the landing lease, the required checks (in
// the checks mode `container`) or the reading of their observed results
// (in the mode `local`, the default), the submission, the review wait, the
// acceptance and the watch for the merge. This command starts the instance, or attaches to
// the task's live one, and is both its progress view and its executor for
// the steps that need Git with a working tree: it polls the stage the
// Workflow writes to the Ledger, says each new stage once, and
//   - at `workspace` (the Workflow holds the lease and waits for this
//     machine) merges main into the workspace, regenerates and pushes — the
//     same code as the plain landing — and in the local checks mode runs
//     the required checks in a clean clone (`atelier check`, as the plain
//     landing does), renewing the lease meanwhile, and reports the pushed
//     head, or the conflicts it stopped on, as a
//     `workspace` event naming the round;
//   - at `conflict` (a pause from an earlier run, whose conflicts the owner
//     has since resolved and committed: the preflight refuses a workspace
//     with a merge in progress or uncommitted changes) sends `resume`;
//   - at `merge` (the Workflow accepted) runs `atelier merge` in the
//     registered checkout, waiting while another landing holds the lease.
// It ends when the instance completes or fails. Closing the laptop stops
// only this view: the Workflow keeps its place, and the same command run
// again attaches and goes on from the stage it reached.
const LIVE = ["queued", "running", "waiting", "waitingForPause", "paused"];

async function runLandWorkflow(io, { d0, itemPath, dir, regenerate }) {
  const { args, name, id, p, request, git, die, print } = io;
  const reviewer = args.reviewer, noReview = args["no-review"] === true;
  const askedChecks = args.checks ?? "local";
  const wfPath = `${itemPath}/landing-workflow`;
  const leasePath = `/projects/${encodeURIComponent(name)}/landing-lease`;
  const record = landRecorder(io, itemPath);
  const sleep = () => new Promise((ok) => setTimeout(ok, POLL_MS));
  const send = (type, payload) => request("POST", wfPath, { event: { type, payload } });

  // Start, or attach to the task's live instance. An accepted task has
  // nothing left but its merge: it is landed through a live instance at
  // its merge stage, and otherwise merged by hand, as the plain landing says.
  let current = null;
  try { current = await request("GET", wfPath); } catch (error) { die(error.message); }
  const live = !!current?.instance && LIVE.includes(current.status?.status);
  if (d0.item.state === "accepted" && !live) die(`${id} is accepted at ${short(d0.item.acceptedHead)}; merge it with: atelier merge ${id}.`);
  let started;
  try { started = await request("POST", wfPath, { checks: askedChecks, ...(reviewer ? { reviewer } : {}), ...(noReview ? { noReview: true } : {}) }); }
  catch (error) { die(error.message); }
  // The mode is the instance's, as the server recorded it: a live instance
  // keeps the mode it was started with, and a server older than the modes
  // records none and runs the checks in the container.
  const checksMode = started.checks === "local" ? "local" : "container";
  if (!started.checks && askedChecks === "local") print("Warning: the server recorded no checks mode for this landing, so it predates them and runs the required checks in a Cloudflare container; deploy the server for --checks local.");
  else if (!started.created && args.checks !== undefined && args.checks !== checksMode) print(`The live instance keeps the checks mode it was started with (${checksMode}); --checks applies to a new landing.`);
  print(started.created
    ? (checksMode === "local"
      ? `Landing ${id} as a Cloudflare Workflow (instance ${started.instance}). The Workflow takes ${name}'s landing lease and runs the submission, the review and the acceptance on Cloudflare as durable steps; this machine merges main, pushes, runs the required checks in a clean clone (checks mode local) and merges when the Workflow asks, and the Workflow goes on only once the server has recorded every check passing at the pushed head. If this command stops, run atelier land ${id} --workflow again to attach.`
      : `Landing ${id} as a Cloudflare Workflow (instance ${started.instance}). The Workflow takes ${name}'s landing lease and runs the checks (in a Cloudflare container), the submission, the review and the acceptance on Cloudflare as durable steps; this machine merges main, pushes and merges when the Workflow asks. If this command stops, run atelier land ${id} --workflow again to attach.`)
    : `Attached to ${id}'s landing Workflow (instance ${started.instance}, at ${started.stage ?? "its start"}).`);
  if (!started.created && (reviewer || noReview)) print("The live instance keeps the review options it was started with; --reviewer and --no-review apply to a new landing.");

  // The pause on a conflict, ended: the owner resolved and committed the
  // conflicts (the preflight saw the workspace clean), so the Workflow is
  // told to queue for the lease and ask for the workspace steps again.
  if (!started.created && started.stage === "conflict") {
    await send("resume", { round: started.round });
    print(`Resumed the landing after the conflicts of round ${started.round + 1}; the Workflow queues for the lease and asks for the merge of main again.`);
  }

  // The executor's renewal of the lease while it does the workspace steps,
  // so a live machine keeps it however long they take, and a machine that
  // goes away lets it lapse. A renewal the server refuses says another
  // landing holds the project now; the workspace steps stop at their next
  // guard rather than push beside it.
  let lost = null;
  const guard = () => { if (lost) throw new StepError(`the landing lease of ${name} is no longer ${id}'s (${lost}); the landing Workflow stops at its next step. Run atelier land ${id} --workflow again once the other landing ends`); };
  const heartbeat = () => {
    const timer = setInterval(async () => {
      try { await request("POST", leasePath, { item: id, renew: true }); }
      catch (error) { if (/no_lease|landing_lease|held for|no landing lease/.test(error.message)) lost = error.message; }
    }, LEASE_RENEW_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  let said = null, workedRound = null, mergedHere = false, saidWait = false;
  for (;;) {
    let read;
    try { read = await request("GET", wfPath); }
    catch (error) { print(`Warning: the landing Workflow could not be read (${error.message}); trying again.`); await sleep(); continue; }
    const { instance, status, stage, round = 0, detail, files } = read ?? {};
    // A merged task reports no landing instance any more; when this CLI did
    // the merge itself, the landing is over, not lost (t308): say so and free
    // the lease now rather than leaving it to lapse.
    if ((!instance || !status) && mergedHere) {
      try { await request("POST", leasePath, { cancel: true, item: id }); } catch { /* a merged task's lease is already free on the server */ }
      print(`${id} landed through the landing Workflow; the lease is released.`);
      return;
    }
    if (!instance || !status) die(`the landing Workflow of ${id} can no longer be read (instance ${instance ?? "none"}); its lease lapses on its own. Run atelier land ${id} --workflow again to start or attach the landing`);
    if (status.status === "complete") {
      if (noReview || status.output?.review === "skipped") print(`${id} is submitted and left for you to settle the review by hand (--no-review): atelier review ${id} --approve --as H/M --note "…", then atelier accept ${id} and atelier merge ${id}.`);
      else print(`${id} landed through the landing Workflow (instance ${instance}); the lease is released.`);
      return;
    }
    if (status.status === "errored" || status.status === "terminated") {
      die(`the landing Workflow ${instance} ${status.status === "terminated" ? "was terminated" : "failed"}: ${status.error?.message ?? detail ?? "no reason given"}`);
    }
    const key = `${stage}:${round}`;
    if (key !== said) {
      said = key;
      const what = {
        lease: "queues for the landing lease",
        workspace: "holds the lease and waits for this machine to merge main and push",
        conflict: `is paused on conflicts in ${(files ?? []).join(", ") || "the merge of main"}`,
        checks: checksMode === "local" ? "reads the observed results of the checks this machine ran" : "runs the required checks in a Cloudflare container",
        review: "waits for the review verdict",
        merge: "has accepted the reviewed head and waits for the merge",
        done: "is done",
        failed: `failed: ${detail ?? ""}`,
      }[stage] ?? `is at ${stage}`;
      print(`The landing Workflow ${what}${round ? ` (round ${round + 1})` : ""}.`);
    }

    if (stage === "workspace" && workedRound !== round) {
      workedRound = round;
      const stop = heartbeat();
      try {
        const merged = await mergeMainAndRegenerate(io, { dir, id, name, regenerate, record, guard, d0 });
        guard();
        await pushRefreshing(io, { dir, id, itemPath }, () => { guard(); return landStep(io, record, "push", ["push"], dir, () => ({ head: merged.head })); });
        // The local checks mode: the required checks run here, in a clean
        // clone of the pushed head, through the same `atelier check` step as
        // the plain landing, before the head is reported, so the server has
        // recorded their observed results when the Workflow reads them. A
        // failure ends the landing below, reported as a failed workspace.
        if (checksMode === "local") {
          print(`Pushed ${short(merged.head)} to ${id}'s fork; running the required checks in a clean clone.`);
          guard();
          await landStep(io, record, "check", ["check"], dir);
          guard();
          print(`The required checks pass at ${short(merged.head)}; reporting the head to the landing Workflow.`);
        } else print(`Pushed ${short(merged.head)} to ${id}'s fork; reporting it to the landing Workflow.`);
        await send("workspace", { round, head: merged.head, mainHead: merged.mainHead, mergedIn: merged.mergedIn });
      } catch (error) {
        const conflicts = Array.isArray(error.data?.conflicts) && error.data.conflicts.length ? error.data.conflicts : null;
        // A conflict pauses the Workflow (it releases the lease and waits
        // for the owner); any other failure ends it with this message.
        try { await send("workspace", conflicts ? { round, conflict: true, files: conflicts, reason: error.message.slice(0, 2000) } : { round, failed: true, reason: String(error.message).slice(0, 2000) }); }
        catch { /* the Workflow times out on its own and releases the lease */ }
        die(conflicts
          ? `${error.message}\nThe landing Workflow is paused at its conflict stage and has released the lease. Once the conflicts are resolved and committed, run atelier land ${id} --workflow again: it resumes this landing.`
          : error.message);
      } finally { stop(); }
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
        // The Workflow leaves the lease unrenewed while it waits for the
        // merge, so a landing that took it meanwhile finishes first and the
        // merge goes on after it.
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
