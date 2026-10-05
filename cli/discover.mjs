// Runner discovery: what each home model's harness actually serves.
//
// `atelier runner --discover` reads the model pool from Atelier, finds what
// each harness has served from the records the tools keep (no request is
// made), and with --probe sends one minimal request per model. It reports
// each model through POST /api/models/ID/status, with the served model, and
// prints a table. It exists because a harness once served a different model
// from the one recorded, for two days, and nothing said so.
//
// Local records, read without a request:
//   Codex     ~/.codex/sessions/**/*.jsonl: "turn_context" records name the
//             model, "rate_limits" records give the 5-hour and weekly use.
//             Session files can be gigabytes, so only a file's tail is read.
//   zcode     ~/.zcode/cli/db/db.sqlite, table model_usage: one row per
//             request, with the model_id that answered.
//   opencode  ~/.local/share/opencode/opencode.db, table message: JSON in
//             data, with each assistant message's modelID, tokens and cost.
// The databases are opened read only, as URIs with ?mode=ro, through
// node:sqlite, or through the sqlite3 command when Node has no SQLite module.
//
// Probes, only with --probe, one short prompt each: claude -p for Claude
// Code, zcode -p followed by reading the model_usage row it added, and a
// single models list call for the Gemini API. The Studio's models (provider
// ai-studio) are paused by the owner and Codex's weekly allowance is
// reserved, so neither is ever probed.
//
// A key is read only by the exact Keychain entry name the runner config gives
// for a model, through credentials.mjs, and goes to a child process's
// environment. It is never printed, logged, written or put in a URL. The
// config names the entry beside "agents", for any model in the pool:
//   "keychain": { "gemini-3.1-pro": "gemini.API_KEY" }
// and credentials.mjs finds that secret as it finds any (on macOS, the
// Keychain item atelier.gemini.API_KEY). No Keychain entry is ever listed.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { redactKeys } from "../src/models/pool.ts";
import { readSecret } from "./credentials.mjs";
import { execute } from "./runner.mjs";
import { readConfig } from "./runner-config.mjs";

export const PROBE_PROMPT = "Reply with OK";
export const PROBE_TIMEOUT_MS = 120_000;
export const SLOW_MS = 30_000;          // an answer slower than this is reported as slow
export const RECENT_MS = 7 * 86_400_000; // a model last served longer ago than this is not shown as available
export const LOOKBACK_MS = 30 * 86_400_000;
const MAX_LINE = 256 * 1024;
const TAIL_STEPS = [4, 16, 64].map((n) => n * 1024 * 1024);
const GOOGLE_KEY_ENV = "GEMINI_API_KEY";
const USAGE = "usage: atelier runner --discover [--name home:NAME] [--probe] [--dry-run] [--config PATH]";

// Harnesses whose record names the model the harness itself chose, so a
// different name there can be a silent substitution. OpenCode's record names
// the model each call asked for, and many models share one record.
const SELF_CHOOSING = new Set(["zcode", "codex"]);
const LOCAL_SOURCES = new Set(["codex", "zcode", "opencode"]);

// ── plain text ─────────────────────────────────────────────────────────────

