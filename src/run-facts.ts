// What a runner's report of a run says, as structured facts alone (the
// round-10 review of G3/G4/G21): no text of the run's output reaches the
// server. Pattern redaction is never complete, so a run report, a run skip
// and a review skip carry only these, and the output itself stays in a log
// on the runner's own machine, named here by host and path, where the
// orchestrator reads it.
import { redactKeys } from "./models/pool.ts";

export interface RunFacts {
  exitCode: number | null;   // the harness's exit code, when it exited
  signal: string | null;     // the signal that ended it, as SIGNAME
  program: string | null;    // the harness program, from PROGRAMS, else sh
  lines: number | null;      // the output's line count
  bytes: number | null;      // and its size in bytes
  log: string | null;        // the full log's path on the runner's host
  host: string | null;       // that host
}

// The programs a runner runs a job through; any other is said as sh.
export const PROGRAMS: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "agy", "node", "npm", "npx", "git", "sh"]);
const LOG_PATH = /^\/[A-Za-z0-9._/-]{1,300}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const count = (v: unknown): number | null => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e12 ? v : null;

export function cleanRunFacts(raw: unknown): RunFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const exitCode = typeof r.exitCode === "number" && Number.isInteger(r.exitCode) && r.exitCode >= -255 && r.exitCode <= 255 ? r.exitCode : null;
  const signal = typeof r.signal === "string" && /^SIG[A-Z0-9]{1,10}$/.test(r.signal) ? r.signal : null;
  const program = typeof r.program === "string" ? (PROGRAMS.has(r.program) ? r.program : "sh") : null;
  // A path of plain characters alone; the key-shape test is not run on it, as
  // a temporary folder's random name (/var/folders/ld/fwhf7p9d...) looks like a key.
  const log = typeof r.log === "string" && LOG_PATH.test(r.log) && !r.log.includes("..") ? r.log : null;
  const host = typeof r.host === "string" && HOST.test(r.host) && redactKeys(r.host) === r.host ? r.host : null;
  return { exitCode, signal, program, lines: count(r.lines), bytes: count(r.bytes), log, host };
}

// The facts in a line for a person, built from the facts alone.
export function runFactsText(f: RunFacts | null | undefined): string {
  if (!f) return "";
  const parts = [
    f.program ? `${f.program}` : null,
    f.exitCode !== null ? `exit ${f.exitCode}` : f.signal ? `ended by ${f.signal}` : null,
    f.lines !== null || f.bytes !== null ? `${f.lines ?? "?"} lines, ${f.bytes ?? "?"} bytes of output` : null,
    f.log ? `log ${f.host ? `${f.host}:` : ""}${f.log}` : null,
  ].filter(Boolean);
  return parts.join("; ");
}

// A stored record read back: its free text is replaced by the facts' line,
// so a row written before this rule shows nothing raw.
export function withoutRunText<T extends { facts?: RunFacts | null }>(row: T, field: keyof T): T {
  return { ...row, [field]: runFactsText(cleanRunFacts(row.facts)) };
}

// ── automatic release notes (the round-11 review) ─────────────────────────
//
// A release a runner makes (a failure, a give-up, work in progress, a
// provider's limit) carries facts alone, rebuilt from the note it sent by
// this fixed grammar: the step from STEPS, the exit code, the signal, a
// timeout, a work-in-progress commit, a provider's limit and its reset, the
// log's host and path. Nothing else of the note is kept, so no error text,
// stderr or URL a failure echoed reaches the server. A validation_blocked
// note is the builder's own report, kept as the block's reason (a follow-up),
// redacted. A release the developer or a model writes by hand keeps its words.
export const STEPS = ["claim", "clone", "fetch", "reset", "checkout", "merge", "rebase", "commit", "push", "harness", "check", "submit", "finish", "brief", "prepare", "plan", "workspace", "run"] as const;
const GAVE_UP_NOTE = "the runner gave up: ";
const VALIDATION_BLOCKED_NOTE = "validation_blocked: ";

const OUTCOMES: readonly [RegExp, string][] = [
  [/\bno new commit\b/, "no new commit"],
  [/\bpush (?:was )?refused\b/, "push refused"],
  [/\b(?:secret scan|key-shaped line)\b/, "secret scan refused"],
  [/\bcommit identity refused\b/, "commit identity refused"],
  [/\bnothing to submit\b/, "nothing to submit"],
  [/\bstates no verdict\b|\bno readable verdict\b|\bwithout a verdict\b/, "the reply states no verdict"],
  [/\bnot mechanical\b/, "not mechanical"],
];

export function automaticNote(note: unknown): string {
  const s = String(note ?? "");
  if (s.startsWith(VALIDATION_BLOCKED_NOTE)) return redactKeys(s);
  const prefix = s.startsWith(GAVE_UP_NOTE) ? GAVE_UP_NOTE : "";
  const named = /\bstep ([a-z-]+)\b/.exec(s)?.[1] ?? /\bgit ([a-z-]+)\b/.exec(s)?.[1] ?? (/\bharness\b/.test(s) ? "harness" : null)
    ?? STEPS.find((step) => step !== "run" && new RegExp(`\\b${step}(?:es|s)?\\b`).test(s)) ?? null;
  // An interrupt leads, as the server reads it there (src/review/stopped.ts).
  const parts = [...(/^interrupted\b/.test(s) ? ["interrupted"] : []), `step ${named && (STEPS as readonly string[]).includes(named) ? named : "run"}`];
  const exit = /\bexit(?:ed| code)? (-?\d{1,3})\b/.exec(s)?.[1];
  if (exit) parts.push(`exit ${exit}`);
  const signal = /\b(SIG[A-Z0-9]{1,10})\b/.exec(s)?.[1];
  if (signal) parts.push(`signal ${signal}`);
  if (/\btimed out\b/.test(s)) parts.push("timed out");
  // What happened, from a fixed list of the runner's own phrases, never the error's words.
  for (const [seen, said] of OUTCOMES) if (seen.test(s) && !parts.includes(said)) parts.push(said);
  const wip = /\bwork in progress ([0-9a-f]{7,64}) (pushed|kept local)\b/.exec(s) ?? /\bcommitted as ([0-9a-f]{7,64})\b/.exec(s);
  if (wip) parts.push(`work in progress ${wip[1]} ${wip[2] ?? "pushed"}`);
  const limit = /\b([a-z][a-z0-9-]{0,30}) usage limit until (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z)/.exec(s);
  if (limit) parts.push(`${limit[1]} usage limit until ${limit[2]}`);
  if (/\bits commits are not pushed\b/.test(s)) parts.push("its commits are not pushed");
  const merge = /\bmerge commit ([0-9a-f]{7,64})\b/.exec(s)?.[1];
  if (merge) parts.push(`merge commit ${merge}`);
  const signature = /\bexit-signature: ([0-9a-f]{32})\b/.exec(s)?.[1];
  if (signature) parts.push(`exit-signature: ${signature}`);
  const size = /\brefused the review input for its size \((limit \d{1,12}|a limit it did not state); (actual \d{1,12}|about \d{1,12} characters sent)\)/.exec(s);
  if (size) parts.push(`refused the review input for its size (${size[1]}; ${size[2]})`);
  const log = /\blog ([A-Za-z0-9][A-Za-z0-9._-]{0,62}):(\/[A-Za-z0-9._/-]{1,300})(?=[;\s]|$)/.exec(s);
  if (log && !log[2].includes("..")) parts.push(`log ${log[1]}:${log[2]}`);
  return `${prefix}${parts.join("; ")}`;
}
