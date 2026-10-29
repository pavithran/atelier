// The tool names a builder's log may name for a step (G21), defined once for
// the runner (cli/progress.mjs) and the server (src/situation.ts): Claude
// Code's, and the codex and opencode equivalents. A name not on the list is
// kept as the word "tool", since no pattern can prove a name is a tool's.
export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  // Claude Code
  "Bash", "Read", "Edit", "Write", "Grep", "Glob", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
  // codex
  "shell", "exec_command", "apply_patch", "update_plan", "web_search",
  // opencode
  "bash", "read", "edit", "write", "grep", "glob", "list", "patch", "webfetch", "todowrite", "todoread", "task",
]);

export function toolName(v: unknown): string {
  return typeof v === "string" && KNOWN_TOOLS.has(v) ? v : "tool";
}
