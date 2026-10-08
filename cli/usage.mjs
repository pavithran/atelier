// Usage reporting: how much of each tool's allowance this machine has used,
// what each tool served and what it cost, and pay-per-use balances.
//
// `atelier runner --usage` reads what each tool records on this machine and
// reports one summary per tool through POST /api/usage/TOOL under the
// runner's name, as `--discover` reports a model's status. It is a one-shot
// command, run from a LaunchAgent or by hand, not a step inside the runner
// loop: the loop polls the queue every 30 seconds and must stay cheap, while
// this reads session logs that can be gigabytes and asks DeepSeek for a
// balance; and the owner may want it on a machine that runs the tools but no
// runner loop at all. It is a port of atelier-ops' usage-report.
//
// Sources, each read only:
//   Codex     ~/.codex/sessions/**/*.jsonl, the newest "rate_limits" record,
//             read by discover.mjs from the tails of the newest files: the
//             5-hour and weekly windows, percent used and when each resets.
//   zcode     ~/.zcode/cli/db/db.sqlite, table model_usage: one row per
//             request, with model_id, provider_id, started_at and
//             computed_total_tokens. zcode records no cost.
//   opencode  ~/.local/share/opencode/opencode.db, table message: each
//             assistant message's modelID, providerID, tokens.total and cost.
//   DeepSeek  GET https://api.deepseek.com/user/balance, with the key the
//             runner config names under balances.deepseek, read from the
//             Keychain by credentials.mjs into one child process's
//             environment and nowhere else. The child prints numbers.
// Not read, because this machine holds no record of them: Claude's plan
// limits (the Claude app shows them) and Gemini's spend (Google serves no
// balance). The command says so each time it runs.
//
// What is reported is counts, windows, model names, costs and balances.
// No prompt, file name, session id, key or header ever leaves the machine:
// any key read is remembered and removed from every line printed, and every
// name a record supplies is cleaned before it is printed or reported
// (cleanBody).

import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";

import { readSecret } from "./credentials.mjs";
import { clean, defaultPaths, probeEnv, readCodexSessions, sqliteReader } from "./discover.mjs";
import { readConfig } from "./runner-config.mjs";
import { execute } from "./runner.mjs";

export const SPANS = ["5h", "24h", "7d"];
const SPAN_MS = { "5h": 5 * 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };
const SPAN_LABELS = { "5h": "last 5 hours", "24h": "last 24 hours", "7d": "last 7 days" };
// How far back the databases are read: the longest span, plus a minute of clock slack.
const LOOKBACK_MS = SPAN_MS["7d"] + 60_000;
// Rows read at most; a record longer than this is reported as cut.
export const ROW_LIMIT = 50_000;
const DEEPSEEK_KEY_ENV = "DEEPSEEK_API_KEY";
const USAGE = "usage: atelier runner --usage [--name home:NAME] [--dry-run] [--config PATH]";

const stamp = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const int = (n) => Math.trunc(Number(n));
const millions = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));

// ── spans ──────────────────────────────────────────────────────────────────

const emptySpans = (cost) => Object.fromEntries(SPANS.map((s) => [s, { requests: 0, tokens: 0, cost: cost ? 0 : null }]));

// Calls ({ model, provider, at, tokens, cost }) summed per model over each
// span ending now. A call up to a minute in the future counts as now, for
// a clock that runs ahead; anything later is not a call that happened.
export function spansOf(calls, now, { cost = false } = {}) {
  const models = new Map();
  for (const c of calls) {
    const age = now - c.at;
    if (!Number.isFinite(age) || age < -60_000 || age > SPAN_MS["7d"]) continue;
    const m = models.get(c.model) ?? { model: c.model, provider: c.provider ?? null, spans: emptySpans(cost) };
    for (const span of SPANS) {
      if (age > SPAN_MS[span]) continue;
      const s = m.spans[span];
      s.requests += 1;
      s.tokens += c.tokens;
      if (cost) s.cost += c.cost;
    }
    models.set(c.model, m);
  }
  return [...models.values()].sort((a, b) => b.spans["7d"].tokens - a.spans["7d"].tokens || a.model.localeCompare(b.model));
}

