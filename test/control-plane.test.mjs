import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { controlPlaneChanges, mergePolicyDecision, readControlPlane, refreshControlPlane } from "../cli/atelier.mjs";

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
  assert.deepEqual(Object.keys(calls[1].body).sort(), ["eligible", "protected", "refuseOverlap"]);
  assert.deepEqual(stored, { ...original, policy: { ...before, ...calls[1].body } });
  assert.deepEqual(result.before, before);
  assert.deepEqual(result.policy, stored.policy);
  assert.equal(lines.length, 3);
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

test("adapter-only policy is read and malformed policy fails before requests", () => fixture(async ({ dir, write }) => {
  write("project-adapter", { protected_surfaces: [{ pattern: "src/**" }] });
  assert.ok(readControlPlane(dir).protected.includes("src/**"));
  writeFileSync(join(dir, "docs/control-plane/agent-policy.v1.json"), "{");
  await assert.rejects(refreshControlPlane(dir, "example", assert.fail, assert.fail), SyntaxError);
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

test("merge warns on eligibility and overlap changes without refusing unrelated paths", () => {
  const result = mergePolicyDecision(before, { ...before, eligible: ["codex"], refuseOverlap: true }, ["src/a.ts"]);
  assert.match(result.warning, /eligible:.*refuseOverlap:/);
  assert.equal(result.refusal, null);
  assert.equal(mergePolicyDecision(before, { ...before, protected: ["AGENTS.md", "package.json"] }, ["package.json"]).refusal, null);
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
if (args.includes('--absolute-git-dir')) console.log(${JSON.stringify(gitDir)});
else if (args.includes('--abbrev-ref')) console.log('main');
else if (args.includes('rev-parse')) console.log(${JSON.stringify(head)});
else if (args.includes('diff')) process.stdout.write('src/secret.ts\\0');
else if (args.includes('merge')) { console.error('merge reached'); process.exit(1); }
`, { mode: 0o755 });
    const preload = join(dir, "fetch.mjs");
    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
let policy = ${JSON.stringify(before)};
let state = process.env.TEST_SUBMITTED ? 'submitted' : 'accepted';
globalThis.fetch = async (url, options) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url, method: options.method, body: options.body }) + '\\n');
  if (options.method === 'PUT') policy = { ...policy, ...JSON.parse(options.body) };
  if (url.endsWith('/accept')) state = 'accepted';
  if (url.endsWith('/api/projects/example')) return Response.json({ project: { policy } });
  if (url.endsWith('/items/t1')) return Response.json({ item: { state, head: '${head}', acceptedHead: '${head}', base: '${base}' }, policy, events: [], evidence: [], reviews: [] });
  return Response.json({ remote: 'https://git.test/example', token: 'test-token' });
};
`);
    const command = (args, extra = {}) => spawnSync(process.execPath, ["--import", preload, resolve("cli/atelier.mjs"), ...args, "--project", "example"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "test-token", ATELIER_SERVER: "https://atelier.test", ...extra },
    });
    const records = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    await run({ command, dir, calls: () => records(log), gitCalls: () => records(gitLog) });
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
