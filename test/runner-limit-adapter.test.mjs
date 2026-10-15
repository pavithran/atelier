import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// These are the harness transport envelopes, not model answer JSON.
const NAMES = ["claude-code", "codex", "opencode", "antigravity"];
function failure(name, message = "Too many requests. Retry after 2 minutes") {
  if (name === "claude-code") return JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: [message] });
  if (name === "codex") return JSON.stringify({ type: "error", message });
  if (name === "opencode") return JSON.stringify({ type: "error", error: { name: "APIError", data: { message, statusCode: 429 } } });
  return JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message } });
}
function answer(name, text) {
  if (name === "claude-code") return JSON.stringify({ type: "result", is_error: false, result: text });
  if (name === "codex") return JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  if (name === "opencode") return JSON.stringify({ type: "text", part: { text } });
  return JSON.stringify({ response: text });
}

for (const name of NAMES) {
  for (const status of [0, 1]) {
    for (const stream of ["stdout", "stderr"]) {
      test(`${name}: structured failure on ${stream}, exit ${status}`, () => {
        const found = detectLimit({ status, [stream]: failure(name) }, { harness: name, now: NOW });
        assert.equal(found?.resetAt ?? null, status === 0 ? null : plus(2 * MIN));
      });
      test(`${name}: answers, auth and timeouts on ${stream}, exit ${status}`, () => {
        for (const text of ['{"error":"Too many requests"}', '{"error":{"message":"usage limit reached"}}',
          "You've hit your usage limit", "Error: 429 Too many requests", failure(name)]) {
          assert.equal(detectLimit({ status, [stream]: answer(name, text) }, { harness: name, now: NOW }), null);
        }
        for (const text of ['{"error":"Too many requests"}', '{"error":{"message":"usage limit reached"}}',
          "Error: 429 Too many requests", "RESOURCE_EXHAUSTED: quota exceeded",
          failure(name, "401 Unauthorized: usage limit reached"), failure(name, "request timed out: usage limit reached")]) {
          assert.equal(detectLimit({ status, [stream]: text }, { harness: name, now: NOW }), null, text);
        }
      });
    }
  }
  test(`${name}: missing reset and interrupted processes`, () => {
    assert.equal(detectLimit({ status: 1, stdout: failure(name, "Usage limit reached") }, { harness: name, now: NOW }).resetAt, null);
    for (const run of [{ status: null, signal: "SIGTERM" }, { status: 1, error: new Error("ETIMEDOUT") }]) {
      assert.equal(detectLimit({ ...run, stdout: failure(name) }, { harness: name, now: NOW }), null);
    }
  });
}

// ── the adapter's spawn ─────────────────────────────────────────────────────

// limitSpawn around a fake harness: what it printed still reaches the
// runner, and a limit adds the marker and exit 75.
function through(harness, run, { stdio = ["pipe", "inherit", "inherit"] } = {}) {
  const out = [], err = [], calls = [];
  const spawn = (exe, argv, options) => { calls.push(options); return { stdout: "", stderr: "", ...run }; };
  const result = limitSpawn(harness, { spawn, now: () => NOW, timeZone: NY, stdout: (s) => out.push(s), stderr: (s) => err.push(s) })("harness", [], { input: "prompt", stdio });
  return { result, out: out.join(""), err: err.join(""), calls };
}

test("a marker printed by the harness is removed and an ordinary failure retains its status", () => {
  const r = through("codex", { status: 3, stderr: `${LIMIT_MARKER} {"harness":"codex"}\nerror: broke\n` });
  assert.equal(r.result.status, 3);
  assert.equal(r.err, "error: broke\n");
});
// A harness run under the adapter is piped, not inherited: the adapter must
// read the whole output to tell a provider limit from an answer, so what the
// harness printed reaches the runner once it ends, not as it is written
// (docs/runners.md, "Provider usage limits"). Gemini's tier review of
// 19d050b1 asked for this behaviour to be pinned.
test("a harness run is piped, and its output is printed once, after it ends", () => {
  let printedBeforeEnd = false;
  const out = [];
  const spawn = (exe, argv, options) => {
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"], "the harness's output is captured, not inherited");
    printedBeforeEnd = out.length > 0;
    return { status: 0, stdout: `${JSON.stringify({ type: "result", is_error: false, result: "the answer\n" })}\n`, stderr: "" };
  };
  limitSpawn("claude-code", { spawn, now: () => NOW, timeZone: NY, stdout: (s) => out.push(s), stderr: () => {} })("harness", [], { input: "prompt", stdio: ["pipe", "inherit", "inherit"] });
  assert.equal(printedBeforeEnd, false);
  assert.deepEqual(out, ["the answer\n"]);
});
test("MCP discovery passes through untouched", () => {
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  limitSpawn("codex", { spawn(exe, argv, actual) { assert.equal(actual, options); return { status: 0 }; } })("codex", ["mcp", "list"], options);
});

