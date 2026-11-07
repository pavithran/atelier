import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNow, nowText, nowBody, easternStamp, revertOpen, TARGET_TOKENS_PER_MERGE, type NowProject } from "../src/now.ts";
import { NOW, h, min, item, progress, project } from "./fixtures/now.ts";

// The Now view (t525): every live task once, in one of four groups, with who
// it waits on and since when; the numbers are the ledger's. The fixture is
// one project with one task per stage, read at 10:00 EST on 2026-11-07
// (15:00 UTC), after the clocks went back on 2026-11-01.

const view = () => buildNow([project()], NOW);
const row = (id: string) => view().groups.flatMap((g) => g.rows).find((r) => r.id === id)!;
const groupOf = (id: string) => view().groups.find((g) => g.rows.some((r) => r.id === id))!.key;

test("the four groups are named and ordered as mockup A, and every live task appears once", () => {
  assert.deepEqual(view().groups.map((g) => [g.key, g.label]), [
    ["needs-you", "Needs you"], ["running", "Running"], ["waiting", "Stuck or waiting on a session"], ["landed", "Landed today"],
  ]);
  const ids = view().groups.flatMap((g) => g.rows.map((r) => r.id));
  assert.deepEqual([...ids].sort(), ["t1", "t10", "t11", "t12", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"].sort());
  assert.equal(new Set(ids).size, ids.length);
});

// One task per stage: its group, its stage word, who it waits on, and what it does by itself.
const BY_STAGE: [string, string, string, RegExp, RegExp][] = [
  ["t1", "waiting", "filed", /^a session to review its criteria$/, /^dispatches itself once its criteria are agreed$/],
  ["t2", "waiting", "agreed", /^a dispatcher session$/, /^queues for a builder$/],
  ["t3", "waiting", "queued", /^a runner offering claude-code\/sonnet-5\.5$/, /^a runner claims it and builds it$/],
  ["t4", "running", "building", /^claude-code\/sonnet-5\.5, building$/, /^checks run when it submits$/],
  ["t5", "waiting", "built", /^the required checks \(a runner\)$/, /^the checks run, then a review is requested$/],
  ["t6", "running", "checked", /^codex\/gpt-6-astra, reviewing$/, /^the verdict records itself$/],
  ["t7", "waiting", "reviewed", /^the landing queue$/, /^queues to land once the gate clears$/],
  ["t8", "needs-you", "landable", /^you: Land$/, /^nothing: it waits for you to land it$/],
  ["t9", "waiting", "landed", /^the post-merge run$/, /^deploys with the next ship$/],
  ["t10", "needs-you", "blocked", /^you: Unblock$/, /^nothing: it waits for you to unblock it$/],
];
for (const [id, group, stage, waiting, next] of BY_STAGE) {
  test(`${id} at ${stage}: group ${group}, who it waits on, what happens next`, () => {
    assert.equal(groupOf(id), group);
    const r = row(id);
    assert.equal(r.stage, stage);
    assert.match(r.waitingOn, waiting);
    assert.match(r.next, next);
    assert.ok(r.waitingOn.trim() !== "" && !/unknown/i.test(r.waitingOn), "waiting on is never empty or unknown");
  });
}

test("a task whose stage was never recorded still says who it waits on", () => {
  const p = project();
  p.stages = {};
  const rows = buildNow([p], NOW).groups.flatMap((g) => g.rows).filter((r) => r.group !== "landed");
  assert.equal(rows.length, 10);
  for (const r of rows) assert.ok(r.waitingOn.trim() && !/unknown/i.test(r.waitingOn) && r.since, r.id);
});

test("since is the stage's entry time from the ledger, in Eastern time on both sides of the November change", () => {
  assert.equal(row("t1").since, h(30));
  assert.equal(row("t4").since, h(3));
  assert.equal(row("t4").sinceText, "2026-11-07 07:00 EST");
  assert.equal(row("t1").sinceText, "2026-11-06 04:00 EST");
  // Before 2026-11-01 02:00 the zone is daylight time.
  assert.equal(easternStamp("2026-10-31T18:30:00.000Z"), "2026-10-31 14:30 EDT");
  assert.equal(easternStamp("2026-11-01T06:30:00.000Z"), "2026-11-01 01:30 EST");
});

test("a running build whose runner has gone quiet is waiting and stuck, not running", () => {
  const p = project();
  (p.progress as never as Record<string, { changedAt: string }>).t4.changedAt = h(2);
  const r = buildNow([p], NOW).groups.flatMap((g) => g.rows).find((x) => x.id === "t4")!;
  assert.equal(r.group, "waiting");
  assert.match(r.waitingOn, /^claude-code\/sonnet-5\.5, building, silent for 2 h$/);
});

test("a task past its stage limit says it is stuck", () => {
  assert.equal(row("t3").stuck, "30 min over its 10 min limit");
  assert.equal(row("t1").stuck, "6 h over its 24 h limit");
  assert.equal(row("t4").stuck, null);
});

test("each row carries every field from the ledger", () => {
  assert.deepEqual(row("t4"), {
    id: "t4", project: "atelier", projectTitle: "Atelier", title: "Title of t4", group: "running", stage: "building",
    waitingOn: "claude-code/sonnet-5.5, building", since: h(3), sinceText: "2026-11-07 07:00 EST",
    next: "checks run when it submits", tokens: 200_000, tokensText: "200k", stuck: null, href: "/p/atelier/t4",
  });
  assert.deepEqual(row("t8"), {
    id: "t8", project: "atelier", projectTitle: "Atelier", title: "Title of t8", group: "needs-you", stage: "landable",
    waitingOn: "you: Land", since: min(15), sinceText: "2026-11-07 09:45 EST",
    next: "nothing: it waits for you to land it", tokens: null, tokensText: "none reported", stuck: null, href: "/p/atelier/t8",
  });
  assert.equal(row("t5").tokens, 50_000);
  assert.equal(row("t6").tokens, null);
});

test("Landed today holds the merges of the Eastern day, with deployed time, reviewer, findings fixed and a Revert link for 24 h", () => {
  assert.deepEqual(view().groups[3].rows.map((r) => r.id), ["t12", "t11"]);
  assert.deepEqual(row("t11"), {
    id: "t11", project: "atelier", projectTitle: "Atelier", title: "Title of t11", group: "landed", stage: "landed",
    waitingOn: "nobody: it is deployed", since: "2026-11-07T06:30:00.000Z", sinceText: "2026-11-07 01:30 EST",
    next: "nothing: it is done", tokens: 400_000, tokensText: "400k", stuck: null, href: "/p/atelier/t11",
    deployedAt: "2026-11-07T07:10:00.000Z", deployedText: "2026-11-07 02:10 EST", reviewer: "codex/gpt-6-astra", findingsFixed: 2,
    revertHref: "/p/atelier/t11/revert", reverted: false, revertTask: null,
  });
  // Merged after the one deploy, and a revert asked for but not merged: no deploy time, no link, not reverted.
  assert.deepEqual([row("t12").deployedAt, row("t12").deployedText, row("t12").waitingOn, row("t12").reverted, row("t12").revertHref], [null, "not deployed yet", "the next ship", false, null]);
  assert.equal(row("t12").revertTask, "t99");
});

test("findings fixed counts the findings the ledger records as fixed, not refuted, confirmed or follow-up ones", () => {
  assert.equal(row("t11").findingsFixed, 2);
  const p = project();
  p.events = p.events.filter((e) => e.kind !== "review.finding");
  assert.equal(buildNow([p], NOW).groups[3].rows.find((r) => r.id === "t11")!.findingsFixed, 0);
});

test("a revert counts only once the revert task has merged; a request alone marks nothing", () => {
  const p = project();
  assert.equal(row("t12").reverted, false);
  assert.equal(buildNow([p], NOW).header.soundMergesToday, 2);
  p.events.push({ kind: "item.merged", itemId: "t99", at: min(10), actor: "owner", data: {} } as never);
  const v = buildNow([p], NOW);
  assert.equal(v.groups[3].rows.find((r) => r.id === "t12")!.reverted, true);
  assert.equal(v.header.soundMergesToday, 1);
  assert.ok(nowBody(v).includes("Reverted"));
  assert.ok(!nowBody(buildNow([project()], NOW)).includes("Reverted"));
});

test("every landed row shows waiting on and next in the page and in the text", () => {
  const v = view(), html = nowBody(v), text = nowText(v);
  for (const r of v.groups[3].rows) {
    assert.ok(html.includes(`<dt>Waiting on</dt><dd>${r.waitingOn}</dd>`) && html.includes(`<dt>Next by itself</dt><dd>${r.next}</dd>`), r.id);
    assert.ok(text.includes(`waiting on ${r.waitingOn}`) && text.includes(`next: ${r.next}`), r.id);
  }
});

test("every field of every row is in the page and the text", () => {
  const v = view(), html = nowBody(v), text = nowText(v);
  for (const r of v.groups.flatMap((g) => g.rows)) {
    for (const s of [r.title, r.projectTitle, r.id, r.stage, r.waitingOn, r.sinceText, r.next, r.tokensText]) assert.ok(html.includes(s), `${r.id} page ${s}`);
    for (const s of [r.title, r.project, r.id, r.stage, r.waitingOn, r.sinceText, r.next, r.tokensText]) assert.ok(text.includes(s), `${r.id} text ${s}`);
  }
});

test("the Revert link is open for 24 hours from the merge and not a moment longer", () => {
  const merged = "2026-11-07T06:30:00.000Z", t = Date.parse(merged) + 24 * 3_600_000;
  assert.equal(revertOpen(merged, new Date(t - 1)), true);
  assert.equal(revertOpen(merged, new Date(t)), false);
});

test("a merge before today's Eastern day, or after now, is not listed as landed today", () => {
  const p = project();
  p.events.push({ kind: "item.merged", itemId: "t14", at: "2026-11-06T23:00:00.000Z", actor: "owner", data: {} } as never);
  p.items.push(item("t14", { state: "merged" }) as never);
  const ids = buildNow([p], NOW).groups[3].rows.map((r) => r.id);
  assert.ok(!ids.includes("t14") && !ids.includes("t13"));
  assert.deepEqual(buildNow([p], new Date("2026-11-07T10:00:00.000Z")).groups[3].rows.map((r) => r.id), ["t11"]);
});

test("the header: tokens per sound merge today, the 0.7M target, merges today and the live count, from the ledger", () => {
  const v = view();
  // t11 and t12 merged today (t13 merged at 23:30 EST yesterday); t12's revert task is not merged, so both are sound.
  assert.deepEqual(v.header, { mergesToday: 2, soundMergesToday: 2, liveCount: 10, tokensPerSoundMerge: 650_000, tokensPerSoundMergeText: "0.65M", target: 700_000, targetText: "0.7M", onTarget: true });
  // A merged revert task makes t12 unsound: the two merges' tokens fall on one sound merge.
  const q = project();
  q.events.push({ kind: "item.merged", itemId: "t99", at: min(10), actor: "owner", data: {} } as never);
  assert.deepEqual([buildNow([q], NOW).header.soundMergesToday, buildNow([q], NOW).header.tokensPerSoundMerge], [1, 1_300_000]);
  assert.equal(TARGET_TOKENS_PER_MERGE, 700_000);
  const p = project();
  // No merge yet today: no figure, never a zero that reads as a win.
  p.events = [];
  const none = buildNow([p], NOW).header;
  assert.deepEqual([none.mergesToday, none.tokensPerSoundMerge, none.tokensPerSoundMergeText, none.onTarget], [0, null, "no merges yet", false]);
});

test("rows from several projects share the groups", () => {
  const other: NowProject = { ...project(), name: "other", title: "Other", items: [item("t1", { state: "claimed", owner: "codex/gpt-6" })] as never, stages: { t1: { stage: "building", since: h(1) } }, owner: [], reviewRequests: [], progress: { t1: progress("t1", {}, 10) } as never, events: [], deploys: [] };
  const v = buildNow([project(), other], NOW);
  assert.deepEqual(v.groups[1].rows.map((r) => `${r.project}/${r.id}`).sort(), ["atelier/t4", "atelier/t6", "other/t1"]);
  assert.equal(v.header.liveCount, 11);
});

test("atelier status text prints the same groups and rows", () => {
  const text = nowText(view());
  const lines = text.split("\n");
  assert.equal(lines[0], "Now: 10 live · 2 merges today · 0.65M tokens per sound merge (target 0.7M)");
  const at = (label: string) => lines.findIndex((l) => l.startsWith(label));
  assert.ok(at("Needs you (2)") < at("Running (2)") && at("Running (2)") < at("Stuck or waiting on a session (6)") && at("Stuck or waiting on a session (6)") < at("Landed today (2)"));
  assert.ok(text.includes("t8  Title of t8  [atelier]  landable"));
  assert.ok(text.includes("    waiting on you: Land · since 2026-11-07 09:45 EST · next: nothing: it waits for you to land it · tokens: none reported"));
  assert.ok(text.includes("    waiting on claude-code/sonnet-5.5, building · since 2026-11-07 07:00 EST · next: checks run when it submits · tokens: 200k"));
  assert.ok(text.includes("    waiting on nobody: it is deployed · next: nothing: it is done · landed 2026-11-07 01:30 EST · deployed 2026-11-07 02:10 EST · reviewer codex/gpt-6-astra · 2 findings fixed · tokens: 400k · revert: /p/atelier/t11/revert"));
  // Every row of the view is a row of the text, once.
  for (const g of view().groups) for (const r of g.rows) assert.equal(lines.filter((l) => l.startsWith(`  ${r.id}  `)).length, 1, r.id);
  // An empty group says so.
  assert.match(nowText(buildNow([], NOW)), /Needs you \(0\)\n  Nothing\./);
});

test("the page draws each row's fields, escapes task text, and names no task twice", () => {
  const p = project();
  (p.items[0] as { title: string }).title = "<img src=x onerror=alert(1)>";
  const html = nowBody(buildNow([p], NOW));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  for (const label of ["Needs you", "Running", "Stuck or waiting on a session", "Landed today"]) assert.ok(html.includes(label), label);
  assert.ok(html.includes('href="/p/atelier/t11/revert"') && html.includes(">Revert<"));
  assert.ok(!html.includes('href="/p/atelier/t12/revert"'));
  assert.equal(html.split('href="/p/atelier/t4"').length - 1, 1);
});
