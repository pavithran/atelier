import { test } from "node:test";
import assert from "node:assert/strict";
import { addTally, buildStory, drawStory, emptyTally, vendorOf, wrap } from "../src/graph.ts";

const OWNER = "pavi";
let seq = 0;
const ev = (itemId: string, actor: string, kind: string, data: Record<string, unknown> = {}) =>
  ({ seq: ++seq, itemId, at: `2026-10-04T10:${String(seq).padStart(2, "0")}:00.000Z`, actor, kind, data });
const item = (id: string, state: string) => ({ id, title: `Task ${id}`, state }) as never;

function night() {
  seq = 0;
  // Events arrive newest first, as the Ledger returns them.
  return [
    ev("t1", OWNER, "item.created"),
    ev("t2", OWNER, "item.created"),
    ev("t1", "claude-code/opus-5.5", "item.claimed"),
    ev("t1", "claude-code/opus-5.5", "fork.created"),
    ev("t1", "claude-code/opus-5.5", "push.observed", { head: "aaaaaaaa11" }),
    // Atelier's sandbox records its own checks, and its push events its own pushes.
    ev("t1", "atelier/sandbox", "evidence.observed", { claim: "npm test", passed: true, where: "sandbox" }),
    ev("t1", "claude-code/opus-5.5", "item.submitted", { head: "aaaaaaaa11" }),
    ev("t1", "zcode/glm-5.3", "review.rejected", { note: "Rule 2 filters too early" }),
    ev("t1", "atelier/events", "push.observed", { head: "bbbbbbbb22", source: "artifacts" }),
    ev("t1", "zcode/glm-5.3", "review.approved"),
    ev("t1", OWNER, "item.accepted", { head: "bbbbbbbb22" }),
    ev("t1", OWNER, "item.merged", { mergeCommit: "cccccccc33", head: "bbbbbbbb22" }),
    ev("t2", "codex/gpt-5.5", "item.claimed"),
    ev("t2", OWNER, "item.handoff", { from: "codex/gpt-5.5", to: "codex/gpt-6" }),
    ev("t2", "codex/gpt-6", "evidence.observed", { claim: "npm test", passed: false }),
  ].reverse();
}

test("each agent's family has a colour; the owner has their own", () => {
  assert.equal(vendorOf("claude-code/opus-5.5", OWNER), "anthropic");
  assert.equal(vendorOf("codex/gpt-6", OWNER), "openai");
  assert.equal(vendorOf("zcode/glm-5.3", OWNER), "zai");
  assert.equal(vendorOf("opencode/glm-5.3-flash", OWNER), "studio");
  assert.equal(vendorOf("pavi", OWNER), "owner");
  assert.equal(vendorOf("someone/else", OWNER), "other");
  // A family is recognised by name, so new releases are coloured on day one.
  assert.equal(vendorOf("codex/gpt-6.1-nova", OWNER), "openai");
  assert.equal(vendorOf("zcode/glm-5.4", OWNER), "zai");
  assert.equal(vendorOf("gemini-cli/gemini-3.1-pro", OWNER), "google");
  assert.equal(vendorOf("opencode/gemini-3.1-pro", OWNER), "google", "a cloud-only family through OpenCode keeps its own colour");
  assert.equal(vendorOf("opencode/deepseek-v4-flash", OWNER), "studio", "DeepSeek through OpenCode is home work: its family is not cloud-only (no local-build suffix here)");
  assert.equal(vendorOf("opencode/DeepSeek-V4-Flash-0731-MXFP4-MLX", OWNER), "studio", "a local build is home work");
  assert.equal(vendorOf("opencode/gemini-3.1-pro-mlx-4bit", OWNER), "studio", "a local build is home work even in a cloud-only family");
  assert.equal(vendorOf("someharness/deepseek-v4-pro", OWNER), "deepseek");
  assert.equal(vendorOf("someharness/qwen3.9-coder", OWNER), "qwen");
});

test("a story has a thread per claimed task, with who held it and how it ended", () => {
  const s = buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER);
  assert.deepEqual(s.threads.map((t) => t.id), ["t1", "t2"]);
  const [t1, t2] = s.threads;
  assert.equal(t1.ending, "merged");
  assert.equal(t1.merge?.sha, "cccccccc33");
  assert.deepEqual(t1.beads.map((b) => b.kind), ["push", "pass", "submit", "reject", "push", "approve", "accept"]);
  assert.equal(t2.end, null, "a task still held runs to now");
  assert.deepEqual(t2.holds.map((h) => h.who), ["codex/gpt-5.5", "codex/gpt-6"]);
  assert.ok(t1.start < t2.start);
});

test("the tally counts agents' moves apart from the owner's decisions", () => {
  const t = buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER).tally;
  assert.equal(t.decisions, 2, "an acceptance and a handoff; a merge and task creation are not decisions");
  assert.equal(t.agentMoves, 7, "everything agents did except opening a fork; Atelier's own records are not moves");
  assert.equal(t.checks, 2);
  assert.equal(t.inCloud, 1);
  assert.equal(t.sentBack, 1);
  assert.deepEqual(t.agents, ["claude-code/opus-5.5", "zcode/glm-5.3", "codex/gpt-5.5", "codex/gpt-6"]);
  assert.equal(t.byVendor.anthropic, 3);
  assert.equal(t.byVendor.other, undefined, "Atelier is not an agent");
  const both = addTally(t, t);
  assert.equal(both.agentMoves, 14);
  assert.equal(both.agents.length, 4, "an agent in two projects is one agent");
  assert.deepEqual(addTally(emptyTally(), t), t);
});

