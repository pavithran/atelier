import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// t394: single-family mode is enforced where work is assigned, not at one
// entry point. Every assignment passes assertEligible, which judges the
// company first (src/rules.ts); every dispatch stored passes setDispatch,
// which judges the model it names (src/ledger.ts); a review request is bound
// to its reviewer only by bindReview, which judges the reviewer's company.
// This scan reads the source for the writes that assign work to a model and
// fails on one in a method not listed here, so a new path is reviewed for
// the mode before it lands, and on a listed one that no longer passes its
// check.

const SRC = new URL("../src/", import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);

// Each method of the Ledger class, by name, with its body, as the source
// lays it out: a member at two spaces' indent through the "  }" closing it.
function methods(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = source.split("\n");
  let name: string | null = null, body: string[] = [];
  for (const line of lines) {
    const m = /^  (?:(?:private|async|static|public|protected) )*([A-Za-z_]\w*)\s*(?:<[^(]*>)?\(.*\{\s*$/.exec(line);
    if (m && !["if", "for", "while", "switch"].includes(m[1])) { name = m[1]; body = []; }
    if (name) body.push(line);
    if (name && line === "  }") { out.set(name, (out.get(name) ?? "") + body.join("\n")); name = null; }
  }
  return out;
}

// The method a line at `index` belongs to.
function enclosing(source: string, index: number): string | null {
  let found: string | null = null;
  for (const line of source.slice(0, index).split("\n")) {
    const m = /^  (?:(?:private|async|static|public|protected) )*([A-Za-z_]\w*)\s*(?:<[^(]*>)?\(.*\{\s*$/.exec(line);
    if (m && !["if", "for", "while", "switch"].includes(m[1])) found = m[1];
  }
  return found;
}

const ledger = readFileSync(join(SRC, "ledger.ts"), "utf8");
const body = methods(ledger);
const sites = (pattern: RegExp) => [...ledger.matchAll(new RegExp(pattern, "g"))].map((m) => enclosing(ledger, m.index!));
const passes = (method: string, check: string) => assert.ok(body.get(method)?.includes(check), `${method} no longer passes ${check}`);

test("assertEligible judges the company before any role, admission or harness rule can let an actor through", () => {
  const rules = readFileSync(join(SRC, "rules.ts"), "utf8");
  const start = rules.indexOf("export function assertEligible(");
  const fn = rules.slice(start, rules.indexOf("\n}\n", start));
  const check = fn.indexOf("if (actor !== owner) assertSingleFamily(");
  assert.ok(check > 0, "assertEligible no longer judges the company");
  for (const exit of ["return", "throw"]) assert.ok(fn.indexOf(exit) > check, `assertEligible can ${exit} before it judges the company`);
});

test("a dispatch is stored only through setDispatch, which judges the model it names", () => {
  // Any file: a dispatch written elsewhere would be stored unjudged.
  const writes = files(SRC).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/SET dispatch = \?/g)].map(() => f.slice(SRC.length)));
  assert.deepEqual(writes, ["ledger.ts"], "a dispatch is written outside the Ledger");
  assert.deepEqual(sites(/SET dispatch = \?/), ["setDispatch"], "a dispatch is written outside setDispatch; route it through setDispatch");
  passes("setDispatch", "assertSingleFamily(");
});

test("a task's owner is set only by a claim or a handoff, both passing assertEligible", () => {
  assert.deepEqual([...new Set(sites(/this\.update\([^)]*\{ owner: (?!null)/))].sort(), ["claim", "handoff", "unclaim"], "a new path sets a task's owner; check it with assertEligible and list it here");
  passes("claim", "assertClaimAllowed(");
  passes("handoffAllowed", "assertEligible(");
  passes("handoff", "this.handoffAllowed(");
  // unclaim (from main, 639ffa5) assigns no one: a claim that failed late is
  // rolled back to the owner saved before it, which a claim or a handoff
  // already judged. It must restore only that saved owner.
  assert.deepEqual(body.get("unclaim")?.match(/\{ owner: [^,]+/g), ["{ owner: prior.owner"], "unclaim sets an owner other than the one saved before the failed claim");
  passes("unclaim", "`claim-rollback:${id}`");
});

test("a plan's planner and a part's builder are named only through namedActor, which passes assertEligible", () => {
  assert.deepEqual([...new Set(sites(/record\.planner = |record\.reroutes\[[^\]]*\] = /))].sort(), ["addMergeMain", "reroutePlan"], "a new path names a plan's planner or a part's builder; check it with namedActor and list it here");
  passes("reroutePlan", "namedActor(");
  // addMergeMain's `to` is the builder resolveAllowed named.
  passes("resolveAllowed", "namedActor(");
  passes("newPlan", "namedActor(");
  passes("newPlan", "pickPlanner(");
  const state = readFileSync(join(SRC, "plans/state.ts"), "utf8");
  for (const fn of ["export function namedActor(", "export function pickPlanner("]) {
    const from = state.indexOf(fn);
    assert.ok(state.slice(from, state.indexOf("\n}\n", from)).includes("assertEligible("), `${fn} no longer passes assertEligible`);
  }
  // Routes fixed at approval are read as the mode in force allows them.
  assert.match(body.get("tick") ?? "", /companyRoute\(rerouted\(r, record\), singleFamily\(/);
});

test("a review request is bound to its reviewer only by bindReview, which judges the reviewer's company", () => {
  assert.deepEqual(sites(/SET state = 'claimed', claimedBy = \?/), ["bindReview", "claimCriteriaReview"], "a new path binds a review request; judge the reviewer's company and list it here");
  passes("bindReview", "companyRefusal(");
  // A criteria review (t438) is bound by its own claim, which judges the
  // company through criteriaIndependenceRefusal under the mode in force.
  passes("claimCriteriaReview", "criteriaIndependenceRefusal(actor, row.authors, this.owner, singleFamily(");
  const criteria = readFileSync(join(SRC, "review/criteria.ts"), "utf8");
  const from = criteria.indexOf("export function criteriaIndependenceRefusal(");
  assert.ok(criteria.slice(from, criteria.indexOf("\n}\n", from)).includes("companyRefusal(reviewer, single)"), "criteriaIndependenceRefusal no longer judges the company");
  passes("claimReview", "this.bindReview(");
  // Every place a request is made, open for a claim; a new one is listed
  // here once it is shown to ask only a reviewer the mode allows, or to
  // leave the company to the bind.
  assert.deepEqual([...new Set(sites(/INSERT INTO review_requests/))].sort(), [
    "askTierReview", "reaskForCriteria", "reaskReview", "replaceReviewClaim", "requestReview", "reviewTick",
  ], "a new path makes a review request; list it here once its reviewer is checked for the mode");
  passes("reaskForCriteria", "companyRefusal(");
  passes("reaskReview", "companyRefusal(");
  passes("initProject", "this.withdrawForeignRequests(");
  passes("initProject", "this.withdrawForeignDispatches(");
});
