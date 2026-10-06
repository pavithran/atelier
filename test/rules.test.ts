import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pushActors, assertHandoffTarget, assertReviewAllowed, agentOf, measuredPaths, changeClass, parseAgents, parseExecution, assertClaimable, evidenceAt, gate, globToRegExp, inboxFor, matchesAny, modelKey, modelOf, sameActor,
  assertClaimAllowed, assertEligible, checkFiles, foldPath, matchesFolded, overlappingLive, parseRuleError, pathCollisions, repoName, RuleError, scopesOverlap, validActor,
  decisionFor, mergedBlockers, mergedChecksAt, overrideAt, OVERRIDE_REASON_MAX, PROTECTED_NEED, reviewOverrideFor,
  type Evidence, type Item, type ProjectPolicy, type Review, type ReviewOverride,
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

test("protected paths need a model of another family; the project owner's approval is not that review", () => {
  const touching = pass({ changedPaths: ["AGENTS.md"] });
  const sameModel: Review = { itemId: "t1", by: "other-harness/opus-5.5", head: H1, approve: true, note: "", at: T };
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

test("what a runner executes is protected: make and just recipes, npx's binary, manifests of build tools, paths run directly", () => {
  const sorted = (files: string[]) => [...files].sort();
  assert.deepEqual(checkFiles(["make test"]), sorted(["Makefile", "makefile", "GNUmakefile", "**/*.mk"]));
  assert.deepEqual(checkFiles(["make -C native -f build.mk all", "make --directory=./lib --makefile=rules.mk"]), sorted(["native/build.mk", "lib/rules.mk", "**/*.mk"]));
  assert.deepEqual(checkFiles(["make -C ../other check", "make -f /etc/Makefile"]), ["**/*.mk"]);
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

test("gc removes clean workspaces at a head that proves nothing is unpublished", async () => {
  const { gcWorkspaceReason } = await import("../src/rules.ts");
  assert.equal(gcWorkspaceReason(item({ state: "merged", acceptedHead: H1 }), H1, false, false), null);
  // An abandoned item never merges; the last head Atelier recorded is its proof.
  assert.equal(gcWorkspaceReason(item({ state: "abandoned" }), H1, false, false), null);
  assert.ok(gcWorkspaceReason(item({ state: "abandoned" }), H1, true, false));
  assert.ok(gcWorkspaceReason(item({ state: "abandoned" }), H1, false, true));
  assert.ok(gcWorkspaceReason(item({ state: "abandoned", head: H2 }), H1, false, false));
  assert.ok(gcWorkspaceReason(item({ state: "abandoned", head: null }), H1, false, false));
  for (const state of ["open", "claimed", "submitted", "accepted"] as const) {
    assert.match(gcWorkspaceReason(item({ state, acceptedHead: H1 }), H1, false, false)!, /neither merged nor abandoned/);
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
  assert.deepEqual(entry({}).map((x) => [x.kind, x.reason]), [["assess", `${PROTECTED_NEED}; ask a reviewer who qualifies, or accept with an override and its reason`]]);
  assert.deepEqual(entry({ reviewOverride }).map((x) => [x.kind, x.reason]), [["accept", "all checks observed passing at this head, with the independent review overridden by the project owner: No other family is available"]]);
  assert.deepEqual(entry({ reviewOverride, state: "accepted", acceptedHead: H1 }).map((x) => [x.kind, x.reason]), [["merge", "accepted, with the independent review overridden by the project owner: No other family is available; run `atelier merge` in the project checkout"]]);
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
  assert.equal(mergedChecksAt({ ...policy, sandboxOnly: true }, [merged], H1, M1).run, false, "under sandboxOnly a merged run on the agent's machine does not count");
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
  // Under sandboxOnly, a merged run on the agent's machine neither blocks nor counts.
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
