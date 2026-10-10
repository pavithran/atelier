import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentRules, claudeModel, parseArgs, runAdapter } from "../cli/harness/adapter.mjs";
import { METADATA_VAR, metadataEscaped, opencodeConfig, substituteEnv } from "../cli/harness/providers.mjs";
import { defaultCommand, parseConfig } from "../cli/runner-config.mjs";
import { commandFor, gatewayMetadata } from "../cli/runner.mjs";
import { redactKeys } from "../src/models/pool.ts";

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
const input = fs.readFileSync(0, "utf8");
const argv = process.argv.slice(2);
const pick = ["OPENCODE_CONFIG", "DEEPSEEK_API_KEY", "CF_AIG_TOKEN", "CF_AIG_METADATA", "${METADATA_VAR}", "ATELIER_SECRET_STORE", "ATELIER_CONFIG_DIR",
  "XDG_CONFIG_HOME", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION",
  "HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "GIT_CONFIG_GLOBAL"];
const list = (dir) => dir && fs.existsSync(dir) ? fs.readdirSync(dir) : null;
const configHome = list(process.env.XDG_CONFIG_HOME), home = list(process.env.HOME);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, input, cwd: process.cwd(), configHome, home, env: Object.fromEntries(pick.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) }));
const answer = "VERDICT: APPROVE\\nSUMMARY: fine";
const at = argv.indexOf("--output-last-message");
if (at !== -1) fs.writeFileSync(argv[at + 1], answer);
else if (argv.includes("--output-format") && argv[argv.indexOf("--output-format") + 1] === "json") process.stdout.write(JSON.stringify({ response: answer }));
else process.stdout.write(answer);
`);
  chmodSync(path, 0o755);
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-adapters-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = join(dir, "ws"), record = join(dir, "record.json"), fake = join(dir, "fake-harness");
  mkdirSync(ws);
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
  return { dir, ws, record, fake, brief, diff, providers, store };
}

function run(harness, s, { model, review = false, plan = false, env: extraEnv = {} }) {
  const verdict = join(s.dir, "verdict.md");
  const args = [model, s.brief, s.ws, plan ? join(s.ws, "plan.json") : "undefined", review ? s.diff : "undefined", review ? verdict : "undefined"];
  // The store is named as the runner's default command names it: the runner
  // gives a harness no ATELIER_ variable.
  const extra = harness === "opencode" ? ["--providers", s.providers, "--secret-store", "file", "--secrets-dir", s.store] : [];
  const env = { PATH: process.env.PATH, HOME: s.dir, [OVERRIDE[harness]]: s.fake,
    CF_AIG_METADATA: gatewayMetadata("t9", review ? "review" : "build", "home:mbp"), ...extraEnv };
  const r = spawnSync(process.execPath, [join(repo, "bin", "harness", ADAPTERS[harness]), ...extra, ...args], { encoding: "utf8", env });
  return { r, seen: JSON.parse(readFileSync(s.record, "utf8")), verdict };
}

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
    assert.equal(readFileSync(verdict, "utf8"), "VERDICT: APPROVE\nSUMMARY: fine");
  });
}

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
  assert.deepEqual(codex.slice(0, 3), ["exec", "--model", "gpt-6-astra"]);
  assert.equal(codex.at(-1), "-", "codex reads the prompt from standard input");
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(run("codex", s, { model: "gpt-6-astra", review: true }).seen.argv[codex.indexOf("--sandbox") + 1], "read-only");
  const agy = run("antigravity", s, { model: "gemini-3.1-pro" }).seen.argv;
  assert.equal(agy[agy.indexOf("--model") + 1], "gemini-3.1-pro-high");
  assert.ok(agy.includes("--sandbox"));
  assert.deepEqual(run("opencode", s, { model: "deepseek-v4-pro" }).seen.argv, ["run", "--model", "deepseek-api/deepseek-v4-pro"]);
  assert.equal(claudeModel("sonnet-5.5"), "claude-sonnet-5-5");
  assert.equal(claudeModel("claude-fable-5-1"), "claude-fable-5-1");
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
