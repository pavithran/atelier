import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { checkLimits, HARNESS_START, PERMISSION, SERVED, CONFIGURED } from "../cli/harness/providers.mjs";
import { gatewayFrom, onPath, planSetup, runSetup, OPENROUTER_MODELS } from "../cli/runner-setup.mjs";
import { parseConfig } from "../cli/runner-config.mjs";

// t374: `atelier runner setup` writes a runner config for the harnesses on
// the machine and the pool's home models, and opencode provider configs whose
// limits fit what each provider serves and what the harness starts with.

const POOL = [
  { id: "opus-5.5", harness: "claude-code", where: "home", provider: "subscription" },
  { id: "gpt-6-astra", harness: "codex", where: "home", provider: "subscription" },
  { id: "gemini-3.1-pro", harness: "antigravity", where: "home", provider: "subscription" },
  { id: "glm-5.3", harness: "opencode", where: "home", provider: "openai-compatible", endpoint: "https://api.z.ai/api/coding/paas/v4" },
  { id: "deepseek-v4-pro", harness: "opencode", where: "home", provider: "deepseek", keychain: "deepseek.KEY2" },
  { id: "xiaomi-mimo-v2.6-pro", harness: "opencode", where: "home", provider: "openrouter" },
  { id: "GLM-5.3-Flash-4_8bit", harness: "opencode", where: "home", provider: "ai-studio", endpoint: "http://studio.local:1234/v1" },
  { id: "tiny-8k", harness: "opencode", where: "home", provider: "ai-studio", endpoint: "http://studio.local:1234/v1" },
  { id: "glm-5.3-cloud", harness: "opencode", where: "cloud", provider: "openrouter" },
  { id: "glm-5.3", harness: "zcode", where: "home", provider: "subscription" },
];
const LISTS = {
  [OPENROUTER_MODELS]: { data: [{ id: "xiaomi/mimo-v2.6-pro", context_length: 262144, top_provider: { context_length: 262144, max_completion_tokens: 65536 } }] },
  "http://studio.local:1234/v1/models": { data: [{ id: "GLM-5.3-Flash-4_8bit", loaded_context_length: 131072 }, { id: "tiny-8k", max_context_length: 8192 }] },
};
const fetchJson = async (url) => LISTS[url] ?? null;
const everything = () => true;

const plan = (over = {}) => planSetup({ configPath: "/cfg/runner.json", pool: POOL, env: {}, which: everything, fetchJson, ...over });
const file = (p, name) => JSON.parse(p.files.find((f) => f.path === join("/cfg", ...name)).text);

test("setup writes a runner config for the harnesses found, with the pool's home models and no command", async () => {
  const p = await plan({ which: (exe) => exe !== "agy" });
  assert.deepEqual(p.found, ["claude-code", "codex", "opencode"]);
  assert.deepEqual(p.config.agents, [
    { agent: "claude-code", models: ["opus-5.5"] },
    { agent: "codex", models: ["gpt-6-astra"] },
    { agent: "opencode", models: ["glm-5.3", "deepseek-v4-pro", "xiaomi-mimo-v2.6-pro", "GLM-5.3-Flash-4_8bit"] },
  ]);
  assert.ok(p.config.agents.every((a) => !("command" in a)), "the runner runs the shipped adapters");
  assert.ok(p.config.jobs.includes("build") && p.config.jobs.includes("review"));
  assert.equal(p.config.tokens["gpt-6-astra"], "agent.gpt-6-astra");
  assert.deepEqual(parseConfig(p.config, { configPath: "/cfg/runner.json" }).errors, []);
  assert.match(p.lines.join("\n"), /home models for antigravity, zcode, which are not installed here/);
  const written = file(p, ["runner.json"]);
  assert.deepEqual(written, p.config);
});

test("setup refuses a model whose context is below what opencode itself starts with", async () => {
  const p = await plan();
  assert.ok(!p.config.agents.find((a) => a.agent === "opencode").models.includes("tiny-8k"));
  const refusal = p.refused.find((r) => r.id === "tiny-8k");
  assert.match(refusal.why, new RegExp(`context of 8192 tokens is below the ${HARNESS_START.opencode} that opencode itself starts with`));
  assert.match(p.lines.join("\n"), /Refused:\n {2}opencode\/tiny-8k: /);
});

