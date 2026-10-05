import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_TASK_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_FINISH_TIMEOUT_MS = 60 * 60_000;

const HARNESSES = ["opencode", "claude-code", "codex", "zcode", "antigravity"];
const MODEL = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const PLACEHOLDERS = ["model", "brief_file", "workspace"];

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
  const seen = new Set();
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
      if (placeholders.some((p) => !PLACEHOLDERS.includes(p)) || /[{}]/.test(template.replace(/\{(model|brief_file|workspace)\}/g, ""))) bad("unknown command placeholder");
      if (!placeholders.includes("model") || !placeholders.includes("brief_file")) bad("command must include {model} and {brief_file}");
      if (/[{}]/.test(entry.command[0])) bad("the executable must not contain placeholders");
    }
    if (errors.length === start) agents.push({ agent: entry.agent, models: [...entry.models], command: [...entry.command] });
  }
  return { agents, errors, taskTimeoutMs, finishTimeoutMs };
}

export function readConfig(path = join(process.env.ATELIER_CONFIG_DIR ?? join(homedir(), ".config", "atelier"), "runner.json")) {
  const config = parseConfig(readFileSync(path, "utf8"));
  if (config.errors.length) throw new Error(config.errors.join("; "));
  return config;
}
