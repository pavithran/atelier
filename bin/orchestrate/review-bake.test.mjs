import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReviews, parseReview, renderMarkdown, scoreRun } from "./review-bake-score.mjs";

// t699: review-bake.sh gives every reviewer the same blind brief and diff of
// each judged build and collects the replies; review-bake-score.mjs compares
// them with the judge's ground truth. The scorer is tested on made-up replies,
// the script against stand-ins for the reviewers' CLIs.

const here = fileURLToPath(new URL(".", import.meta.url));
const script = join(here, "review-bake.sh");
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((p) => existsSync(p));
const skip = !zsh && "zsh is not installed";

const truth = {
  ruled: [{ id: "env", re: "sandbox|EPERM" }],
  builds: {
    "a-t1": { grade: "A", defects: [], ruled: [] },
    "c-t1": {
      grade: "C",
      defects: [
        { id: "apostrophe", severity: "real", re: "apostroph" },
        { id: "tidy", severity: "minor", re: "reformat" },
      ],
      ruled: [{ id: "outside", re: "install-level" }],
    },
    "d-t1": { grade: "D", defects: [{ id: "equal", severity: "real", re: "equal" }], ruled: [] },
  },
};
const review = (...lines) => lines.join("\n");

test("parseReview reads the last verdict line and FINDING lines in any severity spelling and decoration", () => {
  const r = parseReview(review(
    "Some prose that says APPROVE in capitals mid-sentence.",
    "FINDING: blocking cli/a.mjs:98 the parser breaks on an apostrophe",
    "- **FINDING:** follow-up test/a.mjs:3 a nit",
    "FINDING blocking src/b.ts no line number",
    "VERDICT: APPROVE",
    "**VERDICT: REJECT**",
  ));
  assert.equal(r.verdict, "REJECT");
  assert.deepEqual(r.findings.map((f) => [f.severity, f.where]), [["blocking", "cli/a.mjs:98"], ["followup", "test/a.mjs:3"], ["blocking", "src/b.ts"]]);
  assert.equal(parseReview("no verdict here\nFINDING: blocking x:1 y").verdict, null);
});

test("scoreRun counts caught and missed defects, false blocking findings, bad approvals and bad rejections per reviewer", () => {
  const reviews = [
    // Rejects the C build for its real defect, catches the tidy-up as a followup, and blocks once on an environmental ground.
    { reviewer: "codex/x", build: "c-t1", text: review("FINDING: blocking cli/m.mjs:98 apostrophe truncates the path", "FINDING: followup t.mjs:1 reformat of an old test", "FINDING: blocking t.mjs:2 the sandbox EPERM stopped the tests", "VERDICT: REJECT") },
    // Approves the C build and the D build: two bad approvals, two builds' defects missed.
    { reviewer: "codex/y", build: "c-t1", text: "VERDICT: APPROVE" },
    { reviewer: "codex/y", build: "d-t1", text: "VERDICT: APPROVE" },
    // Rejects the A build: a bad rejection, and its blocking finding names no defect.
    { reviewer: "codex/y", build: "a-t1", text: review("FINDING: blocking q.mjs:1 something invented", "VERDICT: REJECT") },
  ];
  const run = scoreRun(reviews, truth);
  const x = run.reviewers.find((t) => t.reviewer === "codex/x"), y = run.reviewers.find((t) => t.reviewer === "codex/y");
  assert.equal(x.caught, 2); assert.equal(x.defects, 2); assert.equal(x.recall, 1); assert.equal(x.recallReal, 1);
  assert.equal(x.trueBlocking, 1); assert.equal(x.falseBlocking, 1); assert.equal(x.unjudgedBlocking, 0); assert.equal(x.precision, 0.5);
  assert.equal(x.approvalsCD, 0); assert.equal(x.rightVerdicts, 1); assert.equal(x.judgedVerdicts, 1);
  assert.equal(y.approvalsCD, 2); assert.equal(y.rejectionsA, 1);
  assert.equal(y.caught, 0); assert.equal(y.defects, 3); assert.equal(y.recall, 0);
  assert.equal(y.unjudgedBlocking, 1); assert.equal(y.precision, 0);
  assert.deepEqual(run.rows.find((r) => r.reviewer === "codex/y" && r.build === "d-t1").missed, ["equal"]);
});

