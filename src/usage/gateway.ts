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
// it, so a log is written once however many pulls see it. The Models page
// and GET /api/usage read the last GATEWAY_WINDOW_DAYS days back through the
// Analytics Engine SQL API (ANALYTICS_TOKEN) and show each model's calls,
// tokens, cost and median duration. With no AI_GATEWAY_TOKEN the trigger
// does nothing and the page says so.
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
// The most rows one read of the window asks Analytics Engine for.
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
// wrote, and what went wrong if it failed.
export interface GatewayPull { at: string; added: number; error: string | null }

// One call as the window's read gives it back: `weight` is how many calls
// the row stands for (Analytics Engine's _sample_interval, 1 unsampled).
export type GatewayCall = Pick<GatewayLog, "provider" | "model" | "tokensIn" | "tokensOut" | "cost" | "durationMs" | "success"> & { at?: string; weight: number };

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
}

// The configuration, or the sentence saying why the gateway is off.
export function gatewayConfig(env: { CF_ACCOUNT_ID?: string; AI_GATEWAY_ID?: string; AI_GATEWAY_TOKEN?: string }): GatewayConfig | string {
  const token = env.AI_GATEWAY_TOKEN?.trim();
  if (!token) return "AI Gateway costs are off: set AI_GATEWAY_TOKEN";
  const account = env.CF_ACCOUNT_ID?.trim();
  if (!account) return "AI Gateway costs are off: set CF_ACCOUNT_ID in wrangler.jsonc";
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
// FIRST_PULL_MS (a first pull), a short page, or MAX_PAGES pages.
export async function fetchNewLogs(cfg: GatewayConfig, last: GatewayMark | null, now: number, fetcher: typeof fetch = fetch): Promise<{ logs: GatewayLog[]; pages: number }> {
  const floor = new Date(now - FIRST_PULL_MS).toISOString();
  const logs: GatewayLog[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetcher(logsUrl(cfg, page), { headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" } });
    const body = await res.json().catch(() => null);
    const found = parsePage(res.status, body);
    for (const log of found) {
      if (last && (log.id === last.id || log.at < last.at)) return { logs, pages: page };
      if (log.at < floor) return { logs, pages: page };
      logs.push(log);
    }
    if (found.length < PAGE_SIZE) return { logs, pages: page };
  }
  return { logs, pages: MAX_PAGES };
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

// The calls of the last `days` days, newest first, at most ROW_LIMIT rows.
export function windowSql(days = GATEWAY_WINDOW_DAYS): string {
  return `SELECT timestamp, blob2 AS provider, blob3 AS model, double1 AS tokens_in, double2 AS tokens_out, double3 AS cost, double4 AS duration_ms, double5 AS success, _sample_interval AS weight FROM ${METRICS_DATASET} WHERE blob1 = 'gateway' AND timestamp > NOW() - INTERVAL '${Math.round(days)}' DAY ORDER BY timestamp DESC LIMIT ${ROW_LIMIT}`;
}

// The rows windowSql read, as calls. The SQL API gives the timestamp as
// "YYYY-MM-DD hh:mm:ss" in UTC and may give a number as a string; a
// negative cost or duration is one the log did not carry.
export function parseCalls(rows: MetricRow[]): GatewayCall[] {
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  return rows.map((r) => {
    const cost = num(r.cost), ms = num(r.duration_ms), weight = num(r.weight);
    const t = typeof r.timestamp === "string" ? Date.parse(`${r.timestamp.replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(r.timestamp) ? "" : "Z"}`) : NaN;
    return {
      ...(Number.isNaN(t) ? {} : { at: new Date(t).toISOString() }),
      provider: text(r.provider, 64) || "unknown", model: text(r.model, 128) || "unknown",
      tokensIn: count(num(r.tokens_in)), tokensOut: count(num(r.tokens_out)),
      cost: Number.isFinite(cost) && cost >= 0 ? cost : null,
      durationMs: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null,
      success: num(r.success) === 1,
      weight: Number.isFinite(weight) && weight >= 1 ? weight : 1,
    };
  });
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Each provider's model over the calls given: calls, failures, tokens and
// cost (each row counted `weight` times), and the median duration over the
// rows that report one, with that number as the sample size. A call with a
// time outside the window ending at `now` is left out. Most cost first,
// then most calls.
export function summarize(calls: GatewayCall[], now: number, windowMs = GATEWAY_WINDOW_MS): GatewayModel[] {
  const since = new Date(now - windowMs).toISOString(), until = new Date(now).toISOString();
  const by = new Map<string, { m: GatewayModel; durations: number[] }>();
  for (const c of calls) {
    if (c.at !== undefined && (c.at < since || c.at > until)) continue;
    const key = `${c.provider}\n${c.model}`;
    let g = by.get(key);
    if (!g) by.set(key, g = { m: { provider: c.provider, model: c.model, calls: 0, failures: 0, tokensIn: 0, tokensOut: 0, cost: null, medianMs: null, sample: 0 }, durations: [] });
    g.m.calls += c.weight;
    if (!c.success) g.m.failures += c.weight;
    g.m.tokensIn += c.tokensIn * c.weight;
    g.m.tokensOut += c.tokensOut * c.weight;
    if (c.cost !== null) g.m.cost = Math.round(((g.m.cost ?? 0) + c.cost * c.weight) * 1e6) / 1e6;
    if (c.durationMs !== null) g.durations.push(c.durationMs);
  }
  return [...by.values()].map(({ m, durations }) => ({ ...m, medianMs: median(durations), sample: durations.length }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls || a.model.localeCompare(b.model));
}

export function gatewayView(off: string | null, calls: GatewayCall[], pull: GatewayPull | null, now: number): GatewayView {
  return { off, days: GATEWAY_WINDOW_DAYS, since: new Date(now - GATEWAY_WINDOW_MS).toISOString(), models: off ? [] : summarize(calls, now), pull };
}

// "850 ms", "12.4 s"
export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
