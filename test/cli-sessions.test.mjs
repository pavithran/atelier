// Part 1 of 2 of the tests that were in cli-sessions.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { constants as osConstants } from "node:os";
import { landingDir, landingJournalFile, oldLandingJournalFile } from "../cli/landing.mjs";
import { fixture, snapshot, remote, cli } from "./cli-sessions-shared.mjs";

// No test reads this Mac's own iCloud folder (t645).
process.env.ATELIER_PRIVATE_ROOT ||= `${process.env.TMPDIR || "/tmp"}/atelier-tests-no-icloud-${process.pid}`;


test("unwrap uses only GET and leaves all checkout and Git files unchanged, the index included", (t) => {
  const f = fixture(t);
  // Make the index's stat data stale, as an editor or a build leaves it: a status that
  // refreshes the index would rewrite it, and unwrap must not.
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(f.checkout, "STATE.md"), old, old);
  const index = () => readFileSync(join(f.checkout, ".git", "index"));
  const before = snapshot(f.checkout), indexBefore = index();
  const result = f.run("unwrap");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(index().equals(indexBefore), "the index was refreshed");
  assert.deepEqual(snapshot(f.checkout), before);
  assert.ok(f.requests().every((r) => r.method === "GET"));
  assert.match(result.stdout, /Current branch:/);
  assert.match(result.stdout, /loose.txt/);
  assert.match(result.stdout, /Previous/);
  assert.match(result.stdout, /STATE.md:\nCurrent state/);
  assert.match(result.stdout, /Say in a short paragraph/);
});


test("unwrap names where it looked when the project has no state file", (t) => {
  const f = fixture(t);
  rmSync(join(f.checkout, "STATE.md"));
  const r = f.run("unwrap");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("State file: none (looked for docs/STATE.md, STATE.md and PROJECT.md)."));
  assert.doesNotMatch(r.stdout, /STATE\.md:\n/, "no excerpt is printed");
  assert.ok(f.requests().every((q) => q.method === "GET"));
});


test("unwrap reads an untracked PROJECT.md as the state file", (t) => {
  const f = fixture(t);
  rmSync(join(f.checkout, "STATE.md"));
  writeFileSync(join(f.checkout, "PROJECT.md"), "Project handoff\n");
  const r = f.run("unwrap");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PROJECT\.md:\nProject handoff/);
  assert.doesNotMatch(r.stdout, /State file: none/);
});


test("unwrap compares the registered branch with each remote's tracking ref, as last fetched or pushed", (t) => {
  const f = fixture(t), branch = f.git("branch", "--show-current");
  remote(f, "github");
  f.git("push", "github", branch); // the push records the tracking ref
  for (const name of ["One", "Two"]) {
    writeFileSync(join(f.checkout, `${name.toLowerCase()}.txt`), `${name}\n`);
    f.git("add", `${name.toLowerCase()}.txt`);
    f.git("commit", "-qm", name);
  }
  let before = snapshot(f.checkout);
  const ahead = f.run("unwrap");
  assert.equal(ahead.status, 0, ahead.stderr);
  assert.ok(ahead.stdout.includes(`Remote github: ${branch} is 2 commits ahead of github/${branch} (as last fetched or pushed); not published.`));
  assert.deepEqual(snapshot(f.checkout), before, "no checkout or Git file changed, the index included");
  assert.ok(f.requests().every((q) => q.method === "GET"), "nothing was fetched through the server");
  remote(f, "mirror");
  before = snapshot(f.checkout);
  const unfetched = f.run("unwrap");
  assert.equal(unfetched.status, 0, unfetched.stderr);
  assert.ok(unfetched.stdout.includes(`Remote mirror: no mirror/${branch} recorded; fetch to compare.`));
  assert.deepEqual(snapshot(f.checkout), before, "no checkout or Git file changed, the index included");
  const line = (r) => r.stdout.split("\n").find((l) => l.startsWith("Remote github:"));
  const unwrapped = () => { const r = f.run("unwrap"); assert.equal(r.status, 0, r.stderr); return line(r); };
  f.git("push", "-q", "github", branch);
  assert.equal(unwrapped(), `Remote github: ${branch} is in step with github/${branch} (as last fetched or pushed).`);
  f.git("reset", "-q", "--hard", "HEAD~1");
  assert.equal(unwrapped(), `Remote github: ${branch} is 1 commit behind github/${branch} (as last fetched or pushed).`);
  writeFileSync(join(f.checkout, "three.txt"), "Three\n");
  f.git("add", "three.txt");
  f.git("commit", "-qm", "Three");
  assert.equal(unwrapped(), `Remote github: ${branch} is 1 commit ahead of and 1 commit behind github/${branch} (as last fetched or pushed); not published.`);
});


