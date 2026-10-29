// The round-12 review of G3/G4/G21: no text from an error, a child process
// or a log reaches a runner's request body except through the facts builder
// (automaticNote, failureReleaseNote, factsOf/runFacts in cli/runner.mjs and
// src/run-facts.ts). A static scan of the runner and its helpers: each call
// that sends to the server (io.cli, report, the transport, the report and
// skip callbacks) is read whole, the facts builder's own arguments are cut
// out, and what is left may name no .message, stderr, stdout or .output.
// Each text flag (--note, --reason) must be built by the facts builder, or be
// a fixed phrase, or one of the words a model wrote on purpose (listed).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const FILES = ["cli/runner.mjs", "cli/task-refresh.mjs", "cli/runner-failure.mjs", "cli/progress.mjs", "cli/commands/runner.mjs"];
const SENDS = /\b(?:io\.cli|report|reportRun|reportSkip|reportRunSkip|reportReviewSkip|heartbeat|transport\.send|t\.send|send)\(/g;
const BUILDERS = /\b(?:automaticNote|failureReleaseNote|factsOf|runFacts)\(/g;
const RAW = /\.message\b|\bstderr\b|\bstdout\b|\.output\b/;
// Words a model wrote on purpose, which stay (follow-ups of round 12): a
// reviewer's summary and its unparsable reply's parse note, a validation_blocked report.
const MODEL_WORDS = ["posted.summary", "parsed.summary", "parsed.error", "blockNote("];

function callAt(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") { const q = c; for (i++; i < s.length && s[i] !== q; i++) if (s[i] === "\\") i++; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return s.slice(open, i + 1);
  }
  return s.slice(open);
}
const withoutBuilders = (text) => {
  let out = text;
  for (const m of [...text.matchAll(BUILDERS)].reverse()) out = out.slice(0, m.index) + "facts()" + out.slice(m.index + callAt(text, m.index + m[0].length - 1).length + m[0].length - 1);
  return out;
};

function rawSends(file, s) {
  const offenders = [];
  for (const m of s.matchAll(SENDS)) {
    if (/^\s*(?:export\s+)?(?:async\s+)?function\b/.test(s.slice(s.lastIndexOf("\n", m.index) + 1, m.index))) continue;
    const call = callAt(s, m.index + m[0].length - 1);
    if (RAW.test(withoutBuilders(call))) offenders.push(`${file}:${s.slice(0, m.index).split("\n").length}: ${call.slice(0, 160)}`);
  }
  return offenders;
}

test("no .message, stderr, stdout or .output reaches a runner request body but through the facts builder", () => {
  const offenders = FILES.flatMap((file) => rawSends(file, readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], "send facts (automaticNote, failureReleaseNote, factsOf), never error or process text");
});

test("the scan catches raw text sent directly, and passes it through the builder", () => {
  assert.equal(rawSends("x", `await io.cli(["release", id, "--note", error.message]);`).length, 1);
  assert.equal(rawSends("x", `await report(["refresh-failed", "--reason", \`not pushed: \${push.stderr}\`]);`).length, 1);
  assert.equal(rawSends("x", `await reportRun({ outcome, detail: result.output });`).length, 1);
  assert.equal(rawSends("x", `await io.cli(["release", id, "--note", automaticNote(error.message)]);`).length, 0);
});

test("every --note and --reason the runner sends is built by the facts builder, a fixed phrase, or a model's own words", () => {
  const offenders = [];
  for (const file of FILES) {
    const s = readFileSync(file, "utf8");
    for (const m of s.matchAll(/"--(?:note|reason)",\s*([^\]\n]+)/g)) {
      const value = m[1].trim();
      const ok = /^(?:automaticNote|failureReleaseNote|outcomeNote)\(/.test(value) || /^"[^"]*"/.test(value) || MODEL_WORDS.some((w) => value.startsWith(w))
        // A conditional whose every branch is one of the above.
        || /^(?:error\.)?validationBlocked \? blockNote\(.*: (?:failureReleaseNote|automaticNote)\(/.test(value) || /^state\.phase === "failed" \? automaticNote\(state\.reason\) : automaticNote\("[^"]*"\)/.test(value);
      if (!ok) offenders.push(`${file}:${s.slice(0, m.index).split("\n").length}: ${value.slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, []);
});
