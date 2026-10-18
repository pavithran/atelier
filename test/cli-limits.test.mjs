// t763 (audit 2026-10-17, audit-cli findings 2 and 3, audit-usage finding 5):
//  - `atelier status` read the Keychain 330 times for 110 requests (3.7 s of
//    7.3 s), because apiToken() asked the store on every call;
//  - request() and git() had no timeout, so a server or a remote that stopped
//    answering held a command for ever;
//  - the integrator took one refresh lease 334 times, each failing on
//    `git merge-base`, with no wait between tries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as tick } from "node:timers/promises";
import { runRunner, passedBy, backoffAfter, backoffKey, backoffPolls } from "../cli/runner.mjs";
import { lowSpeedEnv, serverTimeoutMs, talksToRemote, UPLOAD_BYTES, SERVER_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, LOW_SPEED_BYTES, LOW_SPEED_SECONDS } from "../cli/timeouts.mjs";

process.env.ATELIER_LOAD = "0";
const cli = resolve("cli/atelier.mjs");
const atelierModule = pathToFileURL(cli).href;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "t763-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(argv, env, { script } = {}) {
  const child = spawn(process.execPath, script ? ["--input-type=module", "-e", script] : [cli, ...argv], { env: { ...process.env, ...env } });
  let output = "";
  child.stdout.on("data", (s) => output += s);
  child.stderr.on("data", (s) => output += s);
  return new Promise((done) => child.on("close", (status) => done({ status, output })));
}

test("atelier status reads the token store once, however many requests it makes (audit-cli finding 2)", async (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "bin")); mkdirSync(join(dir, "cfg"));
  const count = join(dir, "count");
  writeFileSync(join(dir, "bin", "security"), `#!/bin/sh\necho x >> ${count}\necho store-token\n`);
  chmodSync(join(dir, "bin", "security"), 0o755);
  const seen = [];
  const server = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  writeFileSync(join(dir, "cfg", "config.json"), JSON.stringify({ server: `http://127.0.0.1:${server.address().port}`, projects: {} }));
  const env = { PATH: `${join(dir, "bin")}:${process.env.PATH}`, ATELIER_SECRET_STORE: "keychain", ATELIER_CONFIG_DIR: join(dir, "cfg"), ATELIER_CACHE: join(dir, "cache"), ATELIER_ACTOR: "owner", ATELIER_TOKEN: "" };
  const { status } = await run(["status"], env);
  assert.equal(status, 0);
  assert.ok(seen.length > 1, `status made several requests (${seen.length})`);
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 1, "one read of the store for all of them");
});

test("a request the server never answers ends with an error naming the call that timed out (audit-cli finding 3)", async (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "cfg"));
  const server = createServer(() => { /* never answers */ });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  writeFileSync(join(dir, "cfg", "config.json"), JSON.stringify({ server: `http://127.0.0.1:${server.address().port}`, projects: {} }));
  const { status, output } = await run(["ls", "--project", "p"], { ATELIER_CONFIG_DIR: join(dir, "cfg"), ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake", ATELIER_ACTOR: "owner", ATELIER_SERVER_TIMEOUT_MS: "400" });
  assert.equal(status, 4, "exit 4 is the server that cannot answer");
  assert.match(output, /server request failed: (GET|POST) \/\S+ timed out after 0\.4 s/);
});

test("the server limit is 60 s, longer for a large body, and ATELIER_SERVER_TIMEOUT_MS overrides it", () => {
  assert.equal(SERVER_TIMEOUT_MS, 60_000);
  assert.equal(serverTimeoutMs(), 60_000);
  assert.equal(serverTimeoutMs({ small: true }), 60_000);
  assert.equal(serverTimeoutMs({ big: "x".repeat(UPLOAD_BYTES) }), UPLOAD_TIMEOUT_MS);
  assert.ok(UPLOAD_TIMEOUT_MS > SERVER_TIMEOUT_MS);
  process.env.ATELIER_SERVER_TIMEOUT_MS = "250";
  try { assert.equal(serverTimeoutMs(), 250); } finally { delete process.env.ATELIER_SERVER_TIMEOUT_MS; }
  process.env.ATELIER_SERVER_TIMEOUT_MS = "soon";
  try { assert.equal(serverTimeoutMs(), 60_000, "a value that is not a number is ignored"); } finally { delete process.env.ATELIER_SERVER_TIMEOUT_MS; }
});

test("lowSpeedEnv adds Git's low-speed floor after the config a token's header already uses", () => {
  const env = lowSpeedEnv({ A: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: Bearer t" });
  assert.equal(env.A, "1");
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.deepEqual([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0], ["http.extraHeader", "Authorization: Bearer t"]);
  assert.deepEqual([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1], ["http.lowSpeedLimit", String(LOW_SPEED_BYTES)]);
  assert.deepEqual([env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2], ["http.lowSpeedTime", String(LOW_SPEED_SECONDS)]);
  assert.equal(lowSpeedEnv({}).GIT_CONFIG_COUNT, "2");
  assert.equal(talksToRemote(["fetch", "--quiet", "origin"]), true);
  assert.equal(talksToRemote(["rev-parse", "HEAD"]), false);
});

// A stand-in git on PATH records the configuration it is given and, for a
// fetch, fails the way git does when a transfer stalls.
test("git() gives a remote command the low-speed floor, none to a local one, and says a stalled transfer timed out", async (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "bin"));
  const log = join(dir, "env.log");
  writeFileSync(join(dir, "bin", "git"), `#!/bin/sh\necho "$1 $GIT_CONFIG_COUNT $GIT_CONFIG_KEY_0 $GIT_CONFIG_VALUE_0 $GIT_CONFIG_KEY_1 $GIT_CONFIG_VALUE_1" >> ${log}\nif [ "$1" = fetch ]; then echo "error: RPC failed; HTTP 000 curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 120 seconds" >&2; exit 128; fi\necho ok\n`);
  chmodSync(join(dir, "bin", "git"), 0o755);
  const script = `import { git } from ${JSON.stringify(atelierModule)};
git(["rev-parse", "HEAD"]);
git(["fetch", "origin"], { token: "tok" });`;
  const { status, output } = await run([], { PATH: `${join(dir, "bin")}:${process.env.PATH}`, ATELIER_CONFIG_DIR: dir }, { script });
  assert.notEqual(status, 0);
  assert.match(output, /git fetch origin timed out \(the transfer stalled below the low-speed floor\):/);
  const [local, remote] = readFileSync(log, "utf8").trim().split("\n");
  assert.match(local, /^rev-parse\s*$/, "a local command gets no configuration from the CLI");
  assert.equal(remote, "fetch 3 http.extraHeader Authorization: Bearer tok http.lowSpeedLimit 1000", "the token's header keeps index 0 and the floor follows");
});

