import { test } from "node:test";
import assert from "node:assert/strict";
import { addTally, buildStory, drawStory, emptyTally, vendorOf } from "../src/graph.ts";

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
    ev("t1", "claude-code/opus-5.5", "evidence.observed", { claim: "npm test", passed: true, where: "sandbox" }),
    ev("t1", "claude-code/opus-5.5", "item.submitted", { head: "aaaaaaaa11" }),
    ev("t1", "zcode/glm-5.3", "review.rejected", { note: "Rule 2 filters too early" }),
    ev("t1", "claude-code/opus-5.5", "push.observed", { head: "bbbbbbbb22" }),
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
  assert.equal(t.agentMoves, 9, "everything agents did except opening a fork");
  assert.equal(t.checks, 2);
  assert.equal(t.inCloud, 1);
  assert.equal(t.sentBack, 1);
  assert.deepEqual(t.agents, ["claude-code/opus-5.5", "zcode/glm-5.3", "codex/gpt-5.5", "codex/gpt-6"]);
  assert.equal(t.byVendor.anthropic, 5);
  const both = addTally(t, t);
  assert.equal(both.agentMoves, 18);
  assert.equal(both.agents.length, 4, "an agent in two projects is one agent");
  assert.deepEqual(addTally(emptyTally(), t), t);
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
  assert.match(svg, /<a href="\/p\/demo\/t9">/);
  assert.match(svg, /--c:var\(--m-anthropic\)/);
});

test("an empty project draws an empty story", () => {
  const s = buildStory("empty", [], [], OWNER);
  assert.equal(s.threads.length, 0);
  assert.match(drawStory(s, OWNER), /^<svg class="graph"/);
});
