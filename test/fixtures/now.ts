import type { NowProject } from "../../src/now.ts";

// The Now view's fixture (t525): one project with one task per stage, read at
// 10:00 EST on 2026-11-07 (15:00 UTC), after the clocks went back on 2026-11-01.
// Tokens and times are fixed so each test names its expected values.

export const NOW = new Date("2026-11-07T15:00:00.000Z");
export const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
export const min = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
export const item = (id: string, patch: Record<string, unknown> = {}) => ({
  id, title: `Title of ${id}`, scope: [], state: "open", owner: null, workspace: null, base: null, head: null, acceptedHead: null,
  createdAt: h(30), updatedAt: h(1), lastPushAt: null, ...patch,
});
const runs = (...tokens: (number | null)[]) => tokens.map((t, i) => ({ actor: "claude-code/sonnet-5.5", startedAt: h(20 - i), costUsd: null, tokens: t }));
export const progress = (id: string, over: Record<string, unknown>, ...tok: (number | null)[]) =>
  ({ task: id, actor: "claude-code/sonnet-5.5", runner: "mac-mini", harness: "claude-code", telemetry: true, startedAt: h(3), endedAt: null, at: min(1), commands: { started: 3, completed: 3 }, current: null, last: null, childAlive: true, commits: 1, changedFiles: 1, logBytes: 10, tokens: null, costUsd: null, receivedAt: min(1), changedAt: min(2), runs: runs(...tok), ...over });

// Parts of a run's tokens, weighed input x1, cache write x1.25, cache read x0.1, output x5.
export const withParts = (p: Record<string, unknown>, parts: { input: number; cacheWrite: number; cacheRead: number; output: number }) =>
  ({ ...p, runs: (p.runs as object[]).map((r) => ({ ...r, parts })) });

export const project = (): NowProject => ({
  name: "atelier", title: "Atelier",
  items: [
    item("t1", { createdAt: h(30) }),
    item("t2"),
    item("t3", { dispatch: { to: "any", agent: "claude-code", model: "sonnet-5.5", at: min(40) } }),
    item("t4", { state: "claimed", owner: "claude-code/sonnet-5.5" }),
    item("t5", { state: "submitted", head: "a".repeat(40), owner: "codex/gpt-6-astra" }),
    item("t6", { state: "submitted", head: "b".repeat(40) }),
    item("t7", { state: "submitted", head: "c".repeat(40) }),
    item("t8", { state: "accepted", head: "d".repeat(40) }),
    item("t9", { state: "integrated", head: "e".repeat(40) }),
    item("t10", { state: "blocked", owner: "claude-code/opus-5.5", blocked: { reason: "waiting for the Cloudflare quota", by: "claude-code/opus-5.5", at: h(5), from: "claimed" } }),
    item("t11", { state: "merged", head: "f".repeat(40), createdAt: h(40) }),
    item("t12", { state: "merged", head: "9".repeat(40), createdAt: h(40) }),
    item("t13", { state: "merged", head: "8".repeat(40), createdAt: h(60) }),
  ] as never,
  // The stage each task's newest event recorded and when that run began.
  stages: {
    t1: { stage: "filed", since: h(30) }, t2: { stage: "agreed", since: h(26) }, t3: { stage: "queued", since: min(40) },
    t4: { stage: "building", since: h(3) }, t5: { stage: "built", since: min(50) }, t6: { stage: "checked", since: min(25) },
    t7: { stage: "reviewed", since: h(3) }, t8: { stage: "landable", since: min(15) }, t9: { stage: "landed", since: min(20) },
    t10: { stage: "blocked", since: h(5) },
  },
  // t8 is the developer's to land; t10 waits on the developer to unblock it.
  owner: [
    { id: "t8", title: "Title of t8", call: "land", sentence: "Land it.", href: "/p/atelier/t8", command: null, why: "ready", notices: [] },
    { id: "t10", title: "Title of t10", call: "unblock", sentence: "Unblock it.", href: "/p/atelier/t10", command: null, why: "blocked", notices: [] },
  ] as never,
  reviewRequests: [{ item: "t6", state: "claimed", claimedBy: "codex/gpt-6-astra", claimedAt: min(5) }],
  landings: {},
  progress: {
    t4: progress("t4", {}, 120_000, 80_000), t5: progress("t5", { endedAt: min(55), childAlive: false }, 50_000),
    // t11 weighs 300,000 (50,000 + 50,000 + 50,000 + 150,000); t12 weighs 800,000.
    t11: withParts(progress("t11", { endedAt: h(9) }, 400_000), { input: 50_000, cacheWrite: 40_000, cacheRead: 500_000, output: 30_000 }),
    t12: withParts(progress("t12", { endedAt: h(9) }, 900_000), { input: 100_000, cacheWrite: 80_000, cacheRead: 1_000_000, output: 100_000 }),
    t13: progress("t13", { endedAt: h(30) }, 5_000_000),
  } as never,
  events: ([
    { kind: "item.merged", itemId: "t11", at: "2026-11-07T06:30:00.000Z", actor: "owner", data: { mergeCommit: "1".repeat(40) } },
    { kind: "item.merged", itemId: "t12", at: "2026-11-07T14:00:00.000Z", actor: "owner", data: { mergeCommit: "2".repeat(40) } },
    // 04:30 UTC is 23:30 EST on the 6th: before today's Eastern day, though the 7th in UTC.
    { kind: "item.merged", itemId: "t13", at: "2026-11-07T04:30:00.000Z", actor: "owner", data: { mergeCommit: "3".repeat(40) } },
    { kind: "review.rejected", itemId: "t11", at: h(12), actor: "codex/gpt-6-astra", data: { findings: [{ file: "a", line: 1, severity: "blocking", text: "x" }, { file: "b", line: 2, severity: "blocking", text: "y" }, { file: "c", line: 3, severity: "blocking", text: "z" }, { file: "d", line: 4, severity: "follow-up", text: "w" }] } },
    { kind: "review.finding", itemId: "t11", at: h(11), actor: "owner", data: { index: 1, verdict: "fixed", review: 5 } },
    { kind: "review.finding", itemId: "t11", at: h(11), actor: "owner", data: { index: 2, verdict: "fixed", review: 5 } },
    { kind: "review.finding", itemId: "t11", at: h(11), actor: "owner", data: { index: 3, verdict: "refuted", review: 5 } },
    { kind: "review.finding", itemId: "t11", at: h(11), actor: "owner", data: { index: 4, verdict: "confirmed", review: 5 } },
    { kind: "review.approved", itemId: "t11", at: h(10), actor: "codex/gpt-6-astra", data: {} },
    { kind: "review.approved", itemId: "t12", at: h(10), actor: "claude-code/opus-5.5", data: {} },
    { kind: "item.revert_requested", itemId: "t12", at: min(30), actor: "owner", data: { itemId: "t99" } },
  ] as Omit<NowProject["events"][number], "seq">[]).map((e, i) => ({ ...e, seq: i + 1 })),
  deploys: [{ ship: "s1", head: "x", by: "owner", result: "shipped", at: "2026-11-07T07:10:00.000Z" }],
});

