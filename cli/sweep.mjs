import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What a run leaves behind (t617). An agent can start a process that outlives
// it: nohup, `&`, setsid, a group of its own. Process groups do not reach
// those, so the run's processes are found three ways, and SIGKILLed once the
// run has ended:
//   1. the marker the runner puts in the harness's environment (MARK_VARIABLE),
//      which every descendant inherits, wherever it goes afterwards;
//   2. the run's workspace as the process's working directory;
//   3. a process seen as a descendant of the harness while the run was going
//      (watch), kept with its start time so a reused pid is never taken.
// Why all three: the marker is the exact test, but this machine's ps does not
// show another process's environment (Linux does, through /proc), so on it the
// marker finds nothing and the other two carry the sweep. The working
// directory finds what stayed; the watch finds what changed directory, if it
// was seen while its parent lived. Only the runner's own user's processes are
// looked at, and never this process.

export const MARK_VARIABLE = "ATELIER_RUN_MARK";
const MOST_NAMED = 20;
const ROUNDS = 5;
const WATCH_MS = 150;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const tool = (names, args, timeout) => {
  for (const name of names) {
    const result = spawnSync(name, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
    if (!result.error) return result.stdout ?? "";
    if (result.error.code !== "ENOENT") throw result.error;
  }
  return "";
};

// The own user's processes: [{ pid, ppid, started, command }].
export function listProcesses() {
  const uid = process.getuid?.();
  const out = tool(["ps", "/bin/ps"], ["-ww", ...(uid === undefined ? ["-A"] : ["-u", String(uid)]), "-o", "pid=,ppid=,lstart=,command="], 10_000);
  const procs = [];
  for (const text of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.*)$/.exec(text);
    if (m && Number(m[1]) !== process.pid) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), started: m[3].replace(/\s+/g, " "), command: m[4] });
  }
  return procs;
}

// The pids among `procs` whose environment holds the marker, where the system
// shows an environment at all.
function markedPids(marker, procs) {
  const found = new Set();
  const token = `${MARK_VARIABLE}=${marker}`;
  for (const { pid } of procs) {
    try { if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(token)) found.add(pid); } catch { /* Not shown. */ }
  }
  if (!found.size && procs.length) {
    const uid = process.getuid?.();
    const out = tool(["ps", "/bin/ps"], ["-E", "-ww", ...(uid === undefined ? ["-A"] : ["-u", String(uid)]), "-o", "pid=,command="], 10_000);
    for (const text of out.split("\n")) {
      const m = /^\s*(\d+)\s/.exec(text);
      if (m && text.split(/\s+/).includes(token)) found.add(Number(m[1]));
    }
  }
  return found;
}

// The pids whose working directory is `dir` or below it.
function pidsIn(dir) {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* A folder gone holds no process. */ return new Set(); }
  const uid = process.getuid?.();
  const out = tool(["lsof", "/usr/sbin/lsof"], ["-n", "-P", "-a", "-d", "cwd", ...(uid === undefined ? [] : ["-u", String(uid)]), "-Fpn"], 30_000);
  const inside = (path) => [dir, real].some((root) => path === root || path.startsWith(`${root}/`));
  const pids = new Set();
  let current = null;
  for (const text of out.split("\n")) {
    if (text.startsWith("p")) current = Number(text.slice(1));
    else if (text.startsWith("n") && current && inside(text.slice(1))) pids.add(current);
  }
  return pids;
}

// The run's live processes: [{ pid, command }]. `run` is { workspace, marker,
// tracked } where tracked is { pid: start time } of descendants seen.
export function processesOf(run) {
  const procs = listProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chosen = new Set();
  if (run.workspace) for (const pid of pidsIn(run.workspace)) if (byPid.has(pid)) chosen.add(pid);
  if (run.marker) for (const pid of markedPids(run.marker, procs)) chosen.add(pid);
  for (const [pid, started] of Object.entries(run.tracked ?? {})) if (byPid.get(Number(pid))?.started === started) chosen.add(Number(pid));
  return [...chosen].map((pid) => ({ pid, command: byPid.get(pid).command }));
}

