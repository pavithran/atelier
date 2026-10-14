// The task refresh's jobs (t462, src/refresh/): keeping a task that has left
// its builder — submitted, accepted, or released with commits — merged with
// main as main moves, so its landing meets no conflict main made while it
// waited.
//
// task-refresh, the integrator's (atelier runner --integrate): takes the
// lease, then works in a workspace of its own, never the builder's: a fresh
// repository that fetches the task's head the lease found and main's head,
// and merges main with git's diff3 conflict style.
//   - The head already holds main: reported refreshed with no head.
//   - The merge is clean: committed with the integrator's Agent line.
//   - It conflicts, every hunk within the documented transformations
//     (src/refresh/mechanical.ts): reported mechanical, and the server picks
//     a resolver, or the refresh waits for one and says why.
//   - It conflicts otherwise (behavioural, or uncertain): returned to the
//     builder with the merge base, both heads, the paths and the hunks.
//   - Before either job merges, the task's edits are compared with code
//     main moved to another file (src/moved-code.ts, t471); a finding is
//     returned to the builder the same way, and nothing is merged or pushed.
// task-resolve, a resolver's (a home runner offering the job): takes the
// lease the server routed to it, merges again the same way, runs its
// harness on the conflicts with a brief naming the transformations, and
// verifies every file it wrote against them (verifyResolution) before
// anything is committed; anything outside them goes back to the builder.
// The merge commit ends with the resolver's Agent line, which the server
// reads and records among the task's contributors.
//
// Either job pushes the same way: it says so first (refresh-pushing, which
// the server refuses when the task moved or is busy or landing, and which
// holds a landing off until the push is recorded), then pushes with no
// force, so a builder's push in between makes it fail rather than be
// overwritten, and reports the merge (refreshed --head), which the server
// verifies on the fork. With required checks, it runs them at the new head
// (atelier check) and reports them (refresh-checked); a failure goes back
// to the builder. A lease that lapses while its checks run is taken again
// at the recorded head, and the next job runs only the checks. An announced
// push with no report retains the landing fence across expiry; the next job
// reconciles the fork, records the merge and runs its checks before taking
// any newer main target. Git pushes have a bounded two-minute timeout. A push
// whose report fails is left fenced for reconciliation, without a rollback
// that could outlive the lease and race a later landing.
// Every report names the lease, and a report the server already holds
// answers the recorded outcome, so a retry does no harm. The lease is
// renewed while the job runs, and one that ends in no report (a provider's
// usage limit on the resolver's harness, a failure before any report) is
// given back at once, saying why, rather than held until it lapses.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSFORMATIONS, classifyConflicts, conflictReport, verifyResolution } from "../src/refresh/mechanical.ts";
import { DETECTOR_ENV, describeFinding, detectMovedEditsAsync } from "../src/moved-code.ts";
import { guardedPush } from "./private.mjs";

const HASH = /^[a-f0-9]{40,64}$/;
const CHECKS_FAILED = 2;
export const PUSH_TIMEOUT_MS = 2 * 60_000;
// How often the leaseholder renews its 30-minute lease (LEASE_MS in
// src/refresh/queue.ts) while the job runs: a resolver's harness or the
// required checks can outlast it, and the runner's heartbeat renews only
// its poll.
export const LEASE_RENEW_MS = 10 * 60_000;
const short = (h) => String(h ?? "").slice(0, 8);

// The identity of the task's own change, as the refresh compares it before
// and after (src/refresh/review.ts): its diff with line numbers and blob
// ids left out, so main's moving the lines around it does not count as a
// change, hashed. Null when there is no diff to compare.
export function diffIdentity(diff) {
  const text = String(diff ?? "");
  if (!text.trim()) return null;
  const kept = text.split("\n").filter((l) => !l.startsWith("index ")).map((l) => (l.startsWith("@@") ? "@@" : l)).join("\n");
  return createHash("sha1").update(kept).digest("hex");
}

