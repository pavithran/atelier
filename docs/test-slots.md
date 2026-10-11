# Host test slots

Local `atelier check` commands and `atelier wrap` checks use one atomic pool
per machine, shared across projects and runners. Agent commands join the same
pool through the wrapper installed with Atelier:

```sh
node /path/to/atelier/cli/load.mjs --project example --task t17 --actor codex/model -- npm test
node /path/to/atelier/cli/load.mjs --priority review -- npm run typecheck
node /path/to/atelier/cli/load.mjs --priority release -- sh -c 'npm test && npm run typecheck'
node /path/to/atelier/cli/load.mjs --status
node /path/to/atelier/cli/load.mjs --status --json
```

The words after `--` are an executable and its arguments, with no implicit
shell. Use `sh -c` explicitly for shell syntax. Each invocation holds one slot
for its command and descendants. Prefer separate invocations for separate
check commands so higher priority waiters can enter between them. Nested
wrappers reuse their outer slot. Commands run directly in a shell are outside
enforcement. This is cooperative scheduling, not isolation of untrusted code.

On first pool creation a valid `ATELIER_TEST_SLOTS` sets capacity; otherwise
capacity is `max(1, floor(coreCount()/4))`. Capacity is recorded atomically in
`/tmp/atelier-test-slots-v1.sqlite`; it does not depend on the project,
`ATELIER_CACHE`, `ATELIER_CONFIG_DIR`, HOME, or the runner name. After creation,
stored capacity wins. An invalid or disagreeing environment value warns once
per caller but cannot prevent admission; an absent value silently uses stored
capacity.

Change capacity with `atelier slots set N` (or `node cli/load.mjs --set N`).
Only positive safe integers are accepted. The change shares admission's SQLite transaction lock and
preserves live leases and the priority/FIFO queue. Raising capacity lets
waiting work enter on its next poll. Lowering capacity leaves running and
nested work alone and admits nothing while active usage is at or above the
new limit. No database reset or runner restart is needed for callers using
the updated implementation. Every runner must run the new code before capacity
is changed: older callers can still reject a capacity disagreement. Never
remove a live pool.
The pool is intended for the machine's shared Atelier service account;
different runner identities and project directories do not partition it.

Admission is non-preemptive, in this order:

1. `release` and `landing` (equivalent).
2. `review`.
3. `ordinary` (the default).

Within each class, an enqueue sequence assigned inside the same SQLite
transaction establishes FIFO order. Freed slots are reserved in that order,
independent of waiter polling speed. Running commands are never displaced.
Lower classes may starve. Select a class using `--priority` on the wrapper or
`ATELIER_TEST_PRIORITY` for the wrapper and local Atelier checks. Local
landings and wrap checks select release automatically. Runner review
harnesses select review; build and plan harnesses select ordinary. Runner
briefs give the installed wrapper path, so the project's checkout need not
contain Atelier's source. Supply project, task and actor through the wrapper
flags when running manually; runners supply them through their environment.

`atelier slots status [--json]` (or the wrapper's `--status [--json]`)
works locally without server credentials. It reports capacity,
active usage, draining excess (usage above capacity), host, project/task, actor, supervisor PID, random launch identity, start time,
and waiters in admission order. JSON also lists the live processes belonging
to each active tree, plus numeric `usage` and `draining` counts. Project status includes this pool, and ordinary text
status prints it. N/A checks bypass the pool entirely.

A fresh random `ATELIER_TEST_LEASE` is installed in the supervisor's launch
environment and inherited by its command. PID liveness alone is never proof
of ownership: a reused PID with another launch identity cannot retain or
release the old entry. Descendants must preserve this environment variable,
including when detaching into another process group. A nested wrapper keeps
it. The supervisor ends leftover descendants after the direct command exits,
first with SIGTERM, then SIGKILL after five seconds, and waits until they
have actually exited. SIGINT/SIGTERM cancel a queued request or terminate a
running tree. SIGKILL cannot execute cleanup; surviving marked descendants
retain the slot, and the next admission or status read reclaims entries once
no marked process remains. SQLite's OS locks and rollback journal protect
transactions even when a writer is killed.

This requires Node 24 or later and macOS/Linux process inspection with `ps`.
Every participant's process environment must be visible to the service
account. An environment that denies inspection refuses admission; it never
assumes the machine is empty. Shells or tools that deliberately clear the
lease variable leave cooperative enforcement, just as direct shell commands
do. This wrapper does not attempt to constrain hostile processes.

Cloud containers do not share the host's filesystem or process namespace.
Wrappers inside a container therefore use that container's own pool; local
status never reports cloud containers. Container checks requested through
Atelier's sandbox path continue to run in the container, not in a host slot.
Do not mount the host pool database into a container or share `/tmp` between
otherwise independent process namespaces.

The former runner `loadLimit`, `ATELIER_LOAD_LIMIT`, and `ATELIER_LOAD`
settings are retired and ignored. Neither runner admission nor checks wait
on load average. Old evidence can still contain historical load readings.

## Runtime smoke check

The runtime dependencies are process-environment visibility and separate
container `/tmp` and PID namespaces; a restricted build sandbox cannot prove
them. Before and after deploying a runner or changing its container image,
run `node --test test/load-process.test.mjs` on that runner and in a disposable
container using the deployed image. It checks real cancellation, SIGKILL,
surviving descendants, reclamation and nested wrappers. The ordinary
`test/load.test.mjs` suite separately checks transactional concurrency and
priority/FIFO. Also hold a wrapped command in the disposable container and
read wrapper status on the host: only the container may report that command.
A failed or skipped smoke check blocks rollout; do not bypass admission to
make it pass. Tests report a reason and skip when a build sandbox denies
`ps`; those skips are not runtime verification. Run the smoke suite where
process inspection is allowed before and after rollout.
