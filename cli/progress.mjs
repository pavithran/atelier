// A live progress line per task (Atelier 2.0, lessons gap G21, from miqra on
// PAVI's word): what the builder has done so far, which the runner sends with
// its poll and heartbeat and the server keeps (Ledger.recordProgress), so
// `atelier situation` and `atelier show` can say it and flag a stall. Every
// figure is read, never judged here:
//   - commands run: tool calls started and completed, from the builder's
//     stream-json log (claude -p --output-format stream-json --verbose,
//     which the claude-code adapter writes to ATELIER_PROGRESS_LOG);
//   - the current step: the last tool call started and not yet completed,
//     with when this runner first saw it;
//   - whether a child process is alive: a process the model's CLI started
//     (the harness is depth 0, the model's CLI depth 1, what it runs depth 2);
//   - commits and changed files on t/N since the task's base;
//   - tokens and cost, from the log's usage and its final result line;
//   - when the run started and ended.
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { toolName } from "../src/tool-names.ts";

const oneLine = (text) => String(text ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
// What a tool call ran, as the program's name alone: a command's first word
// past any NAME=value assignments, its path stripped (npm, git, node). No
// argument, path, pattern or description is ever kept, so no key can leak
// through one, whatever form it takes. A call that runs no command (an edit,
// a read) keeps no summary: its tool's name says what it was.
// The raw command is read through an allowlist, before any normalizing:
// it is split on ASCII space and tab alone, and every character up to the
// end of the program word must be one of A-Z a-z 0-9 _ = . / + : @ % -.
// Anything else there (a quote, a backslash, $, a non-breaking or zero-width
// space, a CR or LF, any non-ASCII letter) could hide where an assignment's
// value ends, so the command is kept as the fixed name sh.
export const PROGRAM = /^[A-Za-z0-9._+-]{1,40}$/;
const SAFE_WORD = /^[A-Za-z0-9_=./+:@%-]+$/;
export function summaryOf(name, input = {}) {
  if (typeof input?.command !== "string") return null;
  for (const word of input.command.split(/[ \t]+/)) {
    if (word === "") continue;
    if (!SAFE_WORD.test(word)) return "sh";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    const program = word.split("/").pop() ?? "";
    return PROGRAM.test(program) ? program : "sh";
  }
  return null;
}

// A fresh reading of one run's log.
export function newStream() {
  return { offset: 0, partial: "", started: 0, completed: 0, pending: new Map(), last: null, tokens: 0, costUsd: null, result: null };
}

// Folds the text of stream-json lines into the reading; a line cut at the
// end of the text is kept for the next call. `at` is when this runner read
// them, which dates a tool call it sees start.
export function foldStream(state, text, at) {
  const lines = (state.partial + text).split("\n");
  state.partial = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(event?.message?.content) ? event.message.content : [];
    if (event.type === "assistant") {
      const usage = event.message?.usage;
      if (usage) state.tokens += ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((n, k) => n + (Number.isFinite(usage[k]) ? usage[k] : 0), 0);
      for (const c of content) {
        if (c?.type !== "tool_use" || typeof c.id !== "string") continue;
        state.started++;
        state.pending.set(c.id, { name: toolName(c.name), summary: summaryOf(c.name, c.input), since: at });
      }
    } else if (event.type === "user") {
      for (const c of content) {
        if (c?.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
        const call = state.pending.get(c.tool_use_id);
        state.pending.delete(c.tool_use_id);
        state.completed++;
        state.last = { name: call?.name ?? "tool", summary: call?.summary ?? null, at, error: c.is_error === true };
      }
    } else if (event.type === "result") {
      if (Number.isFinite(event.total_cost_usd)) state.costUsd = event.total_cost_usd;
      state.result = { subtype: oneLine(event.subtype).slice(0, 40) || null, error: event.is_error === true };
    }
  }
  return state;
}

// Reads what the log gained since the last read. A log not written yet reads
// as nothing.
export function readStream(state, path, at) {
  let fd;
  try {
    const size = statSync(path).size;
    if (size <= state.offset) return state;
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(Math.min(size - state.offset, 8 * 1024 * 1024));
    const n = readSync(fd, buffer, 0, buffer.length, state.offset);
    state.offset += n;
    return foldStream(state, buffer.subarray(0, n).toString("utf8"), at);
  } catch { return state; }
  finally { if (fd !== undefined) closeSync(fd); }
}

// The processes below `root`, each with its depth (1 for a child), from
// `ps -A -o pid=,ppid=`. Null when ps cannot be read.
export function descendants(root, read = () => spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5000 })) {
  const ps = read();
  if (ps.status !== 0 || !ps.stdout) return null;
  const children = new Map();
  for (const line of ps.stdout.trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out = [];
  const walk = (pid, depth) => { for (const c of children.get(pid) ?? []) { out.push({ pid: c, depth }); walk(c, depth + 1); } };
  walk(root, 1);
  return out;
}

// The commits on the task's branch since its base, and the files they change.
export function branchFacts(workspace, base, git = (args) => spawnSync("git", args, { cwd: workspace, encoding: "utf8", timeout: 10_000 })) {
  if (!workspace || !base) return { commits: 0, changedFiles: 0 };
  const count = git(["rev-list", "--count", `${base}..HEAD`]);
  const files = git(["diff", "--name-only", base, "HEAD"]);
  return {
    commits: count.status === 0 ? Number(count.stdout.trim()) || 0 : 0,
    changedFiles: files.status === 0 ? files.stdout.split("\n").filter(Boolean).length : 0,
  };
}

// One runner's progress tracker: at most one build runs at a time. `begin`
// when the harness is about to start, `spawned` with its pid, `end` when it
// has ended; `report()` gives what goes with the next poll or heartbeat, the
// run that ended included until it has been sent once (`sent`).
export function progressTracker({ now = Date.now, ps, git } = {}) {
  let run = null;
  return {
    // Only the Claude Code adapter writes a stream-json log; another harness
    // (codex, opencode, a runner's own command) reports no command telemetry,
    // which is said as such, never as no command run.
    begin({ project, task, actor, base, workspace, log, harness = null }) {
      run = { project, task, actor, base, workspace, log, harness, telemetry: harness === "claude-code", startedAt: new Date(now()).toISOString(), endedAt: null, pid: null, stream: newStream(), sent: false };
    },
    spawned(pid) { if (run) run.pid = pid; },
    end() { if (run && !run.endedAt) run.endedAt = new Date(now()).toISOString(); },
    active() { return !!run; },
    sent() { if (run?.endedAt) run = null; },
    report() {
      if (!run) return [];
      const at = new Date(now()).toISOString();
      if (run.telemetry) readStream(run.stream, run.log, at);
      const s = run.stream;
      const below = run.pid && !run.endedAt ? descendants(run.pid, ps) : [];
      const current = !run.endedAt && s.pending.size ? [...s.pending.values()].at(-1) : null;
      return [{
        project: run.project, task: run.task, actor: run.actor, harness: run.harness, telemetry: run.telemetry,
        startedAt: run.startedAt, endedAt: run.endedAt, at,
        commands: { started: s.started, completed: s.completed },
        current, last: s.last,
        childAlive: below === null ? null : below.some((p) => p.depth >= 2),
        ...branchFacts(run.workspace, run.base, git),
        logBytes: s.offset, tokens: s.tokens || null, costUsd: s.costUsd,
        ...(s.result ? { result: s.result } : {}),
      }];
    },
  };
}
