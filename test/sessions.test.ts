import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSession, stateFile, handoffNotes, staleState, fileExcerpt, sessionNoteText, wrapRelay, sessionCommitMessage, WRAP_MARKERS, unmergedPaths, wrapRefusal, failingChecksRefusal, failingChecksOverridden } from "../src/sessions.ts";

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
test("PROJECT.md is the state file only when neither STATE file exists", () => {
  assert.equal(stateFile(["PROJECT.md"]), "PROJECT.md");
  assert.equal(stateFile(["STATE.md", "PROJECT.md"]), "STATE.md");
  assert.equal(stateFile(["docs/STATE.md", "STATE.md", "PROJECT.md"]), "docs/STATE.md");
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

const note = (pushes: { remote: string; passed: boolean }[] | undefined, passed = true) =>
  ({ actor: "owner", at: "2026-10-05T12:00:00Z", data: { ...cleanSession({ ...input, checks: [{ command: "npm test", passed }], pushes }) } });

test("the relay line names each failed push and a failing check, and says nothing is wrong when nothing is", () => {
  assert.equal(wrapRelay(note(undefined)), "Relay: session closed; checks are Reported, not Observed.");
  assert.equal(wrapRelay(note([{ remote: "github", passed: true }])), "Relay: session closed; checks are Reported, not Observed.");
  assert.equal(wrapRelay(note([{ remote: "github", passed: true }, { remote: "nas", passed: false }])), "Relay: session closed with a failed push to nas.");
  assert.equal(wrapRelay(note([{ remote: "github", passed: false }, { remote: "nas", passed: false }, { remote: "origin", passed: true }])), "Relay: session closed with failed pushes to github, nas.");
  assert.equal(wrapRelay(note([{ remote: "nas", passed: false }], false)), "Relay: session closed with a failing check and a failed push to nas.");
  assert.equal(wrapRelay(note(undefined, false)), "Relay: session closed with a failing check.");
  assert.equal(wrapRelay(note([{ remote: "bad\u202e\nname", passed: false }])), "Relay: session closed with a failed push to bad name.", "a remote's name is cleaned like any text");
});

test("an override records the failed checks it let through, cleaned and bounded, and the note and relay name it", () => {
  const data = cleanSession({ ...input, checksOverridden: ["npm test‮", " tsc "] });
  assert.deepEqual(data.checksOverridden, ["npm test", "tsc"]);
  assert.equal(cleanSession(input).checksOverridden, undefined, "absent unless given");
  for (const bad of [[], "npm test", [""], ["​"], [7], Array(101).fill("x")]) assert.throws(() => cleanSession({ ...input, checksOverridden: bad }), /overridden checks must name one to 100 commands/, JSON.stringify(bad));
  const overridden = { actor: "owner", at: "2026-10-05T12:00:00Z", data };
  assert.match(sessionNoteText(overridden), /^Failing checks overridden by --allow-failing: npm test, tsc\.$/m);
  assert.doesNotMatch(sessionNoteText({ ...overridden, data: cleanSession(input) }), /overridden/);
  assert.equal(wrapRelay(overridden), "Relay: session closed with a failing check overridden by --allow-failing.");
  assert.equal(wrapRelay({ ...overridden, data: { ...data, pushes: [{ remote: "nas", passed: false }] } }), "Relay: session closed with a failing check overridden by --allow-failing and a failed push to nas.");
});

test("the refusal and the override line name each failed check with how it ended", () => {
  const exited = { command: "npm test", status: 1, signal: null, timedOut: false };
  const killed = { command: "make‮ check", status: null, signal: "SIGKILL", timedOut: false };
  const late = { command: "slow", status: null, signal: "SIGTERM", timedOut: true };
  const absent = { command: "ghost", status: null, signal: null, timedOut: false };
  assert.equal(failingChecksRefusal([exited]), "wrap refuses to commit with a failing check: npm test (exited 1). Fix it, or run again with --allow-failing to commit anyway. Nothing was staged, recorded or pushed.");
  assert.equal(failingChecksRefusal([exited, killed, late, absent]), "wrap refuses to commit with 4 failing checks: npm test (exited 1), make check (ended by SIGKILL), slow (timed out), ghost (did not run). Fix them, or run again with --allow-failing to commit anyway. Nothing was staged, recorded or pushed.");
  assert.equal(failingChecksOverridden([exited, late]), "Failing checks overridden by --allow-failing: npm test (exited 1), slow (timed out).");
});

test("unmerged paths are read from the NUL separated index listing, each once", () => {
  assert.deepEqual(unmergedPaths(""), []);
  assert.deepEqual(unmergedPaths("100644 aaa 1\ta.txt\u0000100644 bbb 2\ta.txt\u0000100644 ccc 3\ta.txt\u0000100644 ddd 2\tdir/b c.txt\u0000"), ["a.txt", "dir/b c.txt"]);
  assert.deepEqual(unmergedPaths("100644 aaa 2\tname\nwith newline\u0000"), ["name\nwith newline"], "a path may hold anything but NUL");
});

test("wrap refuses an unfinished checkout and says which kind", () => {
  const ready = { branch: "main", registered: "main", inProgress: [], unmerged: [] };
  assert.equal(wrapRefusal(ready), undefined);
  assert.equal(wrapRefusal({ ...ready, branch: "" }), "wrap refuses a detached HEAD");
  assert.equal(wrapRefusal({ ...ready, branch: "side" }), "check out main before wrap");
  for (const [marker, kind] of Object.entries(WRAP_MARKERS)) assert.equal(wrapRefusal({ ...ready, inProgress: [marker] }), `wrap refuses with ${kind} in progress; finish or abort it first`);
  assert.deepEqual(Object.keys(WRAP_MARKERS).sort(), ["CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD", "atelier-landing.json", "rebase-apply", "rebase-merge", "sequencer"]);
  assert.equal(wrapRefusal({ ...ready, inProgress: ["rebase-merge", "rebase-apply"] }), "wrap refuses with a rebase in progress; finish or abort it first");
  assert.equal(wrapRefusal({ ...ready, inProgress: ["MERGE_HEAD", "REVERT_HEAD"] }), "wrap refuses with a merge and a revert in progress; finish or abort them first");
  assert.match(wrapRefusal({ ...ready, unmerged: ["a.txt"] })!, /^wrap refuses with unmerged files: a\.txt; resolve each and git add it, or abort the operation, so no conflict marker is committed$/);
  assert.match(wrapRefusal({ ...ready, unmerged: ["a", "b", "c", "d", "e", "f", "g"] })!, /unmerged files: a, b, c, d, e and 2 more;/);
  assert.match(wrapRefusal({ ...ready, unmerged: ["a\nb"] })!, /unmerged files: a b;/, "a path is cleaned before it is printed");
  // The order of the reasons: a detached HEAD, unfinished work, conflicts, then the wrong branch.
  assert.equal(wrapRefusal({ branch: "", registered: "main", inProgress: ["MERGE_HEAD"], unmerged: ["a"] }), "wrap refuses a detached HEAD");
  assert.match(wrapRefusal({ branch: "side", registered: "main", inProgress: ["MERGE_HEAD"], unmerged: ["a"] })!, /a merge in progress/);
  assert.match(wrapRefusal({ branch: "side", registered: "main", inProgress: [], unmerged: ["a"] })!, /unmerged files/);
});
