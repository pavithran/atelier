// When the landing-workflow route replaces a live landing instance rather
// than attaching to it (t430), and how it makes sure the old one is gone
// first. Two reasons replace one:
//   - `lease-wait`: it has been at the stage `lease` for the limit or longer
//     by the server's record (src/landing/lease-wait.ts);
//   - `reviewer`: before acceptance, the owner names an eligible reviewer
//     while the reviewer the instance was started with is no longer
//     eligible (it contributed since, or is of a contributor's family).
// Otherwise the live instance is attached to as before, with the options
// it was started with.
//
// A replacement is created only once the old instance has been terminated
// and its status read back as ended (terminated, errored or complete). The
// status read back decides, not the terminate's answer: a terminate that
// fails still allows the replacement once the status confirms the end, and
// a status that cannot be read, or one still live after the terminate,
// refuses it whether the terminate failed or not. An executor whose state
// cannot be established is never run beside a second one.

import { BEFORE_ACCEPTANCE, LANDING_LEASE_WAIT_LIMIT_MS, leaseWaitElapsed, leaseWaitExpired, reviewerIneligibility } from "./lease-wait.ts";
import type { LandingWorkflowRecord } from "../ledger.ts";

export type ReplaceReason = "lease-wait" | "reviewer";
export interface Replacement { reason: ReplaceReason; detail: string }

export const ENDED: readonly string[] = ["complete", "errored", "terminated"];

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(ms % 3_600_000 ? 1 : 0)} hours`;

// Whether the live instance `record` describes is replaced, and why; with
// the reviewer the owner named on this run (null for none), judged against
// the task as it stands. `refused` says why a named reviewer replaced
// nothing because it is not eligible itself.
export function replacementFor(record: LandingWorkflowRecord, named: string | null, item: { state: string; owner: string | null; pushActors?: readonly string[] }, now: number): { replace: Replacement | null; refused?: string } {
  if (leaseWaitExpired(record, now)) {
    const elapsed = leaseWaitElapsed(record, now)!;
    return { replace: { reason: "lease-wait", detail: `instance ${record.instance} has waited for the landing lease since ${record.stageAt} (${hours(elapsed)}), at or past the ${hours(LANDING_LEASE_WAIT_LIMIT_MS)} limit` } };
  }
  const remembered = record.reviewer ?? null;
  if (named === null || remembered === null || named === remembered) return { replace: null };
  if (!BEFORE_ACCEPTANCE.includes(record.stage) || item.state === "accepted" || item.state === "merged") return { replace: null };
  const stale = reviewerIneligibility(remembered, item);
  if (!stale) return { replace: null };
  const refused = reviewerIneligibility(named, item);
  if (refused) return { replace: null, refused: `${named} cannot replace the remembered reviewer ${remembered}: ${refused}` };
  return { replace: { reason: "reviewer", detail: `the remembered reviewer ${remembered} is no longer eligible (${stale}); ${named}, named on this run, is` } };
}

// Terminates `handle` and reads its status back until it has ended. The
// answer is the ended status, or why the end could not be confirmed.
export async function terminateConfirmed(handle: Pick<WorkflowInstance, "terminate" | "status">, tries = 5, pauseMs = 200): Promise<{ ended: InstanceStatus } | { unconfirmed: string }> {
  let terminateError: string | null = null;
  try { await handle.terminate(); } catch (error) { terminateError = String((error as Error)?.message ?? error); }
  let status: InstanceStatus | null = null;
  for (let i = 0; i < tries; i++) {
    try { status = await handle.status(); }
    catch (error) {
      return { unconfirmed: `its status could not be read after the terminate${terminateError ? ` (which failed: ${terminateError})` : ""}: ${String((error as Error)?.message ?? error)}` };
    }
    if (ENDED.includes(status.status)) return { ended: status };
    if (i + 1 < tries) await new Promise((ok) => setTimeout(ok, pauseMs));
  }
  return { unconfirmed: `it is still ${status?.status ?? "unknown"} after the terminate${terminateError ? `, which failed: ${terminateError}` : ""}` };
}