const stamp = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";
const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))} s`;
const firstLine = (text) => String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";

// Anything a log, a provider or the server supplied is one line of plain text
// before it is shown or reported: no control characters, no key.
export function clean(value, max = 200) {
  return redactKeys(String(value ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")).replace(/\s+/g, " ").trim().slice(0, max);
}

// ── model names ────────────────────────────────────────────────────────────

// One model under the names harnesses give it: claude-sonnet-5-5-20261001,
// anthropic/sonnet-5.5 and Sonnet-5.5 are the same model.
export function normalizeModel(name) {
  return String(name ?? "").trim().toLowerCase()
    .replace(/^.*\//, "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/[._]/g, "-");
}

export function sameModel(served, registered, aliases = []) {
  const name = normalizeModel(served);
  return !!name && [registered, ...aliases].some((m) => normalizeModel(m) === name);
}

// ── Codex: ~/.codex/sessions ───────────────────────────────────────────────

export function windowName(minutes) {
  if (minutes >= 240 && minutes <= 360) return "5-hour";
  if (minutes >= 9000 && minutes <= 11000) return "weekly";
  return Number.isFinite(minutes) ? `${minutes}-minute` : "unnamed";
}

// Which window is which comes from its length, never from its position: a
// log can hold only the weekly window as "primary".
function limitWindows(limits, at) {
  if (!limits || typeof limits !== "object") return [];
  return [limits.primary, limits.secondary].flatMap((w) => {
    if (!w || typeof w !== "object" || !Number.isFinite(w.used_percent)) return [];
    const minutes = Number(w.window_minutes);
    let resetsAt = null;
    if (Number.isFinite(w.resets_at)) resetsAt = w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000;
    else if (Number.isFinite(w.resets_in_seconds) && Number.isFinite(at)) resetsAt = at + w.resets_in_seconds * 1000;
    return [{ name: windowName(minutes), minutes, usedPercent: w.used_percent, resetsAt }];
  });
}

// Lines of one session file, oldest first. Only "turn_context" records and
// records carrying "rate_limits" are parsed; the rest of a session is
// conversation and is never looked at.
export function parseCodexLines(lines) {
  const models = new Map();
  let limits = null;
  for (const line of lines) {
    if (line.length > MAX_LINE || !(line.includes('"turn_context"') || line.includes('"rate_limits"'))) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const at = Date.parse(record?.timestamp);
    if (!Number.isFinite(at)) continue;
    if (record.type === "turn_context") {
      const model = record.payload?.model ?? record.payload?.collaboration_mode?.settings?.model;
      if (typeof model === "string" && model) models.set(model, Math.max(models.get(model) ?? 0, at));
    }
    const windows = limitWindows(record.payload?.rate_limits ?? record.rate_limits, at);
    if (windows.length && (!limits || at >= limits.at)) limits = { at, windows };
  }
  return { seen: [...models].map(([model, at]) => ({ model, at })).sort((a, b) => b.at - a.at), limits };
}

// The last `bytes` of a file, from the first whole line on.
function readTail(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const got = readSync(fd, buf, off, n - off, size - n + off);
      if (!got) break;
      off += got;
    }
    const text = buf.toString("utf8", 0, off);
    if (n >= size) return { text, whole: true };
    const i = text.indexOf("\n");
    return { text: i < 0 ? "" : text.slice(i + 1), whole: false };
  } finally { closeSync(fd); }
}

// Session files, newest first by when they were last written: a long session
// started weeks ago is still the one in use.
export function codexSessionFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(path, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try { found.push({ path, mtime: statSync(path).mtimeMs }); } catch { /* removed since it was listed */ }
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.mtime - a.mtime);
}

// What Codex last served and its last rate limits. A file's tail is read, in
// steps of growing size, until both are found or the file is read whole.
export function readCodexSessions(root, { files = 6 } = {}) {
  const list = codexSessionFiles(root).slice(0, files);
  if (!list.length) return { error: `no Codex session files under ${root}` };
  const models = new Map();
  let limits = null;
  for (const { path } of list) {
    try {
      for (const bytes of TAIL_STEPS) {
        const { text, whole } = readTail(path, bytes);
        const found = parseCodexLines(text.split("\n"));
        for (const s of found.seen) models.set(s.model, Math.max(models.get(s.model) ?? 0, s.at));
        if (found.limits && (!limits || found.limits.at >= limits.at)) limits = found.limits;
        if (whole || (found.seen.length && found.limits)) break;
      }
    } catch (error) { return { error: `could not read ${path}: ${error.message}` }; }
    if (models.size && limits) break;
  }
  return { seen: [...models].map(([model, at]) => ({ model, at })).sort((a, b) => b.at - a.at), limits };
}

// "5-hour 12% used, resets T; weekly 81% used, resets T", always naming both.
export function describeLimits(limits, now) {
  if (!limits) return "no rate limits in the log";
  const part = (w) => w.resetsAt !== null && w.resetsAt <= now
    ? `${w.name} reset at ${stamp(w.resetsAt)} (was ${w.usedPercent}% used)`
    : `${w.name} ${w.usedPercent}% used${w.resetsAt !== null ? `, resets ${stamp(w.resetsAt)}` : ""}`;
  const named = (name) => limits.windows.filter((w) => w.name === name).map(part)[0] ?? `${name} not reported`;
  const others = limits.windows.filter((w) => w.name !== "5-hour" && w.name !== "weekly").map(part);
  return [named("5-hour"), named("weekly"), ...others].join("; ") + `; as of ${stamp(limits.at)}`;
}

// ── zcode and opencode: SQLite ─────────────────────────────────────────────

const int = (n) => Math.trunc(Number(n));

export const zcodeSql = (since) => `SELECT session_id, provider_id, model_id, status, started_at, error_type FROM model_usage WHERE started_at >= ${int(since)} ORDER BY started_at DESC LIMIT 5000`;
export const opencodeSql = (since) => `SELECT time_created, data FROM message WHERE json_extract(data, '$.role') = 'assistant' AND time_created >= ${int(since)} ORDER BY time_created DESC LIMIT 5000`;

function bySighting(models) {
  return [...models.values()].sort((a, b) => b.at - a.at);
}

// Rows of model_usage. Only a completed request counts as served; started_at
// is in milliseconds.
export function parseZcodeRows(rows) {
  const models = new Map();
  for (const row of rows ?? []) {
    const at = Number(row?.started_at);
    if (row?.status !== "completed" || typeof row.model_id !== "string" || !row.model_id || !Number.isFinite(at)) continue;
    const seen = models.get(row.model_id) ?? { model: row.model_id, provider: row.provider_id ?? null, at: 0, count: 0 };
    models.set(row.model_id, { ...seen, provider: at >= seen.at ? row.provider_id ?? null : seen.provider, at: Math.max(seen.at, at), count: seen.count + 1 });
  }
  return bySighting(models);
}

// The rows a zcode probe added: the model that answered it. More than one
// session writing during the probe means the rows cannot be told apart.
export function attributeProbe(rows, since) {
  const added = (rows ?? []).filter((r) => Number(r?.started_at) >= since);
  if (!added.length) return { state: "unknown", detail: "zcode wrote no model_usage row" };
  if (new Set(added.map((r) => r.session_id)).size > 1) return { state: "unknown", detail: "more than one zcode session wrote requests during the probe; run it again when zcode is idle" };
  const done = added.filter((r) => r.status === "completed").sort((a, b) => Number(b.started_at) - Number(a.started_at))[0];
  const failed = [...new Set(added.filter((r) => r.status === "error" && r.model_id !== done?.model_id).map((r) => r.model_id))];
  if (done) {
    return { state: "available", served: done.model_id,
      detail: `answered as ${done.model_id}${failed.length ? ` after ${failed.join(", ")} failed` : ""}` };
  }
  const error = added.find((r) => r.status === "error");
  if (error) return { state: "refused", detail: `${error.model_id} failed${error.error_type ? ` (${error.error_type})` : ""}` };
  return { state: "unknown", detail: "zcode wrote a model_usage row that did not complete" };
}

// Rows of message, `data` being the JSON text opencode stores. Assistant
// messages that carry an error were not served.
export function parseOpencodeRows(rows) {
  const models = new Map();
  for (const row of rows ?? []) {
    let data = row?.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { continue; } }
    if (!data || data.role !== "assistant" || typeof data.modelID !== "string" || !data.modelID || data.error) continue;
    const at = Number(data.time?.created ?? row.time_created);
    if (!Number.isFinite(at)) continue;
    const tokens = Number(data.tokens?.total ?? 0) || 0, cost = Number(data.cost ?? 0) || 0;
    const seen = models.get(data.modelID) ?? { model: data.modelID, provider: data.providerID ?? null, at: 0, count: 0, tokens: 0, cost: 0 };
    models.set(data.modelID, { ...seen, provider: at >= seen.at ? data.providerID ?? null : seen.provider, at: Math.max(seen.at, at), count: seen.count + 1, tokens: seen.tokens + tokens, cost: seen.cost + cost });
  }
  return bySighting(models);
}

// A path as a read-only SQLite URI. node:sqlite is used when Node has it; the
// sqlite3 command otherwise. `via` says which, for the report.
export const readOnlyUri = (path) => pathToFileURL(path).href + "?mode=ro";

export async function sqliteReader({ load = () => import("node:sqlite"), run = spawnSync } = {}) {
  let sqlite = null;
  try { sqlite = await load(); } catch { /* an older Node: use the command */ }
  if (sqlite?.DatabaseSync) {
    return {
      via: "node:sqlite",
      query(path, sql) {
        const db = new sqlite.DatabaseSync(readOnlyUri(path), { readOnly: true, timeout: 3000 });
        try { return db.prepare(sql).all().map((row) => ({ ...row })); } finally { db.close(); }
      },
    };
  }
  return {
    via: "the sqlite3 command",
    query(path, sql) {
      const r = run("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 3000", readOnlyUri(path), sql], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (r.error) throw new Error(r.error.code === "ENOENT" ? "Node has no node:sqlite here and the sqlite3 command is not installed" : r.error.message);
      if (r.status !== 0) throw new Error(`sqlite3 exited ${r.status}: ${firstLine(r.stderr)}`);
      const out = String(r.stdout).trim();
      return out ? JSON.parse(out) : [];
    },
  };
}

export function defaultPaths(home = homedir()) {
  return {
    codex: join(home, ".codex", "sessions"),
    zcode: join(home, ".zcode", "cli", "db", "db.sqlite"),
    opencode: join(home, ".local", "share", "opencode", "opencode.db"),
  };
}

// What each harness in use has served, from its own record.
export async function gatherLogs(harnesses, io) {
  const logs = {};
  let via = null;
  if (harnesses.has("codex")) logs.codex = io.readCodex(io.paths.codex);
  for (const [harness, sql, parse] of [["zcode", zcodeSql, parseZcodeRows], ["opencode", opencodeSql, parseOpencodeRows]]) {
    if (!harnesses.has(harness)) continue;
    try {
      if (!existsSync(io.paths[harness])) throw new Error(`no ${harness} database at ${io.paths[harness]}`);
      const reader = await io.reader();
      via = reader.via;
      logs[harness] = { seen: parse(reader.query(io.paths[harness], sql(io.now() - LOOKBACK_MS))), via };
    } catch (error) { logs[harness] = { error: `${harness} record not read: ${error.message}` }; }
  }
  return { logs, via };
}

// ── probes ─────────────────────────────────────────────────────────────────

// What a model's probe is, or why it has none. Studio models and Codex are
// never probed, with or without --probe; nothing else is probed without it.
export function probePlan(entry, { probe = false } = {}) {
  if (entry.provider === "ai-studio") return { kind: null, reason: "paused by owner" };
  if (entry.harness === "codex") return { kind: null, reason: "Codex is never probed: its weekly allowance is reserved" };
  if (!probe) return { kind: null, reason: "not probed; add --probe" };
  if (entry.harness === "claude-code") return { kind: "claude" };
  if (entry.harness === "zcode") return { kind: "zcode" };
  if (entry.provider === "google") return { kind: "google" };
  return { kind: null, reason: `no probe for ${entry.harness} with ${entry.provider}` };
}

// A child gets the runner's environment without the Atelier credentials, and
// a key only if its probe needs one.
export function probeEnv(base, extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(base ?? {})) if (value !== undefined && !/^ATELIER_/i.test(name)) env[name] = value;
  return { ...env, ...extra };
}

// `claude -p --output-format json` prints one result object, or a list of
// events ending in one. modelUsage names each model that answered; the
// registered one is taken if present, else the one that wrote most.
export function parseClaudeProbe(text, entry) {
  let value;
  try { value = JSON.parse(text); } catch { return { state: "unknown", detail: "claude did not print JSON" }; }
  const result = Array.isArray(value) ? [...value].reverse().find((e) => e?.type === "result") : value;
  if (!result || typeof result !== "object") return { state: "unknown", detail: "claude printed no result" };
  if (result.is_error) return { state: "refused", detail: clean(firstLine(result.result ?? result.subtype) || "claude reported an error") };
  const used = Object.entries(result.modelUsage ?? {});
  if (!used.length) return { state: "available", detail: "answered; claude named no model" };
  const written = ([, u]) => Number(u?.outputTokens ?? 0);
  const [name] = used.find(([m]) => sameModel(m, entry.id, entry.aliases ?? [])) ?? [...used].sort((a, b) => written(b) - written(a))[0];
  return { state: "available", served: name, detail: `answered as ${name}` };
}

// The child that lists Gemini models prints only model names and a status.
export const GOOGLE_LIST_SCRIPT = `
const say = (value) => process.stdout.write(JSON.stringify(value));
try {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": process.env.${GOOGLE_KEY_ENV} ?? "" }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) say({ ok: false, status: res.status });
  else {
    const body = await res.json();
    say({ ok: true, names: (body.models ?? []).map((m) => String(m.name)), more: Boolean(body.nextPageToken) });
  }
} catch { say({ ok: false, status: 0 }); }
`;

export function parseGoogleList(text, entry) {
  let value;
  try { value = JSON.parse(text); } catch { return { state: "unknown", detail: "the models list gave no answer" }; }
  if (!value?.ok) {
    const status = Number(value?.status) || 0;
    if ([400, 401, 403, 404].includes(status)) return { state: "refused", detail: `the models list was refused (HTTP ${status})` };
    return { state: "unknown", detail: status ? `the models list failed (HTTP ${status})` : "the models list could not be reached" };
  }
  const names = (Array.isArray(value.names) ? value.names : []).map((n) => String(n).replace(/^models\//, ""));
  const listed = names.find((n) => sameModel(n, entry.id, entry.aliases ?? []));
  if (listed) return { state: "available", served: listed, detail: `listed by the provider (${names.length} models)` };
  if (value.more) return { state: "unknown", detail: `not in the first ${names.length} models the provider lists` };
  return { state: "refused", detail: `not in the provider's list of ${names.length} models` };
}

