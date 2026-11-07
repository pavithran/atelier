import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { slotTrialDecision, SLOT_TRIAL_RATIO } from "../src/runners/slot-trial.ts";
import { acquireSlot, slotStatus, poolSize } from "../cli/load.mjs";
import { landingDir, landingLock } from "../cli/landing.mjs";

// t528: the second Studio test slot is kept only if two suites at once are each
// under 1.3 times the alone median. Times are minutes; the Studio trial that
// supplies them runs after deploy.
const pairs = (...p) => p.map(([a, b]) => ({ a, b }));

test("two slots when every concurrent time is under 1.3 times the alone median", () => {
  const r = slotTrialDecision({ alone: [11, 10, 12], pairs: pairs([13, 14], [12.5, 13.9], [14.2, 13]) });
  assert.equal(r.median, 11);
  assert.equal(r.limit, 11 * SLOT_TRIAL_RATIO);
  assert.equal(r.slots, 2);
  assert.deepEqual(r.over, []);
});

test("one slot, with the slow times named, when any concurrent time reaches the limit", () => {
  const r = slotTrialDecision({ alone: [10, 10, 10], pairs: pairs([12, 12], [12, 13], [11, 12]) });
  assert.equal(r.slots, 1); // exactly 1.3 times is not under it
  assert.deepEqual(r.over, [{ trial: 2, suite: "b", minutes: 13 }]);
  assert.match(r.reason, /trial 2 suite b took 13/);
});

test("a report without three alone times and three complete pairs decides nothing", () => {
  assert.throws(() => slotTrialDecision({ alone: [10, 10], pairs: pairs([1, 1], [1, 1], [1, 1]) }), /three alone/);
  assert.throws(() => slotTrialDecision({ alone: [10, 10, 10], pairs: pairs([1, 1], [1, 1]) }), /three concurrent/);
  assert.throws(() => slotTrialDecision({ alone: [10, 10, 10], pairs: [{ a: 1, b: 1 }, { a: 1, b: 1 }, { a: 1 }] }), /both suites/);
  assert.throws(() => slotTrialDecision({ alone: [10, NaN, 10], pairs: pairs([1, 1], [1, 1], [1, 1]) }), /positive/);
});

function pool(t, capacity) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-t528-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const processes = [];
  const options = { path: join(dir, "slots.sqlite"), env: { ATELIER_TEST_SLOTS: String(capacity) }, processes: () => processes, warn: () => {}, wait: () => new Promise((done) => setTimeout(done, 5)) };
  return { dir, options, owner: () => { const p = { pid: processes.length + 100, lease: randomUUID(), birth: "launch" }; processes.push(p); return { ...p, class: "landing", project: "atelier", task: `t${p.pid}`, actor: "codex/test" }; } };
}

test("two landings at once on two slots hold separate leases, and a third waits", async (t) => {
  const { options, owner } = pool(t, 2);
  const [a, b, c] = [owner(), owner(), owner()];
  const [ra, rb] = await Promise.all([acquireSlot(a, options), acquireSlot(b, options)]);
  assert.notEqual(ra.lease, rb.lease);
  const status = await slotStatus(options);
  assert.equal(status.usage, 2);
  assert.deepEqual(status.active.map((e) => e.lease).sort(), [a.lease, b.lease].sort());
  const waiting = new AbortController();
  const third = acquireSlot(c, { ...options, signal: waiting.signal });
  await new Promise((done) => setTimeout(done, 50));
  assert.equal((await slotStatus(options)).waiters.length, 1);
  waiting.abort();
  await assert.rejects(third, /cancelled/);
});

test("two landings' clean clones and landing locks are separate folders", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-t528-dirs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.ATELIER_CACHE = join(root, "cache");
  const { cleanClone, removeClone } = await import("../cli/atelier.mjs");
  const { execFileSync } = await import("node:child_process");
  const src = join(root, "src");
  execFileSync("git", ["init", "-q", "-b", "main", src]);
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", "-C", src, "commit", "-q", "--allow-empty", "-m", "i"]);
  const head = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const one = cleanClone(src, "x", head, null, "atelier");
  const two = cleanClone(src, "x", head, null, "atelier");
  t.after(() => { removeClone(one.dir); removeClone(two.dir); });
  assert.notEqual(one.dir, two.dir);
  assert.ok(existsSync(one.dir) && existsSync(two.dir));
  // Each landing locks its own checkout's directory; neither blocks the other.
  const g1 = join(root, "a.git"), g2 = join(root, "b.git");
  execFileSync("git", ["init", "-q", "--bare", g1]); execFileSync("git", ["init", "-q", "--bare", g2]);
  const d1 = landingDir(join(root, "cache"), g1), d2 = landingDir(join(root, "cache"), g2);
  assert.notEqual(d1, d2);
  const r1 = landingLock(d1), r2 = landingLock(d2);
  r1(); r2();
});

test("the pool a suite sizes its workers from halves with two slots", () => {
  assert.equal(poolSize({ ATELIER_TEST_SLOTS: "2" }, 36), 18);
});

test("applySlotTrial raises capacity to two only for a qualifying trial, and reports", async () => {
  const { applySlotTrial } = await import("../src/runners/slot-trial.ts");
  const calls = [];
  const set = async (n) => { calls.push(n); };
  const good = await applySlotTrial({ alone: [11, 10, 12], pairs: pairs([13, 14], [12.5, 13.9], [14.2, 13]) }, set);
  assert.deepEqual(calls, [2]);
  assert.equal(good.applied, true);
  assert.match(good.report, /Concurrent trial 3: suite a 14.2, suite b 13/);
  const bad = await applySlotTrial({ alone: [10, 10, 10], pairs: pairs([12, 12], [12, 13], [11, 12]) }, set);
  assert.deepEqual(calls, [2]); // untouched
  assert.equal(bad.applied, false);
  assert.match(bad.report, /trial 2 suite b took 13.*stays one/);
  await assert.rejects(applySlotTrial({ alone: [10, 10, 10], pairs: pairs([12, 12], [12, 13], [11]) }, set));
  assert.deepEqual(calls, [2]);
});

test("atelier slots trial FILE --apply leaves capacity alone and says why when the trial fails", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "slot-trial-"));
  try {
    const file = join(dir, "trial.json");
    writeFileSync(file, JSON.stringify({ alone: [10, 10, 10], pairs: pairs([12, 12], [12, 13], [11, 12]) }));
    const run = (...a) => spawnSync(process.execPath, ["cli/atelier.mjs", "slots", "trial", file, ...a], { encoding: "utf8", env: { ...process.env, ATELIER_TEST_SLOT_POOL: join(dir, "pool.db") } });
    const r = run("--apply");
    assert.match(r.stdout + r.stderr, /stays one/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
