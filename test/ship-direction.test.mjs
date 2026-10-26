import { test } from "node:test";
import assert from "node:assert/strict";
import { formatApprovals, formatPlan } from "../cli/ship.mjs";

// How atelier approvals and the ship plan show an approval given on the
// developer's direction: the quote and acting fields, in the one wording
// every surface uses (directionText in src/rules.ts).

const HEAD = "a".repeat(40);
const FUTURE = "2999-01-01T00:00:00.000Z";
const base = { id: "a1", kind: "deploy", commit: HEAD, note: "", by: "owner", at: "2026-10-26T10:00:00.000Z", expiresAt: FUTURE, status: "active" };
const said = { quote: "yes, deploy it", acting: "claude-code/opus-5.5" };
const WORDS = "the developer's words: \u201cyes, deploy it\u201d, relayed by claude-code/opus-5.5";

test("atelier approvals shows the developer's words and the acting model, and nothing for a plain approval", () => {
  const line = formatApprovals([{ ...base, ...said }]);
  assert.ok(line.endsWith(`  ${WORDS}`), line);
  assert.doesNotMatch(formatApprovals([base]), /developer's words/);
});

test("the ship plan shows the words beside the approval a step uses", () => {
  const plan = { source: "ship.json", steps: [{ step: "deploy", runs: [{ label: "make deploy", kind: "deploy" }] }], notes: [], problems: [] };
  const show = (approvals) => formatPlan({ name: "demo", plan, branch: "main", head: HEAD, commit: HEAD, approvals, push: false, target: null });
  assert.match(show([{ ...base, ...said }]), new RegExp(`\\[deploy: approved as a1 until [^;\\]]+; ${WORDS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
  assert.match(show([base]), /\[deploy: approved as a1 until [^;\]]+\]/);
  assert.doesNotMatch(show([base]), /developer's words/);
});
