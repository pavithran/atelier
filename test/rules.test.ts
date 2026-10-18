import { test } from "node:test";
import { criteriaHash, NO_CRITERIA } from "../src/criteria.ts";
import { effectiveAdmissions, splitHarness, standardAdmissions, type ReviewerAdmission } from "../src/rules.ts";
import { usageShortages } from "../src/rules.ts";
import { LEDGER_RESTART_GAP_MS, ledgerRestart, missingLedgerMethod, parseLedgerRestart, parsePrivateList, privateExcludeLine, privateFolderMatches, privateListText, privatePath, privatePathsAmong, UPDATING_DETAIL } from "../src/rules.ts";
import assert from "node:assert/strict";
import {
  ownerPortAllowed, pushActors, assertHandoffTarget, assertReviewAllowed, agentOf, measuredPaths, changeClass, parseAgents, parseExecution, assertClaimable, evidenceAt, gate, globToRegExp, inboxFor, matchesAny, modelKey, modelOf, sameActor,
  assertClaimAllowed, assertCriteriaAllowed, assertEligible, assertBaselineName, branchesRepoName, branchHost, checkFiles, developerBranch, eligibleAgents, foldPath, matchesFolded, overlappingLive, overlappingRefusal, parseRuleError, pathCollisions, repoName, roleRefusal, RuleError, scopesOverlap, scopesOverlapWithin, validActor,
  riskClass, riskNeed, parseRiskReviews,
  decisionFor, mergedBlockers, mergedChecksAt, overrideAt, OVERRIDE_REASON_MAX, PROTECTED_NEED, reviewOverrideFor,
  applyVerification, unquoteGitPath, dropSettled, isPreExisting, labelPreExisting, PRE_EXISTING_MARGIN, preExistingTask, reReviewDiff, rejectedRounds, REVIEW_ROUND_CAP, reviewedSince, roundCapHold, touchedLines,
  type Evidence, type Finding, type InboxEntry, type Item, type ProjectPolicy, type Review, type ReviewOverride,
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

test("a project that requires criteria refuses a task filed or cleared without them", () => {
  assert.doesNotThrow(() => assertCriteriaAllowed({}, undefined));
  assert.doesNotThrow(() => assertCriteriaAllowed({ requireCriteria: false }, []));
  assert.doesNotThrow(() => assertCriteriaAllowed({ requireCriteria: true }, ["It works"]));
  for (const accept of [undefined, []]) {
    assert.throws(() => assertCriteriaAllowed({ requireCriteria: true }, accept), (err: unknown) => err instanceof RuleError && err.code === "no_criteria" && err.status === 400 && /--accept "TEXT"/.test(err.detail));
  }
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

test("globs: a newline is a path character, so ** crosses it under a protected directory", () => {
  // Git allows a newline in a path; a file under a protected directory stays
  // protected with one in its name, for every matcher the guarded set uses.
  const odd = "docs/control-plane/agent\n-policy.v1.json";
  assert.ok(matchesAny(odd, ["docs/control-plane/**"]));
  assert.ok(matchesFolded(odd, ["docs/control-plane/**"]));
  assert.equal(changeClass([odd], { checks: [], protected: ["docs/control-plane/**"] }), "protected");
  assert.ok(matchesAny("a\nb/c.md", ["**/*.md"]));
  assert.ok(matchesAny("src/a\nb.ts", ["src/*.ts"]));
  assert.ok(matchesAny("src/a\n.ts", ["src/a?.ts"]));
  // A newline never lets a single star cross a slash.
  assert.ok(!matchesAny("src/a\n/b.ts", ["src/*.ts"]));
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

// The shared identity contract of the model-assessment tasks (t622): one
// model under several harnesses is one model. Antigravity names Opus
// "claude-opus-5.5", with a dot where the registry's alias has a dash, so
// before this antigravity/claude-opus-5.5 counted as a model of its own.
test("a registered model's name with dots for dashes, as another harness spells it, is that model", () => {
  assert.equal(modelKey("antigravity/claude-opus-5.5"), "opus-5.5");
  assert.equal(modelKey("antigravity/Claude-Sonnet-5.5:high"), "sonnet-5.5");
  // A name the registry does not know keeps its own spelling.
  assert.equal(modelKey("opencode/kimi-k2.7"), "kimi-k2.7");
  assert.equal(modelKey("opencode/kimi-k2-7"), "kimi-k2-7");
  assert.equal(modelKey("zcode/glm-5-3"), "glm-5.3");
  assert.ok(!sameActor("claude-code/opus-5.5", "antigravity/claude-opus-5.5"));
});

test("one owner: a second actor cannot claim an owned item", () => {
  assert.throws(() => assertClaimable(item({ state: "claimed" }), "codex/gpt-5.5"), /held by claude-code/);
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

test("protected paths need a model of another family; the project owner's approval is not that review", () => {
  const touching = pass({ changedPaths: ["AGENTS.md"] });
  const sameModel: Review = { itemId: "t1", by: "other-harness/opus-5.5", head: H1, criteria: NO_CRITERIA, approve: true, note: "", at: T };
  const sameFamily: Review = { ...sameModel, by: "claude-code/sonnet-5.5" };
  const otherModel: Review = { ...sameModel, by: "codex/gpt-5.5" };
  const owner: Review = { ...sameModel, by: "owner" };
  const renamed: Review = { ...sameModel, by: "pavi" };
  const stale: Review = { ...otherModel, head: H2 };
  assert.equal(gate(item(), policy, [touching], []).needsAssessor, true);
  assert.equal(gate(item(), policy, [touching], [sameModel]).ready, false);
  assert.equal(gate(item(), policy, [touching], [sameFamily]).ready, false);
  assert.equal(gate(item(), policy, [touching], [stale]).ready, false);
  assert.equal(gate(item(), policy, [touching], [otherModel]).ready, true);
  assert.deepEqual(gate(item(), policy, [touching], [owner]).blockers, [PROTECTED_NEED]);
  // Whatever the deployment calls its owner, the owner's approval is not the review.
  assert.equal(gate(item(), policy, [touching], [renamed]).ready, false);
  assert.equal(gate(item(), policy, [touching], [renamed], "pavi").ready, false);
});

test("a rejection at the head blocks", () => {
  const no: Review = { itemId: "t1", by: "codex/gpt-5.5", head: H1, criteria: NO_CRITERIA, approve: false, note: "breaks iOS", at: T };
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

test("what a runner executes is protected: make and just recipes, npx's binary, manifests of build tools, paths run directly", () => {
  const sorted = (files: string[]) => [...files].sort();
  assert.deepEqual(checkFiles(["make test"]), sorted(["Makefile", "makefile", "GNUmakefile", "**/*.mk"]));
  assert.deepEqual(checkFiles(["make -C native -f build.mk all", "make --directory=./lib --makefile=rules.mk"]), sorted(["native/build.mk", "lib/rules.mk", "**/*.mk"]));
  assert.deepEqual(checkFiles(["make -C ../other check", "make -f /etc/Makefile"]), ["**/*.mk"]);
  // The directory an option names is normalised as Git names a changed path,
  // so what it guards matches what a change touches.
  assert.deepEqual(checkFiles(["make -C lib/../native test", "make -C packages/app/ test", "just -d tools -f justfile.ci check"]),
    sorted(["native/Makefile", "native/makefile", "native/GNUmakefile", "packages/app/Makefile", "packages/app/makefile", "packages/app/GNUmakefile", "tools/justfile.ci", "**/*.mk", "**/*.just"]));
  assert.deepEqual(checkFiles(["make -C a/../../escape test"]), ["**/*.mk"]);
  assert.deepEqual(checkFiles(["just check"]), sorted(["justfile", "Justfile", ".justfile", "**/*.just"]));
  assert.deepEqual(checkFiles(["just --justfile ci.just test"]), sorted(["ci.just", "**/*.just"]));
  assert.deepEqual(checkFiles(["npx vitest run"]), sorted(["package.json", ".npmrc", "node_modules/.bin/vitest"]));
  assert.deepEqual(checkFiles(["npx --yes -p typescript tsc --noEmit", "npx eslint@9 ."]), sorted(["package.json", ".npmrc", "node_modules/.bin/tsc", "node_modules/.bin/eslint"]));
  assert.deepEqual(checkFiles(["pnpm dlx @scope/tool --flag", "yarn exec lint", "bun x vitest", "bunx tsc"]), sorted([
    "package.json", ".npmrc", ".pnpmfile.cjs", "node_modules/.bin/tool", ".yarnrc", ".yarnrc.yml", ".yarn/plugins/**", ".yarn/releases/**", "node_modules/.bin/lint", "bunfig.toml", "node_modules/.bin/vitest", "node_modules/.bin/tsc",
  ]));
  assert.deepEqual(checkFiles(["pnpm test", "yarn test", "bun test"]), sorted(["package.json", ".npmrc", ".pnpmfile.cjs", ".yarnrc", ".yarnrc.yml", ".yarn/plugins/**", ".yarn/releases/**", "bunfig.toml"]));
  assert.deepEqual(checkFiles(["cargo test --workspace"]), sorted(["**/Cargo.toml", "**/build.rs", ".cargo/config", ".cargo/config.toml"]));
  assert.deepEqual(checkFiles(["swift test"]), sorted(["**/Package.swift", "**/Package@swift-*.swift"]));
  assert.deepEqual(checkFiles(["xcodebuild -scheme App -destination 'platform=iOS Simulator' test"]), sorted(["**/*.xcodeproj/**", "**/*.xcworkspace/**", "**/Package.swift", "**/Package@swift-*.swift"]));
  assert.deepEqual(checkFiles(["deno task test", "deno test"]), ["deno.json", "deno.jsonc"]);
  assert.deepEqual(checkFiles(["bin/check", "CI=1 scripts/verify --strict", "./bin/lint"]), ["bin/check", "bin/lint", "scripts/verify"]);
  // Paths outside the repository, and arguments that are not run, are not.
  assert.deepEqual(checkFiles(["/usr/bin/true", "../shared/run", "cat docs/a.md"]), []);
  // The guarded set carries these: an item that edits its Makefile or an
  // included rules file under `make test` needs an independent review.
  const made: ProjectPolicy = { checks: ["make test"], protected: [] };
  for (const path of ["Makefile", "lib/rules.mk", "gnumakefile"]) assert.equal(changeClass([path], made), "protected", path);
  assert.equal(changeClass(["src/main.c"], made), "coordinated");
  assert.equal(changeClass(["node_modules/.bin/vitest"], { checks: ["npx vitest run"], protected: [] }), "protected");
});

test("a runner's name counts anywhere in a check line: through wrappers, a shell's -c string, shell syntax and a newline", () => {
  // Each form reaches npm, so each protects package.json; the check cannot
  // be weakened by wrapping the runner. The forms that protect nothing are
  // collected, so a failure names every one.
  const unprotected = (forms: string[], file: (files: string[]) => boolean) => forms.filter((form) => !file(checkFiles([form])));
  assert.deepEqual(unprotected([
    "env CI=1 npm test", "sh -c 'npm test'", "bash -c \"npm run check\"", "time npm test", "timeout 600 npm test", "timeout -k 5 600 npm test",
    "exec npm test", "command npm test", "sudo npm test", "sudo -u app npm test", "nice -n 10 npm test", "cross-env CI=1 npm test", "xvfb-run -a npm test",
    "/usr/bin/env npm test", "if npm test; then :; fi", "! npm test", "{ npm test; }", "echo start\nnpm test", "nohup npm test", "bash -euo pipefail -c 'npm test'",
  ], (files) => files.includes("package.json")), []);
  assert.deepEqual(unprotected(["env make check", "sh -c \"make check\"", "timeout 600 make check", "echo start\nmake check"], (files) => files.includes("Makefile")), []);
  assert.deepEqual(unprotected(["sh -c 'just check'"], (files) => files.includes("justfile")), []);
  assert.deepEqual(unprotected(["env cargo test"], (files) => files.includes("**/Cargo.toml")), []);
  assert.deepEqual(unprotected(["sudo npx vitest run"], (files) => files.includes("node_modules/.bin/vitest")), []);
  // A path run directly counts in every command position the wrappers and shells lead to.
  assert.deepEqual(unprotected(
    ["env CI=1 bin/check", "sh -c 'bin/check'", "timeout 600 bin/check", "if bin/check; then :; fi", "echo start\nbin/check", "bash -c 'env CI=1 scripts/verify'"],
    (files) => files.some((f) => f === "bin/check" || f === "scripts/verify"),
  ), []);
  // A manager told where its project is reads that directory's files too.
  assert.ok(checkFiles(["npm --prefix packages/app test"]).includes("packages/app/package.json"));
  assert.ok(checkFiles(["npm -C packages/app test"]).includes("packages/app/package.json"));
  assert.ok(checkFiles(["pnpm -C packages/app test"]).includes("packages/app/.pnpmfile.cjs"));
  assert.ok(checkFiles(["pnpm --dir=packages/app test"]).includes("packages/app/package.json"));
  assert.ok(checkFiles(["yarn --cwd packages/app test"]).includes("packages/app/.yarnrc.yml"));
  assert.ok(checkFiles(["npm --prefix packages/app test"]).includes("package.json"));
});

test("a check line holding a word that names an Object.prototype member finds no runner and never throws", () => {
  // The runner tables are looked up by word; these words are keys of every
  // plain object, and a lookup that found them would iterate a function.
  for (const word of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]) {
    const lines = [`grep -q ${word} src/a.ts`, `node --test --test-name-pattern ${word}`, `${word} test`, `npm ${word} check`, `${word} -c "npm test"`];
    assert.doesNotThrow(() => checkFiles(lines), word);
    assert.deepEqual(checkFiles([`grep -q ${word} src/a.ts`]), [], word);
    assert.deepEqual(checkFiles([`${word} test`]), [], word);
    assert.ok(checkFiles([`npm ${word} check`]).includes("package.json"), word);
    // The gate reads the same tables through changeClass.
    const p: ProjectPolicy = { checks: [`grep -q ${word} src/a.ts`], protected: ["AGENTS.md"] };
    assert.equal(changeClass(["src/a.ts"], p), "coordinated", word);
    assert.equal(gate(item({ scope: [] }), p, [pass({ claim: p.checks[0], changedPaths: ["src/a.ts"] })], []).ready, true, word);
  }
});

test("files named by a check are protected: an item cannot weaken its own grader", () => {
  assert.deepEqual(checkFiles(["./check.sh", "npm test", "node scripts/verify.mjs --strict", "pytest -q tests/"]), [".npmrc", "check.sh", "package.json", "scripts/verify.mjs"]);
  assert.deepEqual(checkFiles(["grep -q export src/a.ts"]), []);
  assert.deepEqual(checkFiles(["npm ci --prefer-offline && npm test", "npm run check && npm run build"]), [".npmrc", "package.json"]);
  const p: ProjectPolicy = { checks: ["./check.sh"], protected: [] };
  const g = gate(item({ scope: [] }), p, [pass({ claim: "./check.sh", changedPaths: ["check.sh"] })], []);
  assert.equal(g.needsAssessor, true);
  assert.equal(g.ready, false);
});

test("the ship files and what a ship runs are protected like a check's files", () => {
  // docs/atelier/** is guarded in every project, whatever its policy, so an
  // item cannot change or add a ship order the owner would run.
  const plain: ProjectPolicy = { checks: [], protected: [] };
  assert.equal(changeClass(["docs/atelier/ship.json"], plain), "protected");
  assert.equal(changeClass(["docs/atelier/notes.md"], plain), "protected");
  assert.equal(changeClass(["src/a.ts"], plain), "coordinated");
  // The commands the ship order runs (policy.shipRuns, recorded from the
  // checkout's ship files at init) guard their files exactly as a check's do.
  const ship: ProjectPolicy = { ...plain, shipRuns: ["bin/deploy.sh", "npx wrangler deploy"] };
  assert.equal(changeClass(["bin/deploy.sh"], ship), "protected");
  assert.equal(changeClass(["package.json"], ship), "protected", "npx's manifest is guarded as a check's is");
  assert.equal(changeClass(["src/a.ts"], ship), "coordinated");
  assert.equal(changeClass(["bin/deploy.sh"], plain), "coordinated", "a project that records no ship order guards only the ship files' folder");
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

test("roleRefusal says why a claim would be refused and names the agents that would pass", () => {
  const governed: ProjectPolicy = { checks: [], protected: [], agents: { claude: { available: true, eligible_roles: ["executor", "assessor"] }, codex: { available: true, eligible_roles: ["assessor"] }, glm: { available: false, eligible_roles: ["executor"] } } };
  assert.equal(roleRefusal("codex/gpt-6-astra", governed, "executor"), "codex/gpt-6-astra needs an available agent with the executor role; available agents with the executor role: claude");
  assert.equal(roleRefusal("glm/glm-4.6", governed, "executor"), "glm/glm-4.6 needs an available agent with the executor role; available agents with the executor role: claude");
  assert.equal(roleRefusal("codex/gpt-6-astra", governed, "assessor"), null, "codex holds the assessor role");
  assert.equal(roleRefusal("claude-code/opus-5.5", governed, "assessor"), null);
  // No agent holds the role: the refusal says so rather than naming none.
  const onlyExec: ProjectPolicy = { checks: [], protected: [], agents: { claude: { available: true, eligible_roles: ["executor"] } } };
  assert.equal(roleRefusal("claude-code/opus-5.5", onlyExec, "assessor"), "claude-code/opus-5.5 needs an available agent with the assessor role; no agent is available with the assessor role");
  // A legacy policy falls back to assertEligible's own words, which name the eligible harnesses.
  const legacy: ProjectPolicy = { checks: [], protected: [], eligible: ["claude"] };
  assert.equal(roleRefusal("codex/gpt-6-astra", legacy, "assessor"), "codex is not an eligible agent here (eligible: claude)");
  assert.equal(roleRefusal("claude-code/opus-5.5", legacy, "assessor"), null);
  // Without a policy restriction nothing is refused.
  assert.equal(roleRefusal("anything/x", { checks: [], protected: [] }, "assessor"), null);
});

test("eligibleAgents names only the available agents holding the role", () => {
  const governed: ProjectPolicy = { checks: [], protected: [], agents: { claude: { available: true, eligible_roles: ["executor", "assessor"] }, codex: { available: true, eligible_roles: ["assessor"] }, glm: { available: false, eligible_roles: ["executor"] } } };
  assert.deepEqual(eligibleAgents(governed, "executor"), ["claude"]);
  assert.deepEqual(eligibleAgents(governed, "assessor"), ["claude", "codex"]);
  assert.deepEqual(eligibleAgents({ checks: [], protected: [] }, "executor"), []);
});

test("overlappingRefusal names the same live items with the same words as the claim", () => {
  const held = item({ id: "t1", state: "claimed", owner: "codex/gpt-5.5", scope: ["src/**"] });
  const want = item({ id: "t2", state: "open", owner: null, scope: ["src/ui/**"] });
  assert.equal(overlappingRefusal(want, [held], "claude-code/opus-5.5"), "t2's scope overlaps live t1 (codex/gpt-5.5); this project refuses overlapping claims. The developer can narrow a scope with atelier edit t1 --scope GLOB (or atelier edit t2 --scope GLOB)");
  assert.equal(overlappingRefusal(want, [], "claude-code/opus-5.5"), null);
  assert.equal(overlappingRefusal(want, [held], "codex/gpt-5.5"), null, "the holder of the overlapping item may take it");
});

test("a live task blocks an overlapping claim by one rule in every state, and the refusal names the way out", () => {
  const strict: ProjectPolicy = { checks: [], protected: [], refuseOverlap: true };
  const want = item({ id: "t9", state: "open", owner: null, scope: ["src/ui/**"] });
  // An accepted task whose merge was cancelled is accepted still, so it holds like the rest.
  for (const state of ["claimed", "submitted", "accepted"] as const) {
    const held = item({ id: "t14", state, owner: "glm/glm-4.6", scope: [] });
    assert.deepEqual(overlappingLive(want, [held, want], "claude-code/opus-5.5").map((i) => i.id), ["t14"], state);
    assert.throws(
      () => assertClaimAllowed(want, [held, want], strict, "claude-code/opus-5.5"),
      /overlaps live t14 \(glm\/glm-4\.6\).*atelier edit t14 --scope GLOB/,
      state,
    );
    // Narrowed with atelier edit --scope, the same task no longer blocks.
    const narrowed = { ...held, scope: ["docs/**"] };
    assert.doesNotThrow(() => assertClaimAllowed(want, [narrowed, want], strict, "claude-code/opus-5.5"), state);
  }
  for (const state of ["open", "merged", "abandoned"] as const) {
    assert.deepEqual(overlappingLive(want, [item({ id: "t14", state, owner: "glm/glm-4.6", scope: [] }), want], "claude-code/opus-5.5"), [], state);
  }
});

test("a finished workspace goes only against proof that nothing is lost, ignored work included (t561)", async () => {
  const { finishedWorkspaceReason } = await import("../src/rules.ts");
  const clean = { atLedgerHead: true, headInMain: false, dirty: false, ignored: [] as string[], extraCommits: false };
  for (const state of ["merged", "abandoned"] as const) {
    assert.equal(finishedWorkspaceReason(item({ state }), clean), null, state);
    assert.equal(finishedWorkspaceReason(item({ state }), { ...clean, atLedgerHead: false, headInMain: true }), null, state);
  }
  for (const state of ["open", "claimed", "submitted", "accepted"] as const) {
    assert.match(finishedWorkspaceReason(item({ state }), clean)!, /neither merged nor abandoned/);
  }
  assert.match(finishedWorkspaceReason(undefined, clean)!, /neither merged nor abandoned/);
  assert.match(finishedWorkspaceReason(item({ state: "merged" }), { ...clean, atLedgerHead: false })!, /neither the head Atelier recorded nor in main/);
  assert.match(finishedWorkspaceReason(item({ state: "merged" }), { ...clean, dirty: true })!, /changed or untracked/);
  assert.match(finishedWorkspaceReason(item({ state: "merged" }), { ...clean, extraCommits: true })!, /commits neither/);
  // A harness's logs under .scratch/ were removed without a word (t561 pre-review).
  assert.equal(finishedWorkspaceReason(item({ state: "merged" }), { ...clean, ignored: [".scratch/", ".env"] }),
    "holds ignored files that are not rebuildable output: .scratch/, .env");
  const many = ["a", "b", "c", "d", "e", "f", "g"];
  assert.match(finishedWorkspaceReason(item({ state: "abandoned" }), { ...clean, ignored: many })!, /: a, b, c, d, e and 2 more$/);
});

test("only rebuildable output among ignored files lets a finished workspace go (t561)", async () => {
  const { unkeptIgnored } = await import("../src/rules.ts");
  assert.deepEqual(unkeptIgnored(["node_modules/", "web/node_modules/", ".cache/", "dist/", "worker-configuration.d.ts", "app/.DS_Store", "tsconfig.tsbuildinfo"]), []);
  assert.deepEqual(unkeptIgnored([".scratch/", ".env", ".env.local", "renders/", ".wrangler/", ".ai-project-data/", "notes.md"]),
    [".scratch/", ".env", ".env.local", "renders/", ".wrangler/", ".ai-project-data/", "notes.md"]);
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
  const no: Review={itemId:'t1',head:H1,criteria:NO_CRITERIA,by:'owner',approve:false,note:'Fix it',at:T};
  const yes: Review={...no,approve:true,at:'2026-10-03T13:00:00Z'};
  assert.deepEqual(latestReviews([no,yes],{head:H1,criteria:NO_CRITERIA}),[yes]);
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

test("an actor name is at most 200 characters, whatever its shape", () => {
  assert.ok(validActor("h/" + "m".repeat(198)), "a harness and model naming exactly 200");
  assert.equal(validActor("h/" + "m".repeat(199)), false);
  assert.ok(validActor("a".repeat(200)), "a harness alone naming exactly 200");
  assert.equal(validActor("a".repeat(201)), false);
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
const review = (by: string, over: Partial<Review> = {}): Review => ({ itemId: "t1", by, head: H1, criteria: NO_CRITERIA, approve: true, note: "", at: T, ...over });

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

test("direct needs no review, coordinated needs another model, protected needs another family", () => {
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
  assert.equal(gate(item(), governed, protectedChange, [review("owner")]).ready, false);
  assert.equal(gate(item(), governed, coordinated, [review("owner")]).ready, false);
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

test("ungoverned gates need another family for a protected change, and count neither the same family nor the owner", () => {
  assert.equal(gate(item(), policy, [pass()], []).ready, true);
  assert.equal(gate(item(), policy, [pass({ changedPaths: ["AGENTS.md"] })], [review("claude-code/sonnet-5.5")]).ready, false);
  assert.equal(gate(item(), policy, [pass({ changedPaths: ["AGENTS.md"] })], [review("owner")]).ready, false);
  assert.equal(gate(item(), policy, [pass({ changedPaths: ["AGENTS.md"] })], [review("codex/gpt-6")]).ready, true);
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

test("the project owner's rejection blocks every class, and the owner's approval is no class's independent review", () => {
  for (const owner of ["owner", "pavi"]) for (const path of ["docs/a.md", "src/a.ts", "AGENTS.md"]) {
    const evidence = [pass({ changedPaths: [path] })];
    // A direct change needs no review, so it is ready whoever approved it.
    const alone = gate(item(), governed, evidence, [review(owner)], owner);
    assert.deepEqual([path, alone.ready, alone.needsAssessor], [path, path === "docs/a.md", path !== "docs/a.md"]);
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
    // Task t94: after a release, the push observed while nobody held the
    // item was counted under the name the Ledger logs it with,
    // atelier/events, a contributor of no recognised family, so no
    // reviewer could be shown to be of another family. Every holder is
    // already listed, and the push is attributed to none.
    assert.deepEqual(contributors, ["codex/gpt-6", "claude-code/opus-5.5", "opencode/glm-5.3"]);
    const held = item({ pushActors: contributors });
    const evidence = [pass({ changedPaths: ["AGENTS.md"] })];
    assert.equal(gate(held, policy, evidence, [review("codex/gpt-6")]).needsAssessor, true);
    assert.equal(gate(held, policy, evidence, [review("qwen/qwen3")]).ready, true);
  }
  // A push seen before anyone claimed the item is attributed to nobody.
  assert.deepEqual(pushActors([{ kind: "push.observed", actor: "atelier/events", data: {} }]), []);
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
  // Another model of the same family does not count; another family does.
  assert.equal(gate(studio, policy, touching, [review("opencode/GLM-5.3-Flash-4_8bit")]).ready, false);
  assert.equal(gate(studio, policy, touching, [review("codex/gpt-6-astra")]).ready, true);
  assert.equal(gate(item(), policy, touching, [review("codex/gpt-6-astra")]).ready, true);

  // Governed, coordinated: another spelling of a contributor is that
  // contributor; changing harness does not make its review independent: a
  // model never reviews a change it contributed to (t394). Another model
  // does count.
  const coordinated = [pass({ changedPaths: ["src/a.ts"] })];
  assert.equal(gate(item(), governed, coordinated, [review("Claude-Code/OPUS-5.5:fast")]).ready, false);
  assert.equal(gate(item(), governed, coordinated, [review("claude-code/claude-opus-5-5")]).ready, false);
  assert.equal(gate(item(), governed, coordinated, [review("codex/opus-5.5")]).ready, false);
  assert.equal(gate(item(), governed, coordinated, [review("codex/claude-opus-5-5")]).ready, false);
  assert.equal(gate(item(), governed, coordinated, [review("codex/gpt-6-astra")]).ready, true);

  // Governed, protected: a profile suffix never changes a model's family, nor
  // the agent its review is counted for.
  const anyAssessor: ProjectPolicy = { ...governed, agents: { ...governed.agents!, gemini: { available: true, eligible_roles: ["assessor"] } } };
  const qwen = item({ owner: "opencode/qwen3-coder:studio-code", pushActors: ["opencode/qwen3-coder:studio-code"] });
  assert.equal(agentOf("opencode/qwen3.8-27b:google-eval", anyAssessor.agents!), "qwen");
  assert.equal(gate(qwen, anyAssessor, touching, [review("opencode/qwen3.8-27b:google-eval")]).ready, false);
  assert.equal(gate(qwen, anyAssessor, touching, [review("codex/gpt-6-astra")]).ready, true);
});

test("t418: changing harness never makes a contributor model independent", () => {
  const scenarios = [
    { label: "coordinated", policy: governed, paths: ["src/a.ts"] },
    { label: "governed protected", policy: governed, paths: ["AGENTS.md"] },
    { label: "ungoverned protected", policy, paths: ["AGENTS.md"] },
  ];
  for (const scenario of scenarios) {
    const evidence = [pass({ changedPaths: scenario.paths })];
    for (const task of [
      item(),
      item({ owner: "codex/gpt-6", pushActors: ["claude-code/opus-5.5"] }),
    ]) {
      for (const by of ["codex/claude-opus-5-5", "codex/OPUS-5.5:fast", "opencode/opus-5.5"]) {
        const g = gate(task, scenario.policy, evidence, [review(by)]);
        assert.equal(g.ready, false, `${scenario.label}: ${by}`);
        assert.equal(g.needsAssessor, true, `${scenario.label}: ${by}`);
      }
      // A different model at the same company qualifies only for coordinated work.
      assert.equal(gate(task, scenario.policy, evidence, [review("codex/claude-sonnet-5-5")]).ready,
        scenario.label === "coordinated", scenario.label);
      // A company absent from all contributors qualifies for either class.
      assert.equal(gate(task, scenario.policy, evidence, [review("qwen/qwen3")]).ready, true, scenario.label);
    }
  }
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
  assert.equal(gate(handed, governed, evidence, [review("owner")]).ready, false);
});

// PAVI's decision, 2026-10-06: "an independent review of a protected change
// must come from a model of a different family than every contributor in
// every project, not only those with ControlPlane policy files; the owner's
// approval no longer counts as the independent review (the owner still
// accepts and merges)." Each scenario below is one clause of it, in a
// project without policy files and in a governed one.
test("decision 2026-10-06: a protected change needs another family than every contributor, in every project", () => {
  const touching = [pass({ changedPaths: ["AGENTS.md"] })];
  for (const p of [policy, governed]) {
    const governedLabel = p === governed ? "governed" : "ungoverned";
    // The same family, as a different model, is refused.
    for (const by of ["claude-code/sonnet-5.5", "codex/opus-5.5", "opencode/haiku-5"]) {
      const g = gate(item(), p, touching, [review(by)]);
      assert.deepEqual([governedLabel, by, g.ready, g.needsAssessor], [governedLabel, by, false, true]);
    }
    // The owner's approval alone is refused, under the default name and a deployment's own.
    for (const owner of ["owner", "pavi"]) {
      const g = gate(item(), p, touching, [review(owner)], owner);
      assert.deepEqual([governedLabel, owner, g.ready, g.needsAssessor], [governedLabel, owner, false, true]);
    }
    // Another family's approval is accepted, beside the owner's or alone.
    assert.equal(gate(item(), p, touching, [review("codex/gpt-6-astra")]).ready, true, governedLabel);
    assert.equal(gate(item(), p, touching, [review("owner"), review("opencode/qwen3-coder")]).ready, true, governedLabel);
    // A family not recognised from the model's name never qualifies.
    assert.equal(gate(item(), p, touching, [review("opencode/mystery-1")]).ready, false, governedLabel);
  }
});

test("decision 2026-10-06: the owner's override stands in for the missing review only at its head, only from the owner, only with a reason", () => {
  const touching = [pass({ changedPaths: ["AGENTS.md"] })];
  const override = (over: Partial<ReviewOverride> = {}): ReviewOverride => ({ head: H1, by: "owner", reason: "No model of another family is available this week", at: T, ...over });
  const overridden = item({ reviewOverride: override() });
  const g = gate(overridden, policy, touching, [review("owner")]);
  assert.deepEqual([g.ready, g.needsAssessor, g.blockers], [true, false, []]);
  assert.deepEqual(g.overridden, override());
  // Recorded by anyone but the owner, at another head, or without a reason, it is no override.
  for (const bad of [override({ by: "codex/gpt-6" }), override({ head: H2 }), override({ reason: "  " })]) {
    assert.equal(overrideAt(item({ reviewOverride: bad })), null);
    assert.deepEqual(gate(item({ reviewOverride: bad }), policy, touching, []).blockers, [PROTECTED_NEED]);
  }
  // A deployment's own owner name is the one that counts.
  assert.equal(gate(item({ reviewOverride: override({ by: "pavi" }) }), policy, touching, [], "pavi").ready, true);
  // It waives the missing review and nothing else.
  const failing = gate(overridden, policy, [pass({ changedPaths: ["AGENTS.md"], passed: false })], []);
  assert.deepEqual(failing.blockers, ["`npm test` failed when observed"]);
  assert.match(gate(overridden, policy, touching, [review("codex/gpt-6", { approve: false, note: "unsafe" })]).blockers.join(), /rejected by codex\/gpt-6: unsafe/);
  // A qualifying approval makes it moot, and the gate does not report it then.
  assert.equal(gate(overridden, policy, touching, [review("codex/gpt-6")]).overridden, undefined);
  // In a governed project it stands in for a coordinated change's review too.
  assert.equal(gate(overridden, governed, [pass()], []).ready, true);
});

test("decision 2026-10-06: an override is recorded only with a reason, and only where an independent review is missing", () => {
  const touching = [pass({ changedPaths: ["AGENTS.md"] })];
  const made = reviewOverrideFor(item(), policy, touching, [review("owner")], "owner", "  No other family is available\n", T);
  assert.deepEqual(made, {
    override: { head: H1, by: "owner", reason: "No other family is available", at: T },
    waived: PROTECTED_NEED,
    contributors: ["claude-code/opus-5.5"],
  });
  const governedMade = reviewOverrideFor(item(), governed, touching, [], "owner", "reason", T);
  assert.equal(governedMade.waived, "Protected change: needs one review from another model family");
  // The reason is required, as text, and bounded rather than cut.
  for (const reason of [undefined, "", "   ", 5, true, "x".repeat(OVERRIDE_REASON_MAX + 1)]) {
    assert.throws(() => reviewOverrideFor(item(), policy, touching, [], "owner", reason, T), /400\|override_reason\|/);
  }
  assert.doesNotThrow(() => reviewOverrideFor(item(), policy, touching, [], "owner", "x".repeat(OVERRIDE_REASON_MAX), T));
  // Nothing to override: a qualifying approval exists, or the change needs no review.
  assert.throws(() => reviewOverrideFor(item(), policy, touching, [review("codex/gpt-6")], "owner", "reason", T), /409\|override_unneeded\|t1 at aaaaaaaa is not missing an independent review, so there is nothing to override; accept it without an override/);
  assert.throws(() => reviewOverrideFor(item(), policy, [pass()], [], "owner", "reason", T), /409\|override_unneeded\|/);
  assert.throws(() => reviewOverrideFor(item(), governed, [pass({ changedPaths: ["docs/a.md"] })], [], "owner", "reason", T), /override_unneeded/);
  // An earlier override at this head does not make a new one unneeded.
  assert.doesNotThrow(() => reviewOverrideFor(item({ reviewOverride: made.override }), policy, touching, [], "owner", "again", T));
});

test("decision 2026-10-06: the inbox and the page name the override and its reason", () => {
  const now = new Date("2026-10-06T12:00:00.000Z");
  const touching = [pass({ changedPaths: ["AGENTS.md"] })];
  const reviewOverride: ReviewOverride = { head: H1, by: "owner", reason: "No other family is available", at: T };
  const entry = (over: Partial<Item>) => inboxFor("proj", [item({ scope: [], ...over })], policy, touching, [], now);
  assert.deepEqual(entry({}).map((x) => [x.kind, x.reason]), [["assess", `${PROTECTED_NEED}; ask a reviewer with atelier land t1 --reviewer H/M, and override only as the developer's last resort`]]);
  assert.deepEqual(entry({ reviewOverride }).map((x) => [x.kind, x.reason]), [["accept", "all checks observed passing at this head, with the independent review overridden by the developer: No other family is available"]]);
  assert.deepEqual(entry({ reviewOverride, state: "accepted", acceptedHead: H1 }).map((x) => [x.kind, x.reason]), [["merge", "accepted, with the independent review overridden by the developer: No other family is available; run `atelier merge` in the project checkout"]]);
  assert.equal(entry({ state: "accepted", acceptedHead: H1 })[0].reason, "accepted; run `atelier merge` in the project checkout");
  // The page's decision line says the owner's approval is not the review, and gives the override's reason once used.
  const waiting = decisionFor(item(), policy, touching, [review("owner")]);
  assert.deepEqual([waiting.title, waiting.action], ["Waiting for an independent review", "review"]);
  assert.match(waiting.detail, /Your own approval does not count as that review\. If no reviewer qualifies, you can accept with an override and say why\.$/);
  assert.equal(decisionFor(item({ reviewOverride }), policy, touching, []).detail, "Required checks passed for this revision, and you overrode the independent review: No other family is available. Accept it to prepare the local merge.");
  assert.equal(decisionFor(item({ reviewOverride, state: "accepted", acceptedHead: H1 }), policy, touching, []).detail, "You accepted it with the independent review overridden: No other family is available. Run the revision-bound command below in your local checkout.");
});

// macOS's default disk stores names that differ only by letter case or
// Unicode form as one file, so the owner's checkout writes such a path over
// the protected file it aliases.
const defaults: ProjectPolicy = { checks: ["npm test", "./check.sh"], protected: ["AGENTS.md", "CLAUDE.md", "wrangler.*", "docs/caf\u00e9/**"] };

test("a role prompt override is protected by default, so changing one needs a review", () => {
  // `.atelier/prompts/**` is in DEFAULT_PROTECTED (src/ledger.ts, asserted in
  // ledger.spec.ts and routes.spec.ts); this is the guard that keeps an
  // unvetted role prompt from landing and reaching a runner. The matcher is
  // what changeClass runs on, so a change to a role prompt is protected even
  // when the project lists no protected paths of its own.
  for (const path of [".atelier/prompts/review.md", ".atelier/prompts/build.md", ".atelier/prompts/sub/orchestrate.md"]) {
    assert.equal(changeClass([path], { checks: [], protected: [".atelier/prompts/**"] }), "protected", path);
  }
  assert.equal(changeClass(["src/a.ts"], { checks: [], protected: [".atelier/prompts/**"] }), "coordinated");
});

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
  // As for CLAUDE.md itself (decision 2026-10-06): the owner's approval is not
  // the review, and another family's approval is.
  assert.equal(gate(held, defaults, observed, [review("owner")]).ready, false);
  assert.equal(gate(held, defaults, observed, [review("codex/gpt-6-astra")]).ready, true);
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

// The checks on the would-be merge, the head merged with main as it is now,
// are bound to both revisions: they stand beside the merge preview and never
// in place of the head's own run.
test("a merged check never satisfies the head's own check, and is read beside the preview with its main head", () => {
  const M0 = "c".repeat(40), M1 = "d".repeat(40);
  const merged = pass({ merged: true, mainHead: M1, changedPaths: null, at: "2026-10-03T13:00:00.000Z" });
  assert.equal(evidenceAt(policy, [merged], H1).checks[0].grade, "pending");
  assert.equal(evidenceAt(policy, [merged], H1).changedPaths, null);
  assert.match(gate(item(), policy, [merged], []).blockers.join(), /not yet observed at this head/);
  const view = mergedChecksAt(policy, [merged], H1, M1);
  assert.deepEqual(view.checks.map((c) => [c.claim, c.grade, c.passed, c.mainHead, c.stale, c.where]), [["npm test", "observed", true, M1, false, "runner"]]);
  assert.equal(view.run, true);
  assert.equal(mergedChecksAt(policy, [merged], H1, M0).checks[0].stale, true, "stale once main has moved past the head it merged with");
  assert.equal(mergedChecksAt(policy, [merged], H2, M1).run, false, "a new head retires every merged run");
  assert.deepEqual(mergedChecksAt(policy, [], H1, M1), { checks: [{ claim: "npm test", grade: "pending", passed: null, stale: false }], run: false });
  assert.equal(mergedChecksAt({ ...policy, sandboxOnly: true }, [merged], H1, M1).run, false, "under sandboxOnly a merged run on a runner does not count");
  // The head's own run records main's head too, and is still the head's check.
  const own = pass({ mainHead: M0 });
  assert.deepEqual(evidenceAt(policy, [own], H1).checks, [{ claim: "npm test", grade: "observed", passed: true, where: "runner", mainHead: M0 }]);
});

test("a failing merged check blocks only when main moved after the head's own checks passed, until a later run passes", () => {
  const M0 = "c".repeat(40), M1 = "d".repeat(40), M2 = "e".repeat(40);
  const own = pass({ mainHead: M0 });
  const failing = pass({ merged: true, mainHead: M1, passed: false, changedPaths: null, at: "2026-10-03T13:00:00.000Z" });
  const g = gate(item(), policy, [own, failing], []);
  assert.equal(g.ready, false);
  assert.deepEqual(g.blockers, ["`npm test` failed on the merge with main at dddddddd, which moved after this revision's own checks passed; run atelier check --merged again, or bring main into the workspace"]);
  assert.deepEqual(mergedBlockers(policy, [own, failing], H1), g.blockers);
  const decision = decisionFor(item(), policy, [own, failing], []);
  assert.equal(decision.title, "Checks need attention");
  assert.match(decision.detail, /fail on its merge with main/);
  assert.equal(inboxFor("p", [item()], policy, [own, failing], [], new Date(T))[0]?.kind, "failing");
  // Shown, not required: main had not moved when the head's own check passed against the same commit.
  assert.equal(gate(item(), policy, [pass({ mainHead: M1 }), failing], []).ready, true);
  // A head check that recorded no main head cannot say main moved.
  assert.equal(gate(item(), policy, [pass(), failing], []).ready, true);
  // A merged run that precedes every run of the head's own check leaves nothing to compare main with, and the head's own run that follows does not clear it (t178).
  assert.equal(gate(item(), policy, [pass({ mainHead: M0, at: "2026-10-03T15:00:00.000Z" }), failing], []).ready, false);
  // A passing merged run never blocks, and a later one clears an earlier failure.
  assert.equal(gate(item(), policy, [own, pass({ merged: true, mainHead: M1, changedPaths: null })], []).ready, true);
  assert.equal(gate(item(), policy, [own, failing, pass({ merged: true, mainHead: M2, changedPaths: null, at: "2026-10-03T14:00:00.000Z" })], []).ready, true);
  // While the head's own check is pending or failing, that check is the blocker.
  assert.deepEqual(gate(item(), policy, [failing], []).blockers.filter((b) => b.includes("merge")), []);
  assert.deepEqual(gate(item(), policy, [own, pass({ passed: false, mainHead: M0, at: "2026-10-03T12:30:00.000Z" }), failing], []).blockers.filter((b) => b.includes("merge")), []);
  // Under sandboxOnly, a merged run on a runner neither blocks nor counts.
  const strict: ProjectPolicy = { ...policy, sandboxOnly: true };
  assert.equal(gate(item(), strict, [pass({ where: "sandbox", mainHead: M0 }), failing], []).ready, true);
  assert.equal(gate(item(), strict, [pass({ where: "sandbox", mainHead: M0 }), { ...failing, where: "sandbox" }], []).ready, false);
});

// PAVI's decision of 2026-10-06 (t178): a failing merged check at the head
// stands until a merged run passes or the head moves. The head's own check,
// run again later, passes on the head's tree and says nothing about the merge.
test("a failing merged check survives a later plain run of the head's own check", () => {
  const M0 = "c".repeat(40), M1 = "d".repeat(40);
  const own = pass({ mainHead: M0 });
  const failing = pass({ merged: true, mainHead: M1, passed: false, changedPaths: null, at: "2026-10-03T13:00:00.000Z" });
  assert.equal(gate(item(), policy, [own, failing], []).ready, false);
  // Run again later against main as it now is: the same main head the merged run named.
  const again = pass({ mainHead: M1, at: "2026-10-03T14:00:00.000Z" });
  const g = gate(item(), policy, [own, failing, again], []);
  assert.equal(g.ready, false);
  assert.deepEqual(g.blockers, mergedBlockers(policy, [own, failing], H1));
  assert.equal(mergedBlockers(policy, [own, failing, again], H1).length, 1);
  // And against the older main head the first run saw.
  assert.equal(gate(item(), policy, [own, failing, pass({ mainHead: M0, at: "2026-10-03T14:00:00.000Z" })], []).ready, false);
  // The head's own check still has to pass: a later failing plain run is the blocker, not the merged one.
  assert.deepEqual(gate(item(), policy, [own, failing, pass({ passed: false, mainHead: M1, at: "2026-10-03T14:00:00.000Z" })], []).blockers.filter((b) => b.includes("merge")), []);
});

test("a passing merged run clears a failing one, whatever plain runs came between", () => {
  const M1 = "d".repeat(40);
  const own = pass({ mainHead: "c".repeat(40) });
  const failing = pass({ merged: true, mainHead: M1, passed: false, changedPaths: null, at: "2026-10-03T13:00:00.000Z" });
  const again = pass({ mainHead: M1, at: "2026-10-03T14:00:00.000Z" });
  const passing = pass({ merged: true, mainHead: M1, changedPaths: null, at: "2026-10-03T15:00:00.000Z" });
  assert.equal(gate(item(), policy, [own, failing, again], []).ready, false);
  assert.equal(gate(item(), policy, [own, failing, again, passing], []).ready, true);
  assert.deepEqual(mergedBlockers(policy, [own, failing, again, passing], H1), []);
});

test("a new head clears a failing merged check", () => {
  const M1 = "d".repeat(40);
  const own = pass({ mainHead: "c".repeat(40) });
  const failing = pass({ merged: true, mainHead: M1, passed: false, changedPaths: null, at: "2026-10-03T13:00:00.000Z" });
  assert.equal(mergedBlockers(policy, [own, failing], H1).length, 1);
  assert.deepEqual(mergedBlockers(policy, [own, failing], H2), []);
  const next = pass({ head: H2, mainHead: M1, at: "2026-10-03T14:00:00.000Z" });
  assert.equal(gate(item({ head: H2 }), policy, [own, failing, next], []).ready, true);
});

test("a make -C into an absolute directory guards no repository file under that name", () => {
  const files = checkFiles(["make -C /opt/x check"]);
  assert.equal(files.some((f) => f.startsWith("opt/")), false);
});

test("two scopes overlap within a set of globs when some path all three could name", () => {
  assert.equal(scopesOverlapWithin(["src/**"], ["src/ledger.ts"], ["src/ledger.ts", "cli/runner.mjs"]), "src/ledger.ts");
  assert.equal(scopesOverlapWithin(["src/ledger.ts"], ["src/index.ts"], ["src/**"]), null);
  assert.equal(scopesOverlapWithin(["src/**"], ["src/ui/**"], ["cli/runner.mjs"]), null);
  assert.equal(scopesOverlapWithin(["cli/**"], [], ["src/ledger.ts", "cli/runner.mjs"]), "cli/runner.mjs");
  assert.equal(scopesOverlapWithin(["src/**"], ["src/**"], []), null);
});

// t326: a review counts only while its head and its criteria binding are the
// item's own and it is not withdrawn, approval and rejection alike, and every
// rule the gate held before still holds.
test("a review counts only for the head and the acceptance criteria it was bound to, approval and rejection alike", () => {
  const accept = ["The parser reads nested lists"];
  const task = item({ accept });
  const bound = criteriaHash(accept);
  const touching = [pass({ changedPaths: ["AGENTS.md"] })];
  const yes = (over: Partial<Review> = {}) => review("codex/gpt-6", { criteria: bound, ...over });
  // Matching head and criteria: the approval satisfies the gate.
  assert.equal(gate(task, policy, touching, [yes()]).ready, true);
  // Wrong head, or criteria the task no longer has (other text, the empty
  // list), or withdrawn: it satisfies nothing.
  for (const r of [yes({ head: H2 }), yes({ criteria: NO_CRITERIA }), yes({ criteria: criteriaHash(["The parser reads lists"]) }), yes({ withdrawn: { at: T, reason: "the acceptance criteria changed" } })]) {
    const g = gate(task, policy, touching, [r]);
    assert.equal(g.ready, false);
    assert.equal(g.needsAssessor, true);
  }
  // A rejection blocks only when it is bound the same way.
  const no = (over: Partial<Review> = {}) => review("zcode/glm-5.3", { criteria: bound, approve: false, note: "unsafe", ...over });
  assert.match(gate(task, policy, touching, [yes(), no()]).blockers.join(), /rejected by zcode\/glm-5.3: unsafe/);
  for (const r of [no({ head: H2 }), no({ criteria: NO_CRITERIA }), no({ withdrawn: { at: T, reason: "x" } })]) assert.equal(gate(task, policy, touching, [yes(), r]).ready, true);
  assert.equal(decisionFor(task, policy, touching, [yes(), no({ criteria: NO_CRITERIA })]).action, "accept");
  // The latest standing review per reviewer decides: an approval bound to old
  // criteria after a bound rejection does not lift it.
  assert.equal(gate(task, policy, touching, [no({ by: "codex/gpt-6" }), yes({ criteria: NO_CRITERIA, at: "2026-10-04" })]).ready, false);
  // Binding takes nothing away from the rules before it: a contributor, the
  // project owner, an owner-recorded approval no claim backs, a tier
  // approval, a contributor's family, and under a role policy a reviewer
  // without the assessor role do not count.
  assert.equal(gate(task, policy, touching, [yes({ by: "claude-code/opus-5.5" })]).ready, false);
  assert.equal(gate(task, policy, touching, [yes({ by: "owner" })]).ready, false);
  assert.equal(gate(task, policy, touching, [yes({ proved: false, claimed: false, recordedBy: "owner" })]).ready, false);
  assert.equal(gate(task, policy, touching, [yes({ tier: true })]).ready, false);
  assert.equal(gate(task, policy, touching, [yes({ by: "anthropic/sonnet-5.5" })]).ready, false);
  const g = gate(item({ accept, owner: "zcode/glm-5.3" }), governed, [pass({ changedPaths: ["docs/secret/a.md"] })], [review("gemini-cli/gemini-3", { criteria: bound })]);
  assert.equal(g.ready, false, "gemini has no available assessor role");
});

test("reviews recorded before reviews were bound stay visible but neither satisfy nor block, with or without criteria", () => {
  const touching = [pass({ changedPaths: ["AGENTS.md"] })];
  const legacy = (over: Partial<Review>): Review => { const { criteria: _c, ...r } = review("codex/gpt-6", over); return r; };
  for (const accept of [undefined, [], ["It parses"]]) {
    const task = item(accept === undefined ? {} : { accept });
    const approval = legacy({}), rejection = legacy({ by: "zcode/glm-5.3", approve: false, note: "old" });
    const g = gate(task, policy, touching, [approval, rejection]);
    assert.equal(g.ready, false);
    assert.equal(g.needsAssessor, true, "the old approval does not satisfy");
    assert.ok(!g.blockers.some((b) => /rejected by/.test(b)), "the old rejection does not block");
    assert.equal(approval.criteria, undefined, "nothing stamps it");
    // A fresh review bound to the criteria as they are satisfies the gate.
    assert.equal(gate(task, policy, touching, [approval, rejection, review("codex/gpt-6", { criteria: criteriaHash(accept) })]).ready, true);
  }
});


test("review leases expire at five server-clock minutes; renewal cadence is thirty seconds", async () => {
  const { REVIEW_LEASE_MS, REVIEW_RENEW_MS, reviewLeaseExpired } = await import("../src/rules.ts");
  const start = Date.parse(T);
  assert.equal(REVIEW_RENEW_MS, 30_000);
  assert.equal(REVIEW_LEASE_MS, 300_000);
  assert.equal(reviewLeaseExpired(T, start + REVIEW_LEASE_MS - 1), false);
  assert.equal(reviewLeaseExpired(T, start + REVIEW_LEASE_MS), true);
  assert.equal(reviewLeaseExpired(T, start + REVIEW_LEASE_MS + 1), true);
  assert.equal(reviewLeaseExpired(null, start), true);
  assert.equal(reviewLeaseExpired("invalid", start), true);
});

test("only the project owner can port to an open unclaimed task", () => {
  assert.equal(ownerPortAllowed(item({ state: "open", owner: null }), "person", "person"), true);
  assert.equal(ownerPortAllowed(item({ state: "open", owner: null }), "builder", "person"), false);
  assert.equal(ownerPortAllowed(item({ state: "open", owner: "builder" }), "person", "person"), false);
  for (const state of ["claimed", "submitted", "accepted", "integrated", "merged", "abandoned", "blocked"] as const) {
    assert.equal(ownerPortAllowed(item({ state, owner: null }), "person", "person"), false);
  }
});

// ── modes (t585) ─────────────────────────────────────────────────────────────
// On 2026-10-13 Artifacts failed every new fork, so four finished tasks were
// merged by hand outside the record. Fast mode records that path; these pin
// its pure rules.
import { contributorsOf, contributed, projectMode, modeLine, modeSwitch, assertFastMode, fastReceipt, recordedMerge, recordedMergeRefusal, agentOfMessage, agentsOfMessages, postMergeIndependence, fastFixTask, SAME_FAMILY_FAST, postMergeOwed, postMergeReviewLine, fastLandedLines } from "../src/rules.ts";

test("the project is in full mode unless a fast record stands, and only the owner switches, fast with a reason", () => {
  assert.deepEqual(projectMode(null), { mode: "full" });
  assert.deepEqual(projectMode({ mode: "fast" }), { mode: "full" });
  assert.equal(modeLine({ mode: "full" }), "Mode: full");
  const at = "2026-10-13T14:05:09.000Z";
  assert.throws(() => modeSwitch({ mode: "full" }, "codex/gpt-6", "owner", "fast", "forks fail", at), (e: RuleError) => e.code === "not_project_owner");
  assert.throws(() => modeSwitch({ mode: "full" }, "owner", "owner", "fast", "  ", at), (e: RuleError) => e.code === "bad_reason");
  assert.throws(() => modeSwitch({ mode: "full" }, "owner", "owner", "slow", "x", at), (e: RuleError) => e.code === "bad_mode");
  assert.throws(() => modeSwitch({ mode: "full" }, "owner", "owner", "full", undefined, at), (e: RuleError) => e.code === "already_full");
  const fast = modeSwitch({ mode: "full" }, "owner", "owner", "fast", "Artifacts fails\nevery fork", at);
  assert.deepEqual(fast, { mode: "fast", since: at, reason: "Artifacts fails every fork", by: "owner", decision: null });
  assert.equal(modeLine(fast), "Mode: fast since 2026-10-13 14:05 UTC (Artifacts fails every fork)");
  assert.deepEqual(projectMode(JSON.parse(JSON.stringify(fast))), fast);
  assert.throws(() => modeSwitch(fast, "owner", "owner", "fast", "again", at), (e: RuleError) => e.code === "already_fast");
  assert.deepEqual(modeSwitch(fast, "owner", "owner", "full", undefined, at), { mode: "full" });
  assert.throws(() => assertFastMode({ mode: "full" }), (e: RuleError) => e.code === "not_fast_mode");
  assertFastMode(fast);
});

// Astra's audit of 2026-10-13, finding 3: fast mode lands without the gate,
// so switching to it took the developer token alone and skipped both the
// confirmation an override needs and a project's --no-override. The switch
// and a fast landing are refused under noOverride, and the switch needs the
// permission the developer gives on the Settings page with the factor no
// agent holds, as an override from the command line does.
import { assertFastModeAllowed, assertFastModeConfirmed, fastModeConfirmationHint } from "../src/rules.ts";

test("fast mode is refused where overrides are, and the switch needs the developer's confirmation, not the token", () => {
  assert.throws(() => assertFastModeAllowed({ noOverride: true }), (e: RuleError) => e.code === "fast_mode_forbidden" && /forbids overrides/.test(e.detail) && /--no-override/.test(e.detail));
  assertFastModeAllowed({});
  const now = Date.parse("2026-10-13T14:00:00.000Z");
  const given = { by: "owner", at: "2026-10-13T13:50:00.000Z", until: "2026-10-13T14:05:00.000Z", factor: "secret" as const };
  assert.throws(() => assertFastModeConfirmed(null, now, "owner", "proj"), (e: RuleError) => e.code === "fast_mode_unconfirmed" && e.status === 403 && /Allow fast mode from the command line/.test(e.detail) && /developer token alone/.test(e.detail));
  assert.throws(() => assertFastModeConfirmed({ ...given, until: "2026-10-13T13:59:00.000Z" }, now, "owner", "proj"), (e: RuleError) => e.code === "fast_mode_unconfirmed");
  assert.throws(() => assertFastModeConfirmed({ ...given, by: "codex/gpt-6" }, now, "owner", "proj"), (e: RuleError) => e.code === "fast_mode_unconfirmed");
  assertFastModeConfirmed(given, now, "owner", "proj");
  assert.match(fastModeConfirmationHint("proj", "https://a.test", "access"), /^open https:\/\/a\.test\/p\/proj\/settings as the developer, press "Allow fast mode from the command line" under your Cloudflare Access sign-in/);
  assert.match(fastModeConfirmationHint("proj", "", null), /this server can take no confirmation/);
});

// t629 reverses t596's confirmation for the command line (Astra's audit of
// 2026-10-13, finding 3; the developer's decision of 2026-10-13: "why isn't
// my direction sufficient?"). The developer token alone switches to fast mode
// or overrides a missing review when the request carries the developer's own
// words and names the model acting on them, so every such switch says who
// asked and why; a blank quote, or none, or no acting model is refused.
import { ownerDirection, overrideConfirmationHint, DIRECTION_QUOTE_MAX } from "../src/rules.ts";

test("the developer's direction is their quoted words and the model acting on them, both required", () => {
  assert.equal(ownerDirection(undefined, "claude-code/opus-5.5", "fast mode"), null);
  assert.deepEqual(ownerDirection("  go fast,\n forks fail  ", "claude-code/opus-5.5", "fast mode"), { quote: "go fast, forks fail", acting: "claude-code/opus-5.5" });
  for (const bad of ["", "   ", 42, null]) assert.throws(() => ownerDirection(bad, "claude-code/opus-5.5", "fast mode"), (e: RuleError) => e.code === "bad_quote" && e.status === 400 && /--quote/.test(e.detail), String(bad));
  assert.throws(() => ownerDirection("x".repeat(DIRECTION_QUOTE_MAX + 1), "claude-code/opus-5.5", "fast mode"), (e: RuleError) => e.code === "too_long");
  for (const none of [null, undefined, ""]) assert.throws(() => ownerDirection("go fast", none as never, "an override of the independent review"), (e: RuleError) => e.code === "no_acting" && e.status === 400 && /--as H\/M/.test(e.detail) && /an override/.test(e.detail));
  // The mode line says whose words switched it, and who relayed them.
  const fast = { mode: "fast" as const, since: "2026-10-13T14:05:00.000Z", reason: "forks fail", by: "owner", decision: "d1" };
  assert.equal(modeLine(fast), "Mode: fast since 2026-10-13 14:05 UTC (forks fail)");
  assert.equal(modeLine({ ...fast, quote: "go fast", acting: "claude-code/opus-5.5" }), "Mode: fast since 2026-10-13 14:05 UTC (forks fail); the developer's words: \u201cgo fast\u201d, relayed by claude-code/opus-5.5");
  // Both refusals name the direction as the other way to confirm.
  assert.match(fastModeConfirmationHint("proj"), /Allow fast mode from the command line.*; or run it again with --quote "the developer's words" and --as H\/M naming the model acting on them/);
  assert.match(overrideConfirmationHint("proj", "t1"), /Allow an override from the command line.*; or run it again with --quote "the developer's words" and --as H\/M naming the model acting on them/);
});

test("a landed-fast receipt needs both commits, the builder, the test command and its output's sha256, in fast mode only", () => {
  const fast = projectMode({ mode: "fast", since: "2026-10-13T00:00:00Z", reason: "forks fail", by: "owner" });
  const body = { commit: H1, mergeCommit: H2, testedHead: H2, batch: `${H1}..${H2}`, builder: "claude-code/opus-5.5", tests: { command: "npm test", sha256: "c".repeat(64) } };
  const r = fastReceipt(body, fast, "owner", "2026-10-13T01:00:00Z");
  assert.deepEqual(r, { ...body, reason: "forks fail", at: "2026-10-13T01:00:00Z", by: "owner" });
  assert.throws(() => fastReceipt(body, { mode: "full" }, "owner", "x"), (e: RuleError) => e.code === "not_fast_mode");
  for (const bad of [{ commit: "abc" }, { mergeCommit: null }, { builder: "nobody" }, { tests: { command: "npm test", sha256: "short" } }, { tests: { command: "", sha256: "c".repeat(64) } }, { tests: { command: "npm test", sha256: "c".repeat(64), where: "laptop" } }]) {
    assert.throws(() => fastReceipt({ ...body, ...bad }, fast, "owner", "x"), (e: RuleError) => e.code === "bad_receipt", JSON.stringify(bad));
  }
  // The tested head and the batch (t601): a receipt without them, or whose batch does not end at the tested head, is refused.
  for (const bad of [{ testedHead: undefined }, { testedHead: "abc" }, { batch: undefined }, { batch: H2 }, { batch: `${H1}..${H1}` }, { batch: `${H1}..${H2}x` }]) {
    assert.throws(() => fastReceipt({ ...body, ...bad }, fast, "owner", "x"), (e: RuleError) => e.code === "bad_receipt", JSON.stringify(bad));
  }
  // Where the tests ran (t588): the default run in a clean clone, a given --test in the checkout.
  for (const where of ["clean clone", "checkout"] as const) {
    const withWhere = { ...body, tests: { ...body.tests, where } };
    assert.deepEqual(fastReceipt(withWhere, fast, "owner", "x").tests, { command: "npm test", sha256: "c".repeat(64), where });
  }
  assert.equal(agentOfMessage("Fix it\n\nAgent: codex/gpt-6\nAgent: claude-code/opus-5.5\nCo-Authored-By: x"), "claude-code/opus-5.5");
  assert.equal(agentOfMessage("no trailer"), null);
  // The builder becomes a contributor, as a pusher is.
  assert.deepEqual(pushActors([{ actor: "owner", kind: "item.landed_fast", data: { builder: "claude-code/opus-5.5" } }]), ["claude-code/opus-5.5"]);
});

// Finding it would have caught (Astra finding 10, 2026-10-16): the fast landing took
// the builder from the tip commit's Agent line only, so a model that wrote an
// earlier commit of the range could later review the change.
test("a fast landing's contributors are every agent of the range, and gate review independence (t603)", () => {
  const fast = projectMode({ mode: "fast", since: "2026-10-13T00:00:00Z", reason: "forks fail", by: "owner" });
  const tests = { command: "npm test", sha256: "c".repeat(64) };
  const body = { commit: H1, mergeCommit: H2, testedHead: H2, batch: `${H1}..${H2}`, builder: "claude-code/opus-5.5", contributors: ["codex/gpt-6"], tests };
  assert.deepEqual(fastReceipt(body, fast, "owner", "x").contributors, ["claude-code/opus-5.5", "codex/gpt-6"]);
  assert.equal("contributors" in fastReceipt({ ...body, contributors: undefined }, fast, "owner", "x"), false);
  for (const bad of ["codex", ["nobody"], [7], Array(51).fill("codex/gpt-6")]) {
    assert.throws(() => fastReceipt({ ...body, contributors: bad }, fast, "owner", "x"), (e: RuleError) => e.code === "bad_receipt", JSON.stringify(bad));
  }
  assert.deepEqual(agentsOfMessages(["a\n\nAgent: codex/gpt-6", "b\n\nAgent: claude-code/opus-5.5\nAgent: codex/gpt-6", "none"]), ["codex/gpt-6", "claude-code/opus-5.5"]);
  const landed = [{ actor: "owner", kind: "item.landed_fast", data: { builder: "claude-code/opus-5.5", contributors: ["claude-code/opus-5.5", "codex/gpt-6"] } }];
  const contributors = contributorsOf({ owner: null, pushActors: pushActors(landed) });
  assert.deepEqual(contributors, ["claude-code/opus-5.5", "codex/gpt-6"]);
  // The earlier commit's model no longer passes as an independent reviewer.
  assert.equal(contributed("codex/gpt-6", contributors), true);
  assert.deepEqual(pushActors([{ actor: "owner", kind: "item.landed_fast", data: { builder: "claude-code/opus-5.5", contributors: ["nobody", 3] } }]), ["claude-code/opus-5.5"]);
});

// Astra, 2026-10-13, finding 7: a fast landing with no --reviewer, or whose
// ask failed, printed "no post-merge review asked" and nothing owed it.
test("a fast landing's post-merge review is owed until a verdict stands or a request is being served", () => {
  for (const state of ["approved", "rejected", "open", "claimed"]) assert.equal(postMergeOwed(state), false, state);
  for (const state of ["not requested", "withdrawn", "answered", "anything new"]) assert.equal(postMergeOwed(state), true, state);
  assert.match(postMergeReviewLine("t9", { state: "not requested", by: null }), /^OWED: .*t9.*atelier review-request t9 --reviewer H\/M/);
  assert.equal(postMergeReviewLine("t9", { state: "approved", by: "codex/gpt-6" }), "post-merge review approved by codex/gpt-6");
  const landing = (item: string, state: string) => ({ item, receipt: { mergeCommit: "a".repeat(40), builder: "claude-code/opus-5.5" }, review: { state, by: null }, fix: null });
  assert.deepEqual(fastLandedLines([]), ["Nothing landed in fast mode."]);
  const lines = fastLandedLines([landing("t1", "approved"), landing("t2", "not requested"), landing("t3", "withdrawn")]);
  assert.match(lines[1], /OWED/);
  assert.equal(lines.at(-1), "Post-merge reviews still owed: t2, t3. A fast landing is not reviewed until one is asked and answered.");
  assert.doesNotMatch(fastLandedLines([landing("t1", "open")]).join("\n"), /OWED|still owed/);
});

test("a same-family post-merge review is accepted only for a task landed in fast mode, and says so", () => {
  const contributors = ["claude-code/opus-5.5"];
  assert.deepEqual(postMergeIndependence("claude-code/sonnet-5", contributors, null, true), { refusal: null, independence: SAME_FAMILY_FAST });
  assert.match(postMergeIndependence("claude-code/sonnet-5", contributors, null, false).refusal ?? "", /same family/);
  assert.deepEqual(postMergeIndependence("codex/gpt-6", contributors, null, false), { refusal: null, independence: null });
  assert.equal(SAME_FAMILY_FAST, "same-family (fast mode)");
  const fix = fastFixTask("t9", "Add a thing", { by: "claude-code/sonnet-5", head: H2, note: "breaks x", request: 3, findings: [{ file: "src/a.ts", line: 4, severity: "blocking", text: "null deref" }] });
  assert.equal(fix.title, "Fix after fast landing of t9: Add a thing");
  assert.deepEqual(fix.accept, ["src/a.ts:4: null deref"]);
  assert.deepEqual(fastFixTask("t9", "x", { by: "a/b", head: H2, note: "wrong", findings: [] }).accept, ["Resolve the post-merge review's rejection of t9: wrong"]);
});

// ── fast builds (t589) ───────────────────────────────────────────────────────
// 2026-10-13 10:35 EDT: in fast mode every runner build still began with a
// claim that forks main, and the forks failed, so builds ran by hand in
// local clones. In fast mode a dispatched plain build is taken without a
// fork and its commit reported ready; in full mode nothing changes.
import { fastJobRefusal, fastBuildRefusal, assertFastBuild, fastReady, standingFastReady, fastReadyLines } from "../src/rules.ts";

const FAST = projectMode({ mode: "fast", since: "2026-10-13T14:00:00.000Z", reason: "forks fail", by: "owner" });
const BUILD = { id: "t9", kind: undefined, plan: undefined, dispatch: { at: T, agent: "claude-code", model: "opus-5.5" } } as unknown as Item;

test("in fast mode a dispatched plain build is taken without a fork; in full mode every build claims with one", () => {
  assert.equal(fastBuildRefusal(FAST, BUILD), null);
  assert.match(fastBuildRefusal({ mode: "full" }, BUILD) ?? "", /full mode, so a build claims with a fork/);
  assert.throws(() => assertFastBuild({ mode: "full" }, BUILD), (e: RuleError) => e.code === "not_fast_mode" && e.status === 409);
  assert.doesNotThrow(() => assertFastBuild(FAST, BUILD));
  // A job named build is the same as none named.
  assert.equal(fastJobRefusal({ ...BUILD, dispatch: { ...BUILD.dispatch!, job: "build" } }), null);
  // Plans, parts and merge-main jobs keep the claim in either mode.
  for (const other of [{ ...BUILD, kind: "plan" as const }, { ...BUILD, kind: "part" as const, plan: "t1" }, { ...BUILD, dispatch: { ...BUILD.dispatch!, job: "merge-main" } }, { ...BUILD, dispatch: { ...BUILD.dispatch!, job: "plan" } }]) {
    assert.ok(fastJobRefusal(other as Item), JSON.stringify(other));
    assert.throws(() => assertFastBuild(FAST, other as Item), (e: RuleError) => e.code === "not_fast_build");
  }
  // A fork that holds work from an earlier claim is built there; an empty one is not.
  assert.match(fastJobRefusal({ ...BUILD, fork: "p--t9", base: H1, head: H2 }) ?? "", /fork holds work/);
  assert.equal(fastJobRefusal({ ...BUILD, fork: "p--t9", base: H1, head: H1 }), null);
  // A fast take is for a dispatched build.
  assert.throws(() => assertFastBuild(FAST, { ...BUILD, dispatch: null }), (e: RuleError) => e.code === "not_dispatched");
});

test("a fast build's report names the commit, its main and the builder its Agent line names, from the holder, in fast mode", () => {
  const held = { id: "t9", state: "claimed" as const, owner: "claude-code/opus-5.5", runner: "home:studio" };
  const body = { commit: H2, base: H1, builder: "claude-code/opus-5.5", workspace: "/Users/x/cache/fast/p/t9" };
  assert.deepEqual(fastReady(body, FAST, held, "claude-code/opus-5.5"), { ...body, runner: "home:studio" });
  // The runner is the server's record, not the report's.
  assert.equal(fastReady({ ...body, runner: "home:other" }, FAST, held, "claude-code/opus-5.5").runner, "home:studio");
  assert.equal(fastReady({ ...body, workspace: undefined }, FAST, held, "claude-code/opus-5.5").workspace, null);
  assert.throws(() => fastReady(body, { mode: "full" }, held, "claude-code/opus-5.5"), (e: RuleError) => e.code === "not_fast_mode");
  assert.throws(() => fastReady(body, FAST, held, "codex/gpt-6"), (e: RuleError) => e.code === "not_holder");
  assert.throws(() => fastReady(body, FAST, { ...held, state: "open" as const }, "claude-code/opus-5.5"), (e: RuleError) => e.code === "not_holder");
  assert.throws(() => fastReady({ ...body, commit: H1 }, FAST, held, "claude-code/opus-5.5"), (e: RuleError) => e.code === "nothing_built");
  for (const bad of [{ commit: "abc" }, { base: null }, { builder: "nobody" }, { builder: "codex/gpt-6" }, { workspace: "relative/path" }, { workspace: `/${"x".repeat(1001)}` }, { workspace: "/a\nb" }]) {
    assert.throws(() => fastReady({ ...body, ...bad }, FAST, held, "claude-code/opus-5.5"), (e: RuleError) => e.code === "bad_ready", JSON.stringify(bad));
  }
});

test("the standing report is the last one with no claim, release, handoff, dispatch or close after it", () => {
  const ev = (seq: number, kind: string, data: Record<string, unknown> = {}) => ({ seq, kind, data, at: `2026-10-13T14:0${seq}:00.000Z`, actor: "claude-code/opus-5.5" });
  const ready = (seq: number, commit: string) => ev(seq, "item.fast_ready", { commit, base: "0".repeat(40), builder: "claude-code/opus-5.5", runner: "home:studio", workspace: "/w" });
  assert.equal(standingFastReady([]), null);
  // In any order: the task page's events come newest first.
  assert.deepEqual(standingFastReady([ready(3, H2), ev(2, "item.fast_taken"), ev(1, "item.claimed")]), { commit: H2, base: "0".repeat(40), builder: "claude-code/opus-5.5", runner: "home:studio", workspace: "/w", at: "2026-10-13T14:03:00.000Z", by: "claude-code/opus-5.5" });
  assert.equal(standingFastReady([ready(1, H1), ready(4, H2)])?.commit, H2);
  for (const kind of ["item.claimed", "item.released", "item.handoff", "item.dispatched", "item.merged", "item.abandoned"]) {
    assert.equal(standingFastReady([ready(1, H1), ev(2, kind)]), null, kind);
  }
  // Events that change nothing about the build leave it standing.
  assert.equal(standingFastReady([ready(1, H1), ev(2, "review.requested")])?.commit, H1);
});

test("fast status prints each ready commit as a tN=SHA line and the command that records its merge", () => {
  assert.deepEqual(fastReadyLines([]), ["Nothing is ready to merge."]);
  const lines = fastReadyLines([
    { item: "t5", commit: H1, builder: "claude-code/opus-5.5", runner: "home:studio", at: "2026-10-13T14:05:00.000Z" },
    { item: "t7", commit: H2, builder: "codex/gpt-6", runner: null, at: "2026-10-13T14:09:00.000Z" },
  ]);
  assert.deepEqual(lines, [
    "Ready to merge (2):",
    `t5=${H1}  built by claude-code/opus-5.5 on home:studio at 2026-10-13 14:05 UTC`,
    `t7=${H2}  built by codex/gpt-6 at 2026-10-13 14:09 UTC`,
    "Merge each, then record it:",
    `  atelier record-merge t5 --merge SHA --head ${H1} --review H/M=approve@${H1}`,
    `  atelier record-merge t7 --merge SHA --head ${H2} --review H/M=approve@${H2}`,
  ]);
  // Each line's first word is the task and the commit built.
  for (const l of lines.slice(1, 3)) assert.match(l.split(" ")[0], /^t\d+=[0-9a-f]{40}$/);
});

// t586: on 2026-10-13 from 09:35 to 10:05 EDT, after the deploys of t578
// and t585, the busy atelier Ledger kept its old code and answered "The RPC
// receiver does not implement the method" for showcaseCounts and mode.
test("the runtime's missing-method answer is recognised, and nothing else is", () => {
  assert.equal(missingLedgerMethod(new Error('The RPC receiver does not implement the method "showcaseCounts".')), "showcaseCounts");
  assert.equal(missingLedgerMethod(new Error("The RPC receiver does not implement the method mode")), "mode");
  assert.equal(missingLedgerMethod("The RPC receiver does not implement the method 'fastLandings'."), "fastLandings");
  assert.equal(missingLedgerMethod(new TypeError('The RPC receiver does not implement "mode".')), "mode");
  assert.equal(missingLedgerMethod(new Error("409|closed|t1 is merged")), null);
  assert.equal(missingLedgerMethod(undefined), null);
  assert.equal(UPDATING_DETAIL, "the server is updating; try again in a minute");
});

test("a Ledger restarts when its build differs from the Worker's or a method was missing, at most once a minute", () => {
  const OLD = "a".repeat(40), NEW = "b".repeat(40), now = 10_000_000;
  assert.deepEqual(ledgerRestart({ ledger: OLD, worker: NEW, last: null, now }), { restart: true, why: "stale" });
  assert.deepEqual(ledgerRestart({ ledger: NEW, worker: NEW, last: null, now }), { restart: false, why: "current" });
  // Local development and tests set no DEPLOYED_MAIN: no version restart.
  assert.deepEqual(ledgerRestart({ ledger: null, worker: NEW, last: null, now }), { restart: false, why: "unknown" });
  assert.deepEqual(ledgerRestart({ ledger: OLD, worker: null, last: null, now }), { restart: false, why: "unknown" });
  // A missing method restarts whatever the versions say.
  assert.deepEqual(ledgerRestart({ ledger: null, worker: null, last: null, now, missing: true }), { restart: true, why: "missing_method" });
  assert.deepEqual(ledgerRestart({ ledger: NEW, worker: NEW, last: null, now, missing: true }), { restart: true, why: "missing_method" });
  // Once a minute at most.
  const recent = { at: now - LEDGER_RESTART_GAP_MS + 1, from: "c".repeat(40), for: OLD };
  assert.deepEqual(ledgerRestart({ ledger: OLD, worker: NEW, last: recent, now }), { restart: false, why: "too_soon" });
  assert.deepEqual(ledgerRestart({ ledger: null, worker: null, last: recent, now, missing: true }), { restart: false, why: "too_soon" });
  assert.equal(ledgerRestart({ ledger: OLD, worker: NEW, last: { ...recent, at: now - LEDGER_RESTART_GAP_MS }, now }).restart, true);
  // A restart for a Worker that brought the same code back is not repeated
  // for that Worker: it was the older one (an old isolate after a deploy).
  const back = { at: now - 5 * LEDGER_RESTART_GAP_MS, from: NEW, for: OLD };
  assert.deepEqual(ledgerRestart({ ledger: NEW, worker: OLD, last: back, now }), { restart: false, why: "no_change" });
  assert.equal(ledgerRestart({ ledger: NEW, worker: "d".repeat(40), last: back, now }).restart, true, "the next deploy restarts it");
  // An earlier restart that moved the code does not stop the next deploy's.
  assert.equal(ledgerRestart({ ledger: NEW, worker: "d".repeat(40), last: { at: 0, from: OLD, for: NEW }, now }).restart, true);
});

test("the stored last restart is read back, and anything unreadable is none", () => {
  assert.deepEqual(parseLedgerRestart(JSON.stringify({ at: 5, from: "a", for: "b" })), { at: 5, from: "a", for: "b" });
  assert.deepEqual(parseLedgerRestart(JSON.stringify({ at: 5, from: null, for: "" })), { at: 5, from: null, for: null });
  assert.equal(parseLedgerRestart(undefined), null);
  assert.equal(parseLedgerRestart("not json"), null);
  assert.equal(parseLedgerRestart(JSON.stringify({ at: "soon" })), null);
});

// t641: the developer's branches. A name is taken under wip/ or refused;
// main, the project's branch, a task's id, a full ref and a name under
// another prefix are refused rather than renamed, which is what keeps
// `atelier branch push main` from ever naming main.
test("a developer branch is a name under wip/, and main, a task's id and any other prefix are refused", () => {
  assert.equal(developerBranch("idea"), "wip/idea");
  assert.equal(developerBranch("wip/idea"), "wip/idea");
  assert.equal(developerBranch("wip/mac/draft-2.1_x"), "wip/mac/draft-2.1_x");
  for (const name of ["main", "master", "HEAD", "t641", "trunk", "refs/heads/main", "refs/heads/wip/x", "feature/x", "wip/", "wip//x", "wip/x/", "wip/../main", "wip/x..y", "wip/.hidden", "wip/x.lock", "wip/x.", "wip/a b", "wip/x:y", "wip/x~1", "wip/-x", "", "wip/" + "a".repeat(200)]) {
    assert.throws(() => developerBranch(name, "trunk"), (e: unknown) => e instanceof RuleError && e.code === "bad_branch", name);
  }
  assert.throws(() => developerBranch(undefined), RuleError);
  // Only the project's own branch name is reserved beyond main, master and HEAD.
  assert.equal(developerBranch("trunk"), "wip/trunk");
});

test("the Mac a branch was pushed from is one short line, without .local", () => {
  assert.equal(branchHost("Pavis-MacBook-Pro.local"), "Pavis-MacBook-Pro");
  assert.equal(branchHost(" studio "), "studio");
  for (const host of ["", "  ", "a\nb", "x".repeat(101), 5, null]) assert.throws(() => branchHost(host), RuleError);
});

// The reviews of t641: a branches repository's name has a fixed form from a
// hash of the key, of the same length whatever the key, which every new
// baseline is refused and no task fork (KEY--tN) can have.
test("a branches repository is named devbr- and 32 hex digits of the key's hash, a form no baseline may take", async () => {
  const demo = await branchesRepoName("demo");
  assert.match(demo, /^devbr-[0-9a-f]{32}$/);
  assert.equal(await branchesRepoName("demo"), demo);
  assert.notEqual(await branchesRepoName("Demo"), demo);
  assert.match(await branchesRepoName("k".repeat(63)), /^devbr-[0-9a-f]{32}$/);
  // Argon's collision: project branches's fork of t1 is not project t1's branches.
  assert.notEqual(repoName("branches", "t1"), await branchesRepoName("t1"));
  assert.throws(() => assertBaselineName(demo), (e: unknown) => e instanceof RuleError && e.code === "repo_reserved");
  for (const repo of ["demo", "demo--branches", "branches", "branches--t1", "devbr-", "devbr-xyz", `${demo}x`]) assert.doesNotThrow(() => assertBaselineName(repo), repo);
});

// Private files (t645).
test("a private path is made plain, and one outside the checkout or in .git is refused", () => {
  assert.deepEqual(privatePath("PROJECT.md"), { path: "PROJECT.md" });
  assert.deepEqual(privatePath("./notes/plan.md"), { path: "notes/plan.md" });
  assert.deepEqual(privatePath("notes/"), { path: "notes" });
  for (const bad of ["", "  ", "/etc/passwd", "../outside.md", "notes/../x", "a//b", "./", ".git/config", ".GIT/hooks/x", "a\nb"]) {
    assert.ok("error" in privatePath(bad), JSON.stringify(bad));
  }
});

test("private paths match themselves and what lies under a private folder, as a Mac compares names", () => {
  const paths = ["PROJECT.md", "project.md", "notes/plan.md", "notes", "notesy.md", "src/PROJECT.md", "Notes/a.md"];
  assert.deepEqual(privatePathsAmong(paths, ["PROJECT.md", "notes"]), ["PROJECT.md", "project.md", "notes/plan.md", "notes", "Notes/a.md"]);
  assert.deepEqual(privatePathsAmong(paths, []), []);
});

test("a project's iCloud folder is the one named for it, case, spaces, hyphens and underscores aside", () => {
  assert.ok(privateFolderMatches("ikon-weblog", "ikon weblog"));
  assert.ok(privateFolderMatches("assetsapp", "AssetsApp"));
  assert.ok(privateFolderMatches("hqpe-control", "HQPe-Control"));
  assert.ok(!privateFolderMatches("atelier", "atelier-ops"));
  assert.ok(!privateFolderMatches("", ""));
});

test("each private path is excluded by an anchored line with its special characters escaped", () => {
  assert.equal(privateExcludeLine("PROJECT.md"), "/PROJECT.md");
  assert.equal(privateExcludeLine("notes/a*b?[c].md"), "/notes/a\\*b\\?\\[c\\].md");
  assert.equal(privateExcludeLine("#plan!"), "/#plan!");
  assert.equal(privateExcludeLine("trail  "), "/trail\\ \\ ");
});

test("the iCloud list of private files is read line by line as data, and written sorted with each path once", () => {
  assert.ok("error" in privatePath(".atelier-private"), "the list itself is never a private file");
  const r = parsePrivateList("# comment\nPROJECT.md\r\n\n  # indented comment\n../x\nnotes/\nPROJECT.md\n/abs\n.atelier-private\n");
  assert.deepEqual(r.paths, ["PROJECT.md", "notes"]);
  assert.deepEqual(r.refused.map((x) => [x.line, x.text]), [[5, "../x"], [8, "/abs"], [9, ".atelier-private"]]);
  const text = privateListText(["notes", "PROJECT.md", "notes"]);
  assert.deepEqual(text.split("\n").filter((l) => l && !l.startsWith("#")), ["PROJECT.md", "notes"]);
  assert.deepEqual(parsePrivateList(text), { paths: ["PROJECT.md", "notes"], refused: [] });
});

import { gateApprovals } from "../src/rules.ts";
import { recordedApproval } from "../src/landing-verdict.ts";

// t628 review (gpt-6-astra, gemini-3.1-pro-argon): a landing took any
// approval at a ready head for the review it needed. The gate's own
// selection says which approvals it counts, and a landing reads only that.
test("gateApprovals is the gate's selection: only approvals it counts as the independent review, none where no review is needed", () => {
  const touching = pass({ changedPaths: ["AGENTS.md"] });
  const a: Review = { itemId: "t1", by: "codex/gpt-5.5", head: H1, criteria: NO_CRITERIA, approve: true, note: "", at: T, proved: false, claimed: true };
  const unproved: Review = { ...a, by: "antigravity/gemini-3.1-pro", claimed: false };
  const sameFamily: Review = { ...a, by: "claude-code/sonnet-5.5" };
  const tier: Review = { ...a, by: "antigravity/gemini-3.1-pro", tier: true };
  const later: Review = { ...a, approve: false, at: "2026-10-03T13:00:00.000Z" };
  // A's claimed approval makes the gate ready; the unproved, same-family and
  // tier approvals beside it are never counted.
  assert.equal(gate(item(), policy, [touching], [a, unproved, sameFamily, tier]).ready, true);
  assert.deepEqual(gateApprovals(item(), policy, [touching], [a, unproved, sameFamily, tier]).map((r) => r.by), ["codex/gpt-5.5"]);
  assert.deepEqual(gateApprovals(item(), policy, [touching], [unproved, sameFamily, tier]), []);
  // The reviewer's latest verdict is a rejection: its approval no longer counts.
  assert.deepEqual(gateApprovals(item(), policy, [touching], [a, later]), []);
  // An unprotected change needs no review, so no approval is counted for one.
  assert.equal(gate(item(), policy, [pass()], [a]).ready, true);
  assert.deepEqual(gateApprovals(item(), policy, [pass()], [a]), []);
  // A review held outside the item counts none either.
  assert.deepEqual(gateApprovals(item(), policy, [touching], [a], "owner", { reviewHeld: true }), []);
});

test("a landing counts a recorded approval only where the gate is ready and counts that very approval, the named reviewer's where one is named (t628)", () => {
  const touching = pass({ changedPaths: ["AGENTS.md"] });
  const a: Review = { itemId: "t1", by: "codex/gpt-5.5", head: H1, criteria: NO_CRITERIA, approve: true, note: "", at: T, proved: false, claimed: true };
  const b: Review = { ...a, by: "antigravity/gemini-3.1-pro", claimed: false };
  const detail = (reviews: Review[], evidence = [touching]) => ({ item: item({ state: "submitted" }), policy, evidence, reviews, gate: gate(item({ state: "submitted" }), policy, evidence, reviews) });
  assert.equal(recordedApproval(detail([a, b]), H1, null)?.by, "codex/gpt-5.5");
  assert.equal(recordedApproval(detail([a, b]), H1, "codex/gpt-5.5")?.by, "codex/gpt-5.5");
  // B's unproved approval stands beside A's counting one: naming B asks B.
  assert.equal(recordedApproval(detail([a, b]), H1, "antigravity/gemini-3.1-pro"), null);
  // Another head, a gate not ready, or a change that needs no review: none.
  assert.equal(recordedApproval(detail([a]), H2, null), null);
  assert.equal(recordedApproval(detail([b]), H1, null), null);
  assert.equal(recordedApproval(detail([a], [pass()]), H1, null), null);
});


test("an explicit rejection override waives only the recorded reviews and never checks or future rejections", () => {
  const evidence = [pass({ changedPaths: ["AGENTS.md"] })];
  const rejected = review("codex/gpt-6", { approve: false, note: "Sandbox EPERM prevented tests" });
  const made = reviewOverrideFor(item(), policy, evidence, [rejected], "owner", "Override environment-only rejection", T);
  const accepted = item({ reviewOverride: made.override });
  assert.equal(gate(accepted, policy, evidence, [rejected]).ready, true);
  assert.equal(gate(accepted, { ...policy, noOverride: true }, evidence, [rejected]).ready, false);
  assert.equal(gate(accepted, policy, [pass({ passed: false, changedPaths: ["AGENTS.md"] })], [rejected]).ready, false);
  assert.equal(gate(accepted, policy, evidence, [{ ...rejected, at: "2026-10-16T00:00:00Z" }]).ready, false);
  assert.equal(gate(item({ head: H2, reviewOverride: made.override }), policy, evidence, [rejected]).ready, false);
});

// t693 (found reviewing t686 at 8534105d): an override recorded beside an
// independent approval, to waive a rejection, also stood in for the review
// once that approval was withdrawn.
test("an override that waived a rejection beside an approval does not stand in for the review once the approval is withdrawn", () => {
  const evidence = [pass({ changedPaths: ["AGENTS.md"] })];
  const approval = review("codex/gpt-6");
  const rejected = review("antigravity/gemini-4-argon", { approve: false, note: "environment only" });
  const made = reviewOverrideFor(item(), policy, evidence, [approval, rejected], "owner", "Override environment-only rejection", T);
  assert.equal(made.override.rejectionsOnly, true);
  const accepted = item({ reviewOverride: made.override });
  assert.equal(gate(accepted, policy, evidence, [approval, rejected]).ready, true);
  // The approval is no longer counted; the rejection the override named stays waived, the review is missing.
  const withdrawn = gate(accepted, policy, evidence, [rejected]);
  assert.equal(withdrawn.ready, false);
  assert.equal(withdrawn.needsAssessor, true);
  assert.equal(withdrawn.overridden?.rejectionsOnly, true);
  // An override made while the review was missing too still waives both.
  const both = reviewOverrideFor(item(), policy, evidence, [rejected], "owner", "No reviewer qualifies", T);
  assert.equal(both.override.rejectionsOnly, undefined);
  assert.equal(gate(item({ reviewOverride: both.override }), policy, evidence, [rejected]).ready, true);
});

// t653: the tasks t590-t651 were merged into main outside Atelier under the
// 2026-10-13 freeze, and the ledger still showed them open or claimed. The
// record names the merge, the commit merged and the reviews as given, and is
// refused when main lacks the merge or its second parent is another commit.
test("a merge recorded after the fact needs both commits and a review approving the commit merged", () => {
  const H2 = "b".repeat(40), M = "c".repeat(40);
  const review = { by: "codex/gpt-6-astra", verdict: "approve", head: H1, at: "2026-10-13" };
  const body = { mergeCommit: M, commit: H1, reviews: [review, { by: "antigravity/gemini-4-argon", verdict: "reject", head: H2 }] };
  assert.deepEqual(recordedMerge(body, "owner", "2026-10-14T00:00:00Z"), { ...body, outside: true, at: "2026-10-14T00:00:00Z", by: "owner" });
  assert.equal(recordedMerge({ ...body, note: "  freeze  " }, "owner", "x").note, "freeze");
  for (const bad of [{ mergeCommit: "abc" }, { commit: null }, { reviews: [] }, { reviews: "x" }, { reviews: [{ ...review, by: "nobody" }] }, { reviews: [{ ...review, verdict: "lgtm" }] },
    { reviews: [{ ...review, head: "3f313d3b" }] }, { reviews: [{ ...review, at: "yesterday" }] }, { reviews: [{ ...review, at: "2026-13-45" }] }, { note: 5 }]) {
    assert.throws(() => recordedMerge({ ...body, ...bad }, "owner", "x"), (e: RuleError) => e.code === "bad_record", JSON.stringify(bad));
  }
  // The reviews that approved it: a rejection alone, or an approval of another head, is refused.
  for (const reviews of [[{ ...review, verdict: "reject" }], [{ ...review, head: H2 }]]) {
    assert.throws(() => recordedMerge({ ...body, reviews }, "owner", "x"), (e: RuleError) => e.code === "no_approval" && /approves aaaaaaaa/.test(e.detail));
  }
});

test("a merge is recorded only when main holds it and its second parent is the task's head", () => {
  const record = { mergeCommit: "c".repeat(40), commit: H1 };
  const P1 = "e".repeat(40);
  assert.equal(recordedMergeRefusal(record, { parents: [P1, H1], holds: true }), null);
  const code = (baseline: { parents: string[] | null; holds: boolean | null }) => recordedMergeRefusal(record, baseline)?.code;
  assert.equal(code({ parents: null, holds: false }), "merge_not_on_main");
  assert.equal(code({ parents: [P1, H1], holds: false }), "merge_not_on_main");
  assert.equal(code({ parents: [P1, H1], holds: null }), "merge_unconfirmed");
  assert.equal(code({ parents: [P1], holds: true }), "not_a_merge");
  assert.equal(code({ parents: [H1, P1], holds: true }), "second_parent_differs");
  assert.match(recordedMergeRefusal(record, { parents: [H1, P1], holds: true })!.detail, /second parent is eeeeeeee, not aaaaaaaa/);
});

// t726: a history-since baseline holds a merge with one parent; the CLI has
// checked the second parent in the checkout and names the paired commit.
test("a merge the baseline holds flattened is recorded when the CLI paired it, and still refused when the baseline cannot map it", () => {
  const record = { mergeCommit: "c".repeat(40), baselineMerge: "9".repeat(40), commit: H1 };
  assert.equal(recordedMergeRefusal(record, { parents: ["e".repeat(40)], holds: true }), null);
  assert.equal(recordedMergeRefusal({ ...record, baselineMerge: undefined }, { parents: ["e".repeat(40)], holds: true })?.code, "not_a_merge");
  for (const baseline of [{ parents: null, holds: false }, { parents: ["e".repeat(40)], holds: false }] as const) {
    const refusal = recordedMergeRefusal(record, baseline)!;
    assert.equal(refusal.code, "merge_not_on_main");
    assert.match(refusal.detail, /atelier sync/);
    assert.match(refusal.detail, /99999999/);
  }
  assert.equal(recordedMergeRefusal(record, { parents: ["e".repeat(40)], holds: null })?.code, "merge_unconfirmed");
});

// t687 (PAVI, 2026-10-15): ikon-weblog had never admitted gemini-4-argon, so
// a review asked of antigravity/gemini-4-argon there was refused as ineligible.
const admission = (id: string, active = true, aliases: string[] = []): ReviewerAdmission => ({ id, aliases, by: "owner", reason: "r", at: T, active });

test("a reviewer admitted in the standard project is admitted in every project unless that project records its own", () => {
  const argon = admission("gemini-4-argon");
  assert.deepEqual(effectiveAdmissions([], [argon]), [argon]);
  // A project's own withdrawal, or its own admission, stands in place of the standard one.
  const withdrawn = admission("gemini-4-argon", false);
  assert.deepEqual(effectiveAdmissions([withdrawn], [argon]), [withdrawn]);
  const own = admission("Gemini-4-Argon", true, ["argon"]);
  assert.deepEqual(effectiveAdmissions([own], [argon]), [own]);
  // Another model's record leaves it inherited.
  const other = admission("qwen3-coder");
  assert.deepEqual(effectiveAdmissions([other], [argon]), [other, argon]);
  // What the standard project withdrew is not shared.
  assert.deepEqual(effectiveAdmissions([], [admission("gemini-4-argon", false)]), []);
  assert.deepEqual(standardAdmissions([argon, admission("x", false)]), [argon]);
});

test("a model named as the listing prints it, harness/model, is the model; a model id with a slash stays whole", () => {
  assert.deepEqual(splitHarness("antigravity/gemini-4-argon"), { harness: "antigravity", model: "gemini-4-argon" });
  assert.deepEqual(splitHarness("Opencode/z-ai/glm-5"), { harness: "opencode", model: "z-ai/glm-5" });
  assert.deepEqual(splitHarness("gemini-4-argon"), { model: "gemini-4-argon" });
  assert.deepEqual(splitHarness("z-ai/glm-5"), { model: "z-ai/glm-5" });
});

// t562, found on ikon-weblog t33: `done` recorded a check as not applicable at a
// head, then a later measurement at that head (main had moved, so it listed
// another task's paths) made the same check required, and review-request
// waited on a check `done` had called not applicable.
test("a check recorded not applicable at a head stays so when a later measurement of that head lists its paths", () => {
  const p: ProjectPolicy = { checks: ["npm test", "npm run e2e"], checkPaths: [{ command: "npm run e2e", paths: ["e2e/**"] }] };
  const na = pass({ claim: "npm run e2e", passed: null, notApplicable: true, changedPaths: ["src/a.ts"], where: "runner", at: "2026-10-03T12:00:00.000Z" });
  const ran = pass({ at: "2026-10-03T12:00:00.000Z", where: "runner" });
  const later = pass({ at: "2026-10-03T13:00:00.000Z", where: "runner", changedPaths: ["src/a.ts", "e2e/other.spec.ts"] });
  const view = evidenceAt(p, [na, ran, later], H1);
  assert.deepEqual(view.notApplicable, ["npm run e2e"]);
  assert.deepEqual(view.checks.map((c) => c.claim), ["npm test"]);
  assert.deepEqual(mergedChecksAt(p, [na, ran, later], H1, null).checks.map((c) => c.claim), ["npm test"]);
  // Without the record, the later measurement makes the check required and pending.
  const bare = evidenceAt(p, [ran, later], H1);
  assert.deepEqual(bare.checks.map((c) => c.claim), ["npm test", "npm run e2e"]);
  // A run of the check after the record leaves the paths measured to decide.
  const reran = pass({ claim: "npm run e2e", at: "2026-10-03T14:00:00.000Z", changedPaths: ["src/a.ts", "e2e/other.spec.ts"] });
  assert.deepEqual(evidenceAt(p, [na, ran, later, reran], H1).notApplicable, []);
  // A record the policy no longer supports (its paths now include the measured ones) does not stand.
  const widened: ProjectPolicy = { ...p, checkPaths: [{ command: "npm run e2e", paths: ["e2e/**", "src/**"] }] };
  assert.deepEqual(evidenceAt(widened, [na, ran, later], H1).notApplicable, []);
});

// ── review convergence (t717) ────────────────────────────────────────────────
// The loop these end: t363, t478 and t705 each ran round after round on
// 2026-10-15/16, every round a narrower variant of the last (t717).

const rv = (by: string, approve: boolean, head: string, at: string, note = ""): Review => ({ itemId: "t1", by, head, approve, note, at, criteria: "c" } as Review);
const sha = (c: string) => c.repeat(40);

test("round cap: a task is held after REVIEW_ROUND_CAP rejected heads, with the rounds listed, and not before", () => {
  const reviews = Array.from({ length: REVIEW_ROUND_CAP }, (_, i) => rv("codex/gpt-6-astra", false, sha(String(i + 1)), `2026-10-16T0${i}:00:00.000Z`, `variant ${i + 1} of the same defect`));
  const rounds = rejectedRounds(reviews, "owner");
  assert.equal(rounds.length, REVIEW_ROUND_CAP);
  assert.equal(roundCapHold(rounds.slice(0, -1)), null, "one round short of the cap starts another round");
  const hold = roundCapHold(rounds, "t363");
  assert.ok(hold);
  for (let i = 0; i < rounds.length; i++) assert.ok(hold.includes(`round ${i + 1}, ${rounds[i].head.slice(0, 8)}, rejected by codex/gpt-6-astra: variant ${i + 1} of the same defect`), hold);
  assert.ok(hold.includes("atelier land t363 --reviewer H/M"), "it says how the developer asks another round");
});

test("round cap: a round is a head, the developer's rejections and approvals are none, and two rejections of one head are one round", () => {
  const reviews = [
    rv("codex/gpt-6-astra", false, sha("1"), "2026-10-16T01:00:00.000Z"),
    rv("gemini/gemini-4-argon", false, sha("1"), "2026-10-16T02:00:00.000Z"),
    rv("owner", false, sha("2"), "2026-10-16T03:00:00.000Z"),
    rv("codex/gpt-6-astra", true, sha("3"), "2026-10-16T04:00:00.000Z"),
  ];
  const rounds = rejectedRounds(reviews, "owner");
  assert.deepEqual(rounds.map((r) => [r.head, r.by]), [[sha("1"), "codex/gpt-6-astra"]]);
});

test("re-review diff: the head the last review judged, and the diff since it only when that is smaller and not empty", () => {
  const prior = [rv("codex/gpt-6-astra", false, sha("1"), "2026-10-16T01:00:00.000Z"), rv("gemini/gemini-4-argon", false, sha("2"), "2026-10-16T02:00:00.000Z"), rv("owner", true, sha("3"), "2026-10-16T03:00:00.000Z")];
  assert.equal(reviewedSince(prior, sha("4"), "owner"), sha("2"), "the newest model review of an earlier head");
  assert.equal(reviewedSince(prior, sha("2"), "owner"), sha("1"), "never the head under review");
  assert.equal(reviewedSince([], sha("4"), "owner"), null);
  const whole = "d".repeat(500);
  assert.deepEqual(reReviewDiff(whole, "small change"), { diff: "small change", incremental: true });
  assert.deepEqual(reReviewDiff(whole, ""), { diff: whole, incremental: false }, "an empty diff leaves nothing to read");
  assert.deepEqual(reReviewDiff(whole, "e".repeat(900)), { diff: whole, incremental: false }, "a merge of main makes the diff since larger than the change");
  assert.deepEqual(reReviewDiff(whole, null), { diff: whole, incremental: false });
});

test("a finding the developer marked fixed or refuted is not raised again, but a reworded one is", () => {
  const settled = [{ file: "src/a.ts", text: "A lapsed claim is never retried." }];
  const raised = [
    { file: "src/a.ts", line: 10, severity: "blocking", text: "a lapsed claim is never   retried" },
    { file: "./src/a.ts", line: 11, severity: "blocking", text: "A lapsed claim is never retried!" },
    { file: "src/a.ts", line: 10, severity: "blocking", text: "A lapsed claim is never retried when the runner restarts mid-claim, see needed.ts:88." },
    { file: "src/b.ts", line: 3, severity: "blocking", text: "A lapsed claim is never retried." },
  ] satisfies Finding[];
  assert.deepEqual(dropSettled(raised, settled).map((f) => f.line), [10, 3]);
});

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts",
  "@@ -10,3 +10,4 @@ function x() {", " keep", "+added at 11", " keep", " keep",
  "@@ -100,2 +101,1 @@", "--- a deleted line that begins with dashes", " keep",
  "diff --git a/docs/b.md b/docs/b.md", "--- a/docs/b.md", "+++ b/docs/b.md", "@@ -1 +1 @@", "-old", "+new",
  "diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ",
  "diff --git a/bin.dat b/bin.dat", "--- a/bin.dat", "+++ b/bin.dat",
].join("\n");

test("touchedLines reads the added and deleted positions in the new file, and a deleted line that looks like a header is not one", () => {
  const touched = touchedLines(DIFF)!;
  assert.deepEqual([...touched.get("src/a.ts")!].sort((a, b) => a - b), [11, 101]);
  assert.deepEqual([...touched.get("docs/b.md")!], [1]);
  assert.deepEqual([...touched.get("bin.dat")!], [], "a file listed with no hunk is listed, with nothing to place a finding by");
  assert.equal(touchedLines("not a diff at all"), null);
});

test("a blocking finding on lines the change did not touch is a pre-existing follow-up; one it may have touched, or cannot be placed, keeps blocking", () => {
  const f = (file: string, line: number | null): Finding => ({ file, line, severity: "blocking", text: `about ${file}:${line}` });
  const near = 11 + PRE_EXISTING_MARGIN, far = 11 + PRE_EXISTING_MARGIN + 1;
  const labelled = labelPreExisting([
    f("src/a.ts", 11), f("src/a.ts", near), f("src/a.ts", far), f("src/a.ts", 300), f("src/untouched.ts", 4),
    f("src/a.ts", null), f("bin.dat", 9), f("see the docs", 3), f("", 3),
  ], DIFF);
  // src/untouched.ts is no path the diff names, so it cannot be placed and keeps blocking (round 2 of review).
  assert.deepEqual(labelled.map((x) => x.label ?? "blocks"), ["blocks", "blocks", "pre-existing", "pre-existing", "blocks", "blocks", "blocks", "blocks", "blocks"]);
  for (const x of labelled) assert.equal(x.severity, x.label ? "follow-up" : "blocking", "a labelled finding never blocks");
  // A follow-up stays as it is; it is not turned into a task of its own.
  assert.deepEqual(labelPreExisting([{ file: "src/a.ts", line: 400, severity: "follow-up", text: "t" }], DIFF), [{ file: "src/a.ts", line: 400, severity: "follow-up", text: "t" }]);
  // A diff nothing can be read from labels nothing.
  assert.equal(labelPreExisting([f("src/a.ts", 400)], "").at(0)?.label, undefined);
  assert.equal(isPreExisting({ file: "src/a.ts", line: 0 }, touchedLines(DIFF)!), false);
});

test("a blocking finding blocks only when an independent check confirmed it; the rest are recorded as unverified", () => {
  const findings: Finding[] = [
    { file: "a.ts", line: 1, severity: "blocking", text: "one" },
    { file: "b.ts", line: 2, severity: "blocking", text: "two" },
    { file: "c.ts", line: 3, severity: "follow-up", text: "three" },
    { file: "d.ts", line: 4, severity: "blocking", text: "four" },
  ];
  const out = applyVerification(findings, new Set([2]));
  assert.deepEqual(out.map((f) => [f.severity, f.label ?? null]), [["follow-up", "unverified"], ["blocking", null], ["follow-up", null], ["follow-up", "unverified"]]);
  assert.deepEqual(applyVerification(findings, new Set()).filter((f) => f.severity === "blocking"), [], "a check that confirmed nothing leaves nothing blocking");
  assert.deepEqual(findings[0], { file: "a.ts", line: 1, severity: "blocking", text: "one" }, "the reviewer's own findings are not changed");
});

test("the follow-up task for pre-existing findings names each, and there is none without one", () => {
  const findings: Finding[] = [
    { file: "src/untouched.ts", line: 4, severity: "follow-up", label: "pre-existing", text: "Reads a stale value." },
    { file: "src/a.ts", line: 11, severity: "follow-up", label: "unverified", text: "Maybe wrong." },
    { file: "src/a.ts", line: 12, severity: "follow-up", text: "Naming." },
  ];
  const task = preExistingTask("t717", "Review rounds converge", { by: "codex/gpt-6-astra", head: sha("a"), findings })!;
  assert.deepEqual(task.accept, ["src/untouched.ts:4: Reads a stale value."]);
  assert.match(task.title, /t717/);
  assert.equal(preExistingTask("t717", "x", { by: "a/b", head: sha("a"), findings: findings.slice(1) }), null);
});

// Astra's review of round 1 (head 3a817817): git gives a mode change, a binary
// change and a pure rename no ---/+++ lines, so another file's hunk made them
// look untouched and a blocking finding on run.sh became an approval.
test("a path git lists with no hunk (mode change, binary, rename) is changed with unknown placement, so a finding on it keeps blocking", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,1 +10,2 @@", " keep", "+added",
    "diff --git a/run.sh b/run.sh", "old mode 100755", "new mode 100644",
    "diff --git a/img.png b/img.png", "index 1..2 100644", "Binary files a/img.png and b/img.png differ",
    "diff --git a/old/name.ts b/new/name.ts", "similarity index 100%", "rename from old/name.ts", "rename to new/name.ts",
    "diff --git a/dir/x y.txt b/dir/x y.txt", "old mode 100644", "new mode 100755",
  ].join("\n");
  const touched = touchedLines(diff)!;
  for (const path of ["run.sh", "img.png", "old/name.ts", "new/name.ts", "dir/x y.txt"]) assert.deepEqual([...touched.get(path) ?? ["missing"]], [], path);
  const f = (file: string, line: number): Finding => ({ file, line, severity: "blocking", text: "t" });
  const out = labelPreExisting([f("run.sh", 1), f("img.png", 2), f("new/name.ts", 3), f("old/name.ts", 4), f("src/other.ts", 5), f("src/a.ts", 400)], diff);
  assert.deepEqual(out.map((x) => x.label ?? "blocks"), ["blocks", "blocks", "blocks", "blocks", "blocks", "pre-existing"]);
});

// Astra's review of round 2 (head 6111b5e7): git writes src/café.ts as
// "src/caf\303\251.ts" in its headers, and the quoted spelling matched no
// finding, so a finding on a changed line of it was demoted and skipped the check.
test("git's quoted paths are decoded in every header form, and a path no header names keeps blocking", () => {
  assert.equal(unquoteGitPath('"src/caf\\303\\251.ts"'), "src/café.ts");
  assert.equal(unquoteGitPath('"a\\tb \\"q\\" \\\\.txt"'), 'a\tb "q" \\.txt');
  assert.equal(unquoteGitPath("plain name.txt"), "plain name.txt");
  assert.equal(unquoteGitPath('"\\344\\270\\255.md"'), "中.md", "three octal bytes are one character");
  const diff = [
    'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"', "index 1..2 100644", '--- "a/src/caf\\303\\251.ts"', '+++ "b/src/caf\\303\\251.ts"', "@@ -1,1 +1,2 @@", " keep", "+added",
    "diff --git a/dir/with space.txt b/dir/with space.txt", "--- a/dir/with space.txt\t", "+++ b/dir/with space.txt\t", "@@ -1 +1 @@", "-a", "+b",
    'diff --git "a/q\\"uote.txt" "b/q\\"uote.txt"', '--- "a/q\\"uote.txt"', '+++ "b/q\\"uote.txt"', "@@ -1 +1 @@", "-a", "+b",
    'diff --git a/old.ts "b/n\\303\\251w.ts"', "similarity index 100%", "rename from old.ts", 'rename to "n\\303\\251w.ts"',
    'diff --git "a/bin\\303\\251.dat" "b/bin\\303\\251.dat"', 'Binary files "a/bin\\303\\251.dat" and "b/bin\\303\\251.dat" differ',
  ].join("\n");
  const touched = touchedLines(diff)!;
  assert.deepEqual([...touched.keys()].sort(), ["biné.dat", "dir/with space.txt", "néw.ts", "old.ts", 'q"uote.txt', "src/café.ts"].sort());
  assert.deepEqual([...touched.get("src/café.ts")!], [2]);
  const f = (file: string, line: number): Finding => ({ file, line, severity: "blocking", text: "t" });
  const out = labelPreExisting([
    f("src/café.ts", 2), f("src/café.ts", 300), f("dir/with space.txt", 1), f('q"uote.txt', 1), f("néw.ts", 1), f("old.ts", 1), f("biné.dat", 1),
    f('src/caf\\303\\251.ts', 2), f("src/never-named.ts", 3), f("a/src/café.ts", 2),
  ], diff);
  assert.deepEqual(out.map((x) => x.label ?? "blocks"), ["blocks", "pre-existing", "blocks", "blocks", "blocks", "blocks", "blocks", "blocks", "blocks", "blocks"]);
});

test("a defect the check shows was at the base is a pre-existing follow-up, even where the change touched; a torn answer blocks", () => {
  const findings: Finding[] = [1, 2, 3, 4].map((n) => ({ file: "src/a.ts", line: n, severity: "blocking", text: `f${n}` }));
  const out = applyVerification(findings, new Set([1, 4]), new Set([2, 4]));
  assert.deepEqual(out.map((x) => [x.severity, x.label ?? null]), [["blocking", null], ["follow-up", "pre-existing"], ["follow-up", "unverified"], ["blocking", null]]);
});

// t727: a vendor's window ran out with nothing said before it did.
test("t727: a window at 80 percent, or heading past 100 before it resets, is a shortage that names the vendor, window and reset", () => {
  const now = Date.parse("2026-10-05T21:00:00.000Z");
  const resets = (ms: number) => new Date(now + ms).toISOString();
  const day = 86_400_000;
  const win = (name: string, usedPercent: number, resetsAt: string | null) => ({ tool: "codex", windows: [{ name, usedPercent, resetsAt }] });
  // At 80 percent, whatever the pace.
  assert.deepEqual(usageShortages(win("weekly", 80, resets(6.9 * day)), now), [{ key: "codex/shortage:weekly", message: `codex: the weekly window is 80% used; it resets at ${resets(6.9 * day)}.` }]);
  // Under 80: the pace over the window so far decides. 3 days of 7 gone, 40% used is 93% by the reset; 50% is 117%.
  assert.deepEqual(usageShortages(win("weekly", 40, resets(4 * day)), now), []);
  assert.match(usageShortages(win("weekly", 50, resets(4 * day)), now)[0].message, /^codex: at the pace so far, the weekly window \(50% used\) runs out before it resets; it resets at /);
  assert.match(usageShortages(win("5-hour", 60, resets(2 * 3_600_000)), now)[0].message, /5-hour window \(60% used\) runs out/);
  // A pace is not trusted in the first tenth of a window, a window with no used share has none, and an idle window says nothing.
  assert.deepEqual(usageShortages(win("weekly", 30, resets(6.9 * day)), now), []);
  assert.deepEqual(usageShortages(win("weekly", 0, resets(1 * day)), now), []);
  // A reset time that is not known is said, not guessed; so is a window of no known length, which has no pace.
  assert.equal(usageShortages(win("weekly", 90, null), now)[0].message, "codex: the weekly window is 90% used; its reset time is not known.");
  assert.deepEqual(usageShortages(win("90-minute", 50, resets(day)), now), []);
  // A window that has reset is not in use, whatever it read.
  assert.deepEqual(usageShortages(win("weekly", 99, resets(-1000)), now), []);
});

// t631: review by risk. The core list is Atelier's own, the one the
// orchestrator's tier.sh reads (PAVI, 2026-10-17).
const ATELIER_CORE = [
  "src/rules.ts", "src/ledger.ts", "src/index.ts", "src/tokens.ts", "src/secret-scan.ts", "src/checks.ts", "src/landing-workflow.ts",
  "src/runner-token.ts", "src/restart-gate.ts", "src/token-expiry.ts", "src/review/**", "src/dispatch/**",
  "cli/land.mjs", "cli/landing.mjs", "cli/runner.mjs", "cli/runner-failure.mjs", "cli/fast.mjs", "cli/push-steps.mjs", "cli/atelier.mjs",
  "cli/harness/**", "wrangler.jsonc", "package.json", "package-lock.json",
];
const riskPolicy: ProjectPolicy = { ...policy, riskReviews: { core: ATELIER_CORE, reviews: { "docs-or-tests": 0, other: 1, core: 2 } } };

test("riskClass: docs and tests only, core, or other, over real path lists; an unreadable change is core", () => {
  assert.equal(riskClass(["docs/orchestrating.md", "test/rules.test.ts", "README.md", "src/notes.md"], ATELIER_CORE), "docs-or-tests");
  assert.equal(riskClass(["src/ui.ts", "src/theme.css"], ATELIER_CORE), "other");
  assert.equal(riskClass(["test/rules.test.ts", "src/ui.ts"], ATELIER_CORE), "other");
  assert.equal(riskClass(["docs/a.md", "src/rules.ts"], ATELIER_CORE), "core");
  assert.equal(riskClass(["cli/harness/codex.mjs"], ATELIER_CORE), "core");
  assert.equal(riskClass(["src/review/needed.ts", "test/x.test.ts"], ATELIER_CORE), "core");
  // Case and Unicode variants of a core path are core; of a docs path they are not docs.
  assert.equal(riskClass(["SRC/Rules.ts"], ATELIER_CORE), "core");
  assert.equal(riskClass(["Docs/a.txt"], ATELIER_CORE), "other");
  // Nothing measured, or nothing readable, is never taken for a small change.
  assert.equal(riskClass([], ATELIER_CORE), "core");
  assert.equal(riskClass(null, ATELIER_CORE), "core");
  assert.equal(riskClass(undefined, ATELIER_CORE), "core");
});

test("riskNeed: the files the checks run and the ship files are core beside the project's list", () => {
  const p: ProjectPolicy = { ...riskPolicy, checks: ["node test/run.mjs"] };
  assert.deepEqual(riskNeed(["test/run.mjs"], p), { risk: "core", reviews: 2 });
  assert.deepEqual(riskNeed(["docs/atelier/ship.sh"], p), { risk: "core", reviews: 2 });
  assert.deepEqual(riskNeed(["docs/a.md"], p), { risk: "docs-or-tests", reviews: 0 });
  assert.equal(riskNeed(["docs/a.md"], policy), null);
});

// This would have caught a docs-only edit inside a protected path asking for
// the full cross-company review (t631's finding), and a core change landing on one.
test("the gate counts the approvals a risk class needs; a project without riskReviews keeps today's rule", () => {
  const base: Review = { itemId: "t1", by: "codex/gpt-5.5", head: H1, criteria: NO_CRITERIA, approve: true, note: "", at: T };
  const second: Review = { ...base, by: "gemini/gemini-3" };
  const sameFamily: Review = { ...base, by: "claude-code/sonnet-5.5" };
  const protectedDocs = pass({ changedPaths: ["AGENTS.md"] });
  const protectedPolicy: ProjectPolicy = { ...riskPolicy, protected: ["AGENTS.md", "wrangler.*"] };
  // Docs only: protected today, but the class needs no review.
  assert.equal(gate(item(), policy, [protectedDocs], []).ready, false);
  const docs = gate(item(), protectedPolicy, [protectedDocs], []);
  assert.deepEqual([docs.ready, docs.riskClass, docs.needsAssessor], [true, "docs-or-tests", false]);
  // Other: one review; a same-family one is not independent of a protected change, but is of an unprotected one.
  const other = pass({ changedPaths: ["src/ui.ts"] });
  assert.equal(gate(item(), protectedPolicy, [other], []).ready, false);
  assert.match(gate(item(), protectedPolicy, [other], []).blockers.join(), /other change: needs 1 independent review/);
  assert.equal(gate(item(), protectedPolicy, [other], [base]).ready, true);
  // Core: two reviewers, each counted once.
  const core = pass({ changedPaths: ["src/rules.ts"] });
  assert.match(gate(item(), riskPolicy, [core], [base]).blockers.join(), /core change: needs 2 independent reviews.*1 so far/);
  assert.equal(gate(item(), riskPolicy, [core], [base, { ...base, note: "again" }]).ready, false);
  // One model under an alias, a profile or another harness is one reviewer, not two.
  for (const variant of ["codex/gpt-5.5:high", "CODEX/GPT-5.5", "opencode/gpt-5.5"]) {
    assert.equal(gate(item(), riskPolicy, [core], [base, { ...base, by: variant }]).ready, false, variant);
    assert.equal(gateApprovals(item(), riskPolicy, [core], [base, { ...base, by: variant }]).length, 1, variant);
  }
  const both = gate(item(), riskPolicy, [core], [base, second]);
  assert.deepEqual([both.ready, both.riskClass], [true, "core"]);
  // An empty change is core.
  assert.equal(gate(item(), riskPolicy, [pass({ changedPaths: [] })], [base]).ready, false);
  // No riskReviews: one approval for a protected change, none for another, and no class named.
  const today = gate(item(), policy, [pass({ changedPaths: ["wrangler.jsonc"] })], [base]);
  assert.deepEqual(today, { ready: true, blockers: [], needsAssessor: false, outOfScope: ["wrangler.jsonc"] });
  assert.equal(gate(item(), policy, [other], []).riskClass, undefined);
  // The landing's count follows the same need.
  assert.equal(gateApprovals(item(), riskPolicy, [core], [base, second]).length, 2);
  assert.equal(gateApprovals(item(), riskPolicy, [pass({ changedPaths: ["docs/a.md"] })], [base]).length, 0);
  assert.equal(gateApprovals(item(), policy, [other], [base]).length, 0);
});

test("parseRiskReviews accepts the field and refuses what cannot be read", () => {
  const ok = { core: ["src/rules.ts"], reviews: { "docs-or-tests": 0, other: 1, core: 2 } };
  assert.deepEqual(parseRiskReviews({ ...ok, core: [" src/rules.ts "] }), ok);
  for (const bad of [null, "x", { ...ok, core: "src" }, { ...ok, core: [""] }, { core: [] }, { ...ok, reviews: { ...ok.reviews, core: 4 } }, { ...ok, reviews: { ...ok.reviews, other: 1.5 } }, { ...ok, reviews: { other: 1, core: 2 } }]) {
    assert.throws(() => parseRiskReviews(bad), (e: unknown) => e instanceof RuleError && e.code === "bad_risk_reviews" && e.status === 400);
  }
});
