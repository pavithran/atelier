import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { LIMIT_MARKER, PROVIDER_LIMIT_EXIT, detectLimit, limitSpawn, parseReset, runWithLimits } from "../bin/harness/limit.mjs";

// t487: the shipped adapters turn a provider's usage limit, read from the
// harness's captured output, into a structured result (exit 75 and a marker
// line on standard error) the runner pauses the harness on. Everything here
// is a fixture of provider text: no provider is called, no quota is spent.

// A fake clock: Saturday 2026-10-10 12:00 UTC, which is 08:00 in New York
// (EDT, UTC-4) and 14:00 in Paris (CEST, UTC+2).
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const NY = "America/New_York";
const at = (iso) => new Date(iso).toISOString();
const plus = (ms) => new Date(NOW + ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;

test("parseReset reads an epoch, an explicit offset and a relative duration", () => {
  const p = (text, timeZone = NY) => { const r = parseReset(text, { now: NOW, timeZone }); return r === null ? null : new Date(r).toISOString(); };
  assert.equal(p("Claude AI usage limit reached|1791644400"), at(1791644400 * 1000));
  assert.equal(p('{"resets_at": 1791644400}'), at(1791644400 * 1000));
  assert.equal(p("usage limit reached. Resets at 2026-10-12T09:30:00+02:00"), at("2026-10-12T07:30:00Z"));
  assert.equal(p("limit reached, try again at 2026-10-12T09:30:00Z"), at("2026-10-12T09:30:00Z"));
  assert.equal(p("limit reached, resets 2026-10-12T09:30:00-0530"), at("2026-10-12T15:00:00Z"));
  assert.equal(p("try again in 2 hours 13 minutes."), plus(2 * HOUR + 13 * MIN));
  assert.equal(p("Your quota will reset after 3h12m5s."), plus(3 * HOUR + 12 * MIN + 5000));
  assert.equal(p("Please retry in 34.2s"), plus(34_200));
  assert.equal(p("resets in 1 day, 2 hours and 5 minutes"), plus(26 * HOUR + 5 * MIN));
  assert.equal(p("Retry-After: 120"), plus(2 * MIN));
  assert.equal(p('"resets_in_seconds": 5400'), plus(90 * MIN));
  // "5-hour" names the window, not a wait.
  assert.equal(p("5-hour limit reached"), null);
});

test("parseReset reads an unzoned time in the runner's zone and a time alone as its next occurrence", () => {
  const p = (text, timeZone) => { const r = parseReset(text, { now: NOW, timeZone }); return r === null ? null : new Date(r).toISOString(); };
  // Dated, no zone: the runner's.
  assert.equal(p("try again at Oct 14th, 2026 3:05 PM.", NY), at("2026-10-14T19:05:00Z"));
  assert.equal(p("try again at Oct 14th, 2026 3:05 PM.", "Asia/Tokyo"), at("2026-10-14T06:05:00Z"));
  assert.equal(p("resets 2026-10-14 15:05", "Europe/Paris"), at("2026-10-14T13:05:00Z"));
  // No year: this year. Winter time on the far side of a DST change.
  assert.equal(p("resets Nov 20 at 9am", NY), at("2026-11-20T14:00:00Z"));
  // A zone in the message wins over the runner's.
  assert.equal(p("resets Oct 14, 2026 at 3pm (Europe/Paris)", NY), at("2026-10-14T13:00:00Z"));
  // A time alone: today's if still to come, else tomorrow's.
  assert.equal(p("5-hour limit reached ∙ resets 3pm", NY), at("2026-10-10T19:00:00Z"));
  assert.equal(p("resets 7am", NY), at("2026-10-11T11:00:00Z"));
  assert.equal(p("resets at 15:30", "UTC"), at("2026-10-10T15:30:00Z"));
  assert.equal(p("resets 11:59 AM", "UTC"), at("2026-10-11T11:59:00Z"));
  assert.equal(p("will reset at 3pm (UTC)", NY), at("2026-10-10T15:00:00Z"));
  // Across the zone's own midnight: it is already Oct 11 in Tokyo (21:00).
  assert.equal(p("resets 10am", "Asia/Tokyo"), at("2026-10-11T01:00:00Z"));
});

test("parseReset gives null for a missing, invalid or past reset, which the runner gives the 60-minute fallback", () => {
  const p = (text, timeZone = NY) => parseReset(text, { now: NOW, timeZone });
  for (const text of [
    "usage limit reached", "", "resets soon", "resets 2026-13-10T15:00:00Z", "resets 2026-10-14T15:00:00+25:00", "resets 2026-10-14T15:00:00+02:99", "resets Feb 31 at 3pm", "resets Oct 14, 2026 at 25:00", "resets Oct 14 at 13pm",
    "resets 2026-13-40 10:00", "resets Oct 14, 2026", // a date with no time
    "resets Oct 1, 2026 3pm", "resets at 2026-10-01T00:00:00Z", "Claude AI usage limit reached|1700000000", "resets in 0 seconds",
    "resets Oct 14, 2026 at 3pm (Not/AZone)",
  ]) assert.equal(p(text), null, text);
});

// ── what each adapter reads as a limit ──────────────────────────────────────

const claudeStderr = "5-hour limit reached ∙ resets 3pm\n";
// [harness, name, run, expected resetAt (null: a limit with no reset) or "none" (not a limit)]
const FIXTURES = [
  // claude-code
  ["claude-code", "stdout, exit 1, epoch", { status: 1, stdout: JSON.stringify({ error: { message: "Claude AI usage limit reached|1791644400\n" } }) }, at(1791644400 * 1000)],
  ["claude-code", "stdout, exit 0, one message", { status: 0, stdout: JSON.stringify({ error: { message: "Claude usage limit reached. Your limit will reset at 3pm (UTC).\n" } }) }, at("2026-10-10T15:00:00Z")],
  ["claude-code", "stderr, exit 1, time alone", { status: 1, stdout: "", stderr: claudeStderr }, at("2026-10-10T19:00:00Z")],
  ["claude-code", "stderr, exit 1, zone named", { status: 1, stderr: "You've hit your limit · resets 3pm (Europe/Paris)\n" }, at("2026-10-10T13:00:00Z")],
  ["claude-code", "stdout, exit 0, weekly, dated", { status: 0, stdout: JSON.stringify({ error: { message: "Weekly limit reached ∙ resets Oct 14 at 9am\n" } }) }, at("2026-10-14T13:00:00Z")],
  ["claude-code", "stderr, exit 1, no reset", { status: 1, stderr: "Claude usage limit reached.\n" }, null],
  ["claude-code", "stderr after a long build's output", { status: 1, stdout: "I changed 12 files.\n".repeat(200), stderr: `warn: slow\n${claudeStderr}` }, at("2026-10-10T19:00:00Z")],
  // codex
  ["codex", "stderr, exit 1, relative", { status: 1, stderr: "ERROR: You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 13 minutes.\n" }, plus(2 * HOUR + 13 * MIN)],
  ["codex", "stdout, exit 1, dated", { status: 1, stdout: JSON.stringify({ error: { message: "You've hit your usage limit. Try again at Oct 14th, 2026 3:05 PM.\n" } }) }, at("2026-10-14T19:05:00Z")],
  ["codex", "stderr json, exit 1, resets_in_seconds", { status: 1, stderr: '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":5400}}\n' }, plus(90 * MIN)],
  ["codex", "stdout json, exit 0", { status: 0, stdout: '{"error":{"type":"usage_limit_reached","resets_at":1791644400}}\n' }, at(1791644400 * 1000)],
  ["codex", "stderr, exit 1, no reset", { status: 1, stderr: "stream error: usage limit reached\n" }, null],
  // opencode
  ["opencode", "stderr, exit 1, 429 with Retry-After", { status: 1, stderr: "Error: 429 Too Many Requests\nRetry-After: 120\n" }, plus(2 * MIN)],
  ["opencode", "stderr, exit 1, rate limit with a time", { status: 1, stderr: "Error: rate limit exceeded. Limit resets at 2026-10-12T09:30:00+02:00\n" }, at("2026-10-12T07:30:00Z")],
  ["opencode", "stdout, exit 1, quota", { status: 1, stdout: JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.\n" } }) }, null],
  ["opencode", "stderr, exit 1, insufficient_quota json", { status: 1, stderr: '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}\n' }, null],
  ["opencode", "stdout, exit 0, one message", { status: 0, stdout: JSON.stringify({ error: { message: "Error: rate limit exceeded, retry after 30s\n" } }) }, plus(30_000)],
  // antigravity
  ["antigravity", "stdout json, exit 1", { status: 1, stdout: '{"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 3h12m5s.","status":"RESOURCE_EXHAUSTED"}}' }, plus(3 * HOUR + 12 * MIN + 5000)],
  ["antigravity", "stdout json error, exit 0", { status: 0, stdout: '{"error":{"message":"Quota exceeded for this model. Please retry in 34.2s"}}' }, plus(34_200)],
  ["antigravity", "stderr, exit 1", { status: 1, stderr: "RESOURCE_EXHAUSTED: quota exceeded\n" }, null],
  ["antigravity", "stderr, exit 1, retryDelay", { status: 1, stderr: 'Error 429: RESOURCE_EXHAUSTED {"retryDelay": "34s"}\n' }, plus(34_000)],

  // Not limits, whichever harness: the text quoted in an answer.
  ...["claude-code", "codex", "opencode", "antigravity"].flatMap((harness) => [
    [harness, "a long answer quoting limit text, exit 0", { status: 0, stdout: `${"I read the handler.\n".repeat(50)}It prints "usage limit reached" and exits 1; the 429 and rate limit branches are covered.\n` }, "none"],
    [harness, "a short answer quoting limit text, exit 0", { status: 0, stdout: 'The CLI says "usage limit reached" when the plan runs out.\n' }, "none"],
    [harness, "an answer with the phrase mid-sentence, exit 0", { status: 0, stdout: "Done. Handling for usage limit reached is in cli/runner.mjs.\n" }, "none"],
    [harness, "a failed run whose answer quotes limit text", { status: 1, stdout: "The test asserts 'rate limit exceeded' is handled, but the build failed.\n" }, "none"],
    [harness, "a failed run quoting limit text in a code block", { status: 1, stdout: "```\nusage limit reached\n```\n" }, "none"],
    [harness, "a markdown quote", { status: 1, stdout: "> usage limit reached\n" }, "none"],
    [harness, "an ordinary failure", { status: 1, stderr: "error: something else broke\n" }, "none"],
    [harness, "an authentication error", { status: 1, stderr: "Error: 401 Unauthorized: invalid API key\n" }, "none"],
    [harness, "a login prompt", { status: 1, stdout: "Not logged in · Please run /login\n" }, "none"],
    [harness, "an expired token", { status: 1, stderr: "Error: token expired, usage limit reached for this key? 403 Forbidden\n" }, "none"],
    [harness, "a request timeout", { status: 1, stderr: "Error: request timed out after 600s\n" }, "none"],
    [harness, "ETIMEDOUT", { status: 1, stderr: "connect ETIMEDOUT 10.0.0.1:443\n" }, "none"],
    [harness, "a run killed by the runner's time limit", { status: null, signal: "SIGTERM", stderr: claudeStderr }, "none"],
    [harness, "a harness that could not start", { status: null, error: new Error("spawn ENOENT"), stderr: claudeStderr }, "none"],
    [harness, "a short answer about rate limits, exit 0", { status: 0, stdout: "Rate limit headers added\n" }, "none"],
    [harness, "a short answer about a 429 handler, exit 0", { status: 0, stdout: "Rate limit handling added; 429 responses retry.\n" }, "none"],
    [harness, "a successful long run", { status: 0, stdout: "All done.\n", stderr: "" }, "none"],
  ]),
];

for (const [harness, name, run, expected] of FIXTURES) {
  test(`${harness}: ${name}`, () => {
    const found = detectLimit({ stdout: "", stderr: "", ...run }, { now: NOW, timeZone: NY, harness });
    if (expected === "none") return assert.equal(found, null, JSON.stringify(found));
    assert.ok(found, "a provider limit is found");
    assert.equal(found.resetAt, expected);
    assert.ok(found.reason.length > 0 && found.reason.length <= 300);
  });
}

test("a zone Intl does not know reads no zoned time: the reset is null, the fallback's", () => {
  const p = (text, timeZone) => parseReset(text, { now: NOW, timeZone });
  assert.equal(p("limit reached, resets 3pm", "Not/AZone"), null);
  assert.equal(p("limit reached, resets Oct 14 at 3pm (Foo/Bar)", NY), null);
  assert.equal(p("limit reached, resets 2026-10-14 15:00", "bogus"), null);
  // An explicit offset or a duration needs no zone.
  assert.equal(p("limit reached, retry after 120", "Not/AZone"), NOW + 2 * MIN);
  const found = detectLimit({ status: 1, stdout: "", stderr: "stream error: usage limit reached, resets 3pm\n" }, { now: NOW, timeZone: "Not/AZone", harness: "codex" });
  assert.equal(found.resetAt, null);
});

// ── the adapter's spawn ─────────────────────────────────────────────────────

// limitSpawn around a fake harness: what it printed still reaches the
// runner, and a limit adds the marker and exit 75.
function through(harness, run, { stdio = ["pipe", "inherit", "inherit"] } = {}) {
  const out = [], err = [], calls = [];
  const spawn = (exe, argv, options) => { calls.push(options); return { stdout: "", stderr: "", ...run }; };
  const result = limitSpawn(harness, { spawn, now: () => NOW, timeZone: NY, stdout: (s) => out.push(s), stderr: (s) => err.push(s) })("harness", [], { input: "prompt", stdio });
  return { result, out: out.join(""), err: err.join(""), calls };
}

test("a limit ends the adapter's spawn with exit 75 and the marker as the last line of standard error", () => {
  const { result, err, out, calls } = through("claude-code", { status: 1, stdout: "partial work\n", stderr: "warn: slow\nClaude AI usage limit reached|1791644400\n" });
  assert.equal(result.status, PROVIDER_LIMIT_EXIT);
  assert.equal(PROVIDER_LIMIT_EXIT, 75);
  assert.equal(out, "partial work\n", "the harness's standard output still goes where it went");
  assert.deepEqual(calls[0].stdio, ["pipe", "pipe", "pipe"]);
  const lines = err.trimEnd().split("\n");
  assert.equal(lines[0], "warn: slow");
  assert.equal(lines.at(-1).startsWith(`${LIMIT_MARKER} `), true);
  assert.deepEqual(JSON.parse(lines.at(-1).slice(LIMIT_MARKER.length + 1)), {
    harness: "claude-code", reason: "Claude AI usage limit reached|1791644400", resetAt: at(1791644400 * 1000), resetText: "Claude AI usage limit reached|1791644400",
  });
});

test("a marker line a harness printed itself is dropped, and an ordinary failure keeps its own exit status", () => {
  const spoofed = through("codex", { status: 3, stderr: `${LIMIT_MARKER} {"harness":"codex","reason":"fake","resetAt":null}\nerror: broke\n` });
  assert.equal(spoofed.result.status, 3);
  assert.equal(spoofed.err, "error: broke\n");
  const ok = through("codex", { status: 0, stdout: "done\n" });
  assert.equal(ok.result.status, 0);
  assert.equal(ok.out, "done\n");
  assert.equal(ok.err, "");
});

test("a spawn with no prompt (codex's mcp list) passes through untouched", () => {
  const calls = [];
  const spawn = (exe, argv, options) => { calls.push(options); return { status: 0, stdout: "[]", stderr: "" }; };
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  limitSpawn("codex", { spawn })("codex", ["mcp", "list"], options);
  assert.equal(calls[0], options);
});

// ── the shipped adapters, run as the runner runs them ──────────────────────

const repo = fileURLToPath(new URL("..", import.meta.url));
const ADAPTERS = { "claude-code": ["atelier-claude.mjs", "ATELIER_CLAUDE"], antigravity: ["atelier-agy.mjs", "ATELIER_AGY"] };

// A stand-in harness that prints what FAKE_STDOUT / FAKE_STDERR say and exits FAKE_EXIT.
function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "fake-harness"), ws = join(dir, "ws"), brief = join(dir, "brief.md");
  mkdirSync(ws);
  writeFileSync(brief, "Task: t9\nBuild it.\n");
  writeFileSync(fake, `#!${process.execPath}
require("node:fs").readFileSync(0);
process.stdout.write(process.env.FAKE_STDOUT ?? "");
process.stderr.write(process.env.FAKE_STDERR ?? "");
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`);
  chmodSync(fake, 0o755);
  return { dir, ws, brief, fake, verdict: join(dir, "verdict.md") };
}

function runBin(h, name, extraEnv, { review = false } = {}) {
  const [bin, override] = ADAPTERS[name];
  const diff = join(h.dir, "diff.txt");
  writeFileSync(diff, "diff --git a/x b/x\n+x\n");
  const args = ["opus-5.5", h.brief, h.ws, "undefined", review ? diff : "undefined", review ? h.verdict : "undefined"];
  return spawnSync(process.execPath, [join(repo, "bin", "harness", bin), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: h.dir, TZ: NY, [override]: h.fake, ...extraEnv } });
}