const repo = fileURLToPath(new URL("..", import.meta.url));
const ADAPTERS = {
  "claude-code": ["atelier-claude.mjs", "ATELIER_CLAUDE"],
  codex: ["atelier-codex.mjs", "ATELIER_CODEX"],
  opencode: ["atelier-opencode.mjs", "ATELIER_OPENCODE"],
  antigravity: ["atelier-agy.mjs", "ATELIER_AGY"],
};

// A stand-in harness that prints what FAKE_STDOUT / FAKE_STDERR say and exits FAKE_EXIT.
function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "fake-harness"), ws = join(dir, "ws"), brief = join(dir, "brief.md");
  mkdirSync(ws);
  writeFileSync(brief, "Task: t9\nBuild it.\n");
  writeFileSync(fake, `#!${process.execPath}
// opencode --version (t683): answered whatever the configured response is.
if (process.argv[2] === "--version") {
  process.stdout.write((process.env.FAKE_VERSION ?? "1.18.34") + "\\n");
  process.exit(0);
}
if (process.argv.includes("mcp")) {
  process.stdout.write("[]");
  process.exit(0);
}
require("node:fs").readFileSync(0);
const verdictAt = process.argv.indexOf("--output-last-message");
if (verdictAt !== -1 && Number(process.env.FAKE_EXIT ?? 0) === 0) {
  require("node:fs").writeFileSync(process.argv[verdictAt + 1], process.env.FAKE_ANSWER ?? "");
}
// The second ask of a reply with no verdict (opencode run --continue, t576).
process.stdout.write((process.argv.includes("--continue") ? process.env.FAKE_FOLLOW_UP_STDOUT : process.env.FAKE_STDOUT) ?? "");
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
  const providers = join(h.dir, "providers");
  mkdirSync(providers, { recursive: true });
  writeFileSync(join(providers, "models.json"), JSON.stringify({ models: {
    "test-model": { provider: "fixture", providerModel: "fixture", config: "fixture.json" },
  } }));
  const args = ["--providers", providers, "test-model", h.brief, h.ws, "undefined", review ? diff : "undefined", review ? h.verdict : "undefined"];
  return spawnSync(process.execPath, [join(repo, "bin", "harness", bin), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: h.dir, TZ: NY, [override]: h.fake, ...extraEnv } });
}


const FOLLOW_UP = "SUMMARY: checked again.\nVERDICT: APPROVE";

for (const name of Object.keys(ADAPTERS)) {
  test(`${name}: real adapter retains review verdicts containing JSON error examples`, (t) => {
    const h = harness(t);
    for (const text of ['{"error":"Too many requests"}', 'VERDICT: APPROVE\nSUMMARY: Tests cover {"error":"Too many requests"}.', failure(name)]) {
      const r = runBin(h, name, { FAKE_EXIT: "0", FAKE_STDOUT: answer(name, text), FAKE_STDERR: failure(name), FAKE_ANSWER: text, FAKE_FOLLOW_UP_STDOUT: answer(name, FOLLOW_UP) }, { review: true });
      assert.equal(r.status, 0, r.stderr);
      // opencode asks once more when a reply states no verdict (t576) and
      // keeps both replies; a reply with a verdict is kept as it came.
      const asked = name === "opencode" && !text.includes("VERDICT:");
      assert.equal(readFileSync(h.verdict, "utf8"), asked ? `${text}\n\n${FOLLOW_UP}\n` : text);
      assert.ok(!r.stderr.includes(LIMIT_MARKER));
    }
  });
  for (const stream of ["FAKE_STDOUT", "FAKE_STDERR"]) test(`${name}: real adapter reports a failed review's provider limit on ${stream} without a verdict`, (t) => {
    const h = harness(t);
    const r = runBin(h, name, { FAKE_EXIT: "1", [stream]: failure(name) }, { review: true });
    assert.equal(r.status, 75, r.stderr);
    assert.equal(existsSync(h.verdict), false);
    const last = r.stderr.trimEnd().split("\n").at(-1);
    assert.ok(last.startsWith(`${LIMIT_MARKER} `));
    const limit = JSON.parse(last.slice(LIMIT_MARKER.length + 1));
    assert.equal(limit.harness, name);
    assert.ok(Number.isFinite(Date.parse(limit.resetAt)));
  });
  test(`${name}: real adapter preserves ordinary failure exits without reporting a limit`, (t) => {
    const h = harness(t);
    for (const text of [answer(name, failure(name)), '{"error":"Too many requests"}',
      failure(name, "401 Unauthorized: usage limit reached"), failure(name, "request timed out: usage limit reached")]) {
      const r = runBin(h, name, { FAKE_EXIT: "2", FAKE_STDOUT: text, FAKE_STDERR: text }, { review: true });
      assert.equal(r.status, 2, r.stderr);
      assert.equal(existsSync(h.verdict), false);
      assert.ok(!r.stderr.includes(LIMIT_MARKER));
    }
  });
}

