import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CODEX_FEATURES_OFF, VERDICT_DEMAND, VERIFY_DEMAND, VERIFY_DEMAND_BASE, VERDICT_FOLLOW_UP, agentRules, verdictFollowUp, codexNoMcpFlags, claudeModel, parseArgs, runAdapter } from "../cli/harness/adapter.mjs";
import { runWithLimits } from "../bin/harness/limit.mjs";
import { METADATA_VAR, metadataEscaped, opencodeConfig, substituteEnv } from "../cli/harness/providers.mjs";
import { defaultCommand, parseConfig } from "../cli/runner-config.mjs";
import { commandFor, gatewayMetadata } from "../cli/runner.mjs";
import { redactKeys } from "../src/models/pool.ts";
import { parseVerdict, replyFormat } from "../src/review/verdict.ts";
import { parseVerification, verifierBrief } from "../src/review/verify.ts";

// t374: the four harness adapters ship in bin/harness/, carry the agent
// rules, hold no key, give every prompt on standard input and are what the
// runner runs when its config names no command.

const repo = fileURLToPath(new URL("..", import.meta.url));
const ADAPTERS = { "claude-code": "atelier-claude.mjs", codex: "atelier-codex.mjs", opencode: "atelier-opencode.mjs", antigravity: "atelier-agy.mjs" };
const OVERRIDE = { "claude-code": "ATELIER_CLAUDE", codex: "ATELIER_CODEX", opencode: "ATELIER_OPENCODE", antigravity: "ATELIER_AGY" };

