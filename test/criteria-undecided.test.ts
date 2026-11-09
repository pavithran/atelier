import { test } from "node:test";
import assert from "node:assert/strict";
import { criteriaReviewBrief, CRITERIA_FAILURE_RULE, CRITERIA_SHARP_RULE } from "../src/review/criteria.ts";

// t535: the criteria brief makes the reviewer ask what a task does on a crash
// part-way, a retry, a repeated or concurrent call and a timeout, and reject
// absolutes, unsourced numbers and behaviours with no production entry point.
// The reviewer is a model, so these tests check what the brief it reads says
// and that the brief built from a fixture set tells it to reject with a named finding.

const briefFor = (title: string, accept: string[], brief = "") =>
  criteriaReviewBrief({ item: { id: "t9", title, brief, scope: ["src/**"], accept }, rev: 1, authors: ["owner"], plan: null, previous: [], resolutions: [], round: 1 });

// A fixture set for a task that sends a notification and writes a record,
// deciding the retry, repeat and timeout but not the crash.
const NOTIFY_UNDECIDED = [
  "When a task is submitted the owner is sent one notification through the notifier.",
  "A retry after a failed send sends it again, and a repeated call for the same task sends nothing new.",
  "A send that takes longer than 10 seconds is abandoned and recorded as failed.",
];

test("criterion 1: the brief asks a state-writing, sending, retrying or multi-process task what happens on crash, retry, repeat or concurrent call, and timeout", () => {
  const brief = briefFor("Notify on submit", NOTIFY_UNDECIDED, "Send a notification when a task is submitted.");
  assert.ok(brief.includes(CRITERIA_FAILURE_RULE));
  for (const trait of ["writes state", "sends anything", "retries", "spans more than one process or call"]) assert.ok(CRITERIA_FAILURE_RULE.includes(trait), trait);
  for (const asked of ["a crash part-way", "a retry", "a repeated or concurrent call", "a timeout"]) assert.ok(CRITERIA_FAILURE_RULE.includes(asked), asked);
  assert.match(CRITERIA_FAILURE_RULE, /or say why one does not apply/);
  assert.match(CRITERIA_FAILURE_RULE, /between sending and recording/);
});

test("criterion 2: a set leaving one of the four undecided is rejected with a blocking finding naming it", () => {
  const brief = briefFor("Notify on submit", NOTIFY_UNDECIDED);
  // The brief the criteria-review job sends carries the fixture set, numbered
  // as a finding names it, and the "Rules for blocking" section holding the rule.
  assert.ok(brief.includes("1. " + NOTIFY_UNDECIDED[0]));
  assert.ok(brief.includes("3. " + NOTIFY_UNDECIDED[2]));
  const rules = brief.slice(brief.indexOf("## Rules for blocking"), brief.indexOf("## Reply format"));
  assert.ok(rules.includes(CRITERIA_FAILURE_RULE));
  // The fixture decides retry, repeat and timeout; the crash is the gap, and
  // the rule tells the reviewer to reject with a blocking finding naming it.
  assert.ok(!/crash/i.test(NOTIFY_UNDECIDED.join(" ")));
  assert.match(rules, /undecided and unexplained, reject it with a blocking finding that names which behaviour \(crash, retry, repeat or concurrent call, or timeout\) is left open/);
  // Such a finding is a blocking one in the reply format, not a follow-up.
  assert.match(rules, /A blocking finding names the criterion \(criterion-N in the file slot, or criteria for the set as a whole\)/);
  assert.match(brief, /Reject only when there is at least one blocking finding/);
});

test("criterion 3: a task with none of those traits is not asked for them", () => {
  const brief = briefFor("Explain criteria in the docs", ["docs/criteria.md has a section on crash behaviour."], "A docs change.");
  assert.match(CRITERIA_FAILURE_RULE, /A task with none of these traits, such as a docs change or a pure function, is not asked for any of this and is never blocked for lacking it/);
  assert.ok(brief.includes(CRITERIA_FAILURE_RULE));
});

test("criterion 4: the brief rejects an impossible or unstated absolute, a number with no named source, and a behaviour with no named production entry point", () => {
  const brief = briefFor("Count deploys", ["Exactly one notification is sent.", "The count is computed from the ledger.", "Deploys are counted from a passed deploy step."]);
  assert.ok(brief.includes(CRITERIA_SHARP_RULE));
  assert.match(CRITERIA_SHARP_RULE, /absolute \(exactly, never, always\) whose strictest reading is impossible or unstated/);
  assert.match(CRITERIA_SHARP_RULE, /number or field with no named source that records it/);
  assert.match(CRITERIA_SHARP_RULE, /behaviour with no named production entry point/);
  // Each is a blocking ground, not a follow-up.
  assert.match(CRITERIA_SHARP_RULE, /^Also block for/);
});

test("criterion 5: the docs state the rule and give the notification example", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = readFileSync(new URL("../docs/criteria-review.md", import.meta.url), "utf8");
  for (const phrase of ["a crash part-way", "a retry", "a repeated or concurrent call", "a timeout", "blocking finding", "between sending and recording", "Exactly one notification", "no named production entry point|named production entry point"]) assert.match(doc, new RegExp(phrase.replace(/\s+/g, "\\s+")), phrase);
});
