import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptFor, reviewPrompt, verificationPrompt } from "../cli/harness/adapter.mjs";
import { DIFF_PROMPT_MAX, diffPromptMax, diffSections, sizeRefusal, sizeRefusalReason, withoutBulk } from "../src/large-diff.ts";

// t230: a diff over the prompt limit is named by its file and changed paths,
// never put in the prompt; binary and declared generated paths are listed, not
// shown; a harness's refusal for input size is told from any other failure.

const section = (path, body) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
const small = section("src/a.ts", "+one\n");
const big = (path, n) => section(path, `+${"x".repeat(n)}\n`);

test("a diff within the limit is in the prompt, fenced", () => {
  const prompt = reviewPrompt("BRIEF", small, undefined, { file: "/w/diff.txt" });
  assert.ok(prompt.includes(small.trimEnd()));
  assert.ok(prompt.includes("```diff"));
  assert.ok(!prompt.includes("not included here"));
});

test("a diff over the limit is not in the prompt: the file and the changed paths with sizes are", () => {
  const diff = big("src/huge.ts", DIFF_PROMPT_MAX + 5) + big("src/small.ts", 10);
  for (const make of [reviewPrompt, verificationPrompt]) {
    const prompt = make("BRIEF", diff, "/clone", { file: "/w/.scratch/diff.txt" });
    assert.ok(prompt.length < 5000, `the prompt is ${prompt.length} characters`);
    assert.ok(!prompt.includes("xxxxxxxxxx"));
    assert.match(prompt, new RegExp(`The diff is ${diff.length} characters, over the ${DIFF_PROMPT_MAX}`));
    assert.ok(prompt.includes("/w/.scratch/diff.txt"));
    assert.match(prompt, /- src\/huge\.ts: \d+ characters\n- src\/small\.ts: \d+ characters/, "largest first");
  }
});

test("a 7 MB diff gives a small prompt, and the limit can be set by the environment", () => {
  const diff = big("data/blob.json", 7_052_528);
  assert.ok(reviewPrompt("BRIEF", diff, undefined, { file: "/d" }).length < 2000);
  assert.equal(diffPromptMax({}), DIFF_PROMPT_MAX);
  assert.equal(diffPromptMax({ ATELIER_REVIEW_DIFF_MAX: "100" }), 100);
  assert.equal(diffPromptMax({ ATELIER_REVIEW_DIFF_MAX: "-4" }), DIFF_PROMPT_MAX);
  const prompt = reviewPrompt("BRIEF", small, undefined, { file: "/d", max: 10 });
  assert.match(prompt, /over the 10 /);
});

test("binary and generated paths are listed with their sizes, not shown", () => {
  const binary = "diff --git a/img/logo.png b/img/logo.png\nnew file mode 100644\nBinary files /dev/null and b/img/logo.png differ\n";
  const generated = big("docs/api.json", 500);
  const diff = small + binary + generated;
  const sections = diffSections(diff, new Set(["docs/api.json"]));
  assert.deepEqual(sections.map((s) => [s.path, s.binary, s.generated]), [["src/a.ts", false, false], ["img/logo.png", true, false], ["docs/api.json", false, true]]);
  const { text, hidden } = withoutBulk(diff, new Set(["docs/api.json"]));
  assert.deepEqual(hidden.map((h) => h.path), ["img/logo.png", "docs/api.json"]);
  assert.ok(text.includes("+one") && !text.includes("xxxxxxxx") && !text.includes("Binary files"));
  const prompt = reviewPrompt("BRIEF", diff, undefined, { file: "/d", generated: new Set(["docs/api.json"]) });
  assert.match(prompt, /Not shown here, listed only: img\/logo\.png \(binary, \d+ characters\), docs\/api\.json \(generated, \d+ characters\)/);
  const over = reviewPrompt("BRIEF", diff, undefined, { file: "/d", generated: new Set(["docs/api.json"]), max: 50 });
  assert.match(over, /- docs\/api\.json: \d+ characters \(generated, not shown\)/);
  assert.match(over, /- img\/logo\.png: \d+ characters \(binary, not shown\)/);
});

test("promptFor reads the project's declared generated outputs from the clone's merge manifest", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-large-diff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "merge-manifest.json"), JSON.stringify({ version: 1, generators: [{ name: "api", command: ["node", "gen.mjs"], inputs: ["src/**"], outputs: ["docs/api.json"] }] }));
  writeFileSync(join(dir, "brief.txt"), "BRIEF\n");
  writeFileSync(join(dir, "diff.txt"), small + big("docs/api.json", 300));
  const prompt = promptFor("claude-code", { brief: join(dir, "brief.txt"), diff: join(dir, "diff.txt"), workspace: dir, model: "m", verdict: "v" }, (f) => require_read(f));
  assert.match(prompt, /docs\/api\.json \(generated, \d+ characters\)/);
  assert.ok(!prompt.includes("xxxxxxxx"));
});
import { readFileSync } from "node:fs";
const require_read = (f) => readFileSync(f, "utf8");

