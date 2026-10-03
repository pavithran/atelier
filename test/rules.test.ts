import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertClaimable, evidenceAt, gate, globToRegExp, inboxFor, matchesAny, modelOf,
  assertClaimAllowed, assertEligible, checkFiles, overlappingLive, parseRuleError, repoName, RuleError, scopesOverlap,
  type Evidence, type Item, type ProjectPolicy, type Review,
} from "../src/rules.ts";

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const T = "2026-10-03T12:00:00.000Z";

function item(over: Partial<Item> = {}): Item {
  return {
    id: "t1", title: "Fix it", scope: ["src/**"], state: "submitted", owner: "claude-code/opus-5.5",
    fork: "proj--t1", base: "0".repeat(40), head: H1, acceptedHead: null,
    createdAt: T, updatedAt: T, lastPushAt: T, ...over,
  };
}
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md", "wrangler.*"] };
const pass = (over: Partial<Evidence> = {}): Evidence => ({
  itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: true,
  by: "claude-code/opus-5.5", at: T, changedPaths: ["src/a.ts"], ...over,
});

test("globs: ** crosses directories, * does not", () => {
  assert.ok(globToRegExp("src/**").test("src/a/b.ts"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("**/*.md").test("docs/x.md"));
  assert.ok(globToRegExp("**/*.md").test("x.md"));
  assert.ok(matchesAny("wrangler.jsonc", ["wrangler.*"]));
  assert.ok(!matchesAny("src/wrangler.jsonc", ["wrangler.*"]));
});

test("model is what makes a reviewer independent", () => {
  assert.equal(modelOf("claude-code/opus-5.5"), "opus-5.5");
  assert.equal(modelOf("owner"), "owner");
});

test("one owner: a second actor cannot claim an owned item", () => {
  assert.throws(() => assertClaimable(item({ state: "claimed" }), "codex/gpt-5.5"), /owned by claude-code/);
  assert.doesNotThrow(() => assertClaimable(item({ state: "claimed" }), "claude-code/opus-5.5"));
  assert.doesNotThrow(() => assertClaimable(item({ state: "open", owner: null }), "codex/gpt-5.5"));
  assert.throws(() => assertClaimable(item({ state: "merged", owner: null }), "codex/gpt-5.5"), /merged/);
});

test("rule errors survive a trip through a plain message", () => {
  const parsed = parseRuleError(new Error(new RuleError("owned", "t1 is owned | by x", 409).message));
  assert.deepEqual(parsed, { status: 409, code: "owned", detail: "t1 is owned | by x" });
  assert.equal(parseRuleError(new Error("boom")), null);
});

test("a required check is pending until observed at the current head", () => {
  const v = evidenceAt(policy, [pass({ head: H2 })], H1);
  assert.deepEqual(v.checks, [{ claim: "npm test", grade: "pending", passed: null }]);
  assert.equal(v.changedPaths, null);
});

test("a report never satisfies a check", () => {
  const report: Evidence = { itemId: "t1", claim: "npm test", grade: "reported", head: H1, passed: null, by: "x/y", at: T };
  const g = gate(item(), policy, [report], []);
  assert.equal(g.ready, false);
  assert.match(g.blockers.join(), /not yet observed/);
});

test("observed pass at head with ordinary paths is ready", () => {
  const g = gate(item(), policy, [pass()], []);
  assert.deepEqual(g, { ready: true, blockers: [], needsAssessor: false, outOfScope: [] });
});

test("the latest observation at a head wins", () => {
  const g = gate(item(), policy, [pass(), pass({ passed: false, at: "2026-10-03T13:00:00.000Z" })], []);
  assert.match(g.blockers.join(), /failed when observed/);
});

test("protected paths need a different model or the project owner", () => {
  const touching = pass({ changedPaths: ["AGENTS.md"] });
  const sameModel: Review = { itemId: "t1", by: "other-harness/opus-5.5", head: H1, approve: true, note: "", at: T };
  const otherModel: Review = { ...sameModel, by: "codex/gpt-5.5" };
  const owner: Review = { ...sameModel, by: "owner" };
  const renamed: Review = { ...sameModel, by: "pavi" };
  const stale: Review = { ...otherModel, head: H2 };
  assert.equal(gate(item(), policy, [touching], []).needsAssessor, true);
  assert.equal(gate(item(), policy, [touching], [sameModel]).ready, false);
  assert.equal(gate(item(), policy, [touching], [stale]).ready, false);
  assert.equal(gate(item(), policy, [touching], [otherModel]).ready, true);
  assert.equal(gate(item(), policy, [touching], [owner]).ready, true);
  // A deployment that names its owner "pavi" accepts that actor, and only that one.
  assert.equal(gate(item(), policy, [touching], [renamed]).ready, false);
  assert.equal(gate(item(), policy, [touching], [renamed], "pavi").ready, true);
});

test("a rejection at the head blocks", () => {
  const no: Review = { itemId: "t1", by: "codex/gpt-5.5", head: H1, approve: false, note: "breaks iOS", at: T };
  assert.match(gate(item(), policy, [pass()], [no]).blockers.join(), /breaks iOS/);
});

test("changes outside scope are surfaced, not blocked", () => {
  const g = gate(item(), policy, [pass({ changedPaths: ["src/a.ts", "docs/b.md"] })], []);
  assert.equal(g.ready, true);
  assert.deepEqual(g.outOfScope, ["docs/b.md"]);
});

test("scope overlap is conservative", () => {
  assert.ok(scopesOverlap(["src/**"], ["src/ui/**"]));
  assert.ok(!scopesOverlap(["src/**"], ["docs/**"]));
  assert.ok(scopesOverlap([], ["docs/**"]));
});

test("inbox: decisions outrank the owner's problems", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  const items = [
    item({ id: "t1" }),
    item({ id: "t2", title: "Failing", scope: ["lib/**"] }),
    item({ id: "t3", title: "Idle", state: "claimed", scope: ["docs/**"], lastPushAt: "2026-10-03T00:00:00.000Z" }),
    item({ id: "t4", title: "Done", state: "accepted", scope: ["x/**"] }),
  ];
  const ev = [pass({ itemId: "t1" }), pass({ itemId: "t2", passed: false, changedPaths: ["lib/a.ts"] })];
  const kinds = inboxFor("proj", items, policy, ev, [], now).map((x) => `${x.itemId}:${x.kind}`);
  assert.deepEqual(kinds, ["t1:accept", "t4:merge", "t3:stale", "t2:failing"]);
});

