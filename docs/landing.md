# Landing and merging

For developer-token examples, set the acting model for the session:

```sh
export ATELIER_ACTING=claude-code/opus-5.5
```

Use your own registered harness/model. Owner commands such as `ship`,
`wrap`, `branch push|fetch`, `plan show`, `projects` and `import-tasks` keep
the owner actor and use `ATELIER_ACTING`; do not add `--as` to them.
Commands that act as a builder or reviewer use `--as H/M` to name that actor. Agent and runner tokens
name their own actors; leave `ATELIER_ACTING` unset with those tokens.

The cross-company rules below describe the default policy. With
`atelier init --single-family COMPANY`, building and reviewing use only that
company's models: a reviewer must be a different model from every contributor,
never a contributor under another harness. This exception also applies to
criteria review, handoffs and conflict contributors. Only that company's models
qualify.
`atelier init --cross-family` restores the default; both switches record who
made them and when. See [Single-family mode](gate.md#single-family-mode).

How accepted work reaches the project: `atelier finish`, `atelier merge`
with its journal and cancel, and `atelier land`, which runs the whole second
half of a task in one command. The README's "Landing" section gives the
outline.

## Finish and merge

After committing, an agent runs `atelier finish` in its claimed workspace.
It pushes, runs required checks, and submits only if those checks pass and
the workspace remains unchanged.

Once a part of a plan is submitted, if the gate needs an independent review, the server queues a review request automatically as a `review` job, and a runner that offers review jobs claims it. Approval moves the part to integration. For a single task outside a plan, nothing is queued automatically; its review is requested when the developer lands it whole (see Landing a task whole, below), or they can complete an exact revision by hand with:

```sh
ATELIER_ACTING=claude-code/opus-5.5 atelier merge t9 --head FULL_COMMIT_SHA --approve --note 'Reviewed changes'
```

`--approve` records the developer's own review, which is not the independent
review a protected change needs: that review must already exist, or
`--override-review "reason"` records the developer's override of it while
accepting. Acceptance still goes through the gate. Already accepted work
needs only `atelier merge t9 --head FULL_COMMIT_SHA`.

Merging records a journal for the registered checkout under the CLI's cache,
`~/Library/Caches/ai-projects/cloudflare-git/landing/KEY/journal.json`, with
the lock that keeps merges one at a time beside it. KEY is derived from the
checkout's Git directory; neither file lives in that directory, which iCloud
Drive syncs and where it renames a file it finds in conflict to a copy. The
publish pushes the merge commit alone to the project's branch, and the
provenance notes on a push of their own that never decides the merge. If
publishing the baseline or recording the merge fails, rerun the same command.
It resumes from the local merge commit. It refuses a different revision, a
dirty checkout, or concurrent merge. If a process stops during the
uncommitted Git merge, abort that merge with `git merge --abort` before
retrying, or cancel the landing. The journal preserves the original revision
and starting commit. Never remove it to bypass a mismatch: cancel the landing.

`atelier merge t9 --cancel` ends a landing. It takes the landing lock, as
merge does, so it refuses while a merge of the same checkout is running, which
may be publishing. It keeps what the landing left in the checkout, an
unpublished merge commit or an unfinished Git merge, unless `--discard-local`
is given. Then it aborts the unfinished Git merge, or puts the branch back on
the commit where the merge began, the latter only while the branch is still on
the merge commit with nothing uncommitted; otherwise it changes nothing and
says what to move first. The journal is matched by task, not by revision: a
push or review can withdraw an acceptance after the merge commit is made and
before the landing lease is taken, and a new revision can then be accepted.
Such a landing can no longer be finished, so `atelier merge t9` refuses it and
names the cancel, which ends it in the checkout and leaves the server alone.
With a journal, the landing lease is cancelled on the server only while the
task is still accepted at the journal's revision. With a journal or without,
the lease is left alone when the baseline already holds the accepted revision
through a merge made elsewhere, whose lease it is; without a journal the
cancel then refuses. Wherever the cancel asks what the baseline holds, it
fetches the baseline and Git reads its whole history. The server also refuses
to cancel a lease once the baseline holds the accepted revision, reading its
history page by page.

Once the merge is on the baseline the cancel refuses, with or without
`--discard-local`, and the checkout keeps the merge: the journal says so once
the push has returned, and for a push that reached the baseline just before
the process stopped, the baseline's history says so. Rerun `atelier merge t9`
to record it. A merge the server has already recorded, or can no longer
record because the task is not accepted at that revision, leaves only the
journal, which the cancel removes.

### The checkout lease (G9)

The merge runs in the registered checkout, and so does `atelier ship`
(docs/ship.md). Once a deploy raced the lander there. So `atelier merge`,
which `atelier land` runs for its merge step, and `atelier merge --cancel`
take the project's checkout lease before they touch the checkout and free it
when they end, however they end; a process killed outright leaves it to lapse after 15 minutes without
a heartbeat. While a ship holds it, the merge waits and says who holds it.
A holder that stalled past the limit and was taken over stops at its next
step (before the local merge, before publishing, before post-merge steps),
saying so as a fact with a `next`, so nothing more of it touches the
checkout. The server keeps the lease (`GET /api/projects/P/checkout-lease`: holder,
kind, task, machine, process and since) beside the landing lease, which
guards the baseline rather than the checkout.

A deploy by hand outside `atelier ship` cannot be prevented. So the lease
also keeps the checkout's head as the last merge or ship left it, and the next
take compares it with the head now. A different head is reported as a fact,
never as an error to retry (`Fact: P's registered checkout is at X, not at Y
where t3's merge left it ...`, then `next:`), and recorded as a
`checkout.moved` event; the landing goes on.

While a merge holds the landing lease, the task cannot be abandoned, since the
merge may already be on the baseline: finish it with `atelier merge t9`, or
end it with `atelier merge t9 --cancel` while it is not on the baseline, then
abandon.

An earlier CLI kept the journal in the Git directory as `atelier-landing.json`,
with its lock, `atelier-landing.lock`, beside it. A landing interrupted under
it is picked up where it was left: the next `atelier merge` or
`merge --cancel` moves the journal under the cache unchanged and goes on from it, and
removes the lock once the process its owner record names (`pid`, or the `pid 2`
copy iCloud makes) is gone. A live owner still blocks, a lock with no owner
record waits for a human, and a journal found in both places is refused with
both paths named. `atelier wrap` names such a journal as a landing in progress
and moves nothing.

The browser provides this local command after acceptance. It does not run a
network-accessible local executor. Deployment and pushing the project branch
to its own remotes remain separate decisions.

## Landing a task whole

`atelier land t9 --reviewer H/M` runs the whole second half in one command, for the project
developer in the registered checkout. Since Atelier 2.0 (lessons gaps G1 and
G2) it lands the head the task was checked and reviewed at, and never pushes
to the task's branch: the landing push already is a merge of the accepted
head onto the project's branch (the hook's rule 4, [branches](branches.md)),
so the task's branch and its approvals stay as they were reviewed.