test("sizeRefusal reads the limit and the size from a refusal, and nothing from other failures", () => {
  assert.deepEqual(sizeRefusal("Error: Input exceeds the maximum length of 1048576 characters (got 7052528)."), { limit: 1048576, actual: 7052528 });
  assert.deepEqual(sizeRefusal("prompt is too long: 250000 tokens > 200000 maximum"), { limit: 200000, actual: 250000 });
  assert.deepEqual(sizeRefusal("Input exceeds the maximum length of 1,048,576 characters"), { limit: 1048576, actual: null });
  assert.deepEqual(sizeRefusal("request too large"), { limit: null, actual: null });
  for (const other of ["", "boom", "exit 1", "network error: offline", "usage limit reached"]) assert.equal(sizeRefusal(other), null, other);
});

test("sizeRefusalReason states the limit, the size and the fix", () => {
  const reason = sizeRefusalReason("codex/gpt-6-astra", { limit: 1048576, actual: 7052528 }, 10);
  assert.match(reason, /limit 1048576; actual 7052528/);
  assert.match(reason, /Fix: /);
  assert.match(sizeRefusalReason("a/b", { limit: null, actual: null }, 321), /a limit it did not state; about 321 characters sent/);
});

test("a size refusal is a stuck entry naming the fix, until the review is asked for again", async () => {
  const { stuckReport, reportLimits } = await import("../src/stuck/report.ts");
  const at = "2026-10-23T10:00:00.000Z";
  const item = { id: "t14", title: "t14", scope: ["src/**"], state: "submitted", owner: null, fork: null, base: null, head: "abc", acceptedHead: null, createdAt: at, updatedAt: at, lastPushAt: null, dispatch: null };
  const note = sizeRefusalReason("codex/gpt-6-astra", { limit: 1048576, actual: 7052528 }, 10);
  const event = (seq, kind, data = {}) => ({ seq, itemId: "t14", actor: "codex/gpt-6-astra", kind, data, at, proved: false });
  const report = (events) => stuckReport("llm-basics", "https://a.test", new Date("2026-10-23T11:00:00.000Z"), reportLimits(), { items: [item], events, lease: null, workflows: [], reviews: [] }, [], [], []).entries.filter((e) => e.kind === "review-input-size");
  const [entry] = report([event(1, "review.claimed"), event(2, "review.released", { note })]);
  assert.equal(entry.subject, "t14");
  assert.match(entry.reason, /limit 1048576; actual 7052528/);
  assert.match(entry.recovery, /split the change/);
  assert.match(entry.recovery, /review-request t14 --reviewer H\/M/);
  assert.equal(report([event(1, "review.released", { note }), event(2, "review.requested")]).length, 0);
  assert.equal(report([event(1, "review.released", { note: "harness exited 1" })]).length, 0);
});

test("git-quoted filenames are decoded before generated paths are matched", () => {
  const q = '"a/caf\\303\\251 \\"x\\".js" "b/caf\\303\\251 \\"x\\".js"';
  const diff = `diff --git ${q}\n--- "a/caf\\303\\251"\n+++ "b/caf\\303\\251"\n+${"y".repeat(50)}\n` + small;
  const sections = diffSections(diff, new Set(['café "x".js']));
  assert.deepEqual(sections.map((s) => s.path), ['café "x".js', "src/a.ts"]);
  assert.equal(sections[0].generated, true);
  const { text, hidden } = withoutBulk(diff, new Set(['café "x".js']));
  assert.equal(hidden.length, 1);
  assert.ok(!text.includes("yyyy"));
});

test("a diff of only quoted filenames still reports its paths", () => {
  const diff = 'diff --git "a/\\346\\227\\245.txt" "b/\\346\\227\\245.txt"\n+x\n';
  assert.deepEqual(diffSections(diff).map((s) => s.path), ["日.txt"]);
});

// Round 3 found b/out.js listed as out.js and its generated body kept: Git's
// b/ prefix is removed once, whatever the form of the header.
for (const [form, header] of [
  ["unquoted", "diff --git a/b/out.js b/b/out.js"],
  ["quoted", 'diff --git "a/b/out.js" "b/b/out.js"'],
  ["quoted, then b/-prefixed unquoted", 'diff --git "a/b/out.js" b/b/out.js'],
  ["a/-prefixed unquoted, then quoted", 'diff --git a/b/out.js "b/b/out.js"'],
]) {
  test(`a declared generated path under b/ is matched, header ${form}`, () => {
    const diff = `${header}\n--- a/b/out.js\n+++ b/b/out.js\n+GENERATED_CONTENT\n` + small;
    const generated = new Set(["b/out.js"]);
    const sections = diffSections(diff, generated);
    assert.deepEqual(sections.map((s) => s.path), ["b/out.js", "src/a.ts"]);
    assert.equal(sections[0].generated, true);
    const { text, hidden } = withoutBulk(diff, generated);
    assert.deepEqual(hidden.map((h) => h.path), ["b/out.js"]);
    assert.ok(!text.includes("GENERATED_CONTENT"));
    assert.ok(text.includes("diff --git a/b/out.js b/b/out.js\n(generated path"));
  });
}

test("a plain path keeps its name and is matched as declared", () => {
  const diff = big("dist/out.js", 20) + small;
  assert.deepEqual(diffSections(diff, new Set(["dist/out.js"])).map((s) => [s.path, s.generated]), [["dist/out.js", true], ["src/a.ts", false]]);
});
