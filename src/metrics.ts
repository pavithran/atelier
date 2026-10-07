// Atelier's metrics in Workers Analytics Engine: one dataset,
// atelier_metrics, bound as METRICS in wrangler.jsonc, written with
// writeMetric and read back with query through the Analytics Engine SQL
// API. Every data point names its kind in blob1, so each kind of metric
// (AI Gateway calls, src/usage/gateway.ts; model speed; reviewer precision)
// reads its own rows with `WHERE blob1 = 'KIND'`; the blobs and doubles
// after that are the kind's own, in the order its writer gives them.
//
// Reading needs the ANALYTICS_TOKEN secret, an API token with Account
// Analytics: Read on the account CF_ACCOUNT_ID names. Writing needs only
// the binding.

declare global {
  interface Env { ANALYTICS_TOKEN?: string }
}

export const METRICS_DATASET = "atelier_metrics";

// Analytics Engine's limits: 20 blobs (kind included) and 20 doubles per
// point, one index of at most 96 bytes.
const MAX_BLOBS = 19;
const MAX_DOUBLES = 20;
const INDEX_BYTES = 96;

function cutBytes(s: string, max: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return s;
  return new TextDecoder().decode(bytes.slice(0, max)).replace(/�$/, "");
}

// Writes one data point of `kind`: blob1 is the kind, blob2 onwards the
// blobs given, double1 onwards the doubles, and the index, when given,
// the key Analytics Engine samples by. False when there is no binding.
export function writeMetric(dataset: AnalyticsEngineDataset | undefined, kind: string, blobs: (string | null)[], doubles: number[], index?: string): boolean {
  if (!dataset) return false;
  if (blobs.length > MAX_BLOBS || doubles.length > MAX_DOUBLES) throw new Error(`a ${kind} metric has at most ${MAX_BLOBS} blobs and ${MAX_DOUBLES} doubles`);
  dataset.writeDataPoint({
    blobs: [kind, ...blobs],
    doubles: doubles.map((d) => (Number.isFinite(d) ? d : 0)),
    ...(index ? { indexes: [cutBytes(index, INDEX_BYTES)] } : {}),
  });
  return true;
}

export interface QueryConfig { account: string; token: string }

// What query needs, or the sentence saying why metrics cannot be read.
export function queryConfig(env: { CF_ACCOUNT_ID?: string; ANALYTICS_TOKEN?: string }): QueryConfig | string {
  const token = env.ANALYTICS_TOKEN?.trim();
  if (!token) return "set ANALYTICS_TOKEN";
  const account = env.CF_ACCOUNT_ID?.trim();
  if (!account) return "set CF_ACCOUNT_ID in wrangler.jsonc";
  return { account, token };
}

export type MetricRow = Record<string, unknown>;

// Runs one SQL statement against the Analytics Engine SQL API and returns
// its rows, as the API's JSON format gives them: { data: [row, …] }. A
// refused or malformed answer is an Error naming the status.
export async function query(cfg: QueryConfig, sql: string, fetcher: typeof fetch = fetch): Promise<MetricRow[]> {
  const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account)}/analytics_engine/sql`, {
    method: "POST", headers: { authorization: `Bearer ${cfg.token}` }, body: sql,
  });
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!res.ok || !body || !Array.isArray(body.data)) throw new Error(`the Analytics Engine SQL API answered ${res.status}`);
  return body.data.filter((r): r is MetricRow => !!r && typeof r === "object");
}

// A string as an SQL literal: single quotes doubled, control characters dropped.
export const sqlString = (s: string) => `'${s.replace(/[\u0000-\u001f\\]/g, "").replace(/'/g, "''")}'`;
