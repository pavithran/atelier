import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatusBrief, formatUsageWarnings } from "../cli/status.mjs";

const spans = (cost) => ({ "5h": { requests: 0, tokens: 0, cost: null }, "24h": { requests: 1, tokens: 1, cost }, "7d": { requests: 0, tokens: 0, cost: null } });

const brief = (over = {}) => ({
  standing: {
    project: { name: "demo", title: "Demo project", repo: "demo" },
    generatedAt: "2026-10-09T12:34:56Z",
    live: [
      { id: "t1", state: "claimed", owner: "codex/gpt-6", title: "One" },
      { id: "t2", state: "submitted", owner: "claude-code/opus-5.5", title: "Two" },
    ],
    waiting: [{ id: "t2", call: "accept", title: "Two", sentence: "Accept the revision.", href: "/p/demo/t2", command: "atelier land t2 --reviewer H/M --project demo", why: "r", brief: null }],
    merged: ["t9", "t8", "t7", "t6", "t5"].map((id, n) => ({ id, title: `Merged ${id}`, at: "2026-10-09T10:00:00Z", commit: `${n}abcdef0123456789`, line: null })),
  },
  version: { commit: "deadbeefcafe1234", routeLevel: 7 },
  queue: [
    { project: "demo", item: { id: "t2", dispatch: { job: "review", agent: "codex", model: "gpt-6" } } },
    { project: "other", item: { id: "t3", dispatch: { job: "review", agent: "x", model: "y" } } },
  ],
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
    "Waiting on the developer: t2 accept; next: atelier land t2 --reviewer H/M --project demo.",
    "Spend, last 24 hours: $13.75 (codex $12.50, claude $1.25); limit $10.00 a tool a day; over it: codex.",
  ].join("\n"));
});

test("the brief stays under 20 lines however much the project holds", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, state: "claimed", owner: "a/b", title: "x" }));
  const standing = { ...brief().standing, live: many, waiting: many.map((i) => ({ ...i, call: "accept" })) };
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
    "Waiting on the developer: nothing.",
    "Spend: not readable from the server.",
  ]);
});

test("the review queue is the array the API returns, and its waiting reviews are counted", () => {
  assert.match(formatStatusBrief(brief()), /1 waiting for a runner \(t2 by codex\/gpt-6\)/);
});

test("a partial brief labels its counts, retains known owner calls and all read failures within 20 lines", () => {
  const partial = Array.from({ length: 50 }, (_, i) => `t${i}: events could not\nbe read.`);
  const out = formatStatusBrief(brief({ standing: { ...brief().standing, partial } }));
  assert.match(out, /counts cover only what was read:/);
  for (let i = 0; i < 50; i++) assert.ok(out.includes(`t${i}: events could not be read.`));
  assert.match(out, /Waiting on the developer: t2 accept; next: .*; more may be waiting\./);
  assert.ok(out.split("\n").length < 20);
});

test("the brief includes the single-family mode if set", () => {
  const standing = { ...brief().standing, familyMode: { single: "anthropic" } };
  const out = formatStatusBrief(brief({ standing }));
  assert.match(out, /single-family: anthropic/);
});

// t727: a vendor ran short with nothing in `atelier status` to say so.
test("t727: status warns of a window near its limit, names a report not heard from as unknown, and says nothing when all is well", () => {
  const now = Date.parse("2026-10-05T21:00:00.000Z");
  const reading = (over) => ({ tool: "codex", runner: "home:studio", at: new Date(now - 60_000).toISOString(), windows: [], ...over });
  const near = reading({ windows: [{ name: "weekly", usedPercent: 85, resetsAt: new Date(now + 86_400_000).toISOString() }] });
  assert.deepEqual(formatUsageWarnings({ reports: [near] }, now), ["Usage warnings:", "  codex: the weekly window is 85% used; it resets at 2026-10-06T21:00:00.000Z."]);
  const silent = reading({ at: new Date(now - 40 * 3_600_000).toISOString(), windows: near.windows });
  assert.deepEqual(formatUsageWarnings({ reports: [silent] }, now), ["Usage warnings:", "  codex on home:studio: not reported since 2026-10-04T05:00Z, so its usage is not known"]);
  assert.deepEqual(formatUsageWarnings({ reports: [reading({ windows: [{ name: "weekly", usedPercent: 5, resetsAt: near.windows[0].resetsAt }] })] }, now), []);
  assert.deepEqual(formatUsageWarnings(null, now), []);
});

// t727 round 1: a fresh DeepSeek balance of USD 1 under the default floor of 10 showed nothing in status.
test("t727: status warns of a low balance by the same floor the alerts use, and not when the floor is off or met", () => {
  const now = Date.parse("2026-10-05T21:00:00.000Z");
  const deepseek = { tool: "deepseek", runner: "home:studio", at: new Date(now - 60_000).toISOString(), windows: [], balances: [{ currency: "USD", amount: 1 }] };
  const warn = ["Usage warnings:", "  deepseek on home:studio: balance 1 USD, below 10"];
  assert.deepEqual(formatUsageWarnings({ reports: [deepseek] }, now), warn);
  assert.deepEqual(formatUsageWarnings({ reports: [deepseek], thresholds: { balanceFloor: 10 } }, now), warn);
  assert.deepEqual(formatUsageWarnings({ reports: [deepseek], thresholds: { balanceFloor: null } }, now), []);
  assert.deepEqual(formatUsageWarnings({ reports: [deepseek], thresholds: { balanceFloor: 1 } }, now), []);
});