test("unwrap reports a tracking ref it cannot compare and carries on", (t) => {
  const f = fixture(t), branch = f.git("branch", "--show-current");
  remote(f, "broken");
  // A tracking ref naming an object the repository does not have.
  mkdirSync(join(f.checkout, ".git", "refs", "remotes", "broken"), { recursive: true });
  writeFileSync(join(f.checkout, ".git", "refs", "remotes", "broken", branch), `${"0".repeat(39)}1\n`);
  const r = f.run("unwrap");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Remote broken: cannot compare ${branch} with broken/${branch} \\(git rev-list exited \\d+\\)\\.`));
  assert.match(r.stdout, /Say in a short paragraph/);
});


test("wrap commits with summary, next and trailer when the checks pass, and updates the baseline", (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t);
  const result = f.runWith({ FAKE_CHECKS: JSON.stringify(["true"]) }, "wrap", "Finished", "--next", "Fix check");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(f.git("rev-parse", "HEAD"), f.head);
  assert.equal(f.git("--git-dir", f.baseline, "rev-parse", "HEAD"), f.git("rev-parse", "HEAD"));
  assert.match(f.git("log", "-1", "--format=%B"), /^Finished\n\nFix check\n\nAtelier-Session: /);
  const writes = f.requests().filter((r) => r.method === "POST" && r.path.endsWith("/sessions"));
  assert.equal(writes.length, 1);
  const data = JSON.parse(writes[0].body);
  assert.equal(data.dirty, false);
  assert.equal(data.commit, f.git("rev-parse", "HEAD"));
  assert.match(f.git("log", "-1", "--format=%B"), new RegExp(data.sessionAt));
  // The whitespace check runs on what the commit will hold, so after the registered checks and staging.
  assert.deepEqual(data.checks.map((c) => [c.command, c.passed, c.grade]), [["true", true, "reported"], ["git diff --cached --check", true, "reported"]]);
  assert.equal(data.checksOverridden, undefined, "nothing was overridden");
  assert.match(result.stdout, /Refresh STATE.md/);
  assert.match(result.stdout, /Relay: session closed; checks are Reported, not Observed\./);
  assert.doesNotMatch(result.stdout, /overridden/);
});


test("wrap pins the checkout's git identity to the project's, once, and prints nothing when it already matches (t755)", (t) => {
  // Finding: llm-basics, 2026-10-17, a commit in the registered checkout took
  // the global address and the baseline push was refused.
  const f = fixture(t);
  const identity = JSON.stringify({ name: "Owner", email: "123+owner@users.noreply.github.com", agentEmails: [] });
  const said = /Set this checkout's git identity to Owner <123\+owner@users\.noreply\.github\.com>/;
  const first = f.runWith({ FAKE_IDENTITY: identity }, "wrap", "First", "--no-check");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, said);
  assert.equal(first.stdout.match(/Set this checkout's git identity/g).length, 1);
  assert.equal(f.git("config", "--local", "user.email"), "123+owner@users.noreply.github.com");
  assert.equal(f.git("config", "--local", "user.name"), "Owner");
  assert.equal(f.git("log", "-1", "--format=%ae %ce"), "123+owner@users.noreply.github.com 123+owner@users.noreply.github.com");
  writeFileSync(join(f.checkout, "again.txt"), "more\n");
  const second = f.runWith({ FAKE_IDENTITY: identity }, "wrap", "Second", "--no-check");
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /git identity/);
});


// A failing registered check refuses the commit, as an unfinished checkout
// does: the tree, the index and HEAD stay as the checks left them, and no
// request writes. The fixture's default check is `exit 7`.
function refusesFailingChecks(f, env, say) {
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(f.checkout, "STATE.md"), old, old);
  const before = snapshot(f.checkout), head = f.git("rev-parse", "HEAD");
  const r = f.runWith(env, "wrap", "Refuse", "--next", "x");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, say);
  assert.match(r.stderr, /Nothing was staged, recorded or pushed\./);
  assert.deepEqual(snapshot(f.checkout), before, "no file, and not the index, changed");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.git("diff", "--cached", "--name-only"), "", "nothing was staged");
  assert.equal(f.git("--git-dir", f.baseline, "rev-parse", "HEAD"), f.head, "the baseline was not updated");
  assert.deepEqual(f.requests().filter((q) => q.method !== "GET"), [], "no note, no baseline update");
  return r;
}


test("wrap refuses to commit when a registered check fails, naming it with its exit status", (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t);
  const r = refusesFailingChecks(f, {}, /^atelier: wrap refuses to commit with a failing check: exit 7 \(exited 7\)\. Fix it, or run again with --allow-failing to commit anyway\./m);
  assert.match(r.stdout, /Reported: exit 7: failed \(developer's checkout, not a clean clone\)\./, "the result was printed before the refusal");
  assert.doesNotMatch(r.stdout, /Uncommitted files|Refresh STATE\.md|Relay:/, "wrap stopped right after the checks");
});


test("the refusal names every failed check, with the signal that ended one that did not exit", (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t);
  const r = refusesFailingChecks(f, { FAKE_CHECKS: JSON.stringify(["exit 7", "true", "kill -TERM $$"]) },
    /wrap refuses to commit with 2 failing checks: exit 7 \(exited 7\), kill -TERM \$\$ \(ended by SIGTERM\)\. Fix them, or run again with --allow-failing/);
  assert.match(r.stdout, /Reported: true: passed/);
});


// t419: a registered check's group, and what it started, ends with the
// command running it when that command is interrupted, hung up on or
// SIGTERMed, and the command ends with the signal's status.
test("SIGINT, SIGTERM and SIGHUP to wrap end the running check's process group", { timeout: 30_000 }, async (t) => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const f = fixture(t);
    const pidFile = join(f.dir, "check-sleeper.pid");
    const child = f.spawnWith({ FAKE_CHECKS: JSON.stringify([`sleep 300 & echo $! > ${pidFile}; wait`]) }, "wrap", "Interrupted", "--next", "x");
    t.after(() => child.kill("SIGKILL"));
    const ended = new Promise((ok) => child.on("close", (status, sig) => ok({ status, sig })));
    const until = Date.now() + 15_000;
    while (!(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim())) {
      assert.ok(Date.now() < until, "the check never started its sleeper");
      await new Promise((ok) => setTimeout(ok, 25));
    }
    const sleeper = Number(readFileSync(pidFile, "utf8"));
    child.kill(signal);
    assert.deepEqual(await ended, { status: 128 + osConstants.signals[signal], sig: null });
    const alive = () => { try { process.kill(sleeper, 0); return true; } catch { return false; } };
    for (const stop = Date.now() + 2000; alive() && Date.now() < stop;) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(alive(), false, `after ${signal}, the check's sleeper ${sleeper} outlived wrap`);
  }
});


