import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { acquireSlot, releaseSlot, slotStatus, slotCapacity, slotPriority, parseSlotProcesses, formatSlots, poolTransaction, orderedWaiters, slotInvocation, SLOT_WRAPPER } from "../cli/load.mjs";
import { checkEnv } from "../cli/check-env.mjs";

function fixture(t, capacity = 1) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-slots-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const processes = [];
  const options = { path: join(dir, "slots.sqlite"), env: { ATELIER_TEST_SLOTS: String(capacity) }, processes: () => processes };
  const owner = (cls = "ordinary", project = "one") => {
    const p = { pid: processes.length + 100, lease: randomUUID(), birth: "launch" };
    processes.push(p);
    return { ...p, class: cls, project, task: "t1", actor: "codex/test" };
  };
  return { options, processes, owner };
}

test("capacity defaults to a quarter of cores, at least one; only positive integers are accepted", () => {
  for (const [cores, expected] of [[0, 1], [1, 1], [7, 1], [8, 2], [18, 4]]) assert.equal(slotCapacity({}, cores), expected);
  assert.equal(slotCapacity({ ATELIER_TEST_SLOTS: "3" }), 3);
  for (const value of ["", "0", "-1", "1.5", "Infinity", "3x", " 2", "1e2", "9007199254740992"]) {
    assert.throws(() => slotCapacity({ ATELIER_TEST_SLOTS: value }), /positive integer/);
  }
  assert.equal(slotPriority("landing"), slotPriority("release"));
  assert.throws(() => slotPriority("urgent"), /priority/);
});