test("setup refuses a model whose configured context or output exceeds what its provider serves", async () => {
  // The 2026-10-09 mistake: a context above what OpenRouter serves.
  const configured = { "openrouter-api": { "xiaomi/mimo-v2.6-pro": { context: 400_000, output: 32_000 } }, "deepseek-api": { "deepseek-v4-pro": { context: 128_000, output: 100_000 } } };
  const p = await plan({ catalogue: { configured } });
  const why = Object.fromEntries(p.refused.map((r) => [r.id, r.why]));
  assert.match(why["xiaomi-mimo-v2.6-pro"], /configured for a context of 400000 tokens, but its provider serves 262144/);
  assert.match(why["deepseek-v4-pro"], /configured for 100000 output tokens, but its provider serves 64000/);
  assert.deepEqual(p.config.agents.find((a) => a.agent === "opencode").models, ["glm-5.3", "GLM-5.3-Flash-4_8bit"]);
  // Nothing served known: refused, not guessed.
  const unknown = await plan({ fetchJson: async () => null });
  assert.match(Object.fromEntries(unknown.refused.map((r) => [r.id, r.why]))["xiaomi-mimo-v2.6-pro"], /could not be read/);
});

test("setup refuses a model whose provider states no output limit, rather than taking the whole context", async () => {
  const lists = { ...LISTS, [OPENROUTER_MODELS]: { data: [{ id: "xiaomi/mimo-v2.6-pro", context_length: 262144, top_provider: { context_length: 262144, max_completion_tokens: null } }] } };
  const p = await plan({ fetchJson: async (url) => lists[url] ?? null });
  const refusal = p.refused.find((r) => r.id === "xiaomi-mimo-v2.6-pro");
  assert.ok(refusal, "refused");
  assert.match(refusal.why, /states no output limit for xiaomi-mimo-v2\.6-pro/);
  assert.ok(!p.config.agents.find((a) => a.agent === "opencode").models.includes("xiaomi-mimo-v2.6-pro"));
  assert.match(checkLimits("m", { context: 100_000, output: 8_000 }, { context: 100_000 }), /states no output limit for m/);
});

test("a second runner config keeps the first runner's provider configs", async () => {
  // The finding on 84358a17: review.json's setup replaced the models.json
  // that build.json's opencode runs read, so glm-5.3 could no longer build.
  const written = new Map();
  const io = (pool) => ({ pool: async () => pool, which: everything, fetchJson, env: {}, print: () => {}, writeFile: (p, t) => written.set(p, t), exists: (p) => written.has(p) });
  const args = (config) => ({ _: ["runner", "setup"], multi: { config: [config] }, config });
  await runSetup(args("/cfg/build.json"), io(POOL.filter((m) => m.id === "glm-5.3")));
  await runSetup(args("/cfg/review.json"), io(POOL.filter((m) => m.id === "deepseek-v4-pro")));
  for (const [name, model] of [["build", "glm-5.3"], ["review", "deepseek-v4-pro"]]) {
    const configPath = `/cfg/${name}.json`;
    const { agents, errors } = parseConfig(written.get(configPath), { configPath });
    assert.deepEqual(errors, []);
    const command = agents.find((a) => a.agent === "opencode").command;
    const providers = command[command.indexOf("--providers") + 1];
    assert.equal(providers, `/cfg/opencode/${name}.json`);
    const index = JSON.parse(written.get(join(providers, "models.json"))).models;
    assert.deepEqual(Object.keys(index), [model], `${name}'s index lists its own model`);
    assert.ok(written.has(join(providers, index[model].config)), `${name}'s provider config is there`);
  }
});

test("two runner configs that differ only by extension keep provider configs of their own", async () => {
  // The finding on 84644528: runner.json and runner.backup both resolved to
  // opencode/runner, so the second setup's index replaced the first's.
  const written = new Map();
  const io = (pool) => ({ pool: async () => pool, which: everything, fetchJson, env: {}, print: () => {}, writeFile: (p, t) => written.set(p, t), exists: (p) => written.has(p) });
  const args = (config) => ({ _: ["runner", "setup"], multi: { config: [config] }, config });
  await runSetup(args("/cfg/runner.json"), io(POOL.filter((m) => m.id === "glm-5.3")));
  await runSetup(args("/cfg/runner.backup"), io(POOL.filter((m) => m.id === "deepseek-v4-pro")));
  for (const [name, model] of [["runner.json", "glm-5.3"], ["runner.backup", "deepseek-v4-pro"]]) {
    const configPath = `/cfg/${name}`;
    const command = parseConfig(written.get(configPath), { configPath }).agents.find((a) => a.agent === "opencode").command;
    const providers = command[command.indexOf("--providers") + 1];
    assert.equal(providers, `/cfg/opencode/${name}`);
    assert.deepEqual(Object.keys(JSON.parse(written.get(join(providers, "models.json"))).models), [model], `${name}'s index lists its own model`);
  }
});

