import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentOf, measuredPaths, changeClass, parseAgents, parseExecution, assertClaimable, evidenceAt, gate, globToRegExp, inboxFor, matchesAny, modelOf,
  assertClaimAllowed, assertEligible, checkFiles, overlappingLive, parseRuleError, repoName, RuleError, scopesOverlap, validActor,
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

test("gc removes only clean workspaces at their confirmed merged head", async () => {
  const { gcWorkspaceReason } = await import("../src/rules.ts");
  assert.equal(gcWorkspaceReason(item({ state: "merged", acceptedHead: H1 }), H1, false, false), null);
  for (const state of ["open", "claimed", "submitted", "accepted", "abandoned"] as const) {
    assert.match(gcWorkspaceReason(item({ state, acceptedHead: H1 }), H1, false, false)!, /not confirmed merged/);
  }
  assert.ok(gcWorkspaceReason(undefined, H1, false, false));
  assert.ok(gcWorkspaceReason(item({ state: "merged" }), H1, false, false));
  assert.ok(gcWorkspaceReason(item({ state: "merged", acceptedHead: H2 }), H1, false, false));
  assert.ok(gcWorkspaceReason(item({ state: "merged", acceptedHead: H1 }), H1, true, false));
  assert.ok(gcWorkspaceReason(item({ state: "merged", acceptedHead: H1 }), H1, false, true));
});

