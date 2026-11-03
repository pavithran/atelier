# Renewal and checkout lease timeouts (t466)

The cause of the November 2–3, 2026 production timeouts is still unknown.
This investigation uses revision `1901706a`. It does not read the Studio's
production database or atelierd logs: this task permits access only inside
its workspace. It cannot reproduce PGGB or compare the Studio with PGGB
running and paused. No server fix is justified by this evidence yet.

## Method

The local probe constructs the real `Ledger` with `SqlStorage` over a disposable
SQLite file in `.scratch/`. It seeds 500 tasks, 490 merged and ten held,
150,000 note events with 512-character payloads, two claimed review requests
and a checkout lease. This is a synthetic long history, not a production
copy. The history size follows the 150,000-event example already recorded
beside `showcaseCounts` in `src/ledger.ts`.

Each operation runs five times, first without added CPU workers, then with
busy worker threads. These are direct method timings; they exclude HTTP,
authentication, the namespace's transaction and structured-clone costs,
network delay and waiting behind another ledger call. Two seeded review
claims are renewed; two real reviews are not run.

## Measurements

On November 3 the local host reported 36 available cores and 256 GiB RAM,
running Node v26.9.0. Baseline load average was 5.40; the second pass added
31 busy worker threads, each bounded to 60 seconds. This approximates the
reported CPU occupancy, not PGGB's audio, memory or disk work. Values below
are the minimum and maximum of five calls, in milliseconds, including the
first call. A value rounded to zero means less than 0.05 ms.

| Method | No added load | 31 CPU workers |
| --- | ---: | ---: |
| `events()` (200 rows) | 0.6–0.7 | 0.9–1.1 |
| `events(undefined, Number.MAX_SAFE_INTEGER)` | 531.7–564.6 | 703.9–782.5 |
| `items()` | 1.4–2.0 | 1.9–3.0 |
| `detail(t1)` | 1.3–3.1 | 2.0–3.4 |
| `situationFacts` (ten tasks) | 2.6–4.1 | 3.1–4.1 |
| `stuckSnapshot()` | 513.2–539.6 | 715.4–761.9 |
| `stageTick()` | 11.5–15.2 | 14.0–19.2 |
| Two `renewReview` calls together | 0.0–0.2 | 0.1–0.2 |
| `renewCheckoutLease` | 0.1–0.2 | 0.6–0.7 |

An additional pass including `structuredClone(stuckSnapshot())`, to approximate
the namespace's result transfer, took 625.2–649.0 ms without added load and
824.7–883.9 ms with 31 CPU workers. It still excludes the namespace queue,
transaction and HTTP. RSS in that pass reached 2,709 MiB; the worker threads
share that process, so this is not the server's isolated memory cost.

No measured method exceeded one second. No 60-second stall was reproduced.
Probe RSS rose from 146 MiB to a sampled maximum of 1,743 MiB after repeated
full-history reads and the CPU workers. This resembles the reported resident
size, but does not establish a leak, GC stall or production memory pressure.

## What the code establishes

`src/runtime/namespace.mjs` queues each ledger call behind the preceding
call's promise, including its awaits. `SqlStorage` executes SQLite
synchronously on the server thread. A long synchronous read can therefore
delay every request; a long asynchronous call can delay other calls to the
same ledger without blocking the whole thread. Neither observation proves
what delayed production's `/api/version` request.

`stuckSnapshot` reads the entire project event history and its callers in
`src/index.ts` may read other active projects too. `events` converts every
returned row and reads the text cutover metadata for each row. These are
candidates for profiling on a production copy, not established causes of
the 60-second timeout. `stageTick` reads stage events and each live owned
task's history; `situationFacts` reads active task facts. The probe measures
these paths separately from review and checkout renewal.

## Studio evidence still needed

Before and after any proposed deployment, run the project's full suite and
two independent reviews on the Studio while sampling authenticated review
renewals, checkout lease take/renew and `/api/version` from another process.
Measure client wall time, server call time, event-loop delay, RSS, CPU and
ledger queue wait together. Repeat with PGGB paused and running at its
reported 31-of-36-core load. Retain the event count, task count and database
size with each sample; record every call over one second and any timeout.
Do this on a copy or with cheap timing logs under the service owner.

The acceptance requirement for subsecond renewals and leases during a full
suite and two Studio reviews remains unverified. Local synthetic CPU work
cannot establish PGGB's memory pressure, disk contention, scheduler effects,
or the production network and tunnel behavior. Do not treat a passing local
test as the before/after Studio smoke check.

The referenced house style was unavailable in this workspace and was not read.

## Validation

No server behavior, contract, route or UI changed; there is no fix with a
red/green test pair. All commands used the supplied host slot wrapper:
`node /Users/pavi/ai-projects/atelier-runner/cli/load.mjs -- COMMAND`.

- Probe: `node --import ./src/runtime/loader.mjs .scratch/t466-measure.mjs`;
  exited 0 in both passes. The probe source, disposable databases and raw
  output (`t466-measure.log`, `t466-measure-clone.log`) are in `.scratch/`.
  The second pass adds the result-clone measurement to the same probe.
- Full suite: `ATELIER_TEST_TIMEOUT_MS=3600000 npm test`; exited 1,
  6,121 passed, 164 failed, six skipped, none cancelled. Slot wait was less
  than one second; run time was 595 seconds (epoch 1793726887–1793727482).
  This ran against the unchanged server at `1901706a`. Failures include
  “land: the gate is ready, and the decision names the action and revision”,
  “a abandoned task refuses a pushed refresh” (`409|not_ready`, needs an
  independent protected-path approval), and “review.sh names the prose
  standard the policy records, says when the lookup failed, and lets
  PROSE_STANDARD override” (`the recorded standard is named`). These
  unrelated failures were left unchanged. The complete test names and
  assertion output are in `.scratch/t466-suite.log`.
- `npm run typecheck`: exited 0; slot wait 613 seconds, run time one second
  (requested at epoch 1793726911, acquired at 1793727524, ended at 1793727525).

The suite did not time out. This documentation records an unresolved
investigation, not completed Studio validation.
