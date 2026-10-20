// `atelier status --new`: the tasks someone else filed or edited since this
// caller last looked (t43). Read from the ledger's item.created and
// item.edited events, which carry the actor, never from an item's holder or
// updatedAt. The project route answers only the newest 50 events, so a read
// that does not reach back to the bookmark says it may be incomplete and
// keeps the bookmark; a source that cannot be read is "unread", never "none".
//
// The bookmark is the sequence number of the newest event of the last
// complete read, kept in a file on this Mac beside the CLI's config, per
// server, project and resolved actor. One response is one snapshot, so its
// highest sequence number is the upper bound of the read, fixed before any
// event is shown: an event filed meanwhile has a higher number and shows next
// time, whatever its clock said. Pure functions take their facts; only
// readBookmark and writeBookmark touch the disk.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// How many events the project route answers (src/index.ts, GET project).
export const EVENT_WINDOW = 50;
// The first run, and a bookmark ahead of the server's ledger, look back this far.
export const FIRST_RUN_MS = 24 * 60 * 60 * 1000;

export function bookmarkFile(env = process.env) {
  return join(env.ATELIER_CONFIG_DIR ?? join(homedir(), ".config", "atelier"), "new-since.json");
}

export const bookmarkKey = (server, project, actor) => JSON.stringify([String(server), project, actor]);

const validMark = (m) => m && typeof m === "object" && Number.isSafeInteger(m.seq) && m.seq >= 0 && typeof m.at === "string";

// { mark } (null on a first run) or { unreadable }, with the reason. A file
// that is missing is a first run; one that exists but does not parse, or holds
// a malformed entry for this key, is unreadable and is never overwritten.
export function readBookmark(key, file = bookmarkFile()) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if (e?.code === "ENOENT") return { mark: null };
    return { unreadable: `${file} cannot be read: ${e.message}` };
  }
  let all;
  try { all = JSON.parse(text); } catch { return { unreadable: `${file} is not valid JSON` }; }
  if (!all || typeof all !== "object" || Array.isArray(all) || !all.bookmarks || typeof all.bookmarks !== "object" || Array.isArray(all.bookmarks)) {
    return { unreadable: `${file} does not hold bookmarks` };
  }
  if (!Object.hasOwn(all.bookmarks, key)) return { mark: null };
  if (!validMark(all.bookmarks[key])) return { unreadable: `${file} holds a malformed bookmark for this server, project and actor` };
  return { mark: all.bookmarks[key] };
}

// Moves this key's bookmark to `mark`, keeping the others, through a temporary
// file so a reader never sees half of one. Returns null, or why it failed;
// nothing is thrown and the old file is left as it was.
export function writeBookmark(key, mark, file = bookmarkFile()) {
  const current = readBookmark(key, file);
  if (current.unreadable) return current.unreadable;
  try {
    let bookmarks = {};
    try { bookmarks = JSON.parse(readFileSync(file, "utf8")).bookmarks; } catch { /* a first run: none yet */ }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ bookmarks: { ...bookmarks, [key]: mark } }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
    return null;
  } catch (e) {
    return `${file} cannot be written: ${e.message}`;
  }
}

// --since takes an instant with a time and a zone: 2026-10-16T08:00Z or
// 2026-10-16T08:00:00+02:00. A date alone, a time with no zone and a span
// such as 3d are refused, since each names a different instant by machine.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// { ms } or { error }. `now` (ms) is fixed by the caller before it reads.
export function parseSince(text, now) {
  if (typeof text !== "string" || !INSTANT.test(text)) return { error: `--since needs an instant with a time and a zone, such as 2026-10-16T08:00Z or 2026-10-16T08:00:00+02:00; got ${typeof text === "string" ? text : "no value"}` };
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return { error: `--since ${text} is not a real date and time` };
  // Date.parse rolls 30 February over to March; the instant must read back as written.
  const day = text.slice(0, 10), shifted = new Date(ms + offsetMs(text)).toISOString().slice(0, 10);
  if (day !== shifted) return { error: `--since ${text} is not a real date and time` };
  if (ms > now) return { error: `--since ${text} is in the future` };
  return { ms };
}

