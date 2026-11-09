// The one-use request ids of the owner's page forms (t594). A form draws a new
// UUID each time the page is drawn; the Ledger call that acts on it writes the
// id and the first answer in the same synchronous call as the act itself, so
// the id is recorded if and only if the act was (the caller wraps both in one
// transaction). A replay of a used id then returns the first answer and acts
// not again, and an id used for another task or verb is refused.
//
// The store knows nothing of any one verb: Ledger.requestLand is its first
// caller. What a Land press decides, in the order it decides it (the replay of
// a used id, the shown revision, then the queue row and event the press
// writes), is here too (replayOf, assertShown, planLand); the Ledger only
// reads the rows, calls these and writes what they return.
import { RuleError } from "./rules.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };

export const REQUEST_ID_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isRequestId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

// What a form posted: a missing or malformed id is refused before anything is read or recorded.
export function assertRequestId(value: unknown): asserts value is string {
  if (!isRequestId(value)) throw new RuleError("bad_page_request", "this form carries no valid request id; reload the page and try again", 400, "reload the page so the form draws a new request id");
}

export function ensureRequestTable(sql: Sql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS page_requests (id TEXT PRIMARY KEY, item TEXT NOT NULL, verb TEXT NOT NULL, at TEXT NOT NULL, answer TEXT NOT NULL)`);
}

const cutoff = (now: string) => new Date(Date.parse(now) - REQUEST_ID_DAYS * 86_400_000).toISOString();

// The first answer to a used id, as it was kept, or null for an id not yet
// used. An id used for another task or verb is refused: it was one click's.
export function usedRequest(sql: Sql, id: string, item: string, verb: string, now: string): string | null {
  sql.exec(`DELETE FROM page_requests WHERE at < ?`, cutoff(now));
  const row = sql.exec(`SELECT item, verb, answer FROM page_requests WHERE id = ?`, id).toArray()[0];
  if (!row) return null;
  if (row.item !== item || row.verb !== verb) throw new RuleError("request_id_reused", `this request id was already used for another action (${row.verb} on ${row.item}); nothing was recorded`, 409, "reload the page so the form draws a new request id");
  return row.answer as string;
}

// Keeps the id with the answer the first use gave. Called in the Ledger call
// that acted, after the act, never alone.
export function keepRequest(sql: Sql, id: string, item: string, verb: string, answer: string, now: string): void {
  sql.exec(`DELETE FROM page_requests WHERE at < ?`, cutoff(now));
  sql.exec(`INSERT INTO page_requests (id, item, verb, at, answer) VALUES (?, ?, ?, ?, ?)`, id, item, verb, now, answer);
}

// What a page's Land showed: the head and criteria it was drawn from, and the
// one-use id of that click.
export interface ShownLand { head: string; criteria: string; requestId: string }

// The first answer of a used id, marked as a replay, or null for a new one. It
// is looked up before anything else is read, so a replay answers as the first
// press did even after the task's head or criteria moved on.
export function replayOf<T extends object>(sql: Sql, requestId: unknown, item: string, verb: string, now: string): (T & { replayed: true }) | null {
  assertRequestId(requestId);
  const first = usedRequest(sql, requestId, item, verb, now);
  return first ? { ...JSON.parse(first) as T, replayed: true } : null;
}

// A page drawn from a revision other than the task's is refused, nothing
// recorded: the head first, then the criteria.
export function assertShown(shown: ShownLand, item: string, head: string | null, criteria: string): void {
  if (shown.head !== head) throw new RuleError("stale_head", `${item} changed since this page was drawn (it showed ${shown.head.slice(0, 8)}, the task is at ${(head ?? "no head").slice(0, 8)}); reload it and land the revision it shows`, 409, `run atelier show ${item}, then land the new head`);
  if (shown.criteria !== criteria) throw new RuleError("stale_criteria", `${item}'s acceptance criteria changed since you opened this page; reload it and read them again`, 409, "reload the task page, read the criteria, then decide again");
}

export interface LandJobRow { by: string; at: string; quote: string | null; head: string | null }
export interface LandFailure { failedStep: string | null; attempt: number }
export interface LandPlan {
  // The queue row to write: a new one, a change to the row there, or none.
  write: "insert" | "update" | null;
  row: LandJobRow;
  // The failed landing's record is marked requeued.
  requeue: boolean;
  // The land.requested data, or null when nothing is recorded.
  event: Record<string, unknown> | null;
  answer: { item: string; by: string; at: string; quote?: string; queued: boolean; requeued?: { failedStep: string; attempt: number } };
}

// What a press of Land does with the queue: a landing that failed at this head
// is queued again by asking again; a job waiting at an older head is replaced
// by the newer; a job waiting at this head (or at any head, for a press that
// names none) keeps its place and records nothing; otherwise a row is added.
export function planLand(a: { id: string; by: string; at: string; said: string | null; head: string | null; existing: LandJobRow | null; stopped: LandFailure | null }): LandPlan {
  const { id, by, at, said, head, existing, stopped } = a;
  const headed = head ? { head } : {};
  const quoted = said ? { quote: said } : {};
  const fresh: LandJobRow = { by, at, quote: said, head };
  if (stopped) {
    return {
      write: existing ? "update" : "insert", requeue: true,
      row: existing ? { ...existing, at, head: head ?? existing.head } : fresh,
      event: { by, ...headed, requeued: true, failedStep: stopped.failedStep, attempt: stopped.attempt, ...quoted },
      answer: { item: id, by, at, ...quoted, queued: true, requeued: { failedStep: stopped.failedStep!, attempt: stopped.attempt } },
    };
  }
  if (existing && head && existing.head && existing.head !== head) {
    return { write: "update", requeue: false, row: { ...existing, by, at, head }, event: { by, head, replaces: existing.head, ...quoted }, answer: { item: id, by, at, ...quoted, queued: true } };
  }
  if (existing) {
    return { write: null, requeue: false, row: existing, event: null, answer: { item: id, by: existing.by, at: existing.at, ...(existing.quote ? { quote: existing.quote } : {}), queued: false } };
  }
  return { write: "insert", requeue: false, row: fresh, event: { by, ...headed, ...quoted }, answer: { item: id, by, at, ...quoted, queued: true } };
}
