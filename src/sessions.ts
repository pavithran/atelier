export const SESSION_TEXT_MAX = 2000;
// Metadata only. Never store prompts, transcripts, file contents or command output.
export interface SessionData {
  sessionAt?: string;
  commit?: string;
  pushes?: { remote: string; passed: boolean }[];
  found?: string[];
  summary: string;
  next: string;
  head: string;
  dirty: boolean;
  checks: { command: string; passed: boolean; grade: "reported" }[];
  checksSkipped: boolean;
  // The registered checks that failed and `wrap --allow-failing` committed
  // past, by command. Absent when every check passed, when the checks were
  // skipped, and in notes from before the flag existed.
  checksOverridden?: string[];
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
  const metadata: Partial<SessionData> = {};
  if (value.sessionAt !== undefined) {
    if (typeof value.sessionAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.sessionAt)) throw new Error("invalid session time");
    metadata.sessionAt = value.sessionAt;
  }
  if (value.commit !== undefined) {
    if (typeof value.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(value.commit)) throw new Error("invalid session commit");
    metadata.commit = value.commit;
  }
  if (value.pushes !== undefined) {
    if (!Array.isArray(value.pushes) || value.pushes.length > 100) throw new Error("at most 100 remote results allowed");
    metadata.pushes = value.pushes.map((p) => {
      if (!p || !sessionText(p.remote, 200) || typeof p.passed !== "boolean") throw new Error("invalid remote result");
      return { remote: sessionText(p.remote, 200), passed: p.passed };
    });
  }
  if (value.found !== undefined) {
    if (!Array.isArray(value.found) || value.found.length > 100 || value.found.some((id) => typeof id !== "string" || !/^t[0-9]{1,20}$/.test(id))) throw new Error("invalid filed task ids");
    metadata.found = value.found;
  }
  if (value.checksOverridden !== undefined) {
    if (!Array.isArray(value.checksOverridden) || !value.checksOverridden.length || value.checksOverridden.length > 100 || value.checksOverridden.some((c) => !sessionText(c))) throw new Error("overridden checks must name one to 100 commands");
    metadata.checksOverridden = value.checksOverridden.map((c) => sessionText(c));
  }
  return { ...metadata, summary, next: sessionText(value.next), head: value.head, dirty: value.dirty, checks, checksSkipped: value.checksSkipped === true };
}

// PROJECT.md is the last choice: a project may keep its handoff in a file Git
// does not track, as Atelier's own checkout does because the repository is public.
export function stateFile(paths: string[]): string | undefined {
  return ["docs/STATE.md", "STATE.md", "PROJECT.md"].find((p) => paths.includes(p));
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
  return [`Session: ${sessionText(note.actor)} at ${sessionText(note.at, 40)}`, d.summary, `Next: ${d.next || "not recorded"}`,
    `Checkout HEAD: ${d.head}; tree ${d.dirty ? "dirty" : "clean"}.`,
    ...(d.commit ? [`Session commit: ${d.commit}`] : []),
    ...(d.pushes ?? []).map((p) => `Remote ${sessionText(p.remote, 200)}: ${p.passed ? "pushed" : "failed"}.`),
    ...(d.found?.length ? [`Filed tasks: ${d.found.join(", ")}`] : []),
    ...d.checks.map((c) => `Reported: ${c.command}: ${c.passed ? "passed" : "failed"} (owner's checkout, not a clean clone).`),
    ...(d.checksSkipped ? ["Registered checks skipped (--no-check)."] : []),
    ...(d.checksOverridden?.length ? [`Failing checks overridden by --allow-failing: ${d.checksOverridden.join(", ")}.`] : [])].join("\n");
}

// A registered check that did not pass, with how it ended: `status` is its
// exit status, or null when a signal ended it, `timedOut` when that signal
// was wrap's own timeout.
export interface FailedCheck { command: string; status: number | null; signal: string | null; timedOut: boolean }

function checkEnding(c: FailedCheck): string {
  if (c.status !== null) return `exited ${c.status}`;
  if (c.timedOut) return "timed out";
  return c.signal ? `ended by ${c.signal}` : "did not run";
}
const failedList = (failed: FailedCheck[]) => failed.map((c) => `${sessionText(c.command, 200)} (${checkEnding(c)})`).join(", ");

