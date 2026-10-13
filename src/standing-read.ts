// Where a project stands, read from its Ledger: the Overview and GET
// standing share it. Only the project record itself is needed: its tasks,
// notices, task records or last session failing to read are passed on as not
// read (null to attentionFor) and said in `partial`, so the owner calls
// already known still show and the doubt is labelled, never counted as
// nothing waiting.
import { attentionFor } from "./attention.ts";
import { buildStanding, standingTasks, STANDING_BRIEFS, type Detail, type Standing } from "./ui";
import type { LedgerEvent, ProjectRecord } from "./ledger";
import type { Item, InboxEntry } from "./rules";
import type { SessionNote } from "./sessions.ts";
import type { SeenOffer } from "./dispatch/rules";
import type { ModelEntry } from "./models/pool";

// The reads standingOf makes of one project's Ledger.
export interface StandingSource {
  project(): Promise<ProjectRecord>;
  items(): Promise<Item[]>;
  inbox(now: string, pool: readonly ModelEntry[] | null): Promise<InboxEntry[]>;
  events(id: string, limit: number): Promise<LedgerEvent[]>;
  detail(id: string): Promise<Detail>;
  sessions(limit: number): Promise<SessionNote[]>;
}

// `offers` and `pool` are null when they could not be read; `limit` is how
// many of each task's own events are read.
export async function readStanding(
  L: StandingSource, offers: readonly SeenOffer[] | null, pool: readonly ModelEntry[] | null, limit: number, now: Date,
): Promise<Standing> {
  const [project, items] = await Promise.all([L.project(), L.items().catch(() => null)]);
  const inbox = await L.inbox(now.toISOString(), pool).catch(() => null);
  const attention = attentionFor(project.name, items, inbox, offers, now);
  const taskEvents = new Map<string, LedgerEvent[]>();
  await Promise.all(standingTasks(items ?? []).map(async (id) => {
    try { taskEvents.set(id, await L.events(id, limit)); } catch { /* reported as not read */ }
  }));
  const ids = attention.owner.map((t) => t.id).slice(0, STANDING_BRIEFS);
  const details = new Map<string, Detail>();
  await Promise.all(ids.map(async (id) => {
    try { details.set(id, await L.detail(id)); } catch { /* the line keeps the inbox's own reason */ }
  }));
  const sessions = await L.sessions(1).catch(() => null);
  const standing = buildStanding(project, items ?? [], taskEvents, limit, attention, details, now);
  if (!sessions) standing.partial.push("The last session's note could not be read.");
  const unread = [...items ? [] : ["tasks" as const], ...inbox ? [] : ["notices" as const]];
  return { ...standing, session: sessions?.[0], ...unread.length ? { unread } : {} };
}
