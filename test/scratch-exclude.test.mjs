import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excludeScratch } from "../cli/scratch.mjs";

test("a workspace's .scratch/ stays out of Git once excluded, so a committed workspace reads as clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-scratch-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git("add", ".");
    git("-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "a");
    mkdirSync(join(dir, ".scratch"));
    writeFileSync(join(dir, ".scratch", "notes.md"), "an agent's notes\n");
    assert.match(git("status", "--porcelain"), /\.scratch\//);
    excludeScratch(dir);
    excludeScratch(dir);
    assert.equal(git("status", "--porcelain"), "");
    const lines = readFileSync(join(dir, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === ".scratch/");
    assert.equal(lines.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the runner excludes .scratch/ after every workspace reset", () => {
  const source = readFileSync(new URL("../cli/runner.mjs", import.meta.url), "utf8");
  assert.match(source, /reset: async \(cwd\) => \{ await resetTo\(cwd, "HEAD"\); excludeScratch\(cwd\); \}/);
});

test("atelier land excludes .scratch/ before it judges the workspace clean", () => {
  const source = readFileSync(new URL("../cli/land.mjs", import.meta.url), "utf8");
  assert.match(source, /excludeScratch\(dir\);\n\s+if \(git\(\["status", "--porcelain"\]/);
});

test("in a git worktree, whose .git is a file, .scratch/ is excluded through the repository's own exclude file", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-scratch-wt-"));
  try {
    const main = join(dir, "main"), tree = join(dir, "tree");
    mkdirSync(main);
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "a.txt"), "a\n");
    git(main, "add", ".");
    git(main, "-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "a");
    git(main, "worktree", "add", "-q", tree);
    mkdirSync(join(tree, ".scratch"));
    writeFileSync(join(tree, ".scratch", "notes.md"), "notes\n");
    excludeScratch(tree);
    assert.equal(git(tree, "status", "--porcelain"), "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
