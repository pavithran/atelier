import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { controlPlaneChanges, mergePolicyDecision, readControlPlane, refreshControlPlane } from "../cli/atelier.mjs";
import { acceptancePolicy, mergeContext } from "../src/control-plane.ts";

const agents = { codex: { available: true, eligible_roles: ["executor"], preferred_roles: ["planner"] }, claude: { available: false, eligible_roles: ["assessor"] } };
const execution = { allowed_classes: ["direct", "protected"], direct: { enabled: true, allowed_path_patterns: ["docs/**"] }, protected_path_patterns: ["src/security/**"] };

test("CLI reads roles, preferences and classes without losing protected surfaces", () => {
  mkdirSync(".cache", { recursive: true });
  const top = mkdtempSync(resolve(".cache/control-plane-"));
  const dir = join(top, "docs/control-plane");
  try {
    assert.equal(readControlPlane(top), null);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-policy.v1.json"), JSON.stringify({ agents, authority: { overlapping_claims: "refuse" } }));
    writeFileSync(join(dir, "execution-policy.v1.json"), JSON.stringify({ ...execution, maintenance_path_rules: [{ paths: ["tools/**"] }] }));
    writeFileSync(join(dir, "project-adapter.v1.json"), JSON.stringify({ protected_surfaces: [{ pattern: "adapter/**" }] }));
    const cp = readControlPlane(top);
    assert.deepEqual(cp.agents, agents);
    assert.deepEqual(cp.execution, execution);
    assert.deepEqual(cp.eligible, ["codex"]);
    assert.equal(cp.refuseOverlap, true);
    for (const path of ["src/security/**", "tools/**", "adapter/**", "docs/control-plane/**"]) assert.ok(cp.protected.includes(path));
    rmSync(join(dir, "execution-policy.v1.json"));
    assert.equal(readControlPlane(top).execution, undefined);
    writeFileSync(join(dir, "agent-policy.v1.json"), JSON.stringify({ agents: {} }));
    assert.deepEqual(readControlPlane(top).agents, {});
  } finally { rmSync(top, { recursive: true, force: true }); }
});