function offsetMs(text) {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(text);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : 0;
}

const isEvent = (e) => e && typeof e === "object" && Number.isSafeInteger(e.seq) && typeof e.at === "string" && Number.isFinite(Date.parse(e.at)) && typeof e.actor === "string";

// What a read found. `events` is the project route's list, newest first;
// `items` its tasks; `as` the caller's resolved actor; `from` is either
// { seq } (a bookmark) or { ms } (a first run or --since). Returns
// { unread } when the list is not one this can trust, else
// { tasks, upper, complete, behind } where `upper` is the highest sequence
// number of the snapshot (null for no events), `complete` whether the
// snapshot reaches back to `from`, and `behind` that a bookmark was ahead of
// the ledger, so the caller fell back to the first-run window.
export function newSince({ events, items, as, from }) {
  if (!Array.isArray(events) || !events.every(isEvent)) return { unread: "the server's list of events is missing or not in the form this CLI reads" };
  if (!Array.isArray(items)) return { unread: "the server's list of tasks is missing" };
  const upper = events.reduce((n, e) => Math.max(n, e.seq), -1);
  const oldest = events.reduce((n, e) => Math.min(n, e.seq), Infinity);
  const behind = from.seq !== undefined && from.seq > upper;
  const full = events.length >= EVENT_WINDOW;
  const keep = (e) => (from.seq !== undefined && !behind ? e.seq > from.seq : Date.parse(e.at) >= from.ms);
  // A snapshot shorter than the window is the whole history. A full one
  // reaches back only if its oldest event is at or before the bookmark, or
  // strictly before the instant (an equal time may hide a tied event).
  const complete = !full || (from.seq !== undefined && !behind ? oldest <= from.seq : events.some((e) => Date.parse(e.at) < from.ms));
  const byTask = new Map();
  for (const e of events) {
    if ((e.kind !== "item.created" && e.kind !== "item.edited") || e.actor === as || !e.itemId || !keep(e)) continue;
    const seen = byTask.get(e.itemId);
    if (!seen || e.seq > seen.seq) byTask.set(e.itemId, e);
  }
  const title = new Map(items.map((i) => [i.id, i]));
  const tasks = [...byTask.values()].sort((a, b) => b.seq - a.seq).map((e) => ({
    id: e.itemId, title: title.get(e.itemId)?.title ?? null, state: title.get(e.itemId)?.state ?? null,
    kind: e.kind === "item.created" ? "filed" : "edited", actor: e.actor, at: e.at,
  }));
  return { tasks, upper: events.length ? upper : null, complete, behind };
}

const flat = (v) => String(v ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();

// The result as text. `how` says where the window began, in words; `brief`
// is one line, naming the tasks and who touched them.
export function formatNew({ result, project, as, how, brief = false }) {
  const head = `New in ${project} since ${how}, not by ${as}`;
  if (result.unread) return `${head}: unread. ${result.unread}. Nothing is known about what is new.`;
  const warn = result.complete ? [] : [`The list may be incomplete: the server answers only the newest ${EVENT_WINDOW} events and they do not reach back to ${how}. The bookmark is kept, so the next run shows these again; run it sooner.`];
  const none = result.complete ? "Nothing new." : "None found in what could be read.";
  if (brief) {
    const named = result.tasks.map((t) => `${t.id} (${t.kind} by ${flat(t.actor)})`).join(", ");
    return [`${head}: ${result.tasks.length ? named : none}`, ...warn].join("\n");
  }
  const lines = result.tasks.map((t) => `  ${t.id}  ${t.kind} by ${flat(t.actor)} at ${t.at}${t.state ? `  ${t.state}` : ""}  ${flat(t.title)}`);
  return [`${head}`, ...(lines.length ? lines : [`  ${none}`]), ...warn].join("\n");
}
