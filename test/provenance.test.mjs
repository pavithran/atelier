import { test } from "node:test";
import assert from "node:assert/strict";
import { provenanceNote } from "../cli/provenance.mjs";

// t215: the provenance note `atelier merge` pushes to the public repository
// names who reviewed, the verdict, the head and who recorded it, and never
// the review note or the override reason, which stay in the ledger.

const H = "a".repeat(40);
const item = (over = {}) => ({ title: "Fix the gate", acceptedHead: H, ...over });

test("the note names each review's reviewer, verdict, head and recorder, without its text", () => {
  const note = provenanceNote({
    name: "atelier", id: "t9", item: item(),
    view: [{ grade: "observed", passed: true, claim: "npm test", by: "owner", at: "2026-10-06T12:00:00Z" }],
    reviews: [
      { by: "antigravity/gemini-3.1-pro", head: H, approve: true, note: "SECRET REVIEW TEXT", recordedBy: "pavi", proved: false, claimed: true },
      { by: "codex/gpt-6-astra", head: H, approve: false, note: "OTHER TEXT", recordedBy: "codex/gpt-6-astra", proved: true },
    ],
    events: [{ at: "2026-10-06T12:01:00Z", actor: "pavi", kind: "item.accepted", data: { note: "ACCEPT TEXT" } }],
  });
  assert.ok(note.includes(`REVIEW approve by antigravity/gemini-3.1-pro at ${H}, recorded by pavi with the developer's token, answering a claimed review request`), note);
  assert.ok(note.includes(`REVIEW reject by codex/gpt-6-astra at ${H}, recorded by codex/gpt-6-astra`), note);
  assert.ok(note.includes("2026-10-06T12:01:00Z pavi item.accepted"), note);
  for (const text of ["SECRET REVIEW TEXT", "OTHER TEXT", "ACCEPT TEXT"]) assert.ok(!note.includes(text), `the note carries ${text}`);
});

// t394: the note states the family mode in force at acceptance, as the
// acceptance recorded it, right after the accepted head, and lists each
// contributor with its company as recorded, so a single-family review is
// never read as a cross-company one and work done before a switch is never
// read as the current company's.
const anthropicOnly = { checks: [], protected: [], familyMode: { single: "anthropic", by: "pavi", at: "2026-10-09T10:00:00Z" } };
const sonnetApproval = { by: "claude-code/sonnet-5.5", head: H, approve: true, note: "", recordedBy: "claude-code/sonnet-5.5", proved: true };

test("under single-family mode the note names the company and says the review is not cross-company", () => {
  const note = provenanceNote({
    name: "atelier", id: "t9", item: item({ owner: "claude-code/opus-5.5" }), view: [], events: [], reviews: [sonnetApproval], policy: anthropicOnly,
    acceptanceFamily: { singleFamily: "anthropic", contributors: [{ actor: "claude-code/opus-5.5", company: "anthropic" }] },
  });
  const lines = note.split("\n");
  assert.equal(lines[1], `accepted head ${H}`);
  assert.equal(lines[2], "SINGLE-FAMILY MODE anthropic at acceptance: a review below counted when its reviewer was a different anthropic model from every contributor, not another company's model; contributors are listed with their companies as recorded");
  assert.equal(lines[3], "CONTRIBUTOR claude-code/opus-5.5 (anthropic)");
  assert.ok(lines[4].startsWith("REVIEW approve by claude-code/sonnet-5.5"), note);
});

test("work contributed before a switch keeps its own company in the note", () => {
  // The review's case: GPT and Opus contributed, the project then switched
  // to Anthropic only, and a Sonnet approval let the change through.
  const note = provenanceNote({
    name: "atelier", id: "t9", item: item({ owner: "claude-code/opus-5.5", pushActors: ["codex/gpt-6-astra"] }), view: [], events: [], reviews: [sonnetApproval], policy: anthropicOnly,
    acceptanceFamily: { singleFamily: "anthropic", contributors: [{ actor: "codex/gpt-6-astra", company: "openai" }, { actor: "claude-code/opus-5.5", company: "anthropic" }] },
  });
  assert.ok(note.includes("CONTRIBUTOR codex/gpt-6-astra (openai)"), note);
  assert.ok(note.includes("CONTRIBUTOR claude-code/opus-5.5 (anthropic)"), note);
  assert.ok(!/models only|building and reviewing used/.test(note), note);
});

