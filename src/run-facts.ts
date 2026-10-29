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
