import { test } from "node:test";
import assert from "node:assert/strict";
import { checkApplies, evidenceAt, gate, parseRuleError, type Evidence, type Item, type ProjectPolicy } from "../src/rules.ts";
import { adapterCheckPaths, appliesReason, appliesText, fromFnmatch, parseCheckPaths, settleCheckPaths } from "../src/checks.ts";
import { briefFor } from "../src/brief.ts";

// A check can apply only when an item's changed paths match its globs. The
// gate requires it exactly then and lists it as not applicable otherwise,
// and init imports the globs from a ControlPlane adapter's change_rules.

const H1 = "a".repeat(40);
const T = "2026-10-06T12:00:00.000Z";
const item = (over: Partial<Item> = {}): Item => ({
  id: "t1", title: "Edit", scope: [], state: "submitted", owner: "claude-code/opus-5.5",
  fork: "p--t1", base: "0".repeat(40), head: H1, acceptedHead: null, createdAt: T, updatedAt: T, lastPushAt: T, ...over,
});
const policy: ProjectPolicy = {
  checks: ["npm test", "xcodebuild build"],
  checkPaths: [{ command: "xcodebuild build", paths: ["App/**", "project.yml"] }],
  protected: [],
};
const observed = (claim: string, over: Partial<Evidence> = {}): Evidence => ({
  itemId: "t1", claim, grade: "observed", head: H1, passed: true, by: "atelier/sandbox", at: T, changedPaths: ["docs/a.md"], where: "sandbox", ...over,
});
const refusedWith = (fn: () => unknown) => {
  try { fn(); } catch (err) { return parseRuleError(err); }
  assert.fail("expected a refusal");
};

test("a check with paths applies exactly when a changed path matches one, whatever its letter case; one without applies to every change", () => {
  assert.equal(checkApplies(policy, "npm test", ["docs/a.md"]), true);
  assert.equal(checkApplies(policy, "npm test", null), true);
  assert.equal(checkApplies(policy, "xcodebuild build", ["docs/a.md"]), false);
  assert.equal(checkApplies(policy, "xcodebuild build", ["docs/a.md", "App/View.swift"]), true);
  assert.equal(checkApplies(policy, "xcodebuild build", ["app/View.swift"]), true, "a variant spelling of a path still needs the check");
  assert.equal(checkApplies(policy, "xcodebuild build", ["Project.YML"]), true);
  assert.equal(checkApplies(policy, "xcodebuild build", []), false);
  assert.equal(checkApplies(policy, "xcodebuild build", null), null, "unknown until the paths are measured");
});

test("the gate requires a check exactly when it applies, and shows it as not applicable otherwise", () => {
  // A change to the docs: the build does not apply, and the gate is clear without it.
  const docs = [observed("npm test")];
  const view = evidenceAt(policy, docs, H1);
  assert.deepEqual(view.checks, [{ claim: "npm test", grade: "observed", passed: true, where: "sandbox" }]);
  assert.deepEqual(view.notApplicable, ["xcodebuild build"]);
  assert.deepEqual(gate(item(), policy, docs, []), { ready: true, blockers: [], needsAssessor: false, outOfScope: [] });
  // A change to the app: the build applies, and the gate waits for it.
  const app = [observed("npm test", { changedPaths: ["App/View.swift"] })];
  assert.deepEqual(evidenceAt(policy, app, H1).notApplicable, []);
  assert.deepEqual(gate(item(), policy, app, []).blockers, ["`xcodebuild build` not yet observed at this head"]);
  // A failure of a check that does not apply does not block, and a pass of one that does still counts.
  assert.equal(gate(item(), policy, [...docs, observed("xcodebuild build", { passed: false })], []).ready, true);
  assert.equal(gate(item(), policy, [...app, observed("xcodebuild build", { changedPaths: ["App/View.swift"] })], []).ready, true);
  // Before the paths are measured, a check with paths may apply, so it waits.
  const unmeasured = evidenceAt(policy, [], H1);
  assert.deepEqual(unmeasured.checks.map((c) => c.claim), ["npm test", "xcodebuild build"]);
  assert.deepEqual(unmeasured.notApplicable, []);
});

test("a record that a check does not apply measures the paths and is never its result", () => {
  // Every check has paths, and none applies: the records alone clear the gate.
  const only: ProjectPolicy = { ...policy, checks: ["xcodebuild build"] };
  const na = observed("xcodebuild build", { passed: null, notApplicable: true });
  assert.deepEqual(evidenceAt(only, [na], H1), { checks: [], notApplicable: ["xcodebuild build"], reports: [], changedPaths: ["docs/a.md"] });
  assert.equal(gate(item(), only, [na], []).ready, true);
  // If the check applies after all, such a record is not a result: the check waits.
  const app = observed("xcodebuild build", { passed: null, notApplicable: true, changedPaths: ["App/View.swift"] });
  assert.deepEqual(gate(item(), only, [app], []).blockers, ["`xcodebuild build` not yet observed at this head"]);
  // Under sandboxOnly, a record from someone's machine measures nothing.
  assert.equal(evidenceAt({ ...only, sandboxOnly: true }, [{ ...na, where: "runner" }], H1).changedPaths, null);
});

