import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHistory, carryTask, loadPairs, parseCommit, rebuild, savePairs, syncHistory } from "../cli/fresh.mjs";

// The CLI's git helper, as cli/fresh.mjs expects it.
function git(args, opts = {}) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd: opts.cwd, env: { ...process.env, ...opts.env }, input: opts.input });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return opts.raw ? r.stdout : r.stdout.trim();
}

// A repository whose main line runs over three days and includes a merge.
function project() {
  const dir = mkdtempSync(join(tmpdir(), "atelier-fresh-"));
  const at = (day) => ({ GIT_AUTHOR_DATE: `2026-09-0${day}T12:00:00+02:00`, GIT_COMMITTER_DATE: `2026-09-0${day}T12:00:00+02:00` });
  const commit = (day, file, text, message, extra = {}) => {
    writeFileSync(join(dir, file), text);
    git(["add", file], { cwd: dir });
    git(["commit", "-q", "-m", message], { cwd: dir, env: { ...at(day), ...extra } });
  };
  git(["init", "-q", "-b", "main"], { cwd: dir });
  git(["config", "user.name", "Owner"], { cwd: dir });
  git(["config", "user.email", "owner@example.com"], { cwd: dir });
  commit(1, "a.txt", "one\n", "First day");
  commit(2, "a.txt", "two\n", "Second day\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>", { GIT_AUTHOR_NAME: "Agent", GIT_AUTHOR_EMAIL: "agent@example.com" });
  git(["checkout", "-q", "-b", "side"], { cwd: dir });
  commit(3, "b.txt", "side\n", "Side work");
  git(["checkout", "-q", "main"], { cwd: dir });
  commit(3, "c.txt", "main\n", "Main work");
  git(["merge", "-q", "--no-ff", "-m", "Merge side", "side"], { cwd: dir, env: at(4) });
  return dir;
}

test("a commit is parsed and rebuilt with the same tree, authors, dates and message", () => {
  const dir = project();
  try {
    const head = git(["rev-parse", "HEAD~1"], { cwd: dir });
    const original = parseCommit(git(["cat-file", "commit", head], { cwd: dir, raw: true }));
    const again = rebuild(git, dir, head, [git(["rev-parse", "HEAD~2"], { cwd: dir })]);
    assert.equal(again, head, "the same parents give the same commit");
    const moved = rebuild(git, dir, head, []);
    const copy = parseCommit(git(["cat-file", "commit", moved], { cwd: dir, raw: true }));
    assert.deepEqual({ ...copy }, { ...original });
    assert.equal(rebuild(git, dir, head, []), moved, "a rebuild repeated gives the same commit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the baseline history starts at the chosen commit and follows the first-parent line", () => {
  const dir = project();
  try {
    const head = git(["rev-parse", "HEAD"], { cwd: dir });
    const start = git(["rev-list", "-1", "--first-parent", "--before=2026-09-02T00:00:00", "HEAD"], { cwd: dir });
    const built = buildHistory(git, dir, start, head);
    assert.equal(git(["rev-parse", `${built.head}^{tree}`], { cwd: dir }), git(["rev-parse", "HEAD^{tree}"], { cwd: dir }));
    const line = git(["rev-list", "--reverse", built.head], { cwd: dir }).split("\n");
    assert.equal(line.length, 4, "the root, the second day, main work and the merge; the side branch's commit is not on the line");
    assert.match(git(["log", "-1", "--format=%B", line[0]], { cwd: dir }), /^Atelier baseline: history from 2026-09-01/);
    assert.match(git(["log", "-1", "--format=%B", line[0]], { cwd: dir }), /^Atelier-Fresh-History: [0-9a-f]{40}$/m);
    assert.equal(git(["log", "-1", "--format=%an %aI", line[1]], { cwd: dir }), "Agent 2026-09-02T12:00:00+02:00");
    assert.match(git(["log", "-1", "--format=%B", line[1]], { cwd: dir }), /Co-Authored-By: Claude Opus 4\.7/);
    assert.equal(git(["rev-list", "--count", `${line[3]}^@`], { cwd: dir }), "3", "the rebuilt merge has one parent");
    assert.equal(built.pairs[built.head], head);
    assert.equal(Object.keys(built.pairs).length, 4);
    assert.deepEqual(buildHistory(git, dir, start, head), built, "building again gives the same history");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a task is carried onto the paired project commit with the agent's exact trees", () => {
  const dir = project();
  try {
    const head = git(["rev-parse", "HEAD"], { cwd: dir });
    const start = git(["rev-parse", "HEAD~2"], { cwd: dir });
    const built = buildHistory(git, dir, start, head);
    // The agent's work in its fork: two commits on the baseline's head.
    git(["checkout", "-q", "--detach", built.head], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "task\n");
    git(["commit", "-q", "-am", "Task one"], { cwd: dir });
    writeFileSync(join(dir, "d.txt"), "new\n");
    git(["add", "d.txt"], { cwd: dir });
    git(["commit", "-q", "-m", "Task two"], { cwd: dir });
    const task = git(["rev-parse", "HEAD"], { cwd: dir });
    git(["checkout", "-q", "main"], { cwd: dir });
    const twin = carryTask(git, dir, built.head, task, built.pairs);
    assert.equal(git(["rev-parse", `${twin}^{tree}`], { cwd: dir }), git(["rev-parse", `${task}^{tree}`], { cwd: dir }));
    assert.equal(git(["rev-parse", `${twin}~2`], { cwd: dir }), head, "the twin sits on the project's own head");
    assert.equal(git(["log", "-1", "--format=%s", `${twin}~1`], { cwd: dir }), "Task one");
    assert.equal(carryTask(git, dir, built.head, task, built.pairs), twin, "carrying again gives the same commits");
    assert.throws(() => carryTask(git, dir, built.head, task, {}), /no pair for/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("commits made in the checkout are synced onto the baseline; a line that does not continue is refused", () => {
  const dir = project();
  try {
    const start = git(["rev-parse", "HEAD~2"], { cwd: dir });
    const paired = git(["rev-parse", "HEAD"], { cwd: dir });
    const built = buildHistory(git, dir, start, paired);
    writeFileSync(join(dir, "e.txt"), "direct\n");
    git(["add", "e.txt"], { cwd: dir });
    git(["commit", "-q", "-m", "Direct commit"], { cwd: dir });
    const head = git(["rev-parse", "HEAD"], { cwd: dir });
    const synced = syncHistory(git, dir, built.head, paired, head);
    assert.equal(git(["rev-parse", `${synced.head}^{tree}`], { cwd: dir }), git(["rev-parse", "HEAD^{tree}"], { cwd: dir }));
    assert.equal(git(["rev-parse", `${synced.head}^`], { cwd: dir }), built.head);
    assert.deepEqual(synced.pairs, { [synced.head]: head });
    // The side branch's commit is not on main's first-parent line from the merge.
    const side = git(["rev-parse", "side"], { cwd: dir });
    assert.throws(() => syncHistory(git, dir, built.head, side, head), /does not continue from it/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pairs are kept per project in the git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-pairs-"));
  try {
    assert.deepEqual(loadPairs(dir, "a"), {});
    savePairs(dir, "a", { x: "y" });
    savePairs(dir, "b", { p: "q" });
    assert.deepEqual(loadPairs(dir, "a"), { x: "y" });
    assert.deepEqual(loadPairs(dir, "b"), { p: "q" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