// One probe. `ran: false` means it could not be made, which says nothing
// about the model; any other outcome is what the model did.
export async function probeModel(kind, entry, config, io, scrub) {
  const child = (argv, extra, timeoutMs = PROBE_TIMEOUT_MS) => io.run(argv, {
    cwd: io.cwd, capture: true, captureError: true, timeoutMs, signal: io.signal, env: probeEnv(io.env, extra),
  });
  const started = io.now();
  try {
    if (kind === "claude") {
      const result = await child(["claude", "-p", "--model", entry.id, "--output-format", "json", PROBE_PROMPT]);
      if (result.timedOut) return { ran: true, state: "slow", detail: `no answer within ${seconds(PROBE_TIMEOUT_MS)}` };
      const outcome = parseClaudeProbe(result.output, entry);
      if (result.code !== 0 && outcome.state === "unknown") return { ran: true, state: "refused", detail: clean(firstLine(result.stderr || result.output) || `claude exited ${result.code}`) };
      return slowIfLate({ ran: true, ...outcome }, io.now() - started);
    }
    if (kind === "zcode") {
      const result = await child(["zcode", "-p", PROBE_PROMPT]);
      if (result.timedOut) return { ran: true, state: "slow", detail: `no answer within ${seconds(PROBE_TIMEOUT_MS)}` };
      const reader = await io.reader();
      const rows = reader.query(io.paths.zcode, zcodeSql(started));
      return slowIfLate({ ran: true, ...attributeProbe(rows, started) }, io.now() - started);
    }
    // The Gemini API: a models list call, no prompt, with the key in the child's environment.
    const entryName = config?.keychain?.[entry.id];
    if (!entryName) return { ran: false, detail: `the runner config names no Keychain entry for ${entry.id} (keychain)` };
    let key;
    try { key = io.readSecret(entryName); } catch (error) { return { ran: false, detail: `Keychain entry ${entryName} could not be read: ${error.message}` }; }
    if (!key) return { ran: false, detail: `Keychain entry ${entryName} holds no key` };
    scrub.add(key);
    const result = await child([process.execPath, "--input-type=module", "-e", GOOGLE_LIST_SCRIPT], { [GOOGLE_KEY_ENV]: key }, 30_000);
    if (result.timedOut) return { ran: true, state: "unknown", detail: "the models list timed out" };
    return { ran: true, ...parseGoogleList(result.output, entry) };
  } catch (error) {
    return { ran: false, detail: error.code === "ENOENT" ? `${kind === "google" ? "node" : kind} is not installed here` : error.message };
  }
}

