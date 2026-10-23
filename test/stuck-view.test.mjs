import { test } from "node:test";
import assert from "node:assert/strict";
import { openStuck } from "../src/stuck/view.ts";
import { formatInbox, formatStatus, readStuck, statusJson, stuckLines } from "../cli/status.mjs";

// t198: open stuck episodes come before ordinary items on status, unwrap and
// the inbox, with cause, evidence, first-seen time and next step.

const entry = (subject, kind, since, extra = {}) => ({ kind, subject, reason: `${kind} reason`, since, ageMs: 1, evidence: `https://x/p/p/${subject}`, recovery: `atelier dispatch ${subject}`, ...extra });
const opened = (item, cause, at) => ({ project: "p", item, cause, episode: 1, kind: "opened", at, reason: "" });
const items = [{ id: "t1", state: "claimed", title: "One" }, { id: "t2", state: "merged", title: "Two" }];
const NOW = new Date("2026-10-23T12:00:00.000Z");

test("rows list open episodes oldest first with cause, evidence, first-seen and next step", () => {
  const report = { entries: [entry("t1", "orphaned-claim", "2026-10-22T10:00:00.000Z"), entry("t3", "core-hold", "2026-10-21T10:00:00.000Z")] };
  const v = openStuck("p", report, [opened("t1", "orphaned-claim", "2026-10-22T10:10:00.000Z"), opened("t3", "core-hold", "2026-10-21T10:10:00.000Z")], items);
  assert.deepEqual(v.rows.map((r) => r.item), ["t3", "t1"]);
  assert.equal(v.rows[1].firstSeen, "2026-10-22T10:10:00.000Z");
  assert.equal(v.rows[1].evidence, "https://x/p/p/t1");
  assert.equal(v.rows[1].next, "atelier dispatch t1");
  assert.deepEqual(v.notRead, []);
});

test("a closed task has no row, and a cleared episode gives no first-seen time", () => {
  const report = { entries: [entry("t2", "orphaned-claim", "2026-10-22T10:00:00.000Z"), entry("t1", "orphaned-claim", "2026-10-22T10:00:00.000Z")] };
  const cleared = { ...opened("t1", "orphaned-claim", "2026-10-22T11:00:00.000Z"), kind: "cleared" };
  const v = openStuck("p", report, [opened("t1", "orphaned-claim", "2026-10-22T10:10:00.000Z"), cleared, opened("t2", "orphaned-claim", "2026-10-22T10:10:00.000Z")], items);
  assert.deepEqual(v.rows.map((r) => [r.item, r.firstSeen]), [["t1", "unknown"]]);
});

test("unavailable data is labelled unknown", () => {
  const none = openStuck("p", null, null, null);
  assert.deepEqual(none.notRead, ["stuck report", "stuck episodes", "tasks"]);
  const alone = openStuck("p", null, [opened("t1", "orphaned-claim", "2026-10-22T10:10:00.000Z")], items);
  assert.deepEqual([alone.rows[0].evidence, alone.rows[0].next, alone.rows[0].since], ["unknown", "unknown", "unknown"]);
  const text = stuckLines(none).join("\n");
  assert.match(text, /Stuck work: stuck report unknown \(not read\)/);
});

test("status and inbox print the stuck section before ordinary items", () => {
  const stuck = openStuck("p", { entries: [entry("t1", "orphaned-claim", "2026-10-22T10:00:00.000Z")] }, [opened("t1", "orphaned-claim", "2026-10-22T10:10:00.000Z")], items);
  const view = { name: "p", items, inbox: [], stuck };
  const status = formatStatus([view], { now: NOW });
  assert.ok(status.indexOf("Stuck") < status.indexOf("In progress"));
  assert.match(status, /First seen 2026-10-22 10:10 UTC/);
  assert.match(status, /Evidence: https:\/\/x\/p\/p\/t1/);
  assert.match(status, /Next: atelier dispatch t1/);
  const inbox = formatInbox([view], { now: NOW });
  assert.match(inbox, /Stuck\n.*t1 {2}orphaned-claim/);
  assert.equal(statusJson([view], "", null, NOW)[0].stuck.rows.length, 1);
});

test("readStuck reads the report and episodes, and a failed read is unknown", async () => {
  const answers = { "/p/stuck": { entries: [entry("t1", "orphaned-claim", "2026-10-22T10:00:00.000Z")] }, "/p/stuck/episodes": null };
  const v = await readStuck(async (path) => answers[path], "/p", "p", items);
  assert.equal(v.rows[0].firstSeen, "unknown");
  assert.deepEqual(v.notRead, ["stuck episodes"]);
  assert.match(stuckLines(v).join("\n"), /First seen unknown; the cause dates from 2026-10-22 10:00 UTC/);
});

test("an incomplete report keeps open episodes it has no entry for and names what was unavailable", () => {
  const report = { complete: false, unavailable: ["run reports: boom"], entries: [] };
  const v = openStuck("p", report, [opened("t1", "orphaned-claim", "2026-10-22T10:10:00.000Z")], items);
  assert.deepEqual(v.rows.map((r) => [r.item, r.firstSeen, r.evidence, r.next]), [["t1", "2026-10-22T10:10:00.000Z", "unknown", "unknown"]]);
  assert.deepEqual(v.notRead, ["stuck diagnostics (run reports: boom)"]);
  assert.match(stuckLines(v).join("\n"), /Stuck work: stuck diagnostics \(run reports: boom\) unknown/);
  const complete = openStuck("p", { complete: true, unavailable: [], entries: [] }, [opened("t1", "orphaned-claim", "2026-10-22T10:10:00.000Z")], items);
  assert.deepEqual(complete.rows, []);
});

test("unwrap prints the stuck section before the standing lists", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../cli/commands/unwrap.mjs", import.meta.url), "utf8");
  assert.ok(src.indexOf("console.log(stuck.join") < src.indexOf("formatStanding(standing"));
});