for (const name of Object.keys(ADAPTERS)) {
  test(`the ${name} adapter, run for real, ends a build in a provider limit with exit 75 and the marker`, (t) => {
    const h = harness(t);
    const r = runBin(h, name, { FAKE_EXIT: "1", FAKE_STDERR: JSON.stringify({ error: { message: "usage limit reached, try again in 90 minutes" } }) });
    assert.equal(r.status, 75, r.stderr);
    const last = r.stderr.trimEnd().split("\n").at(-1);
    assert.ok(last.startsWith(`${LIMIT_MARKER} `));
    const body = JSON.parse(last.slice(LIMIT_MARKER.length + 1));
    assert.equal(body.harness, name);
    assert.ok(Math.abs(Date.parse(body.resetAt) - (Date.now() + 90 * MIN)) < 60_000, "the reset is 90 minutes on");
  });

  test(`the ${name} adapter writes no verdict when a review's harness hit a limit, even on exit 0`, (t) => {
    const h = harness(t);
    const stdout = JSON.stringify({ error: { message: "Usage limit reached. Resets in 2 hours." } });
    const r = runBin(h, name, { FAKE_EXIT: "0", FAKE_STDOUT: stdout }, { review: true });
    assert.equal(r.status, 75, r.stderr);
    assert.equal(existsSync(h.verdict), false, "the limit message is not taken for a verdict");
    assert.ok(r.stderr.trimEnd().split("\n").at(-1).startsWith(`${LIMIT_MARKER} `));
  });

  test(`the ${name} adapter still writes a review that quotes limit text`, (t) => {
    const h = harness(t);
    const answer = 'VERDICT: APPROVE\nSUMMARY: The handler prints "usage limit reached" as intended.';
    const r = runBin(h, name, { FAKE_EXIT: "0", FAKE_STDOUT: name === "antigravity" ? JSON.stringify({ response: answer }) : answer }, { review: true });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(h.verdict));
    assert.ok(!r.stderr.includes(LIMIT_MARKER));
  });

  test(`the ${name} adapter keeps an authentication failure's own exit status`, (t) => {
    const h = harness(t);
    const r = runBin(h, name, { FAKE_EXIT: "1", FAKE_STDERR: "Error: 401 Unauthorized\n" });
    assert.equal(r.status, 1);
    assert.ok(!r.stderr.includes(LIMIT_MARKER));
  });
}