function fixture(run) {
  mkdirSync(".cache", { recursive: true });
  const dir = mkdtempSync(resolve(".cache/control-plane-"));
  const cp = join(dir, "docs/control-plane");
  mkdirSync(cp, { recursive: true });
  const write = (name, data) => writeFileSync(join(cp, `${name}.v1.json`), JSON.stringify(data));
  return Promise.resolve().then(() => run({ dir, write })).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const before = { protected: ["AGENTS.md"], eligible: ["claude"], refuseOverlap: false, approval: "Owner approved the copy", checks: ["npm test"], sandboxOnly: true };

test("refresh sends only ControlPlane fields and leaves project settings intact", () => fixture(async ({ dir, write }) => {
  write("agent-policy", { agents: { codex: { available: true }, claude: { available: false } }, authority: { overlapping_claims: "refuse" } });
  write("execution-policy", { protected_path_patterns: ["src/private/**"], maintenance_path_rules: [{ paths: ["scripts/**"] }] });
  write("project-adapter", { protected_surfaces: [{ pattern: "secrets/**" }] });
  const original = { title: "Project", createdAt: "2026-10-01", policy: before };
  let stored = structuredClone(original);
  const calls = [], lines = [];
  const request = async (method, path, body, actor) => {
    calls.push({ method, path, body, actor });
    if (method === "PUT") stored.policy = { ...stored.policy, ...body };
    return { project: stored };
  };
  const result = await refreshControlPlane(dir, "example", request, (line) => lines.push(line));
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
  assert.equal(calls[1].path, "/projects/example");
  assert.equal(calls[1].actor, "owner");
  assert.deepEqual(Object.keys(calls[1].body).sort(), ["agents", "eligible", "execution", "protected", "refuseOverlap"]);
  assert.deepEqual(stored, { ...original, policy: { ...before, ...calls[1].body } });
  assert.deepEqual(result.before, before);
  assert.deepEqual(result.policy, stored.policy);
  // Three field changes, and the roles and classes the files now name.
  assert.equal(lines.length, 5);
  assert.ok(lines.some((line) => line.includes("agents changed")) && lines.some((line) => line.includes("execution changed")));
  assert.ok(lines.every((line) => !line.includes("\n")));
  assert.ok(stored.policy.protected.includes("scripts/**"));
  assert.ok(stored.policy.protected.includes("secrets/**"));
  calls.length = 0;
  await refreshControlPlane(dir, "example", request, assert.fail);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
}));

test("comparison treats lists as sets and absent optional fields as defaults", () => {
  assert.deepEqual(controlPlaneChanges({ protected: ["b", "a", "a"] }, { protected: ["a", "b"], eligible: [], refuseOverlap: false }), []);
});

test("a checkout without ControlPlane files makes no policy requests", () => fixture(async ({ dir }) => {
  assert.equal(await refreshControlPlane(dir, "example", assert.fail, assert.fail), null);
}));

test("adapter-only policy is read and malformed policy warns without requests", () => fixture(async ({ dir, write }) => {
  write("project-adapter", { protected_surfaces: [{ pattern: "src/**" }] });
  assert.ok(readControlPlane(dir).protected.includes("src/**"));
  writeFileSync(join(dir, "docs/control-plane/agent-policy.v1.json"), "{");
  const lines = [];
  assert.equal((await refreshControlPlane(dir, "example", assert.fail, (line) => lines.push(line))).skipped, true);
  assert.match(lines[0], /Warning: ControlPlane/);
}));

test("merge warns and refuses newly protected touched paths unless overridden", () => {
  const after = { ...before, protected: ["AGENTS.md", "src/**"] };
  const decision = mergePolicyDecision(before, after, ["src/secret.ts"]);
  assert.match(decision.warning, /policy changed since acceptance.*protected:/);
  assert.match(decision.refusal, /src\/secret.ts.*Review the task again on its page and accept again/);
  assert.match(decision.refusal, /--policy-changed-ok/);
  const allowed = mergePolicyDecision(before, after, ["src/secret.ts"], true);
  assert.equal(allowed.warning, decision.warning);
  assert.equal(allowed.refusal, null);
  assert.equal(mergePolicyDecision(before, after, ["AGENTS.md"]).refusal, null);
  assert.deepEqual(mergePolicyDecision(before, before, ["AGENTS.md"]), { warning: null, refusal: null });
});

test("merge matches newly protected paths whatever their letter case or Unicode form", () => {
  const after = { ...before, protected: ["AGENTS.md", "src/**", "CLAUDE.md"] };
  for (const path of ["SRC/secret.ts", "claude.md", "Src/Secret.ts"]) {
    assert.ok(mergePolicyDecision(before, after, [path]).refusal?.includes(`newly protected paths: ${path}.`), path);
  }
  // A variant of a path protected at acceptance is not newly protected.
  assert.equal(mergePolicyDecision(before, after, ["agents.md", "AGENT\u017f.md"]).refusal, null);
});

test("merge warns on eligibility and overlap changes without refusing unrelated paths", () => {
  const result = mergePolicyDecision(before, { ...before, eligible: ["codex"], refuseOverlap: true }, ["src/a.ts"]);
  assert.match(result.warning, /eligible:.*refuseOverlap:/);
  assert.equal(result.refusal, null);
  assert.equal(mergePolicyDecision(before, { ...before, protected: ["AGENTS.md", "package.json"] }, ["package.json"]).refusal, null);
});

test("merge compares eligible agents, the overlap rule and checks with the acceptance, and refuses what the accepted item no longer satisfies", () => {
  const context = { contributors: ["codex/gpt-6-astra"], passed: ["npm test"], overlapping: ["t4 (claude-code/opus-5.5)"] };
  // A contributor eligible at acceptance and not now.
  let d = mergePolicyDecision({ ...before, eligible: ["codex"] }, { ...before, eligible: ["claude"] }, ["src/a.ts"], false, context);
  assert.match(d.warning, /eligible:/);
  assert.match(d.refusal, /its contributors are no longer eligible here: codex\/gpt-6-astra \(eligible: claude\)\. Review the task again on its page and accept again/);
  // An eligibility change that keeps every contributor: the warning alone.
  assert.equal(mergePolicyDecision({ ...before, eligible: [] }, { ...before, eligible: ["codex", "claude"] }, ["src/a.ts"], false, context).refusal, null);
  // A check required now that was not observed passing at the accepted revision.
  const lint = { ...before, checks: ["npm test", "npm run lint"] };
  d = mergePolicyDecision(before, lint, ["src/a.ts"], false, context);
  assert.match(d.warning, /checks: \["npm test"\] -> \["npm run lint","npm test"\]/);
  assert.match(d.refusal, /checks required now were not observed passing at the accepted revision: `npm run lint`\. Review/);
  assert.equal(mergePolicyDecision(before, lint, ["src/a.ts"], false, { ...context, passed: ["npm test", "npm run lint"] }).refusal, null);
  // Checks are compared only when both sides carry them: the policy read from the files does not.
  assert.deepEqual(controlPlaneChanges(before, { protected: before.protected, eligible: before.eligible, refuseOverlap: false }), []);
  // Overlapping claims newly refused, with a live overlap.
  d = mergePolicyDecision(before, { ...before, refuseOverlap: true }, ["src/a.ts"], false, context);
  assert.match(d.refusal, /overlapping claims are now refused, and its scope overlaps live t4 \(claude-code\/opus-5.5\)\. Review/);
  assert.equal(mergePolicyDecision(before, { ...before, refuseOverlap: true }, ["src/a.ts"], false, { ...context, overlapping: [] }).refusal, null);
  // Every reason at once, and the override.
  const after = { ...lint, protected: ["AGENTS.md", "src/**"], eligible: ["claude"], refuseOverlap: true };
  d = mergePolicyDecision({ ...before, eligible: ["codex"] }, after, ["src/a.ts"], false, context);
  assert.match(d.refusal, /^the accepted revision touches newly protected paths: src\/a.ts; its contributors are no longer eligible here: [^;]+; checks required now [^;]+; overlapping claims are now refused, and its scope overlaps live t4 \(claude-code\/opus-5\.5\)\. Review/);
  assert.equal(mergePolicyDecision({ ...before, eligible: ["codex"] }, after, ["src/a.ts"], true, context).refusal, null);
});

test("the acceptance's policy is its snapshot over the server's policy before the refresh, with the current policy for the rest", () => {
  const current = { ...before, protected: ["AGENTS.md", "src/**"], eligible: ["claude"], refuseOverlap: true, checks: ["npm test", "npm run lint"], sandboxOnly: false };
  const server = { ...before, eligible: ["codex"], checks: ["npm test"] };
  // A full snapshot stands over the server's earlier policy.
  const full = { protected: ["AGENTS.md"], eligible: ["gemini"], refuseOverlap: false, checks: ["npm test"] };
  assert.deepEqual(acceptancePolicy({ policy: current, acceptanceProtected: ["AGENTS.md"], acceptancePolicy: full }, server), { ...current, ...full });
  // An acceptance that recorded protected paths alone: those, and the server's earlier values for the rest.
  assert.deepEqual(acceptancePolicy({ policy: current, acceptanceProtected: ["AGENTS.md"], acceptancePolicy: { protected: ["AGENTS.md"] } }, server),
    { ...current, protected: ["AGENTS.md"], eligible: ["codex"], refuseOverlap: false, checks: ["npm test"] });
  // The oldest acceptances recorded nothing: no protected paths.
  assert.deepEqual(acceptancePolicy({ policy: current, acceptanceProtected: null, acceptancePolicy: null }, server).protected, []);
});

test("the merge context names the item's contributors, the checks observed passing at the accepted revision and the live items its scope overlaps", () => {
  const head = "a".repeat(40), at = "2026-10-06T00:00:00.000Z";
  const detail = {
    item: { id: "t1", scope: ["src/**"], acceptedHead: head },
    policy: { ...before, checks: ["npm test", "npm run lint"] },
    evidence: [
      { itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: "codex/gpt-6-astra", at, where: "sandbox" },
      { itemId: "t1", claim: "npm run lint", grade: "observed", head, passed: false, by: "codex/gpt-6-astra", at, where: "sandbox" },
    ],
    events: [
      { actor: "codex/gpt-6-astra", kind: "item.claimed", data: {} },
      { actor: "owner", kind: "item.handoff", data: { from: "codex/gpt-6-astra", to: "claude-code/opus-5.5" } },
    ],
  };
  const items = [
    { id: "t1", state: "accepted", owner: "claude-code/opus-5.5", scope: ["src/**"] },
    { id: "t2", state: "claimed", owner: "zcode/glm-5.3", scope: ["src/ui/**"] },
    { id: "t3", state: "submitted", owner: "zcode/glm-5.3", scope: ["docs/**"] },
    { id: "t4", state: "merged", owner: null, scope: [] },
  ];
  assert.deepEqual(mergeContext(detail, items), { contributors: ["codex/gpt-6-astra", "claude-code/opus-5.5"], passed: ["npm test"], overlapping: ["t2 (zcode/glm-5.3)"] });
  assert.deepEqual(mergeContext(detail).overlapping, []);
});

function commandFixture(run) {
  return fixture(async ({ dir, write }) => {
    write("agent-policy", { agents: { codex: { available: true } } });
    write("execution-policy", { protected_path_patterns: ["src/**"] });
    const head = "a".repeat(40), base = "b".repeat(40);
    const log = join(dir, "calls.jsonl"), gitLog = join(dir, "git.jsonl"), gitDir = join(dir, "git-state");
    mkdirSync(gitDir);
    writeFileSync(log, "");
    writeFileSync(gitLog, "");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ projects: { example: { path: dir, branch: "main" } } }));
    writeFileSync(join(dir, "git"), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(args) + '\\n');
if (args.includes('--show-toplevel')) console.log(${JSON.stringify(dir)});
else if (args.includes('status') && process.env.TEST_DIRTY) console.log(' M file');
else if (args.includes('--absolute-git-dir')) console.log(${JSON.stringify(gitDir)});
else if (args.includes('--abbrev-ref')) console.log('main');
else if (args.includes('rev-parse')) console.log(${JSON.stringify(head)});
// The fork point the baseline and the accepted revision share: none unless
// the test names one, as after atelier update moved the revision past its base.
else if (args[0] === 'merge-base' && !args.includes('--is-ancestor')) console.log(process.env.TEST_FORK_POINT ?? '');
// Diffed from the recorded base, the revision shows a path the baseline
// changed since the fork; from its real fork point, only its own.
else if (args.includes('diff')) process.stdout.write(args.includes(${JSON.stringify(base)}) ? 'src/secret.ts\\0' : 'docs/own.md\\0');
else if (args.includes('merge')) { console.error('merge reached'); process.exit(1); }
else if (args[0] === 'merge-base' && args.at(-1) !== 'HEAD') process.exit(1);
`, { mode: 0o755 });
    const storage = join(dir, "server.json");
    writeFileSync(storage, JSON.stringify({ policy: before, state: "accepted", acceptanceProtected: before.protected }));
    const preload = join(dir, "fetch.mjs");
    writeFileSync(preload, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const storage = ${JSON.stringify(storage)};
let { policy, state, acceptanceProtected, acceptancePolicy } = JSON.parse(readFileSync(storage, 'utf8'));
// The acceptance on record was made before every field was recorded.
acceptancePolicy ??= { protected: acceptanceProtected };
if (process.env.TEST_SUBMITTED) state = 'submitted';
globalThis.fetch = async (url, options) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url, method: options.method, body: options.body }) + '\\n');
  if (options.method === 'PUT') policy = { ...policy, ...JSON.parse(options.body) };
  if (options.method === 'PUT' && process.env.TEST_PUT_FAIL) return new Response('unavailable', { status: 500 });
  // As the Ledger records an acceptance: the policy it is made under.
  if (url.endsWith('/accept')) { state = 'accepted'; acceptanceProtected = policy.protected; acceptancePolicy = { protected: policy.protected, eligible: policy.eligible ?? [], refuseOverlap: policy.refuseOverlap ?? false, checks: policy.checks }; }
  writeFileSync(storage, JSON.stringify({ policy, state, acceptanceProtected, acceptancePolicy }));
  if (url.endsWith('/accept')) return Response.json({ state, acceptedHead: '${head}' });
  if (url.endsWith('/api/projects/example')) return Response.json({ project: { policy }, items: JSON.parse(process.env.TEST_ITEMS ?? '[]'), baseline: { token: 'test-token', remote: 'https://git.test/example' } });
  if (url.endsWith('/items/t1')) return Response.json({
    item: { id: 't1', state, head: '${head}', acceptedHead: '${head}', base: '${base}', scope: JSON.parse(process.env.TEST_SCOPE ?? '[]') },
    policy, acceptanceProtected, acceptancePolicy, events: JSON.parse(process.env.TEST_EVENTS ?? '[]'), evidence: [], reviews: [],
  });
  return Response.json({ remote: 'https://git.test/example', token: 'test-token' });
};
`);
    const command = (args, extra = {}) => spawnSync(process.execPath, ["--import", preload, resolve("cli/atelier.mjs"), ...args, "--project", "example"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "test-token", ATELIER_SERVER: "https://atelier.test", ...extra },
    });
    const records = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    await run({ command, dir, write, calls: () => records(log), gitCalls: () => records(gitLog) });
  });
}