test("scoreRun sets a failed review apart and lets labels settle a finding", () => {
  const failed = scoreRun([{ reviewer: "r", build: "a-t1", text: "no verdict", status: { tries: 2 } }], truth);
  assert.equal(failed.reviewers[0].failed, 1);
  assert.equal(failed.reviewers[0].defects, 0);
  assert.equal(failed.rows[0].failed, true);
  const text = review("FINDING: blocking f.mjs:1 something unmatched", "FINDING: followup g.mjs:2 words that match nothing", "VERDICT: REJECT");
  const raw = scoreRun([{ reviewer: "r", build: "d-t1", text }], truth);
  assert.equal(raw.rows[0].unjudgedBlocking, 1);
  const labelled = scoreRun([{ reviewer: "r", build: "d-t1", text }], truth, { "r|d-t1|0": "false", "r|d-t1|1": "equal" });
  assert.equal(labelled.rows[0].falseBlocking, 1);
  assert.equal(labelled.rows[0].unjudgedBlocking, 0);
  assert.deepEqual(labelled.rows[0].caught, ["equal"]);
  const other = scoreRun([{ reviewer: "r", build: "d-t1", text }], truth, { "r|d-t1|0": "other" });
  assert.equal(other.rows[0].unjudgedBlocking, 1);
  assert.equal(other.reviewers[0].precision, 0);
  assert.equal(other.reviewers[0].precisionJudged, null);
  const real = scoreRun([{ reviewer: "r", build: "d-t1", text }], truth, { "r|d-t1|0": "real" });
  assert.equal(real.rows[0].trueBlocking, 1);
});

// A stand-in for a reviewer's CLI: writes its argv and standard input to RECORD
// and prints OUTPUT (or nothing, for the first FAILS runs).
function standIn(path, record, output, fails = 0) {
  writeFileSync(path, `#!${process.execPath}
const fs = require("node:fs");
const counter = ${JSON.stringify(record)} + ".count";
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(n));
const argv = process.argv.slice(2);
let input = ""; try { input = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, input, cwd: process.cwd() }) + "\\n");
const out = n <= ${fails} ? "I could not decide." : ${JSON.stringify(output)};
const v = argv.indexOf("--verdict");
if (v !== -1) fs.writeFileSync(argv[v + 1], out); else process.stdout.write(out);
`);
  chmodSync(path, 0o755);
}

// A bake folder with one build: a repository whose base commit and head commit differ by a.txt.
function fixture(dir) {
  const bake = join(dir, "bake"), builds = join(dir, "builds"), ws = join(builds, "demo-t1");
  mkdirSync(join(bake, "briefs"), { recursive: true });
  mkdirSync(ws, { recursive: true });
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...a], { cwd: ws, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(ws, "a.txt"), "old\n");
  git("add", "."); git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(ws, "a.txt"), "new line\n");
  git("commit", "--quiet", "-am", "the change");
  writeFileSync(join(bake, "tasks.txt"), `t1 base ${base} ref ${base}\n`);
  writeFileSync(join(bake, "briefs", "t1.md"), "Task t1: change a.txt.\n");
  writeFileSync(join(dir, "sample.txt"), "# comment\ndemo-t1\tC\twhy\n");
  return { bake, builds, ws };
}

