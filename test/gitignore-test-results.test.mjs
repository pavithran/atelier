import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("a Playwright run's test-results/ output leaves a clone clean", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-gitignore-"));
  try {
    const clone = join(root, "clone");
    execFileSync("git", ["clone", "--quiet", "--local", "--no-checkout", repo, clone]);
    execFileSync("git", ["checkout", "--quiet", "HEAD"], { cwd: clone });
    copyFileSync(join(repo, ".gitignore"), join(clone, ".gitignore"));
    mkdirSync(join(clone, "test-results"));
    writeFileSync(join(clone, "test-results", ".last-run.json"), '{"status":"passed"}\n');
    const status = execFileSync("git", ["status", "--porcelain=v1", "-uall", "--", "test-results"], {
      cwd: clone,
      encoding: "utf8",
    });
    assert.equal(status, "");
    execFileSync("git", ["check-ignore", "-q", "test-results/.last-run.json"], { cwd: clone });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(".gitignore lists test-results/ under Rebuildable dependencies and outputs", () => {
  const lines = readFileSync(join(repo, ".gitignore"), "utf8").split("\n");
  const start = lines.indexOf("# Rebuildable dependencies and outputs");
  assert.ok(start >= 0);
  const end = lines.findIndex((l, i) => i > start && l.trim() === "");
  assert.ok(lines.slice(start, end < 0 ? undefined : end).includes("test-results/"));
});
