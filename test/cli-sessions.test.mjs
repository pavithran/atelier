import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

import { buildHistory, savePairs, loadPairs } from "../cli/fresh.mjs";

const cli = resolve("cli/atelier.mjs");
function fixture(t) {
  mkdirSync(resolve(".cache"), { recursive: true });
  const dir = mkdtempSync(resolve(".cache/session-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(checkout, "STATE.md"), "Current state\n");
  git("add", ".");
  git("commit", "-qm", "Initial");
  const head = git("rev-parse", "HEAD");
  const baseline = join(dir, "baseline.git");
  git("clone", "--bare", checkout, baseline);
  writeFileSync(join(checkout, "loose.txt"), "uncommitted\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", projects: { demo: { path: checkout, branch: git("branch", "--show-current") } } }));
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  appendFileSync(${JSON.stringify(join(dir, "git.jsonl"))}, JSON.stringify(args) + "\\n");
  if (command === "git" && args.some((arg) => arg === "--force" || arg === "--force-with-lease" || arg.startsWith("+"))) throw Error("force push forbidden");
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
const previous = { actor: "owner", at: "2026-10-04T12:00:00Z", data: { summary: "Previous", next: "Continue", head: ${JSON.stringify(head)}, dirty: false, checks: [], checksSkipped: false } };
let taskCount = 0;
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  appendFileSync(${JSON.stringify(join(dir, "requests.jsonl"))}, JSON.stringify({ method: options.method, path, body: options.body }) + "\\n");
  let result;
  if (options.method === "POST") {
    if (path.endsWith("/baseline-token")) result = { token: "fake", remote: ${JSON.stringify(baseline)} };
    else if (path.endsWith("/items")) result = { id: "t" + (++taskCount) };
    else if (path !== "/api/projects/demo/sessions") throw Error("unexpected write");
    else result = { actor: "owner", at: "2026-10-05T12:00:00Z", data: JSON.parse(options.body) };
  } else if (path.endsWith("/standing")) result = { project: { name: "demo", title: "Demo" }, generatedAt: "2026-10-05T12:00:00Z", live: [], waiting: [], queued: [], merged: [], handoffs: [], partial: [], controlPlane: null };
  else if (path.endsWith("/baseline-head")) result = { head: ${JSON.stringify(head)} };
  else if (path.endsWith("/sessions")) result = [previous];
  else if (path === "/api/projects/demo") result = { project: { policy: { checks: JSON.parse(process.env.FAKE_CHECKS ?? '["exit 7"]') } } };
  else throw Error("unexpected route " + path);
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const runWith = (env, ...args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], { cwd: checkout, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "fake", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1", ...env } });
  const run = (...args) => runWith({}, ...args);
  // A command that refuses before any request leaves no log.
  const requests = () => existsSync(join(dir, "requests.jsonl")) ? readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  const clean = () => rmSync(join(checkout, "loose.txt"));
  return { dir, checkout, git, head, baseline, run, runWith, requests, clean };
}
function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? snapshot(join(dir, e.name)) : [[join(dir, e.name), createHash("sha256").update(readFileSync(join(dir, e.name))).digest("hex")]]);
}

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

