import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runRevert } from "../cli/revert.mjs";
import { itemFields } from "../src/rules.ts";

function fixture(t) {
  const dir = mkdtempSync(join(process.cwd(), ".revert-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args, options = {}) => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    if (options.allowFail) return r;
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  writeFileSync(join(dir, "change"), "before\n");
  git(["add", "."]); git(["commit", "-m", "base"]);
  git(["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "change"), "after\n");
  git(["commit", "-am", "feature"]);
  git(["checkout", "main"]);
  git(["merge", "--no-ff", "feature", "-m", "merge"]);
  const mergeCommit = git(["rev-parse", "HEAD"]);
  const io = {
    create: async (body) => {
      assert.deepEqual(body, { revertOf: "t1" });
      return { id: "t2", revert: { itemId: "t1", mergeCommit } };
    },
    claim: async (id, as) => { assert.equal(id, "t2"); assert.equal(as, "codex/test"); return { dir }; },
    git: (args, opts) => { assert.equal(opts.cwd, dir); return git(args, opts); },
    say: () => {},
  };
  return { dir, git, io, mergeCommit };
}

test("revert commits the first-parent inverse while retaining later unrelated work", async (t) => {
  const { dir, git, io, mergeCommit } = fixture(t);
  writeFileSync(join(dir, "later"), "keep\n");
  git(["add", "."]); git(["commit", "-m", "later"]);
  await runRevert("t1", "codex/test", io);
  assert.equal(readFileSync(join(dir, "change"), "utf8"), "before\n");
  assert.equal(readFileSync(join(dir, "later"), "utf8"), "keep\n");
  assert.match(git(["log", "-1", "--format=%B"]), /Agent: codex\/test$/);
  assert.equal(git(["merge-base", "--is-ancestor", mergeCommit, "HEAD"]), "");
  assert.equal(git(["status", "--porcelain"]), "");
});

test("a conflicting revert preserves the task workspace and does not commit", async (t) => {
  const { dir, git, io } = fixture(t);
  writeFileSync(join(dir, "change"), "later edit\n");
  git(["commit", "-am", "later"]);
  const before = git(["rev-parse", "HEAD"]);
  await assert.rejects(runRevert("t1", "codex/test", io), /t2 remains claimed.*Resolve the conflicts/s);
  assert.equal(git(["rev-parse", "HEAD"]), before);
  assert.match(git(["status", "--porcelain"]), /UU change/);
});

test("revert refuses invalid ids and unsupported servers before claiming", async () => {
  await assert.rejects(runRevert("--help", "codex/test", {}), /usage:/);
  await assert.rejects(runRevert("t1", "codex/test", { create: async () => ({ id: "t2" }) }), /server did not record/);
  assert.deepEqual(itemFields({ revertOf: "t1", mergeCommit: "forged" }), { revertOf: "t1" });
  assert.throws(() => itemFields({ revertOf: "HEAD" }), /revertOf must name a task/);
});

test("revert refuses a dirty workspace without changing HEAD", async (t) => {
  const { dir, git, io, mergeCommit } = fixture(t);
  writeFileSync(join(dir, "untracked"), "keep");
  await assert.rejects(runRevert("t1", "codex/test", io), /set aside its changes/);
  assert.equal(git(["rev-parse", "HEAD"]), mergeCommit);
  assert.equal(readFileSync(join(dir, "untracked"), "utf8"), "keep");
});

test("a recorded non-merge or merge outside the workspace history is refused", async (t) => {
  const { git, io, mergeCommit } = fixture(t);
  const base = git(["rev-parse", `${mergeCommit}^1`]);
  const create = async () => ({ id: "t2", revert: { itemId: "t1", mergeCommit: base } });
  await assert.rejects(runRevert("t1", "codex/test", { ...io, create }), /not a merge/);
  git(["checkout", "--detach", base]);
  await assert.rejects(runRevert("t1", "codex/test", io), /does not hold the recorded merge/);
  assert.equal(git(["rev-parse", "HEAD"]), base);
});