// Why wrap stops when a registered check fails: each failed check with how it
// ended, the override, and what was left untouched. Printed as the refusal.
export function failingChecksRefusal(failed: FailedCheck[]): string {
  const count = failed.length === 1 ? "a failing check" : `${failed.length} failing checks`;
  return `wrap refuses to commit with ${count}: ${failedList(failed)}. Fix ${failed.length === 1 ? "it" : "them"}, or run again with --allow-failing to commit anyway. Nothing was staged, recorded or pushed.`;
}

// The line wrap prints when --allow-failing lets failing checks through.
export function failingChecksOverridden(failed: FailedCheck[]): string {
  return `Failing checks overridden by --allow-failing: ${failedList(failed)}.`;
}
export const FILING_RELAY = 'Before the session closes, file a defect in Atelier or project tooling as a task in its project: atelier new "…" --project NAME. For Atelier use --project cloudflare-git. File a lesson worth keeping the same way with a title starting "Lesson: ".';
export const UNWRAP_RELAY = "Say in a short paragraph what is true, what is open and what you will do. " + FILING_RELAY;
// The line the agent relays to the owner. A failing check, the override that
// let it through, and each remote that did not take the push are named, never
// folded into "closed".
export function wrapRelay(note: SessionNote): string {
  const problems: string[] = [];
  if (note.data.checksOverridden?.length) problems.push("a failing check overridden by --allow-failing");
  else if (note.data.checks.some((c) => !c.passed)) problems.push("a failing check");
  const failed = (note.data.pushes ?? []).filter((p) => !p.passed).map((p) => sessionText(p.remote, 200));
  if (failed.length) problems.push(`${failed.length === 1 ? "a failed push" : "failed pushes"} to ${failed.join(", ")}`);
  return problems.length ? `Relay: session closed with ${problems.join(" and ")}.` : "Relay: session closed; checks are Reported, not Observed.";
}

// What wrap names when it refuses because work in the checkout is unfinished.
// Each key is a file or directory in the Git directory that marks it.
export const WRAP_MARKERS: Record<string, string> = {
  MERGE_HEAD: "a merge",
  CHERRY_PICK_HEAD: "a cherry-pick",
  REVERT_HEAD: "a revert",
  "rebase-merge": "a rebase",
  "rebase-apply": "a rebase",
  "atelier-landing.json": "a landing",
  // A multi-commit cherry-pick or revert paused on a conflict, which may
  // leave no CHERRY_PICK_HEAD or REVERT_HEAD once the conflict is staged.
  sequencer: "a cherry-pick or revert sequence",
};

// The paths `git ls-files -u -z` lists, each once: an entry is "MODE SHA STAGE", a tab, the path.
export function unmergedPaths(output: string): string[] {
  return [...new Set(output.split("\0").filter(Boolean).map((entry) => entry.slice(entry.indexOf("\t") + 1)))];
}

// Why wrap must not stage anything yet, or undefined when the checkout is ready. `inProgress` holds
// the WRAP_MARKERS found in the Git directory and `unmerged` the paths the index holds in conflict. A
// squash merge or a stash pop leaves conflicts with no marker, so the index is read as well, and no
// conflict marker is committed.
export function wrapRefusal(s: { branch: string; registered: string; inProgress: string[]; unmerged: string[] }): string | undefined {
  if (!s.branch) return "wrap refuses a detached HEAD";
  const kinds = [...new Set(s.inProgress.map((marker) => WRAP_MARKERS[marker] ?? marker))];
  if (kinds.length) return `wrap refuses with ${kinds.join(" and ")} in progress; finish or abort ${kinds.length > 1 ? "them" : "it"} first`;
  if (s.unmerged.length) {
    const shown = s.unmerged.slice(0, 5).map((path) => sessionText(path, 200)).join(", ");
    const more = s.unmerged.length > 5 ? ` and ${s.unmerged.length - 5} more` : "";
    return `wrap refuses with unmerged files: ${shown}${more}; resolve each and git add it, or abort the operation, so no conflict marker is committed`;
  }
  if (s.branch !== s.registered) return `check out ${s.registered} before wrap`;
  return undefined;
}

export function sessionCommitMessage(summary: string, next: string, at: string): string {
  return `${sessionText(summary)}\n\n${next ? `${sessionText(next)}\n\n` : ""}Atelier-Session: ${sessionText(at, 40)}\n`;
}
