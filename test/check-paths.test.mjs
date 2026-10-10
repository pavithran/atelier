import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The helpers are exported for the command modules (cli/commands/); a slice
// of them runs here as a script, so without the keyword.
const source = readFileSync(new URL("../cli/atelier.mjs", import.meta.url), "utf8").replace(/^export (?=(async )?function |const |let )/gm, "");
const mergeSource = readFileSync(new URL("../cli/commands/merge.mjs", import.meta.url), "utf8");
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
      join: (...parts) => parts.join("/"), lstatSync: () => ({ isDirectory: () => true, isFile: () => true }), readJson: () => ({}),
      RECEIPTS_DIR: "docs/control-plane/landing-receipts", RECEIPT_TEMPLATE: "docs/control-plane/landing-receipt.v1.json", fsConstants: constants,
      short: (s) => s.slice(0, 8), OWNER_NAME: "owner", writeFileSync: (_, text) => { receipt = JSON.parse(text); },
    });
    write("checkout", { name: "p", id: "t1", item: { acceptedHead: "a".repeat(40) }, owners: [], view: [], reviews: [], policy: {}, branch: "main", changeClass: kind });
    assert.equal(receipt.execution_class, kind ?? "coordinated");
  }
  assert.match(mergeSource, /writeReceipt\(cwd,\{[^\n]*changeClass:d\.gate\.changeClass/);
});

// PAVI's decision, 2026-10-06: an override is recorded with its reason, so a
// landing receipt never says no review was required when one was overridden.
test("landing receipts record the owner's override of the independent review at the accepted head", () => {
  const code = source.slice(source.indexOf("function writeReceipt("), source.indexOf("function writeReceipt(") + source.slice(source.indexOf("function writeReceipt(")).indexOf("\n}\n") + 3);
  const head = "a".repeat(40);
  const receiptFor = (item, reviews = []) => {
    let receipt;
    const write = runInNewContext(`${code}; writeReceipt`, {
      join: (...parts) => parts.join("/"), lstatSync: () => ({ isDirectory: () => true, isFile: () => true }), readJson: () => ({}),
      RECEIPTS_DIR: "docs/control-plane/landing-receipts", RECEIPT_TEMPLATE: "docs/control-plane/landing-receipt.v1.json", fsConstants: constants,
      short: (s) => s.slice(0, 8), OWNER_NAME: "Pavi", writeFileSync: (_, text) => { receipt = JSON.parse(text); },
    });
    write("checkout", { name: "p", id: "t1", item, owners: [], view: [], reviews, policy: {}, branch: "main", changeClass: "protected" });
    return receipt.delivery.evidence;
  };
  const reviewOverride = { head, by: "owner", reason: "No model of another family is available.", at: "2026-10-06T12:00:00.000Z" };
  const overridden = receiptFor({ acceptedHead: head, reviewOverride });
  assert.match(overridden, /Pavi overrode the independent review at the accepted head: No model of another family is available\./);
  assert.doesNotMatch(overridden, /No review was required/);
  const owned = receiptFor({ acceptedHead: head, reviewOverride }, [{ by: "owner", approve: true }]);
  assert.match(owned, /Reviews at the accepted head: owner approved\. Pavi overrode the independent review/);
  // An override at another head is not this acceptance's.
  assert.match(receiptFor({ acceptedHead: head, reviewOverride: { ...reviewOverride, head: "b".repeat(40) } }), /No review was required at the accepted head\./);
});
