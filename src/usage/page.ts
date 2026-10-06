// The Usage page: where each tool stands, from the reports home runners
// send (src/usage/report.ts). One table per tool: its rate-limit windows,
// the models it served over the last 5 hours, 24 hours and 7 days, and its
// balances, each row saying which runner reported it and when. A figure
// past the owner's threshold is tagged, and a report older than STALE_MS is
// marked stale. Everything a runner sent is escaped before it is shown.
// Below the tools, each model's reliability across every project, as the
// Models page shows it.

import { escapeText, page, reliabilitySection } from "../ui.ts";
import type { Reliability } from "../models/reliability.ts";
import { stamp } from "../time.ts";
import { crossings, daySpend, isStale, money, SPANS, SPAN_LABELS, STALE_MS, THRESHOLD_SETTINGS, type SpanUse, type Thresholds, type UsageReport } from "./report.ts";

const e = escapeText;
const tag = (label: string, tone = "") => `<span class="tag ${tone}">${e(label)}</span>`;
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

// "1.2M", "340k", "12": tokens at a glance.
export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en");
}

function useCell(s: SpanUse, extra = ""): string {
  const text = !s.requests && !s.tokens && !s.cost
    ? '<span class="meta">none</span>'
    : `${e(plural(s.requests, "request"))} · ${e(tokens(s.tokens))} tokens${s.cost === null ? "" : ` · ${e(money(s.cost))}`}`;
  return `<td class="num">${text}${extra}</td>`;
}

function reportedCell(r: UsageReport, now: number): string {
  return `<td class="reported"><span class="meta">${e(r.runner)} · ${e(stamp(r.at))}</span>${isStale(r, now) ? tag("stale", "ask") : ""}</td>`;
}

