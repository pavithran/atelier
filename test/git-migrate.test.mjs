import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { carryBranch } from "../src/git/move.mjs";

const root = mkdtempSync(join(tmpdir(), "atelier-migrate-"));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };
const git = (dir, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture() {
  const dir = mkdtempSync(join(root, "case-"));
  const remote = join(dir, "fork"), into = join(dir, "into.git");
  git(dir, "init", "-q", "-b", "seed", remote);
  git(remote, "commit", "-q", "--allow-empty", "-m", "base");
  const base = git(remote, "rev-parse", "HEAD");
  git(remote, "commit", "-q", "--allow-empty", "-m", "task work");
  const head = git(remote, "rev-parse", "HEAD");
  git(dir, "init", "-q", "--bare", "-b", "main", into);
  const carry = (extra = {}) => carryBranch({ dir: into, branch: "t/2", defaultRef: "refs/heads/main", remote, head, ...extra });
  const absent = () => {
    assert.throws(() => git(into, "rev-parse", "--verify", "refs/heads/t/2"));
    assert.equal(git(into, "for-each-ref", "--format=%(refname)", "refs/atelier-move"), "");
  };
  return { remote, into, base, head, carry, absent };
}

test("migrate defaults to the fork's HEAD branch and carries only the recorded head", async () => {
  const f = fixture();
  git(f.remote, "commit", "-q", "--allow-empty", "-m", "later work");
  const tip = git(f.remote, "rev-parse", "HEAD");
  const result = await f.carry();
  assert.deepEqual(result, { head: f.head, tip, sourceRef: "refs/heads/seed", carried: true });
  assert.equal(git(f.into, "rev-parse", "refs/heads/t/2"), f.head);
  assert.equal(git(f.into, "for-each-ref", "--format=%(refname)", "refs/atelier-move"), "");
  assert.deepEqual(await f.carry(), { head: f.head, tip: null, carried: false });
});

test("migrate keeps the default branch when it exists", async () => {
  const f = fixture();
  git(f.remote, "branch", "main", f.head);
  git(f.remote, "reset", "--hard", f.base);
  assert.equal((await f.carry()).sourceRef, "refs/heads/main");
});

test("migrate refuses a HEAD branch without the recorded head and lists all branches", async () => {
  const f = fixture();
  git(f.remote, "branch", "other", f.head);
  git(f.remote, "reset", "--hard", f.base);
  const result = await f.carry();
  assert.equal(result.error, "head_missing");
  assert.match(result.detail, /refs\/heads\/seed.*does not hold the recorded head/);
  assert.match(result.detail, /remote branches: other, seed/);
  f.absent();
  assert.equal((await f.carry({ ref: "refs/heads/other" })).sourceRef, "refs/heads/other");
});

test("migrate does not replace an explicit ref with HEAD", async () => {
  const f = fixture();
  git(f.remote, "branch", "old", f.base);
  const result = await f.carry({ ref: "refs/heads/old" });
  assert.equal(result.error, "head_missing");
  assert.match(result.detail, /remote branches: old, seed/);
  f.absent();
  assert.equal((await f.carry({ ref: "refs/heads/seed" })).sourceRef, "refs/heads/seed");
});

test("migrate refuses a missing explicit branch and names available branches", async () => {
  const f = fixture();
  const result = await f.carry({ ref: "refs/heads/missing" });
  assert.equal(result.error, "head_missing");
  assert.match(result.detail, /remote branches: seed/);
  f.absent();
});

test("migrate refuses when HEAD names an absent branch", async () => {
  const f = fixture();
  git(f.remote, "symbolic-ref", "HEAD", "refs/heads/missing");
  const result = await f.carry();
  assert.equal(result.error, "head_missing");
  assert.match(result.detail, /remote branches: seed/);
  f.absent();
});

test("migrate refuses an existing default branch without the recorded head", async () => {
  const f = fixture();
  git(f.remote, "branch", "main", f.base);
  const result = await f.carry();
  assert.equal(result.error, "head_missing");
  assert.match(result.detail, /refs\/heads\/main.*remote branches: main, seed/);
  f.absent();
});
