import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { reuseDecision } from "../cli/landing.mjs";

// t520 review finding: a merge that regenerated declared outputs before its
// checks holds a tree the builder never checked, so the builder's passing
// checks are not reused for it, even when main moved only other paths.

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
function world(t, message) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-reuse-regen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => { const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const put = (path, text) => writeFileSync(join(dir, path), text);
  git("init", "-q", "-b", "main");
  put("src.txt", "one\n"); put("src2.txt", "two\n"); git("add", "."); git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "task"); put("src.txt", "task\n"); git("commit", "-qam", "task");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main"); put("src2.txt", "main\n"); git("commit", "-qam", "main moves another path");
  git("merge", "-q", "--no-ff", "-m", message, head);
  return { dir, base, head, merge: git("rev-parse", "HEAD") };
}
const command = "npm test";
const policy = { checks: [command], protected: [] };
const evidenceFor = (w) => [{ id: 1, itemId: "t1", claim: command, grade: "observed", head: w.head, passed: true, by: "codex/gpt-6", at: "2026-11-07T10:01:00.000Z", changedPaths: ["src.txt"],
  reuse: { project: "p", task: "t1", head: w.head, base: w.base, mainHead: null, mode: "ordinary", where: "runner", command, preparation: "none" } }];

test("a plain merge onto disjoint paths reuses the builder's checks", (t) => {
  const w = world(t, "Merge t1: plain");
  const v = reuseDecision({ cwd: w.dir, policy, evidence: evidenceFor(w), head: w.head, mergeCommit: w.merge });
  assert.equal(v.reuse, true, v.why);
});

test("a merge that regenerated declared outputs does not reuse the builder's checks", (t) => {
  const w = world(t, "Merge t1: regenerated\n\nAtelier-Regenerated: index (node gen.js): out/index.txt matches the merged sources; log sha256 " + "0".repeat(64));
  const v = reuseDecision({ cwd: w.dir, policy, evidence: evidenceFor(w), head: w.head, mergeCommit: w.merge });
  assert.equal(v.reuse, false);
  assert.match(v.why, /regenerated/);
});
