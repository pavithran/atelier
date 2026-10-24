import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { killTree } from "./group.mjs";

// atelier land t1 t2 t3 (t54): a bounded pool of the ordinary land command,
// one child process per task, started in input order. It adds no policy of
// its own. Each child checks, reviews, takes the project's landing lease for
// its merge alone and recovers its own post-merge work exactly as `atelier
// land ID` does; this file starts them, shows what they end with, and stops
// starting new ones when the server says post-merge work is open. Where it
// cannot tell, it does the safe thing again: it starts nothing more, and
// running the same command later reads the ledger and carries on.

export const DEFAULT_PARALLEL = 3;
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
// How long a child has to release its lease after the signal reaches it
// before its whole process tree is killed.
const STOP_GRACE_MS = 30_000;
// The last of a child's error output kept for its result line.
const ERROR_TAIL = 4000;

// The tasks named, once each, in the order first named (t54: a task named
// twice lands once).
export function uniqueIds(ids) { return [...new Set(ids)]; }

// --parallel N: a positive integer. Anything else is refused by the caller
// with the returned message; undefined means the default.
export function parseParallel(value) {
  if (value === undefined) return { parallel: DEFAULT_PARALLEL };
  if (typeof value !== "string" || !/^[1-9]\d{0,3}$/.test(value)) return { error: `--parallel needs a positive integer: atelier land t1 t2 --parallel ${DEFAULT_PARALLEL}` };
  return { parallel: Number(value) };
}

// Flags a single landing's command line takes back from the parsed ones: all
// except --parallel, written as --key=value so that no word after a flag is
// taken for a task.
export function childFlags(multi) {
  const out = [];
  for (const [key, values] of Object.entries(multi)) {
    if (key === "parallel") continue;
    for (const value of values) out.push(typeof value === "boolean" ? (value ? `--${key}` : `--${key}=false`) : `--${key}=${value}`);
  }
  return out;
}

