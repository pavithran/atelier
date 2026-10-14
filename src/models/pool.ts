// The model pool: the models the owner has made available to Atelier, each
// with the harness that drives it, where it runs and, for an API, which
// provider serves it and the name of the Keychain entry that holds its key.
// Atelier stores the entry's name, never a key; the runner on the owner's
// machine reads the key when it needs it. Families are recognised by the
// model's name, so a new release is coloured correctly the day it appears.

import { modelKey, RuleError } from "../rules.ts";

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

// The owner's standing for a model, apart from the runner's report (status):
// paused keeps it out of the pool until the owner turns it back on, and
// reserved holds it back for a reason the note records (spent credits, a
// source down for a spell), so routing, dispatch suggestions and review
// requests skip both. "available" is the default and means nothing is held.
export const MODEL_STATES = ["available", "paused", "reserved"] as const;
export type ModelState = (typeof MODEL_STATES)[number];

// The jobs a model may take. A model lists the roles it is fit for, and
// routing never gives it the others: a review-only model is never a builder.
// An entry that names none takes every role, as before these were recorded.
export const MODEL_ROLES = ["build", "review", "plan"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

// The tiers the owner decided (2026-10-08): frontier models for the hardest
// work, execution models for the everyday, budget models for the cheap. The
// tier is stored and returned, and is informational; routing reads roles and
// state, not the tier.
export const MODEL_TIERS = ["frontier", "execution", "budget"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface ModelNote {
  at: string;
  by: string;                 // the owner who wrote it
  text: string;
  item?: string;              // the task it concerns; a note with none bears on every task
  project?: string;           // the project's stable key, not its name: task ids repeat across projects
  projectName?: string;       // the project's current name, read with the note and never stored
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
  state?: ModelState;         // the owner's standing; paused and reserved skip it
  stateAt?: string;           // when the state was last set
  roles?: readonly ModelRole[]; // the jobs it may take; all three when none are named
  tier?: ModelTier;           // frontier, execution or budget
  notes?: ModelNote[];        // oldest first; read with the entry, never stored on it
}

// The state as routing reads it: available unless the owner paused or reserved it.
export function modelState(entry: Pick<ModelEntry, "state">): ModelState {
  return entry.state ?? "available";
}

// Whether routing, dispatch suggestions and review requests skip the model.
export function offThePool(entry: Pick<ModelEntry, "state">): boolean {
  const state = modelState(entry);
  return state === "paused" || state === "reserved";
}

// Whether the entry may take a job; an entry that names no roles takes every one.
export function hasModelRole(entry: Pick<ModelEntry, "roles">, role: ModelRole): boolean {
  return !entry.roles?.length || entry.roles.includes(role);
}

// Entries saved earlier (a plan's pool, fixed at its approval) with the
// owner's standing as the pool has it now laid over each: a model paused,
// reserved or given other roles since is skipped as the pool would skip it.
// The standing is read from the entry itself (its harness and id) whatever
// the pool's order, never from another entry that merely lists its id as an
// alias. An entry the pool no longer has keeps its saved standing, and is
// held besides by whatever holds the entries now running its model, so
// neither a removed held entry nor its role limits are released through
// another entry's alias (gemini-4-argon's and gpt-6-astra's ninth and tenth
// reviews of t622, t649).
export function withStanding(saved: readonly ModelEntry[], current: readonly ModelEntry[]): ModelEntry[] {
  return saved.map((entry) => {
    const { own, runs } = standingEntries(current, `${entry.harness}/${entry.id}`);
    if (own.length) return layStanding(entry, own);
    return runs.length ? layStanding(entry, [entry, ...runs]) : entry;
  });
}

// A saved entry with the standing of the entries that hold it now, as
// actorStanding reads them for every role: held (paused or reserved, with
// that entry's note) when any one is, and given only the roles all of them
// share. Roles they share none of cannot be written as roles (none means
// all), so the first entry's roles stand; the dispatch check reads the pool now
// and refuses what they would let through.
function layStanding(entry: ModelEntry, from: readonly ModelEntry[]): ModelEntry {
  const { state: _state, stateAt: _stateAt, roles: _roles, ...rest } = entry;
  const now = from.find(offThePool) ?? from[0];
  const named = from.map((e) => e.roles).filter((r): r is readonly ModelRole[] => !!r?.length);
  const shared = MODEL_ROLES.filter((r) => named.every((of) => of.includes(r)));
  const roles = named.length ? (shared.length ? shared : named[0]) : undefined;
  return {
    ...rest, note: now.note,
    ...(now.state ? { state: now.state } : {}), ...(now.stateAt ? { stateAt: now.stateAt } : {}),
    ...(roles ? { roles } : {}),
  };
}

// The one check every path makes before it chooses or accepts a model for a
// job: dispatch suggestions, routing, a plan's planner, reviewer suggestions,
// tier and plan reviews, carried requests and every model the owner names.
// It says why the owner's standing keeps the entry from the role (paused or
// reserved, with its note; or without the role), or null when it may take it.
// test/pool-standing.test.mjs lists every path and fails if one skips it.
const ROLE_NOUN: Record<ModelRole, string> = { build: "builder", review: "reviewer", plan: "planner" };
export function standingRefusal(entry: ModelEntry, role: ModelRole): string | null {
  if (offThePool(entry)) return `${modelState(entry)} since ${(entry.stateAt ?? entry.addedAt).slice(0, 10)} (the developer's standing)${entry.note ? `: ${entry.note}` : ""}`;
  if (!hasModelRole(entry, role)) return `not a ${ROLE_NOUN[role]}; its roles are ${entry.roles!.join(", ")}`;
  return null;
}

// The same check for an actor (harness/model, the model by its id or an
// alias, or a bare model a dispatch names without a harness), prefixed with
// its name. An actor outside the pool is not held. Of the entries
// standingEntries reads, the first that refuses the role holds it, so the
// answer never depends on the pool's order.
export function actorStanding(pool: readonly ModelEntry[], actor: string, role: ModelRole): string | null {
  const { own, runs } = standingEntries(pool, actor);
  const refusal = (own.length ? own : runs).map((e) => standingRefusal(e, role)).find((why) => why !== null) ?? null;
  return refusal ? `${actor} is ${refusal}` : null;
}

// The actor a dispatch's standing is checked as: harness/model, or the bare
// model when it names no harness, which actorStanding holds when any entry
// running that model is held (t649: such a dispatch was not checked at all).
// A dispatch that names no model is the runner's choice and holds nothing.
export function dispatchActor(d: { agent: string | null; model: string | null }): string | null {
  if (!d.model) return null;
  return d.agent ? `${d.agent}/${d.model}` : d.model;
}

// Whether a pool entry runs the model an actor or a bare model name names,
// by modelKey: letter case, a ":profile" suffix and the harness do not make
// another model, so "codex/gpt-6-astra:high" runs the entry gpt-6-astra.
export function entryRuns(entry: Pick<ModelEntry, "id" | "aliases">, name: string): boolean {
  const key = modelKey(name);
  return [entry.id, ...entry.aliases].some((id) => modelKey(id) === key);
}

// The entries whose standing holds for an actor. own is the entry itself,
// under the actor's harness: the entry whose id is the actor's model
// exactly (two ids may differ only in letter case and be two entries, as
// src/models/identity.ts reads them), else those whose id is the same model
// by modelKey (a profile or letter case is the same entry). When the pool
// has it, its standing is the actor's, ahead of any entry that merely lists
// the model as an alias, whatever the pool's order. When it has none (a
// bare model, a removed entry, the model under another harness or only as
// an alias), runs is every entry running the model, and any one of them
// that is held holds the actor: an alias never releases what its entry holds.
function standingEntries(pool: readonly ModelEntry[], actor: string): { own: ModelEntry[]; runs: ModelEntry[] } {
  const runs = pool.filter((e) => entryRuns(e, actor));
  const slash = actor.indexOf("/");
  const harness = slash === -1 ? null : actor.slice(0, slash).toLowerCase();
  const model = slash === -1 ? actor : actor.slice(slash + 1);
  const key = modelKey(actor);
  const exact = runs.filter((e) => e.harness === harness && e.id === model);
  return { own: exact.length ? exact : runs.filter((e) => e.harness === harness && modelKey(e.id) === key), runs };
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

// Every family a name can be recognised as, in the order above: the
// companies a project may run on alone (`atelier init --single-family`).
export const POOL_FAMILIES: readonly PoolFamily[] = FAMILIES.map(([family]) => family);

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
// Scan each run once: failure logs can contain very long alphabetic lines.
const hasKeyRun = (s: string) => (s.match(/[A-Za-z0-9]+/g) ?? []).some((run) => run.length >= 24 && /[A-Za-z]/.test(run) && /[0-9]/.test(run));
export const LOOKS_LIKE_KEY = { test: (s: string) => KEY_PREFIX.test(s) || hasKeyRun(s) };
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
  const given = (k: string) => body[k] !== undefined && body[k] !== null;
  const state = given("state") ? (str(body.state) as ModelState) : undefined;
  if (state !== undefined && !MODEL_STATES.includes(state)) throw bad(`state must be one of ${MODEL_STATES.join(", ")}`);
  const roles = given("roles") ? cleanRoles(body.roles, bad) : undefined;
  const tier = given("tier") ? cleanTier(body.tier, bad) : undefined;
  return {
    id, harness, where, provider,
    ...(endpoint ? { endpoint } : {}),
    ...(keychain ? { keychain } : {}),
    aliases, family: FAMILIES.some(([f]) => f === family) ? family : familyOf(id),
    note: str(body.note).slice(0, 300), addedBy: by, addedAt: at,
    ...(state !== undefined ? (state !== "available" ? { state, stateAt: at } : { state: "available", stateAt: at }) : {}),
    ...(given("roles") ? { roles } : {}),
    ...(given("tier") ? { tier } : {}),
  };
}

// A roles value: a list, or names separated by commas, each a model role.
// Nothing, or a list that empties, means every role, which is not stored.
function cleanRoles(v: unknown, bad: (detail: string) => RuleError): readonly ModelRole[] | undefined {
  const names = (Array.isArray(v) ? v : str(v).split(",")).map(str).filter(Boolean);
  if (!names.length) return undefined;
  const roles = [...new Set(names)] as ModelRole[];
  if (roles.some((r) => !MODEL_ROLES.includes(r))) throw bad(`roles must be some of ${MODEL_ROLES.join(", ")}`);
  return roles;
}

function cleanTier(v: unknown, bad: (detail: string) => RuleError): ModelTier | undefined {
  const tier = str(v);
  if (!tier) return undefined;
  if (!MODEL_TIERS.includes(tier as ModelTier)) throw bad(`tier must be one of ${MODEL_TIERS.join(", ")}`);
  return tier as ModelTier;
}

export function cleanStatus(body: Record<string, unknown>, at: string, by: string): ModelStatus {
  const state = str(body.state);
  if (!["available", "refused", "slow", "unknown"].includes(state)) throw new RuleError("bad_status", "state must be available, refused, slow or unknown", 400);
  const served = redactKeys(plain(str(body.served)).trim()).slice(0, 128);
  const detail = redactKeys(plain(str(body.detail)).trim()).slice(0, 300);
  return { state: state as ModelStatus["state"], at, by, ...(served ? { served } : {}), ...(detail ? { detail } : {}) };
}

// What `atelier models set` may change on an entry: its state, note, roles
// and tier, each optional and, when absent, left as it was. Only a field
// actually given is returned, so a set that names nothing is empty and
// changes nothing. No field here may carry a key.
export interface ModelSet {
  state?: ModelState;
  note?: string;
  roles?: readonly ModelRole[];
  tier?: ModelTier;
}

export function cleanModelSet(body: Record<string, unknown>): ModelSet {
  const bad = (detail: string) => new RuleError("bad_model", detail, 400);
  const out: ModelSet = {};
  const given = (k: string) => body[k] !== undefined && body[k] !== null;
  if (given("state")) {
    const state = str(body.state) as ModelState;
    if (!MODEL_STATES.includes(state)) throw bad(`state must be one of ${MODEL_STATES.join(", ")}`);
    out.state = state;
  }
  if (given("note")) {
    const note = str(body.note);
    if (LOOKS_LIKE_KEY.test(note)) throw bad("the note looks like it carries a key; a key belongs in the Keychain");
    out.note = note.slice(0, 300);
  }
  if (given("roles")) {
    const roles = cleanRoles(body.roles, bad);
    if (roles) out.roles = roles;
  }
  if (given("tier")) out.tier = cleanTier(body.tier, bad);
  return out;
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

const noteTask = (n: ModelNote) => (n.project ? `${n.projectName ?? n.project}/${n.item}` : n.item ?? "");

// The latest of an entry's notes that bears on a task: one that names no task, or that names this task in this project's key.
export function latestNote(entry: Pick<ModelEntry, "notes">, projectKey: string, item: string): ModelNote | undefined {
  return (entry.notes ?? []).filter((n) => !n.item || (n.item === item && n.project === projectKey)).at(-1);
}

export const noteLine = (n: ModelNote) => `Latest note, ${n.at.slice(0, 10)} by ${n.by}${n.item ? ` on ${noteTask(n)}` : ""}: ${n.text}`;
