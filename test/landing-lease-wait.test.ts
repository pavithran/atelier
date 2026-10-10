import { test } from "node:test";
import assert from "node:assert/strict";
import { LANDING_LEASE_WAIT_LIMIT_MS, leaseTimeout, leaseWaitElapsed, leaseWaitExpired, replacementInstanceId, reviewerIneligibility } from "../src/landing/lease-wait.ts";
import { replacementFor, terminateConfirmed } from "../src/landing/replace.ts";
import type { LandingWorkflowRecord } from "../src/ledger.ts";

// The lease-wait limit (t430, src/landing/lease-wait.ts) and the route's
// replacement decision (src/landing/replace.ts), as pure functions.

const T0 = Date.parse("2026-10-10T08:00:00.000Z");
const OPUS = "claude-code/opus-5.5";
const record = (over: Partial<LandingWorkflowRecord> = {}): LandingWorkflowRecord => ({
  instance: "land-t9-1", at: new Date(T0).toISOString(), stage: "lease", stageAt: new Date(T0).toISOString(), round: 0, checks: "local", ...over,
});
const item = { state: "claimed", owner: OPUS, pushActors: [OPUS] };

test("the lease-wait limit is three hours, measured from the recorded lease-stage entry, the boundary itself expired", () => {
  assert.equal(LANDING_LEASE_WAIT_LIMIT_MS, 3 * 3_600_000);
  const r = record();
  assert.equal(leaseWaitElapsed(r, T0 + 1000), 1000);
  assert.equal(leaseWaitExpired(r, T0 + LANDING_LEASE_WAIT_LIMIT_MS - 1), false, "below");
  assert.equal(leaseWaitExpired(r, T0 + LANDING_LEASE_WAIT_LIMIT_MS), true, "at");
  assert.equal(leaseWaitExpired(r, T0 + LANDING_LEASE_WAIT_LIMIT_MS + 1), true, "above");
  // The entry time is the stage's, not the instance's creation time.
  const later = record({ at: new Date(T0 - 10 * 3_600_000).toISOString() });
  assert.equal(leaseWaitExpired(later, T0 + LANDING_LEASE_WAIT_LIMIT_MS - 1), false);
  // Another stage has no lease wait; an unreadable time never expires.
  assert.equal(leaseWaitElapsed(record({ stage: "workspace" }), T0 + 5 * LANDING_LEASE_WAIT_LIMIT_MS), null);
  assert.equal(leaseWaitExpired(record({ stageAt: "garbage" }), T0 + 5 * LANDING_LEASE_WAIT_LIMIT_MS), false);
});