test("what Atelier recorded is drawn on the holder's thread, in the holder's colour", () => {
  const [t1] = buildStory("demo", [item("t1", "merged")], night(), OWNER).threads;
  const pushes = t1.beads.filter((b) => b.kind === "push");
  assert.deepEqual(pushes.map((b) => [b.actor, b.label]), [
    ["claude-code/opus-5.5", "opus-5.5 pushed aaaaaaaa"],
    ["claude-code/opus-5.5", "opus-5.5 pushed bbbbbbbb"],
  ]);
  assert.equal(t1.beads.find((b) => b.kind === "pass")?.actor, "claude-code/opus-5.5");
});

test("a merge is counted only when its task is drawn, and a cut record says so", () => {
  seq = 0;
  // The claim fell outside the read window; only the merge remains.
  const s = buildStory("demo", [item("t7", "merged")], [ev("t7", OWNER, "item.merged", { mergeCommit: "dddddddd44" })], OWNER, true);
  assert.equal(s.threads.length, 0);
  assert.equal(s.tally.merges, 0);
  assert.equal(s.partial, true);
});

test("a rejection and a failed check are moments worth telling", () => {
  const s = buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER);
  const catches = s.moments.filter((m) => m.tone === "catch").map((m) => m.text);
  assert.deepEqual(catches, ["glm-5.3 sent t1 back: Rule 2 filters too early", "A check on t2 failed on the agent's machine"]);
  assert.ok(s.moments.some((m) => m.tone === "merge" && m.text === "t1 merged into main as cccccccc"));
});

test("the drawing escapes what agents wrote and links each task", () => {
  seq = 0;
  const evs = [
    ev("t9", "claude-code/opus-5.5", "item.claimed"),
    ev("t9", "zcode/glm-5.3", "review.rejected", { note: `<script>alert("x")</script>` }),
  ].reverse();
  const svg = drawStory(buildStory("demo", [{ id: "t9", title: "A <b>bold</b> title", state: "claimed" } as never], evs, OWNER), OWNER, { href: (t) => `/p/demo/${t.id}` });
  assert.ok(!svg.includes("<script>"));
  assert.ok(!svg.includes("<b>"));
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /<a href="\/p\/demo\/t9"/);
  assert.match(svg, /--c:var\(--m-anthropic\)/);
});

test("an empty project draws an empty story", () => {
  const s = buildStory("empty", [], [], OWNER);
  assert.equal(s.threads.length, 0);
  assert.match(drawStory(s, OWNER), /^<svg class="graph"/);
});

test("every mark and task has a card, shown only while it is pointed at or focused", () => {
  const svg = drawStory(buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER), OWNER);
  const marks = [...svg.matchAll(/class="g-bead[^"]*"[^>]*data-key="([^"]+)" tabindex="0"/g)].map((m) => m[1]);
  assert.equal(marks.length, 9, "seven marks on t1, two on t2");
  for (const k of marks) {
    assert.ok(svg.includes(`data-card="${k}"`), `card for ${k}`);
    assert.ok(svg.includes(`[data-key="${k}"]:hover`), `hover rule for ${k}`);
  }
  const tasks = [...svg.matchAll(/data-task="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(tasks.length, 2);
  for (const k of tasks) assert.ok(svg.includes(`data-card="${k}"`));
  // Cards come after every thread, so nothing is drawn over them.
  assert.ok(svg.lastIndexOf('class="g-task') < svg.indexOf('class="g-cards"'));
  assert.match(svg, /t1 · merged · opus-5\.5/);
  assert.match(svg, /aria-label="[^"]*sent back: glm-5\.3 sent it back: Rule 2 filters too early"/);
});

test("two graphs on one page never share a card", () => {
  const s = buildStory("demo", [item("t1", "merged")], night(), OWNER);
  const a = drawStory(s, OWNER).match(/id="(g[0-9a-z]+)"/)![1];
  const b = drawStory(s, OWNER).match(/id="(g[0-9a-z]+)"/)![1];
  assert.notEqual(a, b);
});

test("a card's text wraps to its lines and says when it was cut", () => {
  assert.deepEqual(wrap("one two three", 20, 3), ["one two three"]);
  assert.deepEqual(wrap("aaaa bbbb cccc dddd eeee", 9, 2), ["aaaa bbbb", "cccc…"]);
  assert.deepEqual(wrap("", 10, 2), []);
  assert.ok(wrap("x".repeat(80), 20, 2).every((l) => l.length <= 20));
});

test("a public story keeps what happened and leaves out what anyone wrote", () => {
  const s = buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER, false, "Demo", { redact: true, ownerLabel: "PAVI" });
  const text = JSON.stringify(s);
  assert.ok(!text.includes("Rule 2 filters too early"), "review notes are left out");
  assert.ok(!text.includes("npm test"), "check commands are left out");
  assert.ok(s.moments.some((m) => m.text === "glm-5.3 sent t1 back"));
  assert.ok(s.moments.some((m) => m.text === "PAVI accepted t1"), "the owner is named, not addressed");
  assert.equal(s.tally.sentBack, 1, "the counts are the same as the private story's");
  assert.deepEqual(s.tally, buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER).tally);
});