test("wrap --allow-failing commits past a failing check and records the override in the note", (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t);
  const result = f.run("wrap", "Finished", "--next", "Fix check", "--allow-failing");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(f.git("rev-parse", "HEAD"), f.head);
  assert.equal(f.git("--git-dir", f.baseline, "rev-parse", "HEAD"), f.git("rev-parse", "HEAD"));
  assert.match(f.git("log", "-1", "--format=%B"), /^Finished\n\nFix check\n\nAtelier-Session: /);
  const writes = f.requests().filter((r) => r.method === "POST" && r.path.endsWith("/sessions"));
  assert.equal(writes.length, 1);
  const data = JSON.parse(writes[0].body);
  assert.equal(data.commit, f.git("rev-parse", "HEAD"));
  assert.deepEqual(data.checks.map((c) => [c.command, c.passed, c.grade]), [["exit 7", false, "reported"], ["git diff --cached --check", true, "reported"]]);
  assert.deepEqual(data.checksOverridden, ["exit 7"]);
  assert.equal(data.checksSkipped, false);
  assert.match(result.stdout, /^Failing checks overridden by --allow-failing: exit 7 \(exited 7\)\.$/m);
  assert.match(result.stdout, /^Relay: session closed with a failing check overridden by --allow-failing\.$/m);
  // The note the server returned is printed with the override in it.
  assert.match(result.stdout, /^Failing checks overridden by --allow-failing: exit 7\.$/m);
});