for (const name of NAMES) {
  for (const status of [0, 1]) {
    for (const stream of ["stdout", "stderr"]) {
      test(`${name}: adapter transport and limit marker on ${stream}, exit ${status}`, (t) => {
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
            if (argv[0] === "--version") return { status: 0, stdout: "1.18.34\n" };
            if (options.input === undefined) return { status: 0, stdout: "[]" };
            if (name === "claude-code" || name === "antigravity") assert.equal(argv[argv.indexOf("--output-format") + 1], "json");
            if (name === "codex") assert.ok(argv.includes("--json"));
            if (name === "opencode") assert.equal(argv[argv.indexOf("--format") + 1], "json");
            return { status, [stream]: failure(name) };
          },
        });
        assert.equal(result, status === 0 ? 0 : PROVIDER_LIMIT_EXIT);
        if (status === 0) return assert.ok(!err.join("").includes(LIMIT_MARKER));
        const last = err.join("").trimEnd().split("\n").at(-1);
        assert.ok(last.startsWith(`${LIMIT_MARKER} `));
        const limit = JSON.parse(last.slice(LIMIT_MARKER.length + 1));
        assert.equal(limit.harness, name);
        assert.equal(limit.resetAt, plus(2 * MIN));
      });
    }
  }
}

test("opencode review extracts only text events", (t) => {
  const h = harness(t);
  const r = through("opencode", { status: 0, stdout: '{"type":"step_start"}\n' + answer("opencode", 'VERDICT: APPROVE\n{"error":"Too many requests"}') }, { stdio: ["pipe", "pipe", "inherit"] });
  assert.equal(r.result.stdout, 'VERDICT: APPROVE\n{"error":"Too many requests"}');
});

for (const [name, value, expected] of [
  ["claude-code", { type: "result", is_error: true, result: "You've hit your limit · resets 3pm" }, at("2026-10-10T19:00:00Z")],
  ["codex", { type: "error", message: "usage limit reached", resets_in_seconds: 90 }, plus(90_000)],
  ["opencode", { type: "error", error: { name: "APIError", data: { statusCode: 429, message: "Too many requests", retryDelay: "34s" } } }, plus(34_000)],
  ["antigravity", { error: { code: 429, message: "usage limit reached", resets_at: 1791644400 } }, at(1791644400 * 1000)],
]) {
  test(`${name}: transport retains reset fields`, () => {
    const found = detectLimit({ status: 1, stdout: JSON.stringify(value, null, name === "claude-code" || name === "antigravity" ? 2 : 0) }, { harness: name, now: NOW, timeZone: NY });
    assert.equal(found.resetAt, expected);
  });
}

test("provider envelopes cannot be borrowed across harnesses", () => {
  for (const name of NAMES) {
    for (const other of NAMES.filter((n) => n !== name)) {
      assert.equal(detectLimit({ status: 1, stdout: failure(other) }, { harness: name, now: NOW }), null, `${name} reading ${other}`);
    }
  }
});

for (const name of NAMES) {
  test(`${name}: successful build still forwards the plain final report`, () => {
    const text = "validation_blocked: tests could not run";
    const r = through(name, { status: 0, stdout: answer(name, text) });
    assert.equal(r.out, text);
    assert.equal(r.result.status, 0);
  });
  test(`${name}: real adapter prints only the successful build answer`, (t) => {
    const h = harness(t);
    const text = "Build complete.\nvalidation_blocked: tests could not run";
    const r = runBin(h, name, { FAKE_EXIT: "0", FAKE_STDOUT: answer(name, text) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, text);
    assert.ok(!r.stderr.includes(LIMIT_MARKER));
  });
  for (const stream of ["FAKE_STDOUT", "FAKE_STDERR"]) {
    test(`${name}: real adapter build limit on ${stream} ends with exit 75 and the marker`, (t) => {
      const h = harness(t);
      const r = runBin(h, name, { FAKE_EXIT: "1", [stream]: failure(name) });
      assert.equal(r.status, PROVIDER_LIMIT_EXIT, r.stderr);
      const last = r.stderr.trimEnd().split("\n").at(-1);
      assert.ok(last.startsWith(`${LIMIT_MARKER} `));
      const limit = JSON.parse(last.slice(LIMIT_MARKER.length + 1));
      assert.equal(limit.harness, name);
      assert.ok(Number.isFinite(Date.parse(limit.resetAt)));
    });
  }
}

test("codex extracts the final completed agent message for printed and captured output", () => {
  const text = 'Final answer.\n{"error":"Too many requests"}';
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "fixture" }),
    answer("codex", "Earlier progress message"),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "tool output" } }),
    answer("codex", text),
    JSON.stringify({ type: "item.updated", item: { type: "agent_message", text: "incomplete" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
    "",
  ].join("\n");
  for (const mode of ["inherit", "pipe"]) {
    const r = through("codex", { status: 0, stdout }, { stdio: ["pipe", mode, "inherit"] });
    assert.equal(r.result.stdout, text);
    assert.equal(r.out, mode === "inherit" ? text : "");
    assert.equal(r.result.status, 0);
    assert.equal(r.err, "");
  }
  const empty = through("codex", { status: 0, stdout: '{"type":"turn.completed"}\n' });
  assert.equal(empty.out, "");
  assert.equal(empty.result.stdout, "");
});
