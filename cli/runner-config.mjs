import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { redactKeys } from "../src/models/pool.ts";

export const DEFAULT_TASK_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_FINISH_TIMEOUT_MS = 60 * 60_000;

const HARNESSES = ["opencode", "claude-code", "codex", "zcode", "gemini-cli", "antigravity"];
const MODEL = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
// {plan_file} is the plan job's alone (docs/orchestrator.md, section 2): the
// file the harness writes the plan document to. A command without it still
// builds; the runner refuses to give it a plan job.
const PLACEHOLDERS = ["model", "brief_file", "workspace", "plan_file", "diff_file", "verdict_file"];
// The name of a Keychain entry, as the model pool records one.
const KEYCHAIN_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// A provider whose balance the usage report asks for (cli/usage.mjs).
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
// The name of an environment variable a harness entry passes on (runner.mjs harnessEnv).
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function parseConfig(json) {
  const agents = [], errors = [];
  let value;
  try { value = typeof json === "string" ? JSON.parse(json) : json; }
  catch { return { agents, errors: ["config must be valid JSON"] }; }
  if (!value || !Array.isArray(value.agents) || !value.agents.length) {
    return { agents, errors: ["config must contain a nonempty agents array"] };
  }
  const taskTimeoutMs = value.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  if (!Number.isInteger(taskTimeoutMs) || taskTimeoutMs <= 0 || taskTimeoutMs > 2_147_483_647) errors.push("taskTimeoutMs must be a positive timer-safe integer");
  const finishTimeoutMs = value.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS;
  if (!Number.isInteger(finishTimeoutMs) || finishTimeoutMs <= 0 || finishTimeoutMs > 2_147_483_647) errors.push("finishTimeoutMs must be a positive timer-safe integer");
  // Optional: for each model that needs an API key, the name of the Keychain
  // entry that holds it. The key itself is refused here, and never echoed.
  let keychain;
  if (value.keychain !== undefined) {
    if (!value.keychain || typeof value.keychain !== "object" || Array.isArray(value.keychain)) errors.push("keychain must map a model id to the name of its Keychain entry");
    else {
      keychain = {};
      for (const [model, name] of Object.entries(value.keychain)) {
        if (!MODEL.test(model) || redactKeys(model) !== model) errors.push("keychain has a key that is not a model id");
        else if (typeof name !== "string" || !KEYCHAIN_ENTRY.test(name) || redactKeys(name) !== name) errors.push(`keychain.${model} must be the name of a Keychain entry, never the key itself`);
        else keychain[model] = name;
      }
    }
  }
  // Optional: for each provider whose pay-per-use balance `runner --usage`
  // asks for, the name of the Keychain entry that holds its key. As with
  // keychain, the key itself is refused.
  let balances;
  if (value.balances !== undefined) {
    if (!value.balances || typeof value.balances !== "object" || Array.isArray(value.balances)) errors.push("balances must map a provider to the name of its Keychain entry");
    else {
      balances = {};
      for (const [provider, name] of Object.entries(value.balances)) {
        if (!PROVIDER.test(provider) || redactKeys(provider) !== provider) errors.push("balances has a key that is not a provider name");
        else if (typeof name !== "string" || !KEYCHAIN_ENTRY.test(name) || redactKeys(name) !== name) errors.push(`balances.${provider} must be the name of a Keychain entry, never the key itself`);
        else balances[provider.toLowerCase()] = name;
      }
    }
  }
  const seen = new Set();
  // Optional: the jobs besides building the runner offers, such as "review".
  // A review dispatch is offered only to a runner whose offer lists it.
  let jobs;
  if (value.jobs !== undefined) {
    if (!Array.isArray(value.jobs) || value.jobs.some((j) => typeof j !== "string" || !j.trim())) errors.push("jobs must be a list of job names");
    else jobs = [...new Set(value.jobs.map((j) => j.trim()))];
  }
  for (const [i, entry] of value.agents.entries()) {
    const bad = (message) => errors.push(`agents[${i}]: ${message}`);
    const start = errors.length;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { bad("expected an object"); continue; }
    if (!HARNESSES.includes(entry.agent)) bad("unknown agent harness");
    if (seen.has(entry.agent)) bad("duplicate agent harness");
    seen.add(entry.agent);
    if (!Array.isArray(entry.models) || !entry.models.length ||
        entry.models.some((m) => typeof m !== "string" || !MODEL.test(m)) ||
        new Set(entry.models).size !== entry.models.length) bad("models must be distinct claimable model ids");
    if (!Array.isArray(entry.command) || !entry.command.length ||
        entry.command.some((s) => typeof s !== "string" || s.includes("\0")) || !entry.command[0]?.trim()) {
      bad("command must be an argv array with an executable and no NUL characters");
    } else {
      const template = entry.command.join("\n");
      const placeholders = [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
      if (placeholders.some((p) => !PLACEHOLDERS.includes(p)) || /[{}]/.test(template.replace(/\{(model|brief_file|workspace|plan_file|diff_file|verdict_file)\}/g, ""))) bad("unknown command placeholder");
      if (!placeholders.includes("model") || !placeholders.includes("brief_file")) bad("command must include {model} and {brief_file}");
      if (/[{}]/.test(entry.command[0])) bad("the executable must not contain placeholders");
    }
    // Optional: the variables of the runner's environment this harness also
    // gets, such as the provider key opencode reads. Atelier's own never.
    if (entry.env !== undefined) {
      if (!Array.isArray(entry.env) || entry.env.some((name) => typeof name !== "string" || !ENV_NAME.test(name)) ||
          new Set(entry.env).size !== entry.env.length) bad("env must list distinct environment variable names");
      else if (entry.env.some((name) => /^ATELIER_/i.test(name))) bad("env must not name an ATELIER_ variable; a harness never gets Atelier's credentials");
    }
    if (errors.length === start) agents.push({ agent: entry.agent, models: [...entry.models], command: [...entry.command], ...(entry.env ? { env: [...entry.env] } : {}) });
  }
  return { agents, errors, taskTimeoutMs, finishTimeoutMs, ...(keychain ? { keychain } : {}), ...(balances ? { balances } : {}), ...(jobs !== undefined ? { jobs } : {}) };
}

export function readConfig(path = join(process.env.ATELIER_CONFIG_DIR ?? join(homedir(), ".config", "atelier"), "runner.json")) {
  const config = parseConfig(readFileSync(path, "utf8"));
  if (config.errors.length) throw new Error(config.errors.join("; "));
  return config;
}
