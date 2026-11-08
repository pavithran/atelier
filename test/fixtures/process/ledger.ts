// A small project ledger for the Process page (t558): events as `atelier
// events` and the Ledger return them. NOW is a Sunday noon; each task lists
// its events as [minutes after the task was filed, kind, data].
import type { BarEvent } from "../../../src/flow.ts";

export const NOW = Date.parse("2026-11-08T12:00:00Z");
const MIN = 60_000, DAY = 86_400_000;

type Step = [minutes: number, kind: string, data?: Record<string, unknown>];
let seq = 0;

// A task filed `daysAgo` days before NOW, with its events in order.
function task(id: string, daysAgo: number, steps: Step[]): BarEvent[] {
  const filed = NOW - daysAgo * DAY;
  return steps.map(([m, kind, data]) => ({ seq: ++seq, at: new Date(filed + m * MIN).toISOString(), itemId: id, kind, data: data ?? {} }));
}
const ship = (daysAgo: number, afterMin: number, id: string, passed = true): BarEvent[] => {
  const at = (extra: number) => new Date(NOW - daysAgo * DAY + (afterMin + extra) * MIN).toISOString();
  return [
    { seq: ++seq, at: at(0), itemId: null, kind: "action.ran", data: { ship: id, step: "deploy", passed } },
    { seq: ++seq, at: at(1), itemId: null, kind: "action.ran", data: { ship: id, step: "verify", passed: true } },
    { seq: ++seq, at: at(2), itemId: null, kind: "ship.recorded", data: { ship: id, result: "shipped" } },
  ];
};

// t1: criteria rejected once, one fix round, merged 126 minutes after filing,
// deployed 30 minutes after the merge.
const t1 = task("t1", 3, [
  [0, "item.created"], [1, "criteria_review.requested"], [3, "criteria_review.rejected"], [4, "criteria_review.requested"], [6, "criteria_review.approved"],
  [10, "item.dispatched"], [40, "item.claimed"], [60, "push.observed"], [70, "item.submitted"],
  [80, "review.rejected"], [100, "push.observed"], [110, "item.submitted"], [120, "review.approved"], [121, "item.accepted"], [125, "landing.begun"], [126, "item.merged"],
]);
// t2: a failed check, a landing conflict, three rejected rounds, then the cap.
const t2 = task("t2", 2, [
  [0, "item.created"], [5, "item.dispatched"], [65, "item.claimed"], [80, "push.observed"],
  [82, "evidence.test", { passed: false }], [85, "evidence.test", { passed: false }], [90, "item.submitted"],
  [100, "review.rejected"], [120, "item.submitted"], [130, "review.rejected"], [150, "item.submitted"], [160, "review.rejected"],
  [161, "review.round_cap"], [161, "item.blocked"],
]);
// t3: merged after 90 minutes, not deployed.
const t3 = task("t3", 1, [
  [0, "item.created"], [10, "item.dispatched"], [30, "item.claimed"], [50, "push.observed"], [55, "item.submitted"],
  [60, "review.approved"], [61, "item.accepted"], [64, "landing.begun"], [90, "item.merged"],
]);
// t4: filed and left, no phase entered.
const t4 = task("t4", 1, [[0, "item.created"]]);
// Last window: merged 200 minutes after filing, deployed 100 minutes later.
const old = task("t0", 10, [
  [0, "item.created"], [20, "item.dispatched"], [60, "item.claimed"], [120, "push.observed"], [130, "item.submitted"],
  [140, "review.approved"], [141, "item.accepted"], [150, "landing.begun"], [200, "item.merged"],
]);

export const FIXTURE: BarEvent[] = [
  ...old, ...ship(10, 300, "s0"),
  ...t1, ...ship(3, 156, "s1"),
  ...t2, ...t3, ...t4,
].sort((a, b) => a.seq - b.seq);

// What the fixture's numbers are, by hand: t1 merges at 126 min and its ship's
// deploy is recorded at 156 min, so merge-to-deploy is 30 min; t3 is merged
// and not deployed; t0 merged at 200 min and deployed at 300 min.
export const T1_MERGE_TO_DEPLOY = 30, T1_FILED_TO_DEPLOYED = 156, T0_FILED_TO_DEPLOYED = 300;