test("wrap --allow-failing with passing checks records no override", (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t);
  const r = f.runWith({ FAKE_CHECKS: JSON.stringify(["true"]) }, "wrap", "Fine", "--allow-failing");
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(f.requests().find((q) => q.method === "POST" && q.path.endsWith("/sessions")).body);
  assert.equal(data.checksOverridden, undefined);
  assert.doesNotMatch(r.stdout, /overridden/);
});


test("--allow-failing takes no value and is not combined with --no-check; either refusal touches nothing", (t) => {
  for (const [args, say] of [
    [["--allow-failing", "--no-check"], /--allow-failing and --no-check together: skipped checks cannot fail; give one or the other/],
    [["--allow-failing=yes"], /--allow-failing takes no value/],
  ]) {
    const f = fixture(t), before = snapshot(f.checkout);
    const r = f.run("wrap", "Mixed", ...args);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, say);
    assert.deepEqual(snapshot(f.checkout), before);
    assert.deepEqual(f.requests(), [], "refused before any request");
  }
});


test("an unquoted summary is one summary", (t) => {
  const f = fixture(t);
  const r = f.run("wrap", "Finished", "the", "day's", "work", "--next", "Fix check", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.git("log", "-1", "--format=%B"), /^Finished the day's work\n\nFix check\n\n/);
  assert.equal(JSON.parse(f.requests().find((q) => q.method === "POST" && q.path.endsWith("/sessions")).body).summary, "Finished the day's work");
});


test("wrap with no summary stops before it touches anything", (t) => {
  const f = fixture(t), before = snapshot(f.checkout);
  const r = f.run("wrap", "--no-check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a session needs a summary/);
  assert.deepEqual(snapshot(f.checkout), before);
});


test("wrap checks whitespace in what the commit will hold, new files and staged changes included", (t) => {
  const check = (f) => JSON.parse(f.requests().find((q) => q.method === "POST" && q.path.endsWith("/sessions")).body).checks.find((c) => c.command === "git diff --cached --check");
  // An untracked file: git diff --check, which reads the working tree against the index, never sees it.
  const added = fixture(t);
  writeFileSync(join(added.checkout, "new.txt"), "trailing   \n");
  const first = added.run("wrap", "Added", "--no-check");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(check(added).passed, false);
  assert.match(first.stdout, /new\.txt:1: trailing whitespace/);
  assert.match(added.git("ls-tree", "-r", "--name-only", "HEAD"), /new\.txt/, "the failing check is recorded and the session still closes");
  // A change already staged: the working tree and the index agree, so a plain git diff --check is silent.
  const staged = fixture(t);
  writeFileSync(join(staged.checkout, "STATE.md"), "Changed   \n");
  staged.git("add", "STATE.md");
  const second = staged.run("wrap", "Staged", "--no-check");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(check(staged).passed, false);
  assert.match(second.stdout, /STATE\.md:1: trailing whitespace/);
  // And a tree with nothing wrong passes.
  const fine = fixture(t);
  const third = fine.run("wrap", "Fine", "--no-check");
  assert.equal(third.status, 0, third.stderr);
  assert.equal(check(fine).passed, true);
});


test("wrap --no-check still checks whitespace and records the skip", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, "STATE.md"), "Changed   \n");
  const result = f.run("wrap", "Stopped", "--no-check");
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(f.requests().find((r) => r.method === "POST").body);
  assert.equal(data.checksSkipped, true);
  assert.equal(data.checks.length, 1);
  assert.equal(data.checks[0].passed, false);
  assert.doesNotMatch(result.stdout, /Refresh STATE.md/);
});


