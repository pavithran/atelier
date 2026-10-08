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
// The same query's second selection reads calls per task: it groups the
// dataset by the value of each call's "task" metadata entry, asked for as
// metadataValue(key: "task"), because the metadataValue dimension takes
// the entry's key as its argument and the API refuses the query whole
// without it (2026-10-08: 'argument "key" is required', and every gateway
// figure was missing). Runners tag every pay-per-use call with the
// cf-aig-metadata header (CF_AIG_METADATA in cli/runner.mjs) naming
// the task, the role and the runner, and a call carries at most one task
// entry, so the task row counts each call once whatever else its metadata
// names; a call with no metadata, or none naming a task, has no task value
// and counts under no task. The task is the item's id alone, so the same
// id under two projects is one task in these figures.

import { plain } from "./report.ts";

export const GATEWAY_WINDOW_DAYS = 7;
export const GATEWAY_WINDOW_MS = GATEWAY_WINDOW_DAYS * 86_400_000;
// The most groups one query asks for, per selection.
export const GROUP_LIMIT = 1000;
export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
// The metadata key runners send a call's task under.
export const TASK_METADATA_KEY = "task";

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

export interface GatewayTask {
  task: string;                // the cf-aig-metadata task entry's value
  calls: number;
  failures: number;
  tokensIn: number;            // uncached and cached
  tokensOut: number;
  cost: number | null;         // dollars; null when every call cost 0
}

export interface GatewayView {
  off: string | null;          // why there are no figures, or null when there are
  days: number;
  since: string;
  models: GatewayModel[];
  tasks: GatewayTask[];        // calls per task, from the metadata runners send
}

// The configuration, or the sentence saying why the figures are off.
export function gatewayConfig(env: { CF_ACCOUNT_ID?: string; AI_GATEWAY_ID?: string; ANALYTICS_TOKEN?: string }): GatewayConfig | string {
  const token = env.ANALYTICS_TOKEN?.trim();
  if (!token) return "AI Gateway figures are off: set ANALYTICS_TOKEN";
  const account = env.CF_ACCOUNT_ID?.trim();
  if (!account) return "AI Gateway figures are off: set CF_ACCOUNT_ID";
  return { account, gateway: env.AI_GATEWAY_ID?.trim() || "atelier", token };
}

// The query for the window from `since`. Account, gateway, metadata key
// and time are written as JSON strings, which are valid GraphQL string
// literals, so no setting can change the query's shape. Two selections of
// the same dataset: the models grouped by model and provider, the tasks by
// the value of the "task" metadata entry.
export function gatewayQuery(cfg: Pick<GatewayConfig, "account" | "gateway">, since: string): string {
  const s = (v: string) => JSON.stringify(v);
  const filter = `{ datetime_geq: ${s(since)}, gateway: ${s(cfg.gateway)} }`;
  const sum = "{ cost uncachedTokensIn uncachedTokensOut cachedTokensIn cachedTokensOut erroredRequests }";
  const group = (dimensions: string, extra = "") => `aiGatewayRequestsAdaptiveGroups(limit: ${GROUP_LIMIT}, filter: ${filter}) { count dimensions ${dimensions} sum ${sum}${extra} }`;
  return `{ viewer { accounts(filter: { accountTag: ${s(cfg.account)} }) { models: ${group("{ model provider }", " quantiles { durationMsP50 durationMsP90 }")} tasks: ${group(`{ task: metadataValue(key: ${s(TASK_METADATA_KEY)}) }`)} } } }`;
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

// One group of the task selection as a task's figures, or null when the
// group names no task: the selection groups calls by their task value (the
// task alias of metadataValue(key: "task")), and the group whose value is
// empty holds the calls that carry no task entry.
export function parseTaskGroup(raw: unknown): GatewayTask | null {
  const g = obj(raw), dims = obj(g.dimensions), sum = obj(g.sum);
  const task = typeof dims.task === "string" ? plain(dims.task, 64) : "";
  if (!task) return null;
  const cost = num(sum.cost);
  const calls = count(g.count);
  return {
    task,
    calls, failures: Math.min(count(sum.erroredRequests), calls),
    tokensIn: count(sum.uncachedTokensIn) + count(sum.cachedTokensIn),
    tokensOut: count(sum.uncachedTokensOut) + count(sum.cachedTokensOut),
    cost: Number.isFinite(cost) && cost > 0 ? Math.round(cost * 1e6) / 1e6 : null,
  };
}

// The groups of the API's answer, or an Error naming why it is not one: an
// HTTP refusal, a GraphQL error (its first message), or another shape.
export function parseAnswer(status: number, body: unknown): { models: GatewayModel[]; tasks: GatewayTask[] } {
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
  const account = obj(accounts[0]);
  if (!Array.isArray(account.models) || !Array.isArray(account.tasks)) throw new Error("the GraphQL Analytics API answered without data");
  return { models: summarize(account.models.map(parseGroup)), tasks: summarizeTasks(account.tasks.map(parseTaskGroup)) };
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

// Task groups merged by task value (values cut to the same text can meet),
// most calls first, then by task value. A null is a group that named no task.
export function summarizeTasks(tasks: (GatewayTask | null)[]): GatewayTask[] {
  const by = new Map<string, GatewayTask>();
  for (const t of tasks) {
    if (!t || t.calls <= 0) continue;
    const k = by.get(t.task);
    if (!k) { by.set(t.task, { ...t }); continue; }
    by.set(t.task, {
      ...k, calls: k.calls + t.calls, failures: k.failures + t.failures, tokensIn: k.tokensIn + t.tokensIn, tokensOut: k.tokensOut + t.tokensOut,
      cost: k.cost === null && t.cost === null ? null : (k.cost ?? 0) + (t.cost ?? 0),
    });
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls || a.task.localeCompare(b.task));
}

// The view of the window ending `now`: the figures, or why there are none.
export async function readGatewayFigures(env: Parameters<typeof gatewayConfig>[0], now = Date.now(), fetcher: typeof fetch = fetch): Promise<GatewayView> {
  const since = new Date(now - GATEWAY_WINDOW_MS).toISOString();
  const view = (off: string | null, models: GatewayModel[] = [], tasks: GatewayTask[] = []): GatewayView => ({ off, days: GATEWAY_WINDOW_DAYS, since, models, tasks });
  const cfg = gatewayConfig(env);
  if (typeof cfg === "string") return view(cfg);
  try {
    const res = await fetcher(GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: gatewayQuery(cfg, since) }),
    });
    const body = await res.json().catch(() => null);
    const parsed = parseAnswer(res.status, body);
    return view(null, parsed.models, parsed.tasks);
  } catch (err) {
    return view(`AI Gateway figures could not be read: ${plain(err instanceof Error ? err.message : String(err), 300)}`);
  }
}

// "850 ms", "12.4 s"
export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
