import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatusBrief } from "../cli/status.mjs";

const spans = (cost) => ({ "5h": { requests: 0, tokens: 0, cost: null }, "24h": { requests: 1, tokens: 1, cost }, "7d": { requests: 0, tokens: 0, cost: null } });

const brief = (over = {}) => ({
  standing: {
    project: { name: "demo", title: "Demo project", repo: "demo" },
    generatedAt: "2026-10-09T12:34:56Z",
    live: [
      { id: "t1", state: "claimed", owner: "codex/gpt-6", title: "One" },
      { id: "t2", state: "submitted", owner: "claude-code/opus-5.5", title: "Two" },
    ],
    waiting: [{ id: "t2", kind: "accept", title: "Two", reason: "r", brief: null }],
    merged: ["t9", "t8", "t7", "t6", "t5"].map((id, n) => ({ id, title: `Merged ${id}`, at: "2026-10-09T10:00:00Z", commit: `${n}abcdef0123456789`, line: null })),
  },
  version: { commit: "deadbeefcafe1234", routeLevel: 7 },
  queue: {
    queue: [
      { project: "demo", item: { id: "t2", dispatch: { job: "review", agent: "codex", model: "gpt-6" } } },
      { project: "other", item: { id: "t3", dispatch: { job: "review", agent: "x", model: "y" } } },
    ],
  },
  lease: { item: "t4", holder: "owner", since: "2026-10-09 12:00 UTC" },
  usage: {
    thresholds: { dailySpend: 10 },
    reports: [
      { tool: "codex", models: [{ model: "m", spans: spans(12.5) }] },
      { tool: "claude", models: [{ model: "m", spans: spans(1.25) }] },
    ],
  },
  ...over,
});

test("the brief pins its format: merges, deployed commit, builds, reviews, landing, spend", () => {
  assert.equal(formatStatusBrief(brief()), [
    "Demo project (demo) as of 2026-10-09 12:34 UTC",
    "Recent merges:",
    "  t9  0abcdef0  Merged t9",
    "  t8  1abcdef0  Merged t8",
    "  t7  2abcdef0  Merged t7",
    "Deployed: deadbeef, route level 7.",
    "Live builds: 1 (t1 codex/gpt-6).",
    "Reviews: 1 submitted or accepted (t2 submitted); 1 waiting for a runner (t2 by codex/gpt-6).",
    "Landing: t4 held by owner since 2026-10-09 12:00 UTC.",
    "Waiting on the owner: t2 accept.",
    "Spend, last 24 hours: $13.75 (codex $12.50, claude $1.25); limit $10.00 a tool a day; over it: codex.",
  ].join("\n"));
});

test("the brief stays under 20 lines however much the project holds", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, state: "claimed", owner: "a/b", title: "x" }));
  const standing = { ...brief().standing, live: many, waiting: many.map((i) => ({ ...i, kind: "accept" })) };
  const lines = formatStatusBrief(brief({ standing })).split("\n");
  assert.ok(lines.length < 20);
  assert.ok(lines.some((l) => l.includes("and 47 more")));
});

test("--brief is a switch for status and still text for new", async () => {
  const { parseArgs } = await import("../cli/atelier.mjs");
  assert.equal(parseArgs(["status", "--brief", "--project", "demo"]).brief, true);
  assert.equal(parseArgs(["new", "title", "--brief", "the text"]).brief, "the text");
});

test("the brief says what it could not read", () => {
  const standing = { ...brief().standing, merged: [], live: [], waiting: [] };
  const lines = formatStatusBrief(brief({ standing, version: null, queue: null, usage: null, lease: { unreadable: "500" } })).split("\n");
  assert.deepEqual(lines.slice(1), [
    "Recent merges:",
    "  none",
    "Deployed: the server's version could not be read.",
    "Live builds: none.",
    "Reviews: 0 submitted or accepted; the review queue could not be read.",
    "Landing: the lease could not be read (500).",
    "Waiting on the owner: nothing.",
    "Spend: not readable from the server.",
  ]);
});
