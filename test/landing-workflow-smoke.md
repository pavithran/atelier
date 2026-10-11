# Landing Workflow remote smoke (t425)

Run this check before and after deploying a change to landing Workflows, in an
isolated smoke project with disposable tasks. Record the Worker revision,
instance ids, timestamps, HTTP responses and platform errors for both runs.

Local workerd tests cover recovery, creation races and concurrent durable
polls. They cannot reproduce hosted concurrency limits, multi-hour replay
pressure, platform internal errors or expiry under hosted retention. The
missing-instance recovery depends on the binding's `instance.not_found`
error from `get()`; verify that signal remotely rather than treating another
read error as evidence that the instance ended.

1. Hold the project's landing lease with a disposable blocker. Start fourteen
   disposable landing Workflows with a three-hour lease wait. Record all ids
   returned by successful creates; a failed create must not leave a new
   landing-workflow record.
2. Read every task's `landing-workflow` GET route throughout the wait, across
   multiple stretched polls and for a representative multi-hour backlog.
   Each instance must remain readable and queued. Any terminal status must
   include its error; a lost instance must make the CLI exit non-zero and
   report its last status/error and whether the task remains queued.
3. Release the blocker and let the disposable landings finish through their
   normal executor reports. Verify all fourteen finish in queue order, with
   no unaccounted instance or leftover queue entry.
4. In the smoke project, let a disposable instance fail and verify that its
   Ledger stage is `failed`, without reading its status through the API
   (leave `lastStatus` absent or nonterminal). Queue the task for a retry,
   then remove the ended instance using the platform's instance deletion
   operation, preserving its Ledger record. Confirm that `get()` reports
   `instance.not_found`, then POST the task's `landing-workflow` route again.
   Verify a fresh readable instance is recorded and its queue position is
   preserved. A missing instance whose record still has a nonterminal stage
   and no ended status must instead return 503 without changing the record,
   since it may be a successor claimed before create. Finish the disposable
   landing and clean up the smoke project.

A local passing suite is not a receipt for this remote check. Do not deploy
when the before-deploy run has an unexplained loss; preserve diagnostics and
stop the release if the after-deploy run does.


## Review runner restart (t351 / t485)

Before and after deploy, keep one standalone landing and one plan part waiting
on real review runners. SIGTERM a runner during its review and verify its child
exits before the claim is released. Repeat with SIGKILL and a network outage:
a queue poll at five minutes without renewal must offer the review again.
Restart under the same runner name and then take over on another eligible
runner serving the same actor. Verify the original landing instance approves
and advances, with no owner release or new landing. Replay the old request's
release, renewal and verdict: all must be refused without changing its successor.
Keep a review running for more than five minutes and verify thirty-second
renewals retain it. Record request numbers and server timestamps. Local tests
cover the clock and fencing; this smoke verifies hosted alarms, Workflow replay
and real process/network interruption across deployment.
