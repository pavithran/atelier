import { spawnSync } from "node:child_process";

// The clock of a check's run (G7, src/check-limit.ts). It starts when the run
// holds its test slot: the slot wrapper (cli/load.mjs) writes the pid of the
// command it starts to the descriptor SLOT_HELD_FD names once the slot is
// held, and the time spent queued before that is not counted. A run started
// without the wrapper starts its clock when it starts.
//
// The run is stopped for silence, not for a clock alone: when it has printed
// nothing and its processes have shown no activity (CPU time spent, a process
// started or ended) for `silenceMs`, it is "silent". A run that keeps
// progressing goes on to `ceilingMs`, where it "timed out". A run with a live
// child process is quiet, not hung: its silence clock does not run (the
// stall rule from running builders directly in miqra: the log unchanged and
// no child alive). Given `startupMs`, a run that within that long of its start
// has shown no work is stopped as "startup": it printed nothing, no child
// process was seen in it and its processes spent no CPU time after the first
// quarter of the limit (a harness blocked on a prompt under launchd does none of these).
// A child that starts and ends between two readings is not seen as a child,
// so the stop names what was observed, not that no command ran. Given
// `slotWaitMs`, a run that waits that long for its test slot is stopped as
// "slot"; the wait never counts toward the other limits.

// The environment variable naming the descriptor the wrapper reports on.
export const SLOT_HELD_FD = "ATELIER_SLOT_HELD_FD";

// What stops the run now, or null: the ceiling first, then the silence. Pure,
// so a test can give it any times (30 minutes queued, 5 running) without
// waiting for them. `heldAt` null means the slot is not held yet, and nothing
// counts.
export function clockStop({ heldAt, lastActivityAt, now, ceilingMs, silenceMs, startupMs, progressed = true, startedAt, slotWaitMs }) {
  if (heldAt === null || heldAt === undefined) return slotWaitMs !== undefined && startedAt !== undefined && now - startedAt >= slotWaitMs ? { kind: "slot", ms: slotWaitMs } : null;
  if (ceilingMs !== undefined && now - heldAt >= ceilingMs) return { kind: "timeout", ms: ceilingMs };
  if (startupMs !== undefined && !progressed && now - heldAt >= startupMs) return { kind: "startup", ms: startupMs };
  if (silenceMs !== undefined && now - Math.max(heldAt, lastActivityAt ?? heldAt) >= silenceMs) return { kind: "silent", ms: silenceMs };
  return null;
}

// CPU time as ps prints it, in hundredths of a second: [dd-][hh:]mm:ss[.cc].
export function cpuTime(text) {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = rest.split(":").map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(seconds) ? Math.round((Number(days) * 86400 + seconds) * 100) : 0;
}

// The activity of the process tree under `root`: `reading`, the processes in
// it and the CPU time they have spent as one comparable text (a change between
// two readings is activity), and `children`, how many processes under the root
// are alive. Null when ps cannot be read, which counts as activity: a run is
// never stopped on a reading that could not be made.
export function treeActivity(root, read = () => spawnSync("ps", ["-A", "-o", "pid=,ppid=,time="], { encoding: "utf8", timeout: 5000 })) {
  const ps = read();
  if (ps.status !== 0 || !ps.stdout) return null;
  const rows = ps.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/)).filter((r) => r.length >= 3).map(([pid, ppid, time]) => ({ pid: Number(pid), ppid: Number(ppid), cpu: cpuTime(time) }));
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (tree.has(r.ppid) && !tree.has(r.pid)) { tree.add(r.pid); grew = true; }
  }
  const members = rows.filter((r) => tree.has(r.pid));
  return { reading: `${[...tree].sort((a, b) => a - b).join(",")}:${members.reduce((n, r) => n + r.cpu, 0)}`, children: members.filter((r) => r.pid !== root).length };
}

// How often the activity is read: often enough to stop within a tenth of the
// shorter limit, never more than every 15 seconds nor less than every 50 ms.
export const pollMs = (...limits) => Math.max(50, Math.min(15_000, Math.min(...limits.map((l) => l ?? Infinity)) / 10));

// Watches one run. `held` is the readable stream of the wrapper's report, or
// null for a run whose clock starts now. `onStop(stop)` is called once, with
// {kind, ms}, when a limit passes. The caller calls `output()` for every piece
// of output and `end()` when the run is over.
export function watchRun({ pid, held = null, ceilingMs, silenceMs, startupMs, slotWaitMs, onStop, probe = treeActivity, now = Date.now, every }) {
  if (ceilingMs === undefined && silenceMs === undefined && startupMs === undefined && (slotWaitMs === undefined || !held)) return { output() {}, end() {} };
  const startedAt = now();
  let heldAt = held ? null : startedAt, lastActivityAt = heldAt, root = pid, last, first, stopped = false, progressed = false;
  if (held) {
    let text = "";
    held.setEncoding?.("utf8");
    held.on("data", (chunk) => {
      if (heldAt !== null) return;
      text += chunk;
      const reported = /^(\d+)\n/.exec(text);
      if (!reported) return;
      heldAt = lastActivityAt = now();
      root = Number(reported[1]) || pid;
    });
    held.on("error", () => {});
  }
  const timer = setInterval(() => {
    if (stopped) return;
    const halt = (stop) => { stopped = true; clearInterval(timer); onStop(stop); };
    if (heldAt === null) {
      const waited = clockStop({ heldAt, now: now(), startedAt, slotWaitMs });
      if (waited) halt(waited);
      return;
    }
    const sample = silenceMs === undefined && startupMs === undefined ? { reading: "", children: 0 } : probe(root);
    if (sample === null || sample.reading !== last) { last = sample?.reading; lastActivityAt = now(); }
    // A live child: quiet, not hung.
    if (sample === null || sample.children > 0) lastActivityAt = now();
    // Work: a child seen, or the tree's processes or CPU time changed since
    // the first reading a quarter of the startup limit in, once the program's
    // own start-up has passed.
    if (first === undefined && now() - heldAt >= (startupMs ?? 0) / 4) first = sample?.reading;
    if (sample === null || sample.children > 0 || (first !== undefined && sample.reading !== first)) progressed = true;
    const stop = clockStop({ heldAt, lastActivityAt, now: now(), ceilingMs, silenceMs, startupMs, progressed });
    if (stop) halt(stop);
  }, every ?? pollMs(ceilingMs, silenceMs, startupMs, slotWaitMs));
  timer.unref?.();
  return {
    output() { if (heldAt !== null) { lastActivityAt = now(); progressed = true; } },
    end() { clearInterval(timer); },
  };
}
