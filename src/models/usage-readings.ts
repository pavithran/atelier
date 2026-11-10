// What the tools' usage reports say about each model (t597, model slate B).
//
// A report is a runner's reading of one tool at one time. This module is
// pure: it takes reports, offers, readiness and pauses as arguments, and
// reads no ledger, no network and no clock (`now` is always passed in).
//
// readingsFor keeps the newest reading per tool and window and lets an old
// one lapse into "usage unknown". availabilityOf answers, for one model,
// project and job, whether the model is available now and, if not, why. It
// has no production caller yet: the slate builder and the consumers call it.
//
// Unknown usage never makes a model unavailable (PAVI's decision 1): it adds
// the flag "usage unknown" and every other check still applies.

import { claimants, offersFor, type Dispatch, type SeenOffer } from "../dispatch/rules.ts";
import type { ProviderPause } from "../runners/memory.ts";
import { isStaleProbe, type Readiness } from "../runners/readiness.ts";
import type { UsageReport, UsageWindow } from "../usage/report.ts";
import type { ProjectPolicy } from "../rules.ts";
import type { ModelEntry } from "./pool.ts";
import { eligibilityRefusal } from "./suggest.ts";

// A reading older than this says nothing about the tool now, unless it holds
// a limit that has not yet ended.
export const READING_TTL_MS = 26 * 3_600_000;
// A limit with no resetsAt is taken to last this long from its reading.
export const LIMIT_FALLBACK_MS = 5 * 3_600_000;
// A weekly window above this percent makes the model unavailable.
export const WEEKLY_MAX_PERCENT = 80;

export const UNKNOWN_USAGE = "usage unknown";

type Clock = number | Date;
const msOf = (now: Clock) => (now instanceof Date ? now.getTime() : now);

// One window's newest reading, with the instant it was read.
export interface Reading {
  name: string;
  usedPercent: number;
  resetsAt: string | null;
  at: string;              // the window's own at, or the report's arrival when it has none
  runner: string;          // the runner that reported it
  limitUntil: number | null; // ms: when the limit this reading holds ends; null when it holds none
}

// The readings in force for each tool, by window name. A tool with no entry
// has no usable reading: its usage is unknown.
export type Readings = Map<string, Map<string, Reading>>;

// A "limit" window, or a 5-hour window at 100%, is a limit in force until its
// resetsAt, or for LIMIT_FALLBACK_MS from its reading when it has none.
function limitUntil(w: UsageWindow, at: number): number | null {
  if (!(w.name === "limit" || (w.name === "5-hour" && w.usedPercent >= 100))) return null;
  const resets = w.resetsAt === null ? NaN : Date.parse(w.resetsAt);
  return Number.isFinite(resets) ? resets : at + LIMIT_FALLBACK_MS;
}

// The newest reading per tool and window by the window's own `at` (a null
// one counts as the report's arrival); on equal `at` the higher usedPercent.
// A reading older than READING_TTL_MS is dropped, unless it holds a limit
// still in force at `now`.
export function readingsFor(reports: readonly UsageReport[], now: Clock): Readings {
  const t = msOf(now);
  const newest = new Map<string, Map<string, Reading & { ms: number }>>();
  for (const r of reports) {
    for (const w of r.windows) {
      const at = w.at ?? r.at, ms = Date.parse(at);
      if (!Number.isFinite(ms)) continue;
      const byName = newest.get(r.tool) ?? new Map();
      newest.set(r.tool, byName);
      const held = byName.get(w.name);
      if (held && (held.ms > ms || (held.ms === ms && held.usedPercent >= w.usedPercent))) continue;
      byName.set(w.name, { name: w.name, usedPercent: w.usedPercent, resetsAt: w.resetsAt, at, runner: r.runner, limitUntil: limitUntil(w, ms), ms });
    }
  }
  const out: Readings = new Map();
  for (const [tool, byName] of newest) {
    const kept = new Map<string, Reading>();
    for (const [name, { ms, ...reading }] of byName) {
      if (t - ms <= READING_TTL_MS || (reading.limitUntil !== null && t < reading.limitUntil)) kept.set(name, reading);
    }
    if (kept.size) out.set(tool, kept);
  }
  return out;
}