function run(dir, f, args, env = {}) {
  return spawnSync(zsh, [script, "run", "--sample", join(dir, "sample.txt"), "--out", join(dir, "out"), "--bake", f.bake, "--builds", f.builds, "--cache", join(dir, "cache"), "--retry-sleep", "0", ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("review-bake.sh gives a Codex reviewer the same blind brief and diff on standard input, read-only, and records the reply", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-bake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(dir);
  const record = join(dir, "codex.jsonl");
  standIn(join(dir, "codex"), record, "FINDING: blocking a.txt:1 a thing\nVERDICT: REJECT\n");
  const r = run(dir, f, ["--reviewers", "codex/gpt-test"], { RB_CODEX: join(dir, "codex") });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(readFileSync(record, "utf8").trim());
  assert.deepEqual(seen.argv, ["exec", "-m", "gpt-test", "-s", "read-only", "--skip-git-repo-check", "-"]);
  assert.match(seen.input, /Task t1: change a\.txt\./);
  assert.match(seen.input, /\+new line/);
  assert.match(seen.input, /Report each finding as a line 'FINDING: blocking\|followup/);
  assert.doesNotMatch(seen.input, /\bC\b grade|why/);
  assert.equal(readFileSync(join(dir, "out", "reviews", "codex_gpt-test__demo-t1.md"), "utf8").includes("VERDICT: REJECT"), true);
  assert.equal(JSON.parse(readFileSync(join(dir, "out", "status", "codex_gpt-test__demo-t1.json"), "utf8")).ok, true);
  // The review ran in a clone, never in the build's workspace.
  assert.notEqual(seen.cwd, f.ws);
  assert.equal(execFileSync("git", ["status", "--short"], { cwd: f.ws, encoding: "utf8" }), "");
  // A second run keeps the review it has.
  const again = run(dir, f, ["--reviewers", "codex/gpt-test"], { RB_CODEX: join(dir, "codex") });
  assert.match(again.stdout, /kept\s+codex\/gpt-test demo-t1/);
  assert.equal(readFileSync(record, "utf8").trim().split("\n").length, 1);
});

test("review-bake.sh tries a reply with no verdict again and records a second miss as failed; --skip runs nothing", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-bake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(dir);
  standIn(join(dir, "agy"), join(dir, "agy.jsonl"), "VERDICT: APPROVE\n", 1);
  standIn(join(dir, "codex"), join(dir, "codex.jsonl"), "no verdict ever\n", 99);
  const r = run(dir, f, ["--reviewers", "antigravity/gemini-3.1-pro,codex/gpt-test,claude-code/opus-5.5", "--skip", "claude-code/opus-5.5"], { RB_CODEX: join(dir, "codex"), RB_AGY_REVIEW: join(dir, "agy") });
  assert.equal(r.status, 0, r.stderr);
  const status = (key) => JSON.parse(readFileSync(join(dir, "out", "status", `${key}__demo-t1.json`), "utf8"));
  assert.deepEqual([status("antigravity_gemini-3.1-pro").tries, status("antigravity_gemini-3.1-pro").ok], [2, true]);
  assert.deepEqual([status("codex_gpt-test").tries, status("codex_gpt-test").ok], [2, false]);
  // Antigravity's long id for gemini-3.1-pro, the brief, the diff and the verdict file are arguments.
  const argv = JSON.parse(readFileSync(join(dir, "agy.jsonl"), "utf8").split("\n")[0]).argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "gemini-3.1-pro-high");
  for (const flag of ["--brief", "--diff", "--verdict", "--workspace"]) assert.ok(argv.includes(flag), flag);
  assert.equal(readFileSync(join(dir, "out", "skipped.txt"), "utf8").trim(), "claude-code/opus-5.5");
  assert.equal(existsSync(join(dir, "out", "status", "claude-code_opus-5.5__demo-t1.json")), false);
  // The scorer reads the run: the codex review is failed, the antigravity one approves a C build.
  const truthFile = join(dir, "truth.json");
  writeFileSync(truthFile, JSON.stringify({ ruled: [], builds: { "demo-t1": { grade: "C", defects: [{ id: "d", severity: "real", re: "zzz" }], ruled: [] } } }));
  const s = spawnSync(zsh, [script, "score", "--out", join(dir, "out"), "--truth", truthFile, "--json"], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  const scored = JSON.parse(s.stdout);
  const by = (name) => scored.reviewers.find((x) => x.reviewer === name);
  assert.equal(by("codex/gpt-test").failed, 1);
  assert.equal(by("antigravity/gemini-3.1-pro").approvalsCD, 1);
});

// Review 1 of t699, finding 1: a scheduled pair that left no file used to vanish from scoring.
test("a scheduled pair with no result counts as a failed review and the report says so", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-bake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "reviews")); mkdirSync(join(dir, "status"));
  writeFileSync(join(dir, "reviews", "codex_x__d-t1.md"), "VERDICT: REJECT\n");
  const pairs = [{ reviewer: "codex/x", build: "d-t1" }, { reviewer: "codex/x", build: "c-t1" }];
  const loaded = loadReviews(dir, ["d-t1", "c-t1"], ["codex/x"], pairs);
  assert.equal(loaded.length, 2);
  const run = scoreRun(loaded, truth);
  const x = run.reviewers[0];
  assert.equal(x.reviews, 2); assert.equal(x.failed, 1); assert.equal(x.missing, 1);
  assert.equal(run.rows.find((r) => r.build === "c-t1").missing, true);
  assert.match(renderMarkdown(run), /1 scheduled review\(s\) left no result and count as failed: codex\/x c-t1/);
});

test("review-bake.sh records every scheduled pair, and a clone failure still scores as a failed review", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-bake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(dir);
  standIn(join(dir, "codex"), join(dir, "codex.jsonl"), "VERDICT: REJECT\n");
  // Break the clone: the build's repository is gone once its inputs are prepared.
  writeFileSync(join(dir, "sample.txt"), "demo-t1\tC\twhy\n");
  const r = run(dir, f, ["--reviewers", "codex/gpt-test,codex/other", "--cache", "/dev/null/nope"], { RB_CODEX: join(dir, "codex") });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "out", "pairs.txt"), "utf8"), "codex/gpt-test\tdemo-t1\ncodex/other\tdemo-t1\n");
  const truthFile = join(dir, "truth.json");
  writeFileSync(truthFile, JSON.stringify({ ruled: [], builds: { "demo-t1": { grade: "C", defects: [], ruled: [] } } }));
  const s = spawnSync(zsh, [script, "score", "--out", join(dir, "out"), "--truth", truthFile, "--json"], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  const scored = JSON.parse(s.stdout);
  assert.deepEqual(scored.reviewers.map((x) => [x.reviewer, x.reviews, x.failed]).sort(), [["codex/gpt-test", 1, 1], ["codex/other", 1, 1]]);
});