// The rows one runner's report contributes to its tool's table.
function reportRows(r: UsageReport, t: Thresholds, now: number): string {
  const over = new Set(crossings(r, t, now).map((c) => c.key));
  const reported = reportedCell(r, now);
  const rows: string[] = [];
  for (const w of r.windows) {
    const limit = w.name === "weekly" ? t.weeklyPercent : w.name === "5-hour" ? t.windowPercent : null;
    const past = over.has(`${r.tool}/${r.runner}/window:${w.name}`) && limit !== null ? tag(`past ${pct(limit)}`, "bad") : "";
    const reset = w.resetsAt === null ? "" : Date.parse(w.resetsAt) <= now ? ` · reset at ${e(stamp(w.resetsAt))}` : ` · resets ${e(stamp(w.resetsAt))}`;
    const seen = w.at ? `<span class="meta">as the tool recorded it ${e(stamp(w.at))}</span>` : "";
    rows.push(`<tr><th scope="row">${e(w.name)} window</th><td colspan="3" class="num">${e(pct(w.usedPercent))} used${reset}${past}${seen}</td>${reported}</tr>`);
  }
  for (const m of r.models) {
    const who = `<code>${e(m.model)}</code>${m.provider ? `<span class="meta">${e(m.provider)}</span>` : ""}`;
    rows.push(`<tr><th scope="row">${who}</th>${SPANS.map((s) => useCell(m.spans[s])).join("")}${reported}</tr>`);
  }
  // A tool's models together, with the day's spend the alert measures.
  if (r.models.length > 1) {
    const total = (span: (typeof SPANS)[number]): SpanUse => r.models.reduce((acc, m) => ({
      requests: acc.requests + m.spans[span].requests, tokens: acc.tokens + m.spans[span].tokens,
      cost: m.spans[span].cost === null ? acc.cost : (acc.cost ?? 0) + m.spans[span].cost,
    }), { requests: 0, tokens: 0, cost: null as number | null });
    const spent = over.has(`${r.tool}/${r.runner}/spend`) && t.dailySpend !== null ? tag(`above ${money(t.dailySpend)}`, "bad") : "";
    rows.push(`<tr class="total"><th scope="row">All models</th>${SPANS.map((s) => useCell(total(s), s === "24h" ? spent : "")).join("")}${reported}</tr>`);
  } else if (r.models.length === 1 && over.has(`${r.tool}/${r.runner}/spend`) && t.dailySpend !== null) {
    rows.push(`<tr class="total"><th scope="row">Spend in 24 hours</th><td colspan="3" class="num">${e(money(daySpend(r) ?? 0))}${tag(`above ${money(t.dailySpend)}`, "bad")}</td>${reported}</tr>`);
  }
  for (const b of r.balances) {
    const low = over.has(`${r.tool}/${r.runner}/balance:${b.currency}`) && t.balanceFloor !== null ? tag(`below ${t.balanceFloor}`, "bad") : "";
    rows.push(`<tr><th scope="row">Balance</th><td colspan="3" class="num">${e(`${b.amount.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${b.currency}`)}${low}</td>${reported}</tr>`);
  }
  if (!rows.length) rows.push(`<tr><th scope="row">Nothing read</th><td colspan="3" class="meta">The runner found no figures for this tool.</td>${reported}</tr>`);
  return rows.join("");
}

function toolSection(tool: string, reports: UsageReport[], t: Thresholds, now: number): string {
  const notes = reports.flatMap((r) => r.notes.map((n) => `<li><span class="meta">${e(r.runner)}:</span> ${e(n)}</li>`));
  return `<section class="tool" id="${e(tool)}" aria-label="${e(tool)}">
  <h2 class="section-title">${e(tool)}</h2>
  <table class="usage-table">
    <thead><tr><th scope="col">Figure</th>${SPANS.map((s) => `<th scope="col">${e(SPAN_LABELS[s])}</th>`).join("")}<th scope="col">Reported by</th></tr></thead>
    <tbody>${reports.map((r) => reportRows(r, t, now)).join("")}</tbody>
  </table>
  ${notes.length ? `<ul class="usage-notes meta">${notes.join("")}</ul>` : ""}
</section>`;
}

// What the thresholds are, in one sentence, naming the settings that hold them.
function thresholdLine(t: Thresholds): string {
  const part = (v: number | null, on: string) => (v === null ? "" : on);
  const parts = [
    part(t.weeklyPercent, `a weekly window passes ${pct(t.weeklyPercent ?? 0)}`),
    part(t.windowPercent, `a 5-hour window passes ${pct(t.windowPercent ?? 0)}`),
    part(t.dailySpend, `a tool's spend over 24 hours goes above ${money(t.dailySpend ?? 0)}`),
    part(t.balanceFloor, `a balance falls below ${t.balanceFloor}`),
  ].filter(Boolean);
  const settings = Object.values(THRESHOLD_SETTINGS).map((s) => `<code>${e(s)}</code>`).join(", ");
  return parts.length
    ? `An alert goes to the notification topic once per crossing when ${parts.join(", or ")}. The thresholds are the settings ${settings}; a setting of <code>off</code> turns that alert off.`
    : `Every alert is turned off in the settings ${settings}.`;
}

// A key such as codex/home:studio/window:weekly, in words.
export function describeAlert(key: string): string {
  const [tool, runner, figure = ""] = key.split("/");
  const [kind, name] = figure.split(":");
  const what = kind === "window" ? `${name} window past its threshold` : kind === "spend" ? "spend over 24 hours above its threshold" : kind === "balance" ? `${name} balance below its threshold` : figure;
  return `${tool} on ${runner}: ${what}`;
}

export function renderUsage(reports: UsageReport[], t: Thresholds, alerts: { key: string; since: string }[], now = new Date(), ownerName: string | null = null,
  reliability: { models: Reliability; events: number; unread: string[] } | null = null): string {
  const at = now.getTime();
  const tools = new Map<string, UsageReport[]>();
  for (const r of reports) tools.set(r.tool, [...(tools.get(r.tool) ?? []), r]);
  const body = tools.size
    ? [...tools.entries()].map(([tool, list]) => toolSection(tool, list, t, at)).join("")
    : `<div class="empty"><h3>No usage reported yet.</h3><p>On a machine that runs the tools, run <code>atelier runner --usage</code>; schedule it hourly to keep this page current.</p></div>`;
  const inForce = alerts.length
    ? `<div class="notice" role="status"><h3>${e(plural(alerts.length, "alert"))} in force</h3><ul>${alerts.map((a) => `<li>${e(describeAlert(a.key))}, since ${e(stamp(a.since))}</li>`).join("")}</ul></div>`
    : "";
  const stale = reports.filter((r) => isStale(r, at)).length;
  return page("Usage", `<div class="page-width usage">
  <header><h1>Usage</h1>
  <p class="lead">Where each tool stands: its rate-limit windows, the models it served and what they cost, and pay-per-use balances, as the home runners last reported them.</p>
  <p class="meta">${thresholdLine(t)} A report older than ${STALE_MS / 3_600_000} hours is marked stale${stale ? `; ${plural(stale, "report is", "reports are")} stale now` : ""}. Claude's plan limits and Gemini's spend have no record on the runner's machine, so they are not reported.</p></header>
  ${inForce}
  ${body}
  ${reliability ? reliabilitySection(reliability.models, ownerName, reliability) : ""}
</div>`, "Usage", ownerName);
}
