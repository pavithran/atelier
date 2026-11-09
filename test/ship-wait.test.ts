import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatus } from "../cli/status.mjs";
import { buildToday, todayBody } from "../src/today.ts";
import { shipEventsOf } from "../src/ship-wait.ts";
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

const statusText = (events: ReturnType<typeof ev>[], now: Date) =>
  formatStatus([{ name: "demo", title: "Demo", items: [], inbox: [], shipEvents: shipEventsOf(events as never) }], { server: "https://a.test", now });
const today = (events: ReturnType<typeof ev>[], now: Date) => {
  const p = project();
  return buildToday({ owner: "owner", unread: [], projects: [{ now: { ...p, name: "demo" }, pulseEvents: events as never, ships: [], postMerge: {} }] }, now);
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