test("a runner config whose name ends in models.json is not taken for the provider index", async () => {
  // The finding on 71346e21: /cfg/models.json and /cfg/home-models.json threw
  // before anything was written, read as the index and its missing .models.
  for (const name of ["models.json", "home-models.json"]) {
    const written = new Map();
    const lines = [];
    const io = { pool: async () => POOL, which: everything, fetchJson, env: {}, print: (t) => lines.push(t), writeFile: (p, t) => written.set(p, t), exists: (p) => written.has(p) };
    const configPath = `/cfg/${name}`;
    await runSetup({ _: ["runner", "setup"], multi: { config: [configPath] }, config: configPath }, io);
    assert.deepEqual(parseConfig(written.get(configPath), { configPath }).errors, [], name);
    assert.ok(written.has(`/cfg/opencode/${name}/models.json`), `${name}: the index is written beside its configs`);
    assert.match(lines.join("\n"), /Keys are read at run time from the credential store: /, name);
  }
});

test("the catalogue's own limits fit what it says each provider serves", () => {
  for (const [provider, models] of Object.entries(CONFIGURED)) {
    for (const [model, limit] of Object.entries(models)) assert.equal(checkLimits(model, limit, SERVED[provider]?.[model]), null, `${provider}/${model}`);
  }
});

test("the generated provider configs send the gateway metadata, allow git add and git commit, and hold no key", async () => {
  const p = await plan({ env: { ATELIER_GATEWAY: "acct123/atelier" } });
  const deepseek = file(p, ["opencode", "runner.json","deepseek-api.json"]);
  const options = deepseek.provider["deepseek-api"].options;
  assert.equal(options.baseURL, "https://gateway.ai.cloudflare.com/v1/acct123/atelier/deepseek");
  assert.equal(options.apiKey, "{env:DEEPSEEK_API_KEY}");
  assert.equal(options.headers["cf-aig-metadata"], "{env:CF_AIG_METADATA_ESCAPED}");
  assert.equal(options.headers["cf-aig-authorization"], "Bearer {env:CF_AIG_TOKEN}");
  assert.deepEqual(deepseek.provider["deepseek-api"].models["deepseek-v4-pro"].limit, CONFIGURED["deepseek-api"]["deepseek-v4-pro"]);
  for (const name of ["deepseek-api", "openrouter-api", "zai-coding", "ai-studio"]) {
    const config = file(p, ["opencode", "runner.json",`${name}.json`]);
    assert.equal(config.permission.bash["git add *"], "allow", name);
    assert.equal(config.permission.bash["git commit *"], "allow", name);
    assert.equal(config.permission.bash["git push*"], "deny", name);
    assert.ok(config.provider[name].options.headers["cf-aig-metadata"], `${name} sends the metadata`);
    assert.deepEqual(config.mcp, {});
  }
  assert.deepEqual(file(p, ["opencode", "runner.json","openrouter-api.json"]).provider["openrouter-api"].models, { "xiaomi/mimo-v2.6-pro": { name: "xiaomi-mimo-v2.6-pro", limit: { context: 262144, output: 32000 } } });
  assert.equal(file(p, ["opencode", "runner.json","ai-studio.json"]).provider["ai-studio"].options.baseURL, "http://studio.local:1234/v1");
  const index = file(p, ["opencode", "runner.json","models.json"]).models;
  assert.deepEqual(index["deepseek-v4-pro"], { provider: "deepseek-api", providerModel: "deepseek-v4-pro", config: "deepseek-api.json", key: "deepseek.KEY2", keyVar: "DEEPSEEK_API_KEY", gateway: true, limit: CONFIGURED["deepseek-api"]["deepseek-v4-pro"] });
  assert.equal(index["glm-5.3"].key, "zai.API_KEY");
  assert.equal(index["glm-5.3"].gateway, false, "the coding plan is not pay per use and goes direct");
  assert.equal(PERMISSION.external_directory, "deny");
  // Without a gateway, the providers are reached direct and say so.
  const direct = await plan();
  assert.equal(file(direct, ["opencode", "runner.json","deepseek-api.json"]).provider["deepseek-api"].options.baseURL, "https://api.deepseek.com/v1");
  assert.match(direct.lines.join("\n"), /No AI Gateway is named/);
});