test("wrap commits with summary, next and trailer, records failed checks and updates baseline", (t) => {
  const f = fixture(t);
  const result = f.run("wrap", "Finished", "--next", "Fix check");
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
  assert.deepEqual(data.checks.map((c) => [c.command, c.passed, c.grade]), [["exit 7", false, "reported"], ["git diff --cached --check", true, "reported"]]);
  assert.match(result.stdout, /Refresh STATE.md/);
  assert.match(result.stdout, /session closed with a failing check/);
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
  assert.match(r.stderr, /only the project owner records a session/);
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
  "a landing journal": { say: /a landing in progress/, make: (f) => writeFileSync(join(f.checkout, ".git", "atelier-landing.json"), "{}\n") },
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
  const before = snapshot(f.checkout), head = f.git("rev-parse", "HEAD");
  const r = f.run("wrap", "Refuse");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, say);
  assert.deepEqual(snapshot(f.checkout), before, "no file, and not the index, changed");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.deepEqual(f.requests().filter((q) => q.method !== "GET"), [], "no note, no baseline update");
}
for (const [state, { say, make }] of Object.entries(unfinished)) {
  test(`wrap refuses ${state} on a tree with nothing else in it`, (t) => {
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

test("wrap asks again whether the checkout is ready once the registered checks have run", (t) => {
  // A registered check can leave work unfinished: the first look at the checkout passed.
  const f = fixture(t);
  f.clean();
  const r = f.runWith({ FAKE_CHECKS: JSON.stringify(['git rev-parse HEAD > "$(git rev-parse --git-path MERGE_HEAD)"']) }, "wrap", "Late", "--next", "x");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /Reported: .*MERGE_HEAD.*: passed/, "the check ran");
  assert.match(r.stderr, /a merge in progress/);
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
  assert.deepEqual(f.requests().filter((q) => q.method !== "GET"), []);
});

const POLICY = "docs/control-plane/context-budget.v1.json";
const policyOf = (ceiling) => JSON.stringify({ schema_version: 1, kind: "control-plane.context-budget", advisory: true, drift_multiple: 3, surfaces: [{ path: "STATE.md", baseline_lines: 1, required: true, ceiling_lines: ceiling }] });
// Commits a policy at HEAD, as a project that keeps one has.
function commitPolicy(f, ceiling) {
  mkdirSync(join(f.checkout, "docs/control-plane"), { recursive: true });
  writeFileSync(join(f.checkout, POLICY), policyOf(ceiling));
  f.git("add", POLICY);
  f.git("commit", "-qm", "Context policy");
  return f.git("rev-parse", "HEAD");
}
function refused(f, say) {
  const before = snapshot(f.checkout), head = f.git("rev-parse", "HEAD");
  const r = f.run("wrap", "Too large");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /STATE.md: 2 lines, ceiling 1.*docs\/history/);
  if (say) assert.match(r.stdout, say);
  assert.deepEqual(snapshot(f.checkout), before, "nothing was staged or committed");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.deepEqual(f.requests().filter((q) => q.method !== "GET"), []);
}

test("wrap refuses a ceiling before staging or committing", (t) => {
  const f = fixture(t);
  commitPolicy(f, 1);
  writeFileSync(join(f.checkout, "STATE.md"), "One\nTwo\n");
  refused(f);
});

test("a policy edited in the working tree does not lift the ceiling committed at HEAD", (t) => {
  const f = fixture(t);
  commitPolicy(f, 1);
  writeFileSync(join(f.checkout, "STATE.md"), "One\nTwo\n");
  writeFileSync(join(f.checkout, POLICY), policyOf(100));
  refused(f, /context-budget\.v1\.json differs from HEAD.*applies the policy committed at HEAD/);
});

test("a policy deleted in the working tree does not lift the ceiling committed at HEAD", (t) => {
  const f = fixture(t);
  commitPolicy(f, 1);
  writeFileSync(join(f.checkout, "STATE.md"), "One\nTwo\n");
  rmSync(join(f.checkout, POLICY));
  refused(f, /context-budget\.v1\.json is deleted in the working tree.*applies the policy committed at HEAD/);
});

test("a policy that is not committed yet applies from the session after it is", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.checkout, "docs/control-plane"), { recursive: true });
  writeFileSync(join(f.checkout, POLICY), policyOf(1));
  writeFileSync(join(f.checkout, "STATE.md"), "One\nTwo\n");
  const r = f.run("wrap", "Introduce the policy", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is not committed at HEAD, so no ceiling applies until it is/);
  assert.match(f.git("ls-tree", "-r", "--name-only", "HEAD"), /context-budget\.v1\.json/);
  const next = f.run("wrap", "The next session", "--no-check");
  assert.equal(next.status, 1, next.stdout);
  assert.match(next.stdout, /STATE.md: 2 lines, ceiling 1.*docs\/history/);
});

test("wrap asks again about the ceiling once the registered checks have run", (t) => {
  const f = fixture(t);
  commitPolicy(f, 2);
  f.clean();
  const r = f.runWith({ FAKE_CHECKS: JSON.stringify(["printf 'a\\nb\\nc\\n' > STATE.md"]) }, "wrap", "Grew", "--next", "x");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /STATE.md: 3 lines, ceiling 2.*docs\/history/);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
  assert.deepEqual(f.requests().filter((q) => q.method !== "GET"), []);
});

