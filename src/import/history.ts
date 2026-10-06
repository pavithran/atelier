// A project's history from before Atelier, read from git, never from the
// ledger: which models a project's own commit messages say took part, and
// when. Each commit is attributed to the agents named in its
// "Co-Authored-By:" and "Agent:" lines, or to no agent. This is what the
// commits claim, not evidence Atelier observed, and the pages say so.

import { TEXT_CONTROLS, withoutAddresses } from "../text.ts";

export interface ImportedCommit { hash: string; message: string; committedAt: number }

export interface ImportedLane {
  label: string;               // normalized model name, e.g. "opus-5.5"
  names: string[];             // as the commits name it, e.g. ["Claude Opus 4.7"]
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
// The shape of an ImportedHistory and how its lanes are named. Cached copies
// are keyed by it, so a change to either reaches the pages at once: raise it
// whenever buildImported or agentsIn would give a different result.
export const IMPORTED_FORMAT = 3;
const FRESH_ROOT = /^Atelier-Fresh-History: [0-9a-f]{40,64}$/m;
const NAME_LIMIT = 40;

// The agents a commit message names. Variants of one model, such as
// "(1M context)", are one lane; an email address is not part of a name.
export function agentsIn(message: string): string[] {
  const names = new Set<string>();
  for (const line of message.split("\n")) {
    const m = /^\s*(?:Co-Authored-By|Agent)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    // The name is the text before the email address, or, when nothing comes
    // before it, the text after it: "Jane Doe <j@x> reviewed PR #42" is Jane
    // Doe, and "<a@b.c> Claude Opus 5.5" is Claude Opus 5.5. Anything else in
    // angle brackets goes too. Invisible and direction-changing characters
    // go, as in a project title, because the name is drawn on public pages.
    // For the same reason an address without angle brackets goes as well,
    // before the invisible characters that could split it become spaces,
    // and a name that still holds an @ is not taken.
    const email = /<[^<>]*@[^<>]*>/.exec(m[1]);
    const before = email ? m[1].slice(0, email.index) : m[1];
    const side = email && !before.replace(/<[^>]*>/g, "").trim() ? m[1].slice(email.index + email[0].length) : before;
    const name = withoutAddresses(side.replace(/<[^>]*>/g, "")).replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(TEXT_CONTROLS, " ")
      .replace(/\s+/g, " ").trim();
    // A human co-author is a person, not an agent: keep only names that
    // read as a model or an agent harness and model. A name with no letter
    // at all, only a digit or a slash among its marks, is a number or a
    // path, not an agent's name. The whole name is tested, then it is
    // capped by code points, so a digit or slash after the cap, or half of
    // an emoji, is not what decides.
    if (/\p{L}/u.test(name) && !name.includes("@") && (/\//.test(name) || /\d/.test(name) || /^(claude|gpt|codex|gemini|glm|deepseek|qwen|opus|sonnet|haiku|fable)\b/i.test(name))) {
      names.add(Array.from(name).slice(0, NAME_LIMIT).join("").trim());
    }
  }
  return [...names];
}

// Imported history ends where Atelier's own record of tasks starts: the first
// task created. The item list is complete, unlike a window of recent events,
// so a long record never moves the cutoff into Atelier's own work. A project
// with no tasks yet has all its history before Atelier.
export function firstTaskAt(items: { createdAt: string }[]): number | null {
  const times = items.map((i) => Math.floor(Date.parse(i.createdAt) / 1000)).filter((t) => Number.isFinite(t));
  return times.length ? Math.min(...times) : null;
}

export function normaliseAgentName(name: string): string {
  if (name === NO_AGENT) return name;
  let s = name;
  if (s.includes("/")) s = s.split("/").slice(1).join("/");
  let norm = s.toLowerCase().trim().replace(/\s+/g, "-");
  norm = norm.replace(/^claude-(opus|sonnet|haiku|fable)/, "$1");
  if (!/\d/.test(norm)) {
    if (norm === "codex" || norm === "claude-code" || norm === "zcode" || norm === "opencode" || norm === "gemini-cli" || norm === "antigravity") {
      return `${norm}, model not recorded`;
    }
    return `${norm}, version not recorded`;
  }
  return norm;
}

// Commits before `cutoff` (unix seconds), newest first as git logs them.
export function buildImported(commits: ImportedCommit[], cutoff: number | null, complete: boolean): ImportedHistory {
  // A baseline that starts partway through a project's history begins with a
  // root commit Atelier made (cli/fresh.mjs); it is not the project's work.
  const before = commits.filter((c) => (cutoff === null || c.committedAt < cutoff) && !FRESH_ROOT.test(c.message)).sort((a, b) => a.committedAt - b.committedAt);
  const lanes = new Map<string, ImportedLane>();
  let attributed = 0;
  for (const c of before) {
    const agents = agentsIn(c.message);
    if (agents.length) attributed++;
    const counted = new Set<string>();
    for (const rawLabel of agents.length ? agents : [NO_AGENT]) {
      const label = rawLabel === NO_AGENT ? NO_AGENT : normaliseAgentName(rawLabel);
      // Two trailers naming one model ("claude-code/opus-5.5", "Claude Opus 5.5") are one commit in its lane.
      if (counted.has(label)) {
        const lane = lanes.get(label)!;
        if (!lane.names.includes(rawLabel)) lane.names.push(rawLabel);
        continue;
      }
      counted.add(label);
      const lane = lanes.get(label) ?? { label, names: [], count: 0, first: c.committedAt, last: c.committedAt, times: [] };
      if (rawLabel !== NO_AGENT && !lane.names.includes(rawLabel)) lane.names.push(rawLabel);
      lane.count++; lane.last = c.committedAt; lane.times.push(c.committedAt);
      lanes.set(label, lane);
    }
  }
  const ordered = [...lanes.values()].sort((a, b) => (a.label === NO_AGENT ? 1 : b.label === NO_AGENT ? -1 : a.first - b.first || b.count - a.count));
  // A baseline that starts partway through the history never reaches the
  // project's first commit, however much of it is read.
  if (commits.some((c) => FRESH_ROOT.test(c.message))) complete = false;
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
