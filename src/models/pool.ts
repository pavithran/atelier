// The model pool: the models the owner has made available to Atelier, each
// with the harness that drives it, where it runs and, for an API, which
// provider serves it and the name of the Keychain entry that holds its key.
// Atelier stores the entry's name, never a key; the runner on the owner's
// machine reads the key when it needs it. Families are recognised by the
// model's name, so a new release is coloured correctly the day it appears.

import { RuleError } from "../rules.ts";

export type PoolFamily = "anthropic" | "openai" | "zai" | "google" | "deepseek" | "qwen" | "minimax" | "mistral" | "meta" | "moonshot" | "xai" | "xiaomi" | "bytedance" | "cohere" | "other";
export const HARNESSES = ["opencode", "claude-code", "codex", "zcode", "gemini-cli", "antigravity"] as const;
export const PROVIDERS = ["ai-studio", "openai-compatible", "google", "deepseek", "openrouter", "anthropic", "openai", "subscription"] as const;
export type PoolHarness = (typeof HARNESSES)[number];
export type PoolProvider = (typeof PROVIDERS)[number];

export interface ModelStatus {
  state: "available" | "refused" | "slow" | "unknown";
  at: string;
  by: string;                 // the runner that reported it, kind:name
  served?: string;            // the model name the provider reported serving
  detail?: string;
}

export interface ModelNote {
  at: string;
  by: string;                 // the owner who wrote it
  text: string;
  item?: string;              // the task it concerns; a note with none bears on every task
  project?: string;           // the project that task is in: task ids repeat across projects
}

export interface ModelEntry {
  id: string;                 // as the harness names it; the second half of an actor name
  harness: PoolHarness;
  where: "home" | "cloud";
  provider: PoolProvider;
  endpoint?: string;          // for an OpenAI-compatible provider
  keychain?: string;          // the Keychain entry's name on the runner's machine
  aliases: string[];
  family: PoolFamily;
  note: string;
  addedBy: string;
  addedAt: string;
  status?: ModelStatus;
  notes?: ModelNote[];        // oldest first; read with the entry, never stored on it
}

// Names, as patterns, oldest-established first within each family. Anything
// none matches is "other", and the Models page says so.
const FAMILIES: [PoolFamily, RegExp][] = [
  ["anthropic", /^(claude|opus|sonnet|haiku|fable)\b|anthropic/i],
  ["openai", /^(gpt|o\d|codex|chatgpt)\b|^gpt-|openai/i],
  ["zai", /^glm|zhipu|z-?ai/i],
  ["google", /^(gemini|gemma)|google/i],
  ["deepseek", /deepseek/i],
  ["qwen", /^qwen|qwq/i],
  ["minimax", /minimax/i],
  ["mistral", /mistral|codestral|devstral|magistral/i],
  ["meta", /^llama|meta-llama/i],
  ["moonshot", /^kimi\b|moonshot/i],
  ["xai", /^grok\b|x-?ai\b/i],
  ["xiaomi", /^mimo\b|xiaomi/i],
  ["bytedance", /^seed\b|bytedance|doubao/i],
  ["cohere", /^command\b|cohere|^north\b/i],
];

export function familyOf(model: string): PoolFamily {
  const name = model.split("/").pop() ?? model;
  return FAMILIES.find(([, re]) => re.test(name) || re.test(model))?.[0] ?? "other";
}

// A model quantised for a local server: its name says how it was packed.
export const LOCAL_BUILD = /(\d+(_\d+)?bit|mlx|mxfp4|gguf|q\d_k|:studio)/i;

const ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;            // as a dispatch names a model (src/dispatch/rules.ts)
const KEYCHAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