// ── zcode and opencode: SQLite ─────────────────────────────────────────────

export const zcodeUsageSql = (since) => `SELECT model_id, provider_id, started_at, computed_total_tokens FROM model_usage WHERE started_at >= ${int(since)} ORDER BY started_at DESC LIMIT ${ROW_LIMIT}`;
export const opencodeUsageSql = (since) => `SELECT time_created, data FROM message WHERE json_extract(data, '$.role') = 'assistant' AND time_created >= ${int(since)} ORDER BY time_created DESC LIMIT ${ROW_LIMIT}`;

// Rows of model_usage: every request counts, whatever its status, as the
// provider saw it; started_at is in milliseconds.
export function parseZcodeUsage(rows, now) {
  const calls = [];
  for (const row of rows ?? []) {
    const at = Number(row?.started_at);
    if (typeof row?.model_id !== "string" || !row.model_id || !Number.isFinite(at)) continue;
    calls.push({ model: row.model_id, provider: row.provider_id ?? null, at, tokens: Math.max(0, Number(row.computed_total_tokens) || 0), cost: 0 });
  }
  return spansOf(calls, now);
}

// Rows of message, `data` being the JSON text opencode stores: each
// assistant message is one request, with its tokens and its cost.
export function parseOpencodeUsage(rows, now) {
  const calls = [];
  for (const row of rows ?? []) {
    let data = row?.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { continue; } }
    if (!data || data.role !== "assistant" || typeof data.modelID !== "string" || !data.modelID) continue;
    const at = Number(data.time?.created ?? row.time_created);
    if (!Number.isFinite(at)) continue;
    calls.push({ model: data.modelID, provider: data.providerID ?? null, at, tokens: Math.max(0, Number(data.tokens?.total) || 0), cost: Math.max(0, Number(data.cost) || 0) });
  }
  return spansOf(calls, now, { cost: true });
}

// ── Codex: the windows discover.mjs reads ──────────────────────────────────

export function codexWindows(found) {
  if (!found?.limits) return [];
  return found.limits.windows.map((w) => ({ name: w.name, usedPercent: w.usedPercent, resetsAt: iso(w.resetsAt), at: iso(found.limits.at) }));
}

// ── DeepSeek: the balance, asked in a child ────────────────────────────────

// The child that asks DeepSeek prints only currencies and amounts.
export const DEEPSEEK_BALANCE_SCRIPT = `
const say = (value) => process.stdout.write(JSON.stringify(value));
try {
  const res = await fetch("https://api.deepseek.com/user/balance", {
    headers: { authorization: "Bearer " + (process.env.${DEEPSEEK_KEY_ENV} ?? "") }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) say({ ok: false, status: res.status });
  else {
    const body = await res.json();
    say({ ok: true, available: body.is_available !== false, balances: (body.balance_infos ?? []).map((b) => ({ currency: String(b.currency ?? ""), amount: Number(b.total_balance) })) });
  }
} catch { say({ ok: false, status: 0 }); }
`;

export function parseDeepseekBalance(text) {
  let value;
  try { value = JSON.parse(text); } catch { return { error: "the balance call gave no answer" }; }
  if (!value?.ok) {
    const status = Number(value?.status) || 0;
    if ([400, 401, 403].includes(status)) return { error: `the balance call was refused (HTTP ${status}); check the key` };
    return { error: status ? `the balance call failed (HTTP ${status})` : "DeepSeek could not be reached" };
  }
  const balances = (Array.isArray(value.balances) ? value.balances : [])
    .map((b) => ({ currency: String(b?.currency ?? "").toUpperCase(), amount: Number(b?.amount) }))
    .filter((b) => /^[A-Z]{3,8}$/.test(b.currency) && Number.isFinite(b.amount));
  if (!balances.length) return { error: "DeepSeek reported no balance" };
  return { balances, notes: value.available === false ? ["DeepSeek says the balance is not enough for calls"] : [] };
}

// ── what is gathered ───────────────────────────────────────────────────────

