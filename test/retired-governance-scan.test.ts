import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// t152: ControlPlane's governance is retired. A project record still stores
// its agents, execution rules and eligible list, for the pages and responses
// that show history, but no decision reads them. This scan counts the reads
// of those three fields off a policy in the source and fails on one in a file
// not listed here, so a new decision cannot start restricting claims, routing,
// review eligibility or change classes by what ControlPlane left behind.
// Would have caught: assertEligible, hasRole, changeClass, gate and the review
// rules each reading policy.agents, policy.execution or policy.eligible.

const ROOT = new URL("../", import.meta.url).pathname;
const files = (dir: string, ext: string[]): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(dir, e.name), ext) : ext.some((x) => e.name.endsWith(x)) ? [join(dir, e.name)] : []);

const READ = /\bpolicy\??\.(agents|execution|eligible)\b/g;

// What may still read them, and why.
const ALLOWED: Record<string, { reads: number; why: string }> = {
  "src/rules.ts": { reads: 1, why: "the merge comparison of an older acceptance's recorded eligible list, a warning overridable with --policy-changed-ok" },
  "src/ui.ts": { reads: 3, why: "the Settings page and the standing data show the stored policy as history; standing.controlPlane keeps its wire shape" },
  "cli/review-notice.mjs": { reads: 3, why: "a branch that names a local execution file as a rule's source; no rule names one now" },
};

test("no decision reads a policy's stored agents, execution rules or eligible list", () => {
  const found = new Map<string, number>();
  for (const file of [...files(join(ROOT, "src"), [".ts"]), ...files(join(ROOT, "cli"), [".mjs"])]) {
    const reads = readFileSync(file, "utf8").match(READ)?.length ?? 0;
    if (reads) found.set(relative(ROOT, file), reads);
  }
  assert.deepEqual(Object.fromEntries([...found].sort()), Object.fromEntries(Object.entries(ALLOWED).map(([file, a]) => [file, a.reads]).sort()),
    "a file reads a retired policy field; if it only shows it, list it in ALLOWED with the reason, and if it decides anything, remove the read");
});
