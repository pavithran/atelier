import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSession, stateFile, handoffNotes, staleState, fileExcerpt, sessionNoteText, wrapRelay, sessionCommitMessage } from "../src/sessions.ts";

const input = { summary: "A\nB\u202e\u200bC", next: "x".repeat(3000), head: "a".repeat(40), dirty: true, checks: [{ command: "npm test", passed: false, grade: "observed" }] };
test("session text is cleaned, capped and always reported", () => {
  const note = cleanSession(input);
  assert.equal(note.summary, "A B C");
  assert.equal(note.next.length, 2000);
  assert.equal(cleanSession({ ...input, summary: input.next }).summary.length, 2000);
  assert.equal(note.checks[0].grade, "reported");
  assert.throws(() => cleanSession({ ...input, summary: "\u200b" }));
  assert.throws(() => cleanSession({ ...input, checks: Array(101).fill(input.checks[0]) }));
  assert.throws(() => cleanSession({ ...input, head: "bad" }));
});
test("state precedence and dated or named handoffs", () => {
  assert.equal(stateFile(["STATE.md", "docs/STATE.md"]), "docs/STATE.md");
  assert.equal(stateFile([]), undefined);
  assert.equal(stateFile(["STATE.md"]), "STATE.md");
  assert.deepEqual(handoffNotes("Read docs/HANDOFF-2026-09-01.md", ["docs/HANDOFF-2026-09-01.md", "docs/handoffs/2026-10-04.md", "docs/handoffs/2026-10-06.md", "docs/handoffs/undated.md", "docs/handoffs/../2026-10-07.md"], "2026-10-05T12:00:00Z"), ["docs/handoffs/2026-10-06.md", "docs/HANDOFF-2026-09-01.md"]);
});
test("staleness needs a file, previous head and unchanged contents", () => {
  assert.match(staleState("STATE.md", input.head, true), /Refresh STATE.md/);
  assert.equal(staleState("STATE.md", input.head, false), "");
  assert.equal(staleState(undefined, input.head, true), "");
  assert.equal(staleState("STATE.md", undefined, true), "");
});
test("printed note, failure relay and bounded excerpts", () => {
  const note = { actor: "codex/gpt-6-astra", at: "2026-10-05T12:00:00Z", data: cleanSession(input) };
  assert.match(sessionNoteText(note), /Reported: npm test: failed/);
  assert.match(sessionNoteText(note), /Next: x/);
  assert.match(wrapRelay(note), /closed with a failing check/);
  assert.equal(sessionNoteText(), "No session note recorded.");
  assert.equal(fileExcerpt("STATE.md", "a\nb\nc", 2), "STATE.md:\na\nb\nRead the rest in STATE.md, from line 3.");
});

test("a dated handoff changed later on the same day is newer", () => {
  const path = "docs/handoffs/2026-10-05-note.md";
  assert.deepEqual(handoffNotes("", [path], "2026-10-05T12:00:00Z", { [path]: "2026-10-05T13:00:00Z" }), [path]);
  assert.deepEqual(handoffNotes("", [path], "2026-10-05T12:00:00Z", { [path]: "2026-10-05T11:00:00Z" }), []);
});

test("session metadata is bounded, cleaned and excludes content", () => {
  const data = cleanSession({ ...input, sessionAt: "2026-10-05T12:00:00.000Z", commit: input.head,
    pushes: [{ remote: "origin\n" + "x".repeat(300), passed: false, output: "private output" }], found: ["t1"], prompt: "private", transcript: "private", files: "private" });
  assert.equal(data.pushes?.[0].remote.length, 200);
  assert.equal(JSON.stringify(data).includes("private"), false);
  assert.throws(() => cleanSession({ ...input, pushes: Array(101).fill({ remote: "x", passed: true }) }));
  assert.throws(() => cleanSession({ ...input, found: ["t1\nsecret"] }));
  assert.throws(() => cleanSession({ ...input, commit: "not a hash" }));
  assert.throws(() => cleanSession({ ...input, sessionAt: "unbounded" }));
  assert.equal(sessionCommitMessage("Summary\nclean", "Next\nstep", "2026-10-05T12:00:00.000Z"), "Summary clean\n\nNext step\n\nAtelier-Session: 2026-10-05T12:00:00.000Z\n");
});
