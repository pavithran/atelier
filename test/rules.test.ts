import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pushActors, assertHandoffTarget, assertReviewAllowed, agentOf, measuredPaths, changeClass, parseAgents, parseExecution, assertClaimable, evidenceAt, gate, globToRegExp, inboxFor, matchesAny, modelKey, modelOf, sameActor,
  assertClaimAllowed, assertEligible, checkFiles, foldPath, matchesFolded, overlappingLive, parseRuleError, pathCollisions, repoName, RuleError, scopesOverlap, validActor,
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

test("models compare without letter case or profile, and by the registry's id for a name it knows", () => {
  assert.equal(modelKey("opencode/GLM-5.3:studio-fast"), "glm-5.3");
  assert.equal(modelKey("antigravity/Claude-Opus-5-5"), "opus-5.5");
  assert.equal(modelKey("claude-code/claude-sonnet-5-5:fast"), "sonnet-5.5");
  assert.equal(modelKey("opencode/Qwen3-Coder-Next-4bit:studio-code"), "qwen3-coder-next-4bit");
  assert.equal(modelKey("opencode/GLM-5.3-Flash-4_8bit"), "glm-5.3-flash-4_8bit");
  assert.equal(modelKey("owner"), "owner");
  assert.ok(sameActor("claude-code/opus-5.5", "Claude-Code/OPUS-5.5:fast"));
  assert.ok(sameActor("claude-code/opus-5.5", "claude-code/claude-opus-5-5"));
  assert.ok(!sameActor("claude-code/opus-5.5", "codex/opus-5.5"));
  assert.ok(!sameActor("claude-code/opus-5.5", "claude-code/sonnet-5.5"));
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
  // Antigravity is its own agent where a policy names it, and Gemini by family otherwise.
  const withAntigravity = { ...governed.agents!, antigravity: governed.agents!.claude };
  assert.equal(agentOf("antigravity/gemini-3.1-pro", withAntigravity), "antigravity");
  assert.equal(agentOf("antigravity/gemini-3.1-pro", governed.agents!), "gemini");
  assert.equal(agentOf("antigravity/claude-opus-5-5", { claude: governed.agents!.claude }), "claude");
  // Antigravity also serves Claude: that model is never the policy's antigravity agent.
  assert.equal(agentOf("antigravity/claude-opus-5-5", withAntigravity), "claude");
  assert.equal(agentOf("antigravity/claude-opus-5-5", { antigravity: governed.agents!.claude }), null);
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

test("ungoverned gates count another model, or the owner, as independent", () => {
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

test("handoffs require an agent identity distinct from the project owner", () => {
  for (const actor of ["owner", "invented", "a/b/c", "a b/c", "codex/gpt-6"]) {
    assert.throws(() => assertHandoffTarget(actor, "codex/gpt-6"));
  }
  assert.doesNotThrow(() => assertHandoffTarget("codex/gpt-6", "owner"));
});

test("only owner credentials may review accepted work", () => {
  assert.throws(() => assertReviewAllowed(item({ state: "accepted" }), true), /403/);
  assert.doesNotThrow(() => assertReviewAllowed(item({ state: "accepted" }), false));
  assert.doesNotThrow(() => assertReviewAllowed(item(), true));
});

test("push contributors survive handoffs and include event observations", () => {
  const event = (kind: string, actor: string, data = {}) => ({ kind, actor, data });
  assert.deepEqual(pushActors([
    event("item.claimed", "codex/gpt-6"), event("push.observed", "atelier/events"),
    event("item.handoff", "codex/gpt-6", { to: "claude-code/opus-5.5" }),
    event("push.observed", "atelier/events"), event("push.observed", "claude-code/opus-5.5"),
    event("item.handoff", "owner", { to: "opencode/glm-5.3" }),
  ]), ["codex/gpt-6", "claude-code/opus-5.5", "opencode/glm-5.3"]);
});

test("holders remain contributors when Git pushes precede observation", () => {
  for (const kind of ["item.handoff", "item.released"]) {
    const contributors = pushActors([
      { kind: "item.claimed", actor: "codex/gpt-6", data: {} },
      { kind, actor: "owner", data: { from: "codex/gpt-6", to: "claude-code/opus-5.5" } },
      { kind: "push.observed", actor: "atelier/events", data: {} },
      { kind: "item.claimed", actor: "claude-code/opus-5.5", data: {} },
      { kind: "push.observed", actor: "opencode/glm-5.3", data: {} },
    ]);
    assert.ok(contributors.includes("codex/gpt-6"));
    assert.ok(contributors.includes("claude-code/opus-5.5"));
    assert.ok(contributors.includes("opencode/glm-5.3"));
    const held = item({ pushActors: contributors });
    const evidence = [pass({ changedPaths: ["AGENTS.md"] })];
    assert.equal(gate(held, policy, evidence, [review("codex/gpt-6")]).needsAssessor, true);
    assert.equal(gate(held, policy, evidence, [review("qwen/qwen3")]).ready, true);
  }
});

// Audit t105, finding F4: in a project without ControlPlane policy files the
// same model counted as its own independent reviewer under a profile suffix,
// another letter case or another name for it.
test("a contributor's model under another letter case, profile or registered name is not independent of it", () => {
  const touching = [pass({ changedPaths: ["AGENTS.md"] })];
  const studio = item({ owner: "opencode/glm-5.3:studio-code", pushActors: ["opencode/glm-5.3:studio-code"] });
  for (const by of ["opencode/glm-5.3:studio-fast", "zcode/GLM-5.3", "opencode/glm-5.3"]) {
    assert.deepEqual([by, gate(studio, policy, touching, [review(by)]).ready], [by, false]);
  }
  for (const by of ["codex/Opus-5.5", "codex/opus-5.5", "antigravity/claude-opus-5-5", "opencode/OPUS-5.5:local"]) {
    assert.deepEqual([by, gate(item(), policy, touching, [review(by)]).needsAssessor], [by, true]);
  }
  // Another model still counts, including another model of the same family.
  assert.equal(gate(studio, policy, touching, [review("opencode/GLM-5.3-Flash-4_8bit")]).ready, true);
  assert.equal(gate(item(), policy, touching, [review("codex/gpt-6-astra")]).ready, true);

  // Governed, coordinated: another spelling of a contributor is that
  // contributor; the same model in another harness is another agent.
  const coordinated = [pass({ changedPaths: ["src/a.ts"] })];
  assert.equal(gate(item(), governed, coordinated, [review("Claude-Code/OPUS-5.5:fast")]).ready, false);
  assert.equal(gate(item(), governed, coordinated, [review("claude-code/claude-opus-5-5")]).ready, false);
  assert.equal(gate(item(), governed, coordinated, [review("codex/opus-5.5")]).ready, true);

  // Governed, protected: a profile suffix never changes a model's family, nor
  // the agent its review is counted for.
  const anyAssessor: ProjectPolicy = { ...governed, agents: { ...governed.agents!, gemini: { available: true, eligible_roles: ["assessor"] } } };
  const qwen = item({ owner: "opencode/qwen3-coder:studio-code", pushActors: ["opencode/qwen3-coder:studio-code"] });
  assert.equal(agentOf("opencode/qwen3.8-27b:google-eval", anyAssessor.agents!), "qwen");
  assert.equal(gate(qwen, anyAssessor, touching, [review("opencode/qwen3.8-27b:google-eval")]).ready, false);
  assert.equal(gate(qwen, anyAssessor, touching, [review("codex/gpt-6-astra")]).ready, true);
});

test("review independence includes every contributor after a handoff", () => {
  const handed = item({ pushActors: ["codex/gpt-6", "opencode/glm-5.3"], owner: "claude-code/opus-5.5" });
  const evidence = [pass({ changedPaths: ["AGENTS.md"] })];
  for (const by of ["codex/gpt-6", "opencode/gpt-6", "opencode/glm-5.3"]) {
    assert.equal(gate(handed, policy, evidence, [review(by)]).ready, false);
  }
  assert.equal(gate(handed, policy, evidence, [review("qwen/qwen3")]).ready, true);
  assert.equal(gate(handed, governed, evidence, [review("codex/gpt-7")]).ready, false);
  assert.equal(gate(handed, governed, evidence, [review("qwen/qwen3")]).ready, true);
  assert.equal(gate(handed, governed, [pass()], [review("codex/gpt-6")]).ready, false);
  assert.equal(gate(handed, governed, evidence, [review("owner")]).ready, true);
});

// macOS's default disk stores names that differ only by letter case or
// Unicode form as one file, so the owner's checkout writes such a path over
// the protected file it aliases.
const defaults: ProjectPolicy = { checks: ["npm test", "./check.sh"], protected: ["AGENTS.md", "CLAUDE.md", "wrangler.*", "docs/caf\u00e9/**"] };

test("a path differing from a guarded path only by letter case or Unicode form is protected", () => {
  for (const path of [
    "claude.md", "Claude.MD", "Agents.MD", "agents.md", "Wrangler.jsonc", "WRANGLER.toml",
    "Package.json", "CHECK.sh",
    "AGENT\u017f.md",          // long s: the disk folds it to S
    "wrangler.j\u017fonc",
    "pac\u212aage.json",       // Kelvin sign: the disk folds it to k
    "docs/cafe\u0301/a.md",    // decomposed é under a precomposed protected directory
    "DOCS/CAF\u00c9/a.md",
  ]) assert.equal(changeClass([path], defaults), "protected", path);
  for (const path of ["claude.mdx", "src/CLAUDE.md", "docs/cafe/a.md", "AGENTS\u200c.md"]) assert.equal(changeClass([path], defaults), "coordinated", path);
  assert.equal(changeClass(["Docs/Secret/key"], governed), "protected");
  // Folding only adds: a path that matches as written still matches.
  assert.ok(matchesFolded("stra\u00dfe.md", ["stra?e.md"]));
});

test("an ungoverned gate asks for a review when claude.md stands in for CLAUDE.md", () => {
  const held = item({ scope: [], owner: "opencode/glm-5.3:studio-code", pushActors: ["opencode/glm-5.3:studio-code"] });
  const observed = defaults.checks.map((claim) => pass({ claim, changedPaths: ["claude.md"] }));
  const g = gate(held, defaults, observed, []);
  assert.deepEqual({ ready: g.ready, needsAssessor: g.needsAssessor }, { ready: false, needsAssessor: true });
  assert.equal(gate(held, defaults, observed, [review("owner")]).ready, true);
});

test("item scopes and the direct allow-list are matched as written", () => {
  // A variant path is not granted the direct class: it needs the review.
  assert.equal(changeClass(["docs/a.md"], governed), "direct");
  assert.equal(changeClass(["DOCS/a.md"], governed), "coordinated");
  // A variant path is reported outside the scope.
  assert.deepEqual(gate(item(), policy, [pass({ changedPaths: ["src/a.ts", "SRC/b.ts"] })], []).outOfScope, ["SRC/b.ts"]);
});

test("foldPath gives one spelling to the names a Mac's disk treats as one file", () => {
  for (const [a, b] of [
    ["CLAUDE.md", "claude.md"], ["caf\u00e9", "cafe\u0301"], ["CAF\u00c9", "cafe\u0301"], ["AGENTS.md", "AGENT\u017f.md"],
    ["package.json", "pac\u212aage.json"], ["strasse", "stra\u00dfe"], ["STRA\u1e9eE", "strasse"], ["file", "\ufb01le"],
    ["\u03a3\u039f\u03a6\u0399\u0391\u03a3", "\u03c3\u03bf\u03c6\u03b9\u03b1\u03c2"], ["\u212b", "\u00e5"],
  ]) assert.equal(foldPath(a), foldPath(b), `${a} ${b}`);
  // These stay apart on the disk too.
  for (const [a, b] of [["A.md", "\uff21.md"], ["CLAUDE.md", "CLA\u200cUDE.md"], ["a/b", "a-b"]]) assert.notEqual(foldPath(a), foldPath(b), `${a} ${b}`);
});

test("pathCollisions names each group of paths that would share one file, where the clash arises", () => {
  assert.deepEqual(pathCollisions(["CLAUDE.md", "README.md", "claude.md", "src/a.ts"]), [["CLAUDE.md", "claude.md"]]);
  assert.deepEqual(pathCollisions(["AGENTS.md", "AGENT\u017f.md", "caf\u00e9.md", "cafe\u0301.md"]), [["AGENTS.md", "AGENT\u017f.md"], ["caf\u00e9.md", "cafe\u0301.md"]]);
  // Directories clash too; the files under them are named by the directories' group.
  assert.deepEqual(pathCollisions(["Docs/a.md", "docs/a.md", "docs/b.md"]), [["Docs", "docs"]]);
  assert.deepEqual(pathCollisions(["docs/A.md", "docs/a.md"]), [["docs/A.md", "docs/a.md"]]);
  // A file and a directory of the same folded name are one name on the disk.
  assert.deepEqual(pathCollisions(["readme", "README/a.md"]), [["readme", "README"]]);
  assert.deepEqual(pathCollisions(["a.md", "b/a.md", "B.md"]), []);
});
