import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { opencodeMajor } from "../cli/harness/adapter.mjs";
import { OPENCODE2_CONFIG_CONTENT, PERMISSIONS, opencodeConfig } from "../cli/harness/providers.mjs";
import { detectLimit, runWithLimits } from "../bin/harness/limit.mjs";
import { parseVerdict } from "../src/review/verdict.ts";

// t683: running opencode 2 (2.0.29, measured 2026-10-15). The fixtures in
// test/fixtures/opencode2 are `opencode run --standalone --format json`
// output recorded from that release, through a glm-5.3 config, in a temporary
// folder with its own XDG folders:
//   trivial.jsonl                  the prompt "reply with exactly: pong"
//   continue.jsonl                 the same session, --continue
//   external-directory-denied.jsonl  a read of /etc/hosts under a deny rule
//   provider-auth-error.jsonl      a provider's 401
// ATELIER_OPENCODE2 names an opencode 2 executable for the live tests below;
// without it they are skipped.

const repo = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name) => readFileSync(join(repo, "test", "fixtures", "opencode2", name), "utf8");
const opencode2 = process.env.ATELIER_OPENCODE2;
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((p) => existsSync(p));

function temp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the major version is read from either release's --version, asked once per executable", () => {
  let asked = 0;
  const says = (text, status = 0) => () => { asked += 1; return { status, stdout: text }; };
  assert.equal(opencodeMajor("/x/oc-v2", {}, says("opencode v2.0.29\n")), 2);
  assert.equal(opencodeMajor("/x/oc-v2", {}, () => assert.fail("asked again")), 2, "kept");
  assert.equal(asked, 1);
  assert.equal(opencodeMajor("/x/oc-v1", {}, says("1.18.34\n")), 1);
  assert.equal(opencodeMajor("/x/oc-none", {}, says("", 1)), null);
  assert.equal(opencodeMajor("/x/oc-junk", {}, says("no version here")), null);
  assert.equal(opencodeMajor("/x/oc-missing", {}, () => ({ error: new Error("ENOENT") })), null);
});

const MODELS = [{ providerModel: "m", atelierId: "m", limit: { context: 128000, output: 8000 } }];

// The finding on t683 (reviewer astra): opencode 1.18.34's config loader throws
// on the V2 "permissions" key ("V2 permissions are not supported by OpenCode
// V1"), which was written unconditionally.
test("a generated opencode config carries the V2 permissions only for opencode 2, and opencode 1's deny always", () => {
  for (const major of [undefined, null, 1]) {
    const config = opencodeConfig("deepseek-api", MODELS, { gateway: { account: "a", id: "atelier" }, major });
    assert.equal(config.permission.external_directory, "deny", `V1 deny, major ${major}`);
    assert.equal("permissions" in config, false, `no V2 key for major ${major}`);
  }
  const two = opencodeConfig("deepseek-api", MODELS, { gateway: { account: "a", id: "atelier" }, major: 2 });
  assert.equal(two.permission.external_directory, "deny");
  assert.deepEqual(two.permissions.filter((r) => r.action === "external_directory"), [{ action: "external_directory", resource: "*", effect: "deny" }]);
  assert.equal(two.permissions, PERMISSIONS);
  for (const rule of two.permissions) assert.deepEqual(Object.keys(rule).sort(), ["action", "effect", "resource"]);
  assert.deepEqual(JSON.parse(OPENCODE2_CONFIG_CONTENT), { permissions: PERMISSIONS });
});

