// The Studio's second test slot (t528). Landing runs the full suite on one
// slot. Three suites alone and three pairs of suites at once are timed on the
// Studio at one main head; the slot count becomes two only if every
// concurrent time is under this multiple of the alone median.
export const SLOT_TRIAL_RATIO = 1.3;

export interface SlotTrial {
  alone: number[];
  pairs: { a?: number; b?: number }[];
}

export interface SlotTrialDecision {
  slots: 1 | 2;
  median: number;
  limit: number;
  over: { trial: number; suite: "a" | "b"; minutes: number }[];
  reason: string;
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function slotTrialDecision(trial: SlotTrial): SlotTrialDecision {
  if (trial.alone.length !== 3) throw new Error("slot trial needs three alone suite times");
  if (trial.pairs.length !== 3) throw new Error("slot trial needs three concurrent trials");
  if (trial.pairs.some((p) => p.a === undefined || p.b === undefined)) throw new Error("slot trial needs both suites' times in every concurrent trial");
  const all = [...trial.alone, ...trial.pairs.flatMap((p) => [p.a, p.b])];
  if (!all.every(positive)) throw new Error("slot trial times must be positive numbers");
  const median = [...trial.alone].sort((x, y) => x - y)[1];
  const limit = median * SLOT_TRIAL_RATIO;
  const over: SlotTrialDecision["over"] = [];
  trial.pairs.forEach((p, i) => {
    if (!(p.a! < limit)) over.push({ trial: i + 1, suite: "a", minutes: p.a! });
    if (!(p.b! < limit)) over.push({ trial: i + 1, suite: "b", minutes: p.b! });
  });
  if (!over.length) return { slots: 2, median, limit, over, reason: `every concurrent time is under ${limit} (${SLOT_TRIAL_RATIO} times the alone median ${median})` };
  const slow = over.map((o) => `trial ${o.trial} suite ${o.suite} took ${o.minutes}`).join("; ");
  return { slots: 1, median, limit, over, reason: `${slow}, not under ${limit} (${SLOT_TRIAL_RATIO} times the alone median ${median}); the slot count stays one` };
}

export function slotTrialReport(trial: SlotTrial, d: SlotTrialDecision): string {
  const times = (xs: (number | undefined)[]) => xs.join(", ");
  return [
    `Alone suite times (minutes): ${times(trial.alone)}; median ${d.median}`,
    ...trial.pairs.map((p, i) => `Concurrent trial ${i + 1}: suite a ${p.a}, suite b ${p.b}`),
    `Limit: under ${d.limit} (${SLOT_TRIAL_RATIO} times the alone median)`,
    `Decision: ${d.slots} slot${d.slots === 1 ? "" : "s"}: ${d.reason}`,
  ].join("\n");
}

// Sets the capacity through setCapacity only when the trial qualifies, and
// only after the decision is made; a trial that fails changes nothing and the
// report says why. With no setter it only previews: nothing is set and the
// report says what would be.
export async function applySlotTrial(trial: SlotTrial, setCapacity?: (n: number) => Promise<unknown>): Promise<{ decision: SlotTrialDecision; applied: boolean; report: string }> {
  const decision = slotTrialDecision(trial);
  const report = slotTrialReport(trial, decision);
  if (decision.slots !== 2) return { decision, applied: false, report };
  if (!setCapacity) return { decision, applied: false, report: `${report}\nwould set test slot capacity to ${decision.slots} (not applied; add --apply)` };
  await setCapacity(decision.slots);
  return { decision, applied: true, report: `${report}\nTest slot capacity set to ${decision.slots}` };
}