// Each tool with a record here, as a report body for POST /api/usage/TOOL,
// and a line for each tool that could not be read or is not read at all.
export async function gatherUsage(io, config, scrub) {
  const now = io.now();
  const reports = [];
  const skipped = [];
  let via = null;

  if (existsSync(io.paths.codex)) {
    const found = io.readCodex(io.paths.codex);
    if (found.error) skipped.push(`codex: ${found.error}`);
    else reports.push({ tool: "codex", body: { windows: codexWindows(found), models: [], balances: [], notes: found.limits ? [] : ["no rate limits in the newest session logs"] } });
  } else skipped.push(`codex: no session logs at ${io.paths.codex}`);

  for (const [tool, sql, parse] of [["zcode", zcodeUsageSql, parseZcodeUsage], ["opencode", opencodeUsageSql, parseOpencodeUsage]]) {
    if (!existsSync(io.paths[tool])) { skipped.push(`${tool}: no database at ${io.paths[tool]}`); continue; }
    try {
      const reader = await io.reader();
      via = reader.via;
      const rows = reader.query(io.paths[tool], sql(now - LOOKBACK_MS));
      const notes = rows.length >= ROW_LIMIT ? [`only the newest ${ROW_LIMIT} requests were read; older ones in the week are not counted`] : [];
      if (tool === "zcode") notes.push("zcode records no cost");
      reports.push({ tool, body: { windows: [], models: parse(rows, now), balances: [], notes } });
    } catch (error) { skipped.push(`${tool}: record not read: ${error.message}`); }
  }

  for (const [provider, entryName] of Object.entries(config?.balances ?? {})) {
    if (provider !== "deepseek") { skipped.push(`${provider}: no balance source; only DeepSeek's balance can be asked for`); continue; }
    let key;
    try { key = io.readSecret(entryName); } catch (error) { skipped.push(`deepseek: Keychain entry ${entryName} could not be read: ${error.message}`); continue; }
    if (!key) { skipped.push(`deepseek: Keychain entry ${entryName} holds no key`); continue; }
    scrub.add(key);
    try {
      const result = await io.run([process.execPath, "--input-type=module", "-e", DEEPSEEK_BALANCE_SCRIPT],
        { cwd: io.cwd, capture: true, captureError: true, timeoutMs: 30_000, signal: io.signal, env: probeEnv(io.env, { [DEEPSEEK_KEY_ENV]: key }) });
      const found = result.timedOut ? { error: "the balance call timed out" } : parseDeepseekBalance(result.output);
      if (found.error) skipped.push(`deepseek: ${found.error}`);
      else reports.push({ tool: "deepseek", body: { windows: [], models: [], balances: found.balances, notes: found.notes } });
    } catch (error) { skipped.push(`deepseek: ${error.message}`); }
  }
  if (!config?.balances?.deepseek) skipped.push("deepseek: no Keychain entry named under balances.deepseek in the runner config, so its balance is not asked for");
  return { reports, skipped, via };
}

// ── what leaves the machine ────────────────────────────────────────────────

// A report body with every string a tool's record supplied (window, model
// and provider names) and every note cleaned as the server cleans them
// (src/usage/report.ts: control characters and key-shaped text removed) and
// cut to its lengths, after `safe` has removed any key read here. The
// records are files any process of the owner's can write, so what is in
// them reaches neither the terminal nor Atelier as it was found. A window
// or model whose name is left empty is dropped; the server refuses one.
export function cleanBody(body, safe) {
  return {
    windows: body.windows.map((w) => ({ ...w, name: safe(w.name, 40) })).filter((w) => w.name),
    models: body.models.map((m) => ({ ...m, model: safe(m.model, 128), provider: m.provider == null ? null : safe(m.provider, 64) || null })).filter((m) => m.model),
    balances: body.balances,
    notes: body.notes.map((n) => safe(n, 300)).filter(Boolean),
  };
}

// ── plain text ─────────────────────────────────────────────────────────────