// Notes every descendant of `root` while it runs. Returns { tracked, stop }:
// `tracked` is filled in as processes are seen; stop() takes a last look.
export function watch(root, tracked = {}, onNew = () => {}) {
  const look = () => {
    let procs;
    try { procs = listProcesses(); } catch { return; }
    const known = new Set([root, ...Object.keys(tracked).map(Number)]);
    let grew = true, added = false;
    while (grew) {
      grew = false;
      for (const p of procs) if (!known.has(p.pid) && known.has(p.ppid)) { known.add(p.pid); tracked[p.pid] = p.started; grew = added = true; }
    }
    if (added) onNew();
  };
  look();
  const timer = setInterval(look, WATCH_MS);
  return { tracked, stop() { clearInterval(timer); look(); } };
}

// SIGKILLs every process of the run until none is left or ROUNDS rounds have
// passed, and logs each as it ends it: the first MOST_NAMED by pid and
// command, the rest counted. Returns { ended, incomplete }: the processes it
// ended, and whether any is still there or could not be signalled for a reason
// other than having gone. A second sweep finds none and logs nothing. `log`
// and `kill` are local; no call goes to the server.
export async function sweepRun(run, { log, kill = process.kill.bind(process) }) {
  const ended = [], failed = new Set();
  const where = run.workspace ?? "the run";
  for (let round = 0; round < ROUNDS; round++) {
    const found = processesOf(run).filter((p) => !ended.some((e) => e.pid === p.pid));
    if (!found.length) break;
    for (const proc of found) {
      try { kill(proc.pid, "SIGKILL"); } catch (error) {
        if (error.code === "ESRCH") continue;
        failed.add(proc.pid); continue;
      }
      failed.delete(proc.pid);
      ended.push(proc);
      if (ended.length <= MOST_NAMED) log(`ended leftover process ${proc.pid} (${proc.command.slice(0, 200)}) of the run in ${where}`);
    }
    await pause(100);
  }
  if (ended.length > MOST_NAMED) log(`and ${ended.length - MOST_NAMED} more leftover processes of the run in ${where}`);
  const left = processesOf(run);
  const incomplete = left.length > 0 || [...failed].some(alive);
  if (incomplete) log(`${left.length || failed.size} leftover process${(left.length || failed.size) === 1 ? "" : "es"} of the run in ${where} could not be ended; the next start tries again`);
  return { ended, incomplete };
}

// A sweep of the processes in a folder alone, for callers with no run record.
export const sweepDir = (dir, options) => sweepRun({ workspace: dir }, options);

// The runs a runner has begun and not finished sweeping, kept in a file named
// for the runner so a runner that died before or part-way through its sweep,
// or whose sweep left a process, leaves the rest to its next start (recover).
// An entry is removed only after its sweep is complete.
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
  const keep = (record) => { const id = ++serial; runs.set(id, record); save(); return id; };
  return {
    // Records the run, then returns the handle: marker is the value for the
    // harness's MARK_VARIABLE; spawned(pid) starts watching the harness;
    // end() sweeps, and drops the record only if the sweep was complete.
    begin(workspace) {
      const marker = `${name.replace(/[^a-z0-9._-]/gi, "_")}.${process.pid}.${Date.now().toString(36)}.${serial + 1}`;
      const record = { workspace, marker, tracked: {} };
      const id = keep(record);
      let watcher = null;
      return {
        marker,
        spawned(pid) { watcher ??= watch(pid, record.tracked, save); },
        async end() {
          watcher?.stop();
          const { incomplete } = await sweepRun(record, { log, kill });
          if (!incomplete) { runs.delete(id); save(); } else save();
          return { incomplete };
        },
      };
    },
    // Before the first claim: the earlier process of this name, if it is dead,
    // left its runs here. Each is swept; one that cannot be finished is kept
    // under this process for the start after.
    async recover() {
      let earlier;
      try { earlier = JSON.parse(readFileSync(file, "utf8")); } catch { return { incomplete: false }; }
      if (!earlier || earlier.owner === process.pid || (Number.isInteger(earlier.owner) && alive(earlier.owner))) return { incomplete: false };
      let incomplete = false;
      for (const entry of Object.values(earlier.runs ?? {})) {
        const record = typeof entry === "string" ? { workspace: entry } : entry && typeof entry.workspace === "string" ? entry : null;
        if (!record) continue;
        const result = await sweepRun(record, { log, kill });
        if (result.incomplete) { incomplete = true; keep(record); }
      }
      if (!runs.size) { try { unlinkSync(file); } catch { /* Gone. */ } } else save();
      return { incomplete };
    },
  };
}
