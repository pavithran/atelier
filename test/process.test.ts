import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeBars, computeFlow, midpoint, nearestRank, PHASES, type BarEvent, type Phase } from "../src/flow.ts";
import { buildProcess, parseStat, parseWindow, readProcessEvents, renderProcess, minutesText, PROCESS_CSS } from "../src/process.ts";
import { FIXTURE, NOW, T1_FILED_TO_DEPLOYED, T1_MERGE_TO_DEPLOY } from "./fixtures/process/ledger.ts";

// The Process page's numbers (t558). Every figure is checked against what
// src/flow.ts reports for the same events, and the empty cases against the
// words the page must show instead of 0, NaN or an error.

const DAY = 86_400_000;
const tasksOf = (events: readonly BarEvent[], from: number, to: number) => {
  const by = new Map<string, BarEvent[]>();
  for (const e of events) if (e.itemId) (by.get(e.itemId) ?? by.set(e.itemId, []).get(e.itemId)!).push(e);
  return [...by].filter(([, l]) => l[0].kind === "item.created" && Date.parse(l[0].at) >= from && Date.parse(l[0].at) < to).map(([id, l]) => ({ id, events: l }));
};
const page = (events: readonly BarEvent[], window: "7d" | "30d" = "7d", stat: "median" | "p90" = "median") => renderProcess(buildProcess("demo", events, NOW, window), stat, "/p/demo/process");
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("criterion 3: each phase block's task count, median, p90 and share equal the flow report for the window", () => {
  const model = buildProcess("demo", FIXTURE, NOW, "7d");
  const report = computeFlow(tasksOf(FIXTURE, NOW - 7 * DAY, NOW + 1), NOW);
  assert.deepEqual(model.report, report, "the page reuses computeFlow's report");
  for (const phase of PHASES) {
    const minutes = report.tasks.filter((t) => !t.phases[phase].unknown && (t.phases[phase].ms > 0 || t.phases[phase].open)).map((t) => t.phases[phase].ms / 60_000);
    const block = model.blocks.find((b) => b.phases.length === 1 && b.phases[0] === phase);
    if (!block) continue;
    assert.equal(block.tasks, minutes.length, phase);
    assert.equal(block.median, midpoint(minutes), phase);
    assert.equal(block.p90, nearestRank(minutes, 0.9), phase);
    assert.equal(block.share, report.phaseShares[phase], phase);
  }
  // Accept and wait to land are one block: its share is the two shares added.
  const joined = model.blocks.find((b) => b.phases.length === 2)!;
  assert.deepEqual(joined.phases, ["accept", "waitToLand"] satisfies Phase[]);
  assert.ok(Math.abs(joined.share! - (report.phaseShares.accept! + report.phaseShares.waitToLand!)) < 1e-12);
  // A hand check: t1 and t3 build for 30 and 20 minutes (claim to push), t2 for 15 + ...
  const build = model.blocks.find((b) => b.phases[0] === "build")!;
  assert.equal(build.tasks, 3);
});

test("criterion 3: the HTML carries the same numbers, with the statistic the link chose", () => {
  const model = buildProcess("demo", FIXTURE, NOW, "7d");
  const runner = model.blocks.find((b) => b.phases[0] === "runnerWait")!;
  const med = text(page(FIXTURE));
  assert.ok(med.includes(`${minutesText(runner.median!).number} ${minutesText(runner.median!).unit} median`), med);
  assert.ok(med.includes(`p90 ${minutesText(runner.p90!).number} ${minutesText(runner.p90!).unit} · ${runner.tasks} tasks`));
  const p90 = text(page(FIXTURE, "7d", "p90"));
  assert.ok(p90.includes(`${minutesText(runner.p90!).number} ${minutesText(runner.p90!).unit} p90`), p90);
  assert.ok(p90.includes(`median ${minutesText(runner.median!).number} ${minutesText(runner.median!).unit} · ${runner.tasks} tasks`));
  assert.ok(med.includes(`${Math.round(runner.share! * 100)}%`));
});

test("criterion 4: loops count events and tasks from the ledger", () => {
  const { loops } = buildProcess("demo", FIXTURE, NOW, "7d");
  assert.deepEqual(loops.fixRound, { events: 4, tasks: 2 }, "review.rejected: t1 once, t2 three times");
  assert.deepEqual(loops.checkFailed, { events: 2, tasks: 1 }, "failed evidence, as docs/flow.md counts them");
  assert.deepEqual(loops.conflict, { events: 0, tasks: 0 }, "no landing conflict in the fixture");
  assert.deepEqual(loops.criteriaRejected, { events: 1, tasks: 1 }, "criteria_review.rejected");
  assert.deepEqual(loops.roundCap, { events: 1, tasks: 1 }, "review.round_cap");
  const words = text(page(FIXTURE));
  assert.match(words, /4 rejected, fix round · 2 tasks/);
  assert.match(words, /2 check failed · 1 task/);
  assert.match(words, /1 criteria rejected · 1 task/);
  assert.match(words, /1 blocked at the round cap/);
});

