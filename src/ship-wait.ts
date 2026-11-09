// A ship step that has the terminal may stop at a password prompt, such as
// sudo's, with nobody told (t593). Such a step posts its start with
// `terminal: true` and `givesUpAt`, the moment its timeout kills it; the
// Ledger records both on `action.started` (startActionRun, src/actions.ts).
// This file reads those events back for `atelier status` and Today.
//
// The event a pulse reads through `atelier events`:
//   kind  action.started
//   data  { ship, step, command, commit, terminal: true, givesUpAt }
// The wait ends with the `action.ran` event for the same ship and step. Once
// givesUpAt has passed with none, the ship gave up, and that stands until a
// later ship of the project starts a step.

import { EASTERN } from "./now.ts";

export interface WaitEvent { seq?: number; kind: string; at: string; data?: Record<string, unknown> }
export interface ShipWait { state: "waiting" | "gave-up"; ship: string; step: string; commit: string; since: string; givesUpAt: string | null }

const text = (v: unknown) => (typeof v === "string" ? v : "");

// "HH:MM" on the Eastern clock, as Today words its times.
export function waitClock(at: string): string {
  const ps = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  return `${ps.find((p) => p.type === "hour")?.value ?? ""}:${ps.find((p) => p.type === "minute")?.value ?? ""}`;
}

// The waits among a project's events at `now`. Only the ship that started a
// step last can be waiting or have given up: ships take turns on the checkout,
// so a later ship's start ends every earlier one's story.
export function shipWaits(events: readonly WaitEvent[], now: Date): ShipWait[] {
  const ordered = events.filter((e) => e.kind === "action.started" || e.kind === "action.ran")
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || Date.parse(a.at) - Date.parse(b.at));
  const last = ordered.filter((e) => e.kind === "action.started").at(-1);
  if (!last) return [];
  const ship = text(last.data?.ship);
  const ended = new Set(ordered.filter((e) => e.kind === "action.ran" && text(e.data?.ship) === ship).map((e) => text(e.data?.step)));
  const seen = new Set<string>();
  const waits: ShipWait[] = [];
  for (const e of ordered) {
    if (e.kind !== "action.started" || e.data?.terminal !== true || text(e.data.ship) !== ship) continue;
    const step = text(e.data.step);
    // The step may have run again after a retry; the latest start stands.
    if (ended.has(step) || seen.has(step)) continue;
    seen.add(step);
    const givesUpAt = typeof e.data.givesUpAt === "string" && Number.isFinite(Date.parse(e.data.givesUpAt)) ? e.data.givesUpAt : null;
    const over = givesUpAt !== null && Date.parse(givesUpAt) <= now.getTime();
    waits.push({ state: over ? "gave-up" : "waiting", ship, step, commit: text(e.data.commit), since: e.at, givesUpAt });
  }
  return waits;
}

// The line status and Today say.
export function shipWaitLine(w: ShipWait): string {
  const sha = w.commit.slice(0, 8);
  if (w.state === "gave-up") return `ship of ${sha} gave up waiting at ${waitClock(w.givesUpAt!)}`;
  return `ship of ${sha} waits on the developer's password since ${waitClock(w.since)}${w.givesUpAt ? `, gives up at ${waitClock(w.givesUpAt)}` : ""}`;
}

export const shipWaitLines = (events: readonly WaitEvent[] | undefined | null, now: Date): string[] => shipWaits(events ?? [], now).map(shipWaitLine);

// Only the events the waits read, kept on a status view.
export const shipEventsOf = (events: readonly WaitEvent[] | undefined | null): WaitEvent[] =>
  (events ?? []).filter((e) => e.kind === "action.started" || e.kind === "action.ran");
