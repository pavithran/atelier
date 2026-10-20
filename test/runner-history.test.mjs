import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withHistory } from "../cli/runner.mjs";

// t14: the runner adds the server's past findings to an ordinary task's
// brief, keeping the files that exist at the commit the build starts from.
// It goes through real git, as the runner does. The finding it would have
// caught: a build that starts before any push has no head the server knows,
// so only the runner can say which recorded files are still there.

const git = (cwd) => async (args, options = {}) => {
  const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return options.raw ? out : out.trim();
};
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: dir, encoding: "utf8" });
  run("init", "-q");
  mkdirSync(join(dir, "src"));
  for (const f of ["src/kept.ts", "src/odd name.ts", "src/gone.ts", "src/Case.ts"]) writeFileSync(join(dir, f), "x\n");
  run("add", "-A"); run("commit", "-qm", "one");
  const first = run("rev-parse", "HEAD").trim();
  run("rm", "-q", "src/gone.ts"); run("commit", "-qm", "delete");
  const second = run("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "src/gone.ts"), "again\n"); run("add", "-A"); run("commit", "-qm", "recreate");
  return { dir, first, second, third: run("rev-parse", "HEAD").trim() };
}
const entry = (n, file, over = {}) => ({ task: `t${n}`, file, line: n, verdict: "confirmed", text: `finding ${n}`, ...over });
const logs = [];
const log = (m) => logs.push(m);

test("keeps recorded files that exist at the starting head and appends the section after the text", async () => {
  const r = repo();
  try {
    const history = { entries: [entry(1, "src/kept.ts"), entry(2, "src/missing.ts"), entry(3, "src/odd name.ts"), entry(4, "src/case.ts"), entry(5, "src/gone.ts")] };
    // At the second commit src/gone.ts is deleted; at the third it is recreated.
    const atSecond = await withHistory({ git: git(r.dir), log }, { text: "Review findings: fix it.", history }, r.second);
    assert.match(atSecond.text, /^Review findings: fix it\.\n\n## History: past findings on these files/);
    assert.match(atSecond.text, /1\. t1 src\/kept\.ts:1, confirmed/);
    assert.match(atSecond.text, /2\. t3 src\/odd name\.ts:3, confirmed/);
    assert.doesNotMatch(atSecond.text, /missing|case\.ts|gone/);
    const atThird = await withHistory({ git: git(r.dir), log }, { text: "", history }, r.third);
    assert.match(atThird.text, /t5 src\/gone\.ts:5/);
    assert.match(atThird.text, /^## History/);
    assert.match(atSecond.historyHash, /^[0-9a-f]{64}$/);
    assert.notEqual(atSecond.historyHash, atThird.historyHash);
    assert.match(logs.at(-1), /^history of past findings: 3 of 3 shown, hash [0-9a-f]{16}$/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a pathspec in a recorded name is a file name, not a pattern", async () => {
  const r = repo();
  try {
    const out = await withHistory({ git: git(r.dir), log }, { text: "t", history: { entries: [entry(1, "src/*.ts"), entry(2, ":(glob)src/**")] } }, r.third);
    assert.match(out.text, /None:/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("no head, an unreadable tree and an unreadable server history each say unavailable", async () => {
  const r = repo();
  try {
    const history = { entries: [entry(1, "src/kept.ts")] };
    const noHead = await withHistory({ git: git(r.dir), log }, { text: "t", history }, null);
    assert.match(noHead.text, /unavailable/);
    assert.doesNotMatch(noHead.text, /None:/);
    const lines = [];
    const badTree = await withHistory({ git: git(r.dir), log: (m) => lines.push(m) }, { text: "t", history }, "f".repeat(40));
    assert.match(badTree.text, /unavailable/);
    assert.doesNotMatch(badTree.text, /None:/);
    assert.match(lines[0], /could not be read/);
    for (const bad of [{ unavailable: true }, { entries: "no" }, {}]) {
      const out = await withHistory({ git: async () => assert.fail("git is not asked"), log }, { text: "t", history: bad }, r.third);
      assert.match(out.text, /unavailable/);
    }
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a server that sends no history, or no brief at all, changes nothing", async () => {
  const context = { text: "Build the scoped change", hash: "h" };
  assert.equal(await withHistory({ git: async () => assert.fail("no git"), log }, context, "a".repeat(40)), context);
  assert.equal(await withHistory({ git: async () => assert.fail("no git"), log }, null, "a".repeat(40)), null);
});