// Runs the real adapter, limit handling included, against a spawn that
// answers as the recorded opencode 2 did.
function adapterRun(t, { version, replies, exe, review = true, stored }) {
  const dir = temp(t, "atelier-oc2-");
  const ws = join(dir, "ws"), providers = join(dir, "providers"), verdict = join(dir, "verdict.md");
  mkdirSync(ws); mkdirSync(providers);
  writeFileSync(join(providers, "deepseek-api.json"), JSON.stringify(stored ?? opencodeConfig("deepseek-api", MODELS, { gateway: { account: "a", id: "atelier" } })));
  writeFileSync(join(providers, "models.json"), JSON.stringify({ models: { m: { provider: "deepseek-api", providerModel: "m", config: "deepseek-api.json", key: "k", keyVar: "DEEPSEEK_API_KEY", gateway: true } } }));
  const brief = join(dir, "brief.md"), diff = join(dir, "diff.txt");
  writeFileSync(brief, "Task: t9\nReview it.\n");
  writeFileSync(diff, "diff --git a/x b/x\n+x\n");
  const calls = [], versions = [];
  const fake = (exe, argv, options) => {
    if (argv[0] === "--version") { versions.push(argv); return { status: 0, stdout: version }; }
    calls.push({ argv, env: options.env, input: options.input });
    return { status: 0, stdout: replies[calls.length - 1], stderr: "" };
  };
  const errors = [];
  const status = runWithLimits("opencode", ["--providers", providers, "m", brief, ws, "undefined", review ? diff : "undefined", review ? verdict : "undefined"],
    { env: { PATH: process.env.PATH, HOME: dir, ATELIER_OPENCODE: exe }, secret: () => "dummy", spawn: fake, stderr: (x) => errors.push(x), stdout: () => {} });
  return { status, calls, versions, errors, verdict };
}

test("on opencode 2 the adapter passes --standalone to the review and to its continued session, and reads the recorded JSON", (t) => {
  // The first reply, recorded, states no verdict; the second, recorded with
  // --continue, ends in one.
  const { status, calls, versions, verdict } = adapterRun(t, { exe: "/x/oc-run-v2", version: "opencode v2.0.29\n", replies: [fixture("trivial.jsonl"), fixture("continue.jsonl")] });
  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].argv, ["run", "--standalone", "--model", "deepseek-api/m", "--format", "json"]);
  assert.deepEqual(calls[1].argv, ["run", "--standalone", "--model", "deepseek-api/m", "--continue", "--format", "json"]);
  assert.equal(versions.length, 1, "the version is asked once for the whole job");
  const kept = readFileSync(verdict, "utf8");
  assert.equal(kept, "pong\n\npong\nVERDICT: APPROVE\n", "both replies, text parts read from the recorded events");
  assert.equal(parseVerdict(kept).verdict, "approve");
  assert.match(calls[0].env.XDG_DATA_HOME, /atelier-opencode-run-.*\/data$/, "and the run still has a data folder of its own");
});

test("on opencode 1 the adapter's arguments are unchanged: no --standalone", (t) => {
  const { status, calls } = adapterRun(t, { exe: "/x/oc-run-v1", version: "1.18.34\n", replies: [fixture("trivial.jsonl"), fixture("continue.jsonl")] });
  assert.equal(status, 0);
  assert.deepEqual(calls.map((c) => c.argv), [
    ["run", "--model", "deepseek-api/m", "--format", "json"],
    ["run", "--model", "deepseek-api/m", "--continue", "--format", "json"],
  ]);
});

// The finding on t683: a failed or unparseable version probe was treated as
// opencode 1 and launched without --standalone or the deny. A run refused
// cannot leak, and a guess either way breaks (opencode 1 rejects both).
test("a version it cannot read refuses the run: nothing is launched", (t) => {
  for (const version of ["", "no version here"]) {
    const { status, calls, errors } = adapterRun(t, { exe: `/x/oc-run-none-${version.length}`, version, replies: [] });
    assert.equal(status, 1);
    assert.equal(calls.length, 0, "opencode was never run");
    assert.match(errors.join(""), /could not read the version of .*no run was started/);
  }
});

// The finding on t683: the V2 rule was written at setup only, so an
// installation set up before it kept a config without it.
test("on opencode 2 the deny is injected at every run, over a stored config that lacks it; on opencode 1 nothing is injected", (t) => {
  const old = opencodeConfig("deepseek-api", MODELS, { gateway: { account: "a", id: "atelier" } });
  assert.equal("permissions" in old, false);
  const reply = JSON.stringify({ type: "text", part: { text: "VERDICT: APPROVE" } });
  const two = adapterRun(t, { exe: "/x/oc-inject-v2", version: "opencode v2.0.29\n", replies: [reply], stored: old });
  assert.equal(two.status, 0);
  assert.deepEqual(JSON.parse(two.calls[0].env.OPENCODE_CONFIG_CONTENT), { permissions: PERMISSIONS });
  const one = adapterRun(t, { exe: "/x/oc-inject-v1", version: "1.18.34\n", replies: [reply], stored: old });
  assert.equal(one.status, 0);
  assert.equal(one.calls[0].env.OPENCODE_CONFIG_CONTENT, undefined);
});

