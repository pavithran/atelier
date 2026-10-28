// The check limit (G7): how long a check or a command Atelier runs for a
// check may go on. Two numbers, both the project's own (`atelier init
// --check-limit MINUTES --silence-limit MINUTES`), read by `atelier check`,
// the lander, runners and builders from the server, never from the
// environment of whoever runs the check:
//
// - the silence limit: a run that has printed nothing and shown no
//   activity in its processes (CPU time spent, a process started or ended)
//   for this many minutes is stopped as "silent for N minutes". A check that
//   is silent by design (a long compile with no output) declares its own N
//   (`--check-silence CMD=MINUTES`);
//   A run with a live child process is quiet, not hung, and is not stopped
//   for silence (the stall rule from running builders directly in miqra);
// - the startup limit, when the project sets one (`--startup-limit
//   MINUTES`): a run that within that many minutes of its start has printed
//   nothing, shown no child process and spent no CPU time is stopped as
//   "showed no work in N minutes" (a harness blocked on a prompt nobody can
//   answer);
// - the slot-wait limit (`--slot-wait-limit MINUTES`, default 60): a run that
//   waits this long for its test slot is stopped as "waited N minutes for a
//   test slot", and the wait never counts toward the other limits;
// - the hard ceiling (checkLimitMinutes): a run that keeps progressing is
//   stopped only here, as "timed out after N minutes".
//
// Both count from the moment the run holds its test slot (cli/load.mjs),
// never from when it began to wait for one. A stopped run is a fact about
// the run, not a failed test, and is recorded as such (Evidence.stopped).

import type { ProjectPolicy } from "./rules.ts";
import { RuleError } from "./rules.ts";

export const DEFAULT_CHECK_LIMIT_MINUTES = 60;
export const DEFAULT_SILENCE_LIMIT_MINUTES = 10;
export const DEFAULT_SLOT_WAIT_MINUTES = 60;
// A day: a limit is a number of whole or part minutes from 1 to this.
export const LIMIT_MAX_MINUTES = 24 * 60;

// A check's own silence limit, declared with the policy.
export interface CheckSilence { command: string; minutes: number }

// What stopped a run: its ceiling, or its silence, with the limit in minutes.
export interface CheckStop { kind: "timeout" | "silent" | "startup" | "slot"; minutes: number }

// The limits a run of `command` goes by under `policy`, and where each came
// from: "project" when the policy sets it, "check" when the check declares
// its own silence, "default" otherwise.
export interface CheckLimits {
  limitMinutes: number;
  silenceMinutes: number;
  startupMinutes: number | null;   // null: no startup limit
  slotWaitMinutes: number;
  limitFrom: "project" | "default";
  silenceFrom: "check" | "project" | "default";
}

type LimitPolicy = Pick<ProjectPolicy, "checkLimitMinutes" | "silenceLimitMinutes" | "startupLimitMinutes" | "slotWaitLimitMinutes" | "checkSilence"> | null | undefined;

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function checkLimits(policy: LimitPolicy, command?: string): CheckLimits {
  const own = command === undefined ? undefined : policy?.checkSilence?.find((c) => c.command === command && positive(c.minutes));
  const limit = positive(policy?.checkLimitMinutes) ? policy!.checkLimitMinutes! : null;
  const silence = positive(policy?.silenceLimitMinutes) ? policy!.silenceLimitMinutes! : null;
  return {
    limitMinutes: limit ?? DEFAULT_CHECK_LIMIT_MINUTES,
    silenceMinutes: own ? own.minutes : silence ?? DEFAULT_SILENCE_LIMIT_MINUTES,
    startupMinutes: positive(policy?.startupLimitMinutes) ? policy!.startupLimitMinutes! : null,
    slotWaitMinutes: positive(policy?.slotWaitLimitMinutes) ? policy!.slotWaitLimitMinutes! : DEFAULT_SLOT_WAIT_MINUTES,
    limitFrom: limit ? "project" : "default",
    silenceFrom: own ? "check" : silence ? "project" : "default",
  };
}

// The limits in milliseconds, as a runner of processes takes them.
export const limitMs = (l: CheckLimits) => ({ ceilingMs: l.limitMinutes * 60_000, silenceMs: l.silenceMinutes * 60_000, slotWaitMs: l.slotWaitMinutes * 60_000, ...(l.startupMinutes ? { startupMs: l.startupMinutes * 60_000 } : {}) });

// The stop a runner of processes reported ({kind, ms}) in the limits' minutes.
export const stopOf = (stopped: { kind: CheckStop["kind"] } | null | undefined, l: CheckLimits): CheckStop | undefined => !stopped ? undefined
  : { kind: stopped.kind, minutes: stopped.kind === "silent" ? l.silenceMinutes : stopped.kind === "startup" ? (l.startupMinutes ?? 0) : stopped.kind === "slot" ? l.slotWaitMinutes : l.limitMinutes };