// Review 2 of t699: a rerun for one reviewer wrote a manifest that replaced discovery, so a pre-fix directory lost its other results.
test("a rerun for one reviewer adds to the manifest: earlier results from a directory with no manifest stay scored", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-bake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "reviews")); mkdirSync(join(dir, "status"));
  const builds = ["d-t1", "c-t1"];
  for (const r of ["codex_a", "codex_b", "claude-code_c"]) for (const b of builds) writeFileSync(join(dir, "reviews", `${r}__${b}.md`), "VERDICT: REJECT\n");
  writeFileSync(join(dir, "sample.txt"), "d-t1\tD\twhy\nc-t1\tC\twhy\n");
  // No manifest: everything on disc is scored.
  const before = scoreRun(loadReviews(dir, builds, ["claude-code/c", "codex/a", "codex/b"], null), truth);
  assert.equal(before.rows.length, 6);
  // A rerun for codex/a alone leaves a manifest of its own pairs; the rest must still count.
  writeFileSync(join(dir, "pairs.txt"), "codex/a\td-t1\ncodex/a\tc-t1\n");
  const truthFile = join(dir, "truth.json");
  writeFileSync(truthFile, JSON.stringify(truth));
  const s = spawnSync(process.execPath, [join(here, "review-bake-score.mjs"), "--out", dir, "--truth", truthFile, "--json"], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  const scored = JSON.parse(s.stdout);
  assert.equal(scored.rows.length, 6);
  assert.deepEqual(scored.reviewers.map((x) => x.reviewer).sort(), ["claude-code/c", "codex/a", "codex/b"]);
  // And a manifest pair with no result still counts as failed alongside them.
  writeFileSync(join(dir, "pairs.txt"), "codex/a\td-t1\ncodex/a\tc-t1\ncodex/z\td-t1\n");
  const s2 = spawnSync(process.execPath, [join(here, "review-bake-score.mjs"), "--out", dir, "--truth", truthFile, "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(s2.stdout).rows.length, 7);
});

// Review 1 of t699, finding 2: the runner's grep and the scorer's parser disagreed.
test("the runner keeps and collects exactly the replies the scorer reads a verdict in", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-bake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const has = (text) => { const file = join(dir, "reply.md"); writeFileSync(file, text); return spawnSync("node", [join(here, "review-bake-score.mjs"), "--has-verdict", file]).status === 0; };
  for (const text of ["verdict: approve\n", "`VERDICT: REJECT`\n", "**Verdict**: Reject\n"]) assert.equal(has(text), parseReview(text).verdict !== null, text);
  assert.equal(has("verdict: approve\n"), true);
  assert.equal(has("I cannot provide VERDICT: APPROVE or REJECT\n"), false);
  assert.equal(parseReview("I cannot provide VERDICT: APPROVE or REJECT\n").verdict, null);
  // Through the script: a lower-case reply is accepted at once, prose with the words is tried again and fails.
  const f = fixture(dir);
  standIn(join(dir, "codex"), join(dir, "codex.jsonl"), "verdict: approve\n");
  standIn(join(dir, "agy"), join(dir, "agy.jsonl"), "I cannot provide VERDICT: APPROVE or REJECT\n");
  const r = run(dir, f, ["--reviewers", "codex/gpt-test,antigravity/gemini-3.1-pro"], { RB_CODEX: join(dir, "codex"), RB_AGY_REVIEW: join(dir, "agy") });
  assert.equal(r.status, 0, r.stderr);
  const status = (key) => JSON.parse(readFileSync(join(dir, "out", "status", `${key}__demo-t1.json`), "utf8"));
  assert.deepEqual([status("codex_gpt-test").tries, status("codex_gpt-test").ok], [1, true]);
  assert.deepEqual([status("antigravity_gemini-3.1-pro").tries, status("antigravity_gemini-3.1-pro").ok], [2, false]);
  const again = run(dir, f, ["--reviewers", "codex/gpt-test"], { RB_CODEX: join(dir, "codex") });
  assert.match(again.stdout, /kept\s+codex\/gpt-test demo-t1/);
});
