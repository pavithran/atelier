export type TaskKind = "mechanical-edit" | "feature" | "refactor" | "tests" | "docs" | "ui" | "research";
export type Family = "anthropic" | "openai" | "zai" | "qwen" | "deepseek" | "minimax" | "google";
export type Harness = "claude-code" | "codex" | "opencode" | "zcode" | "gemini-cli" | "antigravity";
export type Where = "cloud" | "home";
export type EvidenceKind = "model-card" | "benchmark" | "local-qualification" | "atelier-record";

export interface ModelEvidence {
  kind: EvidenceKind;
  taskKind: TaskKind | "general" | "tool-use" | "repository" | "objective-answers" | "long-context";
  claim: string;
  source: string;
  date: string | null;       // null when the supplied source gives no date
}

export interface ModelProfile {
  id: string;
  aliases?: readonly string[];   // other names harnesses give this same model, such as a vendor's API id
  displayName: string;
  family: Family;
  harnesses: readonly Harness[]; // empty when no harness assignment was supplied
  where: Where;
  dataStaysLocal: boolean;
  contextWindow: number | null; // tokens; null when unknown or set by the server
  costClass: "none" | "low" | "medium" | "high" | "unknown";
  evidence: readonly ModelEvidence[];
  notes: readonly string[];
}

const STUDIO = "Task t14: supplied AI Studio qualification";
const PRIOR = "Task t14: supplied cloud model prior";
const home = {
  harnesses: [], where: "home", dataStaysLocal: true, costClass: "none",
  notes: ["AI Studio, M5 Ultra, oMLX, OpenAI-compatible at the Studio; no per-call cost."],
} as const;
const cloud = { where: "cloud", dataStaysLocal: false, contextWindow: null, costClass: "unknown", notes: [] } as const;

function qualification(taskKind: ModelEvidence["taskKind"], claim: string, date: string | null = null): ModelEvidence {
  return { kind: "local-qualification", taskKind, claim, source: STUDIO, date };
}

const prior: ModelEvidence = {
  kind: "model-card", taskKind: "general",
  claim: "vendor-described strength; not yet measured by Atelier", source: PRIOR, date: null,
};

// Missing specifications stay unknown. These sources are the supplied task facts,
// not independent model cards or new measurements by Atelier.
export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    ...home, id: "Qwen3-Coder-Next-4bit:studio-code", displayName: "Qwen3-Coder-Next-4bit:studio-code",
    family: "qwen", contextWindow: 32768,
    evidence: [
      qualification("tool-use", "5/5 tool scenarios; 12/12 long-session tool turns", "2026-09-30"),
      qualification("repository", "3/3 repository fixtures", "2026-09-30"),
      qualification("objective-answers", "8/16 general objective answers; unreliable unaided arithmetic", "2026-09-30"),
    ],
  },
  {
    ...home, id: "Qwen3.8-27B-6bit:studio-balanced", displayName: "Qwen3.8-27B-6bit:studio-balanced",
    family: "qwen", contextWindow: 65536,
    evidence: [
      qualification("objective-answers", "16/16 objective answers"),
      qualification("repository", "3/3 small repository fixtures"),
      qualification("tool-use", "11/12 long-session tool turns"),
    ],
  },
  {
    ...home, id: "GLM-5.3-Flash-4_8bit", displayName: "GLM-5.3-Flash-4_8bit", family: "zai", contextWindow: 65536,
    evidence: [], notes: [...home.notes, "Current default on the Studio as of 2026-10-03; no task-level qualification recorded yet."],
  },
  {
    ...home, id: "DeepSeek-V4-Flash", displayName: "DeepSeek-V4-Flash", family: "deepseek", contextWindow: null,
    evidence: [qualification("long-context", "Long-context qualification only: 262K to 1M windows, substantive values correct")],
    notes: [...home.notes, "Context window per server config."],
  },
  { ...cloud, id: "opus-5.5", aliases: ["claude-opus-5-5"], displayName: "opus-5.5", family: "anthropic", harnesses: ["claude-code"], evidence: [prior] },
  { ...cloud, id: "sonnet-5.5", aliases: ["claude-sonnet-5-5"], displayName: "sonnet-5.5", family: "anthropic", harnesses: ["claude-code"], evidence: [prior] },
  { ...cloud, id: "gpt-6-astra", displayName: "gpt-6-astra", family: "openai", harnesses: ["codex"], evidence: [prior] },
  { ...cloud, id: "glm-5.3", displayName: "glm-5.3", family: "zai", harnesses: ["zcode"], evidence: [prior] },
];