test("runWithLimits reports a limit through the adapter's own io", (t) => {
  const h = harness(t);
  const spawn = () => ({ status: 1, stdout: "", stderr: "Error: usage limit reached. resets 3pm\n" });
  const err = [];
  const status = runWithLimits("claude-code", ["opus-5.5", h.brief, h.ws, "undefined", "undefined", "undefined"], { env: { PATH: "/usr/bin" }, spawn, now: () => NOW, timeZone: NY, stderr: (s) => err.push(s), stdout: () => {} });
  assert.equal(status, 75);
  assert.match(err.join(""), /"resetAt":"2026-10-10T19:00:00.000Z"/);
});

for (const harness of ["claude-code", "codex", "opencode", "antigravity"]) {
  for (const status of [0, 1]) {
    for (const stream of ["stdout", "stderr"]) {
      test(`${harness}: error envelope on ${stream}, exit ${status}`, () => {
        const run = { status, stdout: "Completed work.\n".repeat(100), [stream]: JSON.stringify({ error: { code: 429, message: "Too many requests", resets_in_seconds: 120 } }) };
        assert.equal(detectLimit(run, { harness, now: NOW }).resetAt, plus(2 * MIN));
      });
    }
    test(`${harness}: ordinary answers never become limits, exit ${status}`, () => {
      for (const answer of ["Quota exceeded errors are now logged.", "Too many requests are now retried.",
        "Usage limit reached", "Error: rate limit exceeded", "You've hit your usage limit.",
        JSON.stringify({ message: "usage limit reached" }),
        JSON.stringify({ type: "assistant", content: [{ text: "usage limit reached" }] }),
        JSON.stringify({ response: "Quota exceeded errors are now logged." }),
        JSON.stringify({ response: JSON.stringify({ error: { code: 429 } }) })]) {
        assert.equal(detectLimit({ status, stdout: answer }, { harness, now: NOW }), null, answer);
      }
    });
  }
}

