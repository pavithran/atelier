import { cpus, hostname } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Host-wide, deliberately independent of HOME, ATELIER_CACHE, project and
// runner configuration. Containers have their own /tmp and process namespace.
export const HOST_POOL = "/tmp/atelier-test-slots-v1.sqlite";
export const SLOT_WRAPPER = fileURLToPath(import.meta.url);
const MARKER = "ATELIER_TEST_LEASE";
const classes = { release: 0, landing: 0, review: 1, ordinary: 2 };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
// A long-lived caller may poll admissions or status repeatedly. Warn once
// per pool in this process, including when capacity changes during its wait.
const warnedPools = new Set();
export const coreCount = () => cpus().length || 1;

// One slot unless told otherwise (t161): on 2026-10-21 three clean-clone suites
// ran at once on one Mac under the old default of a quarter of the cores, and
// two landings failed both attempts on timing and Artifacts 503 noise. Only an
// explicit ATELIER_TEST_SLOTS at first creation, or `--set`, raises it.
export const DEFAULT_SLOTS = 1;

export function slotCapacity(env = process.env, cores = coreCount()) {
  if (env.ATELIER_TEST_SLOTS === undefined) return DEFAULT_SLOTS;
  const text = env.ATELIER_TEST_SLOTS;
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error("ATELIER_TEST_SLOTS must be a positive integer");
  }
  return Number(text);
}

// Workers one test pool may use (t744): the cores divided by the slots, so
// every slot busy at once keeps the machine's load near its core count. A
// slot covers one npm test, and that runs two pools (node --test and
// vitest), each of which took a core-sized count of its own by default: on
// 36 cores nine slots made load 68. An unset or invalid ATELIER_TEST_SLOTS
// gives a quarter of the cores, the share the default capacity had before t161:
// a pool created earlier keeps its stored capacity (often several slots), and
// a suite sized for one slot would then load the machine several times over.
// Failing safe here costs a lone suite some speed, never a loaded machine.
export function poolSize(env = process.env, cores = coreCount()) {
  let slots;
  try { slots = env.ATELIER_TEST_SLOTS === undefined ? Math.max(1, Math.floor(cores / 4)) : slotCapacity(env, cores); }
  catch { slots = Math.max(1, Math.floor(cores / 4)); }
  return Math.max(1, Math.floor(cores / slots));
}

export function slotPriority(value = "ordinary") {
  if (!Object.hasOwn(classes, value)) throw new Error("test priority must be release, landing, review or ordinary");
  return classes[value];
}

// Only retain process identity and our random marker, never command lines or
// other environment values. Unlike PID liveness (including kill(pid, 0)), an
// inherited launch nonce cannot mistake a recycled PID for the old tree.
// Unavailable process information must never be interpreted as an empty host.
// The command wrapper can instead run without touching the pool.
export function slotProcesses() {
  let output;
  try {
    output = execFileSync("ps", ["eww", "-ax", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="], {
      env: { ...process.env, [MARKER]: undefined }, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`cannot inspect test process trees: ${error.message}`);
  }
  const processes = parseSlotProcesses(output);
  if (!processes.some((p) => p.pid === process.pid)) throw new Error("cannot inspect test process trees: incomplete process snapshot");
  return processes;
}

export function parseSlotProcesses(output) {
  const rows = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/);
    if (!match || match[4].includes("Z")) continue;
    const lease = match[6].match(/(?:^|\s)ATELIER_TEST_LEASE=([a-f0-9-]{36})(?:\s|$)/)?.[1];
    rows.push({ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), birth: match[5], lease });
  }
  return rows;
}

