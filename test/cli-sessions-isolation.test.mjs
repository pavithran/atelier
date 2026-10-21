import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./cli-sessions-shared.mjs";
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = (script) => `${quote(process.execPath)} ${quote(script)}`;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function pool(f) {
  const db = new DatabaseSync(f.slotPool, { readOnly: true });
  try { return JSON.parse(db.prepare("SELECT data FROM pool WHERE id=1").get().data); }
  finally { db.close(); }
}
function onlyFixtureOpens(f) {
  assert.ok(f.slotOpens().length, "the actual scheduler must open its isolated pool");
  assert.ok(f.slotOpens().every((entry) => entry.allowed && entry.path === f.slotPool));
}

// t186: a standalone fixture used to admit its checks into the host's pool.
test("standalone session checks use real isolated admission and deny outside databases", { timeout: 20000 }, (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t), probe = join(f.dir, "probe.mjs"), proof = join(f.dir, "proof.json");
  const outside = join(f.dir, "must-not-open.sqlite");
  writeFileSync(probe, `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { HOST_POOL, slotStatus, poolTransaction } from ${JSON.stringify(pathToFileURL(f.slotWrapper).href)};
await assert.rejects(poolTransaction({path:${JSON.stringify(outside)}}), /outside its temporary pool/);
writeFileSync(${JSON.stringify(proof)}, JSON.stringify({pool:HOST_POOL, lease:process.env.ATELIER_TEST_LEASE, status:await slotStatus()}));`);
  const result = f.runWith({ ATELIER_CHECK_TIMEOUT: '10000', ATELIER_TEST_LEASE: undefined, FAKE_CHECKS: JSON.stringify([command(probe)]) }, "wrap", "Isolated check");
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(readFileSync(proof, "utf8"));
  assert.equal(observed.pool, f.slotPool);
  assert.match(observed.lease, /^[a-f0-9-]{36}$/);
  assert.equal(observed.status.active.length, 1);
  assert.equal(observed.status.active[0].lease, observed.lease);
  assert.equal(observed.status.waiters.length, 0);
  assert.equal(existsSync(outside), false, "the guard must refuse before opening SQLite");
  assert.ok(f.slotOpens().some((entry) => !entry.allowed && entry.path === outside));
  assert.ok(f.slotOpens().every((entry) => entry.path === (entry.allowed ? f.slotPool : outside)));
  assert.deepEqual(pool(f).entries, []);
});

test("nested checks keep the isolated wrapper and reuse its lease after environment scrubbing", { timeout: 20000 }, (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t), nested = join(f.dir, "nested.mjs"), probe = join(f.dir, "probe.mjs"), proof = join(f.dir, "nested.json");
  writeFileSync(probe, `import {writeFileSync} from 'node:fs';
import {HOST_POOL,slotStatus} from ${JSON.stringify(pathToFileURL(f.slotWrapper).href)};
writeFileSync(${JSON.stringify(proof)}, JSON.stringify({pool:HOST_POOL, preload:process.env.NODE_OPTIONS, lease:process.env.ATELIER_TEST_LEASE, status:await slotStatus()}));`);
  writeFileSync(nested, `import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkEnv} from ${JSON.stringify(new URL("../cli/check-env.mjs", import.meta.url).href)};
import {slotInvocation} from ${JSON.stringify(new URL("../cli/load.mjs", import.meta.url).href)};
const invocation=slotInvocation([process.execPath,${JSON.stringify(probe)}],{},checkEnv());
assert.equal(invocation.env.NODE_OPTIONS,undefined);
const result=spawnSync(invocation.argv[0],invocation.argv.slice(1),{env:invocation.env,stdio:'inherit'});
process.exitCode=result.status ?? 1;`);
  const result = f.runWith({ ATELIER_CHECK_TIMEOUT: '10000', FAKE_CHECKS: JSON.stringify([command(nested)]) }, "wrap", "Nested check");
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(readFileSync(proof, "utf8"));
  assert.equal(observed.pool, f.slotPool);
  assert.equal(observed.preload, undefined);
  assert.equal(observed.status.active.length, 1);
  assert.equal(observed.status.active[0].lease, observed.lease);
  assert.equal(observed.status.waiters.length, 0);
  assert.equal(pool(f).sequence, 1, "nested admission must not enqueue another slot");
  assert.deepEqual(pool(f).entries, []);
  onlyFixtureOpens(f);
});

test("sync and async fixtures ignore an occupied outer pool and its inherited lease", { timeout: 30000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const outer = fixture(t), ready = join(outer.dir, "ready"), hold = join(outer.dir, "hold.mjs");
  writeFileSync(hold, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`);
  const holder = outer.spawnWith({ ATELIER_CHECK_TIMEOUT: '20000', FAKE_CHECKS: JSON.stringify([command(hold)]) }, "wrap", "Occupied temporary pool");
  const finished = new Promise((done) => holder.once("close", (status, signal) => done({status, signal})));
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(ready)) { assert.ok(Date.now() < deadline, "outer check did not start"); await pause(25); }
    const active = pool(outer).entries.find((entry) => entry.started);
    assert.ok(active, "temporary outer pool must be occupied");
    const unchanged = readFileSync(outer.slotPool);
    for (const asynchronous of [false, true]) {
      const f = fixture(t), proof = join(f.dir, "lease"), script = join(f.dir, "lease.mjs");
      writeFileSync(script, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(proof)},process.env.ATELIER_TEST_LEASE);`);
      const env = { ATELIER_CHECK_TIMEOUT: "10000", ATELIER_TEST_LEASE: active.lease, ATELIER_TEST_SLOTS: "9", FAKE_CHECKS: JSON.stringify([command(script)]) };
      if (asynchronous) {
        const child = f.spawnWith(env, "wrap", "Async isolation");
        const status = await new Promise((done) => child.once("close", (code) => done(code)));
        assert.equal(status, 0);
      } else {
        const result = f.runWith(env, "wrap", "Sync isolation");
        assert.equal(result.status, 0, result.stderr);
      }
      assert.notEqual(readFileSync(proof, "utf8"), active.lease);
      assert.equal(pool(f).capacity, 1);
      assert.deepEqual(pool(f).entries, []);
      onlyFixtureOpens(f);
      assert.ok(readFileSync(outer.slotPool).equals(unchanged), "outer pool bytes must remain unchanged");
      assert.equal(holder.exitCode, null, "fixture cleanup must not signal the outer lease");
    }
    onlyFixtureOpens(outer);
  } finally {
    holder.kill("SIGTERM");
    assert.deepEqual(await finished, { status: 143, signal: null });
  }
});
