export const SESSION_TEXT_MAX = 2000;
export interface SessionData {
  summary: string;
  next: string;
  head: string;
  dirty: boolean;
  checks: { command: string; passed: boolean; grade: "reported" }[];
  checksSkipped: boolean;
}
export interface SessionNote {
  actor: string;
  at: string;
  data: SessionData;
}

export function sessionText(value: unknown, cap = SESSION_TEXT_MAX): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\p{Default_Ignorable_Code_Point}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, cap) : "";
}

export function cleanSession(value: Record<string, unknown>): SessionData {
  if (value.next !== undefined && typeof value.next !== "string") throw new Error("next must be text");
  const summary = sessionText(value.summary);
  if (!summary) throw new Error("a session needs a summary");
  if (typeof value.head !== "string" || !/^[a-f0-9]{40,64}$/.test(value.head)) throw new Error("a session needs a checkout HEAD");
  if (typeof value.dirty !== "boolean") throw new Error("dirty must be a boolean");
  if (!Array.isArray(value.checks) || value.checks.length > 100) throw new Error("checks must be an array of at most 100 results");
  const checks = value.checks.map((c) => {
    if (!c || typeof c !== "object" || !sessionText(c.command) || typeof c.passed !== "boolean") throw new Error("a check needs a command and boolean result");
    return { command: sessionText(c.command), passed: c.passed, grade: "reported" as const };
  });
  return { summary, next: sessionText(value.next), head: value.head, dirty: value.dirty, checks, checksSkipped: value.checksSkipped === true };
}

export function stateFile(paths: string[]): string | undefined {
  return ["docs/STATE.md", "STATE.md"].find((p) => paths.includes(p));
}

export function handoffNotes(state: string, paths: string[], since?: string, modified: Record<string, string> = {}): string[] {
  return [...new Set(paths)].filter((p) => {
    if (p.split("/").includes("..") || !/^docs\/(handoffs\/|HANDOFF-)/.test(p)) return false;
    const date = p.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const named = state.includes(p) || (p.startsWith("docs/") && state.includes(p.slice(5)));
    return named || (p.startsWith("docs/handoffs/") && !!date && (!since || (modified[p] ?? `${date}T00:00:00.000Z`) > since));
  }).sort().reverse();
}

export function staleState(path: string | undefined, previousHead: string | undefined, unchanged: boolean): string {
  return path && previousHead && unchanged ? `Refresh ${path}: it has not changed since the newest session note's HEAD.` : "";
}

export function fileExcerpt(path: string, contents: string, limit = 80): string {
  const lines = contents.split("\n");
  return `${path}:\n${lines.slice(0, limit).join("\n")}${lines.length > limit ? `\nRead the rest in ${path}, from line ${limit + 1}.` : ""}`;
}

export function sessionNoteText(note?: SessionNote): string {
  if (!note) return "No session note recorded.";
  const d = note.data;
  return [`Session: ${sessionText(note.actor)} at ${note.at}`, d.summary, `Next: ${d.next || "not recorded"}`,
    `Checkout HEAD: ${d.head}; tree ${d.dirty ? "dirty" : "clean"}.`,
    ...d.checks.map((c) => `Reported: ${c.command}: ${c.passed ? "passed" : "failed"} (owner's checkout, not a clean clone).`),
    ...(d.checksSkipped ? ["Registered checks skipped (--no-check)."] : [])].join("\n");
}
export const UNWRAP_RELAY = "Say in a short paragraph what is true, what is open and what you will do.";
export function wrapRelay(note: SessionNote): string {
  return note.data.checks.some((c) => !c.passed) ? "Relay: session closed with a failing check." : "Relay: session closed; checks are Reported, not Observed.";
}
