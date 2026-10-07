# Landing and merging

How accepted work reaches the project: `atelier finish`, `atelier merge`
with its journal and cancel, and `atelier land`, which runs the whole second
half of a task in one command. The README's "Landing" section gives the
outline.

## Finish and merge

After committing, an agent runs `atelier finish` in its claimed workspace.
It pushes, runs required checks, and submits only if those checks pass and
the workspace remains unchanged. A project with `sandboxOnly` enabled uses
the cloud runner automatically. `--sandbox` selects it explicitly.

Once a part of a plan is submitted, if the gate needs an independent review, the server queues a review request automatically as a `review` job, and a runner that offers review jobs claims it. Approval moves the part to integration. For a single task outside a plan, nothing is queued automatically; its review is requested when the owner lands it whole (see Landing a task whole, below), or the owner can complete an exact revision by hand with:

```sh
atelier merge t9 --head FULL_COMMIT_SHA --approve --note 'Reviewed changes'
```

`--approve` records the owner's own review, which is not the independent
review a protected change needs: that review must already exist, or
`--override-review "reason"` records the owner's override of it while
accepting. Acceptance still goes through the gate. Already accepted work
needs only `atelier merge t9 --head FULL_COMMIT_SHA`.

Merging records a journal for the registered checkout under the CLI's cache,
`~/Library/Caches/ai-projects/cloudflare-git/landing/KEY/journal.json`, with
the lock that keeps merges one at a time beside it. KEY is derived from the
checkout's Git directory; neither file lives in that directory, which iCloud
Drive syncs and where it renames a file it finds in conflict to a copy. If
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

While a merge holds the landing lease, the task cannot be abandoned, since the
merge may already be on the baseline: finish it with `atelier merge t9`, or
end it with `atelier merge t9 --cancel` while it is not on the baseline, then
abandon.

An earlier CLI kept the journal in the Git directory as `atelier-landing.json`,
with its lock, `atelier-landing.lock`, beside it. A landing interrupted under
it is picked up where it was left: the next `atelier merge`, `merge --cancel`
or `sync` moves the journal under the cache unchanged and goes on from it, and
removes the lock once the process its owner record names (`pid`, or the `pid 2`
copy iCloud makes) is gone. A live owner still blocks, a lock with no owner
record waits for a human, and a journal found in both places is refused with
both paths named. `atelier wrap` names such a journal as a landing in progress
and moves nothing.

The browser provides this local command after acceptance. It does not run a
network-accessible local executor. Deployment and pushing the project branch
to its own remotes remain separate decisions.

## Landing a task whole

`atelier land t9` runs the whole second half in one command, for the project
owner in the registered checkout: it merges main into the task's workspace,
regenerates the project's fixtures when its policy declares how, pushes, runs
the required checks, submits, waits for the independent review the gate
needs, then accepts and merges. It replaces the queueing a project owner did
by hand, one landing at a time, and it takes a lease on the server to keep
that order: while one landing runs, another landing in the same project is
refused with who holds the lease and since when. The lease is released when
the landing ends, on success or failure alike; a landing stopped partway can
be resumed by running `atelier land t9` again, which takes its own lease
back, and a lease whose task has merged or was abandoned no longer guards
anything.

With `--wait` a landing queues for the lease instead of refusing, and the
queue has an order: the server keeps the landings waiting for the lease in
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
a Mac can sleep through a landing, pausing the timers that renew the lease,
so it lapses and a landing queued with `--wait` takes it over, and the first
landing wakes to find the lease gone. It then ends at once, having accepted
and merged nothing, and says whose landing holds the lease now; before the
accepting and merging steps it also asks for the lease again, so a loss it
slept through cannot slip between renewals, and the server itself refuses a
merge while another task's landing holds the lease. Whatever is left of the
stopped landing (a merged main, a pushed head, a review already approved)
stands, and `atelier land t9` again, or `atelier merge t9` once the task is
accepted, finishes it after the other landing ends.

The steps in between:

1. The server must be at this CLI's route level or newer. `GET /api/version`
   reports the commit the server was deployed from (`npm run deploy` records
   it) and its route level, and a landing whose server is older refuses
   before it starts, naming both levels and saying to deploy, since the
   server may lack the routes the landing needs, or answer one the landing
   asks in a way it no longer expects. The route level
   (`src/route-level.ts`) rises by one only when a change makes the CLI
   start calling a route the server did not have, or changes the meaning of
   a route the CLI already calls; the waiting queue the landing's `--wait`
   asks about (`{ item, queued: true }` on the landing-lease route) raised
   it to 10 (main had already reached 9 with another route change).
2. Main is fetched into the task's workspace and merged with `--no-ff`. On
   conflicts the landing stops, leaves the merge in the workspace for the
   owner to resolve, and names the files. After resolving and committing,
   `atelier land t9` again picks up from the push. The conflicts can also go
   back to the task's builder instead: `atelier dispatch t9 --job merge-main`
   (naming the holder with `--agent` and `--model`, as the message the
   landing prints says) sends the task to a runner, whose merge-main job
   merges main into the workspace again and leaves the conflicts for the
   builder to resolve and commit; then `atelier land t9` again, with main
   already merged. See [Dispatch](runners.md#dispatch).
3. When the project's policy declares a `regenerate` command
   (`atelier init --regenerate "CMD"`), it runs in the workspace like a check
   runs, and what it changes is committed before the push, so generated
   fixtures are current with both lines before the checks see them. The
   landing adds no typecheck of its own: the project's required checks are
   the whole gate, and they run through `atelier check` in a clean clone of
   the pushed head.
4. If the gate needs an independent review, the landing requests one through the
   review-request routes and waits for the verdict: the reviewer is the one named with
   `--reviewer H/M`, or a model of another family than every contributor
   picked from the pool. The landing says what the runners are busy with while the request is unclaimed, and, when no live runner offers the reviewer for the review job, that the request can never be claimed until one does, with the review by hand and the `--reviewer` that asks a model a runner offers. A rejection or a timeout stops the landing (the request stays open and the task stays submitted). `--no-review` skips the waiting and leaves the task submitted for the owner to settle by hand.
5. The landing accepts and merges through the CLI's own `accept` and `merge`
   commands, each run as this CLI's child, so their checks and their
   journals behave exactly as when the owner runs them.

Each step, its duration and what it settled are recorded on the task as
`land.*` events (the commits that came from main, the files a conflict
stopped on and who resolved it, the reviewer and the verdict), so the cost
of integrating a task can be read from the ledger. `--dry-run` prints the
steps and the refusals without changing anything.

## Integration basis

The integrator runner merges each part onto its plan's branch as `atelier/integrator`. Their commits remain in the integration history. The tick queues a `refresh` job to merge main into the plan's branch when it moves, so later parts fork from an updated basis. For a single task, `atelier land` merges main into the task's workspace before checks run. Local verification does not establish a successful production container run.