test("sync refreshes a full-history project without Git work", () => commandFixture(({ command, calls, gitCalls }) => {
  const result = command(["sync"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls().map((c) => c.method), ["GET", "PUT"]);
  assert.deepEqual(gitCalls(), []);
}));

test("merge refreshes first and refuses before Git merge", () => commandFixture(({ command, calls, gitCalls }) => {
  const result = command(["merge", "t1"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Warning: ControlPlane policy changed/);
  assert.match(result.stderr, /newly protected paths: src\/secret.ts/);
  assert.match(result.stderr, /https:\/\/atelier.test\/p\/example\/t1/);
  assert.deepEqual(calls().slice(0, 2).map((c) => c.method), ["GET", "PUT"]);
  assert.ok(!gitCalls().some((args) => args.includes("merge")));
  assert.ok(gitCalls().some((args) => args.includes("diff") && args.includes("--no-renames") && args.includes("-z")));
}));

test("merge override proceeds to Git merge while retaining the warning", () => commandFixture(({ command, gitCalls }) => {
  const result = command(["merge", "t1", "--policy-changed-ok"]);
  assert.match(result.stderr, /Warning: ControlPlane policy changed/);
  assert.doesNotMatch(result.stderr, /newly protected paths/);
  assert.ok(gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")));
}));

test("merge without ControlPlane files makes no project policy requests", () => commandFixture(({ command, dir, calls, gitCalls }) => {
  rmSync(join(dir, "docs/control-plane"), { recursive: true });
  const result = command(["merge", "t1"]);
  assert.doesNotMatch(result.stderr, /ControlPlane|newly protected/);
  assert.ok(!calls().some((c) => c.url.endsWith("/api/projects/example")));
  assert.ok(gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")));
}));

test("acceptance during merge uses the refreshed policy before review and acceptance", () => commandFixture(({ command, calls, gitCalls }) => {
  const result = command(["merge", "t1", "--head", "a".repeat(40), "--approve"], { TEST_SUBMITTED: "1" });
  assert.doesNotMatch(result.stderr, /policy changed since acceptance|newly protected/);
  assert.deepEqual(calls().slice(0, 5).map((c) => [c.method, c.url.split("/").at(-1)]), [
    ["GET", "example"], ["PUT", "example"], ["GET", "t1"], ["POST", "review"], ["POST", "accept"],
  ]);
  assert.ok(gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")));
}));

for (const first of ["merge", "sync", "dirty"]) {
  test(`${first} followed by repeated merges keeps refusing the acceptance`, () => commandFixture(({ command, gitCalls }) => {
    const initial = command(first === "sync" ? ["sync"] : ["merge", "t1"], first === "dirty" ? { TEST_DIRTY: "1" } : {});
    assert.equal(initial.status, first === "sync" ? 0 : 1);
    for (let i = 0; i < 2; i++) {
      const result = command(["merge", "t1"]);
      assert.match(result.stderr, /newly protected paths: src\/secret.ts/);
    }
    assert.ok(!gitCalls().some((args) => args.includes("merge")));
  }));
}

test("re-acceptance after refusal records the refreshed list", () => commandFixture(({ command, gitCalls }) => {
  assert.match(command(["merge", "t1"]).stderr, /newly protected paths/);
  const accepted = command(["accept", "t1"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  for (let i = 0; i < 2; i++) {
    const result = command(["merge", "t1"]);
    assert.doesNotMatch(result.stderr, /newly protected paths|policy changed since acceptance/);
    assert.match(result.stderr, /merge conflicts/);
  }
  assert.ok(gitCalls().some((args) => args.includes("--no-ff")));
}));

test("override still reaches Git after repeated refusals", () => commandFixture(({ command }) => {
  for (let i = 0; i < 2; i++) assert.match(command(["merge", "t1"]).stderr, /newly protected paths/);
  for (let i = 0; i < 2; i++) assert.match(command(["merge", "t1", "--policy-changed-ok"]).stderr, /merge conflicts/);
}));

test("merge honours --policy-changed-ok=true, and --policy-changed-ok=false leaves the refusal", () => commandFixture(({ command, gitCalls }) => {
  const on = command(["merge", "t1", "--policy-changed-ok=true"]);
  assert.match(on.stderr, /Warning: ControlPlane policy changed/);
  assert.doesNotMatch(on.stderr, /newly protected paths/);
  assert.ok(gitCalls().some((args) => args.includes("merge") && args.includes("--no-ff")));
  assert.match(command(["merge", "t1", "--policy-changed-ok=false"]).stderr, /newly protected paths/);
}));

test("merge diffs the accepted revision from its real fork point, so the baseline's changes since the fork are not charged to it", () => commandFixture(({ command, gitCalls }) => {
  // After atelier update the accepted revision sits on a newer baseline commit.
  // Diffed from the recorded base it would carry every path the baseline
  // changed since, here the newly protected src/secret.ts; from the fork
  // point it carries its own docs/own.md, and the merge goes ahead.
  const forkPoint = "f".repeat(40);
  const result = command(["merge", "t1"], { TEST_FORK_POINT: forkPoint });
  assert.match(result.stderr, /Warning: ControlPlane policy changed/);
  assert.doesNotMatch(result.stderr, /newly protected paths/);
  assert.match(result.stderr, /merge conflicts/);
  assert.ok(gitCalls().some((args) => args[0] === "merge-base" && args.includes("a".repeat(40))));
  assert.ok(gitCalls().some((args) => args.includes("diff") && args.includes(forkPoint) && !args.includes("b".repeat(40))));
}));

test("merge refuses when a contributor is no longer eligible under the refreshed policy", () => commandFixture(({ command, gitCalls }) => {
  // Eligible at acceptance: claude. The files now make codex the eligible agent.
  const events = JSON.stringify([{ actor: "claude-code/opus-5.5", kind: "item.claimed", data: {}, at: "2026-10-06T00:00:00.000Z" }]);
  const result = command(["merge", "t1"], { TEST_EVENTS: events, TEST_FORK_POINT: "f".repeat(40) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /its contributors are no longer eligible here: claude-code\/opus-5.5 \(eligible: codex\)\. Review the task again on its page and accept again/);
  assert.ok(!gitCalls().some((args) => args.includes("merge")));
  assert.match(command(["merge", "t1", "--policy-changed-ok"], { TEST_EVENTS: events, TEST_FORK_POINT: "f".repeat(40) }).stderr, /merge conflicts/);
}));

test("merge refuses when overlapping claims are newly refused and a live item overlaps the task's scope", () => commandFixture(({ command, write, gitCalls }) => {
  write("agent-policy", { agents: { claude: { available: true } }, authority: { overlapping_claims: "refuse" } });
  const env = { TEST_FORK_POINT: "f".repeat(40), TEST_SCOPE: JSON.stringify(["src/ui/**"]), TEST_ITEMS: JSON.stringify([
    { id: "t2", state: "claimed", owner: "codex/gpt-6-astra", scope: ["src/**"] },
    { id: "t3", state: "claimed", owner: "codex/gpt-6-astra", scope: ["docs/**"] },
  ]) };
  const result = command(["merge", "t1"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /overlapping claims are now refused, and its scope overlaps live t2 \(codex\/gpt-6-astra\)\. Review the task/);
  assert.doesNotMatch(result.stderr, /t3/);
  assert.ok(!gitCalls().some((args) => args.includes("merge")));
  // With no live overlap the change is a warning, and the merge goes ahead.
  const alone = command(["merge", "t1"], { ...env, TEST_ITEMS: JSON.stringify([{ id: "t3", state: "claimed", owner: "codex/gpt-6-astra", scope: ["docs/**"] }]) });
  assert.doesNotMatch(alone.stderr, /overlapping claims are now refused/);
  assert.match(alone.stderr, /merge conflicts/);
}));

for (const content of ["{", "", "{}", "null"]) {
  test(`invalid policy ${JSON.stringify(content)} makes sync warn, stops merge and init naming the file, and leaves cancel alone`, () => commandFixture(({ command, dir, calls, gitCalls }) => {
    command(["sync"]);
    writeFileSync(join(dir, "docs/control-plane/agent-policy.v1.json"), content);
    const count = calls().length;
    const file = /docs\/control-plane\/agent-policy\.v1\.json: \S/;
    for (let i = 0; i < 2; i++) {
      const sync = command(["sync"]);
      assert.equal(sync.status, 0, sync.stderr);
      assert.match(sync.stdout, /Warning: ControlPlane policy could not be read: docs\/control-plane\/agent-policy\.v1\.json: .*The stored policy was not refreshed\./);
      // A merge never skips the comparison: it stops until the file is fixed.
      const merge = command(["merge", "t1"]);
      assert.equal(merge.status, 1);
      assert.match(merge.stderr, /^atelier: ControlPlane policy could not be read: docs\/control-plane\/agent-policy\.v1\.json: .*\. Fix the file, then run atelier merge t1 again\.$/m);
      assert.doesNotMatch(merge.stderr, /merge conflicts|newly protected|\n\s+at /);
      assert.ok(!gitCalls().some((args) => args.includes("merge") || args.includes("fetch")));
      // init stops the same way, with a message and no stack trace.
      const init = command(["init", "--approval", "Owner approved"]);
      assert.equal(init.status, 1);
      assert.match(init.stderr, /^atelier: ControlPlane policy could not be read: docs\/control-plane\/agent-policy\.v1\.json: .*\. Fix the file, then run atelier init again\.$/m);
      assert.match(init.stderr, file);
      assert.doesNotMatch(init.stderr, /SyntaxError|\n\s+at /);
      const cancel = command(["merge", "t1", "--cancel"], { TEST_PUT_FAIL: "1" });
      assert.equal(cancel.status, 0, cancel.stderr);
    }
    assert.ok(!calls().slice(count).some((c) => c.method === "PUT"));
  }));
}

test("init protect extras survive repeated refreshes and later init", () => commandFixture(({ command, dir, write, calls }) => {
  const init = command(["init", "--protect", "owner/**", "--approval", "Owner approved"]);
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"))).projects.example.protect, ["owner/**"]);
  for (let i = 0; i < 2; i++) {
    write("execution-policy", { protected_path_patterns: [`new${i}/**`] });
    const sync = command(["sync"]);
    assert.equal(sync.status, 0, sync.stderr);
    const body = JSON.parse(calls().filter((c) => c.method === "PUT").at(-1).body);
    assert.ok(body.protected.includes("owner/**"));
    assert.ok(body.protected.includes(`new${i}/**`));
  }
  assert.equal(command(["init", "--approval", "Owner approved"]).status, 0);
  assert.ok(JSON.parse(calls().filter((c) => c.method === "PUT").at(-1).body).protected.includes("owner/**"));
}));