### The order of a landing (G2)

1. **Before the lease**, beside any other task's landing:
   - The task must not be blocked, merged, abandoned or a plan. A claimed
     task needs its workspace at its recorded head, with nothing unpushed;
     a submitted or accepted task needs no workspace at all.
   - The task's head and main are fetched into one repository (the claimed
     task's workspace, or else the registered checkout), with no ref moved,
     and the task's edits are compared with code main moved to another file
     since their merge base (t471). A finding stops the landing here, named
     as a `moved-code` failure (a fetch that fails is the `fetch` step); `--moved-ok` records the developer's
     approval of exactly those findings and goes on.
   - The triage, where the landing has one (below).
   - A claimed task has its required checks run at its recorded head, in a
     clean clone (`atelier check`), and is submitted. A submitted task's
     checks are the ones its holder ran at that head.
   - The review the gate needs, asked and not waited for (t264), or settled
     by an approval already recorded at the head.
   - The gate, as `accept` reads it: the head with its checks passing and an
     approval it counts (or none needed).
2. **The lease**, queued for in the order the landings asked (below).
3. **Accept** the head, under the lease.
4. **`merge-main`**: `atelier merge t9 --landing` merges the accepted head
   into the project's branch in the registered checkout, through the merge
   pipeline, with every guard `atelier merge` has (the commit identity, the
   private files, paths a Mac stores as one, files the checkout's Git runs,
   declared outputs). A checkout that only lags the baseline is
   fast-forwarded to it first. A conflict stops the landing here: the merge
   is undone, nothing is pushed anywhere, the record names the files, and
   the approval stands at the head. Whether the builder or the developer
   resolves it is not the lander's to decide: `atelier dispatch t9 --job
   merge-main` sends it back to the builder, whose own clean merge of main
   keeps its approval under the review-retention rule (t288, t56).
5. **`regenerate`**, where the project's policy declares a regenerate
   command (`atelier init --regenerate`): it runs on the merged tree in a
   clean clone, and what it changes is folded into the merge commit, whose
   parents stay the branch's tip and the accepted head.
6. **`checks`**: the project's required checks run once each on the merged
   tree, in that clean clone. A check is observed once per merge result: a
   failure is not run again, so a flaky pass on a second run never lands. A
   failure puts the checkout back where the merge began and pushes nothing;
   the task stays accepted with its approvals, and is not rejected.
7. **`push`**: the merge commit, and nothing else, goes to the project's
   branch (`pushMergeToProjectBranch` in `cli/landing.mjs`, the one function
   that pushes it, with a landing grant minted to the lease holder for the
   task at its accepted head: docs/branches.md). If main moved between
   the checks and the push, Git and the hook refuse it, since it is not a
   fast-forward: the merge is undone and steps 4 to 6 run again on the new
   main, at most twice, and each merge is pushed at most once. A third
   refusal stops the landing with the fact: how often main moved, from
   where to where, with nothing pushed. The provenance notes go on a push of
   their own afterwards, to `refs/notes/atelier`, which the hook lets the
   owner and landing grants write by fast-forward, and never decide the
   landing: a refused notes push leaves them in the checkout for the next
   landing.
8. **`merged`**: the merge is recorded, once the server has found it on the
   project's branch with the accepted head among its parents; the landing
   grant is revoked, and the lease released.

The developer's own `atelier merge t9` (without `--landing`) still merges
and publishes an accepted head by hand, pushing only the merge to the
project's branch, without the merged-tree checks. On the Node server it
takes the landing lease for its landing grant, and lets it go at the end.

### The landing record (G1)

Every landing that gets past the dry run is an attempt. Its steps are
recorded as `land.*` events (`land.start`, `land.lease`, `land.accept`,
`land.merge-main`, `land.regenerate`, `land.checks`, `land.push`,
`land.merged`, and `land.triage`, `land.check`, `land.submit` and
`land.review` before the lease), and the Ledger keeps the latest on the task
as its landing record, which `atelier show t9 --json` carries:

```json
"landing": { "step": "checks", "attempt": 2, "at": "…", "head": "…",
             "failedStep": "checks", "tail": "…the failing check's last lines…" }