test("inbox flags live items whose scopes overlap", () => {
  const items = [item({ id: "t1", state: "claimed" }), item({ id: "t2", state: "claimed", owner: "codex/gpt-5.5", scope: ["src/ui/**"] })];
  const out = inboxFor("proj", items, policy, [], [], new Date(T));
  assert.deepEqual(out.map((x) => x.kind), ["overlap"]);
  assert.match(out[0].reason, /t2 \(codex\/gpt-5.5\)/);
});

test("repo names are safe and stable", () => {
  assert.equal(repoName("ikon weblog"), "ikon-weblog");
  assert.equal(repoName("HQPe-Control", "t12"), "hqpe-control--t12");
  assert.throws(() => repoName("---"), /cannot make a repo name/);
});

test("files named by a check are protected: an item cannot weaken its own grader", () => {
  assert.deepEqual(checkFiles(["./check.sh", "npm test", "node scripts/verify.mjs --strict", "pytest -q tests/"]), ["check.sh", "package.json", "scripts/verify.mjs"]);
  assert.deepEqual(checkFiles(["grep -q export src/a.ts"]), []);
  assert.deepEqual(checkFiles(["npm ci --prefer-offline && npm test", "npm run check && npm run build"]), ["package.json"]);
  const p: ProjectPolicy = { checks: ["./check.sh"], protected: [] };
  const g = gate(item({ scope: [] }), p, [pass({ claim: "./check.sh", changedPaths: ["check.sh"] })], []);
  assert.equal(g.needsAssessor, true);
  assert.equal(g.ready, false);
});

test("eligibility follows ControlPlane's agent families; the project owner always qualifies", () => {
  const p: ProjectPolicy = { checks: [], protected: [], eligible: ["claude", "codex", "glm"] };
  assert.doesNotThrow(() => assertEligible("claude-code/opus-5.5", p));
  assert.doesNotThrow(() => assertEligible("codex/gpt-5.5", p));
  assert.doesNotThrow(() => assertEligible("owner", p));
  assert.doesNotThrow(() => assertEligible("pavi", p, "pavi"));
  assert.throws(() => assertEligible("pavi", p), /not an eligible agent/);
  assert.throws(() => assertEligible("antigravity/gemini-3", p), /not an eligible agent/);
  assert.throws(() => assertEligible("claudette/x", p), /not an eligible agent/);
  assert.doesNotThrow(() => assertEligible("anything/x", { checks: [], protected: [] }));
});

test("overlapping claims are refused when the project says so, and only then", () => {
  const held = item({ id: "t1", state: "claimed", owner: "codex/gpt-5.5", scope: ["src/**"] });
  const want = item({ id: "t2", state: "open", owner: null, scope: ["src/ui/**"] });
  const apart = item({ id: "t3", state: "open", owner: null, scope: ["docs/**"] });
  const all = [held, want, apart];
  const strict: ProjectPolicy = { checks: [], protected: [], refuseOverlap: true };
  assert.deepEqual(overlappingLive(want, all, "claude-code/opus-5.5").map((i) => i.id), ["t1"]);
  assert.throws(() => assertClaimAllowed(want, all, strict, "claude-code/opus-5.5"), /overlaps live t1 \(codex\/gpt-5.5\)/);
  assert.doesNotThrow(() => assertClaimAllowed(apart, all, strict, "claude-code/opus-5.5"));
  assert.doesNotThrow(() => assertClaimAllowed(want, all, { checks: [], protected: [] }, "claude-code/opus-5.5"));
  // The holder of the overlapping item may take a second overlapping item.
  assert.doesNotThrow(() => assertClaimAllowed(want, all, strict, "codex/gpt-5.5"));
  const unscoped = item({ id: "t4", state: "open", owner: null, scope: [] });
  assert.throws(() => assertClaimAllowed(unscoped, [...all, unscoped], strict, "glm/glm-4.6"), /unscoped item overlaps everything/);
});

test("under sandboxOnly, only checks the Worker observed in a sandbox count", () => {
  const strict: ProjectPolicy = { ...policy, sandboxOnly: true };
  const local = pass();                                   // posted by the CLI: where is absent, so "runner"
  const cloud = pass({ where: "sandbox", by: "atelier/sandbox" });
  assert.equal(gate(item(), policy, [local], []).ready, true);
  const g = gate(item(), strict, [local], []);
  assert.equal(g.ready, false);
  assert.match(g.blockers.join(), /not yet observed/);
  assert.equal(gate(item(), strict, [local, cloud], []).ready, true);
  assert.deepEqual(evidenceAt(strict, [cloud], H1).checks, [{ claim: "npm test", grade: "observed", passed: true, where: "sandbox" }]);
  assert.equal(evidenceAt(policy, [local], H1).checks[0].where, "runner");
});
