import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { HOST_POOL, poolTransaction, slotStatus } from "../cli/load.mjs";

const moduleURL = new URL("../cli/load.mjs", import.meta.url).href;
const pause = () => new Promise((done) => setTimeout(done, 20));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-sharing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "pool.sqlite");
}

test("host pool uses a shared non-sticky directory", () => {
  assert.notEqual(dirname(HOST_POOL), "/tmp");
});

for (const mask of [0o077, 0o027]) test(`creator umask ${mask.toString(8)} permits shared access and hot-journal recovery`, async (t) => {
  const path = fixture(t);
  const script = `import { poolTransaction } from ${JSON.stringify(moduleURL)};
    process.umask(${mask});
    await poolTransaction({path:${JSON.stringify(path)}, processes:()=>[]});
    const {DatabaseSync} = await import("node:sqlite");
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === "COMMIT") process.kill(process.pid, "SIGKILL");
      if (sql === "BEGIN IMMEDIATE") exec.call(this, "PRAGMA cache_size=1");
      return exec.call(this, sql);
    };
    await poolTransaction({path:${JSON.stringify(path)}, processes:()=>[]}, state => {
      state.capacity = 999;
      state.padding = "x".repeat(2 * 1024 * 1024);
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
  let output = "";
  child.stderr.on("data", (data) => output += data);
  assert.equal(await new Promise((done) => child.once("exit", (code, signal) => done(signal))), "SIGKILL", output);
  assert.equal(statSync(dirname(path)).mode & 0o1777, 0o777);
  assert.equal(statSync(path).mode & 0o666, 0o666, output);
  assert.equal(statSync(`${path}-journal`).mode & 0o666, 0o666);
  assert.notDeepEqual(readFileSync(`${path}-journal`).subarray(0, 8), Buffer.alloc(8), "journal must be hot");
  const previous = process.umask(0o077);
  try {
    assert.equal((await slotStatus({path, processes:()=>[]})).capacity, 1, "crashed update must remain uncommitted");
    await poolTransaction({path, processes:()=>[]}, state => { state.capacity = 2; });
    assert.equal(process.umask(), 0o077);
    assert.equal((await slotStatus({path, processes:()=>[]})).capacity, 2);
  } finally { process.umask(previous); }
});

test("a forged pool PID cannot redirect wrapper cleanup", { timeout: 15000 }, async (t) => {
  const path = fixture(t);
  const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  let victimExit = false;
  victim.once("exit", () => victimExit = true);
  const lease = randomUUID(), victimLease = randomUUID();
  const processes = [{pid:victim.pid, lease:victimLease}, {pid:process.pid, lease}];
  await poolTransaction({path, processes:()=>processes}, state => {
    state.entries.push({pid:victim.pid, lease, started:"forged", claimed:false});
    state.capacity = 2;
  });
  try {
    const script = `import {runSlotCommand} from ${JSON.stringify(moduleURL)};
      await runSlotCommand([process.execPath,'-e','process.exit(0)'], {}, {path:${JSON.stringify(path)}});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {env:{...process.env, ATELIER_TEST_LEASE:lease}});
    let error = "";
    child.stderr.on("data", data => error += data);
    assert.equal(await new Promise(done => child.once("exit", done)), 0, error);
    await pause();
    assert.equal(victimExit, false);
  } finally { victim.kill("SIGKILL"); }
});
