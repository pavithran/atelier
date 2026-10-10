// `atelier runner setup [--config PATH] [--dry-run]` writes a runner config
// for the harnesses this machine has and the home models the pool gives them,
// and, for opencode, a provider config per provider with each model's limits
// checked against what its provider serves (cli/harness/providers.mjs). The
// runner config names no command, so the runner runs the adapters Atelier
// ships (bin/harness/); nothing written holds a key. docs/runners.md, "Setting
// up a runner", is the walk-through.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

import { DEFAULT_JOBS, defaultConfigPath, parseConfig, providersDir } from "./runner-config.mjs";
import { HARNESSES } from "./harness/adapter.mjs";
import {
  PROVIDERS, SERVED, checkLimits, configuredLimits, localServed, opencodeConfig, openRouterId, openRouterServed, providerFor,
} from "./harness/providers.mjs";

export const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const KEYCHAIN_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const USAGE = "usage: atelier runner setup [--config PATH] [--dry-run]";

// The executable's path on the PATH, or null.
export function onPath(name, env = process.env, exists = existsSync) {
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir && exists(join(dir, name))) return join(dir, name);
  return null;
}

// The AI Gateway the pay-per-use providers go through: ATELIER_GATEWAY as
// ACCOUNT/GATEWAY, or CF_ACCOUNT_ID with the gateway named atelier. Neither
// set, they go direct and the gateway counts nothing.
export function gatewayFrom(env) {
  const named = env.ATELIER_GATEWAY?.trim();
  const parts = named ? named.split("/") : [env.CF_ACCOUNT_ID?.trim(), "atelier"];
  const [account, id] = parts;
  if (!account) return null;
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{1,64}$/.test(account) || !/^[A-Za-z0-9_-]{1,64}$/.test(id ?? "")) throw new Error("ATELIER_GATEWAY must be ACCOUNT/GATEWAY");
  return { account, id };
}

// Each opencode pool entry, resolved: { accepted: [...], refused: [...] }.
// An accepted model carries its provider, the provider's id for it, its base
// URL when the pool gives one, and the limits checked.
// `catalogue` replaces the limits Atelier configures (CONFIGURED), for a test.
export async function resolveOpencode(entries, fetchJson, catalogue = {}) {
  const accepted = [], refused = [];
  let openrouter, studioEndpoint;
  const lists = new Map();
  const list = async (url) => {
    if (!lists.has(url)) lists.set(url, await fetchJson(url));
    const body = lists.get(url);
    return Array.isArray(body?.data) ? body.data : null;
  };
  for (const entry of entries) {
    const refuse = (why) => refused.push({ id: entry.id, why });
    const where = providerFor(entry);
    if (where.refused) { refuse(where.refused); continue; }
    let { provider, providerModel } = where, served;
    if (provider === "openrouter-api") {
      openrouter ??= await list(OPENROUTER_MODELS);
      if (!openrouter) { refuse(`OpenRouter's model list (${OPENROUTER_MODELS}) could not be read, so what it serves for ${entry.id} is unknown`); continue; }
      const hit = openRouterId(entry.id, openrouter);
      if (!hit) { refuse(`OpenRouter lists no single model that ${entry.id} names (an id VENDOR/MODEL, written VENDOR-MODEL in the pool)`); continue; }
      providerModel = hit.id;
      served = openRouterServed(hit);
    } else if (provider === "ai-studio") {
      if (studioEndpoint && studioEndpoint !== where.baseURL) { refuse(`a runner reaches one AI Studio endpoint, and ${studioEndpoint} is already configured`); continue; }
      const listed = await list(`${where.baseURL}/models`);
      const hit = listed?.find((m) => m.id === providerModel);
      served = hit ? localServed(hit) : null;
      if (!served) { refuse(`${where.baseURL}/models ${listed ? `gives no context length for ${entry.id}` : "could not be read"}, so what it serves is unknown`); continue; }
      studioEndpoint = where.baseURL;
    } else {
      served = (catalogue.served ?? SERVED)[provider]?.[providerModel] ?? null;
    }
    const limit = configuredLimits(provider, providerModel, served, catalogue.configured);
    // Without what is served there is no limit either, and checkLimits says so.
    const why = checkLimits(entry.id, limit, served, "opencode");
    if (why) { refuse(why); continue; }
    accepted.push({ atelierId: entry.id, provider, providerModel, limit, ...(where.baseURL ? { baseURL: where.baseURL } : {}), keychain: entry.keychain });
  }
  return { accepted, refused };
}