test("the brief counts checks that do not apply, and says so when none applies", () => {
  const brief = (p: ProjectPolicy, evidence: Evidence[]) => briefFor({ item: item(), policy: p, evidence, reviews: [], events: [], gate: gate(item(), p, evidence, []), ownerActor: "owner", acceptanceProtected: null } as never);
  assert.equal(brief(policy, [observed("npm test")]).evidence[0], "Required checks at this revision: 1 passed in a Cloudflare container, 1 not applicable to this change.");
  const none = brief({ ...policy, checks: ["xcodebuild build"] }, [observed("xcodebuild build", { passed: null, notApplicable: true })]);
  assert.equal(none.evidence[0], "Required checks at this revision: 1 not applicable to this change.");
  assert.deepEqual(none.recommendation, { verdict: "accept", reason: "No required check applies to this revision's changes, and nothing blocks it." });
});

test("a not-applicable record is refused unless the measured paths show it", () => {
  assert.match(appliesReason(policy, "npm test", ["docs/a.md"])!, /`npm test` applies to every change; run it/);
  assert.match(appliesReason(policy, "xcodebuild build", null)!, /the changed paths are not measured/);
  assert.equal(appliesReason(policy, "xcodebuild build", ["app/View.swift", "docs/a.md"]), "`xcodebuild build` applies to this change, which touches app/View.swift; run it");
  assert.equal(appliesReason(policy, "xcodebuild build", ["docs/a.md"]), null);
  assert.equal(appliesText(policy, "xcodebuild build"), "applies only when the change touches App/**, project.yml");
  assert.equal(appliesText(policy, "npm test"), "applies to every change");
});

test("an init gives paths only for registered checks, and keeps those of checks still registered", () => {
  const paths = [{ command: "xcodebuild build", paths: ["App/**"] }];
  assert.deepEqual(settleCheckPaths(["xcodebuild build"], paths, undefined), paths);
  assert.deepEqual(settleCheckPaths(["npm test"], undefined, paths), []);
  assert.deepEqual(settleCheckPaths(["xcodebuild build", "npm test"], undefined, paths), paths);
  assert.deepEqual(settleCheckPaths(["xcodebuild build"], [], paths), []);
  assert.equal(refusedWith(() => settleCheckPaths(["npm test"], paths, undefined))?.code, "bad_check_paths");
  assert.deepEqual(parseCheckPaths([{ command: " make test ", paths: [" src/** "] }]), [{ command: "make test", paths: ["src/**"] }]);
  for (const bad of [null, {}, [{ command: "x", paths: [] }], [{ command: "", paths: ["a"] }], [{ command: "x", paths: [""] }], [{ command: "x", paths: "src/**" }]]) {
    assert.equal(refusedWith(() => parseCheckPaths(bad))?.status, 400, JSON.stringify(bad));
  }
});

test("ControlPlane's fnmatch patterns become globs that match the same paths", () => {
  assert.equal(fromFnmatch("*.md"), "**.md");
  assert.equal(fromFnmatch("src/**"), "src/**");
  assert.equal(fromFnmatch("astro.config.*"), "astro.config.**");
  const p = { checkPaths: [{ command: "c", paths: ["*.md", "astro.config.*"].map(fromFnmatch) }] };
  assert.equal(checkApplies(p, "c", ["docs/guide.md"]), true);
  assert.equal(checkApplies(p, "c", ["astro.config.mjs"]), true);
  assert.equal(checkApplies(p, "c", ["src/a.ts"]), false);
});

test("init imports change_rules: a check applies where the rules requiring the capabilities it runs apply", () => {
  // ikon weblog's adapter, in part, with its registered check.
  const adapter = {
    capabilities: {
      "unit-tests": { action_class: "local-read-only", command: ["npm", "test"] },
      "astro-check": { action_class: "local-read-only", command: ["npm", "run", "check"] },
      "production-build": { action_class: "local-write", command: ["npm", "run", "build"] },
      "diff-check": { action_class: "local-read-only", command: ["git", "diff", "--check"] },
      "app-build": { action_class: "local-read-only", command: ["/bin/sh", "-c", "xcodegen generate && xcodebuild build"] },
      deploy: { action_class: "deploy", command: ["npx", "wrangler", "deploy"] },
    },
    change_rules: [
      { patterns: ["src/**", "astro.config.*", "package.json"], reason: "runtime", requires: ["unit-tests", "astro-check", "production-build", "diff-check"] },
      { patterns: ["AGENTS.md", "docs/**"], reason: "docs", requires: ["diff-check"] },
      { patterns: ["App/**"], reason: "app", requires: ["app-build"] },
      { patterns: [], reason: "empty", requires: ["unit-tests"] },
      { patterns: ["x/**"], reason: "unknown", requires: ["no-such-capability"] },
    ],
  };
  const checks = [
    "npm ci --prefer-offline --no-audit --no-fund && npm run check && npm test",
    "cd ios && xcodegen generate && xcodebuild build",
    "swift test",
  ];
  const { paths, unrun } = adapterCheckPaths(adapter, checks);
  assert.deepEqual(paths, [
    { command: checks[0], paths: ["src/**", "astro.config.**", "package.json"] },
    { command: checks[1], paths: ["App/**"] },
  ]);
  assert.deepEqual(unrun, [{ name: "production-build", command: "npm run build" }, { name: "diff-check", command: "git diff --check" }]);
  // No change rules, no paths: every check applies to every change.
  assert.deepEqual(adapterCheckPaths({ capabilities: adapter.capabilities, change_rules: [] }, checks), { paths: [], unrun: [] });
  assert.deepEqual(adapterCheckPaths(null, checks), { paths: [], unrun: [] });
});
