import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../src/ledger.ts";
import { buildStory } from "../src/graph.ts";
import { buildRecord } from "../src/models/record.ts";
import { buildReliability } from "../src/models/reliability.ts";
import { cleanServed, matchServed, SERVED, servedActor, servedBy, withServed, type ServedSelection } from "../src/models/served.ts";

// t95: zcode served deepseek-flash while its events named glm-5.3. The owner
// annotates each such event with the model that served it; the event never
// changes, and the records and the graph count it under the served model.

const OWNER = "pavi";
const ZCODE = "zcode/glm-5.3", SERVED_AS = "zcode/deepseek-flash", OPUS = "claude-code/opus-5.5";
const [H1, H2] = ["1", "2"].map((c) => c.repeat(40));

function history(...rows: [string | null, string, string, Record<string, unknown>?][]): LedgerEvent[] {
  return rows.map(([itemId, actor, kind, data = {}], i) => ({ seq: i + 1, itemId, actor, kind, data, at: new Date(Date.UTC(2026, 9, 4, 16, i)).toISOString() }));
}
const note = (seq: number, served: string, itemId: string | null = "t1"): [string | null, string, string, Record<string, unknown>] =>
  [itemId, OWNER, SERVED, { seq, recorded: ZCODE, served }];

test("the latest annotation of an event names its served model, in the recorded harness; the annotations are not work", () => {
  const events = history(
    ["t1", ZCODE, "item.claimed"],
    ["t1", ZCODE, "push.observed", { head: H1 }],
    note(1, "deepseek-flash"),
    note(2, "glm-5.3"),
    note(2, "deepseek-flash"),
    ["t1", OWNER, SERVED, { seq: 1 }],
  );
  const served = servedBy(events.toReversed());
  assert.deepEqual([...served], [[1, "deepseek-flash"], [2, "deepseek-flash"]]);
  assert.equal(servedActor(events[0], served), SERVED_AS);
  assert.equal(servedActor(events[2], served), OWNER);
  const counted = withServed(events);
  assert.deepEqual(counted.map((e) => [e.seq, e.actor]), [[1, SERVED_AS], [2, SERVED_AS]]);
  // The events themselves are not changed.
  assert.equal(events[0].actor, ZCODE);
});

test("the track record counts an annotated event under the served model, and the holder's outcomes under the model that served its latest action", () => {
  const events = history(
    ["t1", ZCODE, "item.claimed"],                                         // 1, annotated
    ["t1", "atelier/sandbox", "evidence.observed", { passed: true }],      // 2
    ["t1", ZCODE, "push.observed", { head: H2 }],                         // 3, not annotated: GLM served it
    ["t1", "atelier/sandbox", "evidence.observed", { passed: false }],     // 4
    ["t1", ZCODE, "push.observed", { head: H2 }],                         // 5, annotated
    ["t1", OWNER, "item.handoff", { from: ZCODE, to: OPUS }],             // 6
    ["t2", OPUS, "item.claimed"],                                          // 7
    ["t2", ZCODE, "review.rejected", { head: H1, note: "no" }],           // 8, annotated: a review counts for the holder, opus
    note(1, "deepseek-flash"), note(5, "deepseek-flash"), note(8, "deepseek-flash", "t2"),
  );
  const record = buildRecord(events);
  assert.deepEqual(record.get(SERVED_AS), { itemsClaimed: 1, checkPasses: 1, checkFailures: 0, reviewsApproved: 0, reviewsRejected: 0, handoffsAway: 1, merges: 0 });
  assert.deepEqual(record.get(ZCODE), { itemsClaimed: 0, checkPasses: 0, checkFailures: 1, reviewsApproved: 0, reviewsRejected: 0, handoffsAway: 0, merges: 0 });
  assert.equal(record.get(OPUS)!.reviewsRejected, 1);
  // Without the annotations, everything is glm-5.3's, as it was recorded.
  const plain = buildRecord(events.filter((e) => e.kind !== SERVED));
  assert.equal(plain.has(SERVED_AS), false);
  assert.deepEqual(plain.get(ZCODE), { itemsClaimed: 1, checkPasses: 1, checkFailures: 1, reviewsApproved: 0, reviewsRejected: 0, handoffsAway: 1, merges: 0 });
});