// The integrator's refresh lease failed on `git merge-base` and was taken
// again at the next poll, each time under a new dispatch (334 leases for
// t459, t478 and t494 in a day). The stand-in server grants a lease that
// names no heads, so the job fails on the runner's side at once, as the
// merge-base failure did.
const HEAD = "a".repeat(40);
const refresh = (at, extra = {}) => ({
  project: "atelier",
  item: { id: "t459", dispatch: { job: "task-refresh", head: HEAD, at } },
  agent: "atelier", model: "integrator", actor: "atelier/integrator", ...extra,
});

async function integrate(polls, { grant }) {
  const leases = [];
  let poll = 0;
  const args = { _: ["runner"], multi: { name: ["home:int"], integrate: [true] }, name: "home:int", integrate: true };
  await runRunner(args, {
    workspacePath: () => "/cache/work/atelier/t459", wait: () => tick(),
    taskIO: { log: () => {} },
    async queue() {
      poll++;
      if (poll === polls) process.emit("SIGTERM");
      return poll === polls ? [] : [refresh(`dispatch-${poll}`)];
    },
    async executeChild(argv) {
      if (argv.includes("refresh-lease") && argv.includes("--job")) { leases.push(poll); return { code: 0, output: JSON.stringify(grant(poll)) }; }
      return { code: 0, output: "{}" };
    },
  });
  return leases;
}

test("an --integrate runner whose refresh keeps failing on its own side waits longer between tries (audit-usage finding 5)", async () => {
  // A lease that names no heads: the job fails after the lease, releases it,
  // and the next poll offers the task again under a new dispatch.
  const leases = await integrate(20, { grant: () => ({ lease: { id: "l1" } }) });
  assert.deepEqual(leases, [1, 2, 3, 5, 9, 17], "the first three tries follow each other, then the waits double: 6 leases in 19 polls, not 19");
});

test("passedBy waits out a task's backoff and takes it again once the polls have passed", () => {
  const task = refresh("a");
  const empty = { refused: new Set(), failures: new Map(), infrastructureFailures: new Map() };
  const backoff = new Map([[backoffKey(task), { count: 2, due: 10 }]]);
  assert.match(passedBy(task, ["task-refresh"], { ...empty, backoff, poll: 8 }), /^Passed by: it failed on this runner 2 times in a row; it is tried again in 2 polls\.$/);
  assert.match(passedBy(task, ["task-refresh"], { ...empty, backoff: new Map([[backoffKey(task), { count: 1, due: 9 }]]), poll: 8 }), /1 time in a row; it is tried again in 1 poll\.$/);
  assert.equal(passedBy(task, ["task-refresh"], { ...empty, backoff, poll: 10 }), null);
  assert.equal(passedBy(task, ["task-refresh"], { ...empty, poll: 8 }), null, "with no entry the task is taken");
  // Kept by task and job, so a new dispatch of the same job does not clear it.
  assert.equal(backoffKey(refresh("a")), backoffKey(refresh("b")));
  assert.notEqual(backoffKey(refresh("a")), backoffKey({ ...refresh("a"), item: { id: "t459", dispatch: { job: "review" } } }));
});

test("backoffAfter counts failures on the runner's own side, doubles the wait to a cap, and clears on any other run", () => {
  assert.equal(backoffPolls(1), 0);
  assert.equal(backoffPolls(2), 0, "the first two failures cost no wait");
  assert.equal(backoffPolls(3), 2);
  assert.equal(backoffPolls(4), 4);
  assert.equal(backoffPolls(5), 8);
  assert.equal(backoffPolls(20), 60, "at most half an hour of 30 second polls");
  const infrastructure = { phase: "failed", reason: "git merge-base failed" };
  const first = backoffAfter(undefined, infrastructure, 5);
  assert.deepEqual(first, { count: 1, due: 5 });
  const third = backoffAfter(backoffAfter(first, infrastructure, 6), infrastructure, 7);
  assert.deepEqual(third, { count: 3, due: 9 });
  assert.deepEqual(backoffAfter(third, infrastructure, 9), { count: 4, due: 13 });
  assert.equal(backoffAfter(first, { phase: "refreshed" }, 7), undefined, "a run that does not fail clears it");
  assert.equal(backoffAfter(first, { phase: "idle" }, 7), undefined);
  for (const own of [{ taskFailure: true }, { recorded: true }, { claimRefused: true }, { skipped: true }, { providerLimit: { until: 1 } }, { terminalState: "merged" }]) {
    assert.equal(backoffAfter(first, { phase: "failed", ...own }, 7), first, `${Object.keys(own)[0]} leaves the wait as it was`);
  }
});