// A stand-in harness: records its argv, standard input and the variables the
// adapter set, and answers as each real one does on a review.
function standIn(path, record) {
  writeFileSync(path, `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
// codex [--disable F | -c K=V]... mcp list --json, as codex-cli 0.160.0 does
// it: a server a feature provides ({ feature }) is gone with --disable FEATURE;
// enabled=false on any server not defined in config.toml (one with no
// feature) fails the configuration load.
const mcp = argv.indexOf("mcp");
if (mcp !== -1 && argv[mcp + 1] === "list") {
  fs.appendFileSync(${JSON.stringify(record)} + ".mcp", JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
  if (process.env.FAKE_MCP_FAIL) process.exit(2);
  const raw = process.env.FAKE_MCP_LIST ?? "[]";
  let servers;
  try { servers = JSON.parse(raw); } catch { process.stdout.write(raw); process.exit(0); }
  if (!Array.isArray(servers)) { process.stdout.write(raw); process.exit(0); }
  const flags = argv.slice(0, mcp), off = new Set(flags.filter((a, i) => flags[i - 1] === "--disable"));
  const disabled = new Set();
  for (const c of flags.filter((a, i) => flags[i - 1] === "-c")) {
    const m = /^mcp_servers\\.(.+)\\.enabled=false$/.exec(c);
    if (!m) continue;
    if (!servers.some((s) => s.name === m[1] && !s.feature)) { process.stderr.write("Error: failed to load bootstrap configuration: invalid transport in mcp_servers." + m[1] + "\\n"); process.exit(1); }
    disabled.add(m[1]);
  }
  if (process.env.FAKE_MCP_STUCK) disabled.clear();
  const shown = servers.filter((s) => !off.has(s.feature)).map(({ feature, ...s }) => ({ ...s, enabled: disabled.has(s.name) ? false : s.enabled }));
  process.stdout.write(JSON.stringify(shown));
  process.exit(0);
}
// opencode --version (t683): FAKE_VERSION, else the 1.x the runs use until the switch.
if (argv[0] === "--version") { fs.appendFileSync(${JSON.stringify(record)} + ".version", "asked\\n"); process.stdout.write((process.env.FAKE_VERSION ?? "1.18.34") + "\\n"); process.exit(0); }
const input = fs.readFileSync(0, "utf8");
const pick = ["OPENCODE_CONFIG", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "CF_AIG_TOKEN", "CF_AIG_METADATA", "${METADATA_VAR}", "ATELIER_SECRET_STORE", "ATELIER_CONFIG_DIR",
  "XDG_CONFIG_HOME", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION",
  "HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "GIT_CONFIG_GLOBAL"];
const list = (dir) => dir && fs.existsSync(dir) ? fs.readdirSync(dir) : null;
const configHome = list(process.env.XDG_CONFIG_HOME), home = list(process.env.HOME);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, input, cwd: process.cwd(), configHome, home, env: Object.fromEntries(pick.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) }));
fs.appendFileSync(${JSON.stringify(record)} + ".calls", JSON.stringify({ argv, input }) + "\\n");
// FAKE_ANSWER, when set, is the first reply and FAKE_FOLLOW_UP the reply in
// the continued session (opencode run --continue).
// FAKE_FOLLOW_UP=@template answers the second ask as a reviewer who follows
// it to the letter: with the ask's own verdict-format lines, and no other.
const template = (ask) => ask.split("\\n").filter((l) => /^(?:SUMMARY|FINDING|CRITERION \\d+|VERDICT):/.test(l)).join("\\n");
const followUp = process.env.FAKE_FOLLOW_UP === "@template" ? template(input) : process.env.FAKE_FOLLOW_UP;
const answer = !process.env.FAKE_ANSWER ? "VERDICT: APPROVE\\nSUMMARY: fine" : argv.includes("--continue") || argv.includes("resume") ? followUp : process.env.FAKE_ANSWER;
const at = argv.indexOf("--output-last-message");
if (at !== -1) fs.writeFileSync(argv[at + 1], answer);
else if (argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "json") process.stdout.write(JSON.stringify({ type: "text", part: { text: answer } }));
else if (argv.includes("-p") && argv[argv.indexOf("--output-format") + 1] === "json") process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: answer }));
else if (argv.includes("--output-format") && argv[argv.indexOf("--output-format") + 1] === "json") process.stdout.write(JSON.stringify({ response: answer }));
else process.stdout.write(answer);
`);
  chmodSync(path, 0o755);
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-adapters-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The mock clone lives outside every implicit temp root (/tmp, TMPDIR, the
  // system temp folder), as the real one does under ~/Library/Caches, since a
  // Codex review refuses a clone inside one (t140), whatever TMPDIR is.
  const clones = mkdtempSync(join(homedir(), "atelier-adapters-clone-"));
  t.after(() => rmSync(clones, { recursive: true, force: true }));
  const ws = join(clones, "ws"), record = join(dir, "record.json"), fake = join(dir, "fake-harness");
  mkdirSync(ws);
  // A system temp folder of the run's own, apart from the clone (t140: a
  // Codex review refuses a clone inside the system temp folder).
  const tmp = mkdtempSync(join(tmpdir(), "atelier-adapters-tmp-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  standIn(fake, record);
  // Over the 1 MB an argument could carry.
  const brief = join(dir, "brief.md");
  writeFileSync(brief, `Task: t9\nBuild it.\n${"x".repeat(1_100_000)}\n`);
  const diff = join(dir, "diff.txt");
  writeFileSync(diff, "diff --git a/x b/x\n+```\n");
  // The opencode adapter's provider configs and the store its key is read from.
  const providers = join(dir, "providers");
  mkdirSync(providers);
  writeFileSync(join(providers, "deepseek-api.json"), JSON.stringify(opencodeConfig("deepseek-api", [{ providerModel: "deepseek-v4-pro", atelierId: "deepseek-v4-pro", limit: { context: 128000, output: 32000 } }], { gateway: { account: "acct", id: "atelier" } }), null, 2));
  writeFileSync(join(providers, "models.json"), JSON.stringify({ models: { "deepseek-v4-pro": { provider: "deepseek-api", providerModel: "deepseek-v4-pro", config: "deepseek-api.json", key: "deepseek.API_KEY", keyVar: "DEEPSEEK_API_KEY", gateway: true } } }));
  const store = join(dir, "store");
  mkdirSync(store);
  writeFileSync(join(store, "secrets.json"), JSON.stringify({ "deepseek.API_KEY": "DUMMY-deepseek", CF_AIG_TOKEN: "DUMMY-gateway" }), { mode: 0o600 });
  return { dir, clones, ws, tmp, record, fake, brief, diff, providers, store };
}

function run(harness, s, { model, review = false, plan = false, env: extraEnv = {}, timeout = 10_000, secretStore = "file" }) {
  const verdict = join(s.dir, "verdict.md");
  const args = [model, s.brief, s.ws, plan ? join(s.ws, "plan.json") : "undefined", review ? s.diff : "undefined", review ? verdict : "undefined"];
  // The store is named as the runner's default command names it: the runner
  // gives a harness no ATELIER_ variable.
  const extra = harness === "opencode" ? ["--providers", s.providers, "--secret-store", secretStore, "--secrets-dir", s.store] : [];
  const env = { PATH: process.env.PATH, HOME: s.dir, TMPDIR: s.tmp, [OVERRIDE[harness]]: s.fake,
    CF_AIG_METADATA: gatewayMetadata("t9", review ? "review" : "build", "home:mbp"), ...extraEnv };
  const r = spawnSync(process.execPath, [join(repo, "bin", "harness", ADAPTERS[harness]), ...extra, ...args], {
    encoding: "utf8", env, timeout, killSignal: "SIGKILL",
  });
  const diagnostic = `${harness} adapter: ${r.error?.code ?? "exit"}, status ${r.status}, signal ${r.signal}\nstderr:\n${r.stderr ?? ""}`;
  assert.ok(!r.error, diagnostic);
  assert.equal(r.status, 0, diagnostic);
  return { r, seen: JSON.parse(readFileSync(s.record, "utf8")), verdict };
}

test("a stalled adapter fails with its name, signal and stderr before reading its record", (t) => {
  const s = setup(t);
  // Stall before runAdapter (and before any harness child can be orphaned).
  const preload = join(s.dir, "stall.cjs");
  writeFileSync(preload, 'require("node:fs").writeSync(2, "fake adapter startup stalled\\n"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  // A preload with a live handle alone would still start the adapter. Block
  // module loading synchronously, as a stuck startup read would do.
  writeFileSync(preload, '\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);', { flag: "a" });
  assert.throws(() => run("opencode", s, {
    model: "deepseek-v4-pro", timeout: 2_000, env: { NODE_OPTIONS: `--require=${preload}` },
  }), (error) => {
    assert.match(error.message, /opencode adapter: ETIMEDOUT, status null, signal SIGKILL/);
    assert.match(error.message, /stderr:\nfake adapter startup stalled/);
    assert.doesNotMatch(error.message, /ENOENT/);
    return true;
  });
});

test("opencode bounds a credential read that stalls before the harness starts", (t) => {
  const s = setup(t);
  // Force the native backend even on Linux, using a fake security command.
  // No owner credentials or installed harness are required in a clean clone.
  const security = join(s.dir, "security");
  writeFileSync(security, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(join(s.dir, "credential-started"))}, "started");
process.stderr.write("DUMMY-private-credential-output");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
  chmodSync(security, 0o755);
  assert.throws(() => run("opencode", s, {
    model: "deepseek-v4-pro", secretStore: "keychain", env: { PATH: s.dir },
  }), (error) => {
    assert.match(error.message, /opencode adapter: exit, status 1, signal null/);
    assert.match(error.message, /credential command security timed out after 5000 ms \(signal SIGKILL\)/);
    assert.doesNotMatch(error.message, /DUMMY-private-credential-output|ENOENT/);
    return true;
  });
  assert.equal(readFileSync(join(s.dir, "credential-started"), "utf8"), "started");
  assert.throws(() => readFileSync(s.record), /ENOENT/, "the harness never started");
  // Explicit file stores must continue to bypass even a stuck native store.
  assert.equal(run("opencode", s, { model: "deepseek-v4-pro", env: { PATH: s.dir } }).seen.env.DEEPSEEK_API_KEY, "DUMMY-deepseek");
});

for (const [harness, model] of [["claude-code", "opus-5.5"], ["codex", "gpt-6-astra"], ["opencode", "deepseek-v4-pro"], ["antigravity", "gemini-3.1-pro"]]) {
  test(`the ${harness} adapter gives a build its prompt, rules and brief, on standard input and never as an argument`, (t) => {
    const s = setup(t);
    const { r, seen } = run(harness, s, { model });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(realpathSync(seen.cwd), realpathSync(s.ws));
    const brief = readFileSync(s.brief, "utf8");
    assert.ok(seen.input.endsWith(brief), "the whole brief is on standard input");
    assert.ok(seen.input.startsWith(agentRules(harness, model, s.ws)), "the agent rules come first");
    assert.match(seen.input, new RegExp(`git commit -m "subject" -m "Agent: ${harness}/${model.replace(/\./g, "\\.")}"`));
    assert.match(seen.input, /Do not push\. Run no atelier command\./);
    assert.ok(seen.argv.every((a) => !a.includes("Build it.") && a.length < 10_000), "nothing of the prompt is an argument");
  });

  test(`the ${harness} adapter writes a review's answer to the verdict file, the diff on standard input`, (t) => {
    const s = setup(t);
    const { r, seen, verdict } = run(harness, s, { model, review: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(seen.input, /diff --git a\/x b\/x/);
    assert.match(seen.input, /````diff/, "the fence is longer than the diff's own backticks");
    assert.match(seen.input, /Edit nothing/);
    assert.ok(seen.input.endsWith(VERDICT_DEMAND), "the prompt ends by demanding a final VERDICT line (t576)");
    assert.equal(readFileSync(verdict, "utf8"), "VERDICT: APPROVE\nSUMMARY: fine");
    assert.equal(readFileSync(`${s.record}.calls`, "utf8").trim().split("\n").length, 1, "a reply with a verdict is not asked again");
  });
}

// The finding t576 names: GLM 5.3 under opencode answered reviews in prose
// with no VERDICT line, and the runner released 48 of them overnight on
// 2026-10-13 ("the reply states no verdict"). The adapter now asks once more,
// in the same session, for the verdict lines alone.
test("an opencode review reply with no verdict is asked once more in the same session, and the verdict is recorded", (t) => {
  const s = setup(t);
  const narrative = "I read the diff and ran the tests; the change looks correct and complete.";
  const { verdict } = run("opencode", s, { model: "deepseek-v4-pro", review: true, env: {
    FAKE_ANSWER: narrative, FAKE_FOLLOW_UP: "SUMMARY: read the diff, tests pass\nVERDICT: APPROVE",
  } });
  const calls = readFileSync(`${s.record}.calls`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.length, 2, "one second ask, no more");
  assert.deepEqual(calls[1].argv, ["run", "--model", "deepseek-api/deepseek-v4-pro", "--continue", "--format", "json"], "the second ask continues the run's session");
  assert.equal(calls[1].input, VERDICT_FOLLOW_UP, "and asks for the verdict lines alone");
  const kept = readFileSync(verdict, "utf8");
  assert.ok(kept.startsWith(narrative), "the first reply is kept");
  assert.ok(kept.trimEnd().endsWith("VERDICT: APPROVE"));
  const parsed = parseVerdict(kept);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.verdict, "approve");
});

// Astra's review of t576 (2026-10-13): the second ask permitted only
// SUMMARY, FINDING and VERDICT lines, so a reviewer following it on a task
// with acceptance criteria still gave an approval the runner refuses for
// its missing CRITERION lines (parseVerdict with the task's criterion
// count), and the review was released. The ask now names one CRITERION line
// per criterion, reading the count from the brief's reply format.
test("an opencode review's second ask, on a task with acceptance criteria, asks for one CRITERION line per criterion", (t) => {
  const s = setup(t);
  writeFileSync(s.brief, `Task: t9\nBuild it.\n\n## Acceptance criteria\n\n1. One.\n2. Two.\n\n## Reply format\n\n${replyFormat(2)}\n`);
  const narrative = "I read the diff and ran the tests; both criteria hold.";
  const { verdict } = run("opencode", s, { model: "deepseek-v4-pro", review: true, env: { FAKE_ANSWER: narrative, FAKE_FOLLOW_UP: "@template" } });
  const calls = readFileSync(`${s.record}.calls`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  assert.match(calls[1].input, /one CRITERION line for each of the 2 acceptance criteria/);
  const parsed = parseVerdict(readFileSync(verdict, "utf8"), 2);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.verdict, "approve");
  // Without criteria in the brief the ask names none.
  assert.equal(verdictFollowUp(0), VERDICT_FOLLOW_UP);
  assert.doesNotMatch(VERDICT_FOLLOW_UP, /CRITERION/);
});

test("an opencode review whose second ask also states no verdict keeps both replies for the runner to record as unparsable", (t) => {
  const s = setup(t);
  const { verdict } = run("opencode", s, { model: "deepseek-v4-pro", review: true, env: { FAKE_ANSWER: "Looks fine to me.", FAKE_FOLLOW_UP: "Still fine." } });
  assert.equal(readFileSync(`${s.record}.calls`, "utf8").trim().split("\n").length, 2, "asked once more, not again");
  const parsed = parseVerdict(readFileSync(verdict, "utf8"));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /states no verdict/);
});

// Astra's reviews on miqra on 2026-10-25 (t299): 11 replies in prose with no
// VERDICT line. Only opencode was asked again; a codex review writes its reply
// to a file, which took no second ask.
test("a codex review that states no verdict is asked again in its own session, and both replies are kept", (t) => {
  const s = setup(t);
  const narrative = "I read the diff and ran the tests; all holds.";
  const { verdict } = run("codex", s, { model: "gpt-6-astra", review: true, env: { FAKE_ANSWER: narrative, FAKE_FOLLOW_UP: "SUMMARY: read the diff\nBLOCKING: 0\nVERDICT: APPROVE" } });
  const calls = readFileSync(`${s.record}.calls`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.length, 2, "the review and one second ask");
  const again = calls.at(-1).argv;
  assert.deepEqual(again.slice(again.indexOf("exec"), again.indexOf("exec") + 3), ["exec", "resume", "--last"]);
  assert.match(calls.at(-1).input, /states no verdict/);
  const text = readFileSync(verdict, "utf8");
  assert.ok(text.startsWith(narrative));
  assert.equal(parseVerdict(text).ok, true);
});

test("a codex review that states a verdict is not asked again, and one whose second ask fails keeps its first reply", (t) => {
  const s = setup(t);
  run("codex", s, { model: "gpt-6-astra", review: true, env: {} });
  assert.equal(readFileSync(`${s.record}.calls`, "utf8").trim().split("\n").filter((l) => JSON.parse(l).argv.includes("resume")).length, 0);
  const t2 = setup(t);
  const { verdict } = run("codex", t2, { model: "gpt-6-astra", review: true, env: { FAKE_ANSWER: "Looks fine to me.", FAKE_FOLLOW_UP: "Still fine." } });
  assert.equal(readFileSync(`${t2.record}.calls`, "utf8").trim().split("\n").filter((l) => JSON.parse(l).argv.includes("resume")).length, 1, "asked once more, not again");
  assert.match(parseVerdict(readFileSync(verdict, "utf8")).error, /states no verdict/);
});

test("the harnesses are started with their own permission rules", (t) => {
  const s = setup(t);
  const claude = run("claude-code", s, { model: "opus-5.5" }).seen.argv;
  assert.equal(claude[claude.indexOf("--model") + 1], "claude-opus-5-5");
  assert.ok(claude.includes("--strict-mcp-config"));
  assert.equal(claude[claude.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  const allowed = claude[claude.indexOf("--allowedTools") + 1].split(",");
  assert.ok(allowed.includes("Bash(git add:*)") && allowed.includes("Bash(git commit:*)"));
  assert.ok(claude[claude.indexOf("--disallowedTools") + 1].split(",").includes("Bash(git push:*)"));
  const codex = run("codex", s, { model: "gpt-6-astra" }).seen.argv;
  assert.deepEqual(codex.slice(codex.indexOf("exec"), codex.indexOf("exec") + 3), ["exec", "--model", "gpt-6-astra"]);
  assert.equal(codex.at(-1), "-", "codex reads the prompt from standard input");
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "workspace-write");
  const codexReview = run("codex", s, { model: "gpt-6-astra", review: true }).seen.argv;
  assert.equal(codexReview[codexReview.indexOf("--sandbox") + 1], "workspace-write", "t140: read-only refused mkdtemp, so astra could not run a test that makes a scratch folder");
  const agy = run("antigravity", s, { model: "gemini-3.1-pro" }).seen.argv;
  assert.equal(agy[agy.indexOf("--model") + 1], "gemini-3.1-pro-high");
  const argon = run("antigravity", s, { model: "gemini-4-argon" }).seen.argv;
  assert.equal(argon[argon.indexOf("--model") + 1], "gemini-4-argon-high", "Gemini 4 Argon runs at its high setting");
  // d14 (2026-10-13): Antigravity builds run without the terminal sandbox; reviews keep it.
  assert.ok(!agy.includes("--sandbox"), "an Antigravity build runs without the terminal sandbox");
  assert.ok(run("antigravity", s, { model: "gemini-3.1-pro", review: true }).seen.argv.includes("--sandbox"), "an Antigravity review keeps the sandbox");
  assert.deepEqual(run("opencode", s, { model: "deepseek-v4-pro" }).seen.argv, ["run", "--model", "deepseek-api/deepseek-v4-pro", "--format", "json"]);
  assert.equal(claudeModel("sonnet-5.5"), "claude-sonnet-5-5");
  assert.equal(claudeModel("claude-fable-5-1"), "claude-fable-5-1");
});

// t683: opencode 2's run joins a shared background service, with a data folder
// of its own, unless it is given --standalone; opencode 1 gets its old argv.
test("the opencode adapter, run as a process, passes --standalone on opencode 2 only, and keeps the run's own data folder", (t) => {
  const s = setup(t);
  const two = run("opencode", s, { model: "deepseek-v4-pro", env: { FAKE_VERSION: "opencode v2.0.29" } }).seen;
  assert.deepEqual(two.argv, ["run", "--standalone", "--model", "deepseek-api/deepseek-v4-pro", "--format", "json"]);
  assert.match(two.env.XDG_DATA_HOME, /atelier-opencode-run-.*[\\/]data$/);
  assert.deepEqual(run("opencode", s, { model: "deepseek-v4-pro", env: { FAKE_VERSION: "1.18.34" } }).seen.argv, ["run", "--model", "deepseek-api/deepseek-v4-pro", "--format", "json"]);
  const calls = () => readFileSync(`${s.record}.version`, "utf8").trim().split("\n").length;
  rmSync(`${s.record}.version`);
  run("opencode", s, { model: "deepseek-v4-pro", review: true, env: { FAKE_VERSION: "2.0.29", FAKE_ANSWER: "no verdict here", FAKE_FOLLOW_UP: "VERDICT: APPROVE" } });
  assert.equal(calls(), 1, "the version is asked once although the review runs twice");
  assert.deepEqual(JSON.parse(readFileSync(`${s.record}.calls`, "utf8").trim().split("\n").at(-1)).argv, ["run", "--standalone", "--model", "deepseek-api/deepseek-v4-pro", "--continue", "--format", "json"]);
});

test("the provider config the opencode adapter is given keeps opencode 1's deny, and the adapter adds opencode 2's at run time", (t) => {
  const s = setup(t);
  const seen = run("opencode", s, { model: "deepseek-v4-pro", env: { FAKE_VERSION: "2.0.29" } }).seen;
  const config = JSON.parse(readFileSync(seen.env.OPENCODE_CONFIG, "utf8"));
  assert.equal(config.permission.external_directory, "deny");
  assert.equal("permissions" in config, false, "the stored config here was written with no V2 key (an installation from before t683)");
  assert.deepEqual(JSON.parse(seen.env.OPENCODE_CONFIG_CONTENT), { permissions: [{ action: "external_directory", resource: "*", effect: "deny" }] });
  assert.equal(run("opencode", s, { model: "deepseek-v4-pro", env: { FAKE_VERSION: "1.18.34" } }).seen.env.OPENCODE_CONFIG_CONTENT, undefined);
});

// The finding on t683: an unreadable version was run as opencode 1.
test("the opencode adapter refuses to run when `--version` prints no version", (t) => {
  const s = setup(t);
  const env = { PATH: process.env.PATH, HOME: s.dir, ATELIER_OPENCODE: s.fake, FAKE_VERSION: "unknown", CF_AIG_METADATA: gatewayMetadata("t9", "build", "home:mbp") };
  const r = spawnSync(process.execPath, [join(repo, "bin", "harness", ADAPTERS.opencode), "--providers", s.providers, "--secret-store", "file", "--secrets-dir", s.store, "deepseek-v4-pro", s.brief, s.ws, "undefined", "undefined", "undefined"], { encoding: "utf8", env, timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not read the version of .*no run was started/);
  assert.equal(existsSync(s.record), false, "opencode itself was never run");
});

test("codex runs with its MCP features off and its config.toml servers switched off by name, checked against codex", (t) => {
  // The findings on 71346e21 and b8d81cf3 (codex-cli 0.160.0): -c
  // mcp_servers={} left servers enabled, and enabled=false on a server a
  // plugin or app provides broke the configuration load, so those go through
  // --disable FEATURE and only config.toml's servers are switched off by name.
  const s = setup(t);
  const servers = [
    { name: "node_repl", enabled: true, transport: { type: "stdio", command: "repl" } },
    { name: "safari-mcp-stp", enabled: false, transport: { type: "stdio", command: "safari" } },
    { name: "code-review", feature: "plugins", enabled: true },
    { name: "codex_app", feature: "apps", enabled: true },
    { name: "cua_repl", feature: "computer_use", enabled: true },
  ];
  for (const review of [false, true]) {
    rmSync(s.record + ".mcp", { force: true });
    const { r, seen } = run("codex", s, { model: "gpt-6-astra", review, env: { FAKE_MCP_LIST: JSON.stringify(servers) } });
    assert.equal(r.status, 0, r.stderr);
    const flags = seen.argv.slice(0, seen.argv.indexOf("exec"));
    for (const feature of ["plugins", "apps", "browser_use", "browser_use_external", "computer_use", "in_app_browser"]) {
      assert.ok(flags.some((a, i) => a === feature && flags[i - 1] === "--disable"), `--disable ${feature} (review: ${review})`);
    }
    const overrides = flags.filter((a, i) => flags[i - 1] === "-c");
    assert.deepEqual(overrides, ["mcp_servers.node_repl.enabled=false", "mcp_servers.safari-mcp-stp.enabled=false"], "only config.toml's servers by name");
    // Listed twice from the workspace: once to find config.toml's servers with
    // the features off, once with the job's very flags, where codex loaded.
    const calls = readFileSync(s.record + ".mcp", "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].argv, [...CODEX_FEATURES_OFF, "mcp", "list", "--json"]);
    assert.deepEqual(calls[1].argv, [...flags, "mcp", "list", "--json"], "the job's flags are the ones checked");
    // A review starts in its scratch folder and lists from there (Astra on
    // 9a9228b5); a build starts in the clone and lists from it.
    for (const call of calls) {
      if (review) { assert.equal(dirname(call.cwd), realpathSync(s.tmp)); assert.match(call.cwd, /atelier-codex-review-/); }
      else assert.equal(call.cwd, realpathSync(s.ws), "listed from the workspace, so a project's own servers are found too");
    }
  }
});

test("the stand-in fails as codex does on enabled=false for a plugin's server, which the old flags hit", (t) => {
  const s = setup(t);
  const r = spawnSync(s.fake, ["-c", "mcp_servers.code-review.enabled=false", "mcp", "list", "--json"],
    { encoding: "utf8", env: { ...process.env, HOME: s.dir, FAKE_MCP_LIST: JSON.stringify([{ name: "code-review", feature: "plugins", enabled: true }]) } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid transport in mcp_servers\.code-review/);
});

// The owner's note on round 6: the generated flags are checked against the
// codex installed on the machine, with its own configuration, when there is one.
// It runs under a home of its own: codex writes .codex/ to its home even for
// --version, and this file must leave nothing in the worktree or the owner's home.
const codexHome = mkdtempSync(join(tmpdir(), "atelier-codex-home-"));
mkdirSync(join(codexHome, ".codex"));
const codexEnv = { ...process.env, HOME: codexHome, CODEX_HOME: join(codexHome, ".codex") };
after(() => rmSync(codexHome, { recursive: true, force: true }));
const realCodex = spawnSync("codex", ["--version"], { encoding: "utf8", env: codexEnv }).status === 0;
test("the real codex loads its configuration with the generated flags and lists no MCP server enabled", { skip: !realCodex && "codex is not installed" }, () => {
  const ws = mkdtempSync(join(tmpdir(), "atelier-codex-"));
  const env = codexEnv;
  try {
    const flags = codexNoMcpFlags("codex", ws, env);
    assert.deepEqual(flags.slice(0, CODEX_FEATURES_OFF.length), CODEX_FEATURES_OFF);
    const r = spawnSync("codex", [...flags, "mcp", "list", "--json"], { cwd: ws, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const listed = JSON.parse(r.stdout);
    const servers = Array.isArray(listed) ? listed : Object.entries(listed.servers ?? listed).map(([name, s]) => ({ name, ...s }));
    assert.deepEqual(servers.filter((s) => s.enabled !== false).map((s) => s.name), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("codex does not run when its MCP servers cannot be listed, named safely or all switched off", (t) => {
  const s = setup(t);
  for (const env of [{ FAKE_MCP_FAIL: "1" }, { FAKE_MCP_LIST: "not json" }, { FAKE_MCP_LIST: JSON.stringify([{ name: "a.b" }]) },
    { FAKE_MCP_LIST: JSON.stringify([{ name: "node_repl", enabled: true }]), FAKE_MCP_STUCK: "1" }]) {
    rmSync(s.record, { force: true });
    const verdict = join(s.dir, "verdict.md");
    const r = spawnSync(process.execPath, [join(repo, "bin", "harness", ADAPTERS.codex), "gpt-6-astra", s.brief, s.ws, "undefined", "undefined", "undefined"],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: s.dir, ATELIER_CODEX: s.fake, ...env } });
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.match(r.stderr, /MCP server/);
    assert.throws(() => readFileSync(s.record), "codex was never started for the job");
    assert.throws(() => readFileSync(verdict));
  }
});

test("a plan job is told where to write the plan and to commit nothing", (t) => {
  const s = setup(t);
  const { r, seen } = run("claude-code", s, { model: "opus-5.5", plan: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(seen.input, /This is a plan job: write the plan document, as JSON, to plan\.json and commit nothing\./);
  assert.doesNotMatch(seen.input.slice(0, 2000), /git commit -m/);
});

test("the opencode adapter reads its key and the gateway token from the credential store, and its config parses after opencode's substitution", (t) => {
  const s = setup(t);
  const { r, seen } = run("opencode", s, { model: "deepseek-v4-pro" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(seen.env.OPENCODE_CONFIG, join(s.providers, "deepseek-api.json"));
  assert.equal(seen.env.DEEPSEEK_API_KEY, "DUMMY-deepseek");
  assert.equal(seen.env.CF_AIG_TOKEN, "DUMMY-gateway");
  // The store's names reach the store alone, never opencode.
  assert.equal(seen.env.ATELIER_SECRET_STORE, undefined);
  assert.equal(seen.env.ATELIER_CONFIG_DIR, undefined);
  // What opencode does: substitute into the raw text, then parse.
  const config = JSON.parse(substituteEnv(readFileSync(seen.env.OPENCODE_CONFIG, "utf8"), seen.env));
  const options = config.provider["deepseek-api"].options;
  assert.equal(options.apiKey, "DUMMY-deepseek");
  assert.equal(options.headers["cf-aig-authorization"], "Bearer DUMMY-gateway");
  assert.deepEqual(JSON.parse(options.headers["cf-aig-metadata"]), { task: "t9", role: "build", runner: "home:mbp" });
});

test("opencode runs with the generated config alone: no global, project or inherited config reaches it", (t) => {
  // The finding on 84358a17: OPENCODE_CONFIG merges with the global config
  // (~/.config/opencode) and the project's, so their MCP servers and
  // permissions reached the run.
  const s = setup(t);
  const global = join(s.dir, ".config", "opencode");
  mkdirSync(global, { recursive: true });
  writeFileSync(join(global, "opencode.json"), JSON.stringify({ mcp: { leak: { type: "local", command: ["leak"] } } }));
  writeFileSync(join(s.ws, "opencode.json"), JSON.stringify({ permission: { external_directory: "allow" } }));
  const { r, seen } = run("opencode", s, { model: "deepseek-v4-pro", env: {
    XDG_CONFIG_HOME: join(s.dir, ".config"), OPENCODE_CONFIG_DIR: global, OPENCODE_CONFIG_CONTENT: '{"mcp":{"x":{}}}', OPENCODE_PERMISSION: '{"bash":"allow"}',
  } });
  assert.equal(r.status, 0, r.stderr);
  const home = seen.env.XDG_CONFIG_HOME;
  assert.ok(home && home !== join(s.dir, ".config"), "a config folder of the run's own");
  assert.ok(!dirname(home).startsWith(s.ws), "outside the workspace");
  assert.deepEqual(seen.configHome, [], "and empty: no global config in it");
  assert.equal(seen.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1", "the workspace's own opencode config is not read");
  assert.equal(seen.env.OPENCODE_DISABLE_CLAUDE_CODE, "1", "nor ~/.claude");
  for (const name of ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION"]) assert.equal(seen.env[name], undefined, name);
  assert.equal(seen.env.OPENCODE_CONFIG, join(s.providers, "deepseek-api.json"));
  assert.throws(() => readdirSync(home), /ENOENT/, "removed as the run ends");
});

test("opencode runs with a HOME and XDG folders of the run's own, so no ~/.opencode config reaches it, and git keeps the owner's identity", (t) => {
  // The finding on 84644528: opencode reads ~/.opencode whatever
  // OPENCODE_DISABLE_PROJECT_CONFIG says, so its MCP servers and permissions
  // reached the run while HOME was the owner's.
  const s = setup(t);
  mkdirSync(join(s.dir, ".opencode"));
  writeFileSync(join(s.dir, ".opencode", "opencode.json"), JSON.stringify({ mcp: { leak: { type: "local", command: ["leak"] } }, permission: { bash: "allow" } }));
  writeFileSync(join(s.dir, ".gitconfig"), "[user]\n\tname = Owner\n\temail = owner@example.com\n");
  const { r, seen } = run("opencode", s, { model: "deepseek-v4-pro", env: {
    XDG_DATA_HOME: join(s.dir, ".local", "share"), XDG_CACHE_HOME: join(s.dir, ".cache"), XDG_STATE_HOME: join(s.dir, ".local", "state"),
  } });
  assert.equal(r.status, 0, r.stderr);
  const own = dirname(seen.env.XDG_CONFIG_HOME);
  assert.ok(seen.env.HOME && seen.env.HOME !== s.dir, "a HOME of the run's own");
  assert.deepEqual(seen.home, [], "and empty: no .opencode in it");
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    assert.equal(dirname(seen.env[name]), own, `${name} is in the run's folder`);
  }
  assert.ok(!own.startsWith(s.ws) && !own.startsWith(s.dir), "outside the workspace and the owner's HOME");
  assert.throws(() => readdirSync(own), /ENOENT/, "removed as the run ends");
  assert.equal(seen.env.GIT_CONFIG_GLOBAL, join(s.dir, ".gitconfig"), "git still commits as the owner");
  // A GIT_CONFIG_GLOBAL the runner gives stays.
  assert.equal(run("opencode", s, { model: "deepseek-v4-pro", env: { GIT_CONFIG_GLOBAL: "/elsewhere/gitconfig" } }).seen.env.GIT_CONFIG_GLOBAL, "/elsewhere/gitconfig");
});

test("docs/runners.md logs in with the server, as atelier login requires", () => {
  // The finding on 84644528: the fresh-machine steps said `atelier login`
  // alone, which the CLI refuses.
  const text = readFileSync(join(repo, "docs", "runners.md"), "utf8");
  const logins = [...text.matchAll(/`atelier login([^`]*)`/g)].map((m) => m[1]);
  assert.ok(logins.some((rest) => /--server \S+/.test(rest)), "a step logs in with --server");
  for (const rest of logins) assert.match(rest, /--server|--store/, `atelier login${rest}`);
});

test("a missing key stops the opencode adapter, naming the entry and never a value", (t) => {
  const s = setup(t);
  writeFileSync(join(s.store, "secrets.json"), JSON.stringify({ CF_AIG_TOKEN: "DUMMY-gateway" }), { mode: 0o600 });
  const errors = [];
  const status = runAdapter("opencode", ["--providers", s.providers, "deepseek-v4-pro", s.brief, s.ws, "undefined", "undefined", "undefined"],
    { env: { PATH: process.env.PATH, ATELIER_OPENCODE: s.fake }, secret: () => null, stderr: (text) => errors.push(text), spawn: () => assert.fail("opencode must not start") });
  assert.equal(status, 1);
  assert.match(errors.join(""), /no key for deepseek-api: store it in the credential store as deepseek\.API_KEY/);
});

test("the runner's JSON metadata, substituted naively, breaks the config; escaped, it parses to the same object", () => {
  const raw = gatewayMetadata("t389", "build", "home:mbp-2");
  const text = JSON.stringify(opencodeConfig("openrouter-api", [{ providerModel: "x/y", atelierId: "x-y", limit: { context: 100000, output: 8000 } }], { gateway: { account: "a", id: "atelier" } }));
  // The 2026-10-09 failure: the raw JSON in a JSON string.
  assert.throws(() => JSON.parse(text.replace(`{env:${METADATA_VAR}}`, raw)));
  const parsed = JSON.parse(substituteEnv(text, { [METADATA_VAR]: metadataEscaped(raw) }));
  const header = parsed.provider["openrouter-api"].options.headers["cf-aig-metadata"];
  assert.equal(header, raw);
  assert.deepEqual(JSON.parse(header), { task: "t389", role: "build", runner: "home:mbp-2" });
  // Anything that is not a JSON object is sent as {}, never as broken text.
  assert.equal(JSON.parse(`"${metadataEscaped('{"a":')}"`), "{}");
  assert.equal(JSON.parse(`"${metadataEscaped('{"task":"a\\"b\\\\c"}')}"`), '{"task":"a\\"b\\\\c"}');
});

test("no adapter or catalogue file holds a key", () => {
  for (const dir of ["bin/harness", "cli/harness"]) {
    for (const name of readdirSync(join(repo, dir))) {
      const text = readFileSync(join(repo, dir, name), "utf8");
      assert.equal(redactKeys(text), text, `${dir}/${name} carries something shaped like a key`);
      assert.doesNotMatch(text, /apiKey:\s*"(?!\{env:)/, `${dir}/${name} sets an apiKey other than from the environment`);
    }
  }
});

test("an entry with no command runs the adapter Atelier ships, with every placeholder", () => {
  const { agents, errors } = parseConfig({ jobs: ["build", "review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "opencode", models: ["glm-5.3"] }] }, { configPath: "/cfg/runner.json" });
  assert.deepEqual(errors, []);
  assert.equal(agents[0].command[0], process.execPath);
  assert.equal(agents[0].command[1], join(repo, "bin", "harness", "atelier-codex.mjs"));
  // Each runner config has a provider folder of its own, named after it.
  assert.deepEqual(agents[1].command.slice(2, 4), ["--providers", "/cfg/opencode/runner.json"]);
  // The runner's credential store goes to the opencode adapter as arguments.
  const named = parseConfig({ agents: [{ agent: "opencode", models: ["glm-5.3"] }] }, { configPath: "/cfg/review.json", env: { ATELIER_SECRET_STORE: "file", ATELIER_CONFIG_DIR: "/secrets" } });
  assert.deepEqual(named.agents[0].command.slice(2, 8), ["--providers", "/cfg/opencode/review.json", "--secret-store", "file", "--secrets-dir", "/secrets"]);
  assert.deepEqual(parseConfig({ agents: [{ agent: "opencode", models: ["glm-5.3"] }] }, { configPath: "/cfg/runner.json", env: {} }).agents[0].command.slice(4, 5), ["{model}"]);
  const argv = commandFor(agents[0], { model: "gpt-6-astra", briefFile: "/b", workspace: "/w", planFile: undefined, diffFile: undefined, verdictFile: undefined });
  assert.deepEqual(argv.slice(2), ["gpt-6-astra", "/b", "/w", "undefined", "undefined", "undefined"]);
  assert.deepEqual(parseArgs(argv.slice(2)).plan, null);
  for (const agent of ["claude-code", "codex", "opencode", "antigravity"]) assert.ok(defaultCommand(agent).includes("{verdict_file}"), agent);
  assert.match(parseConfig({ agents: [{ agent: "zcode", models: ["glm-5.3"] }] }).errors.join(), /ships no adapter for zcode; give its command/);
  // A command the owner gives still wins.
  assert.deepEqual(parseConfig({ agents: [{ agent: "codex", models: ["m"], command: ["my-codex", "{model}", "{brief_file}"] }] }).agents[0].command, ["my-codex", "{model}", "{brief_file}"]);
});

// t698: the opencode adapter runs an OpenRouter model, refuses a Claude one,
// and bounds and retries a MiMo run that hangs or drops its connection.
function routed(t, models) {
  const s = setup(t);
  writeFileSync(join(s.providers, "openrouter-api.json"), JSON.stringify(opencodeConfig("openrouter-api", [{ providerModel: "xiaomi/mimo-v2.6-pro", atelierId: "mimo-v2.6-pro", limit: { context: 1000000, output: 32000 } }], { gateway: { account: "acct", id: "atelier" } })));
  const entry = (providerModel) => ({ provider: "openrouter-api", providerModel, config: "openrouter-api.json", key: "openrouter.API_KEY", keyVar: "OPENROUTER_API_KEY", gateway: true });
  writeFileSync(join(s.providers, "models.json"), JSON.stringify({ models: Object.fromEntries(models.map(([id, pm]) => [id, entry(pm)])) }));
  writeFileSync(join(s.store, "secrets.json"), JSON.stringify({ "openrouter.API_KEY": "DUMMY-or", CF_AIG_TOKEN: "DUMMY-gateway" }), { mode: 0o600 });
  for (const argv of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]]) spawnSync("git", argv, { cwd: s.ws });
  return s;
}

// An opencode that does what ACTS says on its nth run: "ok", "hang", "reset"
// (a transport error on stderr, exit 1) or "commit" (commit, then reset).
function scripted(s, acts) {
  const counter = join(s.dir, "count");
  rmSync(counter, { force: true });
  writeFileSync(s.fake, `#!${process.execPath}
const fs = require("node:fs"), cp = require("node:child_process");
if (process.argv[2] === "--version") { process.stdout.write("2.0.29\\n"); process.exit(0); }
fs.readFileSync(0);
const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
const act = ${JSON.stringify(acts)}[n] ?? "ok";
if (act === "hang") setTimeout(() => {}, 60000);
else if (act === "hang-child") {
  const kid = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(counter + ".kid")}, String(kid.pid));
  setTimeout(() => {}, 60000);
} else if (act === "ok-after-child") {
  let alive = true;
  try { process.kill(Number(fs.readFileSync(${JSON.stringify(counter + ".kid")}, "utf8")), 0); } catch { alive = false; }
  fs.writeFileSync(${JSON.stringify(counter + ".alive")}, String(alive));
  process.exit(0);
}
else if (act === "ok") process.exit(0);
else { if (act === "commit") cp.spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "work"]); process.stderr.write("fetch failed: ECONNRESET\\n"); process.exit(1); }
`);
  return () => (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0);
}

function runRouted(s, model, limitMs = 1500) {
  const out = [];
  const status = runAdapter("opencode", ["--providers", s.providers, "--secret-store", "file", "--secrets-dir", s.store, model, s.brief, s.ws, "undefined", "undefined", "undefined"],
    { env: { PATH: process.env.PATH, HOME: s.dir, ATELIER_OPENCODE: s.fake, CF_AIG_METADATA: gatewayMetadata("t9", "build", "home:mbp") }, stderr: (x) => out.push(x), limitMs });
  return { status, stderr: out.join("") };
}

test("the opencode adapter runs an OpenRouter model with its provider model id", (t) => {
  const s = routed(t, [["mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro"]]);
  const seen = run("opencode", s, { model: "mimo-v2.6-pro", env: { FAKE_VERSION: "2.0.29" } }).seen;
  assert.deepEqual(seen.argv.slice(0, 4), ["run", "--standalone", "--model", "openrouter-api/xiaomi/mimo-v2.6-pro"]);
  assert.equal(seen.env.OPENROUTER_API_KEY, "DUMMY-or");
  assert.equal(seen.env.CF_AIG_TOKEN, "DUMMY-gateway");
  assert.deepEqual(JSON.parse(seen.env.OPENCODE_CONFIG_CONTENT).permissions[0].effect, "deny");
});

test("the opencode adapter refuses a Claude model through OpenRouter and never starts opencode", (t) => {
  const s = routed(t, [["claude-sonnet-5.5", "anthropic/claude-sonnet-5.5"]]);
  const count = scripted(s, []);
  const r = runRouted(s, "claude-sonnet-5.5");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no prompt caching.*claude-code/);
  assert.equal(count(), 0);
});

test("a MiMo run that hangs past its time limit with no commit is run once more", (t) => {
  const s = routed(t, [["mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro"]]);
  const count = scripted(s, ["hang", "ok"]);
  const r = runRouted(s, "mimo-v2.6-pro");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(), 2);
  assert.match(r.stderr, /no commit and a transport error \(time limit\); running it once more/);
});

test("a timed-out attempt's whole process group has ended before the retry starts", (t) => {
  const s = routed(t, [["mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro"]]);
  const count = scripted(s, ["hang-child", "ok-after-child"]);
  t.after(() => { try { process.kill(Number(readFileSync(join(s.dir, "count.kid"), "utf8")), "SIGKILL"); } catch { /* gone */ } });
  const r = runRouted(s, "mimo-v2.6-pro");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(), 2);
  assert.equal(readFileSync(join(s.dir, "count.alive"), "utf8"), "false", "the first attempt's child was still running when the retry started");
});

// The shipped path (bin/harness/atelier-opencode.mjs) runs the adapter through
// runWithLimits, whose spawn captures stderr on a pipe and returns it.
test("a MiMo connection drop is retried through the shipped runWithLimits path too", (t) => {
  const s = routed(t, [["mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro"]]);
  const count = scripted(s, ["reset", "ok"]);
  const out = [];
  const status = runWithLimits("opencode", ["--providers", s.providers, "--secret-store", "file", "--secrets-dir", s.store, "mimo-v2.6-pro", s.brief, s.ws, "undefined", "undefined", "undefined"],
    { env: { PATH: process.env.PATH, HOME: s.dir, ATELIER_OPENCODE: s.fake, CF_AIG_METADATA: gatewayMetadata("t9", "build", "home:mbp") }, stderr: (x) => out.push(x), limitMs: 1500 });
  assert.equal(status, 0, out.join(""));
  assert.equal(count(), 2);
  assert.match(out.join(""), /transport error \(stderr\); running it once more/);
});

test("a MiMo run that drops its connection with no commit is run once more, but only once", (t) => {
  const s = routed(t, [["mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro"]]);
  const count = scripted(s, ["reset", "reset", "ok"]);
  const r = runRouted(s, "mimo-v2.6-pro");
  assert.equal(r.status, 1);
  assert.equal(count(), 2);
  assert.match(r.stderr, /ECONNRESET/);
});

test("a MiMo run that committed before the connection dropped is not run again, nor is any other model", (t) => {
  const s = routed(t, [["mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro"], ["qwen3.8-max", "qwen/qwen3.8-max-0902"]]);
  const count = scripted(s, ["commit", "ok"]);
  assert.equal(runRouted(s, "mimo-v2.6-pro").status, 1);
  assert.equal(count(), 1);
  const other = scripted(s, ["reset", "ok"]);
  assert.equal(runRouted(s, "qwen3.8-max").status, 1);
  assert.equal(other(), 1, "only MiMo is retried");
});

// t717, astra's review of round 1: a verification runs as a review job, so the
// adapter put the ordinary VERDICT_DEMAND after the verifier's own format, and
// a verifier that followed the last instruction answered in a shape
// parseVerification cannot read. The composed prompt, as each harness is given
// it, is checked here and not only the runner's stand-in.
test("a verification is given the verification format and never the review's VERDICT and FINDING lines, by every harness", (t) => {
  const s = setup(t);
  writeFileSync(s.brief, verifierBrief({ item: { id: "t9", title: "Landing" }, head: "a".repeat(40), findings: [{ file: "src/a.ts", line: 3, severity: "blocking", text: "It loses data." }], diffFile: s.diff }));
  for (const [harness, model] of [["claude-code", "opus-5.5"], ["codex", "gpt-6-astra"], ["opencode", "deepseek-v4-pro"], ["antigravity", "gemini-3.1-pro"]]) {
    const { seen, verdict } = run(harness, s, { model, review: true, env: { FAKE_ANSWER: "I read src/a.ts.\nFINDING 1: CONFIRMED because line 3 drops the row." } });
    assert.ok(seen.input.includes("# Verification of findings on t9"), harness);
    assert.ok(seen.input.trimEnd().endsWith(VERIFY_DEMAND), `${harness}: the prompt ends with the verification format`);
    assert.ok(!seen.input.includes(VERDICT_DEMAND) && !seen.input.includes("VERDICT: "), `${harness}: no review format in the prompt`);
    const read = parseVerification(readFileSync(verdict, "utf8"), 1);
    assert.ok(read.ok && read.confirmed.has(1), harness);
  }
  // A reply with no VERDICT line is not asked again for one: a verification has none.
  const calls = readFileSync(`${s.record}.calls`, "utf8").trim().split("\n");
  assert.equal(calls.length, 4, "one run for each harness, no follow-up ask");
  // An ordinary review brief still ends with the review's own demand.
  writeFileSync(s.brief, "# Review of t9 at aaaaaaaa\nReview it.\n");
  assert.ok(run("claude-code", s, { model: "opus-5.5", review: true }).seen.input.trimEnd().endsWith(VERDICT_DEMAND));
});

// t717, round 4 (head d71c7d3f): the last instruction of the prompt allowed only
// CONFIRMED and NOT CONFIRMED, over the brief's PRE-EXISTING, so the base rule
// could never trigger in production. With a base the final demand offers all three.
test("a verification brief with a base is given a final demand offering CONFIRMED, NOT CONFIRMED and PRE-EXISTING, by every harness, and each answer parses", (t) => {
  const s = setup(t);
  const input = { item: { id: "t9", title: "Landing" }, head: "a".repeat(40), findings: [1, 2, 3].map((n) => ({ file: "src/a.ts", line: n, severity: "blocking", text: `Defect ${n}.` })), diffFile: s.diff };
  const answer = "FINDING 1: CONFIRMED because line 1 drops the row.\nFINDING 2: NOT CONFIRMED because the test passes.\nFINDING 3: PRE-EXISTING because git show base:src/a.ts reads the same at line 3.";
  for (const [harness, model] of [["claude-code", "opus-5.5"], ["codex", "gpt-6-astra"], ["opencode", "deepseek-v4-pro"], ["antigravity", "gemini-3.1-pro"]]) {
    writeFileSync(s.brief, verifierBrief({ ...input, base: "0".repeat(40) }));
    const { seen, verdict } = run(harness, s, { model, review: true, env: { FAKE_ANSWER: answer } });
    const tail = seen.input.trimEnd();
    assert.ok(tail.endsWith(VERIFY_DEMAND_BASE), `${harness}: the prompt ends with the demand that offers PRE-EXISTING`);
    for (const form of ["FINDING n: CONFIRMED because", "FINDING n: NOT CONFIRMED because", "FINDING n: PRE-EXISTING because"]) assert.ok(VERIFY_DEMAND_BASE.includes(form), `${harness}: ${form}`);
    assert.ok(seen.input.includes("FINDING 3: PRE-EXISTING because"), `${harness}: the brief offers it too`);
    const read = parseVerification(readFileSync(verdict, "utf8"), 3);
    assert.ok(read.ok, harness);
    assert.deepEqual([[...read.confirmed], [...read.preExisting]], [[1], [3]], harness);
    // Without a base the demand is the one it was, and offers no PRE-EXISTING.
    writeFileSync(s.brief, verifierBrief(input));
    const plain = run(harness, s, { model, review: true, env: { FAKE_ANSWER: answer } }).seen.input.trimEnd();
    assert.ok(plain.endsWith(VERIFY_DEMAND) && !plain.includes("PRE-EXISTING"), `${harness}: no base, no PRE-EXISTING`);
  }
});

// t140: gpt-6-astra reviewed t68, t58 and t136 by inspection only, because
// `codex exec -s read-only` refuses mkdtemp under os.tmpdir() (EPERM) and so
// every test that makes a scratch folder. A review now runs workspace-write
// in a fresh empty folder outside the clone.
function codexReviewIn(t, spawnResult) {
  const s = setup(t);
  const seen = [];
  const spawn = (exe, argv, options) => {
    if (argv.includes("mcp")) return { status: 0, stdout: "[]" };
    const cwd = options.cwd;
    seen.push({ argv, cwd, existed: existsSync(cwd), entries: readdirSync(cwd), input: options.input });
    return spawnResult;
  };
  const err = [];
  const status = runAdapter("codex", ["gpt-6-astra", s.brief, s.ws, "undefined", s.diff, join(s.dir, "verdict.md")], { env: { PATH: process.env.PATH, HOME: s.dir }, tmp: s.tmp, spawn, stderr: (x) => err.push(x) });
  return { s, seen, status, err: err.join("") };
}

test("a codex review runs workspace-write in a fresh empty folder outside the clone, named in the prompt, and the folder is removed", (t) => {
  const { s, seen, status } = codexReviewIn(t, { status: 0 });
  assert.equal(status, 0);
  assert.equal(seen.length, 1);
  const { argv, cwd, existed, entries, input } = seen[0];
  assert.ok(existed && entries.length === 0, "an existing, empty folder");
  assert.equal(argv[argv.indexOf("--cd") + 1], cwd, "codex is rooted in the scratch folder");
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "workspace-write");
  const overrides = argv.filter((a, i) => argv[i - 1] === "-c");
  assert.deepEqual(overrides.filter((a) => a.startsWith("sandbox_workspace_write")), ["sandbox_workspace_write.writable_roots=[]", "sandbox_workspace_write.network_access=false"], "a config.toml cannot reopen the clone, its .git or the network (Astra on 3db03d0d)");
  assert.ok(!argv.includes(s.ws), "the clone is not a root of the run");
  assert.equal(dirname(cwd), realpathSync(s.tmp), "made under the system temp folder");
  assert.ok(!cwd.startsWith(s.ws) && !s.ws.startsWith(cwd), "outside the clone");
  assert.ok(input.includes(`The clone under review is ${s.ws}`), "the prompt names the clone");
  assert.ok(input.endsWith(VERDICT_DEMAND));
  assert.equal(existsSync(cwd), false, "removed after success");
});

test("a codex review's scratch folder is removed after a nonzero exit and after a spawn failure", (t) => {
  const failed = codexReviewIn(t, { status: 3 });
  assert.equal(failed.status, 3);
  assert.equal(existsSync(failed.seen[0].cwd), false);
  const broken = codexReviewIn(t, { error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) });
  assert.equal(broken.status, 1);
  assert.match(broken.err, /could not run codex/);
  assert.equal(existsSync(broken.seen[0].cwd), false);
});

test("a codex review that cannot start leaves no scratch folder, and a build gets none and runs in the clone", (t) => {
  const s = setup(t);
  const status = runAdapter("codex", ["gpt-6-astra", s.brief, s.ws, "undefined", s.diff, join(s.dir, "verdict.md")], { env: { PATH: process.env.PATH, HOME: s.dir }, tmp: s.tmp, spawn: () => ({ status: 1, stdout: "" }), stderr: () => {} });
  assert.equal(status, 1, "codex's MCP list failed, so the job did not run");
  assert.deepEqual(readdirSync(s.tmp), [], "no scratch folder left behind");
  const calls = [];
  runAdapter("codex", ["gpt-6-astra", s.brief, s.ws, "undefined", "undefined", "undefined"], { env: { PATH: process.env.PATH, HOME: s.dir }, spawn: (exe, argv, o) => { if (!argv.includes("mcp")) calls.push({ argv, cwd: o.cwd }); return argv.includes("mcp") ? { status: 0, stdout: "[]" } : { status: 0 }; }, stderr: () => {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, s.ws);
  assert.equal(calls[0].argv[calls[0].argv.indexOf("--cd") + 1], s.ws);
  assert.ok(calls[0].argv.some((a) => a.startsWith("sandbox_workspace_write.writable_roots=")), "a build's argv is unchanged");
});

// Astra on 9a9228b5, finding 1: the MCP servers were discovered from the clone
// but codex starts in the scratch folder, so a project-only server got a
// switch-off override into a configuration without it, which fails startup.
test("a codex review discovers its MCP servers from the scratch folder it starts in, not the clone", (t) => {
  const s = setup(t);
  const lists = [];
  const spawn = (exe, argv, options) => {
    if (!argv.includes("mcp")) return { status: 0 };
    const here = realpathSync(options.cwd);
    lists.push(here);
    const projectOnly = here === realpathSync(s.ws);
    const flagged = argv.some((a) => a === "mcp_servers.project-only.enabled=false");
    return { status: 0, stdout: JSON.stringify(projectOnly ? [{ name: "project-only", enabled: !flagged }] : []) };
  };
  const status = runAdapter("codex", ["gpt-6-astra", s.brief, s.ws, "undefined", s.diff, join(s.dir, "verdict.md")], { env: { PATH: process.env.PATH, HOME: s.dir }, tmp: s.tmp, spawn, stderr: () => {} });
  assert.equal(status, 0);
  assert.equal(lists.length, 2);
  for (const cwd of lists) assert.notEqual(cwd, realpathSync(s.ws), "not listed from the clone");
  const calls = [];
  const spawn2 = (exe, argv, options) => { if (argv.includes("mcp")) return spawn(exe, argv, options); calls.push(argv); return { status: 0 }; };
  runAdapter("codex", ["gpt-6-astra", s.brief, s.ws, "undefined", s.diff, join(s.dir, "verdict.md")], { env: { PATH: process.env.PATH, HOME: s.dir }, tmp: s.tmp, spawn: spawn2, stderr: () => {} });
  assert.ok(!calls[0].some((a) => a.includes("project-only")), "no override for a server the run never sees");
  // A build starts in the clone, so it still lists from there.
  lists.length = 0;
  runAdapter("codex", ["gpt-6-astra", s.brief, s.ws, "undefined", "undefined", "undefined"], { env: { PATH: process.env.PATH, HOME: s.dir }, tmp: s.tmp, spawn, stderr: () => {} });
  assert.ok(lists.every((cwd) => cwd === realpathSync(s.ws)));
});

// Astra on 9a9228b5, finding 2: workspace-write also writes the system temp
// folder, so a clone inside it (or TMPDIR naming the clone) would be writable.
test("a codex review refuses a clone inside the system temp folder, the temp folder itself as clone, and a temp folder inside the clone", (t) => {
  const s = setup(t);
  const never = () => assert.fail("codex was started");
  const review = (ws, tmp) => {
    const err = [];
    const status = runAdapter("codex", ["gpt-6-astra", s.brief, ws, "undefined", s.diff, join(s.dir, "verdict.md")], { env: { PATH: process.env.PATH, HOME: s.dir }, tmp, spawn: never, stderr: (x) => err.push(x) });
    return { status, err: err.join("") };
  };
  const inside = join(s.tmp, "clone");
  mkdirSync(inside);
  const a = review(inside, s.tmp);
  assert.equal(a.status, 1);
  assert.match(a.err, /is inside the temp folder/);
  const b = review(s.tmp, s.tmp);
  assert.equal(b.status, 1, "the temp folder is the clone");
  assert.match(b.err, /is inside the temp folder/);
  const clone = join(s.clones, "clone2");
  mkdirSync(join(clone, "tmp"), { recursive: true });
  const c = review(clone, join(clone, "tmp"));
  assert.equal(c.status, 1, "TMPDIR names a folder in the clone");
  assert.match(c.err, /inside the clone/);
  assert.deepEqual(readdirSync(join(clone, "tmp")), [], "no scratch folder left in the clone");
  // Through a symlink the real paths still overlap.
  const link = join(s.dir, "link");
  symlinkSync(s.tmp, link);
  assert.equal(review(join(link, "clone"), s.tmp).status, 1);
  // A build is not a review: it needs no scratch folder and is not refused.
  let started = 0;
  const build = runAdapter("codex", ["gpt-6-astra", s.brief, inside, "undefined", "undefined", "undefined"], { env: { PATH: process.env.PATH, HOME: s.dir }, tmp: s.tmp, spawn: (e, argv) => { if (!argv.includes("mcp")) started++; return argv.includes("mcp") ? { status: 0, stdout: "[]" } : { status: 0 }; }, stderr: () => {} });
  assert.equal(build, 0);
  assert.equal(started, 1);
});

// Astra on f0fa13da: Codex's workspace-write also permits /tmp, which is not
// TMPDIR on macOS (/var/folders/.../T), so a clone at /tmp/review-clone passed.
test("a codex review refuses a clone inside /tmp, $TMPDIR or another implicit temp folder when they differ from the system temp folder, and accepts a clone elsewhere", (t) => {
  const s = setup(t);
  const never = () => assert.fail("codex was started");
  const fakeTmp = mkdtempSync(join(tmpdir(), "atelier-fake-tmp-"));
  const envTmp = mkdtempSync(join(tmpdir(), "atelier-env-tmp-"));
  t.after(() => { rmSync(fakeTmp, { recursive: true, force: true }); rmSync(envTmp, { recursive: true, force: true }); });
  const review = (ws, extra = {}) => {
    const err = [];
    const status = runAdapter("codex", ["gpt-6-astra", s.brief, ws, "undefined", s.diff, join(s.dir, "verdict.md")], { env: { PATH: process.env.PATH, HOME: s.dir, ...extra.env }, tmp: s.tmp, tempRoots: extra.tempRoots, spawn: extra.spawn ?? never, stderr: (x) => err.push(x) });
    return { status, err: err.join("") };
  };
  // A stand-in /tmp that is not the system temp folder.
  mkdirSync(join(fakeTmp, "review-clone"));
  const a = review(join(fakeTmp, "review-clone"), { tempRoots: [fakeTmp] });
  assert.equal(a.status, 1);
  assert.match(a.err, /inside the temp folder \//, "names the root it is inside (the stand-in, or /tmp when TMPDIR is /tmp)");
  assert.equal(review(fakeTmp, { tempRoots: [fakeTmp] }).status, 1, "the temp folder itself");
  // $TMPDIR of the environment, apart from the system temp folder.
  mkdirSync(join(envTmp, "clone"));
  assert.equal(review(join(envTmp, "clone"), { env: { TMPDIR: envTmp } }).status, 1);
  // The real /tmp.
  if (existsSync("/tmp")) {
    const real = mkdtempSync("/tmp/atelier-t140-");
    t.after(() => rmSync(real, { recursive: true, force: true }));
    const r = review(real);
    assert.equal(r.status, 1);
    assert.match(r.err, /inside the temp folder (\/private)?\/tmp/);
  }
  // A clone in none of those folders (as ~/Library/Caches/ai-projects/... is) still runs.
  let started = 0;
  const spawn = (e, argv) => { if (!argv.includes("mcp")) started++; return argv.includes("mcp") ? { status: 0, stdout: "[]" } : { status: 0 }; };
  assert.equal(review(s.ws, { tempRoots: [fakeTmp], spawn }).status, 0);
  assert.equal(started, 1);
});