// What a key looks like, so one pasted where an entry's name belongs is
// refused rather than stored: the prefixes providers give their keys, or a
// long run of key characters with no separator a name would have.
// A provider's key prefix, only at the start of a word and followed by at
// least eight key characters, so "task-model", "flask_app" and "/ask-me/"
// are not taken for keys.
const KEY_PREFIX = /(?<![A-Za-z0-9])(?:sk-|sk_|hf_|AIza|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|eyJ)[A-Za-z0-9_\-.]{8,}|Bearer [A-Za-z0-9._\-]{8,}/;
// A long run of letters and digits, mixing both, as random keys are and
// names are not; some keys join two such runs with a dot (id.secret).
const KEY_RUN = /[A-Za-z0-9]*(?:[A-Za-z][A-Za-z0-9]*[0-9]|[0-9][A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]*/g;
const hasKeyRun = (s: string) => (s.match(KEY_RUN) ?? []).some((run) => run.length >= 24);
const LOOKS_LIKE_KEY = { test: (s: string) => KEY_PREFIX.test(s) || hasKeyRun(s) };
// Any part of an endpoint's path that looks like a key.
const keyInPath = (path: string) => path.split("/").some((seg) => LOOKS_LIKE_KEY.test(seg));

// What a runner reports is shown to the owner; a key a provider echoed back
// in an error is replaced before it is stored.
// A long mixed run, with any dotted parts that follow it (id.secret), goes as one.
const KEY_WITH_PARTS = /[A-Za-z0-9]{24,}(?:\.[A-Za-z0-9_-]{6,})*/g;

export function redactKeys(s: string): string {
  return s.replace(new RegExp(KEY_PREFIX.source, "g"), "[key removed]")
    .replace(KEY_WITH_PARTS, (whole) => (hasKeyRun(whole.split(".")[0]) ? "[key removed]" : whole));
}

// A pool entry from a form or an API body, validated, or a RuleError saying
// what is wrong. Nothing that could hold a secret is accepted: an endpoint
// with a user name or password in it, or a "key" field, is refused.
export function cleanEntry(body: Record<string, unknown>, by: string, at: string): ModelEntry {
  const bad = (detail: string) => new RuleError("bad_model", detail, 400);
  if ("key" in body || "apiKey" in body || "token" in body) throw bad("Atelier never stores keys; give the name of the Keychain entry that holds it");
  const id = str(body.id);
  if (!ID.test(id)) throw bad(`"${id}" is not a model id Atelier can record`);
  // A key pasted into any field by mistake is refused, never stored or shown.
  const pasted = (s: string) => LOOKS_LIKE_KEY.test(s);
  if (pasted(id)) throw bad("the model id looks like a key; a key belongs in the Keychain");
  const harness = str(body.harness) as PoolHarness;
  if (!HARNESSES.includes(harness)) throw bad(`harness must be one of ${HARNESSES.join(", ")}`);
  const where = str(body.where);
  if (where !== "home" && where !== "cloud") throw bad("where must be home or cloud");
  // At home, OpenCode means the Studio; in the cloud it has to say who serves it.
  if (!str(body.provider) && harness === "opencode" && where === "cloud") throw bad("say which provider serves this model in the cloud");
  const provider = (str(body.provider) || (harness === "opencode" ? "ai-studio" : "subscription")) as PoolProvider;
  if (!PROVIDERS.includes(provider)) throw bad(`provider must be one of ${PROVIDERS.join(", ")}`);
  const endpoint = str(body.endpoint);
  if (endpoint) {
    let u: URL;
    try { u = new URL(endpoint); } catch { throw bad("endpoint must be a URL"); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw bad("endpoint must be http or https");
    if (u.username || u.password) throw bad("an endpoint must not carry a user name or password");
    if (u.search || u.hash) throw bad("an endpoint must not carry a query or fragment; a key belongs in the Keychain");
    if (keyInPath(decodeURIComponent(u.pathname))) throw bad("an endpoint's path looks like it carries a key; a key belongs in the Keychain");
  }
  const keychain = str(body.keychain);
  if (keychain && (!KEYCHAIN.test(keychain) || LOOKS_LIKE_KEY.test(keychain))) throw bad("keychain must be the name of a Keychain entry, such as gemini.API_KEY, never the key itself");
  const aliases = (Array.isArray(body.aliases) ? body.aliases : str(body.aliases).split(","))
    .map(str).filter(Boolean).slice(0, 10);
  if (aliases.some((a) => !ID.test(a))) throw bad("an alias must be a model id");
  if (aliases.some(pasted)) throw bad("an alias looks like a key; a key belongs in the Keychain");
  if (pasted(str(body.note))) throw bad("the note looks like it carries a key; a key belongs in the Keychain");
  const family = (str(body.family) || familyOf(id)) as PoolFamily;
  return {
    id, harness, where, provider,
    ...(endpoint ? { endpoint } : {}),
    ...(keychain ? { keychain } : {}),
    aliases, family: FAMILIES.some(([f]) => f === family) ? family : familyOf(id),
    note: str(body.note).slice(0, 300), addedBy: by, addedAt: at,
  };
}

export function cleanStatus(body: Record<string, unknown>, at: string, by: string): ModelStatus {
  const state = str(body.state);
  if (!["available", "refused", "slow", "unknown"].includes(state)) throw new RuleError("bad_status", "state must be available, refused, slow or unknown", 400);
  const served = redactKeys(plain(str(body.served)).trim()).slice(0, 128);
  const detail = redactKeys(plain(str(body.detail)).trim()).slice(0, 300);
  return { state: state as ModelStatus["state"], at, by, ...(served ? { served } : {}), ...(detail ? { detail } : {}) };
}

// The fields a status was observed under: change one and the status no
// longer describes the entry.
export const OBSERVED_UNDER = ["harness", "where", "provider", "endpoint", "keychain"] as const;

export function cleanNote(body: Record<string, unknown>, by: string, at: string): ModelNote {
  const bad = (detail: string) => new RuleError("bad_note", detail, 400);
  const text = plain(str(body.text)).trim();
  if (!text) throw bad("a note needs text");
  if (text.length > 500) throw bad("a note is at most 500 characters");
  if (LOOKS_LIKE_KEY.test(text)) throw bad("the note looks like it carries a key; a key belongs in the Keychain");
  const item = str(body.item);
  if (item && !/^t[1-9]\d*$/.test(item)) throw bad("a note names the task it concerns, such as t406, or none");
  const project = plain(str(body.project)).trim();
  if (item && !project) throw bad("a note on a task names its project, such as alpha");
  if (project && !item) throw bad("a note names a project only with the task it concerns");
  if (project.length > 100) throw bad("a project name is at most 100 characters");
  return { at, by, text, ...(item ? { item, project } : {}) };
}

const noteTask = (n: ModelNote) => (n.project ? `${n.project}/${n.item}` : n.item ?? "");

// The latest of an entry's notes that bears on a task: one that names no task, or that names this task in this project.
export function latestNote(entry: Pick<ModelEntry, "notes">, project: string, item: string): ModelNote | undefined {
  return (entry.notes ?? []).filter((n) => !n.item || (n.item === item && n.project === project)).at(-1);
}

export const noteLine = (n: ModelNote) => `Latest note, ${n.at.slice(0, 10)} by ${n.by}${n.item ? ` on ${noteTask(n)}` : ""}: ${n.text}`;