// The finding on t683: opencode 1.18.34 throws on the V2 "permissions" key.
test("setup writes the V2 permissions into the provider configs only when the opencode found is 2 or later", async () => {
  const names = ["deepseek-api.json", "ai-studio.json", "openrouter-api.json", "zai-coding.json"];
  for (const [major, has] of [[2, true], [1, false], [null, false]]) {
    const p = await plan({ major });
    for (const name of names) {
      const config = file(p, ["opencode", "runner.json", name]);
      assert.equal(config.permission.external_directory, "deny", `${name} keeps opencode 1's deny`);
      assert.equal("permissions" in config, has, `${name}, major ${major}`);
    }
  }
});

test("setup writes the files, refuses to overwrite a runner config, and a dry run writes nothing", async () => {
  const written = new Map(), printed = [];
  const io = { pool: async () => POOL, which: everything, fetchJson, env: {}, print: (t) => printed.push(t), writeFile: (p, t) => written.set(p, t), exists: () => false };
  const args = (extra = {}) => ({ _: ["runner", "setup"], multi: Object.fromEntries(Object.keys(extra).map((k) => [k, [extra[k]]])), ...extra });
  await runSetup(args({ config: "/cfg/runner.json" }), io);
  assert.deepEqual([...written.keys()].sort(), ["/cfg/opencode/runner.json/ai-studio.json", "/cfg/opencode/runner.json/deepseek-api.json", "/cfg/opencode/runner.json/models.json", "/cfg/opencode/runner.json/openrouter-api.json", "/cfg/opencode/runner.json/zai-coding.json", "/cfg/runner.json"]);
  await assert.rejects(runSetup(args({ config: "/cfg/runner.json" }), { ...io, exists: () => true }), /exists; setup does not overwrite a runner config/);
  written.clear();
  await runSetup(args({ config: "/cfg/runner.json", "dry-run": true }), { ...io, exists: () => true });
  assert.equal(written.size, 0);
  assert.match(printed.at(-1), /Dry run: nothing was written/);
  await assert.rejects(runSetup({ _: ["runner", "setup", "x"], multi: {} }, io), /usage: atelier runner setup/);
  await assert.rejects(planSetup({ configPath: "/c/r.json", pool: POOL, env: {}, which: () => false, fetchJson }), /no harness found on the PATH/);
});

test("--claude-token-file puts the path in the written config, never token bytes, and an existing config keeps it", async () => {
  // Criterion 1 of t53: runner setup accepts a Claude token-file reference.
  const FAKE = "fake-claude-token-123";
  const file = "/home/p/.config/api-keys/claude-code-auth.key";
  const written = new Map(), printed = [];
  const io = { pool: async () => POOL, which: everything, fetchJson, env: {}, print: (t) => printed.push(t), writeFile: (p, t) => written.set(p, t), exists: (p) => written.has(p), readFile: (p) => written.get(p) };
  const args = (extra = {}) => ({ _: ["runner", "setup"], multi: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, [v]])), ...extra });
  await runSetup(args({ config: "/cfg/runner.json", "claude-token-file": file }), io);
  const config = JSON.parse(written.get("/cfg/runner.json"));
  assert.equal(config.claudeTokenFile, file);
  const parsed = parseConfig(config, { configPath: "/cfg/runner.json" });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.claudeTokenFile, file);
  const command = parsed.agents.find((a) => a.agent === "claude-code").command;
  assert.deepEqual(command.slice(2, 4), ["--claude-token-file", file]);
  assert.match(printed.join("\n"), /token in \/home\/p\/\.config\/api-keys\/claude-code-auth\.key/);
  assert.doesNotMatch([...written.values(), ...printed].join("\n"), new RegExp(FAKE));
  // Without the flag the config has no claudeTokenFile.
  const plain = await plan();
  assert.ok(!("claudeTokenFile" in plain.config));
  // An existing config keeps its path when the flag is absent (a dry run shows it).
  printed.length = 0;
  const kept = await runSetup(args({ config: "/cfg/runner.json", "dry-run": true }), io);
  assert.equal(kept.config.claudeTokenFile, file);
  assert.match(printed.join("\n"), /"claudeTokenFile": "\/home\/p\/\.config\/api-keys\/claude-code-auth\.key"/);
  // The flag replaces it.
  const replaced = await runSetup(args({ config: "/cfg/runner.json", "dry-run": true, "claude-token-file": "~/other.key" }), io);
  assert.equal(replaced.config.claudeTokenFile, "~/other.key");
  // The config parser's validation applies: a token, a relative path or a traversal is refused and not echoed.
  for (const bad of ["sk-ant-oat01-abcdef", "relative/token.key", "/home/p/../x.key"]) {
    await assert.rejects(runSetup(args({ config: "/cfg/new.json", "claude-token-file": bad }), io), (e) => /claudeTokenFile must be the path of a file/.test(e.message) && !e.message.includes(bad));
  }
  assert.ok(!written.has("/cfg/new.json"), "nothing written for a refused path");
  // The flag needs a value.
  await assert.rejects(runSetup(args({ config: "/cfg/new.json", "claude-token-file": true }), io), /usage: atelier runner setup .*--claude-token-file PATH/);
});

