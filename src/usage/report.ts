// Usage, limits and balances: what a home runner reports about each tool on
// its machine, and the owner's thresholds for alerting on it.
//
// A report is numbers only: a tool's rate-limit windows (percent used, when
// each resets), the models it served with requests, tokens and cost over the
// last 5 hours, 24 hours and 7 days, and any pay-per-use balance. It never
// carries a key, a header, a prompt or a file name; a report that tries to
// is refused, and any string that looks like a key is removed before it is
// stored. Reports are kept on the index Ledger, one per tool and runner.

import { redactKeys } from "../models/pool.ts";
import { RuleError } from "../rules.ts";

export const SPANS = ["5h", "24h", "7d"] as const;
export type Span = (typeof SPANS)[number];
export const SPAN_LABELS: Record<Span, string> = { "5h": "Last 5 hours", "24h": "Last 24 hours", "7d": "Last 7 days" };

export interface UsageWindow {
  name: string;              // "5-hour", "weekly", or as the tool names it
  usedPercent: number;
  resetsAt: string | null;   // when the window resets, if the tool says
  at: string | null;         // when the tool recorded these figures
}

export interface SpanUse { requests: number; tokens: number; cost: number | null }   // cost in dollars; null when the tool records none

export interface ModelUse {
  model: string;
  provider: string | null;
  spans: Record<Span, SpanUse>;
}

export interface Balance { currency: string; amount: number }

export interface UsageReport {
  tool: string;
  runner: string;            // the runner that reported it, kind:name
  at: string;                // when the server received it
  windows: UsageWindow[];
  models: ModelUse[];
  balances: Balance[];
  notes: string[];           // what the runner could not read, in words
}

// The owner's thresholds. Null turns that alert off.
export interface Thresholds {
  weeklyPercent: number | null;   // a weekly window past this percent
  windowPercent: number | null;   // a 5-hour window past this percent
  dailySpend: number | null;      // a tool's pay-per-use spend over 24 hours above this many dollars
  balanceFloor: number | null;    // a balance below this amount, in its own currency
}

export const DEFAULT_THRESHOLDS: Thresholds = { weeklyPercent: 80, windowPercent: 90, dailySpend: 10, balanceFloor: 10 };

// The Worker settings that hold them, as OWNER_NAME and TIMEZONE are held.
export const THRESHOLD_SETTINGS: Record<keyof Thresholds, string> = {
  weeklyPercent: "USAGE_WEEKLY_PERCENT",
  windowPercent: "USAGE_WINDOW_PERCENT",
  dailySpend: "USAGE_DAILY_SPEND",
  balanceFloor: "USAGE_BALANCE_FLOOR",
};

// A report older than this is shown as stale: the runner has not reported
// for longer than any sensible schedule leaves between runs.
export const STALE_MS = 3 * 3_600_000;
export const isStale = (report: Pick<UsageReport, "at">, now: number) => now - Date.parse(report.at) > STALE_MS;

// Each setting is a number at or above zero, or "off" to turn that alert
// off. Anything else, including an unset setting, is the default.
export function thresholdsFrom(settings: Record<string, string | undefined>): Thresholds {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(THRESHOLD_SETTINGS) as (keyof Thresholds)[]) {
    const raw = settings[THRESHOLD_SETTINGS[key]]?.trim();
    if (!raw) continue;
    if (raw.toLowerCase() === "off") out[key] = null;
    else {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) out[key] = n;
    }
  }
  return out;
}

// ── validation ─────────────────────────────────────────────────────────────

