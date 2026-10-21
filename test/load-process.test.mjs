import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slotStatus } from "../cli/load.mjs";

const moduleURL = new URL("../cli/load.mjs", import.meta.url).href;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await pause(25);
  }
  throw new Error(message);
}

function fixture(t, env = { ATELIER_TEST_SLOTS: "1" }) {
  const root = mkdtempSync(join(tmpdir(), "atelier-slot-process-"));
  const path = join(root, "pool.sqlite");
  const children = [];
  t.after(async () => {
    for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } }
    await Promise.all(children.map((child) => child.finished));
    rmSync(root, { force: true, recursive: true });
  });
  // A node script run in a process group of its own with a lease of its own;
  // ATELIER_TEST_SLOTS is whatever `env` gives, never the caller's.
  const spawnScript = (script, lease = randomUUID()) => {
    const base = { ...process.env, ...env, ATELIER_TEST_LEASE: lease };
    if (env.ATELIER_TEST_SLOTS === undefined) delete base.ATELIER_TEST_SLOTS;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { detached: true, env: base, stdio: ["ignore", "pipe", "pipe"] });
    child.lease = lease;
    child.output = "";
    child.stdout.on("data", (s) => child.output += s);
    child.stderr.on("data", (s) => child.output += s);
    child.finished = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
    children.push(child);
    return child;
  };
  const run = (command, cls = "ordinary", lease = randomUUID()) => {
    const script = `import { runSlotCommand } from ${JSON.stringify(moduleURL)};
      try { await runSlotCommand(${JSON.stringify(command)}, { class: ${JSON.stringify(cls)}, project: 'project-' + process.pid, actor: 'codex/test', task: 't1' }, { path: ${JSON.stringify(path)} }); }
      catch (error) { console.error(error); process.exitCode = 1; }`;
    return spawnScript(script, lease);
  };
  return { root, path, run, spawn: spawnScript, status: () => slotStatus({ path, env }) };
}

