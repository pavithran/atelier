import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanDecisionInput, DECISION_TEXT_MAX, DECISIONS_RULE, decisionLines, decisionsSection, NO_DECISIONS } from "../src/decisions.ts";
import { reviewBrief } from "../src/review/brief.ts";
import { reviewNeeded, type ReviewRequired } from "../src/review/needed.ts";
import type { Evidence, Item, ProjectPolicy } from "../src/rules.ts";
import { agentRoute } from "../src/tokens.ts";
import { formatDecisions } from "../cli/atelier.mjs";

// Standing decisions (t377, src/decisions.ts): the rules on what one says,
// the one way the briefs, the guide and the CLI print them, and the review
// brief's section marking them as decisions a reviewer must not overrule.

const AT = "2026-10-09T10:00:00.000Z";
const d1 = { id: "d1", text: "Another company reviews every change.", quote: "another company reviews everywhere", at: AT };
const d2 = { id: "d2", text: "No review is overridden.", quote: "no overrides", at: "2026-10-10T09:30:00.000Z" };

test("cleanDecisionInput keeps the decision and the owner's words to one line each, and refuses either missing", () => {
  assert.deepEqual(cleanDecisionInput({ text: "  Another company\nreviews\t every change. ", quote: " another company " }), {
    text: "Another company reviews every change.", quote: "another company",
  });
  const refused = (body: Record<string, unknown>, code: string, detail: RegExp) => {
    assert.throws(() => cleanDecisionInput(body), (e: Error & { code?: string }) => { assert.equal(e.code, code); assert.match(e.message, detail); return true; });
  };
  refused({ quote: "words" }, "bad_decision", /needs text/);
  refused({ text: "   ", quote: "words" }, "bad_decision", /needs text/);
  refused({ text: 5, quote: "words" }, "bad_decision", /is text/);
  refused({ text: "Decided." }, "bad_quote", /owner's words/);
  refused({ text: "Decided.", quote: "\u0000" }, "bad_quote", /owner's words/);
  refused({ text: "Decided.", quote: ["x"] }, "bad_quote", /are text/);
  refused({ text: "x".repeat(DECISION_TEXT_MAX + 1), quote: "words" }, "too_long", /at most 1000/);
});

test("decisionLines and decisionsSection say each decision once, dated, with the owner's words", () => {
  assert.deepEqual(decisionLines([d1, d2]), [
    "- d1 (2026-10-09): Another company reviews every change. The owner's words: “another company reviews everywhere”",
    "- d2 (2026-10-10): No review is overridden. The owner's words: “no overrides”",
  ]);
  const section = decisionsSection([d1]);
  assert.ok(section.startsWith("## Standing decisions\n\n"));
  assert.ok(section.includes(DECISIONS_RULE));
  assert.match(DECISIONS_RULE, /a reviewer must not overrule one/);
  assert.ok(section.endsWith(decisionLines([d1])[0]));
  assert.ok(decisionsSection([]).endsWith(NO_DECISIONS));
});

// The brief's inputs, as test/review.test.ts builds them, reduced to what a
// standing-decisions section needs.
const H0 = "0".repeat(40), H2 = "b".repeat(40), T = "2026-10-05T12:00:00.000Z";
const GLM = "zcode/glm-5.3";
const item: Item = {
  id: "t21", title: "Review rules", scope: ["src/review/**"], state: "submitted", owner: GLM,
  fork: "p--t21", base: H0, head: H2, acceptedHead: null, pushActors: [GLM], createdAt: T, updatedAt: T, lastPushAt: T,
};
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md"] };
const pass: Evidence = { itemId: "t21", claim: "npm test", grade: "observed", head: H2, passed: true, by: "atelier/sandbox", at: T, changedPaths: ["src/review/needed.ts"], where: "sandbox" };
const need = (): ReviewRequired => {
  const n = reviewNeeded({ item, part: true, policy, evidence: [pass], reviews: [], now: new Date("2026-10-05T13:00:00.000Z"), owner: "pavi" });
  assert.ok(n.needed, n.reason);
  return n;
};
const brief = (decisions?: typeof d1[] | null) => reviewBrief({ need: need(), item, events: [], owner: "pavi", decisions });

test("reviewBrief carries the standing decisions outside any fence, marked as not to be overruled, before the rules for blocking", () => {
  const text = brief([d1, d2]);
  const at = text.indexOf("## Standing decisions");
  assert.ok(at > 0);
  assert.ok(at < text.indexOf("## Rules for blocking"));
  assert.ok(text.includes(`## Standing decisions\n\n${DECISIONS_RULE}\n\n${decisionLines([d1, d2]).join("\n")}\n\n## Rules for blocking`));
  assert.ok(text.includes('A standing decision under "Standing decisions" is the project owner\'s and not open to review: a finding that contests one is neither blocking nor a follow-up.'));
  // With none recorded, or an older server sending none, the brief says so.
  for (const none of [[], null, undefined]) assert.ok(brief(none).includes(`## Standing decisions\n\n${DECISIONS_RULE}\n\n${NO_DECISIONS}\n\n`));
  // A control character in a decision is shown, never hidden.
  const shown = brief([{ ...d1, text: "Reviews​ everywhere." }]);
  assert.ok(shown.includes("Reviews<U+200B> everywhere."));
});

test("an agent token reads a project's decisions and writes none", () => {
  assert.equal(agentRoute("GET", ["projects", "p", "decisions"]), true);
  assert.equal(agentRoute("POST", ["projects", "p", "decisions"]), false);
  assert.equal(agentRoute("POST", ["projects", "p", "decisions", "d1", "withdraw"]), false);
  assert.equal(agentRoute("GET", ["projects", "p", "decisions", "d1"]), false);
});

test("formatDecisions prints each decision as the briefs say it, and a withdrawn one with when and why", () => {
  const gone = { ...d2, withdrawn: { by: "owner", at: "2026-10-11T08:00:00.000Z", note: "the owner allows one override" } };
  assert.equal(formatDecisions([d1, gone]), [
    decisionLines([d1])[0],
    `${decisionLines([d2])[0]} Withdrawn 2026-10-11: the owner allows one override`,
  ].join("\n"));
});
