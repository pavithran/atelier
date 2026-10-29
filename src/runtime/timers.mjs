// The Worker's crons as in-process timers (Atelier 2.0, task 8; design
// section 4.2). wrangler.jsonc gave `scheduled()` three crons: the stage tick
// every five minutes, the stuck episodes every ten, the model snapshots at
// seven past every sixth hour (UTC). The Node server runs the same three jobs
// on timers it starts once it listens and stops when it closes
// (src/runtime/server.mjs).
//
// Each job runs at the same wall-clock moments its cron named: the next
// multiple of its period after now, plus its offset, counted from the epoch
// (UTC). A job is given the moment it was due, as `scheduledTime` was, so
// what it records does not depend on how late the timer fired. One run of a
// job at a time: a run still going when the next is due lets that one pass,
// and the job is due again at the moment after. A failed run is logged and
// the job goes on. `stop()` clears every timer and waits for the runs in
// flight, so nothing runs after the server's databases close.
//
// A timer that fires before its moment (a Node timer can, by a millisecond)
// waits out the rest, as the runtime's alarms do. Each moment runs once
// across restarts too: `store` keeps the last moment each job started
// (the index Ledger, on the server), and a moment at or before it is passed
// over, so a server started again a moment early, or twice, does not run a
// moment twice.
//
// The clock is injected, so the tests drive the jobs without waiting real
// minutes: `now()`, `setTimeout(fn, ms)` and `clearTimeout(handle)`.

export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t),
};

// The first moment strictly after `now` that is `offset` past a multiple of
// `every`, both in milliseconds.
export function nextRun(now, every, offset = 0) {
  return (Math.floor((now - offset) / every) + 1) * every + offset;
}

export class Timers {
  #clock;
  #jobs;
  #log;
  #stopped = false;
  #running = new Set();

  // jobs: [{ name, every, offset?, run(at: Date) }]. log: where a failed run
  // is told (console.error by default).
  #store;
  // store: { last(name) -> Promise<number|null>, ran(name, at) -> Promise }, or null.
  constructor({ jobs, clock = realClock, log = (line) => console.error(line), store = null }) {
    this.#clock = clock;
    this.#store = store;
    this.#log = log;
    this.#jobs = jobs.map((j) => ({ ...j, offset: j.offset ?? 0, timer: null, busy: false, runs: 0, passed: 0 }));
  }

  start() {
    for (const job of this.#jobs) this.#arm(job, this.#clock.now());
    return this;
  }

  // What each job has done, for the tests and for a status read.
  get state() {
    return this.#jobs.map(({ name, runs, passed, busy, due, skipped = 0 }) => ({ name, runs, passed, busy, due, skipped }));
  }

  #arm(job, from) {
    if (this.#stopped) return;
    const due = nextRun(from, job.every, job.offset);
    job.due = due;
    job.timer = this.#clock.setTimeout(() => this.#fire(job, due), Math.max(0, due - this.#clock.now()));
  }

  #fire(job, due) {
    job.timer = null;
    if (this.#stopped) return;
    // Early: wait out the rest of the moment before anything runs.
    const left = due - this.#clock.now();
    if (left > 0) { job.timer = this.#clock.setTimeout(() => this.#fire(job, due), left); return; }
    this.#arm(job, Math.max(this.#clock.now(), due));
    if (job.busy) { job.passed++; return; }
    job.busy = true;
    const run = (async () => {
      try {
        const last = this.#store ? await this.#store.last(job.name) : null;
        if (last !== null && last >= due) { job.skipped = (job.skipped ?? 0) + 1; return; }
        if (this.#store) await this.#store.ran(job.name, due);
        try { await job.run(new Date(due)); }
        catch (err) { this.#log(`${job.name} at ${new Date(due).toISOString()} failed: ${err?.message ?? err}`); }
        job.runs++;
      } catch (err) { this.#log(`${job.name} at ${new Date(due).toISOString()} was not started: ${err?.message ?? err}`); }
      finally { job.busy = false; }
    })();
    this.#running.add(run);
    run.finally(() => this.#running.delete(run));
  }

  async stop() {
    this.#stopped = true;
    for (const job of this.#jobs) if (job.timer !== null) { this.#clock.clearTimeout(job.timer); job.timer = null; }
    await Promise.all([...this.#running]);
  }
}
