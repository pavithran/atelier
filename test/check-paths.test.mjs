import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../cli/atelier.mjs", import.meta.url), "utf8");
function cleanClone(git) {
  const code = source.slice(source.indexOf("function cleanClone("), source.indexOf("async function runCheck("));
  return runInNewContext(`${code}; cleanClone`, {
    git, CACHE: "cache", mkdirSync() {}, mkdtempSync: () => "clone", writeFileSync() {},
    join: (...parts) => parts.join("/"), markerPath: (dir) => dir, process: { pid: 1 }, auth: () => [],
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
});

test("failed or unavailable path measurements send no list", () => {
  for (const failure of ["baseline", "merge-base", "diff"]) {
    const clone = cleanClone((args) => ({ status: args[0] === failure ? 1 : 0, stdout: "" }));
    const result = clone("remote", "token", "head", failure === "baseline" ? null : { remote: "base" }, "project");
    assert.equal(JSON.stringify({ changedPaths: result.changed }), "{}");
  }
});

test("landing receipts record the computed class with the legacy fallback", () => {
  const code = source.slice(source.indexOf("function writeReceipt("), source.indexOf("function writeReceipt(") + source.slice(source.indexOf("function writeReceipt(")).indexOf("\n}\n") + 3);
  for (const kind of ["direct", "protected", "coordinated", undefined]) {
    let receipt;
    const write = runInNewContext(`${code}; writeReceipt`, {
      join: (...parts) => parts.join("/"), existsSync: () => true, readJson: () => ({}),
      short: (s) => s.slice(0, 8), OWNER_NAME: "owner", writeFileSync: (_, text) => { receipt = JSON.parse(text); },
    });
    write("checkout", { name: "p", id: "t1", item: { acceptedHead: "a".repeat(40) }, owners: [], view: [], reviews: [], policy: {}, branch: "main", changeClass: kind });
    assert.equal(receipt.execution_class, kind ?? "coordinated");
  }
  assert.match(source, /writeReceipt\(cwd,\{[^\n]*changeClass:d\.gate\.changeClass/);
});