test("local checks retain only slot coordination across their scrubbed environment", () => {
  const keys = ["ATELIER_TEST_LEASE", "ATELIER_TEST_SLOTS", "ATELIER_TEST_PRIORITY", "ATELIER_TOKEN"];
  const previous = keys.map((key) => process.env[key]);
  try {
    Object.assign(process.env, { ATELIER_TEST_LEASE: randomUUID(), ATELIER_TEST_SLOTS: "2", ATELIER_TEST_PRIORITY: "release", ATELIER_TOKEN: "must-not-reach-check" });
    const metadata = { project: "one", task: "t1", actor: "codex/test" };
    const invocation = slotInvocation(["/bin/sh", "-c", "exit 0"], metadata, checkEnv());
    assert.deepEqual(invocation.argv, [process.execPath, SLOT_WRAPPER, "--metadata", JSON.stringify(metadata), "--", "/bin/sh", "-c", "exit 0"]);
    for (const key of keys.slice(0, 3)) assert.equal(invocation.env[key], process.env[key]);
    assert.equal(invocation.env.ATELIER_TOKEN, undefined);
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test("one transactional pool shares capacity across projects; conflicting capacities are refused even idle", async (t) => {
  const f = fixture(t, 2), one = f.owner(), two = f.owner("review", "two");
  await Promise.all([acquireSlot(one, f.options), acquireSlot(two, f.options)]);
  const status = await slotStatus(f.options);
  assert.equal(status.active.length, 2);
  assert.deepEqual(status.active.map((e) => e.sequence).sort(), [1, 2]);
  assert.deepEqual(new Set(status.active.map((e) => e.project)), new Set(["one", "two"]));
  await assert.rejects(slotStatus({ ...f.options, env: { ATELIER_TEST_SLOTS: "1" } }), /capacity conflict/);
  f.processes.length = 0;
  assert.equal((await slotStatus(f.options)).active.length, 0);
  await assert.rejects(slotStatus({ ...f.options, env: { ATELIER_TEST_SLOTS: "1" } }), /capacity conflict/);
});

test("nested wrappers reuse their live lease without another enqueue or release", async (t) => {
  const f = fixture(t), one = f.owner();
  assert.equal((await acquireSlot(one, f.options)).reused, false);
  const nested = { ...one, pid: 900 };
  f.processes.push(nested);
  assert.equal((await acquireSlot(nested, f.options)).reused, true);
  assert.equal((await slotStatus(f.options)).active.length, 1);
  assert.equal(await releaseSlot(one.lease, f.options, one.pid), false);
  f.processes.pop();
  assert.equal(await releaseSlot(one.lease, f.options, one.pid), true);
});

test("SIGKILL abandonment retains surviving children; recycled PIDs do not own entries", async (t) => {
  const f = fixture(t), one = f.owner();
  await acquireSlot(one, f.options);
  f.processes.push({ pid: 900, lease: one.lease });
  f.processes.shift(); // supervisor killed, child reparented
  assert.equal((await slotStatus(f.options)).active.length, 1);
  assert.equal(await releaseSlot(one.lease, f.options, one.pid), false);
  f.processes[0] = { pid: one.pid, lease: randomUUID() }; // old PID recycled
  assert.equal((await slotStatus(f.options)).active.length, 0);
});

test("waiting cancellation removes its queue entry but never frees another live tree", async (t) => {
  const f = fixture(t), held = f.owner(), waiting = f.owner();
  await acquireSlot(held, f.options);
  const controller = new AbortController();
  await assert.rejects(acquireSlot(waiting, { ...f.options, signal: controller.signal, wait: async () => controller.abort() }), /cancelled/);
  const status = await slotStatus(f.options);
  assert.equal(status.active.length, 1);
  assert.equal(status.waiters.length, 0);
});

test("priority and atomic FIFO order waiters without preempting; status carries ownership", async (t) => {
  const f = fixture(t), held = f.owner(), ordinary = f.owner(), review = f.owner("review"), release1 = f.owner("release"), release2 = f.owner("landing");
  await acquireSlot(held, f.options);
  const gates = [];
  const pending = [];
  for (const owner of [ordinary, review, release1, release2]) {
    let queued;
    const ready = new Promise((resolve) => { queued = resolve; });
    pending.push(acquireSlot(owner, { ...f.options, wait: () => { queued(); return new Promise((resolve) => gates.push({ owner, resolve })); } }));
    await ready;
  }
  const status = await slotStatus(f.options);
  assert.equal(status.active[0].lease, held.lease);
  assert.deepEqual(status.waiters.map((e) => e.lease), [release1, release2, review, ordinary].map((e) => e.lease));
  assert.match(formatSlots(status), /1\/1 on .*[\s\S]*one\/t1 codex\/test pid=100 identity=.*started=/);
  assert.ok(status.waiters.every((e) => e.queued && e.sequence));
  await releaseSlot(held.lease, f.options, held.pid);
  for (const owner of [release1, release2, review, ordinary]) {
    gates.find((g) => g.owner === owner).resolve();
    await pending[[ordinary, review, release1, release2].indexOf(owner)];
    assert.equal((await slotStatus(f.options)).active[0].lease, owner.lease);
    await releaseSlot(owner.lease, f.options, owner.pid);
  }
});

test("SQLite rolls back partial updates; process inspection errors do not reclaim entries", async (t) => {
  const f = fixture(t), one = f.owner();
  await acquireSlot(one, f.options);
  await assert.rejects(poolTransaction(f.options, (state) => { state.entries = []; throw new Error("writer died"); }), /writer died/);
  await assert.rejects(slotStatus({ ...f.options, processes: () => { throw new Error("inspection denied"); } }), /inspection denied/);
  assert.equal((await slotStatus(f.options)).active.length, 1);
});

test("process parser ignores zombies and keeps only nonce identity, never environment secrets", () => {
  const lease = randomUUID();
  const processes = parseSlotProcesses(`  123 1 123 S Sat Oct 10 12:01:02 2026 node ATELIER_TEST_LEASE=${lease} SECRET=hidden\n  124 1 123 Z Sat Oct 10 12:01:02 2026 node ATELIER_TEST_LEASE=${lease}`);
  assert.equal(processes.length, 1);
  assert.equal(processes[0].lease, lease);
  assert.doesNotMatch(JSON.stringify(processes), /hidden|SECRET/);
  assert.deepEqual(orderedWaiters({ entries: [] }), []);
});

test("independent processes atomically acquire shared slots across projects", { timeout: 30000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const f = fixture(t, 2);
  const owners = Array.from({ length: 12 }, (_, i) => ({ ...f.owner("ordinary", `project-${i}`), pid: i + 100 }));
  const log = join(f.options.path, "..", "events.jsonl");
  const children = owners.map((owner) => {
    const script = `import { acquireSlot, releaseSlot } from ${JSON.stringify(new URL("../cli/load.mjs", import.meta.url).href)};
      import { appendFileSync } from 'node:fs';
      const options = {path: ${JSON.stringify(f.options.path)}, env: {ATELIER_TEST_SLOTS:'2'}, processes: () => ${JSON.stringify(owners)}};
      const owner = ${JSON.stringify(owner)};
      await acquireSlot(owner, options);
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({event:'start', project:owner.project}) + '\\n');
      await new Promise(resolve => setTimeout(resolve, 20));
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({event:'end', project:owner.project}) + '\\n');
      await releaseSlot(owner.lease, options, owner.pid);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (s) => error += s);
    t.after(() => { child.kill("SIGKILL"); });
    return new Promise((resolve, reject) => child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(error))));
  });
  await Promise.all(children);
  let active = 0, peak = 0;
  const projects = new Set();
  for (const event of readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)) {
    if (event.event === "start") { active++; projects.add(event.project); } else active--;
    peak = Math.max(peak, active);
    assert.ok(active >= 0 && active <= 2);
  }
  assert.equal(active, 0);
  assert.equal(peak, 2);
  assert.equal(projects.size, 12);
});

test("SIGKILL of a SQLite writer rolls back without stranding the pool lock", { timeout: 10000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const f = fixture(t), one = f.owner();
  await acquireSlot(one, f.options);
  const ready = join(f.options.path, "..", "writer-ready");
  const script = `import {DatabaseSync} from 'node:sqlite'; import {writeFileSync} from 'node:fs';
    const db = new DatabaseSync(${JSON.stringify(f.options.path)});
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE pool SET data=? WHERE id=1').run(JSON.stringify({capacity:1,entries:[],sequence:999}));
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    setTimeout(() => {}, 60000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise((done) => child.once("exit", done));
  t.after(() => child.kill("SIGKILL"));
  const deadline = Date.now() + 5000;
  while (!existsSync(ready)) {
    assert.ok(Date.now() < deadline, "writer did not enter its transaction");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill("SIGKILL");
  await exited;
  const status = await slotStatus(f.options);
  assert.equal(status.active[0].lease, one.lease);
  assert.equal(status.active[0].sequence, 1);
});
