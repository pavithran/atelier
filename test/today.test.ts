import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { buildToday, renderToday, todayInputsOf, type TodayInputs, type TodayLedger, type TodaySource } from "../src/today.ts";
import { NOW, h, project } from "./fixtures/now.ts";

// buildToday is pure and todayInputsOf reads each ledger once (t562). Neither
// test here reaches a ledger binding: the route tests (today-routes.spec.ts,
// today-deploys.spec.ts) prove the same through worker.fetch.

const inputs = (): TodayInputs => {
  const p = project();
  return { owner: "owner", unread: [], projects: [{ now: p, pulseEvents: p.events as never, ships: [], postMerge: {} }] };
};

test("buildToday and renderToday are exported, Today's CSS is in src/today.css, and one input gives equal output twice with no ledger binding", () => {
  assert.equal(typeof buildToday, "function");
  assert.equal(typeof renderToday, "function");
  assert.ok(existsSync(new URL("../src/today.css", import.meta.url)));
  const input = inputs();
  const before = structuredClone(input);
  const a = buildToday(input, NOW), b = buildToday(input, NOW);
  assert.deepEqual(a, b);
  assert.deepEqual(input, before);
  assert.equal(renderToday(a, "PAVI"), renderToday(b, "PAVI"));
  assert.equal(a.tiles.need.value, 2);
  assert.equal((globalThis as Record<string, unknown>).LEDGER, undefined);
});

// A ledger holding events at the given ages, newest first as the real one answers.
const event = (seq: number, age: number, kind = "item.created") => ({ seq, kind, itemId: `t${seq}`, at: new Date(NOW.getTime() - age).toISOString(), actor: "owner", data: {} });
const H_ = 3_600_000, D = 24 * H_;
function source(events: ReturnType<typeof event>[]) {
  const asked: { id?: string; limit?: number; before?: number }[] = [];
  const ledger: TodayLedger = {
    ownerRead: async () => ({ items: [], inbox: null }),
    events: async (id, limit, before) => {
      asked.push({ id, limit, before });
      return events.filter((e) => before === undefined || e.seq < before).sort((a, b) => b.seq - a.seq).slice(0, limit ?? 200) as never;
    },
    situationFacts: async () => ({ items: [], stages: {}, reviewRequests: [], landings: {}, progress: {} }) as never,
    postMergeRun: async () => null,
  };
  const src: TodaySource = { projects: [{ name: "p", title: "P", ledger }], pool: null, offers: null, owner: "owner" };
  return { src, asked };
}

test("todayInputsOf: events 47 h, 49 h, 13 d and 15 d old; only the first reaches buildNow's slice, the first three buildPulse's, the last neither", async () => {
  const { src, asked } = source([event(1, 15 * D), event(2, 13 * D), event(3, 49 * H_), event(4, 47 * H_)]);
  const got = await todayInputsOf(src, NOW);
  assert.equal(got.projects.length, 1);
  assert.deepEqual(got.projects[0].now.events.map((e) => e.seq), [4]);
  assert.deepEqual(got.projects[0].pulseEvents.map((e) => e.seq).sort(), [2, 3, 4]);
  // The ledger's event pages were asked for once each.
  const wide = asked.filter((a) => a.id === undefined);
  assert.equal(new Set(wide.map((a) => a.before)).size, wide.length);
});

test("todayInputsOf: a busy ledger is paged once, each page asked for once, and no event is lost or repeated", async () => {
  const many = Array.from({ length: 1200 }, (_, i) => event(i + 1, (1200 - i) * 600_000)); // ten minutes apart: the oldest 8.3 days old
  const { src, asked } = source(many);
  const got = await todayInputsOf(src, NOW);
  assert.equal(got.projects[0].pulseEvents.length, 1200);
  assert.equal(new Set(got.projects[0].pulseEvents.map((e) => e.seq)).size, 1200);
  const wide = asked.filter((a) => a.id === undefined);
  assert.equal(wide.length, 3);
  assert.equal(new Set(wide.map((a) => a.before)).size, 3);
});

test("todayInputsOf names a project whose ledger throws and reads the rest", async () => {
  const { src } = source([event(1, H_)]);
  const bad: TodaySource["projects"][number] = { name: "broken", title: "Broken", ledger: { ...src.projects[0].ledger, ownerRead: async () => { throw new Error("gone"); } } };
  const got = await todayInputsOf({ ...src, projects: [bad, src.projects[0]] }, NOW);
  assert.deepEqual(got.unread, ["broken"]);
  assert.deepEqual(got.projects.map((p) => p.now.name), ["p"]);
});
void h;
