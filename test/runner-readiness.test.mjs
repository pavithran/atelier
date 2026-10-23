// t234: a runner reports its readiness per harness and the expiry of its
// credentials; status and unwrap show it, and a report over 25 minutes old shows stale.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READY_RECHECK_MS, credentialReadiness, harnessState, planFilePath, runRunner } from "../cli/runner.mjs";
import { formatRunners } from "../cli/status.mjs";
import { READINESS_STALE_MS, expiryFromToken, isStaleProbe, parseReadiness, readinessLines, tokenExpiry } from "../src/runners/readiness.ts";

const root = mkdtempSync(join(tmpdir(), "atelier-readiness-tests-"));
after(() => rmSync(root, { recursive: true, force: true }));
const DAY = 86_400_000;
const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

test("a harness answer is ready, signed-out or unknown", () => {
  assert.equal(harnessState({ ready: true }), "ready");
  assert.equal(harnessState({ ready: true, state: "unknown" }), "ready");
  assert.equal(harnessState({ ready: false, state: "signed-out", why: "x" }), "signed-out");
  assert.equal(harnessState({ ready: false, why: "the Claude CLI is not signed in; run: claude auth login" }), "signed-out");
  assert.equal(harnessState({ ready: false, why: "could not check whether Codex is signed in (timed out)" }), "unknown");
  assert.equal(harnessState({ ready: false, state: "unknown", why: "x" }), "unknown");
  assert.equal(harnessState(undefined), "signed-out");
});

test("expiry: unknown without metadata, expiring within 7 days, expired once past", () => {
  const now = Date.parse("2026-10-23T00:00:00Z");
  assert.deepEqual(tokenExpiry(null, now), { state: "unknown", daysLeft: null });
  assert.equal(tokenExpiry(new Date(now + 8 * DAY).toISOString(), now).state, "ok");
  assert.equal(tokenExpiry(new Date(now + 7 * DAY).toISOString(), now).state, "expiring");
  assert.equal(tokenExpiry(new Date(now + DAY).toISOString(), now).state, "expiring");
  const past = tokenExpiry(new Date(now - DAY).toISOString(), now);
  assert.equal(past.state, "expired");
  assert.equal(past.daysLeft, -1);
  assert.equal(expiryFromToken(jwt(1_800_000_000)), "2027-01-15T08:00:00.000Z");
  assert.equal(expiryFromToken("atl_abcdef"), null);
  assert.equal(expiryFromToken("a.b.c"), null);
});

test("the credential check reports each reviewer token and the Claude token file, and withdraws nothing", () => {
  const dir = mkdtempSync(join(root, "cfg-"));
  const now = Date.parse("2026-10-23T00:00:00Z");
  const file = (name, text, mode = 0o600) => { const p = join(dir, name); writeFileSync(p, text); chmodSync(p, mode); return p; };
  mkdirSync(join(dir, "tokens"));
  file("tokens/soon", jwt((now + 3 * DAY) / 1000));
  file("tokens/fine", jwt((now + 30 * DAY) / 1000));
  file("tokens/opaque", "atl_opaque");
  file("tokens/gone", jwt((now - DAY) / 1000));
  file("tokens/dev", "atl_owner");
  file("tokens/open", "atl_x", 0o644);
  const claude = file("claude-token", "sk-ant-oat01-secret");
  file("claude-token.expires", new Date(now + 5 * DAY).toISOString());
  const config = {
    tokens: { soon: "tokens/soon", fine: "tokens/fine", opaque: "tokens/opaque", gone: "tokens/gone", dev: "tokens/dev", open: "tokens/open", none: "tokens/none" },
    claudeTokenFile: claude,
  };
  const out = credentialReadiness(config, { env: { ATELIER_CONFIG_DIR: dir }, home: dir, now, ownerTokens: () => ["atl_owner"] });
  const by = Object.fromEntries(out.map((c) => [c.name, c]));
  assert.equal(by.soon.state, "expiring");
  assert.equal(by.soon.daysLeft, 3);
  assert.match(by.soon.recovery, /expires soon/);
  assert.equal(by.fine.state, "ok");
  assert.equal(by.fine.recovery, null);
  assert.deepEqual([by.opaque.state, by.opaque.expiresAt], ["unknown", null]);
  assert.equal(by.gone.state, "expired");
  assert.equal(by.dev.state, "developers");
  assert.equal(by.open.state, "unreadable");
  assert.match(by.open.recovery, /chmod 600/);
  assert.equal(by.none.state, "unreadable");
  assert.equal(by.claude.kind, "claude");
  assert.equal(by.claude.state, "expiring");
  assert.equal(by.claude.expiresAt, new Date(now + 5 * DAY).toISOString());
  assert.doesNotMatch(JSON.stringify(out), /atl_|sk-ant|secret/);
  const missing = credentialReadiness({ claudeTokenFile: join(dir, "nope") }, { env: {}, home: dir, now, ownerTokens: () => [] });
  assert.deepEqual(missing.map((c) => c.state), ["unreadable"]);
});

