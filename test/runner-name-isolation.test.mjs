// A test's runner never sees a runner live elsewhere on this Mac. A runner's
// start refuses when another of its name runs (t581), and it read every
// process on the machine, so a real home:studio, or one another test file
// had started, refused the runners of tests that ran beside it. Under npm
// test each test file's process names itself (test/guard.mjs) and the CLIs it
// starts read only its tree (withinTree, cli/procs.mjs); a second runner of
// the name inside that tree is still refused.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { withinTree } from "../cli/procs.mjs";

const dir = mkdtempSync(join(tmpdir(), "atelier-runner-name-"));
const pids = [];
after(() => {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true });
});
// A process whose command line reads as a runner named NAME, as ps shows one.
const stand = join(dir, "atelier.mjs");
writeFileSync(stand, "setInterval(() => {}, 1000);\n");
const NAME = `home:clash-${process.pid}`;
const start = () => spawnSync(process.execPath, [resolve("cli/atelier.mjs"), "runner", "--name", NAME, "--once"], {
  encoding: "utf8", timeout: 30_000,
  env: { ...process.env, ATELIER_SERVER: "http://127.0.0.1:9", ATELIER_TOKEN: "atl_00112233445566778899aabbccddeeff", NO_COLOR: "1" },
});
const waitFor = async (pid) => {
  for (let i = 0; i < 100; i++) {
    if (spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).stdout.includes(NAME)) return;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`the stand-in runner ${pid} never showed in ps`);
};

test("withinTree keeps the rows under the root, the root included, and nothing outside it", () => {
  const rows = [{ pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 20, ppid: 1 }, { pid: 21, ppid: 20 }];
  assert.deepEqual(withinTree(rows, 10).map((r) => r.pid), [10, 11, 12]);
  assert.deepEqual(withinTree(rows, 99), []);
});

test("a runner of the same name outside this test file's process tree does not refuse a test's runner", async () => {
  // Started by a shell that exits at once, so it belongs to no test's tree,
  // as a real runner on this Mac does not.
  const sh = spawnSync("sh", ["-c", `"${process.execPath}" "${stand}" runner --name ${NAME} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
  const pid = Number(sh.stdout.trim());
  assert.ok(pid > 0, sh.stderr);
  pids.push(pid);
  await waitFor(pid);
  const r = start();
  assert.doesNotMatch(r.stdout + r.stderr, /already running on this Mac/);
});

test("a second runner of the name inside this test file's tree is still refused", async () => {
  const child = spawn(process.execPath, [stand, "runner", "--name", NAME], { stdio: "ignore" });
  pids.push(child.pid);
  await waitFor(child.pid);
  const r = start();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`a runner named ${NAME} is already running on this Mac \\(pid ${child.pid}\\)`));
});
