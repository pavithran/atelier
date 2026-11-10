// t589: after a timed-out or failed build's run report, `atelier show` names
// the run log's host and path ("Last run", and lastRun.log in --json), or says
// "no log named" when the runner kept none. Through the real server and CLI.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "claude-code/sonnet-5.5";
const root = mkdtempSync(join(tmpdir(), "atelier-run-log-show-"));
after(() => rmSync(root, { recursive: true, force: true }));
const baseEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
for (const k of Object.keys(baseEnv)) if (k.startsWith("ATELIER_") || k.startsWith("GIT_AUTHOR_") || k.startsWith("GIT_COMMITTER_")) delete baseEnv[k];
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const run = (cmd, args, opts = {}) => new Promise((ok) => execFile(cmd, args, { env: { ...baseEnv, ...identity }, encoding: "utf8", timeout: 120_000, ...opts }, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
let server, base, runnerToken;
const config = join(root, "config"), cache = join(root, "cache");
const api = async (method, path, body) => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const cli = (argv, cwd = root) => run(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], { cwd, env: { ...baseEnv, ...identity, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: cache, ATELIER_TOKEN: OWNER, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: "claude-code/opus-5.5" } });
const report = (item, outcome, facts) => fetch(`${base}/api/runs`, { method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json", "x-atelier-runner": "home:studio", "x-atelier-actor": BUILDER }, body: JSON.stringify({ actor: BUILDER, role: "build", outcome, project: "demo", item, facts }) });
const newItem = async (title) => {
  const id = (await api("POST", "/projects/demo/items", { title, scope: ["src/**"] })).body.id;
  assert.equal((await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", agent: "claude-code", model: "sonnet-5.5" })).status, 200);
  // The runner reports a run on a task it holds: it offers, then claims.
  const asRunner = (path, body) => fetch(`${base}/api${path}`, { method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json", "x-atelier-runner": "home:studio", "x-atelier-actor": BUILDER }, body: JSON.stringify(body) });
  const offered = await asRunner("/queue", { runner: "home:studio", kind: "home", jobs: ["build"], agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }] });
  assert.equal(offered.status, 200, await offered.clone().text());
  const claimed = await asRunner(`/projects/demo/items/${id}/claim`, {});
  assert.equal(claimed.status, 200, await claimed.clone().text());
  return id;
};

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await cli(["login", "--server", base])).code, 0);
  const checkout = join(root, "demo");
  mkdirSync(checkout);
  await run("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  writeFileSync(join(checkout, "a.txt"), "one\n");
  await run("git", ["add", "."], { cwd: checkout });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: checkout });
  const init = await cli(["init", "--check", "git status", "--commit-name", "t", "--commit-email", "t@example.test"], checkout);
  assert.equal(init.code, 0, `${init.stdout}\n${init.stderr}`);
  runnerToken = (await api("POST", "/tokens", { runner: "home:studio", projects: ["demo"] })).body.token;
});
after(async () => { await server?.close(); });

const facts = (extra) => ({ exitCode: null, signal: null, program: "claude", lines: 12, bytes: 300, log: null, host: "ai-studio-256", ...extra });

for (const [outcome, exit] of [["timed-out", {}], ["refused", { exitCode: 1 }]]) {
  test(`after a ${outcome} build's run report, show names the log's host and path, in text and --json`, async () => {
    const id = await newItem(`Reported ${outcome}`);
    const log = `/Users/builder/cache/work/run-logs/demo-${id}-1-2-3.log`;
    const sent = await report(id, outcome, facts({ ...exit, log }));
    assert.equal(sent.status, 201, JSON.stringify(await sent.json()));
    const text = (await cli(["show", id, "--project", "demo"])).stdout;
    assert.match(text, new RegExp(`Last run: ${outcome} \\(build\\) by ${BUILDER} on home:studio at .*log on ai-studio-256 at ${log.replace(/\./g, "\\.")}`));
    const json = JSON.parse((await cli(["show", id, "--project", "demo", "--json"])).stdout);
    assert.equal(json.lastRun.log, log);
    assert.equal(json.lastRun.host, "ai-studio-256");
  });
}

test("a run report whose log was not written shows 'no log named' and lastRun.log null", async () => {
  const id = await newItem("Reported with no log");
  assert.equal((await report(id, "timed-out", facts())).status, 201);
  assert.match((await cli(["show", id, "--project", "demo"])).stdout, /Last run: .*no log named/);
  assert.equal(JSON.parse((await cli(["show", id, "--project", "demo", "--json"])).stdout).lastRun.log, null);
});
