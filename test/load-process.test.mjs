import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const run = (command, cls = "ordinary", lease = randomUUID()) => {
    const script = `import { runSlotCommand } from ${JSON.stringify(moduleURL)};
      try { await runSlotCommand(${JSON.stringify(command)}, { class: ${JSON.stringify(cls)}, project: 'project-' + process.pid, actor: 'codex/test', task: 't1' }, { path: ${JSON.stringify(path)} }); }
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
