import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinMainMerges } from "../cli/workspace-fork.mjs";

// A claim that finds the fork and the workspace diverged joins the fork's
// commits when they only merge main (t264's lander pushed one), and leaves
// any other fork commit for the rebase instruction. Git runs for real.

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-fork-merge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const git = (args, o = {}) => { const r = spawnSync("git", args, { cwd: o.cwd, encoding: "utf8" }); return r; };
  const commit = (cwd, file, subject) => { writeFileSync(join(cwd, file), `${subject}\n`); run(cwd, "add", "."); run(cwd, "commit", "-qm", subject); };
  const main = join(dir, "main"), ws = join(dir, "ws"), lander = join(dir, "lander");
  run(dir, "init", "-q", "-b", "main", main);
  for (const d of [main]) { run(d, "config", "user.name", "T"); run(d, "config", "user.email", "t@example.invalid"); }
  commit(main, "base.txt", "Base");
  run(dir, "clone", "-q", main, ws);
  run(dir, "clone", "-q", main, lander);
  for (const d of [ws, lander]) { run(d, "config", "user.name", "T"); run(d, "config", "user.email", "t@example.invalid"); }
  return { dir, run, git, commit, main, ws, lander };
}

test("a merge of main with other work after it is refused whole", (t) => {
  const f = fixture(t);
  f.commit(f.ws, "work.txt", "Work");
  f.commit(f.main, "moved.txt", "Main moved");
  f.run(f.lander, "fetch", "-q", "origin");
  f.run(f.lander, "merge", "-q", "--no-edit", "origin/main");
  f.commit(f.lander, "lander.txt", "Lander note");
  f.run(f.ws, "remote", "add", "fork", f.lander);
  f.run(f.ws, "fetch", "-q", "fork");
  f.run(f.ws, "fetch", "-q", "origin");
  const before = f.run(f.ws, "rev-parse", "HEAD");
  assert.equal(joinMainMerges(f.git, f.ws, "fork/main", "origin/main"), false);
  assert.equal(f.run(f.ws, "rev-parse", "HEAD"), before);
});

test("a fork holding only a merge of main is joined; other commits are not", (t) => {
  const f = fixture(t);
  f.commit(f.ws, "work.txt", "Work");
  f.commit(f.main, "moved.txt", "Main moved");
  f.run(f.lander, "fetch", "-q", "origin");
  f.run(f.lander, "merge", "-q", "--no-edit", "origin/main");
  f.run(f.ws, "remote", "add", "fork", f.lander);
  f.run(f.ws, "fetch", "-q", "fork");
  f.run(f.ws, "fetch", "-q", "origin");
  const before = f.run(f.ws, "rev-parse", "HEAD");
  assert.equal(joinMainMerges(f.git, f.ws, "fork/main", "origin/main"), true);
  assert.notEqual(f.run(f.ws, "rev-parse", "HEAD"), before);
  assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", "fork/main", "HEAD"], { cwd: f.ws }).status, 0);
  assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", before, "HEAD"], { cwd: f.ws }).status, 0);
});

test("a fork commit of other work is refused and the workspace is untouched", (t) => {
  const f = fixture(t);
  f.commit(f.ws, "work.txt", "Work");
  f.commit(f.lander, "other.txt", "Someone else's work");
  f.run(f.ws, "remote", "add", "fork", f.lander);
  f.run(f.ws, "fetch", "-q", "fork");
  f.run(f.ws, "fetch", "-q", "origin");
  const before = f.run(f.ws, "rev-parse", "HEAD");
  assert.equal(joinMainMerges(f.git, f.ws, "fork/main", "origin/main"), false);
  assert.equal(f.run(f.ws, "rev-parse", "HEAD"), before);
});