test("gc requires an expired check record and no live process", async () => {
  const { gcCheckReason, GC_CHECK_AGE_MS } = await import("../src/rules.ts");
  const now = Date.now(), old = now - GC_CHECK_AGE_MS;
  assert.equal(gcCheckReason(old, false, now), null);
  assert.ok(gcCheckReason(old, true, now));
  assert.ok(gcCheckReason(old + 1, false, now));
  for (const age of [undefined, "yesterday", NaN, Infinity, now + 1]) assert.ok(gcCheckReason(age, false, now));
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

test("decisions reject stale revisions and retain the latest review from each reviewer", async () => {
  const { assertRevision, latestReviews, decisionFor } = await import('../src/rules.ts');
  assert.throws(()=>assertRevision(item(),''),/refresh the task/);
  assert.throws(()=>assertRevision(item(),H2),/changed since/);
  assert.doesNotThrow(()=>assertRevision(item(),H1));
  const no: Review={itemId:'t1',head:H1,by:'owner',approve:false,note:'Fix it',at:T};
  const yes: Review={...no,approve:true,at:'2026-10-03T13:00:00Z'};
  assert.deepEqual(latestReviews([no,yes],H1),[yes]);
  assert.equal(gate(item(),policy,[pass()],[no,yes]).ready,true);
  assert.equal(decisionFor(item({state:'merged'}),policy,[],[]).action,'none');
  assert.equal(decisionFor(item(),policy,[pass({passed:false})],[]).title,'Checks need attention');
});

test("push notices admit only valid branch updates in the configured namespace", async () => {
  const {pushNotice}=await import('../src/rules.ts');
  const notice={type:'cf.artifacts.repo.pushed',source:{namespace:'atelier',repoName:'project--t1'},payload:{ref:'refs/heads/main',after:H1}};
  assert.deepEqual(pushNotice(notice),{repo:'project--t1',ref:'refs/heads/main',after:H1});
  for(const bad of [null,{}, {...notice,type:'other'}, {...notice,source:{...notice.source,namespace:'other'}},{...notice,payload:{ref:'refs/tags/v1',after:H1}},{...notice,payload:{ref:'refs/heads/main',after:'0'.repeat(40)}}])assert.equal(pushNotice(bad),null);
});

test("actor names allow a :profile suffix on the model, never on the harness", () => {
  assert.ok(validActor("opencode/Qwen3-Coder-Next-4bit:studio-code"));
  assert.ok(validActor("pavi"));
  assert.equal(validActor("open:code/glm"), false);
  assert.equal(validActor("opencode/mlx-community/Qwen3"), false);
});

const governed: ProjectPolicy = {
  ...policy,
  agents: {
    claude: { available: true, eligible_roles: ["executor", "assessor"] },
    codex: { available: true, eligible_roles: ["executor", "assessor"] },
    glm: { available: true, eligible_roles: ["executor"] },
    gemini: { available: false, eligible_roles: ["executor", "assessor"] },
    qwen: { available: true, eligible_roles: ["assessor"], preferred_roles: ["executor"] },
  },
  execution: {
    allowed_classes: ["direct", "coordinated", "protected"],
    direct: { enabled: true, allowed_path_patterns: ["docs/**"] },
    protected_path_patterns: ["docs/secret/**"],
  },
};
const review = (by: string, over: Partial<Review> = {}): Review => ({ itemId: "t1", by, head: H1, approve: true, note: "", at: T, ...over });

test("ControlPlane actor mapping uses harness aliases and listed model families", () => {
  for (const [actor, name] of [
    ["claude-code/opus-5.5", "claude"], ["codex/gpt-6-astra", "codex"],
    ["zcode/anything", "glm"], ["opencode/GLM-5.3:local", "glm"],
    ["opencode/sonnet-5.5", "claude"], ["gemini-cli/gemini-3", "gemini"],
    ["opencode/qwen3-coder", "qwen"], ["other/deepseek-v4", null],
    ["opencode/unknown", null], ["owner", null],
  ]) assert.equal(agentOf(actor!, governed.agents!), name);
  assert.equal(agentOf("codex/gpt-6", {}), null);
  assert.equal(agentOf("opencode/gpt-6", { openai: governed.agents!.codex }), "openai");
});

test("claims and handoff eligibility require an available executor, not a preferred role", () => {
  const open = item({ state: "open", owner: null });
  for (const actor of ["opencode/qwen3", "gemini-cli/gemini-3", "other/unknown", "owner"]) {
    assert.throws(() => assertClaimAllowed(open, [], governed, actor), /executor role/);
    assert.throws(() => assertEligible(actor, governed), /executor role/);
  }
  assert.doesNotThrow(() => assertClaimAllowed(open, [], governed, "opencode/glm-5.3"));
  assert.throws(() => assertClaimAllowed(open, [], { ...governed, agents: {} }, "codex/gpt-6"), /executor role/);
});

test("changed paths take the strictest class and retain implicit check protection", () => {
  for (const [paths, kind] of [
    [["docs/a.md"], "direct"], [["src/a.ts"], "coordinated"],
    [["docs/a.md", "src/a.ts"], "coordinated"],
    [["docs/a.md", "docs/secret/key"], "protected"],
    [["src/a.ts", "AGENTS.md"], "protected"], [["package.json"], "protected"],
  ] as [string[], string][]) assert.equal(changeClass(paths, governed), kind);
  assert.equal(changeClass(["docs/a.md"], { ...governed, execution: { ...governed.execution!, direct: { enabled: false, allowed_path_patterns: ["**"] } } }), "coordinated");
});

test("direct needs no review, coordinated needs another actor, protected needs another family", () => {
  const direct = [pass({ changedPaths: ["docs/a.md"] })];
  const coordinated = [pass()];
  const protectedChange = [pass({ changedPaths: ["AGENTS.md"] })];
  assert.equal(gate(item(), governed, direct, []).ready, true);
  assert.equal(gate(item(), governed, coordinated, []).needsAssessor, true);
  assert.equal(gate(item(), governed, coordinated, [review(item().owner!)]).ready, false);
  assert.equal(gate(item(), governed, coordinated, [review("claude-code/sonnet-5.5")]).ready, true);
  assert.equal(gate(item(), governed, protectedChange, [review("claude-code/sonnet-5.5")]).ready, false);
  assert.equal(gate(item(), governed, protectedChange, [review("opencode/opus-5.5")]).ready, false);
  assert.equal(gate(item(), governed, protectedChange, [review("codex/gpt-6")]).ready, true);
  assert.equal(gate(item(), governed, protectedChange, [review("owner")]).ready, true);
  assert.equal(gate(item(), governed, protectedChange, [review("codex/gpt-6", { head: H2 })]).ready, false);
});

test("reviews without an available assessor role do not approve or reject the gate", () => {
  for (const by of ["opencode/glm-5.3", "gemini-cli/gemini-3", "other/unknown"]) {
    assert.equal(gate(item(), governed, [pass()], [review(by)]).ready, false);
    assert.equal(gate(item(), governed, [pass()], [review("codex/gpt-6"), review(by, { approve: false })]).ready, true);
  }
  assert.equal(gate(item(), governed, [pass()], [review("codex/gpt-6"), review("codex/gpt-6", { approve: false, at: "2026-10-04" })]).ready, false);
});

test("disallowed classes block even with approval; missing paths do not imply direct", () => {
  const p = { ...governed, execution: { ...governed.execution!, allowed_classes: [] } };
  for (const path of ["docs/a.md", "src/a.ts", "AGENTS.md"]) {
    assert.match(gate(item(), p, [pass({ changedPaths: [path] })], [review("codex/gpt-6")]).blockers.join(), /not allowed/);
  }
  const g = gate(item(), governed, [], []);
  assert.equal(g.changeClass, null);
  assert.equal(g.ready, false);
  assert.match(g.requirement!, /pending/);
});

test("policy parsing rejects malformed roles and execution rules", () => {
  assert.deepEqual(parseAgents(governed.agents), governed.agents);
  assert.deepEqual(parseExecution(governed.execution), governed.execution);
  for (const value of [null, [], { codex: { available: "yes", eligible_roles: ["executor"] } }, { codex: { available: true, eligible_roles: ["admin"] } }]) assert.throws(() => parseAgents(value), /400\|bad_policy/);
  for (const value of [null, {}, { ...governed.execution, allowed_classes: ["unknown"] }, { ...governed.execution, direct: { enabled: "true", allowed_path_patterns: [] } }]) assert.throws(() => parseExecution(value), /400\|bad_policy/);
});

test("ungoverned gates retain exact-model independence and owner review", () => {
  assert.equal(gate(item(), policy, [pass()], []).ready, true);
  assert.equal(gate(item(), policy, [pass({ changedPaths: ["AGENTS.md"] })], [review("claude-code/sonnet-5.5")]).ready, true);
  assert.equal(gate(item(), policy, [pass({ changedPaths: ["AGENTS.md"] })], [review("owner")]).ready, true);
  assert.equal(gate(item(), policy, [pass()], []).changeClass, undefined);
});


test("empty governed changes have no class and nothing to merge", () => {
  assert.equal(changeClass([], governed), null);
  const g = gate(item(), governed, [pass({ changedPaths: [] })], []);
  assert.equal(g.changeClass, null);
  assert.equal(g.ready, false);
  assert.match(g.blockers.join(), /nothing to merge/);
  assert.equal(gate(item(), policy, [pass({ changedPaths: [] })], []).ready, true);
});

test("sandbox path measurements outrank newer runner measurements", () => {
  const evidence = [pass({ where: "sandbox", changedPaths: ["AGENTS.md"] }), pass({ where: "runner", at: "2026-10-05", changedPaths: ["docs/a.md"] })];
  assert.equal(gate(item(), governed, evidence, []).changeClass, "protected");
  assert.equal(gate(item(), governed, evidence.reverse(), []).ready, false);
});

test("project owner reviews count under role policy for every class", () => {
  for (const owner of ["owner", "pavi"]) for (const path of ["docs/a.md", "src/a.ts", "AGENTS.md"]) {
    const evidence = [pass({ changedPaths: [path] })];
    assert.equal(gate(item(), governed, evidence, [review(owner)], owner).ready, true);
    const g = gate(item(), governed, evidence, [review("codex/gpt-6"), review(owner, { approve: false })], owner);
    assert.equal(g.ready, false);
    assert.match(g.blockers.join(), new RegExp(`rejected by ${owner}`));
  }
});

test("non-array path measurements remain unmeasured", () => {
  for (const changedPaths of [undefined, null, "docs/a.md", {}]) {
    const evidence = [pass({ changedPaths } as Partial<Evidence>)];
    assert.equal(evidenceAt(governed, evidence, H1).changedPaths, null);
    assert.match(gate(item(), governed, evidence, []).blockers.join(), /changed paths not yet observed/);
  }
});


test("path input preserves an empty measurement and rejects malformed input", () => {
  for (const value of [undefined, null, "docs/a.md", {}, [null], [1]]) assert.equal(measuredPaths(value), null);
  assert.deepEqual(measuredPaths([]), []);
  assert.deepEqual(measuredPaths(["AGENTS.md", "docs/agents.md"]), ["AGENTS.md", "docs/agents.md"]);
});
