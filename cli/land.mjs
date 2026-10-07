import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { checkEnv } from "./check-env.mjs";
import { runCommand } from "./ship.mjs";
import { ROUTE_LEVEL } from "../src/route-level.ts";
import { LANDING_LEASE_EXPIRY_MS, landingLeaseLapsed } from "../src/landing-lease.ts";

// atelier land (t187): the project owner lands one task whole, taking the
// project's landing lease on the server so two sessions never race main.
// In the task's workspace it merges main (stopping on conflicts, which it
// leaves for the owner to resolve, naming the files, unless every conflicted
// file is one the project's regenerate command rewrites, when it takes
// either side, regenerates and goes on), regenerates the project's fixtures
// when its policy declares how, then pushes and runs the
// required checks through the CLI's own commands, each as a child process so
// a failure can still release the lease and record the step. It asks the
// server for the independent review the gate needs, or the one the owner names
// with --reviewer whether or not the gate needs it, and waits for the verdict,
// then accepts and merges. Every step, its duration and the commits that came
// from main are recorded on the ledger as land.* events (t186 reads them for
// the integration cost), and the server must be at this CLI's route level or
// newer, or the landing refuses before it starts, saying to deploy.
//
// The lease never strands the project (t214): a landing renews it every
// LEASE_RENEW_MS while it runs, the server treats a lease not renewed for
// LANDING_LEASE_EXPIRY_MS (src/landing-lease.ts) as free, SIGINT and SIGTERM
// release it before the command ends, and `atelier land ID --release-lease`
// frees it by hand, saying which task held it since when.

