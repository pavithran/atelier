import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What a run leaves behind (t617). An agent can start a process that outlives
// it: nohup, `&`, setsid, a group of its own. Process groups do not reach
// those, so a run's processes are found by the run's workspace as their
// working directory, and SIGKILLed once the run has ended.
//
// Why the working directory and not a marker in the environment: this
// machine's ps does not show another process's environment, so a marker could
// not be read back; lsof does show every own process's directory. The cost is
// a process that changes directory out of the workspace, which this does not
// find. Only the runner's own user's processes are looked at, and never this
// process.

const MOST_NAMED = 20;
const ROUNDS = 5;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

// The own user's processes, other than this one, whose working directory is
// `dir` or below it: [{ pid, command }].
export function processesIn(dir) {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* A folder gone holds no process. */ return []; }
  const uid = process.getuid?.();
  const listed = spawnSync("lsof", ["-n", "-P", "-a", "-d", "cwd", ...(uid === undefined ? [] : ["-u", String(uid)]), "-Fpn"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (listed.error) throw listed.error;
  const inside = (path) => [dir, real].some((root) => path === root || path.startsWith(`${root}/`));
  const pids = [];
  let current = null;
  for (const text of (listed.stdout ?? "").split("\n")) {
    if (text.startsWith("p")) current = Number(text.slice(1));
    else if (text.startsWith("n") && current && current !== process.pid && inside(text.slice(1)) && !pids.includes(current)) pids.push(current);
  }
  if (!pids.length) return [];
  const ps = spawnSync("ps", ["-ww", "-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf8", timeout: 10_000 });
  const commands = new Map((ps.stdout ?? "").split("\n").map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]));
  return pids.map((pid) => ({ pid, command: commands.get(pid) ?? "(ended)" }));
}

// SIGKILLs every process in `dir` (processesIn) until none is left or ROUNDS
// rounds have passed, and logs each as it ends it: the first MOST_NAMED by pid
// and command, the rest counted. Returns the processes it ended. A second
// sweep finds none and logs nothing. `log` and `kill` are local; no call goes
// to the server.
export async function sweepDir(dir, { log, kill = process.kill.bind(process) }) {
  const ended = [];
  for (let round = 0; round < ROUNDS; round++) {
    const found = processesIn(dir).filter((p) => !ended.some((e) => e.pid === p.pid));
    if (!found.length) break;
    for (const proc of found) {
      if (ended.some((e) => e.pid === proc.pid)) continue;
      try { kill(proc.pid, "SIGKILL"); } catch { continue; }
      ended.push(proc);
      if (ended.length <= MOST_NAMED) log(`ended leftover process ${proc.pid} (${proc.command.slice(0, 200)}) of the run in ${dir}`);
    }
    await pause(100);
  }
  if (ended.length > MOST_NAMED) log(`and ${ended.length - MOST_NAMED} more leftover processes of the run in ${dir}`);
  return ended;
}

// The workspaces of the runs a runner has begun and not finished sweeping,
// kept in a file named for the runner so a runner that died before or part-way
// through its sweep leaves the rest to its next start (recover). An entry is
// removed only after its sweep is done.
export function sweepJournal({ name, dir, log, kill }) {
  const file = join(dir, `${name.replace(/[^a-z0-9._-]/gi, "_")}.json`);
  const runs = new Map();
  let serial = 0;
  const save = () => {
    if (!runs.size) { try { unlinkSync(file); } catch { /* None written. */ } return; }
    mkdirSync(dir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ owner: process.pid, runs: Object.fromEntries(runs) }));
    renameSync(temporary, file);
  };
  return {
    // Records the run, then returns the handle whose end() sweeps it.
    begin(workspace) {
      const id = ++serial;
      runs.set(id, workspace);
      save();
      return { async end() { await sweepDir(workspace, { log, kill }); runs.delete(id); save(); } };
    },
    // Before the first claim: the earlier process of this name, if it is dead,
    // left its runs' workspaces here. Each is swept and the file removed.
    async recover() {
      let earlier;
      try { earlier = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
      if (!earlier || earlier.owner === process.pid || (Number.isInteger(earlier.owner) && alive(earlier.owner))) return;
      for (const workspace of Object.values(earlier.runs ?? {})) if (typeof workspace === "string") await sweepDir(workspace, { log, kill });
      if (!runs.size) { try { unlinkSync(file); } catch { /* Gone. */ } } else save();
    },
  };
}
