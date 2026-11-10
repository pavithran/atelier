// Z.ai's plan allowance: the quota call answers with one limit per window.
// A token or credit limit (the reply has labelled its windows both ways) counted
// in hours (unit 3) is the 5-hour window and one counted
// in weeks (unit 6) is the weekly window; the time limit beside them is not an
// allowance window and is left out. The key goes in one header and is never
// returned, printed or put in a note.

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const UNITS = { 3: "5-hour", 6: "weekly" };
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// ctx: { env, zaiFetch, now }. Returns { windows, notes }.
export async function readZai(ctx) {
  const key = ctx.env?.ZAI_API_KEY;
  if (!key) return { windows: [], notes: ["zai: no key was given, so its usage is unknown"] };
  let res;
  try {
    res = await ctx.zaiFetch(QUOTA_URL, { headers: { authorization: key, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { windows: [], notes: ["zai: the quota call could not reach Z.ai"] };
  }
  let body = null;
  try { body = await res.json(); } catch { /* a reply that is not JSON has no limits */ }
  if (!res.ok) return { windows: [], notes: [`zai: the quota call failed (HTTP ${res.status})`] };
  if (body?.success !== true || !Array.isArray(body.data?.limits)) return { windows: [], notes: ["zai: the quota call was not a success, so usage is unknown"] };
  const at = iso(ctx.now);
  const windows = [];
  for (const limit of body.data.limits) {
    const name = limit?.type === "TOKENS_LIMIT" || limit?.type === "CREDIT_LIMIT" ? UNITS[limit.unit] : undefined;
    const used = Number(limit?.percentage);
    if (!name || !Number.isFinite(used) || used < 0 || windows.some((w) => w.name === name)) continue;
    windows.push({ name, usedPercent: used, resetsAt: iso(Number(limit.nextResetTime)), at });
  }
  return { windows, notes: windows.length ? [] : ["zai: the answer holds no 5-hour or weekly limit, so usage is unknown"] };
}
