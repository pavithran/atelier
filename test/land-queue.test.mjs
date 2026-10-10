import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// bin/orchestrate/land-queue.sh: landings run one at a time in queue order,
// each prints one LANDQ line naming its outcome, and additions made while
// the queue runs (--add, under the queue's lock) are never lost.

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = join(repo, "bin/orchestrate/land-queue.sh");
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((p) => existsSync(p));
const skip = !zsh && "zsh is not installed";

// A stand-in for the CLI: logs "start tN" and "end tN" to its log, then
// prints the outcome its task maps to.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "land-queue-"));
  const cli = join(dir, "cli.sh");
  const log = join(dir, "calls.log");
  writeFileSync(cli, `#!/bin/sh
echo "start $2 $*" >> ${log}
sleep 0.2
case "$2" in
  t2) echo "FAIL npm test @ abc";;
  t3) echo "conflict stage: paused";;
  *) echo "landed through abc";;
esac
echo "end $2" >> ${log}
`);
  chmodSync(cli, 0o755);
  const env = { ...process.env, ATELIER_CACHE: dir, ATELIER_CLI: cli, ATELIER_PROJECT: "p", LAND_QUEUE_LOAD: "100000", LAND_QUEUE_IDLE: "1", LAND_QUEUE_POLL: "1" };
  return { dir, env, log, queue: join(dir, "land-queue/p.queue") };
}

test("land-queue.sh lands one task at a time, in order, and reports each outcome", { skip }, () => {
  const f = fixture();
  try {
    const r = spawnSync(zsh, [script, "t1:a/b", "t2:c/d", "t3:e/f"], { env: f.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.match(lines[0], /^LANDQ t1: landed through abc$/);
    assert.match(lines[1], /^LANDQ t2: FAIL npm test @ abc$/);
    assert.match(lines[2], /^LANDQ t3: conflict stage: paused$/);
    assert.match(lines[3], /^LANDQ idle: nothing queued/);
    const log = readFileSync(f.log, "utf8");
    const calls = log.trim().split("\n").map((l) => l.split(" ").slice(0, 2).join(" "));
    assert.deepEqual(calls, ["start t1", "end t1", "start t2", "end t2", "start t3", "end t3"]);
    assert.match(log, /land t1 --project p --workflow --wait --reviewer a\/b/);
    assert.ok(existsSync(join(f.dir, "land-queue/t1.log")));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("land-queue.sh --add from many processes while the queue runs loses nothing", { skip }, async () => {
  const f = fixture();
  try {
    const n = 12;
    const q = spawn(zsh, [script, "t100:a/b"], { env: { ...f.env, LAND_QUEUE_IDLE: "4" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    q.stdout.on("data", (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 300));
    await Promise.all(Array.from({ length: n }, (_, i) => new Promise((res) => {
      spawn(zsh, [script, "--add", `t${200 + i}:a/b`], { env: f.env, stdio: "ignore" }).on("close", res);
    })));
    await new Promise((res) => q.on("close", res));
    const landed = [...out.matchAll(/^LANDQ (t\d+): landed/gm)].map((m) => m[1]).sort();
    const want = ["t100", ...Array.from({ length: n }, (_, i) => `t${200 + i}`)].sort();
    assert.deepEqual(landed, want);
    assert.ok(!existsSync(`${f.queue}.lock`));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
