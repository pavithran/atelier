import { isStale, plain, type UsageReport } from "./report.ts";

const reasons: Record<string, string> = {
  codex: "no rate-limit window reported from session logs",
  "claude-code": "session logs count tokens, but provide no plan percent or reset",
  antigravity: "no verified readable quota source",
  zcode: "request counts provide no plan percent or reset",
  opencode: "request costs provide no plan percent or reset",
  deepseek: "a balance provides no allowance percent or reset",
  gemini: "no allowance percent or reset reported",
};

// Keep each machine's reading: account windows may overlap across machines.
export function usageLines(value: { reports?: UsageReport[] } | null, now = Date.now()): string[] {
  const reports = Array.isArray(value?.reports) ? value.reports : [];
  return [...new Set([...Object.keys(reasons), ...reports.map((r) => r.tool)])].flatMap((tool) => {
    const found = reports.filter((r) => r.tool === tool);
    if (!found.length) return [`Usage ${plain(tool, 32)}: no figure; ${value ? reasons[tool] ?? "no report" : "usage reports could not be read"}.`];
    return found.map((r) => {
      const windows = r.windows.map((w) => `${plain(w.name, 40)} ${w.usedPercent}% used, next reset ${w.resetsAt ?? "unknown"}${w.resetsAt && Date.parse(w.resetsAt) <= now ? " (past; await a new reading)" : ""}`).join("; ");
      return `Usage ${plain(tool, 32)} (${plain(r.runner, 80)}; reported ${r.at}${isStale(r, now) ? "; stale" : ""}): ${windows || `no figure; ${reasons[tool] ?? "no allowance window reported"}`}.`;
    });
  });
}
