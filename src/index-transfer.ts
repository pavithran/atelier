import { validTrendProjection } from "./models/snapshot.ts";
import { RuleError } from "./rules.ts";

export const INDEX_FORMAT = "atelier-server-index";
export const INDEX_TABLES = {
  models: ["id", "json"], model_notes: ["id", "model", "json"],
  model_cards: ["id", "model", "json"], model_assignments: ["n", "id", "json"], runs: ["id", "json"],
  snapshot_takes: ["day", "schema", "rev", "json"],
  model_snapshots: ["day", "schema", "rev", "model", "role", "json"],
} as const;
export const INDEX_KEYS = {
  models: ["id"], model_notes: ["id"], model_cards: ["id"], model_assignments: ["n"], runs: ["id"],
  snapshot_takes: ["day", "schema", "rev"], model_snapshots: ["day", "schema", "model", "role", "rev"],
} as const;
export type IndexTable = keyof typeof INDEX_TABLES;
export type IndexRow = Record<string, string | number | null>;
export interface IndexDump {
  format: typeof INDEX_FORMAT; version: 1; commit: string | null;
  tables: Record<IndexTable, IndexRow[]>;
  counts: Record<IndexTable, number>; limitations: string[];
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function indexDump(tables: IndexDump["tables"], commit: string | null, limitations: string[] = []): IndexDump {
  return { format: INDEX_FORMAT, version: 1, commit, tables, counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])) as IndexDump["counts"], limitations };
}
export function validateIndex(value: unknown): IndexDump {
  const fail = (why: string): never => { throw new RuleError("bad_index", why, 400, "atelier index export --file fresh-index.json"); };
  if (!value || typeof value !== "object") fail("the index is a JSON object");
  const d = value as IndexDump;
  if (d.format !== INDEX_FORMAT || d.version !== 1) fail("expected atelier-server-index version 1");
  if (!(d.commit === null || typeof d.commit === "string") || !Array.isArray(d.limitations) || d.limitations.some((v) => typeof v !== "string")) fail("invalid source metadata");
  // Accept the five-table files produced before snapshots were carried.
  if (d.tables && Object.keys(d.tables).sort().join() === "model_assignments,model_cards,model_notes,models,runs") {
    d.tables = { ...d.tables, snapshot_takes: [], model_snapshots: [] };
    d.counts = { ...d.counts, snapshot_takes: 0, model_snapshots: 0 };
  }
  if (!d.tables || !d.counts || Object.keys(d.tables).sort().join() !== Object.keys(INDEX_TABLES).sort().join()) fail("the index must carry exactly the seven index tables");
  for (const [name, columns] of Object.entries(INDEX_TABLES)) {
    const table = name as IndexTable, rows = d.tables[table];
    if (!Array.isArray(rows) || d.counts[table] !== rows.length) fail(`${table}: count does not match rows`);
    const seen = new Set();
    for (const r of rows) {
      if (!r || typeof r !== "object" || Object.keys(r).sort().join() !== [...columns].sort().join()) fail(`${table}: invalid columns`);
      const snapshot = table === "snapshot_takes" || table === "model_snapshots";
      const identity = canonical(INDEX_KEYS[table].map((k) => r[k]));
      if (snapshot) {
        if (typeof r.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !Number.isFinite(Date.parse(r.day)) || new Date(r.day).toISOString().slice(0, 10) !== r.day ||
            !Number.isSafeInteger(r.schema) || Number(r.schema) < 1 || !Number.isSafeInteger(r.rev) || Number(r.rev) < 1 ||
            (table === "model_snapshots" && (typeof r.model !== "string" || !r.model || typeof r.role !== "string" || !r.role))) fail(`${table}: invalid snapshot key`);
      }
      const key = table === "model_assignments" ? "n" : "id";
      if (!snapshot && (table === "models" ? typeof r.id !== "string" || !r.id : !Number.isSafeInteger(r[key]) || Number(r[key]) < 1)) fail(`${table}: invalid row id`);
      if (seen.has(identity)) fail(`${table}: repeated id ${snapshot ? identity : r[key]}`);
      seen.add(identity);
      if ("model" in r && typeof r.model !== "string") fail(`${table}: invalid model`);
      if (table === "model_assignments" && (typeof r.id !== "string" || r.id !== `a${r.n}`)) fail(`${table}: invalid assignment id`);
      if (typeof r.json !== "string") fail(`${table}: json must be text`);
      let record;
      try { record = JSON.parse(r.json as string); } catch { fail(`${table}: invalid JSON`); }
      if (!record || typeof record !== "object" || Array.isArray(record)) fail(`${table}: record must be an object`);
      if (snapshot) {
        if (table === "snapshot_takes" ? record.day !== r.day || record.schema !== r.schema || record.rev !== r.rev : record.model !== r.model || record.role !== r.role || !Array.isArray(record.figures)) fail(`${table}: record differs from snapshot key`);
        if ((r.role === "@trend" || record.projection !== undefined) && (!validTrendProjection(record.projection) || r.schema !== 1 || r.rev !== 1 || r.role !== "@trend" || record.projection.model !== r.model || record.projection.to !== r.day || !Array.isArray(record.projection.measures))) fail(`${table}: invalid trend projection`);
      }
      if (table === "models") {
        if (typeof record.harness !== "string" || !record.harness.trim()) fail("models: harness must be a non-empty string");
        if (record.aliases !== undefined && (!Array.isArray(record.aliases) || record.aliases.some((alias: unknown) => typeof alias !== "string"))) fail("models: aliases must be a list of strings");
      }
      if ((table === "models" || table === "model_assignments") && record.id !== r.id) fail(`${table}: record id differs from row id`);
    }
  }
  return d;
}

// Redact credential values, never prose or keys that happen to name tokens.
// Parse nested JSON text (including assignment fingerprints) so a credential
// is redacted identically wherever the same request text is stored.
export function safeIndex<T>(dump: T, credentials: readonly string[] = []): T {
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (/^\s*[\[{]/.test(value)) {
        try {
          const parsed = JSON.parse(value), safe = redact(parsed);
          return canonical(parsed) === canonical(safe) ? value : JSON.stringify(safe);
        } catch { /* Ordinary text, not serialized JSON. */ }
      }
      let text = value.replace(/(?<![A-Za-z0-9_])atl_[0-9a-f]{16,}(?![A-Za-z0-9_])/gi, "[redacted]");
      for (const token of credentials.filter(Boolean)) text = text.split(token).join("[redacted]");
      return text;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    return value;
  };
  return redact(dump) as T;
}
