// t607, the runner's half: every poll carries the machine's reading beside the
// memory (cli/runner.mjs machineReading), read here off the body a fake server
// receives from the real runRunner. The server's half is
// test/machine-offer.spec.ts.
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { cpus, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { runRunner, machineReading } from "../cli/runner.mjs";
import { setSlotCapacity } from "../cli/load.mjs";
import { parseMachine } from "../src/runners/machine.ts";
import { config, fixture as sharedFixture } from "./runner-shared.mjs";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";
import { serveRunner } from "./helpers/runner-server.mjs";

// Runs the real runner for two polls against the fake server; returns the
// bodies the server received on POST /queue.
async function polls(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-machine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  const bodies = [];
  const server = await serveRunner({ answers: { "POST queue": ({ body }) => { bodies.push(body); return []; } } });
  t.after(() => server.close());
  t.mock.method(console, "log", () => {});
  const exitBefore = process.exitCode;
  t.after(() => { process.exitCode = exitBefore; });
  const { io } = sharedFixture();
  let n = 0;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
    credential: "runner-token", api: { server: () => server.url },
    version: async () => ({ commit: "0".repeat(40), routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES }),
    workspacePath: io.workspacePath, taskIO: io, wait: () => tick(), ...options,
    async queue(offer) {
      const res = await fetch(`${server.url}/api/queue`, { method: "POST", body: JSON.stringify(offer) });
      if (++n > 1) process.emit("SIGTERM");
      return await res.json();
    },
  });
  return bodies;
}

test("the runner's real poll carries the machine's host, cores, load, free memory and test pool", async (t) => {
  const bodies = await polls(t);
  assert.ok(bodies.length >= 2);
  for (const body of bodies) {
    const m = body.machine;
    assert.equal(m.host, hostname());
    assert.equal(m.cpus, cpus().length);
    assert.equal(m.loadavg.length, 3);
    assert.ok(m.loadavg.every((x) => typeof x === "number" && x >= 0));
    assert.ok(m.memFreePercent > 0 && m.memFreePercent <= 100);
    assert.ok(m.testSlots === null || (m.testSlots.capacity >= 1 && m.testSlots.inUse <= m.testSlots.capacity));
    assert.deepEqual(parseMachine(m), m, "the server keeps what the runner sent");
    assert.ok("memory" in body, "beside the memory");
  }
});

test("a host with a test pool reports its capacity and use, and one without reports null", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-machine-pool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pool = join(dir, "pool.sqlite");
  assert.equal((await machineReading({ pool })).testSlots, null, "no pool file, no slots");
  await setSlotCapacity(3, { path: pool });
  assert.deepEqual((await machineReading({ pool })).testSlots, { capacity: 3, inUse: 0 });
  // Through the poll: the runner reads the pool it is given.
  const bodies = await polls(t, { machine: () => machineReading({ pool }) });
  assert.deepEqual(bodies[0].machine.testSlots, { capacity: 3, inUse: 0 });
  const none = await polls(t, { machine: () => machineReading({ pool: join(dir, "absent.sqlite") }) });
  assert.equal(none[0].machine.testSlots, null);
});

test("a pool in use past its capacity is reported full, which the server accepts", async () => {
  const m = await machineReading({ pool: "/x", status: async () => ({ capacity: 2, usage: 5 }), os: { hostname: () => "h", cpus: () => [{}, {}], loadavg: () => [0, 0, 0], freemem: () => 1, totalmem: () => 4 } });
  assert.deepEqual(m, { host: "h", cpus: 2, loadavg: [0, 0, 0], memFreePercent: 25, testSlots: null }, "no pool file at /x");
  const pooled = await machineReading({ pool: new URL(import.meta.url).pathname, status: async () => ({ capacity: 2, usage: 5 }), os: { hostname: () => "h", cpus: () => [{}], loadavg: () => [0, 0, 0], freemem: () => 1, totalmem: () => 4 } });
  assert.deepEqual(pooled.testSlots, { capacity: 2, inUse: 2 });
  assert.ok(parseMachine(pooled));
});

test("a reading that cannot be taken leaves the poll going without it", async (t) => {
  const bodies = await polls(t, { machine: async () => { throw new Error("no sensors"); } });
  assert.ok(bodies.length >= 2);
  assert.ok(bodies.every((b) => !("machine" in b)));
});