// The brief a resolver's harness gets: the transformations it may apply,
// and each conflict, with what applies to it.
export function resolverBrief(item, files) {
  return [
    `# Resolve the mechanical conflicts of ${item.id}'s refresh`,
    "",
    "Main has been merged into this task's head in this workspace, and the merge is in progress with conflicts left in the files below, git's diff3 markers in place. Every conflict here is mechanical: one of these transformations, and only it, resolves it.",
    "",
    ...TRANSFORMATIONS.map((t) => `- ${t.id}: ${t.rule}`),
    "",
    "Edit each file so each conflict holds exactly the resolution its transformation gives, and nothing else changes: no other line of the file, no other file. Do not stage, commit, abort or restart the merge; the runner verifies each file against the transformations, then commits the merge under your Agent line. A file that holds anything else is not pushed: the conflict goes back to the task's builder.",
    "",
    "## Conflicts",
    "",
    ...files.flatMap((f) => [`- ${f.path}: ${f.why}`, ...f.hunks.map((h) => `  - at line ${h.line}: ${h.transformation}, ${h.why}`)]),
    "",
  ].join("\n");
}

// The report a moved-code finding goes back to the builder with: each
// finding's source and destination as a behavioural file, since porting an
// edit to where main moved its code is the builder's decision.
export function movedReport(input, findings) {
  const files = findings.map((f) => ({ path: f.source.path, kind: "behavioural", why: describeFinding(f), hunks: [] }));
  return conflictReport(input, files);
}

