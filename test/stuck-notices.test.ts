import { test } from "node:test";
import assert from "node:assert/strict";
import { dueNotices, noticeKey, NOTICE_AFTER_MS } from "../src/stuck/notices.ts";
import { stuckBatchRequests } from "../src/notify.ts";
import type { Transition } from "../src/stuck/episodes.ts";

const T0 = Date.parse("2026-10-23T00:00:00Z");
const t = (kind: "opened" | "cleared", episode: number, ms: number, item = "t1"): Transition => ({ project: "k", item, cause: "task:x", kind, episode, at: new Date(T0 + ms).toISOString(), reason: "no push" });

test("an episode is due at 60 minutes, not before", () => {
  const log = [t("opened", 1, 0)];
  assert.equal(dueNotices(log, new Set(), T0 + NOTICE_AFTER_MS - 1).length, 0);
  assert.equal(dueNotices(log, new Set(), T0 + NOTICE_AFTER_MS).length, 1);
});

test("a batch holds every due episode, and a recorded one is not due again", () => {
  const log = [t("opened", 1, 0, "a"), t("opened", 1, 0, "b")];
  const due = dueNotices(log, new Set(), T0 + NOTICE_AFTER_MS);
  assert.deepEqual(due.map((d) => d.item), ["a", "b"]);
  assert.equal(dueNotices(log, new Set([noticeKey(due[0])]), T0 + NOTICE_AFTER_MS).length, 1);
});

test("a failed send records nothing, so the episode is due on the next tick", () => {
  const log = [t("opened", 1, 0)];
  assert.equal(dueNotices(log, new Set(), T0 + NOTICE_AFTER_MS).length, 1);
  assert.equal(dueNotices(log, new Set(), T0 + NOTICE_AFTER_MS + 600_000).length, 1);
});

test("a cleared episode is not due", () => {
  assert.equal(dueNotices([t("opened", 1, 0), t("cleared", 1, 30 * 60_000)], new Set(), T0 + 2 * NOTICE_AFTER_MS).length, 0);
});

test("a recurrence is a new episode and is due although the first was told", () => {
  const log = [t("opened", 1, 0), t("cleared", 1, NOTICE_AFTER_MS), t("opened", 2, 2 * NOTICE_AFTER_MS)];
  const sent = new Set([noticeKey(t("opened", 1, 0))]);
  assert.equal(dueNotices(log, sent, T0 + 2 * NOTICE_AFTER_MS + 1).length, 0);
  const due = dueNotices(log, sent, T0 + 3 * NOTICE_AFTER_MS);
  assert.deepEqual(due.map((d) => d.episode), [2]);
});

test("the batch request names the project and each episode, and opens the project page", async () => {
  const sent = stuckBatchRequests("topic", "https://atelier.zone", "p q", [{ item: "t1", reason: "a" }, { item: "t2", reason: "b" }]);
  assert.equal(sent.length, 1);
  const r = sent[0].request;
  assert.equal(r.headers.get("Click"), "https://atelier.zone/p/p%20q");
  assert.equal(await r.text(), "t1: a; t2: b");
  assert.match(Buffer.from(r.headers.get("Title")!.slice(10, -2), "base64").toString(), /p q: 2 stuck episodes/);
});

test("a batch over 500 characters is split so every episode is in a message", async () => {
  const episodes = Array.from({ length: 30 }, (_, i) => ({ item: `t${i}`, reason: "no push for two days, nothing to review" }));
  const sent = stuckBatchRequests("topic", "https://atelier.zone", "p", episodes);
  assert.ok(sent.length > 1);
  assert.deepEqual(sent.flatMap((s) => s.episodes), episodes);
  for (const s of sent) {
    const body = await s.request.text();
    assert.ok(Array.from(body).length <= 500);
    for (const e of s.episodes) assert.ok(body.includes(`${e.item}: ${e.reason}`), `${e.item} is in its message`);
  }
});

test("one episode longer than the limit is cut but still named", async () => {
  const sent = stuckBatchRequests("topic", "https://atelier.zone", "p", [{ item: "t1", reason: "x".repeat(900) }, { item: "t2", reason: "b" }]);
  assert.equal(sent.length, 2);
  assert.match(await sent[0].request.text(), /^t1: x+$/);
  assert.equal(await sent[1].request.text(), "t2: b");
});
