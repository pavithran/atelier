import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCEPT_COUNT, BRIEF_MAX, FIELD_MAX, itemFields, itemText, shortTitle, TITLE_MAX } from "../src/rules.ts";
import { briefFor } from "../cli/runner.mjs";
import { formatTask } from "../cli/atelier.mjs";

// t315: a task's short title, derived from the text when only one long
// string is given, its brief and its acceptance criteria as the boundary
// cleans them, and the agents' briefs carrying the whole text. Storage and
// the migration are tested in ledger.spec.ts, the routes and pages in
// routes.spec.ts, the CLI flags in cli-flags.test.mjs.

test("shortTitle keeps a text that fits and otherwise takes its first clause or sentence", () => {
  assert.equal(shortTitle("Fix the parser"), "Fix the parser");
  assert.equal(shortTitle("  Fix   the\nparser  "), "Fix the parser");
  const eighty = `${"word ".repeat(15)}abcde`;
  assert.equal(eighty.length, TITLE_MAX);
  assert.equal(shortTitle(eighty), eighty);
  // The first clause: up to " (", ": ", "; ", a dash, or the end of a sentence.
  assert.equal(shortTitle(`Plan review by another family (from ForgeBoard, 2026-10-08): ${"more ".repeat(20)}`), "Plan review by another family");
  assert.equal(shortTitle(`Secret scan on push: when Atelier observes a push, ${"scan ".repeat(20)}`), "Secret scan on push");
  assert.equal(shortTitle(`Runners stop cleanly. ${"Then ".repeat(30)}`), "Runners stop cleanly");
  assert.equal(shortTitle(`Undo a merge — ${"why ".repeat(30)}`), "Undo a merge");
  // A clause too short to say anything is passed over: "e.g." is not a title.
  assert.equal(shortTitle(`Fix: e.g. the parser fails on nested lists; ${"x ".repeat(40)}`), "Fix: e.g. the parser fails on nested lists");
});

test("shortTitle cuts a clause too long at a word boundary with an ellipsis, within 80 characters", () => {
  const long = "Run required checks in a Cloudflare Sandbox so Observed no longer depends on the machine that asks for them and nothing else";
  const t = shortTitle(long);
  // "...depends on the" is 80 characters, so with the ellipsis "the" does not fit.
  assert.equal(t, "Run required checks in a Cloudflare Sandbox so Observed no longer depends on…");
  assert.ok(t.length <= TITLE_MAX);
  // Never inside a word: the cut lands before the word that would not fit.
  assert.ok(long.startsWith(t.slice(0, -1)) && long[t.length - 1] === " ");
  // One word longer than a title is cut where it must be.
  assert.equal(shortTitle("x".repeat(200)), `${"x".repeat(TITLE_MAX - 1)}…`);
  // A word ending exactly at the cut is kept whole.
  const exact = `${"abcd ".repeat(15)}abcd ${"z".repeat(10)}`;
  assert.equal(shortTitle(exact), `${"abcd ".repeat(15)}abcd…`);
  assert.equal(shortTitle(exact).length, TITLE_MAX);
});

test("itemText: a title that fits is kept, one long text becomes the brief with a derived title, a long title beside a brief is refused", () => {
  const LONG = `Short titles for tasks (from Pullboard): ${"the whole brief ".repeat(10)}`.trim();
  assert.deepEqual(itemText("Short titles", undefined), { title: "Short titles", brief: null, derived: false });
  assert.deepEqual(itemText("Short titles", LONG), { title: "Short titles", brief: LONG, derived: false });
  // What an older CLI sends: the whole text as the title.
  assert.deepEqual(itemText(LONG, undefined), { title: "Short titles for tasks", brief: LONG, derived: true });
  // A brief alone gives the title too; a brief equal to the title is none.
  assert.deepEqual(itemText("", LONG), { title: "Short titles for tasks", brief: LONG, derived: true });
  assert.deepEqual(itemText("Same", "Same"), { title: "Same", brief: null, derived: false });
  // Line breaks stay in a brief; the title is one line.
  assert.deepEqual(itemText("Two\nlines", "One\r\nTwo\u0007"), { title: "Two lines", brief: "One\nTwo", derived: false });
  assert.throws(() => itemText("x".repeat(TITLE_MAX + 1), "rest"), /a title is at most 80 characters; put the rest in the brief/);
  assert.throws(() => itemText(" ", undefined), /an item needs a title/);
  assert.throws(() => itemText("t", "x".repeat(BRIEF_MAX + 1)), /a brief is at most 4000 characters/);
});

test("itemFields reads the acceptance criteria and the brief: at most 12 criteria of 300 characters, an empty list or null clears", () => {
  assert.deepEqual(itemFields({ accept: [" one ", "two\nlines"], brief: " text " }), { accept: ["one", "two lines"], brief: "text" });
  assert.deepEqual(itemFields({ accept: [], brief: null }), { accept: [], brief: null });
  assert.deepEqual(itemFields({ brief: "  " }), { brief: null });
  assert.equal(itemFields({ accept: Array(ACCEPT_COUNT).fill("x") }).accept?.length, ACCEPT_COUNT);
  for (const [input, why] of [
    [{ accept: "one" }, /accept must be a list of strings with something in each/],
    [{ accept: ["ok", " "] }, /accept must be a list of strings with something in each/],
    [{ accept: Array(ACCEPT_COUNT + 1).fill("x") }, /accept holds at most 12 criteria/],
    [{ accept: ["x".repeat(FIELD_MAX + 1)] }, /each accept entry is at most 300 characters/],
    [{ brief: 7 }, /brief must be text or null/],
  ] as const) assert.throws(() => itemFields(input as Record<string, unknown>), why, JSON.stringify(input).slice(0, 40));
});

test("the agents' briefs carry the whole text: the runner's job brief and atelier start print the brief and the criteria", () => {
  const item = { id: "t3", title: "Short titles", brief: "Every list shows the short title.\nThe brief stays on the page.", accept: ["Lists show the short title", "The brief is on the page"], scope: ["src/**"], owner: "codex/gpt-6" };
  const job = briefFor(item, "demo");
  assert.ok(job.includes("Title: Short titles\nBrief: Every list shows the short title. The brief stays on the page.\nAcceptance criterion 1 (a change that fails one is rejected in review): Lists show the short title\nAcceptance criterion 2 (a change that fails one is rejected in review): The brief is on the page\nScope path: src/**"), job);
  assert.ok(!briefFor({ ...item, brief: null, accept: [] }, "demo").includes("Brief:"));
  assert.equal(formatTask(item), "Short titles\nBrief: Every list shows the short title. The brief stays on the page.\nScope: src/**\nAcceptance criterion 1: Lists show the short title\nAcceptance criterion 2: The brief is on the page");
});