const slowIfLate = (outcome, elapsed) =>
  outcome.state === "available" && elapsed > SLOW_MS ? { ...outcome, state: "slow", detail: `${outcome.detail}, after ${seconds(elapsed)}` } : outcome;

// ── what was found, per model ──────────────────────────────────────────────

// A model judged from what its harness has served. For a harness that
// chooses its own model, a request answered by any other model after the
// registered one last answered is a mismatch, whether or not the pool also
// registers that other model: the entry's own model is not what is being
// served now. A model that is absent from the record is not judged at all
// (`absent`): not being in a log is no evidence of anything, so the caller
// reports nothing for it.
export function judgeLog(entry, log, now) {
  const aliases = entry.aliases ?? [];
  const match = log.seen.find((s) => sameModel(s.model, entry.id, aliases));
  const strangers = !SELF_CHOOSING.has(entry.harness) ? [] : log.seen.filter((s) =>
    (!match || s.at > match.at) && !sameModel(s.model, entry.id, aliases));
  if (strangers.length) {
    const s = strangers[0];
    return { state: "refused", served: s.model, mismatch: true,
      detail: `${s.model} answered at ${stamp(s.at)}${match ? `, after ${match.model} last answered at ${stamp(match.at)}` : `; ${entry.id} is not in the record`}` };
  }
  if (!match) return { state: "unknown", absent: true, detail: `${entry.id} is not in the record` };
  if (now - match.at > RECENT_MS) return { state: "unknown", served: match.model, detail: `last answered at ${stamp(match.at)}; nothing recent` };
  return { state: "available", served: match.model, detail: `last answered at ${stamp(match.at)}${match.count ? `, ${match.count} requests in the record` : ""}` };
}

