# Background main suite on the Studio

`zone.atelier.main-suite` observes the canonical Atelier bare repository once
per minute. launchd runs only one instance of a job at a time. Each invocation
reads the newest `refs/heads/main`; a completed head is skipped. Moves during
a run are coalesced into the next observation. There are no gates.
A completed failed head is not rerun until main changes; an incomplete head
can run again.

Like `ship-suite-studio.mjs`, the job checks out the exact commit in a clean
clone, runs `npm ci` and `npm test`, and removes the clone. It uses six test
workers by default (override with `ATELIER_MAIN_SUITE_WORKERS`), nice 10,
no background process class and no low-priority I/O. The background process
class caused timing failures in the tests. It does
not reserve the landing/build test pool: landing, claim and ship never read
or wait for its result. Their required checks remain unchanged.

Only after a suite ends does the job atomically replace
`/Users/Shared/atelier-main-suite/result.json`. It records the tested commit,
last green commit, completion time and failing names from the suite footer.
An interrupted run leaves the previous result intact; the next invocation
removes its abandoned clone. `main-suite.log` keeps the last completed run output. Current output is written
to `main-suite.log.next` and replaces the completed log only when the run finishes.
A timeout or run without failing test names is `incomplete`, preserves the last
green commit and completed log, and may be retried on the next observation.

On the Studio, `atelier status` (ordinary, project, brief and new forms) and
`atelier stuck` print a red result before their usual output. Green clears
the warning. Incomplete runs print only “Main suite: last run did not finish”.
When a result exists, their JSON adds `mainSuite`; the all-project status remains an
array and adds it to each project row. Missing results produce no warning.
These are local diagnostics, not server API data: CLIs on other hosts do not
read the Studio result. There are no generated pages or browser changes.
Existing status/stuck JSON readers may ignore the additive field.
Suite children ignore the host diagnostic file, so a recorded red result
cannot change their CLI fixtures. The runner still reads its explicit result
path to preserve the last green commit.

## Install

The suite can run on the Studio as pavi's LaunchAgent with no password, using
`~/.config/atelier/main-suite/run.zsh`. That wrapper mirrors main and runs
the shipped `scripts/main-suite.mjs` from the runner copy at nice 10,
with no background process class and no low-priority I/O.
Reviews already run tests as pavi, and main's code has been reviewed.
No new service user or ACLs are needed. Keep the existing LaunchAgent and
wrapper; do not install the historical LaunchDaemon template.

The wrapper supplies Node, npm, git, a writable work directory and TMPDIR,
and publishes readable results at `/Users/Shared/atelier-main-suite/result.json`.
Use only one job; do not launch concurrent manual invocations.

## Remote smoke check

Before and after deployment, check on the Studio that the pavi LaunchAgent
starts the wrapper after a main move, never overlaps invocations, and skips
intermediate heads. Verify six workers by default, the worker override,
nice 10, no background process class and no low-priority I/O. Check that normal builds
and release checks continue independently. Verify a red fixture names failures
in status/stuck, an incomplete fixture prints only the plain unfinished line,
and green clears it. Check that a new run preserves the completed log.
Local tests cannot reproduce installed launchd scheduling, wrapper mirroring,
or macOS resource contention.
