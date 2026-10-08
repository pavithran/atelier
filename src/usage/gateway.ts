// Cloudflare AI Gateway figures: what the calls through the account's AI
// Gateway cost and how long they took, per model, read from Cloudflare's
// GraphQL Analytics API rather than from a tool's record on a runner's
// machine.
//
// One query, sent when the Models page or GET /api/usage is asked for:
//   POST https://api.cloudflare.com/client/v4/graphql
// with the ANALYTICS_TOKEN secret (an API token with Account Analytics:
// Read on the account CF_ACCOUNT_ID names) as a Bearer token. It reads the
// dataset aiGatewayRequestsAdaptiveGroups for the gateway AI_GATEWAY_ID
// (default "atelier") over the last GATEWAY_WINDOW_DAYS days, grouped by
// model and provider: the number of calls, the failed ones, tokens in and
// out (uncached and cached), cost in dollars, and the median and 90th
// percentile duration. The API answers a refusal with HTTP 200 and
// {"data":null,"errors":[{"message":…}]}, so `errors` is checked as well
// as the status.
//
// Calls per task are not read. The dataset has metadataKey and
// metadataValue dimensions, but how a call carrying several cf-aig-metadata
// entries (task, role, runner) is grouped by them has not been checked
// against the live API, and no runner sends a task tag yet (t271), so a
// per-task figure could not be shown to be right.

import { plain } from "./report.ts";

export const GATEWAY_WINDOW_DAYS = 7;
export const GATEWAY_WINDOW_MS = GATEWAY_WINDOW_DAYS * 86_400_000;
// The most model groups one query asks for.
export const GROUP_LIMIT = 1000;
export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

export interface GatewayConfig { account: string; gateway: string; token: string }

export interface GatewayModel {
  provider: string;
  model: string;
  calls: number;
  failures: number;
  tokensIn: number;            // uncached and cached
  tokensOut: number;
  cost: number | null;         // dollars; null when every call cost 0
  medianMs: number | null;
  p90Ms: number | null;
  sample: number;              // the calls the median and p90 are taken over
}

export interface GatewayView {
  off: string | null;          // why there are no figures, or null when there are
  days: number;
  since: string;
  models: GatewayModel[];
}

// The configuration, or the sentence saying why the figures are off.
export function gatewayConfig(env: { CF_ACCOUNT_ID?: string; AI_GATEWAY_ID?: string; ANALYTICS_TOKEN?: string }): GatewayConfig | string {
  const token = env.ANALYTICS_TOKEN?.trim();
  if (!token) return "AI Gateway figures are off: set ANALYTICS_TOKEN";
  const account = env.CF_ACCOUNT_ID?.trim();
  if (!account) return "AI Gateway figures are off: set CF_ACCOUNT_ID";
  return { account, gateway: env.AI_GATEWAY_ID?.trim() || "atelier", token };
}

// The query for the window from `since`. Account, gateway and time are
// written as JSON strings, which are valid GraphQL string literals, so no
// setting can change the query's shape.
export function gatewayQuery(cfg: Pick<GatewayConfig, "account" | "gateway">, since: string): string {
  const s = (v: string) => JSON.stringify(v);
  return `{ viewer { accounts(filter: { accountTag: ${s(cfg.account)} }) { aiGatewayRequestsAdaptiveGroups(limit: ${GROUP_LIMIT}, filter: { datetime_geq: ${s(since)}, gateway: ${s(cfg.gateway)} }) { count dimensions { model provider } sum { cost uncachedTokensIn uncachedTokensOut cachedTokensIn cachedTokensOut erroredRequests } quantiles { durationMsP50 durationMsP90 } } } } }`;
}