test("opencode 2's provider error is read: an auth failure is no limit, a 429 is", () => {
  const run = (stdout) => ({ status: 1, stdout, stderr: "" });
  assert.equal(detectLimit(run(fixture("provider-auth-error.jsonl")), { harness: "opencode" }), null);
  // The shape of the recorded error, with the status a rate limit has.
  const recorded = JSON.parse(fixture("provider-auth-error.jsonl").trim().split("\n").at(-1));
  const limited = { ...recorded, error: { type: "provider.rate_limit", message: "usage limit reached", status: 429, response: { body: '{"error":{"message":"Rate limit reached, resets_in_seconds: 90"}}' } } };
  const found = detectLimit(run(JSON.stringify(limited)), { harness: "opencode", now: Date.UTC(2026, 9, 15) });
  assert.ok(found, "a provider.* error carrying a limit is a limit");
  assert.equal(found.resetAt, new Date(Date.UTC(2026, 9, 15) + 90_000).toISOString());
  // opencode 1's shape still counts.
  assert.ok(detectLimit(run(JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "rate limit exceeded", statusCode: 429 } } })), { harness: "opencode" }));
});

test("run-agent.sh passes --standalone and a deny rule on opencode 2 and neither on opencode 1", { skip: !zsh && "zsh is not installed" }, (t) => {
  const dir = temp(t, "atelier-run-agent-v-");
  const wrappers = join(dir, "wrappers"), ws = join(dir, "ws"), record = join(dir, "record.json");
  mkdirSync(wrappers); mkdirSync(ws);
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: ws });
  writeFileSync(join(wrappers, "opencode-glm"), `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") { process.stdout.write(process.env.FAKE_VERSION + "\\n"); process.exit(0); }
fs.readFileSync(0);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), content: process.env.OPENCODE_CONFIG_CONTENT ?? null, data: process.env.XDG_DATA_HOME }));
`);
  chmodSync(join(wrappers, "opencode-glm"), 0o755);
  const go = (FAKE_VERSION) => {
    rmSync(record, { force: true });
    const r = spawnSync(zsh, [join(repo, "bin", "orchestrate", "run-agent.sh"), "glm", ws, join(dir, "out.txt"), "A short prompt."], { encoding: "utf8", env: { ...process.env, OPENCODE_WRAPPER_DIR: wrappers, FAKE_VERSION } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(record, "utf8"));
  };
  const two = go("opencode v2.0.29");
  assert.deepEqual(two.argv, ["run", "--standalone", "--model", "zai-coding/glm-5.3"]);
  assert.deepEqual(JSON.parse(two.content), { permissions: PERMISSIONS });
  assert.equal(realpathSync(two.data), join(realpathSync(ws), ".scratch", "xdg-data"), "and its data folder is its own");
  const one = go("1.18.34");
  assert.deepEqual(one.argv, ["run", "--model", "zai-coding/glm-5.3"]);
  assert.equal(one.content, null);
});

test("run-agent.sh refuses to start when the version cannot be read", { skip: !zsh && "zsh is not installed" }, (t) => {
  const dir = temp(t, "atelier-run-agent-n-");
  const wrappers = join(dir, "wrappers"), ws = join(dir, "ws"), ran = join(dir, "ran");
  mkdirSync(wrappers); mkdirSync(ws);
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: ws });
  writeFileSync(join(wrappers, "opencode-glm"), `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") { process.stdout.write(process.env.FAKE_VERSION + "\\n"); process.exit(Number(process.env.FAKE_STATUS ?? 0)); }
fs.writeFileSync(${JSON.stringify(ran)}, "ran");
`);
  chmodSync(join(wrappers, "opencode-glm"), 0o755);
  for (const fake of [{ FAKE_VERSION: "no version here" }, { FAKE_VERSION: "2.0.29", FAKE_STATUS: "1" }]) {
    const r = spawnSync(zsh, [join(repo, "bin", "orchestrate", "run-agent.sh"), "glm", ws, join(dir, "out.txt"), "A short prompt."], { encoding: "utf8", env: { ...process.env, OPENCODE_WRAPPER_DIR: wrappers, ...fake } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /could not read the version of .*no run was started/);
    assert.equal(existsSync(ran), false, "the wrapper was never run");
  }
});

