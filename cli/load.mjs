import { cpus, loadavg } from "node:os";

// The load average and the limit a home runner or a landing's checks hold
// back under (t403). On 2026-10-09 t332's landing checks failed on three
// 5-second timeouts at a load average of 81 on 18 cores: home runners started
// jobs regardless of load, and a landing's clean-clone check competed with
// them. A runner now takes a job, and a landing's checks start, only while the
// load average is under a limit (the core count by default), so the two no
// longer starve each other.

// The machine's core count, used as the default load limit. A machine that
// reports none counts as one.
export function coreCount() {
  return cpus().length || 1;
}

// The one-minute load average, the number the limit is judged against.
export function loadAverage() {
  return loadavg()[0];
}

// A load reading forced for tests and scripts: `ATELIER_LOAD` holds a
// comma-separated sequence of readings; each read returns the next and the
// last repeats, so a test can hold the load high for a few reads and then let
// it fall. Without it the real one-minute average is read.
export function envLoad(env = process.env) {
  const values = String(env.ATELIER_LOAD ?? "").trim()
    .split(",").map((s) => s.trim()).filter((s) => s !== "").map((s) => Number(s)).filter(Number.isFinite);
  let i = 0;
  return () => (values.length ? values[Math.min(i++, values.length - 1)] : loadAverage());
}

// A load for one line of output: one decimal, so 81.37 reads "81.4".
export function formatLoad(n) {
  return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : "?";
}

// The limit a runner or check holds under, from a configured number or the
// core count. `configured` is undefined when nothing named a limit.
export function loadLimitOf(configured, cores = coreCount()) {
  return configured ?? cores;
}

// Waits until `readLoad()` reads under `limit`, calling `report` once when it
// first holds, and returns the reading it proceeds on. The wait polls every
// `pollMs` and never gives up: the machine's load is the thing it waits on,
// and there is no timeout that would help.
export async function waitForLoad(limit, { readLoad = envLoad(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), report = () => {}, pollMs = 5000 } = {}) {
  let reported = false;
  for (;;) {
    const current = readLoad();
    if (current < limit) return current;
    if (!reported) { report(current); reported = true; }
    await wait(pollMs);
  }
}
