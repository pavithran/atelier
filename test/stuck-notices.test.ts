import { test } from "node:test";
import assert from "node:assert/strict";
import { dueNotices, noticeKey, NOTICE_AFTER_MS } from "../src/stuck/notices.ts";
import { stuckBatchRequest } from "../src/notify.ts";
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
  const r = stuckBatchRequest("topic", "https://atelier.zone", "p q", [{ item: "t1", reason: "a" }, { item: "t2", reason: "b" }]);
  assert.equal(r.headers.get("Click"), "https://atelier.zone/p/p%20q");
  assert.equal(await r.text(), "t1: a; t2: b");
  assert.match(Buffer.from(r.headers.get("Title")!.slice(10, -2), "base64").toString(), /p q: 2 stuck episodes/);
});
