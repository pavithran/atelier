// Cloudflare AI Gateway costs: what each call through the account's AI
// Gateway cost, read from the gateway's own logs rather than from a tool's
// record on a runner's machine.
//
// A scheduled trigger (src/index.ts) pulls the logs newer than the newest
// one already written, a page at a time, newest first, from
//   GET https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai-gateway/gateways/{AI_GATEWAY_ID}/logs
// with the AI_GATEWAY_TOKEN secret (an API token with AI Gateway: Read) as
// a Bearer token, and writes one Analytics Engine data point per log
// (src/metrics.ts, kind "gateway"). The newest log written, its id and
// time, is kept on the index Ledger, and a pull writes only logs newer than
// it, oldest first, moving the mark past each log only once it is written,
// so a log is written once however many pulls see it and none is passed
// over unwritten. A pull that reads MAX_PAGES pages without reaching the
// mark records the stretch it did not read as a gap (GatewayGap), and the
// figures say so for as long as the gap is in their window. The Models page
// and GET /api/usage read the last GATEWAY_WINDOW_DAYS days back through the
// Analytics Engine SQL API (ANALYTICS_TOKEN): each model's calls, failures,
// tokens and cost summed in SQL, so they are exact at any volume, and its
// median duration over the newest ROW_LIMIT durations, with the sample size.
// With no AI_GATEWAY_TOKEN the trigger does nothing and the page says so.
//
// The response fields read (parseLog) are those of a log in the list:
// id, created_at, provider, model, tokens_in, tokens_out, cost (dollars),
// duration (milliseconds), success, and metadata, the cf-aig-metadata
// header the caller sent, as a JSON string or an object. Of the metadata
// only task, role and runner are kept. Nothing of a request or response
// body is read; the log list does not carry one.

import { plain } from "./report.ts";
import { writeMetric, METRICS_DATASET, type MetricRow } from "../metrics.ts";

// The secret is optional: a Worker without it keeps running with the
// gateway off, so it is declared here rather than required in wrangler.jsonc,
// where `wrangler deploy` would refuse to deploy until it is set.
declare global {
  interface Env { AI_GATEWAY_TOKEN?: string }
}

export const GATEWAY_WINDOW_DAYS = 7;
export const GATEWAY_WINDOW_MS = GATEWAY_WINDOW_DAYS * 86_400_000;
// A first pull, with nothing written yet, reads back this far.
export const FIRST_PULL_MS = GATEWAY_WINDOW_MS;
// The most durations one read of the window asks Analytics Engine for.
export const ROW_LIMIT = 10_000;
// Logs per page, the most the list route serves, and pages per pull: a pull
// every five minutes reads at most PAGE_SIZE × MAX_PAGES logs.
export const PAGE_SIZE = 50;
export const MAX_PAGES = 20;

export interface GatewayConfig { account: string; gateway: string; token: string }

export interface GatewayLog {
  id: string;
  at: string;                  // ISO time the gateway logged the call
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;         // dollars; null when the gateway priced none
  durationMs: number | null;
  success: boolean;
  task: string | null;         // from the cf-aig-metadata header, when sent
  role: string | null;
  runner: string | null;
}

// The newest log written, where a pull stops.
export interface GatewayMark { id: string; at: string }

// The last pull, as the index Ledger records it: when, how many logs it
// wrote, and what went wrong if it failed; and, from pulls since t294, how
// many logs the route answered, how many of those could not be read, and the
// field names (never the values) of the first that could not, so a pull that
// writes nothing says why.
export interface GatewayPull { at: string; added: number; error: string | null; answered?: number; unreadable?: number; unreadableFields?: string[] }