const POLL_MS = Number(process.env.ATELIER_LAND_POLL_MS ?? 5000);
// The review wait outlasts a build on the runner (its task timeout is 45
// minutes), since a review queues behind every older build.
const REVIEW_TIMEOUT_MS = Number(process.env.ATELIER_LAND_REVIEW_TIMEOUT ?? 60 * 60_000);
const CHECK_TIMEOUT_MS = Number(process.env.ATELIER_CHECK_TIMEOUT ?? 20 * 60_000);
const LEASE_RENEW_MS = Number(process.env.ATELIER_LAND_RENEW_MS ?? 60_000);

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
  const releaseLease = args["release-lease"] === true;
  const reviewer = args.reviewer;
  if (releaseLease && (dryRun || noReview || reviewer !== undefined)) die("--release-lease frees the project's landing lease and does nothing else; give it alone");
  if (reviewer !== undefined && (typeof reviewer !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(reviewer))) {
    die(`--reviewer needs harness/model, such as codex/gpt-6-astra: atelier land ${id} --reviewer H/M`);
  }
  if (noReview && reviewer !== undefined) die("--reviewer and --no-review together say two things; name the reviewer, or give --no-review to leave the task submitted");

  const itemPath = `/projects/${encodeURIComponent(name)}/items/${encodeURIComponent(id)}`;
  const leasePath = `/projects/${encodeURIComponent(name)}/landing-lease`;
  const dir = io.workspacePath(name, id);
  const since = (lease) => `${String(lease.at).slice(0, 16).replace("T", " ")} UTC`;

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
  // landing with who holds it and since when.
  const { lease } = await request("GET", leasePath);
  if (lease && lease.item !== id && dryRun) {
    // The server decides whether a lease held for another task still
    // guards the project, when the landing asks for it below; a dry run
    // never asks, so it judges by this machine's clock, for the message only.
    if (!landingLeaseLapsed(lease, Date.now())) die(`a landing is already in progress: ${lease.holder} has been landing ${lease.item} since ${since(lease)}. One landing runs at a time in ${name}; wait for it, run atelier land ${lease.item} again to finish or release that landing, or free the lease with atelier land ${lease.item} --release-lease`);
  }

  // The refusals that stop a landing before it takes the lease, each
  // offering the next step. When this task's own lease is still held, from
  // a landing that was killed, each refusal also says how to free it, so no
  // state of the task leaves the lease out of reach (t214).
  const heldNote = lease && lease.item === id ? ` The landing lease of ${name} is still held for ${id} since ${since(lease)}, from an earlier landing; atelier land ${id} --release-lease frees it.` : "";
  const refuse = (message) => die(message + heldNote);
  const d0 = await request("GET", itemPath);
  if (["merged", "abandoned"].includes(d0.item.state)) refuse(`${id} is ${d0.item.state}; there is nothing to land.`);
  if (d0.item.state === "accepted") refuse(`${id} is accepted at ${short(d0.item.acceptedHead)}; merge it with: atelier merge ${id}.`);
  if (!existsSync(join(dir, ".git"))) refuse(`${id} has no workspace on this Mac (${dir}); it has nothing to land. Run atelier claim ${id} --as H/M first, or land a task that has one.`);
  const held = { project: git(["config", "--local", "atelier.project"], { cwd: dir, allowFail: true }).stdout?.trim(), item: git(["config", "--local", "atelier.item"], { cwd: dir, allowFail: true }).stdout?.trim() };
  if (held.project !== name || held.item !== id) refuse(`${dir} is not ${id}'s workspace (its Git config names ${held.project ?? "no project"}/${held.item ?? "no item"}); land ${id} from the machine holding its workspace.`);
  if (existsSync(join(dir, ".git", "MERGE_HEAD"))) refuse(`a Git merge is already in progress in ${id}'s workspace; resolve and commit it (or git merge --abort), then run atelier land ${id} again.`);
  if (git(["status", "--porcelain"], { cwd: dir })) refuse(`${id}'s workspace has uncommitted changes; commit or set them aside before landing.`);
  const regenerate = typeof d0.policy?.regenerate === "string" ? d0.policy.regenerate : null;

  if (dryRun) {
    print(`Dry run: atelier land ${id} in ${name} would:`);
    print(`  1. take the project's landing lease for ${id} (one landing at a time in ${name})`);
    print(`  2. merge main into ${id}'s workspace (${dir}); on conflicts, stop and leave them for you to resolve, naming the files`);
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

  // From here every failure throws rather than dying, so the lease is
  // released and the step recorded before the command ends.
  const record = async (step, ms, data = {}) => {
    try { await request("POST", `${itemPath}/land`, { step, ms: Math.max(0, Math.round(ms)), ...data }); }
    catch (error) { print(`Warning: the landing's ${step} step could not be recorded: ${error.message}`); }
  };
  // The regenerate command, run in the workspace the way a check runs it.
  // Both the merge (to settle conflicts that lie only in generated files)
  // and the regenerate step below (to bring every generated file current
  // with the merged tree) come through here.
  const runRegenerate = () => {
    const r = spawnSync("/bin/sh", ["-c", regenerate], { cwd: dir, env: checkEnv(), timeout: CHECK_TIMEOUT_MS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const output = io.redact(`${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n[atelier] ${r.error.message}` : ""}`, io.secrets());
    if (output.trim()) process.stdout.write(output.slice(-4000) + "\n");
    return { ok: !r.error && r.status === 0, why: r.error ? r.error.message : `exit ${r.status}` };
  };
  // The heartbeat renews the lease while the landing runs; the timer never
  // keeps the process alive on its own (unref), and a renewal the server
  // refuses says the lease is no longer this landing's, which is reported
  // once rather than retried.
  let leased = false, heartbeat = null;
  const release = async () => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (!leased) return;
    leased = false;
    // The cancel names this task: a lease that lapsed and was taken over by
    // another landing is that landing's now, and the server leaves it.
    try { await request("POST", leasePath, { cancel: true, item: id }); }
    catch (error) { print(`Warning: the landing lease could not be released; a later landing of ${id} takes it over, and it lapses on its own after ${Math.round(LANDING_LEASE_EXPIRY_MS / 60000)} minutes: ${error.message}`); }
  };
  // A signal releases the lease, then ends the command with the signal's
  // conventional status, so a landing stopped by Ctrl-C or kill leaves no
  // lease behind. A Ctrl-C reaches the step's child process through the
  // process group as well.
  const onSignal = (signal) => {
    print(`${signal} received; releasing the landing lease of ${name}…`);
    release().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, onSignal);
  try {
    let t0 = Date.now();
    try {
      const { item, expired } = await request("POST", leasePath, { item: id });
      leased = true;
      if (expired) print(`Took over the landing lease of ${name} from ${expired.holder}, which had been landing ${expired.item} since ${since(expired)} and stopped renewing it ${Math.round((Date.now() - Date.parse(expired.renewedAt ?? expired.at)) / 60000)} minutes ago; that landing is treated as ended.`);
      print(`Landing lease taken for ${id} (${item.state}); one landing at a time in ${name}.`);
    } catch (error) {
      throw new StepError(error.message.replace(/^landing_lease: /, "") || `the landing lease could not be taken: ${error.message}`);
    }
    // A renewal the server refuses (a 4xx, such as no_lease) says the lease
    // is no longer this landing's: the heartbeat stops, the loss is said
    // once, and the release at the end leaves the lease alone, since it is
    // another landing's now. A renewal that fails to reach the server, or
    // that the server fails (a 5xx), is retried on the next beat and warned
    // of once, until a renewal succeeds again.
    let renewFailing = false;
    heartbeat = setInterval(async () => {
      try {
        await request("POST", leasePath, { item: id, renew: true });
        if (renewFailing) { renewFailing = false; print("The landing lease is renewed again."); }
      } catch (error) {
        if (error.status >= 400 && error.status < 500) {
          clearInterval(heartbeat); heartbeat = null; leased = false;
          print(`Warning: the landing lease is no longer ${id}'s (${error.message}); the landing stops renewing it. Stop this landing, or run atelier land ${id} again once the other landing ends.`);
        } else if (!renewFailing) {
          renewFailing = true;
          print(`Warning: the landing lease could not be renewed (${error.message}); trying again every ${Math.round(LEASE_RENEW_MS / 1000)}s. It lapses after ${Math.round(LANDING_LEASE_EXPIRY_MS / 60000)} minutes without a renewal.`);
        }
      }
    }, LEASE_RENEW_MS);
    heartbeat.unref();
    await record("lease", Date.now() - t0);

    // Merge main into the workspace, no-ff, so the task carries main's
    // commits as a merge of their own.
    t0 = Date.now();
    const base = await request("POST", `${itemPath}/base-token`, { scope: "read" });
    git(["fetch", "--quiet", base.remote, base.defaultBranch], { cwd: dir, token: base.token });
    const mainHead = git(["rev-parse", "FETCH_HEAD"], { cwd: dir });
    let fromMain = [], mergedIn = false, settled = null, settledConflicts = [];
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
            regen = runRegenerate();
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
          throw new StepError(conflicts.length
            ? `the merge of main at ${short(mainHead)} into ${id}'s workspace stops on conflicts in:\n${conflicts.join("\n")}\n${reason ? `Taking either side and regenerating did not settle them: ${reason}. ` : ""}The merge is left in the workspace for you to resolve: cd ${JSON.stringify(dir)}, fix the files, git add, git commit. Then run atelier land ${id} again.`
            : `the merge of main at ${short(mainHead)} into ${id}'s workspace failed:\n${(r.stderr || r.stdout).trim()}\nNothing was merged; git left the workspace as it was.`, data);
        }
      }
      mergedIn = true;
      print(`Merged main at ${short(mainHead)} into ${id}'s workspace (${fromMain.length} commit${fromMain.length === 1 ? "" : "s"} from main).`);
    }
    await record("merge", Date.now() - t0, { fromMain, ...(settled ? { conflicts: settledConflicts, resolvedBy: settled } : {}), ...(mergedIn ? {} : { skipped: true }) });

    // The project's fixtures, regenerated now that both lines sit in one
    // tree, so the checks below see fixtures current with them. The command
    // runs in the workspace as a check runs, and what it changes is
    // committed before the push. Where the merge above already ran it to
    // settle conflicts, running it again changes nothing: what it wrote is
    // committed, and only anything else it changes is committed here.
    if (regenerate) {
      t0 = Date.now();
      print(`Regenerating with \`${regenerate}\`…`);
      const r = runRegenerate();
      if (!r.ok) {
        await record("regenerate", Date.now() - t0, { command: regenerate, failed: true });
        throw new StepError(`the fixture regeneration command \`${regenerate}\` failed (${r.why}); the merge is left in the workspace. Fix the command (the project's policy declares it: atelier init --regenerate), then run atelier land ${id} again`);
      }
      let changed = false;
      if (git(["status", "--porcelain"], { cwd: dir })) {
        git(["add", "-A"], { cwd: dir });
        git(["commit", "--quiet", "-m", `Regenerate after merging main into ${id}`], { cwd: dir });
        changed = true;
        print("Committed what the regeneration changed.");
      }
      await record("regenerate", Date.now() - t0, { command: regenerate, changed });
    }

    // Push, checks and submission run as this CLI's own commands in the
    // workspace, so their output is their own and a failure still ends the
    // landing here, with the lease released and the step recorded.
    const step = async (kind, argv, cwd, data = {}) => {
      const t = Date.now();
      const r = await runCommand([process.execPath, io.atelier, ...argv, "--project", name], { cwd, env: io.env });
      if (!r.passed) {
        await record(kind, r.durationMs, { failed: true, reason: r.output.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 500) });
        throw new StepError(`atelier ${argv[0]} failed (exit ${r.status ?? "ended by a signal"}):\n${r.output.split("\n").filter(Boolean).slice(-12).join("\n")}`);
      }
      // A function names fields only the finished step knows, such as the
      // merge commit the checkout now holds.
      await record(kind, r.durationMs, typeof data === "function" ? data() : data);
      return r;
    };
    const head = git(["rev-parse", "HEAD"], { cwd: dir });
    await step("push", ["push"], dir, { head });
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
        // silent (a review queues behind every older build on a runner).
        let busyLine = null;
        const explainWait = async (d) => {
          const claimed = (d.events ?? []).some((e) => e.kind === "review.claimed" && e.data?.head === head && Date.parse(e.at) >= Date.parse(since));
          if (claimed) return;
          let line;
          try {
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
          const d = await request("GET", itemPath);
          const verdict = (d.reviews ?? []).filter((v) => v.head === head && Date.parse(v.at) >= Date.parse(since)).at(-1);
          if (verdict) {
            if (!verdict.approve) {
              await record("review", Date.now() - t0, { verdict: "reject", reviewer: verdict.by, resolvedBy: verdict.by });
              throw new StepError(`${verdict.by} rejected ${id} at ${short(head)}: ${verdict.note || "(no note)"}. The task goes back to its holder with the findings; the merge of main stays in its workspace`);
            }
            print(`${verdict.by} approved ${id} at ${short(head)}.`);
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
    // records it on the ledger.
    await step("accept", ["accept", id], p.path);
    const landed = await step("merged", ["merge", id], p.path, () => ({ mergeCommit: git(["rev-parse", `refs/heads/${p.branch}`], { cwd: p.path }) }));
    print(`${id} landed: ${landed.output.split("\n").filter(Boolean).at(-1) ?? "merged"}`);
  } catch (error) {
    await release();
    die(error.message);
  }
  await release();
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, onSignal);
  print(`The landing lease for ${name} is released; another task may land.`);
}