// Everything setup would write, as { files: [{path, text}], config, refused, found, lines }.
export async function planSetup({ configPath, pool, env, which, fetchJson, catalogue }) {
  const found = Object.keys(HARNESSES).filter((h) => which(HARNESSES[h].executable));
  const home = (Array.isArray(pool) ? pool : []).filter((m) => m.where === "home");
  const gateway = gatewayFrom(env);
  // Each runner config's provider configs have a folder of their own, so a
  // second runner's setup leaves the first's as they were.
  const providers = providersDir(configPath);
  const agents = [], files = [], refused = [];
  const notFound = [...new Set(home.map((m) => m.harness))].filter((h) => !found.includes(h));
  for (const harness of found) {
    const entries = home.filter((m) => m.harness === harness);
    if (!entries.length) continue;
    if (harness !== "opencode") { agents.push({ agent: harness, models: entries.map((m) => m.id) }); continue; }
    const resolved = await resolveOpencode(entries, fetchJson, catalogue);
    refused.push(...resolved.refused.map((r) => ({ ...r, harness })));
    if (!resolved.accepted.length) continue;
    agents.push({ agent: harness, models: resolved.accepted.map((m) => m.atelierId) });
    const index = {};
    for (const provider of [...new Set(resolved.accepted.map((m) => m.provider))]) {
      const models = resolved.accepted.filter((m) => m.provider === provider);
      const spec = PROVIDERS[provider];
      const config = opencodeConfig(provider, models, { baseURL: models[0].baseURL, gateway });
      files.push({ path: join(providers, `${provider}.json`), text: JSON.stringify(config, null, 2) + "\n" });
      for (const m of models) {
        const key = m.keychain ?? spec.key;
        index[m.atelierId] = { provider, providerModel: m.providerModel, config: `${provider}.json`, ...(key ? { key, keyVar: spec.keyVar } : {}), gateway: !!(gateway && spec.gateway), limit: m.limit };
      }
    }
    files.push({ path: join(providers, "models.json"), text: JSON.stringify({ models: index }, null, 2) + "\n" });
  }
  if (!agents.length) {
    throw new Error(found.length
      ? `the pool gives no home model to the harnesses found here (${found.join(", ")})${refused.length ? `; refused: ${refused.map((r) => r.why).join("; ")}` : ""}`
      : "no harness found on the PATH: install one of claude (Claude Code), codex, opencode or agy (Antigravity)");
  }
  // Each model this runner may review as names the Keychain entry of its own
  // agent token (docs/runners.md, Reviewers post under their own agent token).
  const tokens = Object.fromEntries(agents.flatMap((a) => a.models).filter((m) => KEYCHAIN_ENTRY.test(`agent.${m}`)).map((m) => [m, `agent.${m}`]));
  const config = { jobs: [...DEFAULT_JOBS, "review"], agents, tokens };
  const parsed = parseConfig(config, { configPath });
  if (parsed.errors.length) throw new Error(`the config setup would write is refused: ${parsed.errors.join("; ")}`);
  files.unshift({ path: configPath, text: JSON.stringify(config, null, 2) + "\n" });

  const lines = [`Harnesses found: ${found.length ? found.join(", ") : "none"}.`];
  for (const a of agents) lines.push(`  ${a.agent}: ${a.models.join(", ")}`);
  if (notFound.length) lines.push(`The pool has home models for ${notFound.join(", ")}, which ${notFound.length === 1 ? "is" : "are"} not installed here.`);
  if (refused.length) lines.push("Refused:", ...refused.map((r) => `  ${r.harness}/${r.id}: ${r.why}`));
  if (agents.some((a) => a.agent === "opencode")) {
    lines.push(gateway ? `Pay-per-use providers go through the AI Gateway ${gateway.account}/${gateway.id}; store its token as CF_AIG_TOKEN.` : "No AI Gateway is named (ATELIER_GATEWAY or CF_ACCOUNT_ID), so providers are reached direct and the gateway counts nothing.");
    const keys = [...new Set(files.filter((f) => f.path.endsWith("models.json")).flatMap((f) => Object.values(JSON.parse(f.text).models).map((m) => m.key).filter(Boolean)))];
    if (keys.length) lines.push(`Keys are read at run time from the credential store: ${keys.join(", ")}.`);
  }
  lines.push(`Reviewer tokens are read from: ${Object.values(tokens).join(", ") || "none"} (atelier token issue --as HARNESS/MODEL, then store each).`);
  return { files, config, refused, found, lines };
}

// The command. `io` gives the pool, the PATH lookup, fetch and the writes.
export async function runSetup(args, io) {
  if (args._.length !== 2 || Object.keys(args.multi).some((k) => !["config", "dry-run"].includes(k) || args.multi[k].length !== 1) ||
      (args.config !== undefined && typeof args.config !== "string") || (args["dry-run"] !== undefined && args["dry-run"] !== true)) throw new Error(USAGE);
  const env = io.env ?? process.env;
  const configPath = resolve(args.config ?? defaultConfigPath());
  if (!args["dry-run"] && (io.exists ?? existsSync)(configPath)) throw new Error(`${configPath} exists; setup does not overwrite a runner config. Move it aside, or name another file with --config PATH`);
  const plan = await planSetup({
    configPath, env, pool: await io.pool(),
    which: io.which ?? ((name) => onPath(name, env)),
    fetchJson: io.fetchJson, catalogue: io.catalogue,
  });
  const print = io.print ?? ((text) => console.log(text));
  print(plan.lines.join("\n"));
  if (args["dry-run"]) {
    for (const f of plan.files) print(`\n${f.path}:\n${f.text}`);
    print("Dry run: nothing was written.");
    return plan;
  }
  const write = io.writeFile ?? ((path, text) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 }); });
  for (const f of plan.files) write(f.path, f.text);
  print(`Wrote ${plan.files.map((f) => f.path).join(", ")}.\nStart it: atelier runner --name home:NAME${args.config ? ` --config ${configPath}` : ""}`);
  return plan;
}
