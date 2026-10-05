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
  return Response.json(options.method === 'DELETE' ? { removed: true } : {
    project: { repo: 'weblog', policy: { checks: [], protected: [] } },
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
