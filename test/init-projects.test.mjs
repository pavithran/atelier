import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve("cli/atelier.mjs");

function fixture(run) {
  mkdirSync(".cache", { recursive: true });
  const dir = mkdtempSync(resolve(".cache/init-test-"));
  const config = join(dir, "config.json"), log = join(dir, "calls.jsonl");
  const initial = { server: "https://atelier.test", owner: "owner", projects: { weblog: { path: dir, branch: "main", notesRemote: "origin" } } };
  writeFileSync(config, JSON.stringify(initial));
  writeFileSync(log, "");
  writeFileSync(join(dir, "git"), `#!/usr/bin/env node
if (process.argv.includes('--show-toplevel')) console.log(process.cwd());
else if (process.argv.includes('--abbrev-ref')) console.log('main');
else if (process.argv.includes('rev-parse')) console.log('a'.repeat(40));
else if (process.argv.includes('config')) process.exit(1);
else if (!process.argv.includes('push')) process.exit(2);
`, { mode: 0o755 });
  const preload = join(dir, "fetch.mjs");
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, options) => {
  appendFileSync(process.env.TEST_CALLS, JSON.stringify({ url, ...options }) + '\\n');
  if (process.env.TEST_REFUSE) return Response.json({ error: 'live_work', detail: 'live work' }, { status: 409 });
  const renamed = /\\/projects\\/([^/]+)\\/rename$/.exec(url);
  if (renamed) {
    const from = decodeURIComponent(renamed[1]), to = JSON.parse(options.body).to;
    return Response.json({ from, to, key: from, names: [from, to], project: { name: to, repo: from, policy: { checks: [], protected: [] } } });
  }
  return Response.json(options.method === 'DELETE' ? { removed: true } : {
    project: { repo: 'weblog', policy: { checks: [], protected: ['manual/**'], ...(process.env.TEST_APPROVED ? { approval: process.env.TEST_APPROVED } : {}) } },
    remote: 'https://git.test/weblog', token: 'test-token',
    baseline: { remote: 'https://git.test/weblog', token: 'test-token' }
  });
};
`);
  const command = (args, extra = {}) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "test-token", ATELIER_SERVER: initial.server, ATELIER_ACTOR: "owner", TEST_CALLS: log, ...extra },
  });
  try {
    run({ command, initial, config: () => JSON.parse(readFileSync(config, "utf8")), calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("CLI init sends a title update under the registered name", () => fixture(({ command, config, calls }) => {
  const result = command(["init", "--title", "Ikon weblog"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls()[0].url, "https://atelier.test/api/projects/weblog");
  assert.equal(JSON.parse(calls()[0].body).title, "Ikon weblog");
  assert.deepEqual(Object.keys(config().projects), ["weblog"]);
}));

test("CLI rename refuses a different name unless it changes only local config", () => fixture(({ command, initial, config, calls }) => {
  const refused = command(["init", "--name", "ikon"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /registered as weblog/);
  assert.deepEqual(config(), initial);
  const renamed = command(["init", "--name", "ikon", "--rename-local"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.deepEqual(config().projects, { ikon: initial.projects.weblog });
  assert.deepEqual(calls(), []);
}));

test("CLI rename asks the server, then moves the local config entry to the new name", () => fixture(({ command, initial, config, calls }) => {
  const renamed = command(["projects", "rename", "weblog", "ikon"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.equal(calls().length, 1);
  assert.equal(calls()[0].url, "https://atelier.test/api/projects/weblog/rename");
  assert.equal(calls()[0].method, "POST");
  assert.deepEqual(JSON.parse(calls()[0].body), { to: "ikon" });
  assert.deepEqual(config().projects, { ikon: initial.projects.weblog });
  assert.match(renamed.stdout, /weblog is now ikon on https:\/\/atelier\.test\. Its Ledger, baseline weblog and every fork stay where they are\. The local config entry weblog is now ikon\./);
  assert.match(renamed.stdout, /weblog still works/);
}));

test("CLI rename leaves local config alone when the server refuses, or when no entry has the old name", () => fixture(({ command, initial, config, calls }) => {
  const refused = command(["projects", "rename", "weblog", "ikon"], { TEST_REFUSE: "1" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /live_work/);
  assert.deepEqual(config(), initial);
  const elsewhere = command(["projects", "rename", "elsewhere", "other"]);
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  assert.deepEqual(config(), initial);
  assert.match(elsewhere.stdout, /No local config entry was called elsewhere\./);
  assert.equal(calls().length, 2);
}));

test("CLI rename keeps an entry already under the new name and says what the dropped one held", () => fixture(({ command, initial, config }) => {
  const prepared = command(["init", "--name", "ikon", "--rename-local"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const both = { ...config(), projects: { ikon: config().projects.ikon, weblog: { path: "/elsewhere", branch: "old", notesRemote: "origin" } } };
  writeFileSync(join(initial.projects.weblog.path, "config.json"), JSON.stringify(both));
  const renamed = command(["projects", "rename", "weblog", "ikon"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.deepEqual(config().projects, { ikon: initial.projects.weblog });
  assert.match(renamed.stdout, /already had an entry ikon, which is kept; the entry weblog was dropped \(it held: path \/elsewhere, branch old, notesRemote origin\)/);
}));

// Task t108: a rename the server finishes while answering with the new
// name as both names (a retry that named the new name) dropped the local
// entry under that name.
test("CLI rename leaves the local config alone when the server answers the same name for both", () => fixture(({ command, initial, config }) => {
  const prepared = command(["init", "--name", "ikon", "--rename-local"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const finished = command(["projects", "rename", "ikon", "ikon"]);
  assert.equal(finished.status, 0, finished.stderr);
  assert.deepEqual(config().projects, { ikon: initial.projects.weblog });
  assert.equal(finished.stdout, "ikon is the project's name on https://atelier.test, and the rename that gave it that name is complete. The local config is unchanged.\n");
}));

test("CLI rename needs both names and contacts no server without them", () => fixture(({ command, initial, config, calls }) => {
  for (const argv of [["projects", "rename"], ["projects", "rename", "weblog"], ["projects", "rename", "weblog", "ikon", "extra"]]) {
    const r = command(argv);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: atelier projects remove NAME \[--force\] · projects rename OLD NEW/);
  }
  assert.deepEqual(config(), initial);
  assert.deepEqual(calls(), []);
}));

test("CLI removal keeps local config on refusal and removes it on success", () => fixture(({ command, initial, config, calls }) => {
  assert.equal(command(["projects", "remove", "weblog"], { TEST_REFUSE: "1" }).status, 1);
  assert.deepEqual(config(), initial);
  const removed = command(["projects", "remove", "weblog", "--force"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(config().projects, {});
  assert.equal(calls()[1].method, "DELETE");
  assert.deepEqual(JSON.parse(calls()[1].body), { force: true });
  assert.match(removed.stdout, /Artifacts repository and project Ledger data are retained/);
}));

test("CLI removal says which local settings were dropped, including notesRemote", () => fixture(({ command, initial }) => {
  const removed = command(["projects", "remove", "weblog", "--force"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Local settings dropped: path .+, branch main, notesRemote origin\./);
  assert.ok(removed.stdout.includes(`path ${initial.projects.weblog.path}`));
}));

test("CLI removal of a project with no local entry names no dropped settings", () => fixture(({ command }) => {
  const removed = command(["projects", "remove", "elsewhere"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.doesNotMatch(removed.stdout, /Local settings dropped/);
}));

test("CLI init sends ControlPlane role and class policy", () => fixture(({ command, initial, calls }) => {
  const dir = join(initial.projects.weblog.path, "docs/control-plane");
  mkdirSync(dir, { recursive: true });
  const agents = { codex: { available: true, eligible_roles: ["executor"], preferred_roles: ["planner"] } };
  const execution = { allowed_classes: ["coordinated", "protected"], direct: { enabled: false, allowed_path_patterns: [] }, protected_path_patterns: ["security/**"] };
  writeFileSync(join(dir, "agent-policy.v1.json"), JSON.stringify({ agents }));
  writeFileSync(join(dir, "execution-policy.v1.json"), JSON.stringify(execution));
  const result = command(["init", "--approval", "Owner approved this fixture"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(calls()[0].body);
  assert.deepEqual(body.agents, agents);
  assert.deepEqual(body.execution, execution);
}));

test("CLI init keeps the approval recorded on a ControlPlane project unless the baseline is replaced", () => fixture(({ command, initial, calls }) => {
  const dir = join(initial.projects.weblog.path, "docs/control-plane");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent-policy.v1.json"), JSON.stringify({ agents: { codex: { available: true, eligible_roles: ["executor"] } } }));
  const approval = "PAVI, 2026-10-01: approved the copy";
  // Nothing recorded yet: the approval is asked for, after one read and no write.
  const asked = command(["init", "--title", "Weblog"]);
  assert.equal(asked.status, 1, asked.stdout);
  assert.match(asked.stderr, /Record the project owner's approval/);
  assert.deepEqual(calls().map((c) => c.method), ["GET"]);
  // Recorded: a change to the title or the checks keeps it and sends none.
  const kept = command(["init", "--title", "Weblog", "--check", "npm test"], { TEST_APPROVED: approval });
  assert.equal(kept.status, 0, kept.stderr);
  const put = calls().filter((c) => c.method === "PUT").at(-1);
  assert.equal(JSON.parse(put.body).approval, undefined);
  assert.deepEqual(JSON.parse(put.body).checks, ["npm test"]);
  assert.ok(kept.stdout.includes(`Approval:   ${approval}`), kept.stdout);
  // Given, it is sent as before, with no read first.
  const given = command(["init", "--approval", "PAVI, 2026-10-02: approved again"], { TEST_APPROVED: approval });
  assert.equal(given.status, 0, given.stderr);
  assert.deepEqual(calls().slice(-1).map((c) => [c.method, JSON.parse(c.body).approval]), [["PUT", "PAVI, 2026-10-02: approved again"]]);
  // --reset drops the recorded policy and --history-since replaces the baseline: asked again, and told why.
  for (const [flag, why] of [[["--reset"], /--reset starts the policy over/], [["--history-since", "2026-01-01"], /--history-since replaces the baseline/]]) {
    const again = command(["init", ...flag], { TEST_APPROVED: approval });
    assert.equal(again.status, 1, again.stdout);
    assert.match(again.stderr, why);
    assert.match(again.stderr, /Record the project owner's approval/);
  }
  assert.equal(calls().filter((c) => c.method === "PUT").length, 2);
}));

test("CLI sync refreshes ControlPlane policy even when the baseline already matches", () => fixture(({ command, initial, calls }) => {
  const top = initial.projects.weblog.path;
  initial.projects.weblog.fresh = true;
  // Paths the owner added with init --protect are kept from the local registration.
  initial.projects.weblog.protect = ["manual/**"];
  writeFileSync(join(top, "config.json"), JSON.stringify(initial));
  const gitDir = join(top, "fake-git"), dir = join(top, "docs/control-plane");
  mkdirSync(gitDir);
  mkdirSync(dir, { recursive: true });
  const head = "a".repeat(40);
  writeFileSync(join(gitDir, "atelier-baseline-map.json"), JSON.stringify({ weblog: { [head]: head } }));
  writeFileSync(join(top, "git"), `#!/usr/bin/env node
if (process.argv.includes('--show-toplevel')) console.log(process.cwd());
else if (process.argv.includes('--absolute-git-dir')) console.log(process.cwd() + '/fake-git');
else if (process.argv.includes('--abbrev-ref')) console.log('main');
else if (process.argv.includes('rev-parse')) console.log('a'.repeat(40));
else if (process.argv.includes('config')) process.exit(1);
else if (!process.argv.includes('status') && !process.argv.includes('fetch')) process.exit(2);
`, { mode: 0o755 });
  const agents = { codex: { available: true, eligible_roles: ["executor"] } };
  const execution = { allowed_classes: ["protected"], direct: { enabled: false, allowed_path_patterns: [] }, protected_path_patterns: ["security/**"] };
  writeFileSync(join(dir, "agent-policy.v1.json"), JSON.stringify({ agents }));
  writeFileSync(join(dir, "execution-policy.v1.json"), JSON.stringify(execution));
  const result = command(["sync"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /baseline already matches/);
  const body = JSON.parse(calls().find((c) => c.method === "PUT").body);
  assert.deepEqual(body.agents, agents);
  assert.deepEqual(body.execution, execution);
  assert.ok(body.protected.includes("manual/**"));
  assert.ok(body.protected.includes("security/**"));
}));