// ── opencode 2 itself ───────────────────────────────────────────────────────

// A stand-in for a model provider (OpenAI chat completions, streamed): to a
// request that offers tools and has no tool result yet it answers with a call
// of the read tool on /etc/hosts; to any other, with text.
function modelServer() {
  const requests = [];
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* not JSON */ }
      requests.push(parsed);
      const wantsRead = Array.isArray(parsed.tools) && parsed.tools.length && !(parsed.messages ?? []).some((m) => m.role === "tool");
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (wantsRead) {
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "/etc/hosts" }) } }] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: "done" }));
        res.write(chunk({}, "stop"));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

// Runs opencode 2 on one prompt against the stand-in model, in folders of its
// own, with `config` as its only config; returns the parsed JSON events.
async function liveRun(t, config, extraEnv = {}) {
  const dir = temp(t, "atelier-oc2-live-");
  const { server, port } = await modelServer();
  t.after(() => server.close());
  const ws = join(dir, "ws");
  mkdirSync(ws);
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: ws });
  const home = join(dir, "home");
  const env = { PATH: process.env.PATH, HOME: home, AI_STUDIO_API_KEY: "dummy", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", ...extraEnv };
  for (const [name, sub] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) { env[name] = join(dir, sub); mkdirSync(env[name], { recursive: true }); }
  mkdirSync(home);
  const file = join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify(config(`http://127.0.0.1:${port}/v1`)));
  env.OPENCODE_CONFIG = file;
  const child = spawn(opencode2, ["run", "--standalone", "--format", "json", "--model", "ai-studio/fake"], { cwd: ws, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.stdin.end("Read /etc/hosts with the read tool.\n");
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  const events = out.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return { code, events, out, err };
}

const generated = (baseURL) => opencodeConfig("ai-studio", [{ providerModel: "fake", atelierId: "fake", limit: { context: 128000, output: 8000 } }], { baseURL, major: 2 });
const reads = (events) => events.filter((e) => e.type === "tool_use" && e.part?.tool === "read");

test("opencode 2 refuses a read outside the workspace under the generated config", { skip: !opencode2 && "ATELIER_OPENCODE2 names no opencode 2 executable" }, async (t) => {
  const { code, events, out, err } = await liveRun(t, generated);
  const read = reads(events);
  assert.equal(read.length, 1, `the model's read call ran: ${out.slice(0, 600)} ${err.slice(0, 600)}`);
  assert.equal(read[0].part.state.status, "error");
  assert.match(read[0].part.state.error, /Permission denied: external_directory/);
  assert.equal(code, 0);
});

test("opencode 2 reads outside the workspace when nothing denies it (the control that makes the test above mean something)", { skip: !opencode2 && "ATELIER_OPENCODE2 names no opencode 2 executable" }, async (t) => {
  const { events, out } = await liveRun(t, (baseURL) => {
    const { permission, permissions, ...bare } = generated(baseURL);
    return bare;
  });
  const read = reads(events);
  assert.equal(read.length, 1, out.slice(0, 600));
  assert.equal(read[0].part.state.status, "completed", "without a rule opencode run approves the read");
});

// The finding on t683: an installation set up before the V2 rule keeps a
// config without it. OPENCODE_CONFIG_CONTENT must merge over OPENCODE_CONFIG on
// opencode 2 itself for the run-time injection to fence it.
test("opencode 2 refuses the read under an old stored config (no V2 rule) when the deny arrives in OPENCODE_CONFIG_CONTENT", { skip: !opencode2 && "ATELIER_OPENCODE2 names no opencode 2 executable" }, async (t) => {
  const old = (baseURL) => {
    const { permissions, ...rest } = generated(baseURL);
    return rest;
  };
  const { events, out, err } = await liveRun(t, old, { OPENCODE_CONFIG_CONTENT: OPENCODE2_CONFIG_CONTENT });
  const read = reads(events);
  assert.equal(read.length, 1, `${out.slice(0, 600)} ${err.slice(0, 600)}`);
  assert.equal(read[0].part.state.status, "error");
  assert.match(read[0].part.state.error, /Permission denied: external_directory/);
});