export function describeReport(tool, body, now) {
  const lines = [`${tool}:`];
  for (const w of body.windows) {
    const reset = w.resetsAt === null ? "" : Date.parse(w.resetsAt) <= now ? `, reset at ${stamp(Date.parse(w.resetsAt))}` : `, resets ${stamp(Date.parse(w.resetsAt))}`;
    lines.push(`  ${w.name} ${w.usedPercent}% used${reset}${w.at ? `; as of ${stamp(Date.parse(w.at))}` : ""}`);
  }
  for (const span of SPANS) {
    const used = body.models.filter((m) => m.spans[span].requests);
    if (!body.models.length) break;
    if (!used.length) { lines.push(`  ${SPAN_LABELS[span]}: none`); continue; }
    lines.push(`  ${SPAN_LABELS[span]}:`);
    for (const m of used) {
      const s = m.spans[span];
      lines.push(`    ${m.model}: ${s.requests} request${s.requests === 1 ? "" : "s"}, ${millions(s.tokens)} tokens${s.cost === null ? "" : `, $${s.cost.toFixed(2)}`}`);
    }
  }
  for (const b of body.balances) lines.push(`  balance ${b.amount} ${b.currency}`);
  for (const n of body.notes) lines.push(`  ${n}`);
  return lines;
}

// What the server read of the AI Gateway (GET /api/usage, field gateway;
// src/usage/gateway.ts): each model's calls, tokens, cost, and median and
// p90 duration over its window with the calls they are taken over, or why
// there are none. A server older than this CLI sends no p90 (and a pull
// record this CLI no longer prints), so only what is there is shown. Every
// name is cleaned with `safe` before it is printed.
export function describeGateway(view, safe) {
  if (!view || typeof view !== "object") return ["AI Gateway: the server reports no gateway figures; it runs routes older than this CLI."];
  if (view.off) return [`AI Gateway: ${safe(view.off, 300)}.`];
  const lines = [`AI Gateway, last ${view.days} days:`];
  if (!view.models?.length) lines.push("  no calls");
  const time = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
  const dollars = (n) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
  for (const m of view.models ?? []) {
    const p90 = typeof m.p90Ms === "number" ? `, p90 ${time(m.p90Ms)}` : "";
    const ms = typeof m.medianMs === "number" ? `median ${time(m.medianMs)}${p90} (n=${m.sample})` : "no durations";
    lines.push(`  ${safe(m.model, 128)} (${safe(m.provider, 64)}): ${m.calls} call${m.calls === 1 ? "" : "s"}${m.failures ? `, ${m.failures} failed` : ""}, ${millions(m.tokensIn)} in, ${millions(m.tokensOut)} out, ${typeof m.cost === "number" ? dollars(m.cost) : "not priced"}, ${ms}`);
  }
  return lines;
}

// How fast each model worked, as the server computed it from the ledger
// (GET /api/reliability, field speed; src/models/speed.ts): per model the
// median build (claim to submission), review (claim to verdict) and task
// (first claim to merge) with the n each is taken over, and the stalled
// share of its build and review runs, over the stated window. Below the
// server's minimum n only n is printed. A server older than this CLI sends
// no speed field, and the lines say so. Every name is cleaned with `safe`.
export function describeSpeed(view, safe) {
  if (!view || typeof view !== "object" || !Array.isArray(view.models)) return ["Speed: the server reports no speed figures; it runs routes older than this CLI."];
  const day = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "?");
  const lines = [`Speed by model, last ${view.days} days (${day(view.since)} to ${day(view.until)}):`];
  if (!view.models.length) lines.push("  no runs ended in the window");
  const time = (s) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
  const measure = (m) => (!m?.n ? "none" : typeof m.median === "number" ? `median ${time(m.median)} (n=${m.n})` : `n=${m.n}, too few for a median`);
  const stalls = (r) => (!r?.runs ? "no runs" : `${r.stalled} of ${r.runs} stalled (${Math.round((r.stalled / r.runs) * 100)}%)`);
  for (const m of view.models) {
    lines.push(`  ${safe(m.model, 128)}: build ${measure(m.build)}, ${stalls(m.build)}; review ${measure(m.review)}, ${stalls(m.review)}; task to merge ${measure(m.task)}`);
  }
  return lines;
}

// ── the command ────────────────────────────────────────────────────────────

