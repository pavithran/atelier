// A ship step that has the terminal may stop at a password prompt, such as
// sudo's, with nobody told (t593). Such a step posts its start with
// `terminal: true` and `givesUpAt`, the moment its timeout kills it; the
// Ledger records both on `action.started` (startActionRun, src/actions.ts).
// This file reads those events back for `atelier status` and Today.
//
// The event a pulse reads through `atelier events`:
//   kind  action.started
//   data  { ship, step, command, commit, terminal: true, givesUpAt, run, attempt }
//   (`run` is the command's index in the step, 0 for the first; `attempt` is
//   0 for the first try of it, 1 for its first retry.)
// The wait ends with the `action.ran` event for the same ship and step. Once
// givesUpAt has passed with none, the ship gave up, and that stands until a
// later ship of the project starts a step.
//
// readShipWait reads the project's newest terminal start straight from the
// event log, bounded by neither a count nor an age, so a wait or gave-up line
// outlasts any number of later events. Each attempt posts its own start, so
// the one shown is the highest (run, attempt) of the ship's latest terminal step.

import { EASTERN } from "./now.ts";

// The newest terminal start, and whether a run or a later ship ended it.
export interface ShipWaitRecord { ship: string; step: string; commit: string; attempt: number; since: string; givesUpAt: string | null; resolved: boolean }
export interface ShipWait { state: "waiting" | "gave-up"; ship: string; step: string; commit: string; attempt: number; since: string; givesUpAt: string | null }

const text = (v: unknown) => (typeof v === "string" ? v : "");

// "HH:MM" on the Eastern clock, as Today words its times.
export function waitClock(at: string): string {
  const ps = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  return `${ps.find((p) => p.type === "hour")?.value ?? ""}:${ps.find((p) => p.type === "minute")?.value ?? ""}`;
}

// The one read: the project's newest action.started with terminal true, found
// by event kind, and whether it is resolved: an action.ran for the same ship
// and step, or the start of any later ship.
export function readShipWait(sql: SqlStorage): ShipWaitRecord | null {
  const row = sql.exec(`SELECT seq, at, data FROM events WHERE kind = 'action.started' AND json_extract(data, '$.terminal') = 1 ORDER BY seq DESC LIMIT 1`).toArray()[0];
  if (!row) return null;
  const d = JSON.parse(row.data as string) as Record<string, unknown>;
  const ship = text(d.ship), step = text(d.step);
  // A step's commands each count attempts from 0: the highest run, then the
  // highest attempt, is the one waiting, whichever was posted last.
  const top = sql.exec(
    `SELECT seq, at, data FROM events WHERE kind = 'action.started' AND json_extract(data, '$.terminal') = 1 AND json_extract(data, '$.ship') = ? AND json_extract(data, '$.step') = ?
     ORDER BY COALESCE(json_extract(data, '$.run'), 0) DESC, COALESCE(json_extract(data, '$.attempt'), 0) DESC, seq DESC LIMIT 1`,
    ship, step,
  ).toArray()[0] ?? row;
  const t = JSON.parse(top.data as string) as Record<string, unknown>;
  const ended = sql.exec(
    `SELECT 1 FROM events WHERE seq > ? AND ((kind = 'action.ran' AND json_extract(data, '$.ship') = ? AND json_extract(data, '$.step') = ?) OR (kind = 'action.started' AND json_extract(data, '$.ship') != ?)) LIMIT 1`,
    row.seq as number, ship, step, ship,
  ).toArray().length > 0;
  const givesUpAt = typeof t.givesUpAt === "string" && Number.isFinite(Date.parse(t.givesUpAt)) ? t.givesUpAt : null;
  return { ship, step, commit: text(t.commit), attempt: typeof t.attempt === "number" ? t.attempt : 0, since: top.at as string, givesUpAt, resolved: ended };
}

// The wait at `now`; none once resolved.
export function shipWaitOf(r: ShipWaitRecord | null | undefined, now: Date): ShipWait | null {
  if (!r || r.resolved) return null;
  const over = r.givesUpAt !== null && Date.parse(r.givesUpAt) <= now.getTime();
  return { state: over ? "gave-up" : "waiting", ship: r.ship, step: r.step, commit: r.commit, attempt: r.attempt, since: r.since, givesUpAt: r.givesUpAt };
}

// The line status and Today say.
export function shipWaitLine(w: ShipWait): string {
  const sha = w.commit.slice(0, 8);
  if (w.state === "gave-up") return `ship of ${sha} gave up waiting at ${waitClock(w.givesUpAt!)}`;
  return `ship of ${sha} waits on the developer's password since ${waitClock(w.since)}${w.givesUpAt ? `, gives up at ${waitClock(w.givesUpAt)}` : ""}`;
}

export const shipWaitLines = (r: ShipWaitRecord | null | undefined, now: Date): string[] => {
  const w = shipWaitOf(r, now);
  return w ? [shipWaitLine(w)] : [];
};