// The row for one pool entry. `ctx`: offered (is it in this runner's config),
// plan (probePlan), probe (an outcome), log (a harness's record) and now. A
// row is posted only with evidence: a probe's answer, or something the
// harness's record says about this model. No record of it is "no recent
// record", and nothing is posted.
export function decideRow(entry, ctx) {
  const id = entry.id, aliases = entry.aliases ?? [], paused = entry.provider === "ai-studio";
  const row = { id, harness: entry.harness, provider: entry.provider, offered: ctx.offered, state: "unknown", label: "not checked", served: null, source: "none", mismatch: false, detail: "", post: false };
  let found = null;
  const notes = [];
  if (ctx.probe?.ran) {
    found = { ...ctx.probe, source: "probe" };
    if (found.served && !sameModel(found.served, id, aliases)) {
      found = { ...found, state: "refused", mismatch: true, detail: `${found.detail}; the registered model is ${id}` };
    }
  } else if (ctx.log && !ctx.log.error) {
    found = { ...judgeLog(entry, ctx.log, ctx.now), source: "log" };
    if (ctx.log.limits) found.detail += `; ${describeLimits(ctx.log.limits, ctx.now)}`;
  }
  if (ctx.probe && !ctx.probe.ran) notes.push(`probe not run: ${ctx.probe.detail}`);
  else if ((!found || found.absent) && !ctx.probe && ctx.plan.reason && !paused) notes.push(ctx.plan.reason);
  if (ctx.log?.error) notes.push(ctx.log.error);
  else if (!ctx.log && !found && !LOCAL_SOURCES.has(entry.harness)) notes.push(`no local record is read for ${entry.harness}`);
  if (found?.absent) Object.assign(row, { label: "no recent record", detail: found.detail });
  else if (found) Object.assign(row, { state: found.state, label: found.state, served: found.served ?? null, source: found.source, mismatch: !!found.mismatch, post: true, detail: `${found.source}: ${found.detail}` });
  if (paused) Object.assign(row, { state: "unknown", label: "paused by owner", post: true, detail: ["paused by owner; not probed", found && row.detail].filter(Boolean).join("; ") });
  row.detail = [row.detail, ...notes].filter(Boolean).join("; ");
  return row;
}

