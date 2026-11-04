# Background main suite on the Studio

`zone.atelier.main-suite` observes the canonical Atelier bare repository once
per minute. launchd runs only one instance of a job at a time. Each invocation
reads the newest `refs/heads/main`; a completed head is skipped. Moves during
a run are coalesced into the next observation. There are no retries or gates.
A failed head is not rerun until main changes.

Like `ship-suite-studio.mjs`, the job checks out the exact commit in a clean
clone, runs `npm ci` and `npm test`, and removes the clone. It uses one test
worker, nice 20, background process scheduling and low priority I/O. It does
not reserve the landing/build test pool: landing, claim and ship never read
or wait for its result. Their required checks remain unchanged.

Only after a suite ends does the job atomically replace
`/Users/Shared/atelier-main-suite/result.json`. It records the tested commit,
last green commit, completion time and failing names from the suite footer.
An interrupted run leaves the previous result intact; the next invocation
removes its abandoned clone. `main-suite.log` contains the latest run output.
An install or suite failure without a footer directs the reader to that log.

On the Studio, `atelier status` (ordinary, project, brief and new forms) and
`atelier stuck` print a red result before their usual output. Green clears
the warning. When a result exists, their JSON adds `mainSuite`; the all-project status remains an
array and adds it to each project row. Missing results produce no warning.
These are local diagnostics, not server API data: CLIs on other hosts do not
read the Studio result. There are no generated pages or browser changes.
Existing status/stuck JSON readers may ignore the additive field.
Suite children ignore the host diagnostic file, so a recorded red result
cannot change their CLI fixtures. The runner still reads its explicit result
path to preserve the last green commit.

## Install (administrator action; not performed by a task workspace)

Create a dedicated non-admin service user `atelier-suite`, with its own
home, work and TMPDIR. Do not run this job as `atelier-build`, `pavi`, or
`atelierd`. Give it no owner, builder, agent, runner, Git-push, SSH, or API
token, no runner configuration, and no access to server secrets or ledgers.
Recording the local result needs only filesystem write access, not a token.

Install this revision of the script and its `cli/main-suite.mjs` helper in
a root-owned, service-readable code directory. Provide Node 24+, npm and git
on the service PATH. Grant the service identity read-only access to only
`/Users/atelierd/repos/production/atelier.git`, including new Git objects and
refs, and traversal of its ancestors, without exposing other repositories.
Use scoped ACLs; retain the server directories permissions. Configure that
one repository as a Git safe.directory for this identity. The job needs no
write access to the repository or installed code.

Create `/Users/Shared/atelier-main-suite` owned by `atelier-suite`, mode 755;
only that user may write its contents. Result files are mode 644 so Studio
CLI users can read them. Work, home, logs and TMPDIR must be writable by the
service. The TMPDIR must be outside the checkout and private to the service.
Do not inherit builder environment or credentials.

Fill `scripts/studio/zone.atelier.main-suite.plist.template`: `@NODE@` is the
absolute Node executable, `@CODE@` the installed code directory, `@REPO@` the
canonical bare repository, `@BIN@` the Node/npm/git directory, and `@HOME@`,
`@WORK@`, `@TMP@` the service directories. Install it root-owned, mode 644,
as `/Library/LaunchDaemons/zone.atelier.main-suite.plist`, and bootstrap it
in the system launchd domain. Use only this one job; do not launch concurrent
manual invocations. No service installation is possible from this workspace.

## Remote smoke check

Before and after deployment, check on the Studio that launchd starts the job
within a few minutes of a main move, never overlaps invocations, skips
intermediate heads, and runs as `atelier-suite` at nice 20 with one worker.
Verify its identity cannot write the canonical repo or read secrets, that it
has no tokens, and that normal builds and release checks continue independently.
Verify a red fixture result appears in Studio status/stuck text and JSON,
then that a completed green clears it. Local tests cover clean clones, result
publication, coalescing and absence of gates; they cannot reproduce installed
launchd scheduling, production ACL inheritance, or macOS resource contention.