test("a relative reviewer token path finds its expiry metadata beside the file in the config directory", () => {
  const dir = mkdtempSync(join(root, "cfg-"));
  const now = Date.parse("2026-10-23T00:00:00Z");
  mkdirSync(join(dir, "tokens"));
  writeFileSync(join(dir, "tokens", "agent"), "atl_opaque");
  chmodSync(join(dir, "tokens", "agent"), 0o600);
  writeFileSync(join(dir, "tokens", "agent.expires"), new Date(now + 2 * DAY).toISOString());
  assert.notEqual(process.cwd(), dir);
  const [entry] = credentialReadiness({ tokens: { m: "tokens/agent" } }, { env: { ATELIER_CONFIG_DIR: dir }, home: root, now, ownerTokens: () => [] });
  assert.equal(entry.state, "expiring");
  assert.equal(entry.expiresAt, new Date(now + 2 * DAY).toISOString());
});

test("the report is bounded on the server and stale past 25 minutes", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const fresh = new Date(now - 5 * 60_000).toISOString(), old = new Date(now - READINESS_STALE_MS - 60_000).toISOString();
  assert.equal(isStaleProbe(fresh, now), false);
  assert.equal(isStaleProbe(old, now), true);
  assert.equal(isStaleProbe("junk", now), true);
  assert.equal(parseReadiness("x"), null);
  assert.equal(parseReadiness({ harnesses: [{ harness: "x", state: "weird", probedAt: fresh }] }), null);
  const parsed = parseReadiness({
    harnesses: [{ harness: "codex", state: "signed-out", probedAt: fresh, recovery: "run: codex login", extra: 1 }, { harness: "claude-code", state: "ready", probedAt: old }],
    tokens: [{ kind: "reviewer", name: "m1", state: "expiring", expiresAt: "2026-10-26T00:00:00Z", daysLeft: 3, recovery: "reissue", value: "atl_secret" }],
  });
  assert.equal(parsed.harnesses.length, 2);
  assert.ok(!JSON.stringify(parsed).includes("atl_secret"));
  const text = readinessLines("home:studio", parsed, now).join("\n");
  assert.match(text, /home:studio  codex  signed-out  probed 5m ago  run: codex login/);
  assert.match(text, /home:studio  claude-code  stale  probed 26m ago \(last ready\)/);
  assert.match(text, /home:studio  reviewer token m1  expiring: expires 2026-10-26 \(3 days\)  reissue/);
  const runners = formatRunners([{ runner: "home:studio", kind: "home", agents: [], at: fresh, readiness: parsed }], now).join("\n");
  assert.match(runners, /Runners:\n {2}home:studio {2}live[^\n]*\n {4}home:studio {2}codex/);
});

test("a poll and a heartbeat carry the self-check report", async (t) => {
  const dir = mkdtempSync(join(root, "run-")), workspace = join(dir, "work");
  mkdirSync(workspace);
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [
    { agent: "claude-code", models: ["m1"], command: ["/x/atelier-claude", "{model}", "{brief_file}", "{workspace}", "{plan_file}"] },
    { agent: "codex", models: ["c1"], command: ["/x/atelier-codex", "{model}", "{brief_file}"] },
  ], jobs: ["build", "plan"] }));
  const previous = Object.fromEntries(["ATELIER_CONFIG_DIR", "ATELIER_SECRET_STORE"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file" });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const polls = [], beats = [];
  const assignment = { project: "demo", actor: "claude-code/m1", agent: "claude-code", model: "m1", item: { id: "t1", title: "Change", scope: ["src/**"], accept: ["works"], kind: "plan", dispatch: { job: "plan" } } };
  let clock = Date.parse("2026-10-23T12:00:00Z"), calls = 0;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config, once: true }, {
    now: () => clock, limitFile: join(dir, "limits.json"), credential: "runner-secret", workspacePath: () => workspace, heartbeatMs: 10,
    queue: async (offer) => { polls.push(offer); return calls++ ? [] : [assignment]; },
    heartbeat: async (offer) => { beats.push(offer); },
    harnessReady: async (harness) => harness === "codex" ? { ready: false, why: "Codex is not signed in; run: codex login" } : { ready: true },
    jobBrief: async () => ({ text: "Plan the change" }),
    postPlan: async () => ({ valid: true, hash: "h" }),
    taskIO: { log() {}, reset: async () => {}, head: async () => "h", dataHome: async () => null, identityRefusals: async () => [] },
    executeChild: async () => { clock += READY_RECHECK_MS; await new Promise((r) => setTimeout(r, 50)); writeFileSync(planFilePath(workspace), JSON.stringify({ goal: "Change" })); return { code: 0, output: "", stderr: "" }; },
  }).catch(() => {});
  const first = polls[0].readiness;
  assert.deepEqual(first.harnesses.map((h) => [h.harness, h.state, h.probedAt]), [
    ["claude-code", "ready", "2026-10-23T12:00:00.000Z"],
    ["codex", "signed-out", "2026-10-23T12:00:00.000Z"],
  ]);
  assert.equal(first.harnesses[1].recovery, "Codex is not signed in; run: codex login");
  assert.equal(first.harnesses[0].recovery, null);
  for (const beat of beats) assert.ok(beat.readiness.harnesses.length, "the heartbeat carries the report");
});