export function usageOptions(args, host = hostname()) {
  if (args._.length !== 1 || Object.keys(args.multi).some((k) => !["usage", "name", "dry-run", "config"].includes(k) || args.multi[k].length !== 1)) throw new Error(USAGE);
  for (const flag of ["usage", "dry-run"]) if (args[flag] !== undefined && args[flag] !== true) throw new Error(USAGE);
  if (args.config !== undefined && typeof args.config !== "string") throw new Error(USAGE);
  let name = args.name;
  if (name === undefined) name = `home:${host.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "runner"}`;
  if (typeof name !== "string" || !/^home:[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error("use --name home:NAME");
  return { name: name.toLowerCase(), dryRun: args["dry-run"] === true, configPath: args.config };
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

// io: report(tool, body, runner) comes from the CLI and answers with what the
// server returned ({ alerts }), gateway(), when given, answers with the
// server's AI Gateway view, and speed(), when given, with its speed record
// (describeSpeed); everything else has a default, so a test
// supplies only what it replaces.
export async function runUsage(args, given = {}) {
  const opts = usageOptions(args);
  const io = { ...defaultIo(), ...given };
  const secrets = new Set();
  const scrub = { add: (value) => { if (value) secrets.add(value); } };
  const withoutKeys = (text) => [...secrets].reduce((s, secret) => s.split(secret).join("[key removed]"), String(text ?? ""));
  const safe = (text, max) => clean(withoutKeys(text), max);

  let config = null, configNote = "";
  try { config = io.readConfig(opts.configPath); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    configNote = "No runner config was found, so no balance is asked for.";
  }

  const { reports: gathered, skipped, via } = await gatherUsage(io, config, scrub);
  // Cleaned once, so what is printed and what is reported are the same values.
  // The skipped lines too: what a tool or an error returned reaches neither the
  // terminal nor Atelier as it was found, which withoutKeys alone would not do.
  const reports = gathered.map((r) => ({ tool: r.tool, body: cleanBody(r.body, safe) }));
  const now = io.now();
  const out = [`Usage on ${opts.name}, as of ${stamp(now)}.`];
  if (configNote) out.push(configNote);
  if (via) out.push(`Local databases are read only, through ${via}.`);
  for (const r of reports) out.push("", ...describeReport(r.tool, r.body, now));
  if (skipped.length) out.push("", "Not reported:", ...skipped.map((s) => `  ${safe(s, 300)}`));
  // The gateway's figures are the server's, read once whatever this
  // machine records; a failed read is said and does not stop the report.
  if (io.gateway) {
    try { out.push("", ...describeGateway(await io.gateway(), safe)); }
    catch (error) { out.push("", `AI Gateway: could not read: ${safe(error.message, 200)}`); }
  }
  // The models' speed is the server's too, from the ledger; a failed read is
  // said and does not stop the report.
  if (io.speed) {
    try { out.push("", ...describeSpeed(await io.speed(), safe)); }
    catch (error) { out.push("", `Speed: could not read: ${safe(error.message, 200)}`); }
  }
  out.push("", "Not read here: Claude's plan limits (the Claude app shows them) and Gemini's spend (Google serves no balance).");

  const failed = [], alerts = [];
  let reported = 0;
  if (!opts.dryRun) {
    for (const r of reports) {
      if (io.signal?.aborted) throw new Error("interrupted");
      try {
        const answer = await io.report(r.tool, r.body, opts.name);
        reported++;
        for (const a of answer?.alerts ?? []) alerts.push(safe(a, 200));
      } catch (error) { failed.push(`${r.tool}: ${safe(error.message)}`); }
    }
  }
  out.push("", opts.dryRun ? "Dry run: nothing was reported to Atelier." : `Reported ${reported} usage summar${reported === 1 ? "y" : "ies"} to Atelier.`);
  if (alerts.length) out.push(`Alerts: ${alerts.join("; ")}.`);
  io.print(withoutKeys(out.join("\n")));
  if (failed.length) throw new Error(`could not report ${failed.length} usage summar${failed.length === 1 ? "y" : "ies"}: ${failed.join("; ")}`);
  return reports;
}
