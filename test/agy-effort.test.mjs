import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("both Antigravity review paths honour effort and preserve defaults", () => {
  for (const [model, effort, expected] of [
    ["gemini-4-argon", "medium", "gemini-4-argon-medium"],
    ["gemini-4-argon-medium", "", "gemini-4-argon-medium"],
    ["claude-opus-5.5-medium", "", "claude-opus-5-5-medium"],
    ["gemini-4-argon-medium", "high", "gemini-4-argon-medium"],
    ["some-other-id", "medium", "some-other-id"],
    ["gemini-4-argon", "", "gemini-4-argon-high"],
    ["gpt-oss-120b", "", "gpt-oss-120b-medium"],
    ["gemini-4-carbon", "", "gemini-4-carbon-high"],
    ["gemini-4-carbon", "low", "gemini-4-carbon-low"],
    ["gemini-4-carbon", "medium", "gemini-4-carbon-medium"],
  ]) {
    // Intercept agy's process boundary so the legacy entry point needs no files.
    const script = `
      import fs from 'node:fs';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { HARNESSES } from './cli/harness/adapter.mjs';
      const direct = HARNESSES.antigravity.command({model:${JSON.stringify(model)}}, 'review').argv;
      const read = fs.readFileSync;
      fs.readFileSync = (file, ...args) => ['brief', 'diff'].includes(file) ? 'Review this change.' : read(file, ...args);
      let legacy, verdict;
      fs.writeFileSync = (file, text) => { if (file !== 'verdict') throw new Error('unexpected write'); verdict = text; };
      cp.spawnSync = (command, argv) => { legacy = argv; return {status:0, stdout:JSON.stringify({response:'VERDICT: APPROVE'})}; };
      syncBuiltinESMExports();
      process.argv = [process.execPath, 'agy-review', '--model', ${JSON.stringify(model)}, '--brief', 'brief', '--diff', 'diff', '--verdict', 'verdict', '--workspace', process.cwd()];
      await import('./cli/agy-review.mjs');
      console.log(JSON.stringify({direct, legacy, verdict}));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, AGY_EFFORT: effort }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    for (const path of ["direct", "legacy"]) {
      const argv = seen[path];
      assert.equal(argv[argv.indexOf("--model") + 1], expected, `${path}: ${model}, effort=${effort}`);
    }
    assert.equal(seen.verdict, "VERDICT: APPROVE");
  }
});
