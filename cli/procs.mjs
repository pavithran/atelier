// The runners and agent processes live on this machine, by task, with no
// command lines. A command line can hold a prompt or a token, and a
// `pgrep -f` on one matches the command that asked. So the process table is
// read as columns, a runner is told by its argv shape and printed by its
// --name, and an agent by where it works: a process whose working
// directory is a task's workspace (work/PROJECT/ID under the CLI's cache) is
// that task's agent. The caller reads `ps` and `lsof`; this only parses and
// words. Pure.

// `ps -axo pid=,ppid=,etime=,args=` -> [{ pid, ppid, etime, args }].
export function parsePs(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], args: m[4].trim() });
  }
  return rows;
}

// `lsof -a -d cwd -Fpcn` -> Map pid -> { comm, cwd }.
export function parseLsof(text) {
  const out = new Map();
  let cur = null;
  for (const line of text.split("\n")) {
    const tag = line[0], value = line.slice(1);
    if (tag === "p") { cur = { comm: "", cwd: "" }; out.set(Number(value), cur); }
    else if (cur && tag === "c") cur.comm = value;
    else if (cur && tag === "n") cur.cwd = value;
  }
  return out;
}

// ps's elapsed time, [[dd-]hh:]mm:ss, as a short age.
export function age(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return etime;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0));
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${mi}m`;
  if (mi) return `${mi}m`;
  return `${s}s`;
}

// Whether the command line is the runner: atelier.mjs (or `atelier`), then
// any flags, then the word runner, as the CLI's parser takes them (so
// `atelier.mjs --name home:x runner` counts). The line is read whole, not
// split on spaces, since the script's path may hold some (iCloud's Mobile
// Documents does). Behind an interpreter the script may be any path ending
// in atelier[.mjs]; with none, the command itself must be, so
// `grep atelier runner` is not a runner. A flag that takes a value hides
// that value from the search for the command word.
const VALUE_FLAGS = new Set(["name", "config", "project", "as"]);
const commandWord = (text) => {
  const words = text.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--" || !w) return null;
    if (!w.startsWith("-")) return w;
    if (w.startsWith("--") && !w.includes("=") && VALUE_FLAGS.has(w.slice(2))) i++;
  }
  return null;
};
const isRunner = (args) => {
  const m = /^(?:\S*\/)?(?:node|bun|deno)\s+(.*)$/.exec(args);
  const text = m ? m[1] : args;
  // Each place that ends "atelier" or "atelier.mjs" could be the script, since
  // its own path may hold the word and a space.
  for (const hit of text.matchAll(/(?:^|\/)atelier(?:\.mjs)?(?=\s|$)/g)) {
    if (!m && hit.index !== 0 && /\s/.test(text.slice(0, hit.index))) continue;
    if (commandWord(text.slice(hit.index + hit[0].length)) === "runner") return true;
  }
  return false;
};
const runnerName = (args) => /\s--name(?:=|\s+)(\S+)/.exec(args)?.[1] ?? "runner";

// The task a working directory belongs to, under `work`, or null.
export function taskOf(cwd, work) {
  const root = work.replace(/\/+$/, "") + "/";
  if (!cwd.startsWith(root)) return null;
  const [project, id] = cwd.slice(root.length).split("/");
  return project && /^t\d+(-review-[\w-]+)?$/.test(id ?? "") ? { project, id: id.replace(/-review-.*$/, "") } : null;
}

// { runners: [{ pid, name, age, tasks }], agents: [{ pid, command, age, project, id }] }.
// `skip` holds pids to leave out (this command and its children).
export function liveProcesses({ ps, lsof, work, skip = [], project = null }) {
  const skipped = new Set(skip);
  const byPid = new Map(ps.map((p) => [p.pid, p]));
  const agents = [];
  for (const [pid, { comm, cwd }] of lsof) {
    const row = byPid.get(pid), task = taskOf(cwd, work);
    if (!row || !task || skipped.has(pid) || isRunner(row.args) || (project && task.project !== project)) continue;
    agents.push({ pid, command: comm.split("/").pop(), age: age(row.etime), project: task.project, id: task.id });
  }
  const runners = ps.filter((p) => !skipped.has(p.pid) && isRunner(p.args)).map((p) => {
    const tasks = new Set();
    for (const a of agents) {
      const seen = new Set();
      for (let at = byPid.get(a.pid); at && !seen.has(at.pid); at = byPid.get(at.ppid)) {
        seen.add(at.pid);
        if (at.ppid === p.pid) { tasks.add(a.id); break; }
      }
    }
    return { pid: p.pid, ppid: p.ppid, name: runnerName(p.args), age: age(p.etime), tasks: [...tasks].sort() };
  });
  const byTask = (a, b) => a.id.localeCompare(b.id, "en", { numeric: true }) || a.pid - b.pid;
  return { runners: runners.sort((a, b) => a.pid - b.pid), agents: agents.sort(byTask) };
}

// The runners that share a name (compared without case, as the server does),
// as [{ name, pids }]. One name is one process: a second one polls the queue
// as the first and the two race for the same tasks (t581).
export function duplicateRunners(runners) {
  const byName = new Map();
  for (const r of runners) byName.set(r.name.toLowerCase(), [...(byName.get(r.name.toLowerCase()) ?? []), r.pid]);
  return [...byName].filter(([, pids]) => pids.length > 1).map(([name, pids]) => ({ name, pids }));
}

// Why a runner called `name` may not start: another process with that name is
// live on this Mac. null when none is. The caller leaves out its own pid.
export function startRefusal(runners, name) {
  const pids = runners.filter((r) => r.name.toLowerCase() === name.toLowerCase()).map((r) => r.pid);
  if (!pids.length) return null;
  return `a runner named ${name} is already running on this Mac (pid ${pids.join(", ")}). Stop it, or start this one with --replace to stop it first.`;
}

// The start guard, with its effects handed in so a test signals no process:
// `kill(pid)` sends SIGTERM and may throw, `alive(pid)` says whether it still
// runs, `sleep(ms)` waits, `say(text)` prints. Returns null to go on, or the
// reason the runner must not start. Without `replace`, a live runner of the
// name is a refusal; with it, each is stopped and given `waitMs` to go, and
// any that stays, or cannot be signalled, is a refusal too (never a second
// runner beside it).
export async function guardName({ runners, name, replace, kill, alive, sleep, say, waitMs = 10_000 }) {
  const refusal = startRefusal(runners, name);
  if (!refusal) return null;
  if (!replace) return refusal;
  const pids = runners.filter((r) => r.name.toLowerCase() === name.toLowerCase()).map((r) => r.pid);
  for (const pid of pids) {
    try { kill(pid); } catch (error) { return `could not stop the runner with pid ${pid}: ${error.message}; this one was not started.`; }
  }
  for (let waited = 0; waited < waitMs && pids.some(alive); waited += 200) await sleep(200);
  const left = pids.filter(alive);
  if (left.length) return `the runner with pid ${left.join(", ")} did not stop within ${waitMs / 1000} seconds; this one was not started.`;
  say(`runner: stopped pid ${pids.join(", ")}.`);
  return null;
}

// The section: one line per runner, then one per task with its agents.
// A runner whose child is a runner is only the waiting parent of its
// replacement (reexecSelf without a supervisor, t760): it is left out, so
// each reload is one line and a waiting parent is never taken for a duplicate.
export function formatProcesses({ runners: all, agents }) {
  const parents = new Set(all.map((r) => r.ppid));
  const runners = all.filter((r) => !parents.has(r.pid));
  const lines = ["Live on this Mac:"];
  for (const r of runners) lines.push(`  runner ${r.name}  pid ${r.pid}  up ${r.age}${r.tasks.length ? `  working on ${r.tasks.join(", ")}` : "  idle"}`);
  if (!runners.length) lines.push("  no runner process");
  for (const d of duplicateRunners(runners)) lines.push(`  duplicate runner name ${d.name}: pids ${d.pids.join(", ")}; keep one and stop the rest`);
  const keys = [...new Set(agents.map((a) => `${a.project}/${a.id}`))];
  for (const key of keys) {
    const mine = agents.filter((a) => `${a.project}/${a.id}` === key);
    lines.push(`  ${key}  ${mine.map((a) => `${a.command} pid ${a.pid} up ${a.age}`).join("; ")}`);
  }
  if (!keys.length) lines.push("  no agent process in a task workspace");
  return lines.join("\n");
}