```

`start` opens an attempt at the task's head. A failure of a step under the
lease (`merge-main` to `merged`) is recorded only for the current attempt,
and not once another task's landing has taken the lease; a lease that
lapsed with no takeover still records it. A failed step stays named as
`failedStep` with `tail`, the last lines (at most 2,000 characters) of that
step's own output — the failing check's, not what ran before it — and, for a
conflict, `files`. A refusal before any step (a blocked task, a workspace
with unpushed commits) is the `start` step failing, its words the tail; a
lease the landing could not take is the `lease` step failing. A signal that
ends the landing is recorded as the step it was at failing.

A failed landing is not tried again on a timer. The server stops offering
its land job to the lander while the task's head is the one it failed at,
and the runner passes the job by while it is the one that failed; the
lander's log has one line per attempt, naming the failing step, the attempt
and the tail. `atelier land t9 --queue` queues it again (the record notes
`requeued`), and a new head lets it run.

## Landing by itself

A task lands with no session once its required checks passed at its head and a
reviewer of another company approved that head (t520). The stage tick queues
the land job at once: no `atelier accept`, no fast mode, no standing
instruction and no wait past a stage limit are needed. A runner that lists the
land job and holds the registered checkout runs `atelier land` in it, one
landing at a time per project under the landing lease, and the second of two
approved tasks is merged and tested on a main that holds the first.

The tick queues nothing when:

- the approval is for an older head than the task's current one, or is from a
  reviewer of the builder's own company, even in a single-family project where
  the gate admits it (`crossCompanyApproval`, `src/rules.ts`);
- the task is marked `--next-gate developer` and not accepted at its head;
- a landing failed at this head and the developer has not queued it again, so a
  conflict or a failed check is not retried in a loop;
- the developer recorded `atelier decide --standing queue-landable off` (fast
  mode), or no live runner offers the job.

The landing tests the tree main will become. The builder's passing checks at
the same head are reused instead of run again when every required check has a
complete receipt for an ordinary run, and main has moved no path the task
touches between the receipt's base and the main the merge was made on
(`reusableChecks` and `reuseVerdict`, `src/landing-verdict.ts`;
`reuseDecision`, `cli/landing.mjs`). The `land.checks` event then carries
`reused: true`, the base and main it was read against, and one `reused: CHECK`
line per check; otherwise the checks run on the merged tree, and a failure
pushes nothing. A regeneration that changes the tree, or a receipt that cannot
be read, reuses nothing. If main moves between the check and the push, the push
is refused and the merge is made again on the new main, and checked under the
same rule, twice at most.

A landing that stops on a conflict is sent back to the task's builder by the
runner (`atelier dispatch ID --job merge-main`, with the files in the note) and
is not run again at that head.

`atelier land t9 --queue --cancel` removes a queued landing. Run when nothing
is queued, it says so, exits 0 and changes nothing. A landing of the task
that holds the lease and has begun its merge (`merge-main` or later) is not
cancelled or interrupted: the cancel refuses, naming the step it is at. One
still before its merge stops when it reaches the lease, merging nothing.

The lease is released when the landing ends, on success or failure alike; a
landing stopped partway can be resumed by running `atelier land t9` again,
and a lease whose task has merged or was abandoned no longer guards
anything.

### The queue for the lease

A landing waiting for the lease queues for it (with or without `--wait`,
since t550), and the queue has an order: the server keeps the landings waiting for the lease in
the order they queued (one row per task, with who asked and when) and hands
the lease to the first of them when it frees, so a landing cannot take it
ahead of another that waited longer, however their polls happen to land —
t247 once took it ahead of t245, which had waited longer and was the one its
plan needed. While it waits the landing asks the server again on every poll,
which refreshes its place, and says whose landing it waits behind and which
landings are queued ahead; a landing that stops asking (killed, or ended by a
signal, or given up after its three-hour limit, which leaves the queue
outright) drops out once 15 minutes pass without an ask, as a lease not
renewed for that long stops guarding the project, and a row whose task has
closed goes the same way.

A landing that loses the lease stops rather than merge beside its successor:
a Mac can sleep through a landing's merge, pausing the timers that renew the
lease, so it lapses and a waiting landing takes it over, and the first
landing wakes to find the lease gone. It then ends at once, having accepted
and merged nothing, and says whose landing holds the lease now; before the
accepting and merging steps it also asks for the lease again, so a loss it
slept through cannot slip between renewals, and the server itself refuses a
merge while another task's landing holds the lease. Whatever is left of the
stopped landing (a review already approved, an acceptance)
stands, and `atelier land t9` again, or `atelier merge t9` once the task is
accepted, finishes it after the other landing ends.

Details of the steps:

1. Clients from before capabilities require the server to be at their route
   level or newer. `GET /api/version`
   reports the commit the server was deployed from (`npm run deploy` records
   it) and its route level, and a landing whose server is older refuses
   before it starts, naming both levels and saying to deploy, since the
   server may lack the routes the landing needs, or answer one the landing
   asks in a way it no longer expects. `ROUTE_LEVEL` is frozen at 28 (t522);
   new routes require named capabilities, never a numeric raise.

   The landing now checks named capabilities rather than that number (t458):
   `GET /api/version` also lists `capabilities`, names like
   `land.triage.v1` that each stand for one behaviour of the API, and
   `atelier land` refuses, before the lease or any workspace changes, when
   the list lacks one of the capabilities its module declares
   (`src/usage/commands/land.ts`, read back as `COMMAND_CAPABILITIES.land`),
   naming the missing set, the revision the server runs and the deploy to
   run. Extra capabilities are accepted; a reply with no usable version,
   and one whose `capabilities` or `routeLevel` is the wrong shape, are
   refused with their own messages. A capability is never changed
   incompatibly: the change takes a new name (`…v2`), and a client that
   needs `v1` is not satisfied by a server that publishes only `v2`.

   Every command checks the same way: a command that relies on an API
   behaviour names it in `capabilities` in its module,
   `src/usage/commands/NAME.ts` (a subcommand's own go under
   `subcommands`, so `atelier models` lists the pool on any server while
   `models note` needs `models.note.v1`), and the CLI asks the server once,
   after the flags are checked and before the handler's first request
   (`requireCapabilities`, `cli/atelier.mjs`); `land` alone makes the same
   check itself, after `--release-lease`, which touches only the lease
   route so a stuck lease can be freed while the server is behind, and
   before the lease is read. `claim`, `start`, `wrap`, `new`, `edit`, `init`, `merge`, `plan refresh`,
   `review`, `review-claim`, `review-unparsable`, `token issue`, `token
   store`, `board`, the criteria review's `criteria-review`,
   `criteria-review-claim`, `criteria-verdict`, `criteria-review-failed`
   and `criteria-finding` (`reviews.criteria-review.v1`, t438) and the integrator's `integrated`,
   `integration-failed`, `refreshed` and `refresh-failed` declare theirs
   (`edit` declares the binding a change of criteria withdraws: a command
   declares what any of its flags may ask); a command with none, and
   `help`, `--help` and `--version` of any command, asks nothing, so the
   offline commands work with no server at all, including `init --rename-local`.
   The identity consumers (`revert`, `claim`, `start`, `wrap`, `init`, `merge`,
   `land` and runner jobs) require `projects.commit-identity.v1`;
   `models admit`, `withdraw` and `reviewers` require `reviews.admission.v1`;
   `models set` requires the pool's standing, `models.standing.v1` (t389),
   and `models add` asks for it only with `--state`, `--roles` or `--tier`;
   `init` and `land` require the durable post-merge runs, `land.post-merge.v1`
   (t477), and `land --post-merge` asks for that one alone; they also
   require the landing's triage step, `land.triage.v1` (t475); `stuck`
   requires the stuck report, `projects.stuck.v1` (t441). The home runner checks the
   union of its jobs' (`JOB_CAPABILITIES`, `src/route-level.ts`) before its
   first poll, the integrator's `integrate` and `refresh` jobs included;
   the review job's include the review claim leases (`reviews.lease.v1`) and the review skip (`reviews.skip.v1`,
   `reviews.skip-as-runner.v1`), so a reviewer against a server from before
   t353 refuses to start instead of losing its skips.

   **Adding a route.** Add one unique `family.behaviour.vN` declaration,
   with a summary and no `level`, to `src/capability-declarations.ts`, and
   name it in the consuming command or runner job's requirements. The server
   publishes it automatically. Do not raise `ROUTE_LEVEL`. `.gitattributes`
   routes the file to `merge=atelier-records`, and `bin/merge-manifest.json`
   declares it a record file keyed by `name`. In a clone Atelier manages
   (every merge goes through the pipeline in step 2 below), independent
   declarations unite by name in either order, and a name both sides added
   differently, edited or deleted stays in conflict for resolution. In a
   clone without Atelier's setup, Git knows no `atelier-records` driver and
   merges the file as ordinary text, so additions on neighbouring lines
   conflict and are resolved by hand; either way the capabilities test
   refuses duplicate names after merging.
   A server missing the name is refused with the same deploy-first remedy,
   even if it reports a higher route level.

   **Legacy compatibility.** The server still publishes `routeLevel` for old
   clients. A server that publishes only a level guarantees existing
   declarations up to that level, capped at the frozen boundary of 28.
   Keep historical mappings unchanged. New declarations have no legacy
   guarantee. Queued tasks carrying a `level` above 28 may keep that metadata,
   but must drop their `ROUTE_LEVEL` raise; their capabilities work through
   the published names, never through that metadata. There is no contiguous
   level requirement or renumbering step. The capabilities test pins the
   frozen number and checks independent additions in both merge orders.

   The run skip, `runners.run-skip.v1` (t420), is one such name: every
   runner job but the review requires it, so a runner refuses a server that
   reports only a route level and starts on one that publishes the name.

2. The merge goes through the merge pipeline (`cli/merge-pipeline.mjs`),
   the same one every merge Atelier makes with Git goes through: the
   landing's merge of the head into the project's branch in the registered
   checkout, `atelier update` (a pipeline merge wherever a declared
   generator must run, otherwise a rebase through the clone's merge
   drivers), a runner's merge-main, integrate and refresh merges, and the
   speculative merge `atelier check --merged` checks in its clean clone.
   The server makes no Git merge: the item page's merge preview, a plan's
   and a part's mergeability read the same declarations through
   `src/merge-declarations.ts`, uniting record files by key and listing
   regenerable outputs apart from source conflicts. No generator runs
   there.
   `bin/merge-manifest.json` declares each generator (its name, its command
   as an argument list, the source inputs it reads and the outputs it
   writes), the record files that unite by key, and the registries whose
   entry files (one per command or route declaration) must keep unique keys;
   `.gitattributes` routes each declared output to `merge=atelier-generated`
   and each record file to `merge=atelier-records`. The pipeline first
   installs those drivers in the clone's own Git config, then merges the
   sources. Record files unite by key, while a key both sides changed
   differently, an edit against a deletion or a duplicate registry key stays
   a conflict. In the landing's merge onto the project's branch no generator
   runs in the checkout: where one would, `verifyAccepted` merges first in a
   throwaway clone and runs each declared generator twice. A successful,
   deterministic generator may change its declared outputs; the landing
   commits those outputs with the merge and says so without another review.
   Generator failures, writes outside declared outputs, missing outputs and
   changes between runs stop the landing. The checkout adopts the verified
   outputs without running the generator again; any other difference from
   the verified merge tree also stops the landing. On conflicts the landing stops, naming the
   files (`failedStep: merge-main`), and leaves nothing in the checkout. The
   conflicts go back to the task's builder: `atelier dispatch t9 --job
   merge-main` (naming the holder with `--agent` and `--model`) sends the
   task to a runner, whose merge-main job merges main into the workspace and
   leaves the conflicts for the builder to resolve, commit and push with
   `atelier push`; then `atelier land t9` again. See
   [Dispatch](runners.md#dispatch).
3. When the project's policy declares a `regenerate` command
   (`atelier init --regenerate "CMD"`), it runs on the merged tree in the
   clean clone the checks use, as a check runs, and what it changes joins
   the merge commit before the checks see it. The landing adds no typecheck
   of its own: the project's required checks are the whole gate, run once
   on the merged tree.
4. If the gate needs an independent review, the landing requests one through the
   review-request routes: the reviewer is the one named with
   `--reviewer H/M`. Without a named reviewer, a needed review is refused
   with candidates. It records a land request and stops without waiting
   when approval is missing. Run it again after approval. A rejection keeps the task submitted. `--no-review` leaves the task submitted for the developer to settle by hand.
5. With the head checked and approved, the landing takes the lease, accepts
   through the CLI's own `accept`, and merges through `atelier merge t9
   --landing`, each run as this CLI's child, so their checks and their
   journals behave exactly as when the developer runs them. The merge's
   journal lets a landing killed partway resume where it stopped.

Each step, its duration and what it settled are recorded on the task as
`land.*` events (the files a conflict stopped on, the reviewer and the
verdict, the merge commit, the checks and how often main moved before the
push), so the cost of integrating a task can be read from the ledger, and
the landing record carries the latest (above). A record is capped at 4,000
characters of JSON, a list in it cut to its first entries with the count of
all of them beside it. `--dry-run` prints the steps, with a preview of the
merge, and the refusals without changing anything.

### Triage before the review

A landing can have one model triage the change before the review is asked
for (t475), so a change that plainly misses a criterion goes back to its
holder without spending a review round. The model is `--triage H/M`, or else
the project's `triage` setting (the policy's, set with `atelier init --triage
H/M` and cleared with `--triage ""`, or `"triage": "H/M"` in this Mac's
registration of the project in the Atelier config); with neither, no triage
runs. A model of the builder's own company may triage, since triage
is not the independent review; the pool's rules still apply: the model must
be in the pool, not refused, and not paid per token. It runs on the developer's
Mac through its harness's adapter (`bin/harness`), read-only, for at most 30
minutes (`ATELIER_LAND_TRIAGE_TIMEOUT` milliseconds).

The triage reads the task's recorded head before the review request.
`atelier land` never pushes to the task branch. A claimed task must have
its workspace changes committed and pushed before landing; the command
runs its required checks and submits that recorded head. A submitted task
keeps its recorded head and any review already open there.

The triage compares that head with its merge base with main and reads the
task's acceptance criteria (and a part's, numbered after them) as they are now.
For each criterion it answers met, not-met or unsure, with its evidence and
a file and line, or the reason no location applies. Its brief has it trace
the production request paths the change touches and list the runtime
behaviour it could not verify. A result is bound to the head, the merge base
and the criteria binding, and a pass recorded at the same binding by the same
model is not asked for twice. The criteria are read again just before the
submission, and criteria changed by then are triaged again with nothing yet
submitted. Criteria changed after the submission stop the landing before the
review request, saying the task is submitted and no review was asked for;
running the landing again triages the new criteria.

Only every criterion met goes on. A criterion not met or unsure, a task with
no criteria, a reply that cannot be read, a timeout, or a model that is
unavailable stops the landing before the task is submitted: the
findings are printed with the command to run again, the lease is never
taken, and the recorded task head stays unchanged. The project
developer can skip the triage with `--no-triage "REASON"`, or go past a stop with
`--override-triage "REASON"`; either is recorded with the head and the
criteria binding before the landing goes on, and a record the server
refuses — it takes one only from the signed-in developer — stops the
landing. Neither stands in for the independent review.

Triage is recorded as `land.triage` events (the binding, the model, the
outcome — passed, stopped, bypassed or overridden — each criterion's status,
and the developer's reason), never as a review: it adds no approval, rejection
or round, and the gate decides as it did. After a pass or a bypass the
landing goes on under the review rules as they are, whether no review is
needed, an approval already covers the change, or `--no-review` was given.

## Integration basis

The integrator runner merges each part onto its plan's branch as `atelier/integrator`. Their commits remain in the integration history. The tick queues a `refresh` job to merge main into the plan's branch when it moves, so later parts branch from an updated basis. For a single task, `atelier land` merges the accepted head into the project's branch in the registered checkout and runs the checks on that merged tree before it pushes. Local verification does not establish a successful production container run.

## Landing without a separate acceptance

For an ordinary task, run `atelier land ID` once the required checks pass
and a qualifying independent reviewer approves its recorded head. The landing
checks the gate and accepts that head internally before merging it. No separate
`atelier accept` command is needed. Ship remains the developer’s control.

To require a developer decision for a task, set
`atelier edit ID --next-gate developer`. A landing refuses that task until the
developer runs `atelier accept ID`. Other next-gate text remains descriptive.
Plans still use their integration and acceptance workflow.

A developer can record review and landing intent with the build dispatch:
`atelier dispatch ID --agent H --model M --reviewer H/M --land`.
The dispatch keeps the named reviewer. With `--land` and no `--reviewer`, it
uses the project's `review-on-checked` mapping for the named builder's company;
without a matching mapping it refuses. Submit asks the review under the current
gate, reviewer admission and independence rules, then queues the ordinary land
job. The lander needs a registered checkout and a runner offering `land`.
A refusal leaves the task submitted and records `submission.review_wait`;
resubmitting the same head retries, and the checked-stage tick retries too.

`atelier status` and `status --brief` list a submitted task with no gate review
at its current head under "Waiting on the orchestrator", with
`atelier land ID --reviewer H/M --project NAME`. Status JSON includes the same
command in `orchestratorWaits`; item snapshots carry `reviewAskedHead` (null
when none). This field comes from the ledger's current gate review requests,
including answered requests, excluding withdrawn, released and tier requests.
An omitted field means an older server did not supply this information.

`atelier-pulse` in ai-projects-ops (`bin/atelier-pulse`) implements the wake
itself. It reads `item.submitted` and `review.requested` from `atelier events`,
waking for a submitted head with no review asked and staying quiet when a
review is asked for that head. This repository provides the dispatch-time
review request and the status wait. The walters-coach regression test here
covers the status half; pulse coverage belongs to ai-projects-ops.
Before and after deployment, smoke-check a dispatch with `--reviewer --land`
through submit, review approval and merge on a registered checkout. Also check
that the installed pulse wakes once for an unasked head and stays quiet for an
asked head. Local tests do not exercise the external pulse or a live runner.
