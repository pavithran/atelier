// The runners and agent processes live on this machine, by task, with no
// command lines. A command line can hold a prompt or a token, and a
// `pgrep -f` on one matches the command that asked. So the process table is
// read as columns, a runner is told by its argv shape and printed by its
// --name, and an agent by where it works: a process whose working
// directory is a task's workspace (work/PROJECT/ID under the CLI's cache) is
// that task's agent. The caller reads `ps` and `lsof`; this only parses and
// words. Pure.

// `ps -axo pid=,ppid=,etime=,args=` -> [{ pid, ppid, etime, argv }].
export function parsePs(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], argv: m[4].trim().split(/\s+/) });
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

// Whether argv is the runner: atelier.mjs (or `atelier`) then the word runner.
const isRunner = (argv) => {
  const i = argv.findIndex((a) => /(^|\/)atelier(\.mjs)?$/.test(a));
  return i !== -1 && argv[i + 1] === "runner";
};
const runnerName = (argv) => {
  const i = argv.findIndex((a) => a === "--name" || a.startsWith("--name="));
  if (i === -1) return "runner";
  return argv[i] === "--name" ? argv[i + 1] ?? "runner" : argv[i].slice(7);
};

// The task a working directory belongs to, under `work`, or null.
export function taskOf(cwd, work) {
  const root = work.replace(/\/+$/, "") + "/";
  if (!cwd.startsWith(root)) return null;
  const [project, id] = cwd.slice(root.length).split("/");
  return project && /^t\d+$/.test(id ?? "") ? { project, id } : null;
}

// { runners: [{ pid, name, age, tasks }], agents: [{ pid, command, age, project, id }] }.
// `skip` holds pids to leave out (this command and its children).
export function liveProcesses({ ps, lsof, work, skip = [], project = null }) {
  const skipped = new Set(skip);
  const byPid = new Map(ps.map((p) => [p.pid, p]));
  const agents = [];
  for (const [pid, { comm, cwd }] of lsof) {
    const row = byPid.get(pid), task = taskOf(cwd, work);
    if (!row || !task || skipped.has(pid) || isRunner(row.argv) || (project && task.project !== project)) continue;
    agents.push({ pid, command: comm.split("/").pop(), age: age(row.etime), project: task.project, id: task.id });
  }
  const runners = ps.filter((p) => !skipped.has(p.pid) && isRunner(p.argv)).map((p) => {
    const tasks = new Set();
    for (const a of agents) {
      for (let at = byPid.get(a.pid); at; at = byPid.get(at.ppid)) if (at.ppid === p.pid) { tasks.add(a.id); break; }
    }
    return { pid: p.pid, name: runnerName(p.argv), age: age(p.etime), tasks: [...tasks].sort() };
  });
  const byTask = (a, b) => a.id.localeCompare(b.id, "en", { numeric: true }) || a.pid - b.pid;
  return { runners: runners.sort((a, b) => a.pid - b.pid), agents: agents.sort(byTask) };
}

// The section: one line per runner, then one per task with its agents.
export function formatProcesses({ runners, agents }) {
  const lines = ["Live on this Mac:"];
  for (const r of runners) lines.push(`  runner ${r.name}  pid ${r.pid}  up ${r.age}${r.tasks.length ? `  working on ${r.tasks.join(", ")}` : "  idle"}`);
  if (!runners.length) lines.push("  no runner process");
  const keys = [...new Set(agents.map((a) => `${a.project}/${a.id}`))];
  for (const key of keys) {
    const mine = agents.filter((a) => `${a.project}/${a.id}` === key);
    lines.push(`  ${key}  ${mine.map((a) => `${a.command} pid ${a.pid} up ${a.age}`).join("; ")}`);
  }
  if (!keys.length) lines.push("  no agent process in a task workspace");
  return lines.join("\n");
}