export async function runTaskRefresh(assignment, config, name, io) {
  const { project, item, actor } = assignment;
  const d = item.dispatch ?? {};
  const job = d.job === "task-resolve" ? "resolve" : "refresh";
  const at = ["--project", project, "--as", actor];
  let lease = null, dir = null, pushed = null, recorded = false, workspace = null, renewal = null, renewing = false, announced = false;
  const report = async (argv) => JSON.parse(await io.cli([argv[0], item.id, ...at, ...argv.slice(1)]) || "{}");
  const leaseArgs = () => ["--lease", lease.id, "--main-head", lease.mainHead, "--expected-head", lease.expectedHead];
  try {
    if (job === "refresh" && actor !== "atelier/integrator") throw Object.assign(new Error("the task-refresh job runs as atelier/integrator"), { skipped: true });
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(project) || !/^t[0-9]+$/.test(item.id) || !HASH.test(d.head ?? "")) {
      throw Object.assign(new Error("the queue returned an invalid refresh assignment"), { skipped: true });
    }
    const leased = await report(["refresh-lease", "--job", job, "--runner", name]);
    lease = leased.lease;
    announced = !!lease?.pushing;
    workspace = leased.workspace;
    if (!lease?.id || !HASH.test(lease.mainHead ?? "") || !HASH.test(lease.expectedHead ?? "") || !workspace?.remote || !leased.baseline?.remote) throw new Error("the refresh lease names no lease, heads or repositories");
    const { mainHead, expectedHead } = lease;
    // Renewed while the job runs; one renewal in flight, and a failure is
    // said and tried again on the next interval.
    renewal = setInterval(async () => {
      if (renewing || io.stopped?.()) return;
      renewing = true;
      try { await report(["refresh-lease", "--renew", lease.id]); }
      catch (error) { io.log(`renewing ${item.id}'s refresh lease failed: ${error.message}`); }
      finally { renewing = false; }
    }, io.leaseRenewMs ?? LEASE_RENEW_MS);
    renewal.unref?.();
    // The required checks at the head a refresh recorded, reported under the
    // lease; a failure sends the task back to its builder.
    const checkAt = async (head) => {
      let failing = null;
      try {
        const output = await io.cli(["check", item.id, ...at]);
        if (output) io.log(output);
      } catch (error) {
        if (error.code !== CHECKS_FAILED) throw error;
        failing = String(error.output ?? "").split("\n").filter((l) => l.startsWith("FAIL")).map((l) => l.replace(/\s+/g, " ").trim()).join("; ") || error.message;
      }
      await report(["refresh-checked", ...leaseArgs(), ...(failing === null ? ["--passed"] : ["--failed", "--reason", `the required checks failed with main merged: ${failing}`.slice(0, 400)])]);
      if (failing !== null) io.log(`${item.id}'s checks failed at the refreshed head ${short(head)}; it goes back to its builder`);
      return failing === null ? { phase: "refreshed", head } : { phase: "failed", reason: "checks failed at the refreshed head", recorded: true };
    };
    // A lease taken again after one lapsed while its holder ran the checks
    // at the head its refresh recorded resumes there: the merge is recorded,
    // and only the checks are left.
    if (lease.checking) {
      if (!HASH.test(lease.checking)) throw new Error("the resumed refresh lease names no recorded head");
      recorded = true;
      io.log(`${item.id}'s refresh with main at ${short(mainHead)} is recorded at ${short(lease.checking)}; running its checks`);
      return await checkAt(lease.checking);
    }
    // A workspace of the refresh's own: the builder's is never touched.
    dir = await io.tempDir(`refresh-${project}-${item.id}-`);
    const git = (args, options = {}) => io.git(args, { cwd: dir, ...options });
    await git(["init", "--quiet"]);
    // Recover a push whose report was lost before considering whether the
    // branch already contains main. The server verifies the merge and Agent
    // line again; only then can its required checks run.
    if (lease.pushing) {
      const remote = await git(["ls-remote", workspace.remote, `refs/heads/${workspace.defaultBranch || "main"}`], { token: workspace.token, timeoutMs: PUSH_TIMEOUT_MS });
      const top = remote.split(/\s+/)[0];
      if (!HASH.test(top)) throw new Error("cannot reconcile the announced push: no fork head");
      if (top !== lease.pushing.head) {
        await report(["refresh-failed", ...leaseArgs(), "--outcome", "superseded", "--reason", "the settled fork does not name the announced refresh"]);
        recorded = true;
        return { phase: "failed", reason: "the fork moved", recorded: true };
      }
      const refreshed = await report(["refreshed", ...leaseArgs(), "--head", top]);
      recorded = true;
      if (refreshed?.result?.reason === "checks pending") return await checkAt(top);
      return { phase: "refreshed", head: top };
    }
    const identity = leased.commitIdentity;
    // The project's commit identity (t451), as a claim writes it.
    await git(["config", "user.name", identity?.name || "Atelier"]);
    await git(["config", "user.email", identity?.email || "atelier@users.noreply.atelier.zone"]);
    await io.fetch(dir, workspace.remote, workspace.token, expectedHead);
    await io.fetch(dir, leased.baseline.remote, leased.baseline.token, mainHead);
    await git(["checkout", "--quiet", "--detach", expectedHead]);
    if (await io.isAncestor(dir, mainHead, expectedHead)) {
      await report(["refreshed", ...leaseArgs()]);
      recorded = true;
      io.log(`${item.id} already holds main at ${short(mainHead)}`);
      return { phase: "refreshed", held: true };
    }
    const mergeBase = await git(["merge-base", expectedHead, mainHead]);
    // The task's edits against code main moved to another file (t471),
    // compared before either job merges: once main is merged its head is
    // the merge base, and a landing compares nothing. Git merges such an
    // edit cleanly into the file main left behind, so a finding is the
    // builder's to port: it goes back with the paths, and nothing is pushed.
    const moved = await detectMovedEditsAsync((args) => git(args, { raw: true, env: DETECTOR_ENV }), { task: expectedHead, main: mainHead, mergeBase })
      .catch((error) => { throw new Error(`comparing the task's edits with code main moved failed: ${error.message}`); });
    if (moved.findings.length) {
      const conflict = movedReport({ base: mergeBase, head: expectedHead, main: mainHead }, moved.findings);
      const file = join(await io.tempDir(`refresh-report-${item.id}-`), "report.json");
      writeFileSync(file, JSON.stringify(conflict));
      const n = moved.findings.length;
      await report(["refresh-failed", ...leaseArgs(), "--outcome", "returned", "--report", file, "--reason", `${n} edit${n === 1 ? "" : "s"} in code main moved to another file: ${describeFinding(moved.findings[0])}`.slice(0, 400)]);
      recorded = true;
      io.log(`${item.id}'s edits lie in code main at ${short(mainHead)} moved to another file (${n} finding${n === 1 ? "" : "s"}); returned to its builder, nothing pushed`);
      return { phase: "failed", reason: "edits in moved code", recorded: true, returned: true };
    }
    const message = `Merge main at ${short(mainHead)} into ${item.id}\n\nAgent: ${actor}`;
    const merged = await git(["-c", "merge.conflictStyle=diff3", "merge", "--no-ff", "--no-edit", "-m", message, mainHead], { allowFail: true });
    const conflicted = (await git(["diff", "--name-only", "--diff-filter=U", "-z"], { raw: true })).split("\0").filter(Boolean);
    let transformations = [];
    if (conflicted.length) {
      const inputs = [];
      for (const path of conflicted) {
        const stages = [...new Set((await git(["ls-files", "-u", "-z", "--", path], { raw: true })).split("\0").filter(Boolean).map((l) => Number(/^\d+ [0-9a-f]+ (\d)\t/.exec(l)?.[1])))].filter(Boolean);
        const file = join(dir, path);
        const text = existsSync(file) ? readFileSync(file, "utf8") : null;
        inputs.push({ path, text, stages });
      }
      const classified = classifyConflicts(inputs);
      if (classified.kind !== "mechanical") {
        const conflict = conflictReport({ base: mergeBase, head: expectedHead, main: mainHead }, classified.files);
        const file = join(await io.tempDir(`refresh-report-${item.id}-`), "report.json");
        writeFileSync(file, JSON.stringify(conflict));
        await report(["refresh-failed", ...leaseArgs(), "--outcome", "returned", "--report", file, "--reason", `${conflict.kind} conflict in ${classified.files.filter((f) => f.kind !== "mechanical").map((f) => f.path).join(", ")}`]);
        recorded = true;
        io.log(`${item.id}'s refresh from main at ${short(mainHead)} conflicts beyond the mechanical transformations (${conflict.kind}); returned to its builder`);
        return { phase: "failed", reason: `${conflict.kind} conflict`, recorded: true, returned: true };
      }
      if (job === "refresh") {
        await report(["refresh-failed", ...leaseArgs(), "--outcome", "mechanical", "--reason", `mechanical conflicts in ${conflicted.join(", ")}`]);
        recorded = true;
        io.log(`${item.id}'s refresh from main at ${short(mainHead)} left only mechanical conflicts; it goes to a resolver`);
        return { phase: "failed", reason: "mechanical conflicts, for a resolver", recorded: true };
      }
      // The resolver's harness resolves; what it wrote is verified, file by file.
      const before = Object.fromEntries(inputs.map((i) => [i.path, i.text]));
      const headBefore = await io.head(dir);
      const snapshot = () => git(["ls-files", "-s", "-z"], { raw: true });
      const untracked = async () => (await git(["ls-files", "--others", "--exclude-standard", "-z"], { raw: true })).split("\0").filter((p) => p && !p.startsWith(".scratch/"));
      const indexBefore = await snapshot(), untrackedBefore = await untracked();
      await io.resolveConflicts(assignment, dir, resolverBrief(item, classified.files));
      const faults = [];
      if (await io.head(dir) !== headBefore) faults.push("the resolver moved HEAD; it must leave the merge for the runner to commit");
      if ((await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFail: true })).status !== 0) faults.push("the merge is no longer in progress");
      for (const path of conflicted) {
        const file = join(dir, path);
        const why = existsSync(file) ? verifyResolution(before[path], readFileSync(file, "utf8")) : "the file is gone";
        if (why) faults.push(`${path}: ${why}`);
      }
      // Nothing outside the conflicted files may change: the index is as
      // the merge left it, and the working tree differs from it in the
      // conflicted files alone, with nothing new untracked.
      if (await snapshot() !== indexBefore) faults.push("the resolver staged or unstaged files; the runner stages the resolution itself");
      const elsewhere = [
        ...(await git(["diff", "--name-only", "-z"], { raw: true })).split("\0").filter((p) => p && !conflicted.includes(p)),
        ...(await untracked()).filter((p) => !untrackedBefore.includes(p)),
      ];
      if (elsewhere.length) faults.push(`the resolver changed files outside the conflicts: ${elsewhere.slice(0, 10).join(", ")}`);
      if (faults.length) {
        const conflict = conflictReport({ base: mergeBase, head: expectedHead, main: mainHead }, classified.files.map((f) => ({ ...f, kind: "uncertain", why: `the resolution was not mechanical: ${faults.join("; ").slice(0, 300)}` })));
        const file = join(await io.tempDir(`refresh-report-${item.id}-`), "report.json");
        writeFileSync(file, JSON.stringify({ ...conflict, kind: "uncertain" }));
        await report(["refresh-failed", ...leaseArgs(), "--outcome", "returned", "--report", file, "--reason", `the resolution was not mechanical: ${faults[0]}`.slice(0, 400)]);
        recorded = true;
        io.log(`${actor}'s resolution of ${item.id} failed verification: ${faults.join("; ")}; returned to its builder`);
        return { phase: "failed", reason: "unverified resolution", recorded: true, returned: true };
      }
      await git(["add", "--", ...conflicted]);
      await git(["commit", "--quiet", "--no-edit", "-m", message]);
      transformations = [...new Set(classified.files.flatMap((f) => f.hunks.map((h) => h.transformation)))];
    } else if (merged.status !== 0) {
      throw new Error(`merging main at ${short(mainHead)} failed: ${(merged.stderr || merged.stdout || "").trim().slice(0, 400)}`);
    }
    const head = await io.head(dir);
    const diffBefore = diffIdentity(await git(["diff", "--no-color", mergeBase, expectedHead], { raw: true }));
    const diffAfter = diffIdentity(await git(["diff", "--no-color", mainHead, head], { raw: true }));
    // Said before the push; refused when the task moved or is busy or landing.
    const pushStarted = Date.now();
    try { await report(["refresh-pushing", ...leaseArgs(), "--head", head]); announced = true; }
    catch (error) {
      await report(["refresh-failed", ...leaseArgs(), "--outcome", "superseded", "--reason", `not pushed: ${error.message}`.slice(0, 400)]).catch(() => {});
      recorded = true;
      return { phase: "failed", reason: `not pushed: ${error.message}`, recorded: true };
    }
    const branch = workspace.defaultBranch || "main";
    if (Date.now() - pushStarted >= PUSH_TIMEOUT_MS) throw new Error("push authorization expired before git started");
    // The merge adds none of the project's private files to the fork (t645):
    // everything the fork lacks is read for them, main's commits included,
    // against the fork's head alone, which the lease names (Astra's third
    // review of t645: main's history was taken as held).
    let privateHeld = null;
    const push = await guardedPush({ project, cwd: dir, tip: head, base: [lease.expectedHead], what: `${item.id}'s refresh`, fail: (message) => { privateHeld = message; return null; } },
      () => git(["push", "--quiet", workspace.remote, `${head}:refs/heads/${branch}`], { token: workspace.token, allowFail: true, timeoutMs: PUSH_TIMEOUT_MS }));
    if (privateHeld) throw new Error(privateHeld);
    // A transport error may arrive after the remote installed the commit.
    // Reconcile before declaring the push superseded and dropping its fence.
    let pushedDespiteError = false;
    if (push.status !== 0) {
      const top = (await git(["ls-remote", workspace.remote, `refs/heads/${branch}`], { token: workspace.token, timeoutMs: PUSH_TIMEOUT_MS })).split(/\s+/)[0];
      if (!HASH.test(top)) throw new Error("cannot reconcile the failed push: no fork head");
      pushedDespiteError = top === head;
    }
    if (push.status !== 0 && !pushedDespiteError) {
      // No force: a push in between (the builder's) keeps the fork, and the
      // refresh is tried again from wherever the task is now.
      await report(["refresh-failed", ...leaseArgs(), "--outcome", "superseded", "--reason", `the fork moved under the refresh; the push was refused: ${(push.stderr || "").trim().slice(0, 200)}`]);
      recorded = true;
      io.log(`${item.id}'s fork moved under the refresh; nothing was pushed over it`);
      return { phase: "failed", reason: "the fork moved", recorded: true };
    }
    pushed = head;
    // Retry a lost answer before leaving reconciliation to lease recovery;
    // a report already recorded answers idempotently.
    const refreshedArgs = ["refreshed", ...leaseArgs(), "--head", head, ...(diffBefore ? ["--diff-before", diffBefore] : []), ...(diffAfter ? ["--diff-after", diffAfter] : []), ...(transformations.length ? ["--transformations", transformations.join(",")] : [])];
    const refreshed = await report(refreshedArgs).catch((error) => { io.log(`recording the refresh failed (${error.message}); asking again`); return report(refreshedArgs); });
    recorded = true;
    io.log(`${item.id} refreshed with main at ${short(mainHead)} as ${short(head)}${transformations.length ? ` (${transformations.join(", ")})` : ""}`);
    if (!(leased.checks ?? []).length || refreshed?.result?.reason !== "checks pending") return { phase: "refreshed", head };
    return await checkAt(head);
  } catch (error) {
    io.log(`refresh of ${item.id} failed: ${error.message}`);
    // Once a push is announced, retain its fence and let lease recovery
    // reconcile the fork. Never issue a late rollback: a delayed report
    // could outlast this lease and race another runner's landing.
    if (pushed && !recorded && workspace) {
      const status = await report(["refresh-lease", "--status", lease.id]).catch((e) => ({ error: e }));
      if (status.error || status.head === pushed) {
        recorded = true;
        io.log(status.error
          ? `reading ${item.id}'s recorded head failed (${status.error.message}); the push of ${short(pushed)} is left on the fork`
          : `${item.id}'s refresh is recorded at ${short(pushed)}${status.checking ? "; its checks resume under the next lease" : ""}; the push stays`);
      }
    }
    // A lease that ended in no report is given back at once, with why, so
    // the task's log says what stopped it and the same work is offered
    // again, rather than held until the lease lapses: a provider's usage
    // limit on the resolver's harness (which pauses the harness, as a
    // build's does, and counts toward neither cap), or a failure before any
    // report, a detector's or git's. A push left on the fork keeps its
    // lease, which lapses.
    if (lease?.id && !recorded && !announced) {
      clearInterval(renewal);
      try {
        const answer = await report(["refresh-lease", "--release", lease.id, "--reason", error.message.slice(0, 400), ...(error.providerLimit ? ["--provider-limit"] : [])]);
        if (answer.released !== false) io.log(`released ${item.id}'s refresh lease${error.providerLimit ? "; the same work resumes when the provider's limit resets" : ""}`);
      } catch (releaseError) { io.log(`releasing ${item.id}'s refresh lease failed: ${releaseError.message}`); }
    }
    // A lease the server refused (the task became busy, another runner took
    // it) is the queue's state, not a failure: counted toward neither cap,
    // and offered again when the queue offers it.
    return {
      phase: "failed", reason: error.message, ...(error.skipped ? { skipped: true } : {}), ...(!lease && !error.skipped ? { recorded: true } : {}),
      ...(error.providerLimit ? { providerLimit: error.providerLimit } : {}),
    };
  } finally {
    clearInterval(renewal);
    if (dir) await io.removeTree(dir);
  }
}