test("wrap compares an untracked state file by its modification time, not with git show", (t) => {
  // The previous note is dated 2026-10-04T12:00:00Z.
  const older = new Date("2026-10-03T00:00:00.000Z"), newer = new Date("2026-10-05T00:00:00.000Z");
  const stale = fixture(t);
  rmSync(join(stale.checkout, "STATE.md"));
  writeFileSync(join(stale.checkout, "PROJECT.md"), "Handoff\n");
  utimesSync(join(stale.checkout, "PROJECT.md"), older, older);
  // Git holds no copy of an untracked file at any commit, so none is asked for.
  const shown = (f) => f.gitCalls().filter((args) => args[0] === "show").map((args) => args[1]);
  const first = stale.run("wrap", "Untracked", "--no-check");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Refresh PROJECT\.md/);
  assert.deepEqual(shown(stale), [], "git show was run for the untracked state file");
  const fresh = fixture(t);
  rmSync(join(fresh.checkout, "STATE.md"));
  writeFileSync(join(fresh.checkout, "PROJECT.md"), "Handoff\n");
  utimesSync(join(fresh.checkout, "PROJECT.md"), newer, newer);
  const second = fresh.run("wrap", "Untracked", "--no-check");
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /Refresh PROJECT\.md/);
  assert.deepEqual(shown(fresh), [], "git show was run for the untracked state file");
});


test("wrap says when a tracked state file has no copy at the previous session's head", (t) => {
  const f = fixture(t);
  // docs/STATE.md comes first among the state files, and it was committed
  // after the previous note's head, so git show at that head finds nothing.
  rmSync(join(f.checkout, "STATE.md"));
  mkdirSync(join(f.checkout, "docs"));
  writeFileSync(join(f.checkout, "docs", "STATE.md"), "Moved here\n");
  f.git("add", "-A");
  f.git("commit", "-qm", "Move the state file");
  const r = f.run("wrap", "Moved", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Could not compare docs\/STATE\.md with the previous session HEAD\.$/m);
  assert.ok(f.gitCalls().some((args) => args[0] === "show" && args[1] === `${f.head}:docs/STATE.md`), "git show at the previous head was not run");
});


test("unwrap with an explicit project reads standing even without a local checkout", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", projects: {} }));
  const result = f.run("unwrap", "--project", "demo");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /none is registered on this machine/);
  assert.match(result.stdout, /Previous/);
  assert.ok(f.requests().every((r) => r.method === "GET"));
});


