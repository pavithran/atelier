import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { caseSetHash, caseSetMeta, harnessAndModel, loadReviews, renderMarkdown, scoreRun } from "./review-bake-score.mjs";

// t46: a portable, versioned case set of judged builds (review-cases/v1) that
// the bake runner and scorer run without the bake-off's private data folder,
// and a score that records which cases, brief and reviewer it measured.

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "..", "..");
const cases = join(here, "review-cases", "v1");
const script = join(here, "review-bake.sh");
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((p) => existsSync(p));
const skip = !zsh && "zsh is not installed";
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const sampleNames = () => readFileSync(join(cases, "sample.txt"), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split("\t")[0]);

test("the checked-in case set is self-contained: every case has its brief, diff, base and ground truth, and none names a home folder", () => {
  const names = sampleNames();
  const truth = json(join(cases, "truth.json"));
  assert.deepEqual(Object.keys(truth.builds).sort(), [...names].sort());
  for (const n of names) {
    for (const f of ["brief.md", "diff.txt", "base"]) assert.ok(readFileSync(join(cases, n, f), "utf8").trim(), `${n}/${f}`);
    assert.match(readFileSync(join(cases, n, "base"), "utf8").trim(), /^[0-9a-f]{40}$/);
    assert.doesNotMatch(readFileSync(join(cases, n, "brief.md"), "utf8"), /\bgrade\b|judge/i);
  }
  // Both kinds of case are there: clean builds and builds with a confirmed defect.
  const grades = names.map((n) => truth.builds[n].grade);
  assert.ok(grades.includes("A") && grades.some((g) => g === "C" || g === "D"));
  for (const n of names) assert.equal(truth.builds[n].defects.length > 0, truth.builds[n].grade !== "A", n);
  const manifest = json(join(cases, "manifest.json"));
  assert.equal(typeof manifest.briefVersion, "string");
  for (const f of ["manifest.json", "sample.txt", "truth.json", "README.md", ...names.flatMap((n) => ["brief.md", "diff.txt", "base"].map((x) => join(n, x)))]) {
    assert.doesNotMatch(readFileSync(join(cases, f), "utf8"), /\/Users\/|~\/Documents|ai-project-data/, f);
  }
});

test("caseSetHash covers every file of the folder: the same bytes give the same hash, any edit changes it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-cases-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(cases, join(dir, "copy"), { recursive: true });
  const a = caseSetHash(cases);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(caseSetHash(join(dir, "copy")), a);
  writeFileSync(join(dir, "copy", "worktree-clean-1", "brief.md"), readFileSync(join(cases, "worktree-clean-1", "brief.md"), "utf8") + "x");
  assert.notEqual(caseSetHash(join(dir, "copy")), a);
  cpSync(cases, join(dir, "more"), { recursive: true });
  writeFileSync(join(dir, "more", "extra"), "");
  assert.notEqual(caseSetHash(join(dir, "more")), a);
  assert.deepEqual(harnessAndModel("codex/gpt-6-astra"), { harness: "codex", model: "gpt-6-astra" });
  assert.deepEqual(harnessAndModel("solo"), { harness: "solo", model: null });
});