test("the reliability record counts annotated work and annotated verdicts under the served model", () => {
  const events = history(
    ["t1", ZCODE, "item.claimed"],
    ["t1", ZCODE, "item.submitted", { head: H1 }],
    ["t1", OPUS, "review.approved", { head: H1 }],
    ["t1", OWNER, "item.merged", { head: H1 }],
    ["t2", OPUS, "item.claimed"],
    ["t2", OPUS, "item.submitted", { head: H2 }],
    ["t2", ZCODE, "review.rejected", { head: H2, note: "missing a test" }],
    note(1, "deepseek-flash"), note(2, "deepseek-flash"), note(7, "deepseek-flash", "t2"),
  );
  const rel = buildReliability([{ project: "atelier", events }], [], OWNER);
  const flash = rel.get("deepseek-flash")!;
  assert.deepEqual([flash.firstReviews, flash.approvedFirst, flash.merged, flash.rejectionsGiven], [1, 1, 1, 1]);
  assert.deepEqual(flash.actors, [SERVED_AS]);
  assert.equal(flash.family, "deepseek");
  assert.equal(rel.has("glm-5.3"), false);
  assert.deepEqual(rel.get("opus-5.5")!.rejections.map((c) => c.by), [SERVED_AS]);
});

test("the graph draws and counts an annotated event under the served model, and draws no annotation", () => {
  const events = history(
    ["t1", ZCODE, "item.claimed"],
    ["t1", ZCODE, "push.observed", { head: H1 }],
    note(1, "deepseek-flash"), note(2, "deepseek-flash"),
  );
  const items = [{ id: "t1", title: "Task", state: "claimed" }] as never;
  const story = buildStory("atelier", items, events, OWNER);
  assert.deepEqual(story.tally.agents, [SERVED_AS]);
  assert.deepEqual(story.tally.byVendor, { deepseek: 2 });
  assert.deepEqual(story.threads[0].holds.map((h) => h.who), [SERVED_AS]);
  assert.equal(story.span, 1);
  assert.equal(story.tally.decisions, 0);
});

const sel = (change: Partial<ServedSelection> = {}): ServedSelection => ({
  served: "deepseek-flash", recorded: ZCODE, from: "2026-10-04T16:01:00.000Z", to: "2026-10-04T16:04:00.000Z", items: null, note: "", ...change,
});

test("a selection matches the recorded actor in any letter case, from its start up to its end, on the tasks it names; an annotated one is not annotated again", () => {
  const events = history(
    ["t1", ZCODE, "item.claimed"],                    // 16:00, before the window
    ["t1", "zcode/GLM-5.3", "push.observed"],        // 16:01, at its start
    ["t2", ZCODE, "item.claimed"],                    // 16:02, another task
    ["t1", OPUS, "review.approved"],                  // 16:03, another actor
    ["t1", ZCODE, "item.submitted"],                  // 16:04, at its end, outside
    note(3, "deepseek-flash", "t2"),                  // 16:05, an annotation
  );
  const all = matchServed(events, sel());
  assert.deepEqual(all.matched.map((m) => [m.seq, m.itemId, m.served]), [[2, "t1", null], [3, "t2", "deepseek-flash"]]);
  assert.deepEqual(all.pending.map((m) => m.seq), [2]);
  assert.deepEqual(matchServed(events, sel({ items: ["t1"] })).matched.map((m) => m.seq), [2]);
  // An annotation that names another model is replaced by a new one.
  assert.deepEqual(matchServed(events, sel({ served: "glm-5.3" })).pending.map((m) => m.seq), [2, 3]);
  assert.deepEqual(matchServed(events, sel({ recorded: "codex/glm-5.3" })).matched, []);
});

test("a selection names the served model, the recorded harness/model and both ends of the window", () => {
  const body = { served: "deepseek-flash", recorded: ZCODE, from: "2026-10-04T16:00Z", to: "2026-10-05T20:17Z", items: ["t2", "t11", "t2"], note: "per\nmodel_usage", apply: true };
  assert.deepEqual(cleanServed(body), {
    served: "deepseek-flash", recorded: ZCODE, from: "2026-10-04T16:00:00.000Z", to: "2026-10-05T20:17:00.000Z", items: ["t2", "t11"], note: "per model_usage", apply: true,
  });
  assert.equal(cleanServed({ ...body, apply: undefined, items: undefined }).items, null);
  assert.equal(cleanServed({ ...body, apply: undefined }).apply, false);
  for (const [change, why] of [
    [{ served: "deepseek flash" }, /served must be/],
    [{ recorded: "glm-5.3" }, /recorded must be the harness\/model/],
    [{ recorded: "atelier/events" }, /recorded must be/],
    [{ from: "yesterday" }, /from must be a time/],
    [{ to: undefined }, /to must be a time/],
    [{ from: "2026-10-06T00:00Z" }, /from must come before to/],
    [{ items: [] }, /items must list task ids/],
    [{ items: ["2"] }, /items must list task ids/],
    [{ apply: "yes" }, /apply must be true or false/],
  ] as const) assert.throws(() => cleanServed({ ...body, ...change }), why);
});
