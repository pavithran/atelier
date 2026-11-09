// The one-use request ids of the owner's page forms (t594). A form draws a new
// UUID each time the page is drawn; the Ledger call that acts on it writes the
// id and the first answer in the same synchronous call as the act itself, so
// the id is recorded if and only if the act was (the caller wraps both in one
// transaction). A replay of a used id then returns the first answer and acts
// not again, and an id used for another task or verb is refused.
//
// The store knows nothing of any one verb: Ledger.requestLand is its first
// caller.
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