// A stand-in reviewer that reads what it is given the way a good reviewer would: it names the defect each case holds.
function standIn(path, record) {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), status: require("node:child_process").execFileSync("git", ["status", "--short"], { encoding: "utf8" }) }) + "\\n");
let out = "No defect found.\\nVERDICT: APPROVE\\n";
if (input.includes('"stat", ["-f"')) out = "FINDING: blocking test/orchestrate-stdin.test.mjs:54 stat -f %HT is BSD syntax; GNU stat fails on Linux\\nVERDICT: REJECT\\n";
if (input.includes("servesProject(offer, project)")) out = "FINDING: blocking src/stuck/report.ts:157 a runner that polled under a former name before a rename is dropped from the idle list\\nVERDICT: REJECT\\n";
process.stdout.write(out);
`);
  chmodSync(path, 0o755);
}

test("review-bake.sh runs the case set with a stand-in reviewer and no home-directory data, and the score records the cases, brief, harness, model and version", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-cases-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home"); mkdirSync(home);
  const record = join(dir, "codex.jsonl");
  standIn(join(dir, "codex"), record);
  const env = { ...process.env, HOME: home, RB_CODEX: join(dir, "codex") };
  const run = (...a) => spawnSync(zsh, [script, ...a], { encoding: "utf8", env, cwd: dir });
  const base = json(join(cases, "manifest.json"));
  const have = (sha) => spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repo }).status === 0;
  if (!sampleNames().every((n) => have(readFileSync(join(cases, n, "base"), "utf8").trim()))) return t.skip("this clone lacks the history the cases' base commits are in");
  const r = run("run", "--cases", cases, "--out", join(dir, "out"), "--reviewers", "codex/gpt-test", "--cache", join(dir, "cache"), "--retry-sleep", "0");
  assert.equal(r.status, 0, r.stderr);
  // Each review ran in a clone with the build's change applied and uncommitted, never in this checkout.
  const seen = readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(seen.length, sampleNames().length);
  for (const s of seen) { assert.notEqual(s.cwd, repo); assert.match(s.status, /^\s*[MA?]/m); }
  assert.deepEqual(readdirSync(join(home)), []);
  const s = run("score", "--out", join(dir, "out"), "--cases", cases, "--version", "brief A", "--write");
  assert.equal(s.status, 0, s.stderr);
  const scores = json(join(dir, "out", "scores.json"));
  assert.deepEqual(scores.meta, { caseSet: base.caseSet, caseSetVersion: base.version, briefVersion: base.briefVersion, caseSetHash: caseSetHash(cases), reviewerVersion: "brief A" });
  const [x] = scores.reviewers;
  assert.deepEqual([x.harness, x.model, x.reviews, x.failed, x.wrongVerdicts, x.unjudgedBlocking, x.recall, x.precision], ["codex", "gpt-test", 4, 0, 0, 0, 1, 1]);
  const md = readFileSync(join(dir, "out", "scores.md"), "utf8");
  assert.match(md, new RegExp(`hash ${caseSetHash(cases)}, brief version ${base.briefVersion}, reviewer version: brief A`));
  assert.match(md, /\| codex\/gpt-test \| codex \| gpt-test \| 4 \| 0 \(0\) \| 0 \|/);
  // The same case set scored twice gives the same bytes: a comparison needs no clock.
  run("score", "--out", join(dir, "out"), "--cases", cases, "--version", "brief A", "--write");
  assert.equal(readFileSync(join(dir, "out", "scores.md"), "utf8"), md);
});

test("review-bake.sh run --cases says which base commit is missing instead of reviewing the wrong tree", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-cases-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source"); mkdirSync(source);
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: source });
  const r = spawnSync(zsh, [script, "run", "--cases", cases, "--source", source, "--out", join(dir, "out"), "--reviewers", "codex/gpt-test", "--cache", join(dir, "cache")], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /base [0-9a-f]{40} of case \S+ is not a commit of /);
  assert.equal(existsSync(join(dir, "out", "reviews")), false);
});

test("a score with nothing to divide by reports n/a, not 0 or NaN: only clean builds reviewed, only failed or missing runs", () => {
  const truth = json(join(cases, "truth.json"));
  const [clean1, clean2, bsd] = ["worktree-clean-1", "worktree-clean-2", "worktree-bsd-stat"];
  const approve = "VERDICT: APPROVE\n";
  // One reviewer saw only clean builds: no defects to catch (recall n/a) and no blocking findings (precision n/a).
  // Another's every run failed or left no result.
  const reviews = [
    { reviewer: "codex/clean-only", build: clean1, text: approve },
    { reviewer: "codex/clean-only", build: clean2, text: approve },
    { reviewer: "codex/all-failed", build: bsd, text: "I could not decide.", status: { tries: 2, ok: false } },
    { reviewer: "codex/all-failed", build: clean1, text: "", missing: true },
  ];
  const result = scoreRun(reviews, truth);
  const by = Object.fromEntries(result.reviewers.map((t) => [t.reviewer, t]));
  assert.deepEqual([by["codex/clean-only"].recall, by["codex/clean-only"].precision, by["codex/clean-only"].precisionJudged, by["codex/clean-only"].wrongVerdicts], [null, null, null, 0]);
  assert.deepEqual([by["codex/all-failed"].recall, by["codex/all-failed"].precision, by["codex/all-failed"].reviews, by["codex/all-failed"].failed, by["codex/all-failed"].missing], [null, null, 2, 2, 1]);
  const md = renderMarkdown(result);
  assert.match(md, /\| codex\/all-failed \| codex \| all-failed \| 2 \| 2 \(1\) \| 0 \| 0 \| 0 \| 0\/0 \| 0\/0 \| 0 \/ 0 \/ 0 \| n\/a \| n\/a \| n\/a \| n\/a \|/);
  assert.doesNotMatch(md, /NaN|Infinity/);
  assert.match(md, /1 scheduled review\(s\) left no result and count as failed: codex\/all-failed worktree-clean-1/);
});

test("a wrong verdict counts both ways and an unjudged blocking finding stays out of the judged precision", () => {
  const truth = json(join(cases, "truth.json"));
  const result = scoreRun([
    { reviewer: "codex/x", build: "worktree-clean-1", text: "FINDING: blocking a.mjs:1 something nobody judged\nVERDICT: REJECT\n" },
    { reviewer: "codex/x", build: "holder-rename-missed", text: "VERDICT: APPROVE\n" },
  ], truth);
  const [x] = result.reviewers;
  assert.deepEqual([x.rejectionsA, x.approvalsCD, x.wrongVerdicts, x.unjudgedBlocking, x.precision, x.precisionJudged, x.recall], [1, 1, 2, 1, 0, null, 0]);
});

test("caseSetMeta reads the manifest and leaves the reviewer version empty when none is given", () => {
  assert.equal(caseSetMeta(cases).reviewerVersion, null);
  assert.equal(caseSetMeta(cases, "v2").reviewerVersion, "v2");
});
