import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatus } from "../cli/status.mjs";
import { buildToday, todayBody } from "../src/today.ts";
import { DatabaseSync } from "node:sqlite";
import { readShipWait } from "../src/ship-wait.ts";
import { NOW, project } from "./fixtures/now.ts";

// t593, criteria 2, 3 and 7: `atelier status` and Today say a ship waits on
// the developer's password while its terminal start has no action.ran, and
// that it gave up once givesUpAt has passed, until a later ship starts. The
// clock is fixed: the start is at 05:16 UTC (00:16 EST) on 2026-11-09 and the
// step gives up at 05:36 UTC (00:36 EST).

const H1 = "763e3ca9".padEnd(40, "0"), H2 = "b".repeat(40);
const at = (hhmm: string) => new Date(`2026-11-09T${hhmm}:00.000Z`);
const ev = (seq: number, kind: string, time: string, data: Record<string, unknown>) => ({ seq, kind, itemId: null, actor: "owner", at: at(time).toISOString(), data });
const start = (seq: number, time: string, over: Record<string, unknown> = {}) => ev(seq, "action.started", time, { ship: "s-1", step: "deploy", command: "deploy", commit: H1, terminal: true, givesUpAt: at("05:36").toISOString(), ...over });
const ran = (seq: number, time: string, over: Record<string, unknown> = {}) => ev(seq, "action.ran", time, { ship: "s-1", step: "deploy", command: "deploy", commit: H1, passed: true, ...over });

// The Ledger's events table in SQLite, read by the same readShipWait the Ledger calls.
const wait = (events: ReturnType<typeof ev>[]) => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)");
  const put = db.prepare("INSERT INTO events (seq, at, actor, kind, data) VALUES (?, ?, 'owner', ?, ?)");
  for (const e of events) put.run(e.seq, e.at, e.kind, JSON.stringify(e.data));
  const sql = { exec: (q: string, ...b: never[]) => ({ toArray: () => db.prepare(q).all(...b) }) };
  return readShipWait(sql as never);
};
const statusText = (events: ReturnType<typeof ev>[], now: Date) =>
  formatStatus([{ name: "demo", title: "Demo", items: [], inbox: [], shipWait: wait(events) }], { server: "https://a.test", now });
const today = (events: ReturnType<typeof ev>[], now: Date) => {
  const p = project();
  return buildToday({ owner: "owner", unread: [], projects: [{ now: { ...p, name: "demo" }, pulseEvents: [], shipWait: wait(events), ships: [], postMerge: {} }] }, now);
};

const WAITS = "ship of 763e3ca9 waits on the developer's password since 00:16, gives up at 00:36";
const GAVE_UP = "ship of 763e3ca9 gave up waiting at 00:36";

test("status says the ship waits on the password while the terminal start has no run, and stops once one is recorded", () => {
  assert.match(statusText([start(1, "05:16")], at("05:20")), new RegExp(WAITS));
  assert.doesNotMatch(statusText([start(1, "05:16"), ran(2, "05:30")], at("05:31")), /waits on the developer's password|gave up waiting/);
});

test("Today says the same, in its own alert, and stops once a run is recorded", () => {
  const waiting = today([start(1, "05:16")], at("05:20"));
  assert.deepEqual(waiting.shipWaits, [`demo: ${WAITS}`]);
  assert.match(todayBody(waiting), /data-ship-wait>demo: ship of 763e3ca9 waits on the developer&#39;s password|data-ship-wait>demo: ship of 763e3ca9 waits on the developer's password/);
  assert.deepEqual(today([start(1, "05:16"), ran(2, "05:30")], at("05:31")).shipWaits, []);
});

test("past givesUpAt with no run, both say the ship gave up, until a later ship of the project starts", () => {
  const events = [start(1, "05:16")];
  assert.match(statusText(events, at("05:37")), new RegExp(GAVE_UP));
  assert.doesNotMatch(statusText(events, at("05:37")), /waits on the developer's password/);
  assert.deepEqual(today(events, at("05:37")).shipWaits, [`demo: ${GAVE_UP}`]);
  const later = [...events, start(3, "06:00", { ship: "s-2", commit: H2, terminal: undefined, givesUpAt: undefined })];
  assert.doesNotMatch(statusText(later, at("06:01")), /gave up waiting/);
  assert.deepEqual(today(later, at("06:01")).shipWaits, []);
});

test("a recorded start with no run, past its givesUpAt, is the gave-up line (the crash after the post and before the step)", () => {
  assert.deepEqual(today([start(1, "05:16")], at("09:00")).shipWaits, [`demo: ${GAVE_UP}`]);
});

test("a start without terminal, from an older CLI, shows no wait", () => {
  const plain = start(1, "05:16", { terminal: undefined, givesUpAt: undefined });
  assert.doesNotMatch(statusText([plain], at("05:20")), /password|gave up waiting/);
  assert.deepEqual(today([plain], at("05:20")).shipWaits, []);
});

const other = (seq: number, time: string) => ev(seq, "item.created", time, { id: `t${seq}` });

test("the line still shows after 60 later unrelated events, and with the clock 15 days on", () => {
  const events = [start(1, "05:16"), ...Array.from({ length: 60 }, (_, i) => other(i + 2, "05:17"))];
  assert.match(statusText(events, at("05:20")), new RegExp(WAITS));
  assert.deepEqual(today(events, at("05:20")).shipWaits, [`demo: ${WAITS}`]);
  const days15 = new Date(at("05:37").getTime() + 15 * 24 * 3600 * 1000);
  assert.match(statusText(events, days15), new RegExp(GAVE_UP));
  assert.deepEqual(today(events, days15).shipWaits, [`demo: ${GAVE_UP}`]);
});

test("during a retry the newest attempt's wait and deadline are shown, not the first attempt's gave-up", () => {
  const retry = start(2, "05:40", { attempt: 1, givesUpAt: at("06:00").toISOString() });
  const events = [start(1, "05:16", { attempt: 0 }), retry];
  const line = "ship of 763e3ca9 waits on the developer's password since 00:40, gives up at 01:00";
  assert.match(statusText(events, at("05:45")), new RegExp(line));
  assert.deepEqual(today(events, at("05:45")).shipWaits, [`demo: ${line}`]);
  assert.doesNotMatch(statusText(events, at("05:45")), /gave up waiting/);
});