const TOOL = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const CURRENCY = /^[A-Z]{3,8}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const plain = (s: string, max: number) => redactKeys(s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")).replace(/\s+/g, " ").trim().slice(0, max);
const bad = (detail: string) => new RuleError("bad_usage", detail, 400);
const list = (v: unknown, what: string, max: number): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad(`${what} must be a list`);
  if (v.length > max) throw bad(`${what} may hold at most ${max} entries`);
  return v;
};
const count = (v: unknown, what: string): number => {
  const n = v === undefined || v === null ? 0 : Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${what} must be a number at or above zero`);
  return Math.round(n);
};
const when = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const ms = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const SECRET_FIELDS = ["key", "apiKey", "token", "authorization", "header", "headers"];

// A tool or runner name is stored as sent, drawn on the usage page and put in
// an alert's title, which goes to ntfy.sh, so it must be a plain name: the
// tool matches TOOL (the runner matched parseRunner's pattern already), and
// neither looks like a key by the patterns redactKeys removes, in the case
// it was sent or the case it is stored in. A report with such a name is
// refused, and the refusal does not repeat the name.
const keyShaped = (name: string) => redactKeys(name) !== name || redactKeys(name.toLowerCase()) !== name.toLowerCase();

// A report from the route body, validated, or a RuleError saying what is
// wrong. `at` and `by` are the server's: when it arrived and which runner
// sent it, as a model status takes them.
export function cleanReport(tool: string, body: Record<string, unknown>, at: string, by: string): UsageReport {
  if (keyShaped(tool)) throw bad("the tool name looks like a key; a report names its tool plainly, such as codex");
  if (!TOOL.test(tool)) throw bad(`"${tool}" is not a tool name Atelier can record`);
  if (keyShaped(by)) throw bad("the runner name looks like a key; name the runner plainly in X-Atelier-Runner, such as home:studio");
  if (SECRET_FIELDS.some((f) => f in body)) throw bad("a usage report carries numbers, never a key or a header");
  const windows = list(body.windows, "windows", 10).map((w): UsageWindow => {
    const x = (w ?? {}) as Record<string, unknown>;
    const name = plain(str(x.name), 40);
    if (!name) throw bad("a window needs a name");
    const used = Number(x.usedPercent);
    if (!Number.isFinite(used) || used < 0) throw bad(`window ${name}: usedPercent must be a number at or above zero`);
    return { name, usedPercent: Math.min(Math.round(used * 10) / 10, 999), resetsAt: when(x.resetsAt), at: when(x.at) };
  });
  const models = list(body.models, "models", 200).map((m): ModelUse => {
    const x = (m ?? {}) as Record<string, unknown>;
    const model = plain(str(x.model), 128);
    if (!model) throw bad("a model needs a name");
    const given = (x.spans ?? {}) as Record<string, unknown>;
    const spans = Object.fromEntries(SPANS.map((span) => {
      const s = (given[span] ?? {}) as Record<string, unknown>;
      const cost = s.cost === undefined || s.cost === null ? null : Number(s.cost);
      if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw bad(`${model} ${span}: cost must be a number at or above zero, or null`);
      return [span, { requests: count(s.requests, `${model} ${span} requests`), tokens: count(s.tokens, `${model} ${span} tokens`), cost: cost === null ? null : Math.round(cost * 10_000) / 10_000 }];
    })) as Record<Span, SpanUse>;
    const provider = plain(str(x.provider), 64);
    return { model, provider: provider || null, spans };
  });
  const balances = list(body.balances, "balances", 10).map((b): Balance => {
    const x = (b ?? {}) as Record<string, unknown>;
    const currency = str(x.currency).toUpperCase();
    if (!CURRENCY.test(currency)) throw bad("a balance names its currency as a code such as USD");
    const amount = Number(x.amount);
    if (!Number.isFinite(amount)) throw bad(`balance ${currency}: amount must be a number`);
    return { currency, amount: Math.round(amount * 100) / 100 };
  });
  const notes = list(body.notes, "notes", 10).map((n) => plain(str(n), 300)).filter(Boolean);
  return { tool: tool.toLowerCase(), runner: by, at, windows, models, balances, notes };
}

// ── crossings ──────────────────────────────────────────────────────────────

// An alert that is in force for a report: a window, a day's spend or a
// balance past the owner's threshold. The key names the figure, so the
// Ledger can tell a crossing already alerted from a new one.
export interface Crossing { key: string; title: string; body: string }

// "$0", "<$0.01", "$0.40", "$12": whole dollars without cents.
export function money(n: number): string {
  const cents = Math.round(n * 100);
  if (cents === 0) return n === 0 ? "$0" : "<$0.01";
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

// A tool's spend over the day: the sum over its models, or null when the
// tool records no cost at all.
export function daySpend(r: Pick<UsageReport, "models">): number | null {
  const costs = r.models.map((m) => m.spans["24h"].cost).filter((c): c is number => c !== null);
  return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
}

export function crossings(r: UsageReport, t: Thresholds, now: number): Crossing[] {
  const out: Crossing[] = [];
  const where = `${r.tool} on ${r.runner}`;
  for (const w of r.windows) {
    const limit = w.name === "weekly" ? t.weeklyPercent : w.name === "5-hour" ? t.windowPercent : null;
    // A window that has already reset is not in use, whatever the last reading said.
    if (limit === null || w.usedPercent <= limit || (w.resetsAt !== null && Date.parse(w.resetsAt) <= now)) continue;
    out.push({
      key: `${r.tool}/${r.runner}/window:${w.name}`,
      title: `${r.tool}: ${w.name} window ${pct(w.usedPercent)} used`,
      body: `${where} has used ${pct(w.usedPercent)} of its ${w.name} window, past ${pct(limit)}${w.resetsAt ? `; it resets at ${w.resetsAt}` : ""}.`,
    });
  }
  const spent = daySpend(r);
  if (t.dailySpend !== null && spent !== null && spent > t.dailySpend) {
    out.push({
      key: `${r.tool}/${r.runner}/spend`,
      title: `${r.tool}: ${money(spent)} spent in 24 hours`,
      body: `${where} has spent ${money(spent)} in the last 24 hours, above ${money(t.dailySpend)}.`,
    });
  }
  for (const b of r.balances) {
    if (t.balanceFloor === null || b.amount >= t.balanceFloor) continue;
    out.push({
      key: `${r.tool}/${r.runner}/balance:${b.currency}`,
      title: `${r.tool}: balance ${b.amount} ${b.currency}`,
      body: `${where} reports a balance of ${b.amount} ${b.currency}, below ${t.balanceFloor}.`,
    });
  }
  return out;
}
