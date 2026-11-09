# Where the time goes

`atelier flow [--project P] [--since T] [--json]` reports how long tasks spend
in each phase of their flow in a 13-line scorecard: merged tasks, median
minutes from filing to merge, median review rounds per task, rejection rate
and phase shares. It reads the events the ledger already records and
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
| criteria review | `criteria_review.requested` | `criteria_review.approved`, `criteria_review.rejected`, `criteria_review.withdrawn` or `criteria_review.failed` |
| runner wait | `item.dispatched` | `item.claimed`, `item.handoff`, `item.released`, `item.undispatched` or `item.abandoned` |
| build | `item.claimed` or `item.handoff` | the first `push.observed`; or `item.submitted`, `item.released`, `item.abandoned` or a new `item.dispatched` |
| checks | `push.observed` while building; or the first check on the merge (`evidence.*` with `merged`) while waiting to land | `item.submitted`; or, for the landing's checks, the last check on the merge |
| review wait | `item.submitted` | the first `review.approved` or `review.rejected` |
| accept | `review.approved` | `item.accepted` (a `review.rejected` sends the task back to build) |
| wait to land | `item.accepted` | the first check on the merge, or `item.merged` when none was recorded |
| merge | `landing.begun`, or the last check on the merge in older histories | `item.merged` |

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

## Scorecard and JSON

Filing-to-merge minutes use creation and merge timestamps for merged tasks
with complete records. Review rounds count submissions for every task with a
complete record, including zero for tasks not yet submitted. Both medians use
the mean of the two middle values for an even count. Empty populations show
`n/a` (JSON `null`). Rejection rate counts tasks with any rejection, rather
than rejected verdicts divided by all verdicts.

Phase shares divide each known phase total by the sum of known phase totals,
including open time up to observation. Unassigned gaps and unknown stretches
are excluded; these shares do not partition all elapsed filing-to-merge time.
Each phase shows its unknown and open task counts. A cancelled landing returns
to waiting to land. A landing that has only begun remains open and does not
count as merged.

JSON retains the existing task phases, totals and rates, adding
`medianMinutesToMerge`, `medianReviewRounds`, and `phaseShares` (fractions from
zero to one). Each task also has `minutesToMerge`, null until a merge is recorded.
Production callers are `cli/commands/flow.mjs`, which uses the same report for
text and JSON, and the Process tab (`GET /p/NAME/process`, `src/process.ts`),
which draws it as a flowchart: see [process.md](process.md).

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

## The redesign's bars

`atelier flow --bars [--project P] [--tokens FILE] [--json]` reports the last
seven days for each project (or the one named) and overall. Each bar prints its
value, its target, PASS or FAIL and the events it came from; a figure with no
merges to count prints "no merges in the last 7 days" and is not scored.

| Bar | Target | Source |
| --- | --- | --- |
| weighted tokens per sound merge | under 0.7M | soundness from `item.merged`, `item.fix_of` and post-merge `evidence.*`; tokens from `--tokens FILE`, a JSON object of item id (or `project/id`) to weighted tokens, because the ledger records none (unmeasured without it) |
| filed to deployed, median / p90 | 60 min / 3 h | `item.created` to the last `action.ran` with step `deploy` of a ship at or after `item.merged`, when that record passed and the ship got past deploy: a later step of the ship recorded an `action.ran`, or its `ship.recorded` is shipped or names a failed step after deploy. Ship records a step's results only once the step ends, so a ship that stopped part-way through recording is not counted; merged tasks not yet deployed are named, not counted |
| merges that turned main red | 0 | an `evidence.*` event on the merge (`merged`, `passed: false`) after `item.merged` and within 7 days of it |
| shadow-review escapes | at most 1 in 10 | merges in the window with an `item.fix_of` recorded after `item.merged` |
| live rows with no named wait | 0 | each unfinished item whose latest state event does not name a wait (dispatch, claim, handoff, submit, approval, accept, block, criteria review, landing) |
| repairs without a fix_of link | 0 | tasks created in the window titled Fix or Repair with no `item.fix_of`, `item.reverts` or `item.defect_of` (a title match, so a repair titled otherwise is missed) |
| session-written records per merge | under 3 | `session.wrapped`, `decision.recorded` and `assignment.recorded` in the window, over merges |

A sound merge has no `item.fix_of` linked to it and no red main it caused
within seven days. The figures come from this ledger's events; the Nov 1-6
measurements and the plan are not read by the command.

## How the criteria were written (t536)

`atelier flow --bars` also prints, per project and overall, what the findings
of the last seven days say about the criteria. These figures have no target; they measure
criteria writing the way the bars measure code. Each line names its source.

Every blocking finding carries the criterion it concerns (a number, or none) and
a cause from a fixed list:

| Cause | Meaning |
| --- | --- |
| `spec` | the criteria left it undecided or impossible as written |
| `wiring` | built but not connected to its callers, routes or pages |
| `failure-path` | a crash, retry or error path that is wrong |
| `coding` | a logic error in the code |
| `tests` | the tests miss or misjudge the behaviour |
| `docs` | docs or help that contradict the code |

The reviewer states both in the reply, on the finding line, at no extra call:
`FINDING: blocking src/example.ts:12 [criterion-2, wiring] What is wrong.` A
blocking finding missing either is recorded with cause `unknown` and counted,
not refused. `atelier finding ID --index N --cause CAUSE` corrects a cause
(`--head` is optional; `--review-seq` or `--reviewer` names the review as for a
verdict) and records who changed it and from what; the reviewer's record is not edited.

A required check that fails at landing, or on main after a merge, records the
names of its failing tests against the task as a `check.failed_tests` event,
with cause `unknown`. The CLI reads the names from the whole output of the
check, for a landing and for a post-merge check step alike, before any cut of
the text it sends. The event keeps at most 200 names, the total the output named
and, beyond 200, `and N more`. Output that no test
reporter format fits records no names and says so (`namesRead: false`). The
orchestrator sets the cause with `atelier finding ID --failure N --cause
CAUSE`, N the event's sequence; a `check.cause` event records the cause it was,
the cause it is and who set it.

| Figure | Source |
| --- | --- |
| findings by cause | `review.rejected` events' blocking findings, a `review.finding_cause` correction in place of the reviewer's cause |
| spec share | spec findings over the findings whose cause is known |
| criteria with two or more findings | blocking findings grouped by task and criterion number |
| repeats | a blocking finding with the file and text (as `findingKey` reads them) of an earlier blocking finding of the same task |
| failed required checks, by cause | `check.failed_tests` events, with `check.cause` events |
| tasks whose criteria passed their first criteria review | each task's first `criteria_review.approved` or `criteria_review.rejected` event, in the window |

Findings recorded before causes were asked for show cause `unknown`, are
counted, and are left out of every share; the report says how many. A criteria
review's findings are about the criteria themselves and carry neither tag.