export const minutesText = (n: number): string => `${n} ${n === 1 ? "minute" : "minutes"}`;

// What a stopped run reports, in Atelier's words.
export function stopText(stop: CheckStop): string {
  return stop.kind === "silent" ? `silent for ${minutesText(stop.minutes)}`
    : stop.kind === "startup" ? `showed no work in ${minutesText(stop.minutes)}`
    : stop.kind === "slot" ? `waited ${minutesText(stop.minutes)} for a test slot`
    : `timed out after ${minutesText(stop.minutes)}`;
}

// The limit as `show` and `init` print it: one line, every number and where
// it came from.
export function limitText(policy: LimitPolicy): string {
  const l = checkLimits(policy);
  const own = (policy?.checkSilence ?? []).filter((c) => positive(c.minutes));
  return [
    `a run is stopped when silent for ${minutesText(l.silenceMinutes)} (no output, no process activity and no live child process)${l.silenceFrom === "default" ? ", the default" : ""}`,
    l.startupMinutes ? `when it showed no work in its first ${minutesText(l.startupMinutes)} (no output, no child process seen, no CPU time)` : "with no startup limit",
    `and at a hard ceiling of ${minutesText(l.limitMinutes)}${l.limitFrom === "default" ? ", the default" : ""}`,
    "all counted from when it holds its test slot",
    `a run that waits ${minutesText(l.slotWaitMinutes)} for its slot is stopped${positive(policy?.slotWaitLimitMinutes) ? "" : ", the default"}`,
    ...(own.length ? [`checks declaring their own silence: ${own.map((c) => `\`${c.command}\` ${minutesText(c.minutes)}`).join(", ")}`] : []),
  ].join("; ");
}

// One limit as an init sends it: minutes, or null, "" or 0 to return to the
// default. Anything else is refused, naming the flag.
export function limitArg(value: unknown, flag: string): number | null {
  if (value === null || value === "" || value === 0 || value === "0") return null;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  if (!positive(n) || n > LIMIT_MAX_MINUTES) {
    throw new RuleError("bad_check_limit", `${flag} takes minutes, more than 0 and at most ${LIMIT_MAX_MINUTES}, or "" for the default`, 400);
  }
  return n;
}

// The checks' own silence limits as an init sends them: a list of
// {command, minutes}, or "CMD=MINUTES" texts; null or [] clears them.
export function checkSilenceArg(value: unknown): CheckSilence[] {
  if (value === null || value === "") return [];
  if (!Array.isArray(value)) throw new RuleError("bad_check_silence", "checkSilence must be a list of {command, minutes}", 400);
  const out: CheckSilence[] = [];
  for (const entry of value) {
    let command: unknown, minutes: unknown;
    if (typeof entry === "string") {
      const at = entry.lastIndexOf("=");
      command = at > 0 ? entry.slice(0, at) : "";
      minutes = at > 0 ? entry.slice(at + 1) : "";
    } else if (entry && typeof entry === "object") ({ command, minutes } = entry as Record<string, unknown>);
    if (typeof command !== "string" || !command.trim()) throw new RuleError("bad_check_silence", "--check-silence takes CMD=MINUTES, the check's command and its own silence limit", 400);
    const n = limitArg(minutes, `--check-silence ${command.trim()}`);
    if (n === null) throw new RuleError("bad_check_silence", `--check-silence ${command.trim()} needs minutes`, 400);
    out.push({ command: command.trim(), minutes: n });
  }
  return out;
}

// The fact a stopped check's block carries (G7): the task waits on nothing
// but a rerun, so the model lifts it, recorded as a fact, with no words from
// the developer. A validation_blocked release whose reason starts with
// Atelier's own words for a stop is such a block.
export const TIMEOUT_FACT = "timeout" as const;
export const STOP_WORDS = /^(?:timed out\b|silent for \d+(?:\.\d+)? minutes?\b|showed no work in \d+(?:\.\d+)? minutes?\b|waited \d+(?:\.\d+)? minutes? for a test slot\b)/i;

// What stopped a run, as `atelier check` posts it with the evidence; anything
// but {kind: "timeout" | "silent", minutes} is refused.
export function stoppedArg(value: unknown): CheckStop {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || (v.kind !== "timeout" && v.kind !== "silent" && v.kind !== "startup" && v.kind !== "slot") || !positive(v.minutes) || (v.minutes as number) > LIMIT_MAX_MINUTES) {
    throw new RuleError("bad_stopped", "stopped must be {kind: \"timeout\", \"silent\", \"startup\" or \"slot\", minutes}", 400);
  }
  return { kind: v.kind, minutes: v.minutes as number };
}

// A stop with where its clock counted from: the slot for every limit but the
// wait for the slot itself.
export const stopLine = (stop: CheckStop): string => `${stopText(stop)}${stop.kind === "slot" ? "" : ", counted from its held test slot"}`;
