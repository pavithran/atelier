import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The helpers are exported for the command modules (cli/commands/); a slice
// of them runs here as a script, so without the keyword.
const source = readFileSync(new URL("../cli/atelier.mjs", import.meta.url), "utf8").replace(/^export (?=(async )?function |const |let )/gm, "");
// Each clone gets its merge configuration (t463) before anything merges in it.
const installed = [];
function cleanClone(git) {
  const code = source.slice(source.indexOf("function cleanClone("), source.indexOf("async function runCheck("));
  return runInNewContext(`${code}; cleanClone`, {
    git, CACHE: "cache", mkdirSync() {}, mkdtempSync: () => "clone", writeFileSync() {},
    join: (...parts) => parts.join("/"), markerPath: (dir) => dir, process: { pid: 1 }, auth: () => [],
    installMergeConfig: (dir) => { installed.push(dir); return []; },
  });
}

test("check measures both sides of a protected rename", () => {
  const clone = cleanClone((args) => {
    if (args[0] === "merge-base") return { status: 0, stdout: "base" };
    if (args[0] === "diff") {
      assert.ok(args.includes("--no-renames"));
      return { status: 0, stdout: "AGENTS.md\0docs/agents.md\0" };
    }
  });
  assert.deepEqual(Array.from(clone("remote", "token", "head", { remote: "base" }, "project").changed), ["AGENTS.md", "docs/agents.md"]);
  assert.equal(installed.at(-1), "clone");
});

test("failed or unavailable path measurements send no list", () => {
  for (const failure of ["baseline", "merge-base", "diff"]) {
    const clone = cleanClone((args) => ({ status: args[0] === failure ? 1 : 0, stdout: "" }));
    const result = clone("remote", "token", "head", failure === "baseline" ? null : { remote: "base" }, "project");
    assert.equal(JSON.stringify({ changedPaths: result.changed }), "{}");
  }
});

