import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { redactKeys } from "../src/models/pool.ts";
import { isOwnerSecretName } from "./credentials.mjs";

export const DEFAULT_TASK_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_FINISH_TIMEOUT_MS = 60 * 60_000;

// The jobs a runner offers and takes (offerFrom in runner.mjs): every form of
// building — a plain build, the plan job (docs/orchestrator.md, section 2) and
// the three merge jobs — plus the review job (section 4). A config with no
// `jobs` takes the build jobs alone, as every runner did before reviews; a
// config with `jobs` takes exactly what it lists, so ["review"] keeps a runner
// for reviews alone (t252) and a config that wants both lists "build" and its
// kin beside "review".
export const DEFAULT_JOBS = ["build", "plan", "merge-main", "merge-main-task", "merge-plan"];
const JOB_NAMES = new Set([...DEFAULT_JOBS, "review"]);

const HARNESSES = ["opencode", "claude-code", "codex", "zcode", "gemini-cli", "antigravity"];
const MODEL = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
// {plan_file} is the plan job's alone (docs/orchestrator.md, section 2): the
// file the harness writes the plan document to. A command without it still
// builds; the runner refuses to give it a plan job.
const PLACEHOLDERS = ["model", "brief_file", "workspace", "plan_file", "diff_file", "verdict_file"];
// The name of a Keychain entry, as the model pool records one.
const KEYCHAIN_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// The file an agent token may be read from (tokens, t346): a path with
// folders, each a plain name, under the user's Atelier config directory,
// written as ~/.config/atelier/NAME or relative to that directory. Its
// resolution against the directory is the runner's (tokenFile in runner.mjs).
const TOKEN_FILE = /^(~\/\.config\/atelier\/)?(?:[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/)*[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// A provider whose balance the usage report asks for (cli/usage.mjs).
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
// The name of an environment variable a harness entry passes on (runner.mjs harnessEnv).
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// The harness adapters Atelier ships (bin/harness/, cli/harness/adapter.mjs),
// which an entry runs when it gives no command of its own. Each is started by
// this Node with every placeholder, so the one command builds, plans and
// reviews; opencode's also names the folder of the provider configs `atelier
// runner setup` wrote for this runner config (providersDir), and the
// credential store the
// runner itself reads (ATELIER_SECRET_STORE, ATELIER_CONFIG_DIR): the runner
// passes a harness no ATELIER_ variable (check-env.mjs), so without these the
// adapter would look for its keys in another store than the one they were
// put in.
const ADAPTERS = { "claude-code": "atelier-claude.mjs", codex: "atelier-codex.mjs", opencode: "atelier-opencode.mjs", antigravity: "atelier-agy.mjs" };
const BIN = fileURLToPath(new URL("../bin/harness/", import.meta.url));
export function defaultCommand(agent, configPath = defaultConfigPath(), env = process.env) {
  const adapter = ADAPTERS[agent];
  if (!adapter) return null;
  const store = agent !== "opencode" ? [] : [
    "--providers", providersDir(configPath),
    ...(env.ATELIER_SECRET_STORE ? ["--secret-store", env.ATELIER_SECRET_STORE] : []),
    ...(env.ATELIER_CONFIG_DIR ? ["--secrets-dir", env.ATELIER_CONFIG_DIR] : []),
  ];
  return [process.execPath, join(BIN, adapter), ...store,
    "{model}", "{brief_file}", "{workspace}", "{plan_file}", "{diff_file}", "{verdict_file}"];
}
export const defaultConfigDir = () => process.env.ATELIER_CONFIG_DIR ?? join(homedir(), ".config", "atelier");
export const defaultConfigPath = () => join(defaultConfigDir(), "runner.json");

// The folder of one runner config's opencode provider configs: opencode/NAME
// beside it, NAME the config's whole file name (runner.json). A folder per
// config, so setting up a second runner leaves the first one's index and
// provider configs as they were; the extension stays in NAME, so
// runner.json and runner.backup never share one (the finding on 84644528).
export function providersDir(configPath) {
  const path = resolve(configPath);
  return join(dirname(path), "opencode", basename(path));
}

// `configPath` is the file the config was read from, beside which `runner
// setup` keeps the opencode provider configs a default command names
// (providersDir); `env` the runner's environment, which names its credential
// store.
export function parseConfig(json, { configPath, env } = {}) {
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
  // Optional (t346): for each model this runner reviews as, where that
  // model's own agent token is stored, so its verdicts are recorded by the
  // model itself and not by the owner token the runner holds: the name of a
  // Keychain entry (read as `keychain` reads a key, by that exact name), or
  // the path of a file under the user's Atelier config directory (a value
  // with a "/"), readable by the user alone. The token itself is refused
  // here, as a key is, and is never echoed.
  let tokens;
  if (value.tokens !== undefined) {
    if (!value.tokens || typeof value.tokens !== "object" || Array.isArray(value.tokens)) errors.push("tokens must map a model id to the name of its agent token's Keychain entry or the path of its file");
    else {
      tokens = {};
      for (const [model, where] of Object.entries(value.tokens)) {
        if (!MODEL.test(model) || redactKeys(model) !== model) errors.push("tokens has a key that is not a model id");
        else if (typeof where !== "string" || !where.trim() || /^atl_/i.test(where) || redactKeys(where) !== where || !(KEYCHAIN_ENTRY.test(where) || TOKEN_FILE.test(where))) errors.push(`tokens.${model} must name a Keychain entry or a token file under ~/.config/atelier/, never the token itself`);
        // The owner's own credential (API_TOKEN, or a name the store reads
        // from ATELIER_TOKEN) is not a reviewer's token: naming it would have
        // the owner record the review, which is what `tokens` exists to prevent.
        else if (isOwnerSecretName(where)) errors.push(`tokens.${model} must not name the owner's token (${where.toUpperCase()}): a review is recorded only by the reviewer's own agent token (atelier token issue --as AGENT/${model}, then store that token under a name of its own)`);
        else tokens[model] = where;
      }
    }
  }
  // Removed (t346): the owner-recorded fallback, which let the owner token
  // record the reviews of models `tokens` left out. A config that still
  // carries it is refused, so the owner learns the reviews it expected to be
  // recorded would not be, rather than finding the option silently ignored.
  if (value.ownerRecordsReviews !== undefined) errors.push("ownerRecordsReviews was removed: a review is recorded only by the reviewer's own agent token, so name one under tokens for each model this runner reviews as (docs/runners.md, Reviewers post under their own agent token) and take the option out");
  const seen = new Set();
  // Optional: the jobs this runner takes, named exactly (DEFAULT_JOBS): with
  // it the list is the whole truth, so a runner configured for reviews takes
  // no build, and one long build on it cannot hold every review behind it
  // (t252). A name the runner does not know is refused, not taken as silence:
  // a typo would otherwise leave the runner idle while work waits.
  let jobs;
  if (value.jobs !== undefined) {
    if (!Array.isArray(value.jobs) || !value.jobs.length || value.jobs.some((j) => typeof j !== "string" || !j.trim())) errors.push("jobs must be a nonempty list of job names");
    else {
      jobs = [...new Set(value.jobs.map((j) => j.trim()))];
      for (const job of jobs) {
        if (job === "integrate" || job === "refresh") errors.push(`jobs cannot list "${job}": the integrate and refresh jobs are the integrator's alone (atelier runner --integrate, which takes no config)`);
        else if (!JOB_NAMES.has(job)) errors.push(`jobs cannot list "${job}": the jobs are build, plan, merge-main, merge-main-task, merge-plan and review`);
      }
    }
  }
  for (let [i, entry] of value.agents.entries()) {
    const bad = (message) => errors.push(`agents[${i}]: ${message}`);
    const start = errors.length;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { bad("expected an object"); continue; }
    if (!HARNESSES.includes(entry.agent)) bad("unknown agent harness");
    if (seen.has(entry.agent)) bad("duplicate agent harness");
    seen.add(entry.agent);
    if (!Array.isArray(entry.models) || !entry.models.length ||
        entry.models.some((m) => typeof m !== "string" || !MODEL.test(m)) ||
        new Set(entry.models).size !== entry.models.length) bad("models must be distinct claimable model ids");
    // No command: the adapter Atelier ships for the harness, where it ships one.
    if (entry.command === undefined && HARNESSES.includes(entry.agent)) {
      const command = defaultCommand(entry.agent, configPath, env);
      if (command) entry = { ...entry, command };
      else bad(`Atelier ships no adapter for ${entry.agent}; give its command`);
    }
    if (!Array.isArray(entry.command) || !entry.command.length ||
        entry.command.some((s) => typeof s !== "string" || s.includes("\0")) || !entry.command[0]?.trim()) {
      bad("command must be an argv array with an executable and no NUL characters");
    } else {
      const template = entry.command.join("\n");
      const placeholders = [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
      if (placeholders.some((p) => !PLACEHOLDERS.includes(p)) || /[{}]/.test(template.replace(/\{(model|brief_file|workspace|plan_file|diff_file|verdict_file)\}/g, ""))) bad("unknown command placeholder");
      if (!placeholders.includes("model") || !placeholders.includes("brief_file")) bad("command must include {model} and {brief_file}");
      if (/[{}]/.test(entry.command[0])) bad("the executable must not contain placeholders");
      // A runner that offers reviews may be given one for any of its agents,
      // and a reviewer's verdict is read from the {verdict_file} it writes.
      if (jobs?.includes("review") && !placeholders.includes("verdict_file")) bad(`jobs include "review", but ${entry.agent}'s command has no {verdict_file} placeholder, so it could not write a verdict; add one, or take "review" out of jobs`);
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
  return { agents, errors, taskTimeoutMs, finishTimeoutMs, ...(keychain ? { keychain } : {}), ...(balances ? { balances } : {}), ...(tokens ? { tokens } : {}),
    ...(jobs !== undefined ? { jobs } : {}) };
}

export function readConfig(path = defaultConfigPath()) {
  const config = parseConfig(readFileSync(path, "utf8"), { configPath: path });
  if (config.errors.length) throw new Error(config.errors.join("; "));
  return config;
}
