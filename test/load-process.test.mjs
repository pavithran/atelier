import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
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

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-slot-process-"));
  const path = join(root, "pool.sqlite"), env = { ATELIER_TEST_SLOTS: "1" };
  const children = [];
  t.after(async () => {
    for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } }
    await Promise.all(children.map((child) => child.finished));
    rmSync(root, { force: true, recursive: true });
  });
  const run = (command, cls = "ordinary", lease = randomUUID(), sequence = {}) => {
    const script = `import { runSlotCommand } from ${JSON.stringify(moduleURL)};
      try { await runSlotCommand(${JSON.stringify(command)}, { class: ${JSON.stringify(cls)}, project: 'project-' + process.pid, actor: 'codex/test', task: 't1', ...${JSON.stringify(sequence)} }, { path: ${JSON.stringify(path)} }); }
      catch (error) { console.error(error); process.exitCode = 1; }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      detached: true, env: { ...process.env, ...env, ATELIER_TEST_LEASE: lease }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.lease = lease;
    child.output = "";
    child.stdout.on("data", (s) => child.output += s);
    child.stderr.on("data", (s) => child.output += s);
    child.finished = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
    children.push(child);
    return child;
  };
  return { root, path, run, status: () => slotStatus({ path, env }) };
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


test("release sequence real processes retain gaps, then yield before the fourth continuation", { timeout: 30000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t), sequenceId = randomUUID(), order = join(f.root, "order");
  const command = (label) => [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(order)}, ${JSON.stringify(label)});`];
  const first = f.run(command("0"), "release", randomUUID(), { sequenceId, sequenceStep: 0 });
  assert.equal((await first.finished).code, 0, first.output);
  const ordinary = f.run(command("O"));
  await until(async () => (await f.status()).waiters.length === 1, "ordinary did not queue behind reservation");
  for (let step = 1; step <= 4; step++) {
    const child = f.run(command(String(step)), "release", randomUUID(), { sequenceId, sequenceStep: step });
    assert.equal((await child.finished).code, 0, child.output);
  }
  assert.equal((await ordinary.finished).code, 0, ordinary.output);
  assert.equal(readFileSync(order, "utf8"), "0123O4");
});

test("release sequence failure frees immediately and an abandoned idle reservation expires", { timeout: 30000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t), sequenceId = randomUUID();
  const failure = f.run([process.execPath, "-e", "process.exit(9)"], "release", randomUUID(), { sequenceId, sequenceStep: 0 });
  assert.equal((await failure.finished).code, 9, failure.output);
  assert.equal((await f.status()).usage, 0);
  const success = f.run([process.execPath, "-e", "process.exit(0)"], "release", randomUUID(), { sequenceId, sequenceStep: 0 });
  assert.equal((await success.finished).code, 0, success.output);
  assert.equal((await f.status()).usage, 1, "exited caller retains only bounded idle reservation");
  const ordinary = f.run([process.execPath, "-e", "process.exit(0)"]);
  assert.equal((await ordinary.finished).code, 0, ordinary.output);
  assert.equal((await f.status()).usage, 0);
});


test("cancelling a running release sequence leaves no reservation", { timeout: 30000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = fixture(t), marker = join(f.root, "started");
  const child = f.run([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`], "release", randomUUID(), { sequenceId: randomUUID(), sequenceStep: 0 });
  await until(() => existsSync(marker), "release never started");
  child.kill("SIGTERM");
  assert.equal((await child.finished).code, 143, child.output);
  assert.equal((await f.status()).usage, 0);
});