test("the note states the mode at acceptance, not the mode at merge", () => {
  const input = { name: "atelier", id: "t9", item: item({ owner: "codex/gpt-6-astra" }), view: [], reviews: [sonnetApproval] };
  // Accepted under the default, then the project switched to Anthropic only.
  const recorded = provenanceNote({ ...input, events: [], policy: anthropicOnly, acceptanceFamily: { singleFamily: null, contributors: [{ actor: "codex/gpt-6-astra", company: "openai" }] } });
  assert.equal(recorded.split("\n")[2], "CROSS-FAMILY MODE at acceptance: a protected change needed approval from a model of another company than every contributor");
  assert.ok(!recorded.includes("SINGLE-FAMILY"), recorded);
  // An older acceptance that recorded no mode: the switch's time tells.
  const accepted = (at) => [{ at, actor: "pavi", kind: "item.accepted", data: { head: H } }];
  const before = provenanceNote({ ...input, events: accepted("2026-10-09T09:00:00Z"), policy: anthropicOnly });
  assert.ok(before.split("\n")[2].startsWith("FAMILY MODE at acceptance not recorded"), before);
  const after = provenanceNote({ ...input, events: accepted("2026-10-09T11:00:00Z"), policy: anthropicOnly });
  assert.ok(after.split("\n")[2].startsWith("SINGLE-FAMILY MODE anthropic at acceptance"), after);
  // Without a recorded list, each contributor's company is read from its name.
  assert.ok(after.includes("CONTRIBUTOR codex/gpt-6-astra (openai)"), after);
  // The default, and a recorded return to it, state cross-family mode.
  for (const policy of [undefined, { checks: [], protected: [] }, { checks: [], protected: [], familyMode: { single: null, by: "pavi", at: "2026-10-09T10:00:00Z" } }]) {
    const note = provenanceNote({ ...input, events: accepted("2026-10-09T11:00:00Z"), ...(policy ? { policy } : {}) });
    assert.ok(note.split("\n")[2].startsWith("CROSS-FAMILY MODE at acceptance"), note);
  }
});

test("an override at the accepted head is named without its reason", () => {
  const note = provenanceNote({
    name: "atelier", id: "t9", item: item({ reviewOverride: { head: H, by: "pavi", reason: "PRIVATE REASON", at: "2026-10-06T12:00:00Z" } }),
    view: [], reviews: [], events: [],
  });
  assert.ok(note.includes(`REVIEW OVERRIDDEN by pavi at ${H}`), note);
  assert.ok(!note.includes("PRIVATE REASON"), note);
});

// t150: the tree the checks passed on, which the landing receipt carried (t708),
// is stated by the note now, only when the caller measured one.
test("the note states the checked tree when the merge produced the tree the checks passed on, and says nothing otherwise", () => {
  const tree = "b".repeat(40);
  const base = { name: "atelier", id: "t9", item: item(), view: [], reviews: [], events: [{ at: "2026-10-06T12:01:00Z", actor: "pavi", kind: "item.accepted", data: {} }] };
  const note = provenanceNote({ ...base, checkedTree: { tree, claims: ["npm test", "npm run typecheck"] } });
  const lines = note.split("\n");
  assert.equal(lines.at(-2), `CHECKED TREE ${tree}: the merge produced exactly the tree these checks passed on (npm test, npm run typecheck), so a deploy gate may accept them instead of running them again`);
  assert.equal(lines.at(-1), "2026-10-06T12:01:00Z pavi item.accepted");
  assert.doesNotMatch(provenanceNote(base), /CHECKED TREE/);
  assert.doesNotMatch(provenanceNote({ ...base, checkedTree: null }), /CHECKED TREE/);
});