test("the gateway and the harnesses on the PATH are read from the environment", () => {
  assert.deepEqual(gatewayFrom({ ATELIER_GATEWAY: "a1/gw" }), { account: "a1", id: "gw" });
  assert.deepEqual(gatewayFrom({ CF_ACCOUNT_ID: "a2" }), { account: "a2", id: "atelier" });
  assert.equal(gatewayFrom({}), null);
  assert.throws(() => gatewayFrom({ ATELIER_GATEWAY: "a/b/c d" }), /ACCOUNT\/GATEWAY/);
  assert.equal(onPath("claude", { PATH: "/x:/y" }, (p) => p === "/y/claude"), "/y/claude");
  assert.equal(onPath("claude", { PATH: "/x" }, () => false), null);
});

// t698: the pool's OpenRouter entries are recorded as cloud with ids that carry
// no vendor; a home runner runs them through the gateway's openrouter/v1.
const ROUTED = [
  { id: "qwen3.8-max", harness: "opencode", where: "cloud", provider: "openrouter" },
  { id: "mimo-v2.6-pro", harness: "opencode", where: "cloud", provider: "openrouter" },
  { id: "anthropic-claude-sonnet-5.5", harness: "opencode", where: "cloud", provider: "openrouter" },
];
const served = { context_length: 1_000_000, top_provider: { context_length: 1_000_000, max_completion_tokens: 131072 } };
const ROUTED_LISTS = { [OPENROUTER_MODELS]: { data: ["qwen/qwen3.8-max-0902", "xiaomi/mimo-v2.6-pro", "anthropic/claude-sonnet-5.5"].map((id) => ({ id, ...served })) } };

test("a home runner is set up for opencode/qwen3.8-max and opencode/mimo-v2.6-pro through the gateway's OpenRouter route", async () => {
  const p = await planSetup({ configPath: "/cfg/runner.json", pool: ROUTED, env: { ATELIER_GATEWAY: "acct123/atelier" }, which: everything, fetchJson: async (u) => ROUTED_LISTS[u] ?? null, major: 2 });
  assert.deepEqual(p.config.agents, [{ agent: "opencode", models: ["qwen3.8-max", "mimo-v2.6-pro"] }]);
  const config = file(p, ["opencode", "runner.json", "openrouter-api.json"]);
  const provider = config.provider["openrouter-api"];
  assert.equal(provider.options.baseURL, "https://gateway.ai.cloudflare.com/v1/acct123/atelier/openrouter/v1");
  assert.equal(provider.options.apiKey, "{env:OPENROUTER_API_KEY}");
  assert.equal(provider.options.headers["cf-aig-authorization"], "Bearer {env:CF_AIG_TOKEN}");
  assert.deepEqual(Object.keys(provider.models), ["qwen/qwen3.8-max-0902", "xiaomi/mimo-v2.6-pro"]);
  assert.deepEqual(provider.models["qwen/qwen3.8-max-0902"].limit, { context: 1_000_000, output: 32000 });
  assert.equal(config.permissions[0].effect, "deny", "opencode 2's deny stays");
  const index = file(p, ["opencode", "runner.json", "models.json"]).models;
  assert.deepEqual(index["qwen3.8-max"], { provider: "openrouter-api", providerModel: "qwen/qwen3.8-max-0902", config: "openrouter-api.json", key: "openrouter.API_KEY", keyVar: "OPENROUTER_API_KEY", gateway: true, limit: { context: 1_000_000, output: 32000 } });
  assert.equal(index["mimo-v2.6-pro"].providerModel, "xiaomi/mimo-v2.6-pro");
  assert.doesNotMatch(JSON.stringify(p.files), /sk-or|Bearer [A-Za-z0-9]{20}/, "no key is written");
});

test("setup refuses a Claude model through OpenRouter, naming claude-code", async () => {
  const p = await planSetup({ configPath: "/cfg/runner.json", pool: ROUTED, env: {}, which: everything, fetchJson: async (u) => ROUTED_LISTS[u] ?? null });
  assert.ok(!p.config.agents[0].models.includes("anthropic-claude-sonnet-5.5"));
  const refusal = p.refused.find((r) => r.id === "anthropic-claude-sonnet-5.5");
  assert.match(refusal.why, /no prompt caching.*claude-code/);
});