const DIAGNOSTICS = {
  "claude-code": "5-hour limit reached ∙ resets in 2 hours",
  codex: "ERROR: You've hit your usage limit. Try again in 2 hours.",
  opencode: "Error: 429 Too Many Requests. Retry after 2 hours",
  antigravity: "RESOURCE_EXHAUSTED: quota exceeded. Retry after 2 hours",
};
for (const [harness, stderr] of Object.entries(DIAGNOSTICS)) {
  for (const status of [0, 1]) {
    test(`${harness}: stderr diagnostic survives a long answer, exit ${status}`, () => {
      assert.equal(detectLimit({ status, stderr, stdout: "Work completed.\n".repeat(100) }, { harness, now: NOW }).resetAt, plus(2 * HOUR));
    });
    test(`${harness}: auth and timeout error envelopes are not limits, exit ${status}`, () => {
      for (const message of ["401 Unauthorized: usage limit reached", "request timed out: usage limit reached"]) {
        for (const stream of ["stdout", "stderr"]) {
          assert.equal(detectLimit({ status, [stream]: JSON.stringify({ error: { message } }) }, { harness, now: NOW }), null);
        }
      }
    });
  }
}

for (const name of Object.keys(DIAGNOSTICS)) {
  for (const status of [0, 1]) {
    for (const stream of ["stdout", "stderr"]) {
      test(`${name}: adapter emits the structured limit from ${stream}, exit ${status}`, (t) => {
        const h = harness(t);
        const providers = join(h.dir, "providers");
        mkdirSync(providers);
        writeFileSync(join(providers, "models.json"), JSON.stringify({ models: {
          "test-model": { provider: "fixture", providerModel: "fixture", config: "fixture.json" },
        } }));
        const err = [];
        const result = runWithLimits(name, ["--providers", providers, "test-model", h.brief, h.ws, "undefined", "undefined", "undefined"], {
          env: { PATH: process.env.PATH, HOME: h.dir }, now: () => NOW, timeZone: NY,
          stdout() {}, stderr: (text) => err.push(text),
          spawn(exe, argv, options) {
            if (options.input === undefined) return { status: 0, stdout: "[]" }; // codex MCP discovery
            return { status, [stream]: JSON.stringify({ error: { code: 429, message: "Too many requests", resets_in_seconds: 120 } }) };
          },
        });
        assert.equal(result, PROVIDER_LIMIT_EXIT);
        const last = err.join("").trimEnd().split("\n").at(-1);
        assert.ok(last.startsWith(`${LIMIT_MARKER} `));
        const limit = JSON.parse(last.slice(LIMIT_MARKER.length + 1));
        assert.equal(limit.harness, name);
        assert.equal(limit.resetAt, plus(2 * MIN));
      });
    }
  }
}