// SQLite's OS locks and rollback journal serialize sequence allocation,
// admission and reclamation, including a writer killed inside a transaction.
// Tests inject a database and process snapshot; production has no path override.
export async function poolTransaction(options = {}, update = () => {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(options.path ?? HOST_POOL);
  try {
    db.exec("PRAGMA busy_timeout=30000; CREATE TABLE IF NOT EXISTS pool (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
    db.exec("BEGIN IMMEDIATE");
    try {
      const stored = db.prepare("SELECT data FROM pool WHERE id=1").get();
      const env = options.env ?? process.env;
      let requested;
      try { requested = slotCapacity(env); }
      catch { /* Invalid environment is advisory, including first creation. */ }
      const state = stored ? JSON.parse(stored.data) : { capacity: requested ?? slotCapacity({}), host: hostname(), sequence: 0, entries: [] };
      const poolPath = resolve(options.path ?? HOST_POOL);
      if (env.ATELIER_TEST_SLOTS !== undefined && requested !== state.capacity && !warnedPools.has(poolPath)) {
        warnedPools.add(poolPath);
        (options.warn ?? console.warn)(`test slots: warning: ATELIER_TEST_SLOTS ${requested === undefined ? "is invalid" : `requests ${requested}`}; using stored capacity ${state.capacity}`);
      }
      const processes = options.skipEmpty && !state.entries.length ? [] : (options.processes ?? slotProcesses)();
      state.entries = state.entries.filter((entry) => processes.some((p) => p.lease === entry.lease));
      const result = update(state, processes);
      db.prepare("INSERT INTO pool(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(state));
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.close(); }
}

// Use the admission lock; never rebuild the pool or renumber its queue.
export async function setSlotCapacity(value, options = {}) {
  const capacity = slotCapacity({ ATELIER_TEST_SLOTS: String(value) });
  return poolTransaction({ ...options, skipEmpty: true }, (state) => {
    state.capacity = capacity;
    return capacity;
  });
}

export const orderedWaiters = (state) => state.entries.filter((e) => !e.started).sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);

export async function slotStatus(options = {}) {
  return poolTransaction({ ...options, skipEmpty: true }, (state, processes) => ({
    capacity: state.capacity, host: state.host,
    usage: state.entries.filter((e) => e.started).length,
    draining: Math.max(0, state.entries.filter((e) => e.started).length - state.capacity),
    active: state.entries.filter((e) => e.started).map((e) => ({ ...e, processes: processes.filter((p) => p.lease === e.lease) })),
    waiters: orderedWaiters(state),
  }));
}

export function formatSlots(status) {
  const row = (e) => `  ${e.class} #${e.sequence} ${e.project ?? "?"}/${e.task ?? "?"} ${e.actor ?? "?"} pid=${e.pid} identity=${e.lease} ${e.started ? "started=" + e.started : "queued=" + e.queued}`;
  return [`Test slots: ${status.active.length}/${status.capacity} on ${status.host}${status.draining ? ` (draining excess: ${status.draining})` : ""}`, ...status.active.map(row), "Waiting (priority, FIFO):", ...status.waiters.map(row)].join("\n");
}

export async function acquireSlot(metadata = {}, options = {}) {
  const lease = metadata.lease ?? process.env[MARKER];
  if (!lease) throw new Error("test slots require the launch wrapper (missing process identity)");
  const priority = slotPriority(metadata.class ?? process.env.ATELIER_TEST_PRIORITY);
  const signal = options.signal;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("test slot wait cancelled");
      const result = await poolTransaction(options, (state, processes) => {
        if (!processes.some((p) => p.pid === (metadata.pid ?? process.pid) && p.lease === lease)) {
          throw new Error("test process identity is not visible; refusing slot admission");
        }
        let entry = state.entries.find((e) => e.lease === lease);
        if (entry?.started) {
          const reused = entry.claimed === true;
          entry.claimed = true;
          return { lease, reused };
        }
        if (!entry) {
          const identity = processes.find((p) => p.pid === (metadata.pid ?? process.pid));
          entry = { ...metadata, birth: identity.birth, lease, pid: metadata.pid ?? process.pid, class: metadata.class ?? process.env.ATELIER_TEST_PRIORITY ?? "ordinary", priority,
            sequence: ++state.sequence, queued: new Date().toISOString() };
          state.entries.push(entry);
        }
        const free = Math.max(0, state.capacity - state.entries.filter((e) => e.started).length);
        // Reserve every eligible waiter in enqueue order in this transaction;
        // polling speed cannot reverse FIFO when multiple slots become free.
        for (const next of orderedWaiters(state).slice(0, free)) next.started = new Date().toISOString();
        if (!entry.started) return null;
        entry.claimed = true;
        return { lease, reused: false };
      });
      if (result) return result;
      await (options.wait ?? delay)(100);
    }
  } catch (error) {
    await poolTransaction(options, (state) => { state.entries = state.entries.filter((e) => e.lease !== lease || e.claimed); });
    throw error;
  }
}

// Releasing a live tree is never permitted, even when the supervisor has
// exited or received SIGKILL. The next admission/status reclaims it instead.
export async function releaseSlot(lease, options = {}, self = process.pid) {
  return poolTransaction(options, (state, processes) => {
    if (processes.some((p) => p.lease === lease && p.pid !== self)) return false;
    state.entries = state.entries.filter((e) => e.lease !== lease);
    return true;
  });
}

export function slotInvocation(argv, metadata = {}, base = process.env) {
  const env = { ...base };
  // Scrubbed check environments explicitly retain only slot coordination.
  for (const key of [MARKER, "ATELIER_TEST_SLOTS", "ATELIER_TEST_PRIORITY"]) {
    if (process.env[key] !== undefined && env[key] === undefined) env[key] = process.env[key];
  }
  return { argv: [process.execPath, SLOT_WRAPPER, "--metadata", JSON.stringify(metadata), "--", ...argv], env };
}

export const SLOT_HELP = `Host-wide test slots (Node 24+, macOS/Linux):
  node cli/load.mjs [--priority release|landing|review|ordinary] [--project NAME] [--task ID] [--actor H/M] -- COMMAND [ARG ...]
  node cli/load.mjs --status [--json]
  node cli/load.mjs --set N

One slot covers one command and its descendants; nested wrappers reuse it.
Local Atelier checks use this same pool. Direct shell commands are outside
its enforcement. Containers have independent /tmp and process namespaces.
On first creation, valid ATELIER_TEST_SLOTS sets capacity, otherwise it defaults
to one, so a wave's checks run one at a time. Stored capacity then wins (a pool
made under an older default keeps it: run --set 1); invalid or differing
environment values warn. --set N atomically changes capacity (positive safe
integer). Lowering drains running work without preemption or a restart.
The database is /tmp/atelier-test-slots-v1.sqlite.
Release/landing precedes review, then ordinary, FIFO within each class by an
atomic enqueue sequence. Admission never preempts active commands. Lower
classes may starve. Select a class with --priority or ATELIER_TEST_PRIORITY.
Landings set release and review harnesses set review; other checks default to
ordinary. SIGINT/SIGTERM cancel waiting or terminate the running tree.
A killed wrapper's surviving children keep its slot until they exit. A status
read or admission reclaims abandoned entries. ps must expose participants'
process environments; when inspection is unavailable, commands run without
process-tree accounting and warn on stderr. This fallback never frees slots.
The inherited ATELIER_TEST_LEASE must be preserved by descendants, including
commands that detach. This is cooperative scheduling, not a security sandbox.
ATELIER_LOAD, ATELIER_LOAD_LIMIT and runner loadLimit are retired and ignored.
`;

async function main(argv) {
  if (argv[0] === "--set") {
    if (argv.length !== 2) throw new Error("usage: node cli/load.mjs --set N");
    const capacity = await setSlotCapacity(argv[1]);
    return console.log(`Test slot capacity: ${capacity}`);
  }
  const split = argv.indexOf("--");
  const flags = split < 0 ? argv : argv.slice(0, split);
  const command = split < 0 ? [] : argv.slice(split + 1);
  const metadata = { project: process.env.ATELIER_TEST_PROJECT, task: process.env.ATELIER_TEST_TASK, actor: process.env.ATELIER_TEST_ACTOR ?? process.env.ATELIER_ACTOR };
  let status = false, json = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--help") return console.log(SLOT_HELP);
    if (flag === "--status") { status = true; continue; }
    if (flag === "--json") { json = true; continue; }
    const key = { "--priority": "class", "--project": "project", "--task": "task", "--actor": "actor", "--metadata": "metadata" }[flag];
    if (!key || !flags[i + 1]) throw new Error(SLOT_HELP);
    const value = flags[++i];
    if (key === "metadata") Object.assign(metadata, JSON.parse(value)); else metadata[key] = value;
  }
  if (status) {
    const result = await slotStatus();
    return console.log(json ? JSON.stringify(result, null, 2) : formatSlots(result));
  }
  if (!command.length) throw new Error(SLOT_HELP);
  slotPriority(metadata.class ?? process.env.ATELIER_TEST_PRIORITY);
  // Start with the nonce in the exec environment (setting process.env later
  // is not reliably visible to ps). Never put it in argv or persisted scripts.
  if (!process.env[MARKER]) {
    const child = spawn(process.execPath, [SLOT_WRAPPER, ...argv], { env: { ...process.env, [MARKER]: randomUUID() }, stdio: "inherit" });
    const forward = (signal) => { child.kill(signal); };
    const onInt = () => forward("SIGINT"), onTerm = () => forward("SIGTERM");
    process.on("SIGINT", onInt).on("SIGTERM", onTerm);
    const result = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    });
    process.off("SIGINT", onInt).off("SIGTERM", onTerm);
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code;
    return;
  }
  await runSlotCommand(command, metadata);
}

