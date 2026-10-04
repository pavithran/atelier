// A project's history from before Atelier, read from git, never from the
// ledger: which models a project's own commit messages say took part, and
// when. Each commit is attributed to the agents named in its
// "Co-Authored-By:" and "Agent:" lines, or to no agent. This is what the
// commits claim, not evidence Atelier observed, and the pages say so.

export interface ImportedCommit { hash: string; message: string; committedAt: number }

export interface ImportedLane {
  label: string;               // as the commits name it, e.g. "Claude Opus 4.7"
  count: number;
  first: number;               // unix seconds
  last: number;
  times: number[];             // one per commit, oldest first
}

export interface ImportedHistory {
  total: number;               // commits read
  attributed: number;          // commits naming at least one agent
  lanes: ImportedLane[];       // most commits first; "No agent named" last
  first: number;
  last: number;
  complete: boolean;           // the whole history before the cutoff was read
}

export const NO_AGENT = "No agent named";

// The agents a commit message names. Variants of one model, such as
// "(1M context)", are one lane; an email address is not part of a name.
export function agentsIn(message: string): string[] {
  const names = new Set<string>();
  for (const line of message.split("\n")) {
    const m = /^\s*(?:Co-Authored-By|Agent)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const name = m[1].replace(/<[^>]*>/g, "").replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    // A human co-author is a person, not an agent: keep only names that
    // read as a model or an agent harness and model.
    if (name && (/\//.test(name) || /\d/.test(name) || /^(claude|gpt|codex|gemini|glm|deepseek|qwen|opus|sonnet|haiku|fable)\b/i.test(name))) names.add(name);
  }
  return [...names];
}

// Commits before `cutoff` (unix seconds), newest first as git logs them.
export function buildImported(commits: ImportedCommit[], cutoff: number | null, complete: boolean): ImportedHistory {
  const before = commits.filter((c) => cutoff === null || c.committedAt < cutoff).sort((a, b) => a.committedAt - b.committedAt);
  const lanes = new Map<string, ImportedLane>();
  let attributed = 0;
  for (const c of before) {
    const agents = agentsIn(c.message);
    if (agents.length) attributed++;
    for (const label of agents.length ? agents : [NO_AGENT]) {
      const lane = lanes.get(label) ?? { label, count: 0, first: c.committedAt, last: c.committedAt, times: [] };
      lane.count++; lane.last = c.committedAt; lane.times.push(c.committedAt);
      lanes.set(label, lane);
    }
  }
  const ordered = [...lanes.values()].sort((a, b) => (a.label === NO_AGENT ? 1 : b.label === NO_AGENT ? -1 : a.first - b.first || b.count - a.count));
  return {
    total: before.length, attributed, lanes: ordered,
    first: before[0]?.committedAt ?? 0, last: before.at(-1)?.committedAt ?? 0, complete,
  };
}

// How many commits are read, in pages of 1,000 (the most Artifacts' log
// returns at once); a longer history is drawn from its most recent part.
export const IMPORT_LIMIT = 3000;

export interface LogSource {
  log(opts: { ref?: string; limit?: number; offset?: number }): Promise<{ hash: string; message: string; committedAt: number; parents: string[] }[]>;
}

export async function readImported(s: LogSource, cutoff: number | null, limit = IMPORT_LIMIT): Promise<ImportedHistory> {
  const commits: ImportedCommit[] = [];
  let complete = false;
  for (let offset = 0; offset < limit; offset += 1000) {
    const page = await s.log({ limit: Math.min(1000, limit - offset), offset });
    commits.push(...page.map(({ hash, message, committedAt }) => ({ hash, message, committedAt })));
    if (page.length < Math.min(1000, limit - offset)) { complete = true; break; }
  }
  return buildImported(commits, cutoff, complete);
}