test("criterion 4: a landing conflict is counted as docs/flow.md counts it", () => {
  const extra: BarEvent[] = [
    { seq: 9001, at: new Date(NOW - 3 * DAY + 100 * 60_000).toISOString(), itemId: "t1", kind: "refresh.returned", data: {} },
    { seq: 9002, at: new Date(NOW - 2 * DAY + 100 * 60_000).toISOString(), itemId: "t2", kind: "integration.failed", data: {} },
  ];
  assert.deepEqual(buildProcess("demo", [...FIXTURE, ...extra], NOW, "7d").loops.conflict, { events: 2, tasks: 2 });
});

test("criterion 5: the headline cards, each with the previous window", () => {
  const m = buildProcess("demo", FIXTURE, NOW, "7d");
  const bars = (now: number) => computeBars([{ name: "demo", events: FIXTURE }], now).scopes[0].bars;
  const now = bars(NOW), before = bars(NOW - 7 * DAY);
  assert.equal(m.cards.deployMedian.value, now.find((b) => b.id === "deployMedian")!.value);
  assert.equal(m.cards.deployMedian.value, T1_FILED_TO_DEPLOYED, "t1 is the one merged task deployed this week");
  assert.equal(m.cards.deployMedian.status, "fail", "156 min is over the 60 min target");
  assert.equal(m.cards.deployMedian.target, "at most 60 min");
  assert.equal(m.cards.deployP90.status, "pass");
  assert.equal(m.cards.deployP90.target, "at most 3 h");
  assert.equal(m.cards.deployMedian.previous, before.find((b) => b.id === "deployMedian")!.value);
  assert.equal(m.cards.deployMedian.previous, 300);
  assert.equal(m.cards.toMerge.value, m.report.medianMinutesToMerge);
  assert.equal(m.cards.toMerge.value, midpoint([126, 90]));
  assert.equal(m.cards.rounds.value, m.report.medianReviewRounds);
  assert.equal(m.cards.toMerge.previous, 200);
  const words = text(page(FIXTURE));
  assert.match(words, /Filed to deployed, median/);
  assert.match(words, /was 5 h the previous 7 days/);
  assert.match(words, /Filed to merged, median/);
  assert.match(words, /Review rounds per task, median/);
});

test("criterion 6: Ship is measured merge to deploy, and merged tasks not deployed are counted and named", () => {
  const m = buildProcess("demo", FIXTURE, NOW, "7d");
  assert.equal(m.ship.merges, 2);
  assert.equal(m.ship.deployed, 1);
  assert.equal(m.ship.median, T1_MERGE_TO_DEPLOY);
  assert.equal(m.ship.p90, T1_MERGE_TO_DEPLOY);
  assert.deepEqual(m.ship.notDeployed, ["t3"]);
  const words = text(page(FIXTURE));
  assert.match(words, /30 min median/);
  assert.match(words, /1 merged, not deployed: t3/);
  assert.match(words, /1 of 2/);
  // Not a difference of medians: filed-to-deployed minus filed-to-merged would be 156 - 108 = 48.
  assert.notEqual(m.ship.median, m.cards.deployMedian.value! - m.cards.toMerge.value!);
});

test("criterion 7: the window and statistic switch through plain links, unknown values fall back, no script", () => {
  assert.equal(parseWindow(null), "7d");
  assert.equal(parseWindow("30d"), "30d");
  assert.equal(parseWindow("7d"), "7d");
  for (const bad of ["", "1d", "30", "30D", "all", "7d,30d", "<script>"]) assert.equal(parseWindow(bad), "7d", bad);
  assert.equal(parseStat(null), "median");
  assert.equal(parseStat("p90"), "p90");
  for (const bad of ["", "mean", "P90", "p99", "median,p90"]) assert.equal(parseStat(bad), "median", bad);
  const html = page(FIXTURE, "30d", "p90");
  assert.ok(html.includes('<a href="/p/demo/process?since=7d&amp;stat=p90">7 days</a>'));
  assert.ok(html.includes('<a href="/p/demo/process?since=30d&amp;stat=p90" aria-current="true">30 days</a>'));
  assert.ok(html.includes('<a href="/p/demo/process?since=30d&amp;stat=median">Median</a>'));
  assert.ok(html.includes('<a href="/p/demo/process?since=30d&amp;stat=p90" aria-current="true">p90</a>'));
  assert.ok(!/<script|<button|onclick/i.test(html), "the switches need no JavaScript");
});

test("criterion 7: 30 days reads tasks filed in the longer window and compares with the 30 before", () => {
  const m = buildProcess("demo", FIXTURE, NOW, "30d");
  assert.equal(m.report.tasks.length, 5, "t0 through t4");
  assert.equal(m.days, 30);
  assert.equal(m.cards.toMerge.previous, null, "nothing was filed in the 30 days before");
});

