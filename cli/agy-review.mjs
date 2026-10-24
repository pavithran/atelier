#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { AGY_MODELS, demandFor, diffBlock, generatedPaths } from "./harness/adapter.mjs";
import { diffPromptMax } from "../src/review/large-diff.ts";

// An adapter a runner's config names as the review command for the antigravity
// harness (docs/orchestrator.md, section 4). The review job hands it the brief
// and the diff and reads the reply from the verdict file; this reads both,
// builds one prompt, runs Antigravity's CLI `agy` with the workspace as its
// working folder and the prompt on standard input (an argument is capped by
// the operating system, and a large diff passes that cap), and writes `agy`'s `response`
// field to the verdict file. It exits non-zero, writing nothing, when `agy`
// fails, prints no JSON or gives an empty response, so the runner releases the
// request as it does for any harness failure. The executable is `agy` on the
// PATH, or ATELIER_AGY when that is set, so tests can use a stand-in.

// Atelier's model ids mapped to Antigravity's, from the one table the build
// path reads too (a copy here lacked gemini-3.8-flash, so every Flash review
// exited 1: t573); any other id passes through.
const MODEL_MAP = AGY_MODELS;

const value = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1 || at + 1 >= process.argv.length) throw new Error(`usage: agy-review.mjs needs --${name}`);
  return process.argv[at + 1];
};

const model = value("model");
const briefFile = value("brief");
const diffFile = value("diff");
const verdictFile = value("verdict");
const workspace = value("workspace");

// The prompt is the brief, then the diff in a fence longer than any run of
// backticks inside it (at least four), so nothing in the diff can close the
// fence, then a sentence the reviewer follows in the workspace. A diff over
// the prompt limit is named by its file and changed paths instead (t230).
const diff = readFileSync(diffFile, "utf8").replace(/\n+$/, "");
const brief = readFileSync(briefFile, "utf8").replace(/\n+$/, "");
const prompt = [
  brief,
  "",
  ...diffBlock(diff, { file: diffFile, generated: generatedPaths(workspace, (f) => readFileSync(f, "utf8")), max: diffPromptMax(process.env) }),
  "",
  "In the current folder you may read files and run the project's tests; do not push, do not run any atelier command, and verify a blocking finding before you state it.",
  demandFor(brief),
].join("\n");

const agy = process.env.ATELIER_AGY || "agy";
const argv = ["--model", MODEL_MAP[model] ?? model, "--dangerously-skip-permissions", "--sandbox", "--output-format", "json", "--print-timeout", "2400s"];

const fail = (message) => {
  process.stderr.write(`agy-review: ${message}\n`);
  process.exit(1);
};

const result = spawnSync(agy, argv, { cwd: workspace, input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (result.error) fail(`could not run ${agy}: ${result.error.message}`);
if (result.status !== 0) fail(`${agy} exited ${result.status}`);

let response;
try {
  response = JSON.parse(result.stdout.trim()).response;
} catch {
  fail(`${agy} printed no JSON`);
}
if (typeof response !== "string" || !response.trim()) fail(`${agy} gave an empty response`);

writeFileSync(verdictFile, response, "utf8");