// Whether a stored report stands against an incoming one from the same tool
// and runner (putUsage). The incoming report replaces it only when its newest
// window was read after the stored one's newest: an older report, or an equal
// one such as a retry after a timeout, leaves the stored row. A report with
// no windows has no reading to compare, so it replaces a stored row that has
// none or whose newest window is past READING_TTL_MS at the report's arrival.
export function keepsStored(stored: UsageReport, incoming: UsageReport): boolean {
  const newest = (r: UsageReport) => r.windows.reduce((m, w) => Math.max(m, Date.parse(w.at ?? r.at)), -Infinity);
  const held = newest(stored), added = newest(incoming);
  if (held === -Infinity) return false;
  if (added === -Infinity) return Date.parse(incoming.at) - held <= READING_TTL_MS;
  return added <= held;
}

// The tool whose usage a model draws on, or null when none reports for it.
// Every model of one tool shares its reading.
export function toolOf(entry: Pick<ModelEntry, "harness" | "family">): string | null {
  if (entry.family === "zai" && (entry.harness === "opencode" || entry.harness === "zcode")) return "zai";
  if (entry.harness === "codex" || entry.harness === "claude-code" || entry.harness === "antigravity") return entry.harness;
  return null;
}

export interface Availability {
  available: boolean;
  // Why not, or null when available. The eligibility refusal is
  // builderCandidates' own sentence (eligibilityRefusal); the others are "not-offered",
  // "signed-out", "stale-readiness", "provider-paused", "weekly-over-80"
  // and "limit-reached".
  reason: string | null;
  until: string | null;    // when the reason ends, if it says
  flags: string[];         // "usage unknown" when the tool's usage cannot be read
}

// What each runner last said about its harnesses, by runner name.
export type ReadinessByRunner = Readonly<Record<string, Readiness | null | undefined>>;

// The first failing check, in this order: eligibility; offered for the
// project and job; harness ready and not stale; no provider pause before its
// reset; weekly at most 80%; 5-hour not at its limit.
export function availabilityOf(
  entry: ModelEntry,
  ask: { project: string; job?: Dispatch["job"] | "build"; policy: ProjectPolicy; owner?: string },
  readings: Readings,
  offers: readonly SeenOffer[] | null,
  readiness: ReadinessByRunner,
  pauses: readonly ProviderPause[],
  now: Clock,
): Availability {
  const t = msOf(now);
  const tool = toolOf(entry);
  const have = tool === null ? undefined : readings.get(tool);
  const flags = have && have.size ? [] : [UNKNOWN_USAGE];
  const no = (reason: string, until: string | null = null): Availability => ({ available: false, reason, until, flags });

  const refused = eligibilityRefusal(entry, ask, undefined, new Date(t));
  if (refused) return no(refused);

  // Offered: the runners that would be handed this dispatch. With no live
  // runner nothing is restricted, as in builderCandidates.
  const job = ask.job && ask.job !== "build" ? ask.job : undefined;
  const runners = offers ? claimants({ to: entry.where, job, agent: entry.harness, model: entry.id }, offersFor(offers, ask.project), new Date(t)) : null;
  if (runners && !runners.length) return no("not-offered");

  // Ready: one runner that is ready is enough. When all are unready, the
  // newest report gives the reason. A runner with no report for the harness
  // gives no evidence against it.
  if (runners) {
    let worst: { probedAt: number; reason: string } | null = null;
    let ready = false;
    for (const runner of runners) {
      const h = readiness[runner]?.harnesses.find((x) => x.harness === entry.harness);
      if (!h) { ready = true; break; }
      const stale = isStaleProbe(h.probedAt, t);
      if (!stale && h.state !== "signed-out") { ready = true; break; }
      const probedAt = Date.parse(h.probedAt);
      if (!worst || probedAt > worst.probedAt) worst = { probedAt, reason: stale ? "stale-readiness" : "signed-out" };
    }
    if (!ready && worst) return no(worst.reason);
  }

  const paused = pauses.filter((p) => p.harness === entry.harness && Date.parse(p.resetAt) > t).sort((a, b) => Date.parse(b.resetAt) - Date.parse(a.resetAt))[0];
  if (paused) return no("provider-paused", paused.resetAt);

  const weekly = have?.get("weekly");
  if (weekly && weekly.usedPercent > WEEKLY_MAX_PERCENT && !(weekly.resetsAt !== null && Date.parse(weekly.resetsAt) <= t)) {
    return no("weekly-over-80", weekly.resetsAt);
  }

  // A limit in force: the one that ends last.
  const limits = [...(have?.values() ?? [])].filter((r) => r.limitUntil !== null && t < r.limitUntil);
  if (limits.length) return no("limit-reached", new Date(Math.max(...limits.map((r) => r.limitUntil!))).toISOString());

  return { available: true, reason: null, until: null, flags };
}
