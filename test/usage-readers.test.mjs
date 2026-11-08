import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runUsage } from "../cli/usage.mjs";

// Each test enters through runUsage. The files are fixtures this file writes,
// the Z.ai answer and the server are stubs, and the clock is a fake: no test
// reads a real log, calls Z.ai or contacts a real server.

const NOW = Date.parse("2026-11-08T11:00:00.000Z");
const hoursAgo = (h) => NOW - h * 3_600_000;
const KEY = "zai-TESTONLY-0123456789abcdefghij";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "usage readers "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const args = (...flags) => {
  const out = { _: ["runner"], multi: { usage: [true] }, usage: true };
  for (const flag of flags) {
    const at = flag.indexOf("=");
    const [key, value] = at < 0 ? [flag, true] : [flag.slice(0, at), flag.slice(at + 1)];
    out[key] = value;
    (out.multi[key] ??= []).push(value);
  }
  return out;
};

const enoent = () => Object.assign(new Error("no config"), { code: "ENOENT" });

// Z.ai's quota answer: one limit per window, with percent used and the reset in ms.
const ZAI_OK = { code: 200, success: true, data: { limits: [
  { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42, nextResetTime: NOW + 2 * 3_600_000 },
  { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 17, nextResetTime: NOW + 3 * 86_400_000 },
  { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 3, nextResetTime: NOW + 20 * 86_400_000 },
] } };
const answer = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function setup(t, over = {}) {
  const dir = tempDir(t);
  const paths = { claudeUsage: join(dir, "claude-usage.txt"), antigravityLog: join(dir, "cli.log"), ...over.paths };
  const calls = { report: [], printed: [], order: [] };
  const io = {
    paths, env: { PATH: "/usr/bin", ZAI_API_KEY: KEY, ...over.env }, now: () => NOW,
    readConfig: () => { throw enoent(); },
    zaiFetch: answer(ZAI_OK),
    report: async (tool, body, runner) => { calls.order.push(`report ${tool}`); calls.report.push({ tool, body, runner }); return {}; },
    propose: async () => { calls.order.push("propose"); },
    print: (text) => calls.printed.push(text),
    ...over.io,
  };
  return { io, calls, dir, paths };
}
const posted = (calls, tool) => calls.report.find((r) => r.tool === tool)?.body;
const touchAt = (path, text, at) => { writeFileSync(path, text); utimesSync(path, at / 1000, at / 1000); };
const names = (body) => body.windows.map((w) => w.name);

// ── criterion 1: Z.ai ──────────────────────────────────────────────────────

test("zai prints and reports its 5-hour and weekly windows, and never the key", async (t) => {
  const { io, calls } = setup(t);
  await runUsage(args("dry-run", "name=home:test"), io);
  const printed = calls.printed.join("\n");
  assert.match(printed, /zai:\n  5-hour 42% used, resets 2026-11-08T13:00Z/);
  assert.match(printed, /weekly 17% used, resets 2026-11-11T11:00Z/);
  assert.equal(printed.includes(KEY), false);
  const real = setup(t);
  await runUsage(args("name=home:test"), real.io);
  const body = posted(real.calls, "zai");
  assert.deepEqual(names(body), ["5-hour", "weekly"]);
  assert.equal(body.windows[0].usedPercent, 42);
  assert.equal(JSON.stringify(real.calls).includes(KEY), false);
});

