import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../cli/runner-config.mjs";

// The antigravity review adapter (cli/agy-review.mjs): it reads the brief and
// the diff the review job wrote, builds one prompt, runs the stand-in for `agy`
// named by ATELIER_AGY, and writes the response to the verdict file. It exits
// non-zero, writing no verdict file, when `agy` fails, prints no JSON or gives
// an empty response, and it maps Atelier's model ids to Antigravity's.

const adapter = fileURLToPath(new URL("../cli/agy-review.mjs", import.meta.url));

// The stand-in script prints the JSON `agy` would, records its arguments to
// AGY_LOG, and exits with `code`. It never runs the real agy.
const standIn = (stdout, code = 0) =>
  `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.AGY_LOG, JSON.stringify({ argv: process.argv, stdin: fs.readFileSync(0, "utf8") }));\n${stdout ? `process.stdout.write(${JSON.stringify(stdout)});\n` : ""}process.exit(${code});\n`;

function review(t, { stdout = JSON.stringify({ response: "...VERDICT: APPROVE..." }), code = 0, model = "gemini-3.1-pro", diffText = "DIFF TEXT\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-agy-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const brief = join(dir, "brief.txt");
  const diff = join(dir, "diff.txt");
  const verdict = join(dir, "verdict.txt");
  const log = join(dir, "args.json");
  const agy = join(dir, "agy");
  writeFileSync(brief, "BRIEF TEXT\n");
  writeFileSync(diff, diffText);
  writeFileSync(agy, standIn(stdout, code));
  chmodSync(agy, 0o755);
  const result = spawnSync(process.execPath, [adapter, "--model", model, "--brief", brief, "--diff", diff, "--verdict", verdict, "--workspace", dir], {
    encoding: "utf8",
    env: { ...process.env, ATELIER_AGY: agy, AGY_LOG: log },
  });
  return { dir, verdict, log, result };
}

test("the adapter writes agy's response to the verdict file and maps the model id", (t) => {
  const { verdict, log, result } = review(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(verdict, "utf8"), "...VERDICT: APPROVE...");
  const { argv: args, stdin: prompt } = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.1-pro-high", "gemini-3.1-pro maps to gemini-3.1-pro-high");
  assert.ok(!args.includes("-p"), "the prompt is not an argument, whose size the operating system caps");
  assert.ok(prompt.startsWith("BRIEF TEXT\n"), "the brief opens the prompt");
  assert.ok(prompt.includes("````diff\nDIFF TEXT\n````"), "the diff is fenced with four backticks");
});

test("a diff larger than an argument can hold passes on standard input, fenced past its own backticks", (t) => {
  const big = "+" + "x".repeat(2 * 1024 * 1024) + "\n+`````five\n";
  const { verdict, log, result } = review(t, { diffText: big });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(verdict, "utf8"), "...VERDICT: APPROVE...");
  const { stdin } = JSON.parse(readFileSync(log, "utf8"));
  assert.ok(stdin.includes("``````diff\n+x"), "the fence is longer than the diff's own run of five backticks");
  assert.ok(stdin.length > 2 * 1024 * 1024);
});

test("the adapter maps gpt-oss-120b and passes any other model id through", (t) => {
  for (const [model, mapped] of [["gpt-oss-120b", "gpt-oss-120b-medium"], ["some-other-id", "some-other-id"]]) {
    const { log, result } = review(t, { model });
    assert.equal(result.status, 0, result.stderr);
    const { argv: args } = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(args[args.indexOf("--model") + 1], mapped, model);
  }
});

test("the adapter exits non-zero and writes no verdict when agy fails, prints no JSON or gives an empty response", (t) => {
  for (const over of [
    { code: 1 },
    { stdout: "this is not JSON", code: 0 },
    { stdout: JSON.stringify({ response: "" }), code: 0 },
  ]) {
    const { verdict, result } = review(t, over);
    assert.notEqual(result.status, 0, JSON.stringify(over));
    assert.throws(() => readFileSync(verdict, "utf8"), /ENOENT/, JSON.stringify(over));
  }
});

test("a runner config with the antigravity command validates", () => {
  const config = {
    agents: [
      {
        agent: "antigravity",
        models: ["gemini-3.1-pro", "gpt-oss-120b"],
        command: ["node", "cli/agy-review.mjs", "--model", "{model}", "--brief", "{brief_file}", "--diff", "{diff_file}", "--verdict", "{verdict_file}", "--workspace", "{workspace}"],
      },
    ],
  };
  assert.deepEqual(parseConfig(config).errors, []);
});
