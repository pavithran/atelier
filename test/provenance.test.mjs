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

test("an override at the accepted head is named without its reason", () => {
  const note = provenanceNote({
    name: "atelier", id: "t9", item: item({ reviewOverride: { head: H, by: "pavi", reason: "PRIVATE REASON", at: "2026-10-06T12:00:00Z" } }),
    view: [], reviews: [], events: [],
  });
  assert.ok(note.includes(`REVIEW OVERRIDDEN by pavi at ${H}`), note);
  assert.ok(!note.includes("PRIVATE REASON"), note);
});