test("zai sends the key as a header and a refusal or HTTP error gives no windows and a note", async (t) => {
  const seen = [];
  const sent = setup(t, { io: { zaiFetch: async (url, init) => { seen.push([url, init.headers]); return answer(ZAI_OK)(); } } });
  await runUsage(args("dry-run"), sent.io);
  assert.match(seen[0][0], /^https:\/\/api\.z\.ai\//);
  assert.equal(JSON.stringify(seen[0][1]).includes(KEY), true);
  for (const fetch of [answer({ code: 1001, success: false, msg: "bad token" }), answer({}, 500), async () => { throw new Error(`connect failed with ${KEY}`); }]) {
    const { io, calls } = setup(t, { io: { zaiFetch: fetch } });
    await runUsage(args("name=home:test"), io);
    const body = posted(calls, "zai");
    assert.deepEqual(body.windows, []);
    assert.match(body.notes.join(" "), /zai/);
    assert.equal(JSON.stringify(calls).includes(KEY), false);
  }
});

// ── criteria 2 and 7: Claude's capture file ────────────────────────────────

test("claude-code reads the four-field file for both windows, at the file's mtime", async (t) => {
  const { io, calls, paths } = setup(t);
  touchAt(paths.claudeUsage, "37 62 2026-11-08T14:00:00.000Z 2026-11-12T09:00:00.000Z\n", hoursAgo(2));
  await runUsage(args("name=home:test"), io);
  const body = posted(calls, "claude-code");
  assert.deepEqual(body.windows.map((w) => [w.name, w.usedPercent, w.resetsAt, w.at]), [
    ["5-hour", 37, "2026-11-08T14:00:00.000Z", new Date(hoursAgo(2)).toISOString()],
    ["weekly", 62, "2026-11-12T09:00:00.000Z", new Date(hoursAgo(2)).toISOString()],
  ]);
});

test("claude-code with a file over 26 hours old, missing or unparseable has no windows and says usage unknown", async (t) => {
  for (const make of [
    (p) => touchAt(p, "37 62 2026-11-08T14:00:00.000Z 2026-11-12T09:00:00.000Z", hoursAgo(26.5)),
    () => {},
    (p) => touchAt(p, "about a third, I think", hoursAgo(1)),
    (p) => touchAt(p, "137 62 2026-11-08T14:00:00.000Z 2026-11-12T09:00:00.000Z", hoursAgo(1)),
  ]) {
    const { io, calls, paths } = setup(t);
    make(paths.claudeUsage);
    await runUsage(args("name=home:test"), io);
    const body = posted(calls, "claude-code");
    assert.deepEqual(body.windows, []);
    assert.match(body.notes.join(" "), /usage unknown/);
  }
});

test("a dash for the 5-hour fields leaves only the weekly window, not usage unknown", async (t) => {
  const { io, calls, paths } = setup(t);
  touchAt(paths.claudeUsage, "- 62 - 2026-11-12T09:00:00.000Z", hoursAgo(1));
  await runUsage(args("name=home:test"), io);
  const body = posted(calls, "claude-code");
  assert.deepEqual(names(body), ["weekly"]);
  assert.doesNotMatch(body.notes.join(" "), /usage unknown/);
});

// ── criterion 3: Antigravity ───────────────────────────────────────────────

const agyLine = (at) => `${new Date(at).toISOString()} ERROR code=429 RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Resets in 4h26m8s.`;

test("antigravity posts a limit window at 100% from a recent RESOURCE_EXHAUSTED line", async (t) => {
  const { io, calls, paths } = setup(t);
  writeFileSync(paths.antigravityLog, ["INFO started", agyLine(hoursAgo(1)), "INFO done"].join("\n") + "\n");
  await runUsage(args("name=home:test"), io);
  const body = posted(calls, "antigravity");
  const reset = new Date(hoursAgo(1) + (4 * 3600 + 26 * 60 + 8) * 1000).toISOString();
  assert.deepEqual(body.windows.map((w) => [w.name, w.usedPercent, w.resetsAt]), [["limit", 100, reset]]);
});

test("antigravity with a 30 hour old line, or none, has no window and says usage unknown", async (t) => {
  for (const text of [agyLine(hoursAgo(30)) + "\n", "INFO nothing wrong here\n", null]) {
    const { io, calls, paths } = setup(t);
    if (text !== null) writeFileSync(paths.antigravityLog, text);
    await runUsage(args("name=home:test"), io);
    const body = posted(calls, "antigravity");
    assert.deepEqual(body.windows, []);
    assert.match(body.notes.join(" "), /usage unknown/);
  }
});

// ── criterion 4: a reader that throws or hangs ─────────────────────────────

test("a reader that throws or hangs posts its tool with a note naming it, and the others still post", async (t) => {
  const dir = tempDir(t);
  // A log path that is a directory makes the antigravity reader throw.
  const log = join(dir, "log-as-dir");
  mkdirSync(log);
  const timers = [];
  let clock = 0;
  const sleep = (ms) => new Promise((resolve) => timers.push({ due: clock + ms, resolve }));
  const { io, calls, paths } = setup(t, { paths: { antigravityLog: log }, io: { zaiFetch: () => new Promise(() => {}), sleep } });
  touchAt(paths.claudeUsage, "37 62 2026-11-08T14:00:00.000Z 2026-11-12T09:00:00.000Z", hoursAgo(1));
  const run = runUsage(args("name=home:test"), io);
  let finished = false;
  run.finally(() => { finished = true; });
  // The fake clock moves to the next timer only once the real work has settled.
  while (!finished) {
    await new Promise((r) => setTimeout(r, 30));
    if (finished) break;
    if (timers.length) {
      timers.sort((a, b) => a.due - b.due);
      const next = timers.shift();
      clock = next.due;
      next.resolve();
    }
  }
  await run;
  assert.ok(clock <= 60_000, `the run took ${clock} ms of fake time`);
  assert.ok(clock >= 20_000);
  const zai = posted(calls, "zai");
  assert.deepEqual(zai.windows, []);
  assert.match(zai.notes.join(" "), /zai reader.*(timed out|20 s)/);
  const agy = posted(calls, "antigravity");
  assert.deepEqual(agy.windows, []);
  assert.match(agy.notes.join(" "), /antigravity reader/);
  assert.deepEqual(names(posted(calls, "claude-code")), ["5-hour", "weekly"]);
});

// ── criterion 5: the proposal ──────────────────────────────────────────────

async function stubServer(t, status) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    req.resume();
    res.writeHead(status, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

// The proposal goes through the CLI, the way the 6 AM job runs it: the server
// and credential are the ones the reports use. Each case runs the real CLI
// against a stub server, with a config directory and home of its own.
const run = promisify(execFile);
const STORED = "atl_stored0123456789abcdef0123456789ab";
const FROM_ENV = "atl_env000000000000000000000000000000";

async function cli(t, { server, saved, stored, env = {}, flags = [] }) {
  const root = tempDir(t);
  const config = join(root, "config");
  mkdirSync(config);
  mkdirSync(join(root, "home"));
  if (saved) writeFileSync(join(config, "config.json"), JSON.stringify({ server }));
  if (stored) writeFileSync(join(config, "secrets.json"), JSON.stringify({ API_TOKEN: STORED }), { mode: 0o600 });
  const full = { PATH: process.env.PATH, HOME: join(root, "home"), ATELIER_CONFIG_DIR: config, ATELIER_SECRET_STORE: "file", ATELIER_ACTING: "claude-code/sonnet-5.5", NO_COLOR: "1", ...env };
  const file = new URL("../cli/atelier.mjs", import.meta.url).pathname;
  try {
    const out = await run(process.execPath, [file, "runner", "--usage", "--name", "home:test", ...flags], { env: full, cwd: root, timeout: 60_000 });
    return { code: 0, ...out };
  } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
const proposals = (stub) => stub.requests.filter((r) => r.url === "/api/model-slate/propose");

for (const [name, mode] of [
  ["the server and token from saved config only", { saved: true, stored: true, token: STORED }],
  ["ATELIER_SERVER set with the token stored locally", { saved: true, stored: true, viaEnv: true, token: STORED }],
  ["the environment only", { env: true, token: FROM_ENV }],
]) {
  test(`the CLI asks for one slate proposal after its reports: ${name}`, async (t) => {
    const stub = await stubServer(t, 200);
    const env = mode.env ? { ATELIER_SERVER: stub.url, ATELIER_TOKEN: FROM_ENV } : mode.viaEnv ? { ATELIER_SERVER: stub.url } : {};
    const result = await cli(t, { server: stub.url, saved: mode.saved, stored: mode.stored, env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(proposals(stub).length, 1);
    assert.equal(proposals(stub)[0].method, "POST");
    assert.equal(proposals(stub)[0].auth, `Bearer ${mode.token}`);
    assert.equal(stub.requests.at(-1).url, "/api/model-slate/propose", "after the reports");
    assert.ok(stub.requests.some((r) => r.url.startsWith("/api/usage/")), "the reports went to the same server");
  });
}

test("a dry run does not ask for a proposal", async (t) => {
  const stub = await stubServer(t, 200);
  const result = await cli(t, { server: stub.url, saved: true, stored: true, flags: ["--dry-run"] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(stub.requests.filter((r) => r.method !== "GET"), [], "reads only");
});

test("an unreachable server or a non-2xx answer fails naming the server, writes no file, and a rerun sends everything again", async (t) => {
  const down = await stubServer(t, 200);
  const closed = down.url.replace(/:\d+$/, ":1");
  const refusing = await stubServer(t, 500);
  for (const [url, why] of [[closed, "unreachable"], [refusing.url, "500"]]) {
    const first = await cli(t, { server: url, saved: true, stored: true });
    assert.equal(first.code, 1, why);
    assert.ok(first.stderr.includes(url), `${why}: ${first.stderr}`);
  }
  // The server answers every request 500: reports fail first, and the rerun posts them again.
  const sent = refusing.requests.length;
  const again = await cli(t, { server: refusing.url, saved: true, stored: true });
  assert.equal(again.code, 1);
  assert.equal(refusing.requests.length, sent * 2);
});

// ── criteria 6 and 7: the capture ──────────────────────────────────────────

test("--claude-capture writes the file through a temp file and a rename, and the file reads back", async (t) => {
  const { io, calls, dir, paths } = setup(t);
  const renames = [];
  io.rename = (from, to) => { renames.push([from, to]); assert.equal(existsSync(from), true); renameSync(from, to); };
  await runUsage(args("claude-capture=37 62 2026-11-08T14:00:00Z 2026-11-12T09:00:00Z"), io);
  assert.equal(renames.length, 1);
  assert.notEqual(renames[0][0], paths.claudeUsage);
  assert.equal(renames[0][1], paths.claudeUsage);
  assert.deepEqual(readdirSync(dir), ["claude-usage.txt"]);
  assert.equal(calls.report.length, 0);
  const next = setup(t);
  next.io.paths.claudeUsage = paths.claudeUsage;
  utimesSync(paths.claudeUsage, hoursAgo(0.1) / 1000, hoursAgo(0.1) / 1000);
  await runUsage(args("name=home:test"), next.io);
  assert.deepEqual(names(posted(next.calls, "claude-code")), ["5-hour", "weekly"]);
});

test("--claude-capture refuses bad numbers, exits with an error and keeps the old file", async (t) => {
  const bad = ["101 62 2026-11-08T14:00:00Z 2026-11-12T09:00:00Z", "37 -5 2026-11-08T14:00:00Z 2026-11-12T09:00:00Z", "abc 62 2026-11-08T14:00:00Z 2026-11-12T09:00:00Z",
    "37 62 soon 2026-11-12T09:00:00Z", "37 62 2026-11-08T14:00:00Z", "37 - 2026-11-08T14:00:00Z -", "- 62 2026-11-08T14:00:00Z 2026-11-12T09:00:00Z", "37 62 - 2026-11-12T09:00:00Z"];
  for (const text of bad) {
    const { io, dir, paths } = setup(t);
    writeFileSync(paths.claudeUsage, "OLD\n");
    await assert.rejects(runUsage(args(`claude-capture=${text}`), io), /claude-capture/, text);
    assert.equal(readFileSync(paths.claudeUsage, "utf8"), "OLD\n");
    assert.deepEqual(readdirSync(dir), ["claude-usage.txt"]);
  }
});

test("--claude-capture accepts a dash for the 5-hour fields and the file yields the weekly window alone", async (t) => {
  const { io, calls, paths } = setup(t);
  await runUsage(args("claude-capture=- 62 - 2026-11-12T09:00:00Z"), io);
  utimesSync(paths.claudeUsage, hoursAgo(0.1) / 1000, hoursAgo(0.1) / 1000);
  const next = setup(t);
  next.io.paths.claudeUsage = paths.claudeUsage;
  await runUsage(args("name=home:test"), next.io);
  const body = posted(next.calls, "claude-code");
  assert.deepEqual(names(body), ["weekly"]);
  assert.doesNotMatch(body.notes.join(" "), /usage unknown/);
  assert.equal(calls.report.length, 0);
});

// ── criterion 6: the documentation ─────────────────────────────────────────

test("docs/usage-agent.md gives the Studio plist at 6:00, 6:20 and 6:40 and the MacBook's 6:00 run", () => {
  const text = readFileSync(new URL("../docs/usage-agent.md", import.meta.url), "utf8");
  assert.match(text, /<key>StartCalendarInterval<\/key>/);
  for (const minute of [0, 20, 40]) assert.match(text, new RegExp(`<key>Hour</key>\\s*<integer>6</integer>\\s*<key>Minute</key>\\s*<integer>${minute}</integer>`));
  assert.match(text, /MacBook[^\n]*6:00/);
  assert.match(text, /--claude-capture/);
});