// The default way to run one landing: `atelier land ID …` as a process group
// of its own, so a signal to this queue reaches it and everything it started.
export function spawnLanding(argv, { env = process.env } = {}) {
  const child = spawn(argv[0], argv.slice(1), { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const done = new Promise((resolve) => {
    let ended = false;
    const end = (status, signal, error) => { if (!ended) { ended = true; resolve({ status, signal, error }); } };
    child.on("error", (error) => end(null, null, error));
    child.on("close", (status, signal) => end(status, signal));
  });
  return { pid: child.pid, stdout: child.stdout, stderr: child.stderr, done, kill: (signal) => { try { process.kill(-child.pid, signal); } catch { /* it has ended */ } }, killTree: () => killTree(child.pid) };
}

// Runs the pool. io:
//   ids        the tasks, already unique, in input order
//   parallel   the cap
//   argvFor    (id) => the command line of its landing
//   launch     (argv) => a running landing (spawnLanding's shape)
//   stateOf    async (id) => { merged, postMerge } from the ledger; may throw
//   barrier    async () => the open post-merge run, or null; may throw
//   print      one line out
//   signals    the object that delivers SIGINT, SIGTERM and SIGHUP (process)
// Resolves { results, stoppedBy, held } where results are { id, outcome }:
// landed, already-merged, failed or not-started.
export async function runLandQueue(io) {
  const { ids, parallel, argvFor, launch, stateOf, barrier, print, signals = process, graceMs = STOP_GRACE_MS } = io;
  const results = new Map(ids.map((id) => [id, { id, outcome: "not-started" }]));
  const running = new Map();
  let next = 0, held = null, stoppedBy = null, hold = null;

  // A first signal passes to every landing, which releases its own lease (the
  // release names its task, so another holder's lease is left alone), and the
  // queue starts nothing more. A second one ends their trees at once.
  const onSignal = (signal) => {
    if (stoppedBy) { for (const l of running.values()) l.killTree(); return; }
    stoppedBy = signal;
    wake?.(); wake = null;
    print(`${signal} received: stopping ${running.size} landing${running.size === 1 ? "" : "s"} and starting no more. Run the same command again to carry on.`);
    for (const l of running.values()) l.kill(signal);
    const timer = setTimeout(() => { for (const l of running.values()) l.killTree(); }, graceMs);
    timer.unref?.();
  };
  for (const s of STOP_SIGNALS) signals.on(s, onSignal);

  const lines = (stream, id) => {
    let tail = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      tail += chunk;
      const parts = tail.split("\n");
      tail = parts.pop();
      for (const line of parts) print(`[${id}] ${line}`);
    });
    stream.on("end", () => { if (tail) print(`[${id}] ${tail}`); });
  };

  // Admission is one task at a time, in input order: a landing starts only
  // when the one before it has been admitted, so a slow ledger read for one
  // task cannot let a later one overtake it. Landings, once started, run
  // together. Nothing is admitted while a failed landing's post-merge check
  // is pending, after a signal, or under a hold; those are rechecked after the
  // ledger read, immediately before the process starts.
  let turn = Promise.resolve(), checking = 0, wake = null;
  const settled = () => new Promise((ok) => { const was = wake; wake = () => { was?.(); ok(); }; });
  const blocked = () => stoppedBy || hold || checking > 0;

  // Resolves { run }, the promise for the landing it started (or for a task
  // found merged), or null when nothing more is to be started.
  const admit = () => {
    const mine = turn.then(async () => {
      for (;;) {
        while (checking > 0 && !stoppedBy) await settled();
        if (stoppedBy || hold || next >= ids.length) return null;
        const id = ids[next];
        // A task merged already, with no post-merge work open, is complete: a
        // rerun after a stop must not fail on what it landed before. One whose
        // post-merge run is open goes to the landing, which resumes it (t477).
        // A ledger that cannot be read sends the task to the landing, which
        // reads it itself.
        let merged = false;
        try {
          const state = await stateOf(id);
          merged = Boolean(state?.merged && !state.postMerge);
        } catch { /* the landing judges */ }
        if (blocked()) { if (stoppedBy || hold) return null; continue; }
        next++;
        if (merged) {
          results.get(id).outcome = "already-merged";
          print(`${id} is already merged; nothing to land.`);
          return { run: Promise.resolve() };
        }
        return { run: start(id) };
      }
    });
    turn = mine.then(() => {}, () => {});
    return mine;
  };

  // Starts the landing and returns a promise for its end; synchronous, so
  // admission has no gap between its last check and the process.
  const start = (id) => {
    const l = launch(argvFor(id));
    running.set(id, l);
    lines(l.stdout, id);
    let tail = "";
    l.stderr.setEncoding?.("utf8");
    l.stderr.on("data", (chunk) => { tail = (tail + chunk).slice(-ERROR_TAIL); });
    return l.done.then(async (end) => {
      running.delete(id);
      const result = results.get(id);
      if (end.status === 0) {
        result.outcome = "landed";
        print(`${id} landed.`);
        return;
      }
      result.outcome = "failed";
      // Admission pauses from here, before anything else is awaited.
      checking++;
      try {
        const why = end.error ? end.error.message : end.signal ? `ended by ${end.signal}` : `exit ${end.status}`;
        print(`${id} failed (${why})${tail.trim() ? `:\n${tail.trim()}` : "."}`);
        // A landing that failed may have left post-merge work open (a landing
        // that succeeded finished its own). That stops what has not started;
        // what already runs is held by the server's barrier on its merge. A
        // barrier that cannot be read is treated as open.
        if (!stoppedBy && !hold) {
          try {
            const open = await barrier();
            if (open) hold = `post-merge run ${open.id ?? ""} is ${open.state ?? "open"}`.replace("  ", " ");
          } catch (error) { hold = `the post-merge state could not be read (${error.message})`; }
          if (hold) print(`Starting no more landings: ${hold}. Resolve it with atelier land ${id} --post-merge status, then run the same command again.`);
        }
      } finally { checking--; wake?.(); wake = null; }
    });
  };

  const pool = async () => {
    for (let a = await admit(); a !== null; a = await admit()) await a.run;
  };
  try {
    await Promise.all(Array.from({ length: Math.min(parallel, ids.length) }, pool));
  } finally {
    for (const s of STOP_SIGNALS) signals.off(s, onSignal);
  }
  held = hold;
  return { results: [...results.values()], stoppedBy, held };
}

