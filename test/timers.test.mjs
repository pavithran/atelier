// Atelier 2.0, task 8 (design-branches-2026-10-28.md, section 4.2): the
// Worker's crons run on in-process timers in the Node server, started and
// stopped with it. The clock is injected, so these tests move time forward by
// hours without waiting for it.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Timers, nextRun } from "../src/runtime/timers.mjs";
import { startServer } from "../src/runtime/server.mjs";

const MIN = 60_000, HOUR = 60 * MIN;

// A clock whose time moves only when a test says. advance() runs every timer
// due on the way, in order, each at its own moment.
function fakeClock(start) {
  let now = start, seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    pending: () => pending.size,
    // Runs the timers due by `now + ms`; `early` makes each fire that many
    // milliseconds before its moment, as a Node timer sometimes does.
    async advance(ms, { early = 0, settle = async () => {} } = {}) {
      const until = now + ms;
      for (;;) {
        const next = [...pending].map(([id, t]) => ({ id, ...t })).filter((t) => t.at - early <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        pending.delete(next.id);
        now = Math.max(now, next.at - early);
        next.fn();
        await settle();
      }
      now = until;
    },
  };
}

test("nextRun keeps the crons' wall-clock moments: */5, */10 and 7 past every sixth hour, in UTC", () => {
  const t = Date.parse("2026-10-28T13:02:30.000Z");
  assert.equal(new Date(nextRun(t, 5 * MIN)).toISOString(), "2026-10-28T13:05:00.000Z");
  assert.equal(new Date(nextRun(t, 10 * MIN)).toISOString(), "2026-10-28T13:10:00.000Z");
  assert.equal(new Date(nextRun(t, 6 * HOUR, 7 * MIN)).toISOString(), "2026-10-28T18:07:00.000Z");
  // Strictly after: a moment exactly on the boundary is the next one.
  assert.equal(new Date(nextRun(Date.parse("2026-10-28T13:05:00.000Z"), 5 * MIN)).toISOString(), "2026-10-28T13:10:00.000Z");
  assert.equal(new Date(nextRun(Date.parse("2026-10-28T00:06:59.999Z"), 6 * HOUR, 7 * MIN)).toISOString(), "2026-10-28T00:07:00.000Z");
});

test("each job runs at its moments and is given the moment it was due; a timer that fires early runs nothing twice", async () => {
  const clock = fakeClock(Date.parse("2026-10-28T13:02:30.000Z"));
  const seen = [];
  const timers = new Timers({ clock, jobs: [{ name: "five", every: 5 * MIN, run: async (at) => { seen.push(at.toISOString()); } }] }).start();
  await clock.advance(16 * MIN, { early: 1 });
  assert.deepEqual(seen, ["2026-10-28T13:05:00.000Z", "2026-10-28T13:10:00.000Z", "2026-10-28T13:15:00.000Z"]);
  await timers.stop();
  assert.equal(clock.pending(), 0, "stop clears every timer");
  await clock.advance(HOUR);
  assert.equal(seen.length, 3, "nothing runs after stop");
});

test("a run still going lets the next moment pass; a failed run is logged and the job goes on; stop waits for the run in flight", async () => {
  const clock = fakeClock(Date.parse("2026-10-28T13:00:00.000Z"));
  const logged = [];
  let release, started = 0, failed = 0;
  const gate = new Promise((ok) => { release = ok; });
  const timers = new Timers({
    clock, log: (line) => logged.push(line),
    jobs: [
      { name: "slow", every: 5 * MIN, run: async () => { started++; await gate; } },
      { name: "flaky", every: 10 * MIN, run: async () => { failed++; throw new Error("the index could not be read"); } },
    ],
  }).start();
  await clock.advance(21 * MIN);
  assert.equal(started, 1, "the slow job's later moments passed while its first run went on");
  assert.equal(timers.state.find((j) => j.name === "slow").passed, 3);
  assert.equal(failed, 2, "the failing job ran at each of its moments");
  assert.equal(logged.length, 2);
  assert.match(logged[0], /^flaky at 2026-10-28T13:10:00\.000Z failed: the index could not be read$/);
  let stopped = false;
  const stopping = timers.stop().then(() => { stopped = true; });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(stopped, false, "stop waits for the run in flight");
  release();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(clock.pending(), 0);
});

const OWNER = "atl_00112233445566778899aabbccddeeff";
const root = mkdtempSync(join(tmpdir(), "atelier-timers-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("the server starts the stage tick, the stuck episodes and the model snapshots with itself and stops them when it closes; the tick records a stuck stage once the clock passes its limit", async () => {
  const start = Date.now();
  const clock = fakeClock(start);
  const server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, timers: { clock } });
  try {
    assert.deepEqual(server.timers.state.map((j) => j.name), ["stage tick", "stuck episodes", "model snapshots"]);
    assert.equal(clock.pending(), 3, "one timer per job, armed at start");
    const api = async (method, path, body) => {
      const res = await fetch(`${server.url}/api${path}`, { method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const made = await api("PUT", "/projects/demo", {});
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const task = await api("POST", "/projects/demo/items", { title: "Filed and left", scope: ["src/**"] });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const settle = async () => { while (server.timers.state.some((j) => j.busy)) await new Promise((ok) => setTimeout(ok, 5)); };
    const L = server.namespace.get(server.namespace.idFromName("project:demo"));
    const stuck = async () => (await L.events(task.body.id, 1000)).filter((e) => e.kind === "stage.stuck");

    // Before its limit (24 hours for a filed task) the tick records nothing.
    await clock.advance(23 * HOUR, { settle });
    const ticks = server.timers.state.find((j) => j.name === "stage tick").runs;
    assert.ok(ticks >= 23 * 12 - 1, `the stage tick ran every five minutes (${ticks} runs)`);
    assert.ok(server.timers.state.find((j) => j.name === "stuck episodes").runs >= 23 * 6 - 1);
    assert.ok(server.timers.state.find((j) => j.name === "model snapshots").runs >= 3);
    assert.deepEqual(await stuck(), []);
    // Past it, the next tick records the stage as stuck, once, with its age.
    await clock.advance(2 * HOUR, { settle });
    const found = await stuck();
    assert.equal(found.length, 1);
    assert.equal(found[0].data.stage, "filed");
    assert.ok(found[0].data.overMs > 0);
    // The run is recorded on the index, which status reads.
    const ran = await server.namespace.get(server.namespace.idFromName("__index")).tickRan();
    assert.ok(ran && Date.parse(ran.at) > start + 24 * HOUR, JSON.stringify(ran));
  } finally {
    await server.close();
  }
  assert.equal(clock.pending(), 0, "closing the server stops its timers");
});

test("a test server has no timers unless asked, and false turns them off anywhere", async () => {
  const server = await startServer({ env: "test", dataDir: join(root, "plain"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  try { assert.equal(server.timers, null); } finally { await server.close(); }
  const off = await startServer({ env: "staging", dataDir: join(root, "off"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, timers: false });
  try { assert.equal(off.timers, null); } finally { await off.close(); }
});
