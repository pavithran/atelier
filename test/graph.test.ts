import { test } from "node:test";
import assert from "node:assert/strict";
import { addTally, buildStory, drawStory, emptyTally, vendorOf, isLocalRun, wrap } from "../src/graph.ts";

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
  assert.equal(vendorOf("opencode/glm-5.3-flash", OWNER), "zai");
  assert.ok(isLocalRun("opencode/glm-5.3-flash"));
  assert.equal(vendorOf("pavi", OWNER), "owner");
  assert.equal(vendorOf("someone/else", OWNER), "other");
  // A family is recognised by name, so new releases are coloured on day one.
  assert.equal(vendorOf("codex/gpt-6.1-nova", OWNER), "openai");
  assert.equal(vendorOf("zcode/glm-5.4", OWNER), "zai");
  assert.equal(vendorOf("gemini-cli/gemini-3.1-pro", OWNER), "google");
  assert.equal(vendorOf("opencode/gemini-3.1-pro", OWNER), "google", "a cloud-only family through OpenCode keeps its own colour");
  assert.ok(!isLocalRun("opencode/gemini-3.1-pro"));
  assert.equal(vendorOf("opencode/deepseek-v4-flash", OWNER), "deepseek");
  assert.ok(isLocalRun("opencode/deepseek-v4-flash"), "DeepSeek through OpenCode is home work: its family is not cloud-only (no local-build suffix here)");
  assert.equal(vendorOf("opencode/DeepSeek-V4-Flash-0731-MXFP4-MLX", OWNER), "deepseek");
  assert.ok(isLocalRun("opencode/DeepSeek-V4-Flash-0731-MXFP4-MLX"), "a local build is home work");
  assert.equal(vendorOf("opencode/gemini-3.1-pro-mlx-4bit", OWNER), "google");
  assert.ok(isLocalRun("opencode/gemini-3.1-pro-mlx-4bit"), "a local build is home work even in a cloud-only family");
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