// The summary line and the exit status: non-zero if any landing failed, a
// signal stopped the queue or a hold left tasks unstarted.
export function summarise({ results, stoppedBy, held }) {
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  const parts = [["landed", "landed"], ["already-merged", "already merged"], ["failed", "failed"], ["not-started", "not started"]]
    .map(([key, label]) => [count(key), label]).filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  const bad = count("failed") > 0 || count("not-started") > 0;
  const status = stoppedBy ? 128 + osConstants.signals[stoppedBy] : bad || held ? 1 : 0;
  return { line: `${results.length} task${results.length === 1 ? "" : "s"}: ${parts.join(", ")}.`, status };
}

// ── the land job (t226) ────────────────────────────────────────────────────

// How many lines of a landing's output a failure report keeps.
const LOG_TAIL_LINES = 12;

// The step a failed landing stopped at, from the message its step runner
// ends with ("atelier merge failed (exit 1)"); "land" where it names none.
export function failedStep(output) {
  const found = [...String(output ?? "").matchAll(/atelier ([a-z][a-z-]*) failed/g)].at(-1);
  return found ? found[1] : "land";
}

// The report of a landing that failed: the step and the tail of its log.
export function failureReport(id, output) {
  const tail = String(output ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-LOG_TAIL_LINES).join("\n");
  return `landing ${id} failed at ${failedStep(output)}${tail ? `:\n${tail}` : "."}`;
}

// One land job, run by a runner that holds the project's registered
// checkout: the same flow as `atelier land ID`, run in that checkout as a
// process of its own, so the landing lease and the landing journal
// (docs/landing.md) are the ones the command keeps. A run that was killed
// leaves its journal, and the next run of the job resumes from it.
//
// Before a new landing starts, the checkout must be clean and on the commit
// the baseline names; either refuses the job with the reason, and nothing
// runs. With a journal present the checkout holds the landing's own merge,
// so it is the command that judges it. io:
//   checkout     the registered checkout's folder
//   git          async (args) => { code, output }, run in the checkout
//   baselineHead async () => the baseline's head commit, or null
//   hasJournal   () => whether a landing journal exists for the checkout
//   land         async () => { code, output, timedOut } of `atelier land ID`
// Resolves { ok: true } or { ok: false, refused, reason } where refused is
// true when the job was not started.
export async function runLandJob(id, io) {
  const { checkout, git, baselineHead, hasJournal, land } = io;
  if (!hasJournal()) {
    const status = await git(["status", "--porcelain"]);
    if (status.code !== 0) return { ok: false, refused: true, reason: `the checkout ${checkout} cannot be read: git status exited ${status.code}` };
    const dirty = status.output.split("\n").filter(Boolean);
    if (dirty.length) return { ok: false, refused: true, reason: `the checkout ${checkout} has uncommitted changes (${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}${dirty.length > 5 ? `, and ${dirty.length - 5} more` : ""}); commit or set them aside, and the landing of ${id} runs on the next poll` };
    const head = await git(["rev-parse", "HEAD"]);
    const base = await baselineHead();
    if (head.code !== 0 || !base) return { ok: false, refused: true, reason: `main in the checkout ${checkout} cannot be compared with the baseline (${head.code !== 0 ? "its HEAD cannot be read" : "the baseline's head cannot be read"})` };
    const here = head.output.trim();
    if (here !== base && !await io.samePaired?.(here, base)) return { ok: false, refused: true, reason: `main in the checkout ${checkout} is at ${here.slice(0, 8)}, not at the baseline's ${base.slice(0, 8)}; run atelier sync there, and the landing of ${id} runs on the next poll` };
  }
  const result = await land();
  if (result.code === 0 && !result.timedOut) return { ok: true };
  const output = result.timedOut ? `${result.output}\natelier land failed (timed out)` : result.output;
  return { ok: false, refused: false, reason: failureReport(id, output) };
}