export async function runSlotCommand(command, metadata = {}, options = {}) {
  const controller = new AbortController();
  let interrupted;
  const stop = (signal) => { interrupted = signal; controller.abort(); };
  const onInt = () => stop("SIGINT"), onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt).on("SIGTERM", onTerm);
  let acquired, exitSignal;
  try {
    // Probe before opening SQLite: read-only review sandboxes can forbid both.
    try { (options.processes ?? slotProcesses)(); }
    catch (error) {
      console.error(`test slots: ${error.message}; running without process-tree accounting`);
      acquired = { reused: true }; // Supervise only the direct child; do not touch the pool.
    }
    acquired ??= await acquireSlot(metadata, { ...options, signal: controller.signal });
    if (controller.signal.aborted) throw new Error("test slot wait cancelled");
    const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
    let ended = false, code = 1, spawnError;
    child.once("error", (error) => { spawnError = error; ended = true; });
    child.once("exit", (exit, signal) => { code = exit ?? (signal === "SIGINT" ? 130 : 143); exitSignal = signal; ended = true; });
    // A nested wrapper waits only for its direct command. The outer wrapper
    // alone owns the tree and the slot (and performs descendant cleanup).
    let stopping;
    for (;;) {
      if (acquired.reused) {
        if (interrupted) child.kill(interrupted);
        if (ended) break;
      } else if (ended || interrupted) {
        const descendants = (options.processes ?? slotProcesses)().filter((p) => p.lease === acquired.lease && p.pid !== process.pid);
        if ((ended || interrupted) && !stopping) stopping = Date.now();
        if (stopping) for (const p of descendants) {
          // Refresh the nonce check before signalling: a PID alone is not ownership.
          if ((options.processes ?? slotProcesses)().some((now) => now.pid === p.pid && now.lease === acquired.lease)) {
            try { process.kill(p.pid, Date.now() - stopping >= 5000 ? "SIGKILL" : interrupted ?? "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          }
        }
        if (ended && !descendants.length) break;
      }
      await delay(50);
    }
    if (spawnError) throw spawnError;
    process.exitCode = interrupted === "SIGINT" ? 130 : interrupted ? 143 : code;
  } catch (error) {
    if (!interrupted) throw error;
    process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  } finally {
    process.off("SIGINT", onInt).off("SIGTERM", onTerm);
    if (acquired && !acquired.reused) await releaseSlot(acquired.lease, options);
  }
  // Preserve the command's signal outcome after releasing its tree, so local
  // checks can still distinguish a signalled command from an ordinary exit.
  if (exitSignal && !interrupted) process.kill(process.pid, exitSignal);
}

if (process.argv[1] && resolve(process.argv[1]) === SLOT_WRAPPER) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`test slots: ${error.message}`); process.exitCode = 1; }
}