test("a released task ends on its thread, closed and not live", () => {
  seq = 0;
  const evs = [
    ev("t3", "codex/gpt-6", "item.claimed"),
    ev("t3", "codex/gpt-6", "push.observed", { head: "eeeeeeee55" }),
    ev("t3", OWNER, "item.released", { from: "codex/gpt-6", note: "stalled" }),
  ].reverse();
  const s = buildStory("demo", [item("t3", "open")], evs, OWNER);
  assert.equal(s.threads[0].ending, "released");
  assert.ok(s.threads[0].end !== null);
  const svg = drawStory(s, OWNER);
  assert.match(svg, /g-cap/, "a released task is capped like a closed one");
  assert.match(svg, /g-task closed/);
  assert.doesNotMatch(svg, /g-task[^"]*live/);
});

test("a failed claim ends the thread the same way as a release", () => {
  seq = 0;
  const evs = [
    ev("t4", "zcode/glm-5.3", "item.claimed"),
    ev("t4", "zcode/glm-5.3", "item.claim_failed", { reason: "the fork could not be created" }),
  ].reverse();
  const [t4] = buildStory("demo", [item("t4", "open")], evs, OWNER).threads;
  assert.equal(t4.ending, "released");
});

test("an open task with no end on its record is not live either", () => {
  seq = 0;
  const evs = [ev("t5", "codex/gpt-6", "item.claimed")].reverse();
  const s = buildStory("demo", [item("t5", "open")], evs, OWNER);
  assert.ok(s.threads[0].end !== null, "the thread ends where its record ends");
  assert.equal(s.threads[0].ending, "released");
  assert.doesNotMatch(drawStory(s, OWNER), /g-task[^"]*live/);
});

test("an empty project draws an empty story", () => {
  const s = buildStory("empty", [], [], OWNER);
  assert.equal(s.threads.length, 0);
  assert.match(drawStory(s, OWNER), /^<svg class="graph"/);
});

test("every mark and task has a card, shown only while it is pointed at or focused", () => {
  const svg = drawStory(buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER), OWNER);
  // A mark is focusable itself, or through the link it sits in.
  const marks = [...svg.matchAll(/class="g-bead[^"]*"[^>]*data-key="([^"]+)" tabindex="0"|class="g-bead-link" data-key="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
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

// A story of one task, as the task page and a Decisions card draw it.
function oneTask() {
  seq = 0;
  const evs = [
    ev("t7", "codex/gpt-6", "item.claimed"),
    ev("t7", "codex/gpt-6", "push.observed", { head: "aaaaaaaa11" }),
    ev("t7", "atelier/sandbox", "evidence.observed", { claim: "npm test", passed: false, where: "sandbox" }),
    ev("t7", OWNER, "item.handoff", { from: "codex/gpt-6", to: "claude-code/opus-5.5" }),
    ev("t7", "claude-code/opus-5.5", "item.submitted", { head: "aaaaaaaa11" }),
    ev("t7", "zcode/glm-5.3", "review.approved"),
    ev("t7", OWNER, "review.rejected", { note: "no" }),
  ].reverse();
  return buildStory("demo", [{ id: "t7", title: "One <i>task</i>", state: "submitted" } as never], evs, OWNER);
}

test("a card's drawing is narrow, has no axis, and draws each review as an edge from its reviewer", () => {
  const svg = drawStory(oneTask(), OWNER, { mini: true, replaySeconds: 0 });
  assert.match(svg, /^<svg class="graph compact mini"[^>]*viewBox="0 0 480 /);
  assert.doesNotMatch(svg, /g-clock/, "no axis labels");
  const edges = [...svg.matchAll(/<g class="g-edge (approve|reject) pop" style="--c:([^;]+);/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(edges, [["approve", "var(--m-zai)"], ["reject", "var(--m-owner)"]]);
  assert.match(svg, /<title>glm-5\.3 approved<\/title>/);
  assert.match(svg, /class="ring"/, "a sent-back review is ringed");
  assert.match(svg, /aria-label="t7, One &lt;i&gt;task&lt;\/i&gt;: its thread, \d+ marks"/);
  assert.doesNotMatch(drawStory(oneTask(), OWNER), /g-edge/, "the full drawing marks reviews as beads only");
});

test("the full drawing of one task has dated gridlines, each drawn once, and a note beside its head", () => {
  const note = { verdict: "review", tone: "ask" as const, text: "Needs an approval <now>" };
  const svg = drawStory(oneTask(), OWNER, { replaySeconds: 0, note });
  const clocks = [...svg.matchAll(/class="g-clock" x="([\d.]+)"[^>]*>([^<]+)</g)];
  assert.ok(clocks.length >= 2);
  assert.equal(new Set(clocks.map((m) => m[1])).size, clocks.length, "no position is labelled twice");
  assert.ok(clocks.every((m) => /^10\/04 10:\d\d$/.test(m[2])), "each carries a date and a time");
  assert.match(svg, /<g class="g-note ask">/);
  assert.match(svg, /<tspan class="g-note-verdict">review<\/tspan> · Needs an approval &lt;now&gt;/);
  assert.ok(!svg.includes("<now>"));
  const kinds = [...svg.matchAll(/class="g-bead pop (\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(kinds, ["push", "fail", "handoff", "submit", "approve", "reject"]);
  assert.doesNotMatch(drawStory(oneTask(), OWNER, { replaySeconds: 0 }), /g-note/, "no note unless one is given");
  assert.doesNotMatch(drawStory(oneTask(), OWNER, { mini: true, note }), /g-note/, "a card carries no note");
});

test("Flow's filters keep only threads active in the window or worked by the family, and the tally counts only those", () => {
  const all = buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER);
  assert.deepEqual(all.threads.map((t) => t.id).sort(), ["t1", "t2"]);
  const zai = buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER, false, "Demo", { family: "zai" });
  assert.deepEqual(zai.threads.map((t) => t.id), ["t1"], "only the task GLM reviewed");
  assert.equal(zai.tally.merges, 1);
  const openai = buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER, false, "Demo", { family: "openai" });
  assert.deepEqual(openai.threads.map((t) => t.id), ["t2"]);
  assert.equal(openai.tally.merges, 0, "the tally counts only what is drawn");
  const late = buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER, false, "Demo", { since: "2026-10-04T10:13:00.000Z" });
  assert.deepEqual(late.threads.map((t) => t.id), ["t2"], "t1's last activity was at 10:12");
});

test("a card links to the commit or the task's checks, encoded; a public story has no links", () => {
  const s = buildStory("my project", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER);
  const svg = drawStory(s, OWNER);
  assert.ok(svg.includes('<a href="/p/my%20project/t1/commit/aaaaaaaa11" class="g-bead-link"'), "a push mark is a link to its commit, reached by keyboard");
  assert.ok(svg.includes('<a href="/p/my%20project/t1#checks" class="g-bead-link"'), "a check or review mark links to the task's checks");
  assert.ok(svg.includes('<a href="/p/my%20project/t1/commit/aaaaaaaa11" tabindex="-1">'), "its card links there too, for a pointer, without a second tab stop");
  assert.ok(!/class="g-bead-link"[^>]*>\s*<g class="g-bead[^"]*"[^>]*tabindex/.test(svg), "a linked mark is not focusable twice");
  assert.match(svg, /\[data-card="[^"]+"\]:hover,\[data-card="[^"]+"\]:focus-within\) \[data-card="[^"]+"\]/, "a card stays open while pointed at or holding focus");
  const pub = drawStory(buildStory("my project", [item("t1", "merged")], night(), OWNER, false, "P", { redact: true }), OWNER);
  assert.ok(!pub.includes("/commit/") && !pub.includes("#checks"));
});

test("a local run keeps its family's colour, dotted and drawn without the dash animation", () => {
  seq = 0;
  const evs = [ev("t9", "opencode/GLM-5.3-Flash-4_8bit", "item.claimed")].reverse();
  const svg = drawStory(buildStory("demo", [{ id: "t9", title: "Local work", state: "claimed" } as never], evs, OWNER), OWNER);
  const local = svg.match(/<path class="g-thread[^"]*local"[^>]*>/g) ?? [];
  assert.ok(local.length > 0, "the thread is marked local");
  for (const p of local) {
    assert.match(p, /--c:var\(--m-zai\)/, "coloured by its family");
    assert.doesNotMatch(p, /pathLength|\bdraw\b/, "the dot pattern is not in pathLength units, so no draw animation");
  }
  assert.match(svg, /<circle class="g-head pop local"/);
});

test("a local run's beads carry their actor's colour for the outline", () => {
  seq = 0;
  const evs = [ev("t9", "opencode/GLM-5.3-Flash-4_8bit", "item.claimed"), ev("t9", "opencode/GLM-5.3-Flash-4_8bit", "push.observed", { head: "a".repeat(40) })].reverse();
  const svg = drawStory(buildStory("demo", [{ id: "t9", title: "Local work", state: "claimed" } as never], evs, OWNER), OWNER);
  const beads = svg.match(/<g class="g-bead pop [^"]*local"[^>]*>/g) ?? [];
  assert.ok(beads.length > 0, "a local bead is drawn");
  for (const b of beads) assert.match(b, /--c:var\(--m-zai\)/);
});

test("a session note is bookkeeping: no agent's move, a quarter step on the axis, and nothing on a thread", () => {
  const base = buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], night(), OWNER);
  // The Ledger records a session with no task, as the owner and, once agent tokens are allowed to, as an agent.
  const noted = night();
  noted.unshift({ seq: 100, itemId: null, at: "2026-10-04T11:00:00.000Z", actor: "claude-code/opus-5.5", kind: "session.wrapped", data: { summary: "Stopped for the day" } } as never);
  noted.unshift({ seq: 101, itemId: null, at: "2026-10-04T11:01:00.000Z", actor: OWNER, kind: "session.wrapped", data: { summary: "Stopped too" } } as never);
  const story = buildStory("demo", [item("t1", "merged"), item("t2", "claimed")], noted, OWNER);
  assert.equal(story.tally.agentMoves, base.tally.agentMoves, "the tally counts neither note");
  assert.equal(story.tally.decisions, base.tally.decisions);
  assert.deepEqual(story.tally.byVendor, base.tally.byVendor);
  assert.deepEqual(story.tally.agents, base.tally.agents, "an agent that only wrapped a session did not act");
  assert.equal(story.span, base.span + 0.5, "two notes take a quarter step each");
  assert.deepEqual(story.threads.map((th) => th.beads.length), base.threads.map((th) => th.beads.length));
  assert.equal(story.moments.length, base.moments.length, "a note is not told as a moment");
});

// PAVI's decision, 2026-10-06: the owner's override of a missing review is a
// decision of its own, told with its reason except on a public page.
test("the owner's override of a missing review is a decision, told with its reason", () => {
  seq = 0;
  const events = [
    ev("t1", "claude-code/opus-5.5", "item.claimed"),
    ev("t1", "claude-code/opus-5.5", "item.submitted", { head: "aaaaaaaa11" }),
    ev("t1", OWNER, "review.overridden", { head: "aaaaaaaa11", reason: "No model of another family is available" }),
    ev("t1", OWNER, "item.accepted", { head: "aaaaaaaa11", reviewOverridden: true }),
  ].reverse();
  const s = buildStory("demo", [item("t1", "accepted")], events, OWNER);
  assert.equal(s.tally.decisions, 2, "the override and the acceptance");
  assert.ok(s.moments.some((m) => m.text === "You overrode the independent review of t1: No model of another family is available" && m.tone === "you"));
  const pub = buildStory("demo", [item("t1", "accepted")], events, OWNER, false, "Demo", { redact: true, ownerLabel: "PAVI" });
  assert.ok(pub.moments.some((m) => m.text === "PAVI overrode the independent review of t1"));
});
