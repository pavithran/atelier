// Part 2 of 2 of the tests that were in cli-sessions.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHistory, savePairs, loadPairs } from "../cli/fresh.mjs";
import { fixture, snapshot, remote, cli } from "./cli-sessions-shared.mjs";


test("wrap asks again whether the checkout is ready once the registered checks have run", (t) => {
  if (!canInspectSlots(t)) return;
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
  if (!canInspectSlots(t)) return;
  const f = fixture(t);
  commitPolicy(f, 2);
  f.clean();
  const r = f.runWith({ FAKE_CHECKS: JSON.stringify(["printf 'a\\nb\\nc\\n' > STATE.md"]) }, "wrap", "Grew", "--next", "x");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /STATE.md: 3 lines, ceiling 2.*docs\/history/);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
  assert.deepEqual(f.requests().filter((q) => q.method !== "GET"), []);
});

// A pre-push hook that records the remote it was given and what it saw of GIT_LFS_SKIP_PUSH:
// the value, or "unset", as git-lfs's own hook would read it.
function recordPushes(f) {
  const hook = join(f.checkout, ".git", "hooks", "pre-push"), log = join(f.dir, "pushes.log");
  // A tab separates the fields: a remote's path may hold spaces.
  writeFileSync(hook, `#!/bin/sh\nprintf '%s\\t%s\\n' "$1" "\${GIT_LFS_SKIP_PUSH-unset}" >> ${JSON.stringify(log)}\n`);
  chmodSync(hook, 0o755);
  return () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => l.split("\t")) : [];
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

test("wrap pushes a declared public mirror only the project's no-reply address: an agent address the landing allows is not published there", (t) => {
  const f = fixture(t), path = remote(f, "github"), own = remote(f, "origin");
  const branch = f.git("branch", "--show-current");
  // History the mirror already holds is not read again, whatever it carries.
  f.git("push", "-q", "github", branch);
  f.git("push", "-q", "origin", branch);
  const identity = JSON.stringify({ name: "Owner", email: "123+owner@users.noreply.github.com", agentEmails: ["agents@atelier.example"], publicMirrors: ["github"] });
  // A commit under the project's no-reply address is published.
  f.git("config", "user.email", "123+owner@users.noreply.github.com");
  const pushed = f.runWith({ FAKE_IDENTITY: identity }, "wrap", "Owner", "--push", "--no-check");
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.match(pushed.stdout, /Remote github: pushed\./);
  const published = f.git("rev-parse", "HEAD");
  assert.equal(f.git("--git-dir", path, "rev-parse", `refs/heads/${branch}`), published);
  // One under an agent address the landing allows is not.
  // (wrap pins the checkout's own address to the project's, t755, so an agent's address arrives by the environment.)
  const agent = { GIT_AUTHOR_EMAIL: "agents@atelier.example", GIT_COMMITTER_EMAIL: "agents@atelier.example" };
  writeFileSync(join(f.checkout, "agent.txt"), "agent work\n");
  const refused = f.runWith({ FAKE_IDENTITY: identity, ...agent }, "wrap", "Agent", "--push", "--no-check");
  assert.equal(refused.status, 1, refused.stderr);
  const commit = f.git("rev-parse", "HEAD");
  assert.ok(refused.stdout.includes(`Not pushed to github: commit ${commit.slice(0, 12)}: the author email agents@atelier.example is not the project's public address 123+owner@users.noreply.github.com`), refused.stdout);
  assert.doesNotMatch(refused.stdout, /test@example\.invalid/, "what the mirror already holds is outside the range");
  assert.equal(f.git("--git-dir", path, "rev-parse", `refs/heads/${branch}`), published);
  // A remote the policy does not declare a mirror takes the commit: only declared mirrors are checked.
  assert.match(refused.stdout, /Remote github: failed\./);
  assert.match(refused.stdout, /Remote origin: pushed\./);
  assert.equal(f.git("--git-dir", own, "rev-parse", `refs/heads/${branch}`), commit);
  assert.match(refused.stderr, /the push failed for 1 remote: github/);
});


test("wrap checks no remote as a public mirror when the policy declares none", (t) => {
  const f = fixture(t), path = remote(f, "github");
  const branch = f.git("branch", "--show-current");
  const identity = JSON.stringify({ name: "Owner", email: "123+owner@users.noreply.github.com", agentEmails: ["agents@atelier.example"] });
  f.git("config", "user.email", "agents@atelier.example");
  const r = f.runWith({ FAKE_IDENTITY: identity }, "wrap", "Agent", "--push", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Remote github: pushed\./);
  assert.equal(f.git("--git-dir", path, "rev-parse", `refs/heads/${branch}`), f.git("rev-parse", "HEAD"));
});


test("wrap names every failed push in the relay line, beside an overridden failing check", (t) => {
  const f = fixture(t);
  f.git("remote", "add", "gone", join(f.dir, "gone.git"));
  f.git("remote", "add", "missing", join(f.dir, "missing.git"));
  const r = f.run("wrap", "Push", "--push", "--allow-failing");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Relay: session closed with a failing check overridden by --allow-failing and failed pushes to gone, missing\./);
  assert.match(r.stderr, /push failed for 2 remotes: gone, missing/);
});

test("without the override, a failing check stops wrap before any remote is pushed", (t) => {
  const f = fixture(t), path = remote(f, "origin");
  const r = f.run("wrap", "Push", "--push");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /wrap refuses to commit with a failing check/);
  assert.equal(f.git("--git-dir", path, "for-each-ref", "refs/heads"), "", "origin took no push");
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


test("a line of equals signs alone, as Markdown underlines a heading, is not a conflict marker", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, "guide.md"), "Title\n=======\n\nText.\n");
  const r = f.run("wrap", "Guide", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.git("ls-tree", "-r", "--name-only", "HEAD"), /guide\.md/);
});


test("wrap runs no registered check when one is never read-only, and changes nothing; --no-check still wraps", (t) => {
  const f = fixture(t);
  const ran = join(f.dir, "ran");
  // A push to a remote that does not exist, so that even code without the rule changes nothing.
  const checks = JSON.stringify([`touch '${ran}'`, "git push atelier-test-nowhere HEAD"]);
  const r = f.runWith({ FAKE_CHECKS: checks }, "wrap", "Refuse", "--next", "x");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /`git push atelier-test-nowhere HEAD` is not a check: it pushes \(git push atelier-test-nowhere HEAD\)/);
  assert.match(r.stderr, /wrap runs the registered checks in this checkout, so it stopped before running any\. Replace the check with atelier init --check, or wrap with --no-check\./);
  assert.equal(existsSync(ran), false, "no check ran");
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
  assert.deepEqual(f.requests().filter((q) => q.method !== "GET"), [], "no note, no baseline update");
  const skipped = f.runWith({ FAKE_CHECKS: checks }, "wrap", "Skip", "--next", "x", "--no-check");
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(existsSync(ran), false, "--no-check ran nothing");
});
