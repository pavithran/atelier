import { spawnSync } from "node:child_process";
import { join, sep } from "node:path";

// Test processes a workspace left running (t419): a test runner, a test
// file's process or a watcher whose working directory, or whose command,
// lies in a workspace under the cache's work/ folder, running an hour or
// more. On 2026-10-09 seven such processes had spun a core each for a day,
// parented to PID 1, and nothing said so. `atelier status` names them; it
// never ends them, for a pid is the owner's to check before a kill.

export const STRAY_AGE_S = 3600;

// A command that runs tests: node --test, a test or spec file, vitest, jest,
// pytest, or npm test.
const TEST_COMMAND = /\s--test(\s|=|$)|\.(test|spec)\.[cm]?[jt]sx?\b|\bvitest\b|\bjest\b|\bpytest\b|\bnpm (run )?test\b/;

// ps's elapsed time, [[dd-]hh:]mm:ss, in seconds; null when unreadable.
export function etimeSeconds(text) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

// `ps -axo pid=,ppid=,etime=,command=` as { pid, ppid, elapsed, command }.
export function parsePs(text) {
  return text.split("\n").flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);
    const elapsed = m ? etimeSeconds(m[3]) : null;
    return m && elapsed !== null ? [{ pid: Number(m[1]), ppid: Number(m[2]), elapsed, command: m[4].trim() }] : [];
  });
}

// `lsof -a -d cwd -Fn -p …` as a map from pid to working directory.
export function parseLsofCwd(text) {
  const cwds = new Map();
  let pid = null;
  for (const l of text.split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && pid !== null) cwds.set(pid, l.slice(1));
  }
  return cwds;
}

// The workspace ("project/id") a path lies in under `work`, or null.
function workspaceOf(path, work) {
  const at = path.indexOf(work + sep);
  if (at === -1) return null;
  const [project, id] = path.slice(at + work.length + 1).split(/[/\s]/);
  return project && id ? `${project}/${id}` : null;
}

// The processes in `procs` that run tests, have run `minAge` seconds or more
// and belong to a workspace under `cache`: by the working directory `cwds`
// names, or else by a workspace path in the command.
export function strayTests(procs, cwds, cache, minAge = STRAY_AGE_S) {
  const work = join(cache, "work");
  return procs.flatMap((p) => {
    if (p.elapsed < minAge || !TEST_COMMAND.test(p.command)) return [];
    const cwd = cwds.get(p.pid) ?? null;
    const workspace = (cwd && workspaceOf(cwd, work)) ?? workspaceOf(p.command, work);
    return workspace ? [{ ...p, cwd, workspace }] : [];
  }).sort((a, b) => b.elapsed - a.elapsed || a.pid - b.pid);
}

const age = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

// The section of `atelier status`, or null when there is none to name.
export function formatStrays(strays) {
  if (!strays.length) return null;
  const command = (c) => (c.length > 120 ? `${c.slice(0, 119)}…` : c);
  return [
    `Test processes left from workspaces on this Mac (${strays.length}, each running over an hour):`,
    ...strays.map((p) => `  pid ${p.pid}  ${p.workspace}  running ${age(p.elapsed)}${p.ppid === 1 ? "  orphaned (parent is PID 1)" : ""}  ${command(p.command)}`),
    "  Check each with ps -o pid,ppid,etime,command -p PID before ending it with kill PID.",
  ].join("\n");
}

// Reads this machine's processes and finds the stray tests among them. A
// machine where ps or lsof cannot run names none.
export function findStrays(cache, { run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 }), minAge = STRAY_AGE_S } = {}) {
  const ps = run("ps", ["-axo", "pid=,ppid=,etime=,command="]);
  if (ps.status !== 0 || !ps.stdout) return [];
  const candidates = parsePs(ps.stdout).filter((p) => p.elapsed >= minAge && TEST_COMMAND.test(p.command) && p.pid !== process.pid);
  if (!candidates.length) return [];
  const lsof = run("lsof", ["-a", "-d", "cwd", "-Fn", "-p", candidates.map((p) => p.pid).join(",")]);
  return strayTests(candidates, parseLsofCwd(lsof.stdout ?? ""), cache, minAge);
}