test("clean wrap records a note without a commit", (t) => {
  const f = fixture(t);
  f.clean();
  const r = f.run("wrap", "Clean", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
  assert.match(r.stdout, /Nothing to commit/);
  assert.equal(JSON.parse(f.requests().find((r) => r.path.endsWith("/sessions") && r.method === "POST").body).commit, undefined);
});


test("only the project owner records a session, and wrap says so before it commits anything", (t) => {
  const f = fixture(t), before = snapshot(f.checkout);
  const r = f.runWith({ ATELIER_ACTOR: "claude-code/opus-5.5" }, "wrap", "Mine", "--no-check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only the developer records a session/);
  assert.deepEqual(snapshot(f.checkout), before);
  assert.deepEqual(f.requests(), []);
});


// Two branches that change STATE.md differently, so that taking one into the other conflicts.
function diverge(f) {
  const main = f.git("branch", "--show-current");
  f.git("checkout", "-q", "-b", "side");
  writeFileSync(join(f.checkout, "STATE.md"), "side\n");
  f.git("commit", "-qam", "Side");
  f.git("checkout", "-q", main);
  writeFileSync(join(f.checkout, "STATE.md"), "main\n");
  f.git("commit", "-qam", "Main");
}

// A git command that is meant to stop on a conflict.
const conflict = (f, ...args) => assert.equal(spawnSync("git", args, { cwd: f.checkout, encoding: "utf8" }).status, 1, `git ${args.join(" ")} should conflict`);

const unmerged = (f) => f.git("ls-files", "-u");

const marked = (f, name) => existsSync(join(f.checkout, ".git", name));

// Each way a checkout can be left unfinished, with what wrap says about it.
const unfinished = {
  "a detached HEAD": { say: /detached HEAD/, make: (f) => f.git("checkout", "-q", "--detach") },
  "MERGE_HEAD": { say: /a merge in progress/, make: (f) => writeFileSync(join(f.checkout, ".git", "MERGE_HEAD"), f.head + "\n") },
  "CHERRY_PICK_HEAD": { say: /a cherry-pick in progress/, make: (f) => writeFileSync(join(f.checkout, ".git", "CHERRY_PICK_HEAD"), f.head + "\n") },
  "REVERT_HEAD": { say: /a revert in progress/, make: (f) => writeFileSync(join(f.checkout, ".git", "REVERT_HEAD"), f.head + "\n") },
  "rebase-merge": { say: /a rebase in progress/, make: (f) => mkdirSync(join(f.checkout, ".git", "rebase-merge")) },
  "rebase-apply": { say: /a rebase in progress/, make: (f) => mkdirSync(join(f.checkout, ".git", "rebase-apply")) },
  // The journal lives under the cache, keyed by the checkout's Git directory, not in it.
  "a landing journal": { say: /a landing in progress/, make: (f) => { const file = landingJournalFile(landingDir(join(f.dir, "cache"), join(f.checkout, ".git"))); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "{}\n"); } },
  // A landing interrupted under an earlier CLI left its journal in the Git directory. Wrap names it
  // and, like every refusal here, changes nothing: the next merge moves it (cli/landing.mjs).
  "a landing journal an earlier CLI left in the Git directory": { say: /a landing in progress/, make: (f) => writeFileSync(oldLandingJournalFile(join(f.checkout, ".git")), "{}\n") },
  "a cherry-pick stopped on a conflict": {
    say: /a cherry-pick in progress/,
    make: (f) => { diverge(f); conflict(f, "cherry-pick", "side"); assert.ok(marked(f, "CHERRY_PICK_HEAD") && unmerged(f)); },
  },
  "a cherry-pick whose conflict was resolved but not finished": {
    say: /a cherry-pick in progress/,
    make: (f) => { diverge(f); conflict(f, "cherry-pick", "side"); writeFileSync(join(f.checkout, "STATE.md"), "resolved\n"); f.git("add", "STATE.md"); assert.ok(marked(f, "CHERRY_PICK_HEAD") && !unmerged(f)); },
  },
  "a revert stopped on a conflict": {
    say: /a revert in progress/,
    make: (f) => { diverge(f); conflict(f, "revert", "--no-edit", "HEAD~1"); assert.ok(marked(f, "REVERT_HEAD") && unmerged(f)); },
  },
  "a revert whose conflict was resolved but not finished": {
    say: /a revert in progress/,
    make: (f) => { diverge(f); conflict(f, "revert", "--no-edit", "HEAD~1"); writeFileSync(join(f.checkout, "STATE.md"), "resolved\n"); f.git("add", "STATE.md"); assert.ok(marked(f, "REVERT_HEAD") && !unmerged(f)); },
  },
  // These two leave conflicts in the index and no file in the Git directory to say so.
  "a squash merge stopped on a conflict": {
    say: /unmerged files: STATE\.md/,
    make: (f) => { diverge(f); conflict(f, "merge", "--squash", "side"); assert.ok(!marked(f, "MERGE_HEAD") && unmerged(f)); },
  },
  // Resolved with git add and the markers left in: no marker file, no unmerged entry.
  "a stash pop whose conflict was added with its markers": {
    say: /will not commit conflict markers: STATE\.md/,
    make: (f) => {
      writeFileSync(join(f.checkout, "STATE.md"), "stashed\n");
      f.git("stash", "-q");
      writeFileSync(join(f.checkout, "STATE.md"), "committed\n");
      f.git("commit", "-qam", "Committed");
      conflict(f, "stash", "pop");
      f.git("add", "STATE.md");
      assert.ok(!marked(f, "MERGE_HEAD") && !unmerged(f));
    },
  },
  "a new file named like an option, holding conflict markers": {
    say: /will not commit conflict markers: --new\.txt/,
    make: (f) => { writeFileSync(join(f.checkout, "--new.txt"), "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n"); },
  },
  "a new file named -, holding conflict markers": {
    say: /will not commit conflict markers: -(\.|;)/,
    make: (f) => { writeFileSync(join(f.checkout, "-"), "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n"); },
  },
  "a file marked -diff whose conflict was added with its markers": {
    say: /will not commit conflict markers: notes\.txt/,
    make: (f) => {
      writeFileSync(join(f.checkout, ".gitattributes"), "*.txt -diff\n");
      writeFileSync(join(f.checkout, "notes.txt"), "base\n");
      f.git("add", ".gitattributes", "notes.txt");
      f.git("commit", "-qm", "Notes");
      writeFileSync(join(f.checkout, "notes.txt"), "base\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n");
      f.git("add", "notes.txt");
      assert.ok(!unmerged(f));
    },
  },
  "a cherry-pick sequence paused with nothing else to show it": {
    say: /a cherry-pick or revert sequence/,
    make: (f) => { mkdirSync(join(f.checkout, ".git", "sequencer"), { recursive: true }); writeFileSync(join(f.checkout, ".git", "sequencer", "todo"), "pick 0000000 next\n"); },
  },
  "a new file holding conflict markers": {
    say: /will not commit conflict markers: copied\.md/,
    make: (f) => { writeFileSync(join(f.checkout, "copied.md"), "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n"); },
  },
  "a stash pop stopped on a conflict": {
    say: /unmerged files: STATE\.md/,
    make: (f) => {
      writeFileSync(join(f.checkout, "STATE.md"), "stashed\n");
      f.git("stash", "-q");
      writeFileSync(join(f.checkout, "STATE.md"), "committed\n");
      f.git("commit", "-qam", "Committed");
      conflict(f, "stash", "pop");
      assert.ok(!marked(f, "MERGE_HEAD") && unmerged(f));
    },
  },
};

function refuses(f, say) {
  // Leave STATE.md stat-dirty, as iCloud or an editor does: a git call that
  // refreshes the index would rewrite it, and a refusal must not.
  const old = new Date(Date.now() - 60_000);
  if (existsSync(join(f.checkout, "STATE.md"))) utimesSync(join(f.checkout, "STATE.md"), old, old);
  const before = snapshot(f.checkout), head = f.git("rev-parse", "HEAD");
  // The registered check passes, so the refusal under test is the only one.
  const r = f.runWith({ FAKE_CHECKS: JSON.stringify(["true"]) }, "wrap", "Refuse");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, say);
  assert.deepEqual(snapshot(f.checkout), before, "no file, and not the index, changed");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.deepEqual(f.requests().filter((q) => q.method !== "GET"), [], "no note, no baseline update");
}

for (const [state, { say, make }] of Object.entries(unfinished)) {
  test(`wrap refuses ${state} on a tree with nothing else in it`, (t) => {
    if (/conflict markers/.test(say.source) && !canInspectSlots(t)) return;
    const f = fixture(t);
    f.clean();
    make(f);
    refuses(f, say);
  });
}

test("a refusal stages nothing of the changes waiting beside it", (t) => {
  for (const state of ["a detached HEAD", "MERGE_HEAD", "a squash merge stopped on a conflict"]) {
    const f = fixture(t);
    f.clean();
    unfinished[state].make(f);
    writeFileSync(join(f.checkout, "pending.txt"), "waiting\n");
    refuses(f, unfinished[state].say);
    assert.ok(!f.git("diff", "--cached", "--name-only").includes("pending.txt"), `${state}: pending.txt was staged`);
  }
});
