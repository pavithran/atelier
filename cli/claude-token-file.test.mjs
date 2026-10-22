import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "./runner-config.mjs";
import { harnessReady, runAdapter } from "./harness/adapter.mjs";

const root = mkdtempSync(join(tmpdir(), "atelier-claude-token-file-"));
after(() => rmSync(root, { recursive: true, force: true }));
const FAKE = "fake-claude-token-123";

function fixture(contents) {
  const dir = mkdtempSync(join(root, "t-"));
  const file = join(dir, "claude.key");
  if (contents !== undefined) writeFileSync(file, contents);
  return { dir, file };
}

test("the config accepts a token-file path, passes it to the shipped adapter, and refuses a token", () => {
  const { file } = fixture(FAKE);
  const ok = parseConfig({ claudeTokenFile: file, agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }] });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.claudeTokenFile, file);
  const command = ok.agents[0].command;
  assert.deepEqual(command.slice(2, 4), ["--claude-token-file", file]);
  assert.doesNotMatch(JSON.stringify(ok), new RegExp(FAKE));
  const bad = parseConfig({ claudeTokenFile: "sk-ant-oat01-abc", agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }] });
  assert.match(bad.errors.join(), /claudeTokenFile/);
  assert.doesNotMatch(bad.errors.join(), /sk-ant/);
  // No file configured: the command is the native-login one.
  const none = parseConfig({ agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }] });
  assert.ok(!none.agents[0].command.includes("--claude-token-file"));
});

test("the adapter gives the Claude child the file's token over inherited credentials, and no one else", () => {
  const { dir, file } = fixture(`${FAKE}\n`);
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "do it");
  let seen, argvSeen;
  const spawn = (exe, argv, options) => { seen = options.env; argvSeen = argv; return { status: 0 }; };
  const env = { HOME: dir, CLAUDE_CODE_OAUTH_TOKEN: "inherited", ANTHROPIC_API_KEY: "console-key" };
  const errors = [];
  assert.equal(runAdapter("claude-code", ["--claude-token-file", file, "sonnet-5.5", brief, dir, "undefined", "undefined", "undefined"], { env, spawn, stderr: (t) => errors.push(t) }), 0, errors.join());
  assert.equal(seen.CLAUDE_CODE_OAUTH_TOKEN, FAKE);
  assert.equal(seen.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "inherited");
  assert.doesNotMatch(JSON.stringify(argvSeen), new RegExp(FAKE));
});

test("with no file configured native login and inherited credentials are kept", () => {
  const { dir } = fixture();
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "do it");
  let seen;
  const env = { HOME: dir, CLAUDE_CODE_OAUTH_TOKEN: "inherited" };
  runAdapter("claude-code", ["sonnet-5.5", brief, dir, "undefined", "undefined", "undefined"], { env, spawn: (e, a, o) => { seen = o.env; return { status: 0 }; } });
  assert.equal(seen.CLAUDE_CODE_OAUTH_TOKEN, "inherited");
});

test("a missing, empty or unreadable token file is a redacted error from the adapter and the probe", async () => {
  const { dir } = fixture();
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "do it");
  const missing = join(dir, "none.key"), empty = fixture("  \n").file, locked = fixture(FAKE).file;
  chmodSync(locked, 0o000);
  for (const [file, word] of [[missing, /missing/], [empty, /empty/], [locked, /unreadable/]]) {
    if (file === locked && process.getuid?.() === 0) continue;
    const errors = [];
    let spawned = false;
    const code = runAdapter("claude-code", ["--claude-token-file", file, "sonnet-5.5", brief, dir, "undefined", "undefined", "undefined"], { env: { HOME: dir }, spawn: () => { spawned = true; return { status: 0 }; }, stderr: (t) => errors.push(t) });
    assert.equal(code, 1);
    assert.equal(spawned, false);
    assert.match(errors.join(), word);
    assert.doesNotMatch(errors.join(), new RegExp(FAKE));
    const answer = await harnessReady("claude-code", { env: {}, command: [process.execPath, "a.mjs", "--claude-token-file", file, "{model}"], home: dir, run: async () => ({ code: 0, stdout: '{"loggedIn":true}' }) });
    assert.equal(answer.ready, false);
    assert.match(answer.why, word);
    assert.doesNotMatch(JSON.stringify(answer), new RegExp(FAKE));
  }
});

test("the probe loads the configured token over the inherited one", async () => {
  const { dir, file } = fixture(`${FAKE}\n`);
  let seen;
  const run = async (_e, _a, { env }) => { seen = env; return { code: 0, stdout: '{"loggedIn":true}' }; };
  const command = [process.execPath, "a.mjs", "--claude-token-file", file, "{model}"];
  assert.deepEqual(await harnessReady("claude-code", { env: { CLAUDE_CODE_OAUTH_TOKEN: "inherited", ANTHROPIC_API_KEY: "k" }, command, home: dir, run }), { ready: true });
  assert.equal(seen.CLAUDE_CODE_OAUTH_TOKEN, FAKE);
  assert.equal(seen.ANTHROPIC_API_KEY, undefined);
});
