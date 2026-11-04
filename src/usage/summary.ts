import { actorStanding, type ModelEntry } from "../models/pool.ts";
import { actorFamily, familyRefusal } from "../rules.ts";
import { offering, offersFor, type SeenOffer } from "../dispatch/rules.ts";
import { crossings, DEFAULT_THRESHOLDS, isStale, plain, STALE_MS, type Thresholds, type UsageReport } from "./report.ts";

export const usageReasons: Record<string, string> = {
  codex: "no rate-limit window reported from session logs",
  "claude-code": "session logs count tokens; no plan percent without a recent Claude status-line rate_limits capture",
  antigravity: "no verified readable quota source",
  zcode: "request counts provide no plan percent or reset",
  opencode: "request costs provide no plan percent or reset",
  deepseek: "a balance provides no allowance percent or reset",
  "gemini-cli": "no allowance percent or reset reported",
};

// Keep each machine's reading: account windows may overlap across machines.
export function usageLines(value: { reports?: UsageReport[] } | null, now = Date.now()): string[] {
  const reports = Array.isArray(value?.reports) ? value.reports : [];
  return [...new Set([...Object.keys(usageReasons), ...reports.map((r) => r.tool)])].flatMap((tool) => {
    const found = reports.filter((r) => r.tool === tool);
    if (!found.length) return [`Usage ${plain(tool, 32)}: no figure; ${value ? usageReasons[tool] ?? "no report" : "usage reports could not be read"}.`];
    return found.map((r) => {
      const windows = r.windows.map((w) => `${plain(w.name, 40)} ${w.usedPercent}% used, ${Math.max(0, Math.round((100 - w.usedPercent) * 10) / 10)}% left, next reset ${w.resetsAt ?? "unknown"}${w.resetsAt && Date.parse(w.resetsAt) <= now ? " (past; await a new reading)" : ""}`).join("; ");
      return `Usage ${plain(tool, 32)} (${plain(r.runner, 80)}; reported ${r.at}${isStale(r, now) ? "; stale" : ""}): ${windows || `no figure; ${usageReasons[tool] ?? "no allowance window reported"}`}.`;
    });
  });
}

interface UsageView { reports?: UsageReport[]; thresholds?: Thresholds }
interface AdviceContext {
  pool: ModelEntry[] | null;
  offers: SeenOffer[] | null;
  tasks: { id: string; contributors: string[] }[] | null;
  project?: string;
  single?: string | null;
}

// Advice only: keep reports separate, and use the least remaining live window.
export function usageAdvice(value: UsageView | null, context: AdviceContext, now = Date.now()): string[] {
  if (!value) return ["Next models: unknown; usage, pool, runners or contributors could not be read."];
  const thresholds = value.thresholds ?? DEFAULT_THRESHOLDS;
  const fresh = (value.reports ?? []).filter((r) => !isStale(r, now)).map((r) => ({ ...r, windows: r.windows.filter((w) => !w.at || now - Date.parse(w.at) <= STALE_MS) }));
  const warnings = fresh.flatMap((r) => crossings(r, thresholds, now).map((c) => ({ tool: r.tool, message: c.body })));
  if (!context.pool || !context.offers || !context.tasks) return [...warnings.map((w) => `Warning: ${plain(w.tool, 32)}: ${plain(w.message, 500)} Alternative builder/reviewer unknown; pool, runners or contributors could not be read.`), "Next models: unknown; pool, runners or contributors could not be read."];
  const held = new Set(warnings.map((w) => w.tool));
  const toolOf = (m: ModelEntry) => m.harness === "opencode" && m.provider === "deepseek" ? "deepseek" : m.harness;
  const remaining = (m: ModelEntry): number | null => {
    const windows = fresh.filter((r) => r.tool === toolOf(m)).flatMap((r) => r.windows).filter((w) =>
      (!w.at || now - Date.parse(w.at) <= STALE_MS) && w.resetsAt !== null && Date.parse(w.resetsAt) > now);
    return windows.length ? Math.max(0, Math.min(...windows.map((w) => 100 - w.usedPercent))) : null;
  };
  const actor = (m: ModelEntry) => `${m.harness}/${m.id}`;
  const offers = context.project ? offersFor(context.offers, context.project) : context.offers;
  const candidates = (role: "build" | "review") => context.pool!.filter((m) =>
    (!context.single || actorFamily(actor(m)) === context.single) &&
    !held.has(m.harness) && !held.has(toolOf(m)) && remaining(m) !== 0 && !actorStanding(context.pool!, actor(m), role) && m.status?.state !== "refused" &&
    offering({ to: m.where, ...(role === "review" ? { job: "review" } : {}) }, offers, new Date(now))?.actors.has(actor(m).toLowerCase()))
    .sort((a, b) => (remaining(b) ?? -1) - (remaining(a) ?? -1) || actor(a).localeCompare(actor(b)));
  const describe = (m: ModelEntry | undefined) => m ? `${plain(actor(m), 160)} (${remaining(m) === null ? "quota unknown; check vendor" : `${remaining(m)}% left`})` : "none eligible; add an available independent model and runner";
  const builders = candidates("build"), reviewers = candidates("review");
  // This advice always requires another company, even in single-family projects.
  const reviewer = (contributors: string[]) => context.single ? undefined : reviewers.find((m) => !familyRefusal(actor(m), contributors));
  const builder = builders.find((m) => reviewer([actor(m)])) ?? builders[0];
  const next = `build: ${describe(builder)}; review next build: ${describe(builder ? reviewer([actor(builder)]) : undefined)}`;
  return [
    ...warnings.map((w) => `Warning: ${plain(w.tool, 32)}: ${plain(w.message, 500)} Use ${next}.`),
    `Next models: ${next}.`,
    ...context.tasks.map((t) => `Next review ${plain(t.id, 40)}: ${describe(reviewer(t.contributors))}.`),
  ];
}
