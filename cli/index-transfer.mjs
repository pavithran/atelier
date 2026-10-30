import { validTrendProjection } from "../src/models/snapshot.ts";
import { cleanCardModel } from "../src/models/cards.ts";
import { indexDump, canonical } from "../src/index-transfer.ts";

export const V1_LIMITATIONS = [
  "1.0 trends expose only the current 14-day projection, not stored snapshot rows, take cutoffs, cohorts or full earlier revisions. Visible points are carried as projections in model_snapshots; older days, other schemas and undiscoverable models cannot be recovered. Snapshot dates for a model with no measures are unavailable outside the original span.",
  "1.0 GET /api/runs returns only the newest 1000 reports; older reports have no public read route.",
  "1.0 GET /api/models exposes notes only for models still in the pool; orphan notes have no read route.",
  "1.0 has no card listing: cards are read for names found in the pool (including aliases), assignments, runs and registry; cards under other names cannot be discovered.",
  "1.0 does not expose note or run database ids; those rows receive transfer ids in source order. Their timestamps, actors and text are preserved.",
  "1.0 GET /api/model-roles omits actingDeclared on withdrawals; that field cannot be carried.",
];
// The 1.0 read routes return projections rather than SQL rows. Keep their
// answers beside the rows so the export states precisely what was available.
export async function collectIndex(get, registryNames = []) {
  const version = await get("/version");
  if (version.capabilities?.includes("index.transfer.v1")) {
    const d = await get("/index/export");
    return { ...d, commit: version.commit ?? null };
  }
  const pool = await get("/models"), roles = await get("/model-roles"), runs = await get("/runs");
  if (!Array.isArray(pool) || !Array.isArray(roles.assignments) || !Array.isArray(runs)) throw new Error("unexpected 1.0 index read shape");
  const tables = { models: [], model_notes: [], model_cards: [], model_assignments: [], runs: [], snapshot_takes: [], model_snapshots: [] };
  const names = new Set(registryNames), cards = new Map(), answers = { pool, roles, runs, cards: [], trends: [] };
  // 1.0 omits SQL ids. Assign transfer ids in the order the source stored
  // the exposed rows, preserving ordering and duplicate reports on import.
  const next = { model_notes: 0, runs: 0 };
  const transferId = (table) => ++next[table];
  for (const entry of pool) {
    const { notes, ...model } = entry;
    for (const id of [entry.id, ...(entry.aliases ?? [])]) { names.add(id); names.add(`${entry.harness}/${id}`); }
    tables.models.push({ id: entry.id, json: JSON.stringify(model) });
    for (const note of notes ?? []) {
      const { projectName, ...stored } = note;
      tables.model_notes.push({ id: transferId("model_notes"), model: entry.id, json: JSON.stringify(stored) });
    }
  }
  for (const view of roles.assignments) {
    const { status, supersededBy, withdrawal, ...record } = view;
    tables.model_assignments.push({ n: Number(record.id.slice(1)), id: record.id, json: JSON.stringify(record) });
    for (const choice of record.choices) names.add(choice.actor);
    if (withdrawal) {
      const { id, ...fields } = withdrawal;
      tables.model_assignments.push({ n: Number(id.slice(1)), id, json: JSON.stringify({ id, kind: "withdrawn", withdraws: record.id, scope: record.scope, role: record.role, ...fields }) });
    }
  }
  for (const report of runs.slice().reverse()) {
    if (report.actor) names.add(report.actor);
    if (report.model) names.add(report.model);
    tables.runs.push({ id: transferId("runs"), json: JSON.stringify(report) });
  }
  for (const name of names) {
    // Historical actors can be valid run names but invalid card names in 1.0.
    // Such names cannot hold a card; failures from actual reads still abort.
    try { cleanCardModel(name); } catch { continue; }
    const view = await get(`/models/${encodeURIComponent(name)}/cards`);
    answers.cards.push({ name, answer: view });
    for (const shown of [...view.cards, ...view.withdrawals]) {
      const { state, endedBy, endedAt, endReason, ...record } = shown;
      const { id, ...stored } = record;
      const row = { id: Number(id.slice(1)), model: record.model, json: JSON.stringify(stored) };
      if (cards.has(row.id) && canonical(cards.get(row.id)) !== canonical(row)) throw new Error(`card ${record.id} changed while exporting; stop writers and retry`);
      cards.set(row.id, row);
      names.add(record.model);
      if (record.named) names.add(record.named);
    }
  }
  const trends = new Map();
  for (const name of names) {
    try { cleanCardModel(name); } catch { continue; }
    const trend = await get(`/models/${encodeURIComponent(name)}/trend`);
    if (!validTrendProjection(trend)) throw new Error("unexpected 1.0 trend read shape");
    answers.trends.push({ name, answer: trend });
    if (trends.has(trend.model) && canonical(trends.get(trend.model)) !== canonical(trend)) throw new Error(`trend ${trend.model} changed while exporting; stop writers and retry`);
    trends.set(trend.model, trend);
  }
  for (const trend of [...trends.values()].sort((a, b) => a.model.localeCompare(b.model))) {
    if (!trend.snapshots && !trend.measures.length) continue;
    tables.model_snapshots.push({ day: trend.to, schema: 1, rev: 1, model: trend.model, role: "@trend",
      json: JSON.stringify({ model: trend.model, role: "@trend", figures: [], projection: trend }) });
  }
  tables.model_cards = [...cards.values()].sort((a, b) => a.id - b.id);
  tables.model_assignments.sort((a, b) => a.n - b.n);
  return { ...indexDump(tables, version.commit ?? null, V1_LIMITATIONS), answers };
}

export { safeIndex } from "../src/index-transfer.ts";
