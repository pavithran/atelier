import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsIn, buildImported, firstTaskAt, readImported, NO_AGENT } from "../src/import/history.ts";
import { drawImported } from "../src/import/draw.ts";

test("agents are read from Co-Authored-By and Agent lines; a parenthesised variant of one name is that name", () => {
  assert.deepEqual(agentsIn("Fix it\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"), ["Claude Opus 4.7"]);
  assert.deepEqual(agentsIn("x\n\nAgent: codex/gpt-6-astra\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"), ["codex/gpt-6-astra", "Claude Opus 5.5"]);
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: Jane Doe <jane@example.com>"), [], "a person is not an agent");
  assert.deepEqual(agentsIn("Mentions Co-Authored-By: in the subject only"), []);
});

const c = (hash: string, t: number, message: string) => ({ hash, committedAt: t, message, parents: [] as string[] });

test("commits before the cutoff are grouped by agent, oldest agent first, with no agent last", () => {
  const h = buildImported([
    c("a", 100, "one\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <x>"),
    c("b", 200, "two\n\nCo-Authored-By: Claude Opus 4.7 <x>"),
    c("d", 300, "three"),
    c("e", 400, "four\n\nCo-Authored-By: Claude Opus 5 <x>"),
    c("f", 900, "after Atelier\n\nCo-Authored-By: Claude Opus 5.5 <x>"),
  ], 500, true);
  assert.equal(h.total, 4);
  assert.equal(h.attributed, 3);
  assert.deepEqual(h.lanes.map((l) => [l.label, l.count]), [["Claude Opus 4.7", 2], ["Claude Opus 5", 1], [NO_AGENT, 1]]);
  assert.deepEqual([h.first, h.last], [100, 400]);
});

test("the log is read in pages of 1,000 up to the limit, and says whether it reached the start", async () => {
  const all = Array.from({ length: 2500 }, (_, i) => c(`h${i}`, 10_000 - i, `m${i}`));
  const calls: unknown[] = [];
  const source = { log: async (o: { limit?: number; offset?: number }) => { calls.push(o); return all.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 50)); } };
  const whole = await readImported(source, null, 3000);
  assert.deepEqual([whole.total, whole.complete, calls.length], [2500, true, 3]);
  assert.ok(calls.every((o) => !("ref" in (o as object))), "the head is read without a ref, as Artifacts requires");
  const cut = await readImported(source, null, 2000);
  assert.deepEqual([cut.total, cut.complete], [2000, false]);
});

test("the drawing escapes agent names and draws only names, counts and times", () => {
  const h = buildImported([c("a", 100, "secret subject\n\nCo-Authored-By: Claude \"Opus\" & 9 <x>"), c("b", 200, "another secret")], null, true);
  const svg = drawImported(h, "pavi", "Demo");
  assert.match(svg, /Claude &quot;Opus&quot; &amp; 9/);
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: Claude <b>Opus</b> 9 <x>"), ["Claude Opus 9"], "anything in angle brackets is dropped with the email");
  assert.ok(!svg.includes("secret subject") && !svg.includes("another secret"));
  assert.equal(drawImported(buildImported([], null, true), "pavi", "Demo"), "");
});

test("the email goes and the text on either side of it stays; the name is capped by code points after the agent test", () => {
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: <a@b.c> Claude Opus 5.5"), ["Claude Opus 5.5"], "an email that comes first does not take the name with it");
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: Claude Opus 5.5 <a@b.c> do not publish"), ["Claude Opus 5.5 do not publish"]);
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: Claude\u202e Opus\u200b 5.5 <a@b.c>"), ["Claude Opus 5.5"]);
  assert.deepEqual(agentsIn(`x\n\nAgent: ${"a".repeat(41)}9`), ["a".repeat(40)], "a digit after the cap still gets the name kept");
  const [emoji] = agentsIn(`x\n\nAgent: claude ${"🤖".repeat(21)}`);
  assert.equal(emoji, `claude ${"🤖".repeat(21)}`, "an emoji is not cut in half at the cap");
  const [long] = agentsIn(`x\n\nAgent: codex/${"g".repeat(1200)}`);
  assert.equal(long.length, 40);
  const svg = drawImported(buildImported([c("a", 1, `x\n\nAgent: codex/${"g".repeat(60)}`)], null, true), "pavi", "Demo");
  assert.match(svg, /…<title>codex\/g+<\/title>/, "a long name is cut in the lane and shown whole on hover");
  assert.match(svg, /aria-label="Demo before Atelier: 1 commit, 1 naming an agent"/);
});

test("the cutoff is the first task created, however long the event record", () => {
  assert.equal(firstTaskAt([]), null);
  assert.equal(firstTaskAt([{ createdAt: "2026-10-02T00:00:00Z" }, { createdAt: "2026-09-30T12:00:00Z" }]), Date.parse("2026-09-30T12:00:00Z") / 1000);
  assert.equal(firstTaskAt([{ createdAt: "not a date" }, { createdAt: "2026-09-30T12:00:00Z" }]), Date.parse("2026-09-30T12:00:00Z") / 1000, "an unparseable date is skipped");
  assert.equal(firstTaskAt([{ createdAt: "not a date" }]), null, "no parseable date means no first task");
});

test("a drawing of a history cut short says it shows the most recent part", () => {
  const h = buildImported([c("a", 100, "m\n\nCo-Authored-By: Claude Opus 9 <x>")], null, false);
  assert.match(drawImported(h, "pavi", "Demo"), /aria-label="Demo before Atelier: 1 commit, 1 naming an agent \(the most recent part of the history\)"/);
  const whole = buildImported([c("a", 100, "m\n\nCo-Authored-By: Claude Opus 9 <x>")], null, true);
  assert.match(drawImported(whole, "pavi", "Demo"), /aria-label="Demo before Atelier: 1 commit, 1 naming an agent"/);
});