test("a lease-wait timeout names the holder of the final attempt, or says no landing held it", () => {
  const held = leaseTimeout("t9", LANDING_LEASE_WAIT_LIMIT_MS, { why: "owner has been landing t12 since …", at: "2026-10-10T11:00:05.000Z", holder: { item: "t12", holder: "owner", since: "2026-10-10T10:40:00.000Z" } });
  assert.match(held, /^the landing lease was not t9's within 3 hours: at the final attempt \(2026-10-10 11:00 UTC\) owner's landing of t12 held it \(since 2026-10-10 10:40 UTC\); the server said: owner has been landing t12/);
  const none = leaseTimeout("t9", 30 * 60_000, { why: "owner's landing of t3 has been waiting for the lease since …", at: "2026-10-10T11:00:05.000Z", holder: null });
  assert.match(none, /within 30 minutes: at the final attempt \(2026-10-10 11:00 UTC\) no landing held it; the server said: owner's landing of t3 has been waiting/);
  // An attempt cached by an instance older than t430 is not mistaken for no holder.
  assert.match(leaseTimeout("t9", 1500, { why: "busy" }), /within 2 seconds: at the final attempt its holder was not recorded; the server said: busy\./);
});

test("a replacement id is derived from the replaced instance alone", () => {
  const a = replacementInstanceId("t9", "land-t9-1760000000000");
  assert.equal(a, replacementInstanceId("t9", "land-t9-1760000000000"));
  assert.notEqual(a, replacementInstanceId("t9", "land-t9-1760000000001"));
  assert.match(a, /^land-t9-r[0-9a-z]+$/);
  assert.ok(a.length <= 100);
});

test("the route replaces a live instance only past the lease-wait limit or for an eligible reviewer in place of an ineligible one", () => {
  const now = T0 + LANDING_LEASE_WAIT_LIMIT_MS;
  assert.deepEqual(replacementFor(record(), null, item, now - 1), { replace: null });
  const expired = replacementFor(record(), null, item, now).replace;
  assert.equal(expired?.reason, "lease-wait");
  assert.match(expired!.detail, /land-t9-1 has waited for the landing lease since 2026-10-10T08:00:00.000Z \(3 hours\), at or past the 3 hours limit/);
  // The remembered reviewer contributed: a named reviewer of another family replaces it.
  const atReview = record({ stage: "review", reviewer: OPUS });
  assert.equal(reviewerIneligibility(OPUS, item) !== null, true);
  assert.equal(reviewerIneligibility("codex/gpt-5.5", item), null);
  const swap = replacementFor(atReview, "codex/gpt-5.5", item, T0);
  assert.equal(swap.replace?.reason, "reviewer");
  assert.match(swap.replace!.detail, /remembered reviewer claude-code\/opus-5\.5 is no longer eligible .*codex\/gpt-5\.5, named on this run, is/);
  // A named reviewer who is not eligible replaces nothing and is reported.
  const refused = replacementFor(atReview, "claude-code/sonnet-5.5", item, T0);
  assert.equal(refused.replace, null);
  assert.match(refused.refused!, /claude-code\/sonnet-5\.5 cannot replace the remembered reviewer/);
  // An eligible remembered reviewer, the same name, none named, or a stage past acceptance: attach.
  assert.deepEqual(replacementFor(record({ stage: "review", reviewer: "codex/gpt-5.5" }), "gemini-cli/gemini-3-pro", item, T0), { replace: null });
  assert.deepEqual(replacementFor(atReview, OPUS, item, T0), { replace: null });
  assert.deepEqual(replacementFor(atReview, null, item, T0), { replace: null });
  assert.deepEqual(replacementFor(record({ stage: "merge", reviewer: OPUS }), "codex/gpt-5.5", item, T0), { replace: null });
  assert.deepEqual(replacementFor(atReview, "codex/gpt-5.5", { ...item, state: "accepted" }, T0), { replace: null });
});

test("termination is confirmed only by an ended status read back after the terminate", async () => {
  const handle = (terminate: () => Promise<void>, statuses: (InstanceStatus["status"] | Error)[]) => {
    let i = 0;
    return {
      terminate,
      status: async () => { const s = statuses[Math.min(i++, statuses.length - 1)]; if (s instanceof Error) throw s; return { status: s } as InstanceStatus; },
    };
  };
  const ok = async () => {};
  const fails = async () => { throw new Error("internal error terminating"); };
  assert.deepEqual(await terminateConfirmed(handle(ok, ["running", "terminated"]), 3, 1), { ended: { status: "terminated" } });
  // A terminate that throws on an instance that ended meanwhile still confirms.
  assert.deepEqual(await terminateConfirmed(handle(fails, ["errored"]), 3, 1), { ended: { status: "errored" } });
  const stillLive = await terminateConfirmed(handle(fails, ["running"]), 3, 1);
  assert.ok("unconfirmed" in stillLive && /still running after the terminate, which failed: internal error terminating/.test(stillLive.unconfirmed));
  const unreadable = await terminateConfirmed(handle(ok, [new Error("internal error reading")]), 3, 1);
  assert.ok("unconfirmed" in unreadable && /could not be read after the terminate: internal error reading/.test(unreadable.unconfirmed));
  const unknown = await terminateConfirmed(handle(ok, ["unknown"]), 2, 1);
  assert.ok("unconfirmed" in unknown && /still unknown/.test(unknown.unconfirmed));
});
