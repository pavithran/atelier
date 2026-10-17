# Where the time goes

`atelier flow [--project P] [--since T] [--json]` reports how long tasks spend
in each phase of their flow, summed and per task, and how often a task needs
more than one attempt. It reads the events the ledger already records and
records nothing of its own (`src/flow.ts` computes it; `cli/commands/flow.mjs`
fetches each task's events from the item route and prints it).

`--since T` takes the tasks created at or after T: an ISO date or time, or a
span back from now such as `3d` or `12h`. Without it the report covers the
last seven days.

## Phases

A task is in at most one phase at a time. A phase begins at one recorded event
and ends at the next recorded event that leaves it. A task that goes round the
loop again (a release, a rejection, a handback) enters the phase again, and the
minutes of every stretch are added.

| Phase | Begins at | Ends at |
| --- | --- | --- |
| runner wait | `item.dispatched` | `item.claimed`, `item.handoff`, `item.released`, `item.undispatched` or `item.abandoned` |
| build | `item.claimed` or `item.handoff` | the first `push.observed`; or `item.submitted`, `item.released`, `item.abandoned` or a new `item.dispatched` |
| checks | `push.observed` while building; or the first check on the merge (`evidence.*` with `merged`) while waiting to land | `item.submitted`; or, for the landing's checks, the last check on the merge |
| review wait | `item.submitted` | the first `review.approved` or `review.rejected` |
| accept | `review.approved` | `item.accepted` (a `review.rejected` sends the task back to build) |
| wait to land | `item.accepted` | the first check on the merge, or `item.merged` when none was recorded |
| merge | the last check on the merge | `item.merged` |

Build time before the first push and the time from a push to the next submit
are split by the push: the checks an agent runs between its push and its submit
are the checks phase. A task handed back after it was accepted goes back to
build.

## What is unknown, and what is open

Nothing is guessed. For one task and one phase:

- A phase that has begun and not ended is open. Its minutes run to the moment
  the report was made, and the report marks it open.
- A phase whose start or end the record does not show is unknown for that
  task: `item.submitted` with no build before it, a verdict with no submit
  before it, `item.merged` out of a phase that no event left, or a task whose
  earliest recorded event is not its creation. Unknown phases are counted per
  phase, not added to the minutes.
- The ledger records no event when a merge begins. When a task merges out of
  the wait to land with no check recorded on the merge, the wait to land runs to
  `item.merged` and the merge phase is unknown for that task.
- A review verdict recorded after the merge (`postMerge`) is outside the phases.
- A verdict on accepted work takes the acceptance back, as the ledger does; a rejection ends the wait to land and the task waits for review again.
- The minutes of a phase that is unknown for a task are left out of the totals.
- A phase a task never entered adds nothing. A task landed outside the flow
  (`atelier record-merge`, or a fast landing) has no phase events, so its row
  is empty rather than unknown.

## Attempts and rates

- Attempts per merge: the `item.submitted` events of the merged tasks, divided
  by the number of merged tasks.
- Conflict rate: the share of tasks with at least one `refresh.returned`, one
  `integration.failed`, or an `item.handoff` while accepted work waited to land
  or was checking the merge.
- Rejection rate: the share of tasks with at least one `review.rejected`.
- Check failure rate: the share of tasks with at least one `evidence.*` event
  whose check did not pass, or one `refresh.checks_failed`.

The rates count the tasks whose record reaches back to their creation. The
report says how many that is.