// What the last pull read, in words, for the page and the CLI: how many logs
// the route answered and how many could not be read, with the first such
// log's field names. Empty for a pull recorded before t294.
export function pullReadText(pull: GatewayPull | null): string {
  if (!pull || pull.answered === undefined) return "";
  const logs = (n: number) => `${n} log${n === 1 ? "" : "s"}`;
  const bad = pull.unreadable ? `; ${pull.unreadable} could not be read${pull.unreadableFields?.length ? ` (fields: ${pull.unreadableFields.join(", ")})` : ""}` : "";
  return `the logs route answered ${logs(pull.answered)}${bad}`;
}

// The field names of a log that could not be read, as plain names: at most
// 20, each cut to 40 characters, in the order the route gave them.
export function fieldNames(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [typeof raw];
  return Object.keys(raw).slice(0, 20).map((k) => plain(k, 40));
}

// Logs a pull did not read: it read MAX_PAGES pages, newest first, without
// reaching the mark, so of the logs between `from` (the mark's time, or the
// first pull's floor) and `to` (the oldest it read) at least `atLeast` were
// never written. The list route says only that a further page exists, so
// the count is a floor, not the number missed.
export interface GatewayGap { from: string; to: string; atLeast: number; pulledAt: string }

// One model's totals over the window, as the totals query sums them.
export interface GatewayTotals { provider: string; model: string; calls: number; failures: number; tokensIn: number; tokensOut: number; cost: number | null }

// One duration from the newest ROW_LIMIT of the window.
export interface GatewayDuration { provider: string; model: string; durationMs: number }

export interface GatewayModel {
  provider: string;
  model: string;
  calls: number;
  failures: number;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;         // null when no call in the window was priced
  medianMs: number | null;
  sample: number;              // the rows the median is taken over
}

export interface GatewayView {
  off: string | null;          // why the gateway is not shown, or null when it is
  days: number;
  since: string;
  models: GatewayModel[];
  pull: GatewayPull | null;
  gaps: GatewayGap[];          // stretches of the window no pull read
  sampled: boolean;            // the medians read ROW_LIMIT durations, not every one
}

// The configuration, or the sentence saying why the gateway is off.
export function gatewayConfig(env: { CF_ACCOUNT_ID?: string; AI_GATEWAY_ID?: string; AI_GATEWAY_TOKEN?: string }): GatewayConfig | string {
  const token = env.AI_GATEWAY_TOKEN?.trim();
  if (!token) return "AI Gateway costs are off: set AI_GATEWAY_TOKEN";
  const account = env.CF_ACCOUNT_ID?.trim();
  if (!account) return "AI Gateway costs are off: set CF_ACCOUNT_ID";
  return { account, gateway: env.AI_GATEWAY_ID?.trim() || "atelier", token };
}