// What is reported for a row: the state, the model served, and the detail.
export function statusBody(row) {
  return { state: row.state, ...(row.served ? { served: row.served } : {}), ...(row.detail ? { detail: row.detail } : {}) };
}

export function mismatchLines(rows) {
  return rows.filter((r) => r.mismatch).map((r) =>
    `${r.harness}/${r.id} is registered as ${r.id} but is served as ${r.served}. ${r.detail}`);
}

export function renderTable(rows) {
  const head = ["MODEL", "HARNESS", "PROVIDER", "SERVED", "STATUS", "EVIDENCE"];
  const cells = rows.map((r) => [r.id, r.harness, r.provider, r.served ?? "not known", r.label, r.source]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((x, i) => (i === c.length - 1 ? x : x.padEnd(widths[i]))).join("  ");
  return [line(head), ...cells.map(line)].join("\n");
}

// ── the command ────────────────────────────────────────────────────────────

// The command line, validated. The name defaults to this machine's.
export function discoverOptions(args, host = hostname()) {
  if (args._.length !== 1 || Object.keys(args.multi).some((k) => !["discover", "name", "probe", "dry-run", "config"].includes(k) || args.multi[k].length !== 1)) throw new Error(USAGE);
  for (const flag of ["discover", "probe", "dry-run"]) if (args[flag] !== undefined && args[flag] !== true) throw new Error(USAGE);
  if (args.config !== undefined && typeof args.config !== "string") throw new Error(USAGE);
  let name = args.name;
  if (name === undefined) name = `home:${host.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "runner"}`;
  if (typeof name !== "string" || !/^home:[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error("use --name home:NAME");
  return { name: `home:${name.slice(5)}`, probe: args.probe === true, dryRun: args["dry-run"] === true, configPath: args.config };
}

function defaultIo() {
  let reader;
  return {
    paths: defaultPaths(), env: process.env, cwd: tmpdir(), now: () => Date.now(), signal: undefined,
    run: execute, readSecret, readConfig, readCodex: readCodexSessions,
    reader: async () => (reader ??= await sqliteReader()),
    print: (text) => console.log(text),
  };
}

// io: pool() and report(id, body, runner) come from the CLI; everything else
// has a default, so a test supplies only what it replaces.
export async function runDiscover(args, given = {}) {
  const opts = discoverOptions(args);
  const io = { ...defaultIo(), ...given };
  // A key that was read is remembered, so no line printed or reported can carry it, whatever a tool echoed.
  const secrets = new Set();
  const scrub = { add: (value) => { if (value) secrets.add(value); } };
  const withoutKeys = (text) => [...secrets].reduce((s, secret) => s.split(secret).join("[key removed]"), String(text ?? ""));
  const safe = (text, max) => clean(withoutKeys(text), max);

  let config = null, configNote = "";
  try { config = io.readConfig(opts.configPath); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    configNote = "No runner config was found, so no model is shown as offered here and no Keychain entry is named.";
  }

  const pool = await io.pool();
  if (!Array.isArray(pool)) throw new Error("the model pool did not come back as a list");
  const home = pool.filter((m) => m.where === "home");
  const offers = (entry) => !!config?.agents.some((a) => a.agent === entry.harness && a.models.includes(entry.id));
  const { logs, via } = await gatherLogs(new Set(home.map((m) => m.harness).filter((h) => LOCAL_SOURCES.has(h))), io);

  const probes = new Map();
  for (const entry of home) {
    const plan = probePlan(entry, opts);
    if (!plan.kind) continue;
    if (io.signal?.aborted) throw new Error("interrupted");
    probes.set(entry.id, await probeModel(plan.kind, entry, config, io, scrub));
  }

  const now = io.now();
  const rows = home.map((entry) => decideRow(entry, {
    offered: offers(entry), plan: probePlan(entry, opts), probe: probes.get(entry.id), log: logs[entry.harness], now,
  })).map((row) => ({ ...row, id: safe(row.id, 64), served: row.served ? safe(row.served, 128) : null, detail: safe(row.detail, 300) }));

  const out = [
    `Pool: ${home.length} home model${home.length === 1 ? "" : "s"}${pool.length > home.length ? `; ${pool.length - home.length} cloud model${pool.length - home.length === 1 ? "" : "s"} left to a cloud runner` : ""}. Runner: ${opts.name}.`,
  ];
  if (configNote) out.push(configNote);
  if (via) out.push(`Local databases are read only, through ${via}.`);
  out.push(opts.probe
    ? `Probes: one short prompt each ("${PROBE_PROMPT}"), so each costs almost nothing; the Gemini check is one models list call and sends no prompt. Studio models and Codex are not probed.`
    : "Probes: none sent. Add --probe to send one short prompt per model; Studio models and Codex are never probed.");
  if (!home.length) out.push("", "The pool has no home models.");
  else {
    out.push("", renderTable(rows));
    const notOffered = rows.filter((r) => config && !r.offered).map((r) => `${r.harness}/${r.id}`);
    if (notOffered.length) out.push("", `Not in this runner's config, so it is not offered tasks: ${notOffered.join(", ")}.`);
    const mismatches = mismatchLines(rows);
    if (mismatches.length) out.push("", "Mismatch:", ...mismatches.map((m) => `  ${m}`));
    if (logs.codex && home.some((m) => m.harness === "codex")) out.push("", `Codex use, from its log: ${logs.codex.error ? safe(logs.codex.error) : describeLimits(logs.codex.limits, now)}.`);
    out.push("", "Details:", ...rows.map((r) => `  ${r.harness}/${r.id}: ${r.detail || "nothing found"}`));
  }

  const failed = [];
  let reported = 0;
  if (!opts.dryRun) {
    for (const row of rows.filter((r) => r.post)) {
      if (io.signal?.aborted) throw new Error("interrupted");
      try { await io.report(row.id, statusBody(row), opts.name); reported++; } catch (error) { failed.push(`${row.id}: ${safe(error.message)}`); }
    }
  }
  out.push("", opts.dryRun ? "Dry run: nothing was reported to Atelier." : `Reported ${reported} status${reported === 1 ? "" : "es"} to Atelier${rows.length - reported - failed.length ? `; ${rows.length - reported - failed.length} had nothing to report` : ""}.`);
  io.print(withoutKeys(out.join("\n")));
  if (failed.length) throw new Error(`could not report ${failed.length} status${failed.length === 1 ? "" : "es"}: ${failed.join("; ")}`);
  return rows;
}
