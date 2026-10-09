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
  assert.ok(note.includes(`REVIEW approve by antigravity/gemini-3.1-pro at ${H}, recorded by pavi with the owner token, answering a claimed review request`), note);
  assert.ok(note.includes(`REVIEW reject by codex/gpt-6-astra at ${H}, recorded by codex/gpt-6-astra`), note);
  assert.ok(note.includes("2026-10-06T12:01:00Z pavi item.accepted"), note);
  for (const text of ["SECRET REVIEW TEXT", "OTHER TEXT", "ACCEPT TEXT"]) assert.ok(!note.includes(text), `the note carries ${text}`);
});

// t394: a project on one company's models says so in the note, right after
// the accepted head, so its review is never read as a cross-company one.
test("under single-family mode the note names the company and says the review is not cross-company", () => {
  const input = {
    name: "atelier", id: "t9", item: item(),
    view: [], events: [],
    reviews: [{ by: "claude-code/sonnet-5.5", head: H, approve: true, note: "", recordedBy: "claude-code/sonnet-5.5", proved: true }],
  };
  const single = provenanceNote({ ...input, policy: { checks: [], protected: [], familyMode: { single: "anthropic", by: "pavi", at: "2026-10-09T10:00:00Z" } } });
  const lines = single.split("\n");
  assert.equal(lines[1], `accepted head ${H}`);
  assert.equal(lines[2], "SINGLE-FAMILY MODE anthropic: building and reviewing used anthropic models only; a review below is by a different anthropic model than every contributor, not by another company's model");
  assert.ok(lines[3].startsWith("REVIEW approve by claude-code/sonnet-5.5"), single);
  // The default, and a recorded return to it, say nothing of a mode.
  for (const policy of [undefined, { checks: [], protected: [] }, { checks: [], protected: [], familyMode: { single: null, by: "pavi", at: "2026-10-09T10:00:00Z" } }]) {
    const note = provenanceNote({ ...input, ...(policy ? { policy } : {}) });
    assert.ok(!note.includes("SINGLE-FAMILY"), note);
    assert.equal(note.split("\n")[2], `REVIEW approve by claude-code/sonnet-5.5 at ${H}, recorded by claude-code/sonnet-5.5`);
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