export function logsUrl(cfg: GatewayConfig, page: number): string {
  const q = new URLSearchParams({ page: String(page), per_page: String(PAGE_SIZE), order_by: "created_at", order_by_direction: "desc" });
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account)}/ai-gateway/gateways/${encodeURIComponent(cfg.gateway)}/logs?${q}`;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? plain(v, max) : "");
const tag = (v: unknown) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? plain(String(v), 100) || null : null);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

// task, role and runner from the cf-aig-metadata the caller sent; the
// gateway returns it as a JSON string, or as an object.
export function parseMetadata(raw: unknown): { task: string | null; role: string | null; runner: string | null } {
  let m: unknown = raw;
  if (typeof raw === "string") {
    try { m = JSON.parse(raw); } catch { m = null; }
  }
  const o = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  return { task: tag(o.task), role: tag(o.role), runner: tag(o.runner) };
}

// A log id as the gateway gives it (a ULID): kept as it is, since key
// redaction would turn every such id into the same text.
const LOG_ID = /^[A-Za-z0-9_-]{1,64}$/;

// One log from the list, or null when it has no id or no time.
export function parseLog(raw: unknown): GatewayLog | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && LOG_ID.test(r.id) ? r.id : "";
  const t = typeof r.created_at === "string" ? Date.parse(r.created_at) : NaN;
  if (!id || Number.isNaN(t)) return null;
  return {
    id, at: new Date(t).toISOString(),
    provider: text(r.provider, 64) || "unknown",
    model: text(r.model, 128) || "unknown",
    tokensIn: count(r.tokens_in), tokensOut: count(r.tokens_out),
    cost: typeof r.cost === "number" && Number.isFinite(r.cost) && r.cost >= 0 ? r.cost : null,
    durationMs: typeof r.duration === "number" && Number.isFinite(r.duration) && r.duration >= 0 ? Math.round(r.duration) : null,
    success: r.success === true,
    ...parseMetadata(r.metadata),
  };
}

// The logs of one page of the list's answer, or an Error saying why the
// answer is not one.
export function parsePage(status: number, body: unknown): GatewayLog[] {
  const b = (body && typeof body === "object" ? body : {}) as { success?: unknown; errors?: unknown; result?: unknown };
  if (status < 200 || status >= 300 || b.success === false || !Array.isArray(b.result)) {
    const first = Array.isArray(b.errors) ? (b.errors[0] as { message?: unknown } | undefined) : undefined;
    throw new Error(`the AI Gateway logs route answered ${status}${typeof first?.message === "string" ? `: ${plain(first.message, 200)}` : ""}`);
  }
  return b.result.map(parseLog).filter((l): l is GatewayLog => l !== null);
}

// Every log newer than `last`, newest first: pages are read until one holds
// the last written id or a log older than it, a log older than
// FIRST_PULL_MS (a first pull), or a short page. After MAX_PAGES full pages
// the pull stops short of all of those, and `gap` names the stretch it did
// not read, from the mark (or the floor) to the oldest log it read.
export interface FetchedLogs {
  logs: GatewayLog[]; pages: number; gap: Omit<GatewayGap, "pulledAt"> | null;
  answered: number; unreadable: number; unreadableFields: string[] | null;
}

export async function fetchNewLogs(cfg: GatewayConfig, last: GatewayMark | null, now: number, fetcher: typeof fetch = fetch): Promise<FetchedLogs> {
  const floor = new Date(now - FIRST_PULL_MS).toISOString();
  const logs: GatewayLog[] = [];
  let answeredAll = 0, unreadable = 0, unreadableFields: string[] | null = null;
  const done = (pages: number, gap: FetchedLogs["gap"]): FetchedLogs => ({ logs, pages, gap, answered: answeredAll, unreadable, unreadableFields });
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetcher(logsUrl(cfg, page), { headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" } });
    const body = await res.json().catch(() => null);
    const found = parsePage(res.status, body);
    // A short page is judged by what the list answered, not by the logs that
    // parsed: a full page holding one log without an id is not the last.
    const raw = (body as { result: unknown[] }).result;
    const answered = raw.length;
    answeredAll += answered;
    unreadable += answered - found.length;
    if (!unreadableFields && answered > found.length) unreadableFields = fieldNames(raw.find((r) => parseLog(r) === null));
    for (const log of found) {
      if (last && (log.id === last.id || log.at < last.at)) return done(page, null);
      if (log.at < floor) return done(page, null);
      logs.push(log);
    }
    if (answered < PAGE_SIZE) return done(page, null);
  }
  return done(MAX_PAGES, { from: last?.at ?? floor, to: logs[logs.length - 1]?.at ?? new Date(now).toISOString(), atLeast: 1 });
}

// One log as an Analytics Engine data point of kind "gateway": blobs
// provider, model, task, role, runner, log id (blob2 to blob7); doubles
// tokens in, tokens out, cost in dollars, duration in ms, success 1 or 0
// (double1 to double5), an unpriced cost or unknown duration written as -1;
// indexed by model.
export function writeLog(dataset: AnalyticsEngineDataset | undefined, l: GatewayLog): boolean {
  return writeMetric(dataset, "gateway",
    [l.provider, l.model, l.task, l.role, l.runner, l.id],
    [l.tokensIn, l.tokensOut, l.cost ?? -1, l.durationMs ?? -1, l.success ? 1 : 0],
    l.model);
}

const inWindow = (days: number) => `FROM ${METRICS_DATASET} WHERE blob1 = 'gateway' AND timestamp > NOW() - INTERVAL '${Math.round(days)}' DAY`;

// Each model's totals over the last `days` days, summed by Analytics Engine.
// A sampled row stands for _sample_interval calls, so every count and sum
// is weighted by it; a cost of -1 (unpriced) adds nothing and is not
// counted as priced.
// Analytics Engine wants both branches of an IF() of one type, so each
// is a Double (0.0, or _sample_interval * 1.0).
export function totalsSql(days = GATEWAY_WINDOW_DAYS): string {
  return `SELECT blob2 AS provider, blob3 AS model, SUM(_sample_interval) AS calls, SUM(IF(double5 = 1, 0.0, _sample_interval * 1.0)) AS failures, SUM(_sample_interval * double1) AS tokens_in, SUM(_sample_interval * double2) AS tokens_out, SUM(IF(double3 >= 0, _sample_interval * double3, 0.0)) AS cost, SUM(IF(double3 >= 0, _sample_interval * 1.0, 0.0)) AS priced ${inWindow(days)} GROUP BY blob2, blob3`;
}

// The newest ROW_LIMIT durations of the last `days` days, for the medians.
export function durationsSql(days = GATEWAY_WINDOW_DAYS): string {
  return `SELECT blob2 AS provider, blob3 AS model, double4 AS duration_ms ${inWindow(days)} AND double4 >= 0 ORDER BY timestamp DESC LIMIT ${ROW_LIMIT}`;
}

// The SQL API may give a number as a string.
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const names = (r: MetricRow) => ({ provider: text(r.provider, 64) || "unknown", model: text(r.model, 128) || "unknown" });

export function parseTotals(rows: MetricRow[]): GatewayTotals[] {
  return rows.map((r) => {
    const cost = num(r.cost), priced = num(r.priced);
    return {
      ...names(r), calls: count(num(r.calls)), failures: count(num(r.failures)),
      tokensIn: count(num(r.tokens_in)), tokensOut: count(num(r.tokens_out)),
      cost: Number.isFinite(priced) && priced > 0 && Number.isFinite(cost) ? Math.round(cost * 1e6) / 1e6 : null,
    };
  });
}

export function parseDurations(rows: MetricRow[]): GatewayDuration[] {
  return rows.flatMap((r) => {
    const ms = num(r.duration_ms);
    return Number.isFinite(ms) && ms >= 0 ? [{ ...names(r), durationMs: Math.round(ms) }] : [];
  });
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Each provider's model: its totals as summed, and the median of its
// durations among those read, with their number as the sample size. Most
// cost first, then most calls.
export function summarize(totals: GatewayTotals[], durations: GatewayDuration[]): GatewayModel[] {
  const by = new Map<string, number[]>();
  for (const d of durations) {
    const key = `${d.provider}\n${d.model}`;
    by.set(key, [...(by.get(key) ?? []), d.durationMs]);
  }
  return totals.map((t) => {
    const ds = by.get(`${t.provider}\n${t.model}`) ?? [];
    return { ...t, medianMs: median(ds), sample: ds.length };
  }).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls || a.model.localeCompare(b.model));
}

export function gatewayView(off: string | null, totals: GatewayTotals[], durations: GatewayDuration[], pull: GatewayPull | null, gaps: GatewayGap[], now: number): GatewayView {
  const since = new Date(now - GATEWAY_WINDOW_MS).toISOString();
  return {
    off, days: GATEWAY_WINDOW_DAYS, since, models: off ? [] : summarize(totals, durations), pull,
    gaps: gaps.filter((g) => g.to >= since), sampled: durations.length >= ROW_LIMIT,
  };
}

// "850 ms", "12.4 s"
export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