// The API may give a number as a string.
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const count = (v: unknown) => { const n = num(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0; };
const ms = (v: unknown) => { const n = num(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };
const name = (v: unknown, max: number) => (typeof v === "string" ? plain(v, max) : "") || "unknown";
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// One group of the answer as a model's figures. The gateway records a call
// it could not price as costing 0, so a model whose calls sum to 0 cannot
// be told from a free one; its cost is null, shown as "not priced".
export function parseGroup(raw: unknown): GatewayModel {
  const g = obj(raw), dims = obj(g.dimensions), sum = obj(g.sum), q = obj(g.quantiles);
  const cost = num(sum.cost);
  const calls = count(g.count);
  return {
    provider: name(dims.provider, 64), model: name(dims.model, 96),
    calls, failures: Math.min(count(sum.erroredRequests), calls),
    tokensIn: count(sum.uncachedTokensIn) + count(sum.cachedTokensIn),
    tokensOut: count(sum.uncachedTokensOut) + count(sum.cachedTokensOut),
    cost: Number.isFinite(cost) && cost > 0 ? Math.round(cost * 1e6) / 1e6 : null,
    medianMs: calls ? ms(q.durationMsP50) : null, p90Ms: calls ? ms(q.durationMsP90) : null,
    sample: calls,
  };
}

// The groups of the API's answer, or an Error naming why it is not one: an
// HTTP refusal, a GraphQL error (its first message), or another shape.
export function parseAnswer(status: number, body: unknown): GatewayModel[] {
  const b = obj(body);
  const errors = Array.isArray(b.errors) ? b.errors : [];
  if (errors.length) {
    const message = obj(errors[0]).message;
    throw new Error(`the GraphQL Analytics API refused the query${typeof message === "string" && message.trim() ? `: ${plain(message, 200)}` : ""}`);
  }
  if (status < 200 || status >= 300) throw new Error(`the GraphQL Analytics API answered ${status}`);
  const accounts = obj(obj(b.data).viewer).accounts;
  if (!Array.isArray(accounts)) throw new Error("the GraphQL Analytics API answered without data");
  if (!accounts.length) throw new Error("the GraphQL Analytics API answered no account; check CF_ACCOUNT_ID and that the token reaches it");
  const groups = obj(accounts[0]).aiGatewayRequestsAdaptiveGroups;
  if (!Array.isArray(groups)) throw new Error("the GraphQL Analytics API answered without data");
  return summarize(groups.map(parseGroup));
}

// Groups of one provider's model merged (names cut to the same text can
// meet), most cost first, then most calls. A merged group keeps the
// percentiles of its larger part.
export function summarize(models: GatewayModel[]): GatewayModel[] {
  const by = new Map<string, GatewayModel>();
  for (const m of models.filter((x) => x.calls > 0)) {
    const key = `${m.provider}\n${m.model}`;
    const k = by.get(key);
    if (!k) { by.set(key, { ...m }); continue; }
    const big = k.sample >= m.sample ? k : m;
    by.set(key, {
      ...k, calls: k.calls + m.calls, failures: k.failures + m.failures, tokensIn: k.tokensIn + m.tokensIn, tokensOut: k.tokensOut + m.tokensOut,
      cost: k.cost === null && m.cost === null ? null : (k.cost ?? 0) + (m.cost ?? 0),
      medianMs: big.medianMs, p90Ms: big.p90Ms, sample: big.sample,
    });
  }
  return [...by.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls || a.model.localeCompare(b.model));
}

// The view of the window ending `now`: the figures, or why there are none.
export async function readGatewayFigures(env: Parameters<typeof gatewayConfig>[0], now = Date.now(), fetcher: typeof fetch = fetch): Promise<GatewayView> {
  const since = new Date(now - GATEWAY_WINDOW_MS).toISOString();
  const view = (off: string | null, models: GatewayModel[] = []): GatewayView => ({ off, days: GATEWAY_WINDOW_DAYS, since, models });
  const cfg = gatewayConfig(env);
  if (typeof cfg === "string") return view(cfg);
  try {
    const res = await fetcher(GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: gatewayQuery(cfg, since) }),
    });
    const body = await res.json().catch(() => null);
    return view(null, parseAnswer(res.status, body));
  } catch (err) {
    return view(`AI Gateway figures could not be read: ${plain(err instanceof Error ? err.message : String(err), 300)}`);
  }
}

// "850 ms", "12.4 s"
export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
