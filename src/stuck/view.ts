// The open stuck episodes as the owner's surfaces (status, unwrap, inbox)
// list them: one row per open episode, oldest first, with its cause, the
// evidence, when it was first seen and the next step. Pure: the caller reads
// the stuck report, the recorded transitions and the project's tasks.
import { causeOf, keyOf, type Transition } from "./episodes.ts";
import type { Entry } from "./report.ts";

export const UNKNOWN = "unknown";
export interface OpenStuck { item: string; cause: string; reason: string; firstSeen: string; since: string; evidence: string; next: string }
export interface StuckView { rows: OpenStuck[]; notRead: string[] }

// `report` is the stuck report (null when not read); `transitions` the
// recorded episode transitions of the project (null when not read); `items`
// the project's tasks (null when not read). A row needs the report: without
// it the open episodes are still listed, with evidence and next step unknown.
// A report that says it is incomplete keeps the recorded open episodes it has
// no entry for, with evidence and next step unknown, and names each
// unavailable source in notRead. A task that is merged or abandoned has no row.
export function openStuck(project: string, report: { entries: readonly Entry[]; complete?: boolean; unavailable?: readonly string[] } | null, transitions: readonly Transition[] | null, items: readonly { id: string; state: string }[] | null): StuckView {
  const notRead: string[] = [];
  if (!report) notRead.push("stuck report");
  if (!transitions) notRead.push("stuck episodes");
  if (!items) notRead.push("tasks");
  const opened = new Map<string, Transition>();
  const open = new Map<string, Transition>();
  for (const t of transitions ?? []) {
    if (t.project !== project) continue;
    if (t.kind === "opened") { opened.set(keyOf(t), t); open.set(keyOf(t), t); } else open.delete(keyOf(t));
  }
  const closed = new Set((items ?? []).filter((i) => ["merged", "abandoned"].includes(i.state)).map((i) => i.id));
  const rows = new Map<string, OpenStuck>();
  for (const e of report?.entries ?? []) {
    const key = { project, item: e.subject, cause: causeOf(e) };
    const episode = opened.get(keyOf(key));
    rows.set(keyOf(key), { item: e.subject, cause: key.cause, reason: e.reason, firstSeen: episode && open.has(keyOf(key)) ? episode.at : UNKNOWN, since: e.since, evidence: e.evidence || UNKNOWN, next: e.recovery || UNKNOWN });
  }
  // With no report, or an incomplete one, the recorded open episodes stand in.
  const partial = !report || report.complete === false || (report.unavailable?.length ?? 0) > 0;
  for (const u of report?.unavailable ?? []) notRead.push(`stuck diagnostics (${u})`);
  if (report && partial && !report.unavailable?.length) notRead.push("stuck diagnostics (incomplete report)");
  if (partial) for (const [k, t] of open) if (!rows.has(k)) rows.set(k, { item: t.item, cause: t.cause, reason: t.reason, firstSeen: t.at, since: UNKNOWN, evidence: UNKNOWN, next: UNKNOWN });
  const sorted = [...rows.values()].filter((r) => !closed.has(r.item)).sort((a, b) => (a.firstSeen === UNKNOWN ? a.since : a.firstSeen).localeCompare(b.firstSeen === UNKNOWN ? b.since : b.firstSeen) || a.item.localeCompare(b.item) || a.cause.localeCompare(b.cause));
  return { rows: sorted, notRead };
}