test("criterion 8: a project with no events shows 'no tasks', never 0, NaN or an error", () => {
  const html = page([]);
  const words = text(html);
  assert.match(words, /no tasks/i);
  assert.ok(!/NaN|undefined|Infinity|null/.test(html), "no NaN, undefined, Infinity or null in the markup");
  assert.ok(!/\b0 min\b|\b0 h\b|\b0%/.test(words), words);
  for (const window of ["7d", "30d"] as const) for (const stat of ["median", "p90"] as const) assert.ok(page([], window, stat).includes("no tasks"));
  assert.equal(buildProcess("demo", [], NOW, "7d").report.tasks.length, 0);
});

test("criterion 8: a window with no tasks, and a phase no task entered", () => {
  // Only the old task: this week is empty.
  const oldOnly = FIXTURE.filter((e) => e.itemId === "t0" || e.itemId === null);
  const empty = buildProcess("demo", oldOnly, NOW, "7d");
  assert.equal(empty.report.tasks.length, 0);
  assert.ok(empty.blocks.every((b) => b.tasks === 0 && b.median === null && b.p90 === null && b.share === null));
  assert.ok(!/NaN|undefined/.test(page(oldOnly)));
  // The fixture's criteria review is entered by one task, the merge phase by two; remove criteria review.
  const none = FIXTURE.filter((e) => !e.kind.startsWith("criteria_review."));
  const m = buildProcess("demo", none, NOW, "7d");
  const block = m.blocks.find((b) => b.phases[0] === "criteriaReview")!;
  assert.equal(block.tasks, 0);
  assert.equal(block.median, null);
  const html = page(none);
  assert.match(html, /<g class="n-judge[^>]*>(?:(?!<\/g>)[\s\S])*Criteria review(?:(?!<\/g>)[\s\S])*no tasks/);
  assert.ok(!/NaN/.test(html));
});

test("criterion 2: ten blocks, loop arrows, drawn with theme variables", () => {
  const html = page(FIXTURE);
  assert.equal((html.match(/<rect class="n-box"/g) ?? []).length, 22, "ten blocks and the round-cap box, on the desktop map and on the phone map");
  const kickers = [...html.matchAll(/class="n-kick"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(kickers.slice(0, 10), ["1 · start", "2 · judge", "3 · wait", "4 · work", "5 · work", "6 · judge", "7 · wait", "8 · work", "9 · ship", "10 · end"]);
  assert.ok((html.match(/class="e-loop/g) ?? []).length >= 10);
  assert.ok(html.includes("<svg class=\"desk\"") && html.includes("<svg class=\"phone\""));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(PROCESS_CSS), "process.css has no literal colour");
  assert.ok(!/rgba?\(\s*\d/.test(PROCESS_CSS), "process.css has no literal rgb colour");
  assert.ok(PROCESS_CSS.includes("var(--observed)") && PROCESS_CSS.includes("var(--caution)") && PROCESS_CSS.includes("var(--fault)"));
});

test("criterion 9: the footer names each figure's source, and says runner wait includes core-file holds", () => {
  const words = text(page(FIXTURE));
  assert.match(words, /Phases and loops: .*atelier flow --json/);
  assert.match(words, /Deploy times: .*atelier flow --bars/);
  assert.match(words, /Ship is measured/);
  assert.match(words, /Runner wait includes core-file holds/);
  assert.match(words, /incl\. core-file holds/);
  // The ledger does not separate holds: a ledger that did would drop the sentence.
  assert.ok(!/core-file holds are/.test(words));
});

test("a read of the ledger stops once a page reaches back past the previous window", async () => {
  const sorted = [...FIXTURE].sort((a, b) => b.seq - a.seq);
  const calls: (number | undefined)[] = [];
  const got = await readProcessEvents(async (before) => { calls.push(before); return sorted.filter((e) => before === undefined || e.seq < before).slice(0, 5); }, 5, NOW, "7d");
  assert.ok(calls.length > 1, "more than one page");
  assert.ok(got.length <= sorted.length);
  assert.deepEqual(got.map((e) => e.seq), [...got.map((e) => e.seq)].sort((a, b) => a - b), "oldest first");
  assert.equal(buildProcess("demo", got, NOW, "7d").report.tasks.length, 4);
});

test("criterion 10 and 11: the docs hold the flowchart and flow.md links to it", () => {
  const doc = readFileSync(new URL("../docs/process.md", import.meta.url), "utf8");
  assert.match(doc, /```mermaid\nflowchart/);
  for (const name of ["Criteria review", "runner wait", "Build", "Checks", "Code review", "Accept", "Land", "Ship", "Live"]) assert.ok(doc.toLowerCase().includes(name.toLowerCase()), name);
  for (const source of ["review.rejected", "criteria_review.rejected", "review.round_cap", "refresh.returned", "item.merged", "action.ran"]) assert.ok(doc.includes(source), source);
  assert.match(readFileSync(new URL("../docs/flow.md", import.meta.url), "utf8"), /\(process\.md\)/);
});
