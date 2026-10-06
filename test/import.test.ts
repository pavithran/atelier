import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsIn, buildImported, firstTaskAt, readImported, NO_AGENT, normaliseAgentName } from "../src/import/history.ts";
import { drawImported, laneColour } from "../src/import/draw.ts";

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
  assert.deepEqual(h.lanes.map((l) => [l.label, l.count]), [["opus-4.7", 2], ["opus-5", 1], [NO_AGENT, 1]]);
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

test("the name is the text before the email, or after it when nothing comes before; capped by code points after the agent test", () => {
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: <a@b.c> Claude Opus 5.5"), ["Claude Opus 5.5"], "an email that comes first does not take the name with it");
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: Claude Opus 5.5 <a@b.c> do not publish"), ["Claude Opus 5.5"]);
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: Claude\u202e Opus\u200b 5.5 <a@b.c>"), ["Claude Opus 5.5"]);
  assert.deepEqual(agentsIn(`x\n\nAgent: ${"a".repeat(41)}9`), ["a".repeat(40)], "a digit after the cap still gets the name kept");
  const [emoji] = agentsIn(`x\n\nAgent: claude ${"🤖".repeat(21)}`);
  assert.equal(emoji, `claude ${"🤖".repeat(21)}`, "an emoji is not cut in half at the cap");
  const [long] = agentsIn(`x\n\nAgent: codex/${"g".repeat(1200)}`);
  assert.equal(long.length, 40);
  const svg = drawImported(buildImported([c("a", 1, `x\n\nAgent: codex/${"g".repeat(60)}`)], null, true), "pavi", "Demo");
  assert.match(svg, /…<title>g+, version not recorded \(as the commits name it: codex\/g+\)<\/title>/, "a long name is cut in the lane and shown whole on hover");
  assert.match(svg, /aria-label="Demo before Atelier: 1 commit, 1 naming an agent"/);
});

// Task t158 (security pass 2, finding 7): a co-author address written
// without angle brackets became a lane, a digit or a model's name in it
// being enough, and was drawn on the public showcase.
test("an address without angle brackets is no name, and is never drawn", () => {
  for (const trailer of ["jane2@private.example", "claude@private.example", "1234567+jdoe@users.noreply.github.com", "Jane Doe 2 @ private.example", "jane2\u200b@private.example"]) {
    assert.deepEqual(agentsIn(`x\n\nCo-Authored-By: ${trailer}`), [], trailer);
  }
  // The address goes; a model's name beside it stays.
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: Claude Opus 5.5 claude@private.example"), ["Claude Opus 5.5"]);
  assert.deepEqual(agentsIn("x\n\nAgent: codex/gpt-6-astra (codex@private.example)"), ["codex/gpt-6-astra"]);
  const h = buildImported([c("a", 1, "x\n\nCo-Authored-By: jane2@private.example"), c("b", 2, "y\n\nCo-Authored-By: Claude Opus 5.5 1234567+jdoe@users.noreply.github.com")], null, true);
  assert.deepEqual(h.lanes.map((l) => [l.label, l.names]), [["opus-5.5", ["Claude Opus 5.5"]], [NO_AGENT, []]]);
  assert.ok(!drawImported(h, "pavi", "Demo").includes("@"));
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

test("a person named before the email stays a person, whatever follows the email; a lane label is cut by characters", () => {
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: Jane Doe <jane@example.com> reviewed PR #42"), []);
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: Jane Doe <jane@example.com> https://example.com/u/7"), []);
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: <a@b.c> Claude Opus 5.5"), ["Claude Opus 5.5"]);
  assert.deepEqual(agentsIn("x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com> (1M context)"), ["Claude Opus 5.5"]);
  const label = `codex/${"🤖".repeat(21)}`;
  const svg = drawImported(buildImported([c("a", 1, `x\n\nAgent: ${label}`)], null, true), "pavi", "Demo");
  const shown = /<text class="imp-name"[^>]*>([^<]*)</.exec(svg)?.[1] ?? "";
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(shown), "no half of an emoji is drawn");
  assert.ok(shown.endsWith("…"));
});

test("a baseline's own root is not the project's work, and its history is never complete", () => {
  const root = { hash: "r", committedAt: 50, message: `Atelier baseline: history from 2026-09-05, starting at ${"a".repeat(40)}\n\nAtelier-Fresh-History: ${"a".repeat(40)}\n` };
  const h = buildImported([c("b", 100, "x\n\nCo-Authored-By: Claude Opus 4.7 <x>"), root], null, true);
  assert.equal(h.total, 1);
  assert.equal(h.complete, false);
  assert.equal(buildImported([c("b", 100, "x")], null, true).complete, true);
});

test("agent name normalisation", () => {
  assert.equal(normaliseAgentName("Claude Opus 5.5"), "opus-5.5");
  assert.equal(normaliseAgentName("Claude Fable 5.1"), "fable-5.1");
  assert.equal(normaliseAgentName("GPT-5.5"), "gpt-5.5");
  assert.equal(normaliseAgentName("Gemini 3.1 Pro"), "gemini-3.1-pro");
  assert.equal(normaliseAgentName("Claude Opus"), "opus, version not recorded");
  assert.equal(normaliseAgentName("GLM"), "glm, version not recorded");
  assert.equal(normaliseAgentName("Codex"), "codex, model not recorded");
  assert.equal(normaliseAgentName("codex/gpt-6-astra"), "gpt-6-astra");
  assert.equal(normaliseAgentName(NO_AGENT), NO_AGENT);
});


test("a commit naming one model twice counts once in its lane, and keeps both names", () => {
  const h = buildImported([c("a", 100, "one\n\nCo-Authored-By: claude-code/opus-5.5 <x>\nCo-Authored-By: Claude Opus 5.5 <y>")], null, true);
  assert.deepEqual(h.lanes.map((l) => [l.label, l.count, l.names]), [["opus-5.5", 1, ["claude-code/opus-5.5", "Claude Opus 5.5"]]]);
  assert.equal(h.attributed, 1);
});

test("a normalised lane keeps its family's colour", () => {
  for (const [label, family] of [["fable-5.1", "anthropic"], ["opus, version not recorded", "anthropic"], ["opus-5.5", "anthropic"],
    ["glm, version not recorded", "zai"], ["gpt-6-astra", "openai"], ["gemini-3.1-pro", "google"]]) {
    assert.equal(laneColour(label, "pavi"), `var(--m-${family})`, label);
  }
});