function remote(f, name) {
  const path = join(f.dir, name + ".git");
  f.git("init", "--bare", path);
  f.git("remote", "add", name, path);
  return path;
}
// A pre-push hook that records the remote it was given and what it saw of GIT_LFS_SKIP_PUSH:
// the value, or "unset", as git-lfs's own hook would read it.
function recordPushes(f) {
  const hook = join(f.checkout, ".git", "hooks", "pre-push"), log = join(f.dir, "pushes.log");
  writeFileSync(hook, `#!/bin/sh\necho "$1 \${GIT_LFS_SKIP_PUSH-unset}" >> ${JSON.stringify(log)}\n`);
  chmodSync(hook, 0o755);
  return () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")) : [];
}
test("wrap never pushes checkout remotes without --push and respects ignored files", (t) => {
  const f = fixture(t), path = remote(f, "origin");
  writeFileSync(join(f.checkout, ".gitignore"), "ignored\n");
  writeFileSync(join(f.checkout, "ignored"), "private\n");
  const r = f.run("wrap", "Local", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git("--git-dir", path, "for-each-ref", "refs/heads"), "");
  assert.doesNotMatch(f.git("ls-tree", "-r", "--name-only", "HEAD"), /ignored/);
});
test("wrap pushes each remote, continues after failure, files found tasks and then exits 1", (t) => {
  const f = fixture(t), first = remote(f, "a"), last = remote(f, "z");
  f.git("remote", "add", "broken", join(f.dir, "absent.git"));
  const r = f.run("wrap", "Push", "--push", "--found", "Tool defect", "--found", "Lesson: Keep evidence", "--no-check");
  assert.equal(r.status, 1, "a remote that took no push fails the command");
  assert.match(r.stderr, /the session is recorded, but the push failed for 1 remote: broken/);
  const branch = f.git("branch", "--show-current");
  for (const path of [first, last]) assert.equal(f.git("--git-dir", path, "rev-parse", `refs/heads/${branch}`), f.git("rev-parse", "HEAD"));
  const note = JSON.parse(f.requests().find((r) => r.path.endsWith("/sessions") && r.method === "POST").body);
  assert.deepEqual(note.pushes, [{ remote: "a", passed: true }, { remote: "broken", passed: false }, { remote: "z", passed: true }]);
  assert.deepEqual(note.found, ["t1", "t2"]);
  assert.deepEqual(f.requests().filter((r) => r.path.endsWith("/items")).map((r) => JSON.parse(r.body).title), ["Tool defect", "Lesson: Keep evidence"]);
  // The note and the baseline were recorded before the command failed, and the relay line names the remote.
  assert.equal(f.git("--git-dir", f.baseline, "rev-parse", "HEAD"), f.git("rev-parse", "HEAD"));
  assert.match(r.stdout, /Relay: session closed with a failed push to broken\./);
  assert.match(r.stdout, /Remote broken: failed\./);
});
test("wrap names every failed push in the relay line, beside a failing check", (t) => {
  const f = fixture(t);
  f.git("remote", "add", "gone", join(f.dir, "gone.git"));
  f.git("remote", "add", "missing", join(f.dir, "missing.git"));
  const r = f.run("wrap", "Push", "--push");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Relay: session closed with a failing check and failed pushes to gone, missing\./);
  assert.match(r.stderr, /push failed for 2 remotes: gone, missing/);
});
test("wrap gives the owner's remotes a normal push with LFS uploads, and Atelier's baseline still skips them", (t) => {
  const f = fixture(t);
  remote(f, "origin");
  const seen = recordPushes(f);
  // Even when the caller's environment turns the upload off, a remote that is told "pushed" must hold the LFS objects.
  const r = f.runWith({ GIT_LFS_SKIP_PUSH: "1" }, "wrap", "Push", "--push", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  const pushes = seen();
  assert.deepEqual(pushes.filter(([to]) => to === "origin"), [["origin", "unset"]], "the owner's remote saw no GIT_LFS_SKIP_PUSH");
  const atelier = pushes.filter(([to]) => to === f.baseline);
  assert.ok(atelier.length > 0, "the baseline was pushed to");
  assert.ok(atelier.every(([, skip]) => skip === "1"), "every push to Atelier skips the upload");
});
test("wrap reuses sync for a fresh-history baseline", (t) => {
  const f = fixture(t), branch = f.git("branch", "--show-current");
  const runGit = (args, options) => execFileSync("git", args, { cwd: options.cwd, input: options.input, encoding: "utf8" }).trim();
  const built = buildHistory(runGit, f.checkout, f.head, f.head);
  savePairs(join(f.checkout, ".git"), "demo", built.pairs);
  const fresh = join(f.dir, "fresh.git");
  f.git("init", "--bare", fresh);
  f.git("push", fresh, `${built.head}:refs/heads/${branch}`);
  // The fake server returns the baseline path from the fixture.
  rmSync(f.baseline, { recursive: true });
  f.git("clone", "--bare", fresh, f.baseline);
  writeFileSync(join(f.dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", projects: { demo: { path: f.checkout, branch, fresh: true } } }));
  const r = f.run("wrap", "Carry", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /carried 1 commit/);
  const base = f.git("--git-dir", f.baseline, "rev-parse", `refs/heads/${branch}`);
  assert.equal(loadPairs(join(f.checkout, ".git"), "demo")[base], f.git("rev-parse", "HEAD"));
  assert.equal(f.git("rev-parse", `${base}^{tree}`), f.git("rev-parse", "HEAD^{tree}"));
});
test("wrap cannot force a divergent remote even when its push refspec requests force", (t) => {
  const f = fixture(t), path = remote(f, "origin"), branch = f.git("branch", "--show-current");
  f.git("push", "origin", branch);
  const tree = f.git("rev-parse", "HEAD^{tree}");
  const ahead = f.git("commit-tree", tree, "-p", f.head, "-m", "Remote work");
  f.git("push", "origin", `${ahead}:refs/heads/${branch}`);
  f.git("config", "remote.origin.push", `+refs/heads/${branch}:refs/heads/${branch}`);
  const r = f.run("wrap", "Local work", "--push", "--no-check");
  assert.equal(r.status, 1, "a remote that refused the push fails the command");
  assert.match(r.stdout, /Remote origin: failed/);
  assert.equal(f.git("--git-dir", path, "rev-parse", `refs/heads/${branch}`), ahead);
});