test("real wrappers: queued cancellation, SIGKILL, surviving children and reclamation", { timeout: 30000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t), childFile = join(f.root, "child.pid");
  const held = f.run([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(childFile)}, String(process.pid)); setTimeout(() => {}, 20000);`]);
  await until(() => existsSync(childFile), "test child never started");
  const status = await f.status();
  assert.equal(status.active.length, 1);
  assert.ok(status.active[0].processes.length >= 2);
  const waiting = f.run([process.execPath, "-e", "process.exit(77)"]);
  await until(async () => (await f.status()).waiters.length === 1, "waiter never queued");
  waiting.kill("SIGTERM");
  await waiting.finished;
  assert.equal((await f.status()).waiters.length, 0);
  held.kill("SIGKILL");
  await held.finished;
  assert.equal((await f.status()).active.length, 1, "the surviving command still owns the slot");
  const childPid = Number(readFileSync(childFile, "utf8"));
  process.kill(childPid, "SIGKILL");
  await until(async () => !(await f.status()).active.length, "abandoned slot was not reclaimed");
  const next = f.run([process.execPath, "-e", "process.exit(0)"]);
  assert.equal((await next.finished).code, 0, next.output);
});

test("real nested wrappers reuse one slot and a failed spawn releases it", { timeout: 30000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t);
  const nested = `import { runSlotCommand } from ${JSON.stringify(moduleURL)};
    await runSlotCommand([process.execPath, '-e', 'console.log("nested ran")'], {}, {path: ${JSON.stringify(f.path)}});`;
  const child = f.run([process.execPath, "--input-type=module", "-e", nested]);
  assert.equal((await child.finished).code, 0, child.output);
  assert.match(child.output, /nested ran/);
  assert.equal((await f.status()).active.length, 0);
  const failed = f.run([join(f.root, "missing-program")]);
  assert.equal((await failed.finished).code, 1);
  assert.equal((await f.status()).active.length, 0);
  const signalled = f.run([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]);
  assert.equal((await signalled.finished).signal, "SIGTERM");
  assert.equal((await f.status()).active.length, 0);
});


test("real wrapper CLI sets capacity, preserves launch tokens, drains and reports exit status", { timeout: 30000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t);
  // Isolate only the fixed database location; execute the actual CLI and its
  // nonce-launch route, with no replacement of admission or process inspection.
  const wrapper = join(realpathSync(f.root), "load.mjs");
  writeFileSync(wrapper, readFileSync(new URL("../cli/load.mjs", import.meta.url), "utf8")
    .replace('"/tmp/atelier-test-slots-v1.sqlite"', JSON.stringify(f.path)));
  const cli = (args, slots = "invalid") => {
    const env = { ...process.env, ATELIER_TEST_SLOTS: slots };
    delete env.ATELIER_TEST_LEASE;
    delete env.ATELIER_TOKEN;
    const child = spawn(process.execPath, [wrapper, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    t.after(() => child.kill("SIGKILL"));
    return new Promise((resolve) => child.once("exit", (code) => resolve({ code, stdout, stderr })));
  };
  assert.equal((await cli(["--set", "2"])).code, 0);
  const holds = [f.run([process.execPath, "-e", "setTimeout(() => {}, 20000)"]), f.run([process.execPath, "-e", "setTimeout(() => {}, 20000)"])];
  await until(async () => (await f.status()).active.length === 2, "two commands did not start");
  assert.equal((await cli(["--set", "1"])).code, 0);
  const json = await cli(["--status", "--json"]);
  assert.equal(json.code, 0);
  const status = JSON.parse(json.stdout);
  assert.equal(status.capacity, 1);
  assert.equal(status.usage, 2);
  assert.equal(status.draining, 1);
  assert.deepEqual(new Set(status.active.map((e) => e.lease)), new Set(holds.map((e) => e.lease)));
  assert.match((await cli(["--status"])).stdout, /draining excess: 1/);
  for (const value of ["0", "-1", "1.5", "9007199254740992"]) assert.equal((await cli(["--set", value])).code, 1);
  assert.equal((await cli(["--set", "2", "extra"])).code, 1);
  for (const held of holds) held.kill("SIGTERM");
  await Promise.all(holds.map((held) => held.finished));
  const nested = await cli(["--", process.execPath, wrapper, "--", process.execPath, "-e", 'console.log(process.env.ATELIER_TEST_LEASE); process.exit(7)']);
  assert.equal(nested.code, 7, nested.stderr);
  assert.match(nested.stdout, /[a-f0-9-]{36}/);
  assert.match(nested.stderr, /warning:.*invalid/);
  assert.equal((await f.status()).active.length, 0);
});

// t161: atelier land t142 t140 t139 ran three clean-clone suites at once on one
// 18-core Mac (default capacity four), and two landings failed both attempts.
// Three landing processes run a step of their own that must overlap (each
// waits until all three are in it, so serialising the steps would hang), then
// a check through the real wrapper under the default capacity (no
// ATELIER_TEST_SLOTS anywhere): the checks must never run two at once.
test("real landings under the default capacity run their checks one at a time while their other steps overlap", { timeout: 60000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t, {});
  const log = join(f.root, "checks.log"), steps = join(f.root, "steps");
  mkdirSync(steps);
  const check = join(f.root, "check.mjs");
  writeFileSync(check, `import { appendFileSync } from "node:fs";
    appendFileSync(process.argv[2], "start\\n");
    setTimeout(() => appendFileSync(process.argv[2], "end\\n"), 400);`);
  const script = `import { runSlotCommand } from ${JSON.stringify(moduleURL)};
    import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    // The step beside the others: in it until all three landings are.
    writeFileSync(${JSON.stringify(steps)} + "/" + process.pid, "");
    while (readdirSync(${JSON.stringify(steps)}).length < 3) await sleep(20);
    await runSlotCommand([process.execPath, ${JSON.stringify(check)}, ${JSON.stringify(log)}], { class: "release", project: "project", actor: "codex/test", task: "t" + process.pid }, { path: ${JSON.stringify(f.path)} });`;
  const landings = [1, 2, 3].map(() => f.spawn(script));
  const ends = await Promise.all(landings.map((l) => l.finished));
  for (const [i, end] of ends.entries()) assert.equal(end.code, 0, landings[i].output);
  assert.equal((await f.status()).capacity, 1);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["start", "end", "start", "end", "start", "end"]);
});
