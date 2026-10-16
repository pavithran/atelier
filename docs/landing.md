# Landing and merging

The cross-company rules below describe the default policy. With
`atelier init --single-family COMPANY`, building and reviewing use only that
company's models: a reviewer must be a different model from every contributor,
never a contributor under another harness. This exception also applies to
criteria review, handoffs and conflict contributors. Only that company's tier
models qualify; if none qualifies, no separate tier review is requested.
`atelier init --cross-family` restores the default; both switches record who
made them and when. See [Single-family mode](gate.md#single-family-mode).

How accepted work reaches the project: `atelier finish`, `atelier merge`
with its journal and cancel, and `atelier land`, which runs the whole second
half of a task in one command. The README's "Landing" section gives the
outline.

## Finish and merge

After committing, an agent runs `atelier finish` in its claimed workspace.
It pushes, runs required checks, and submits only if those checks pass and
the workspace remains unchanged. A project with `sandboxOnly` enabled uses
the cloud runner automatically. `--sandbox` selects it explicitly.

Once a part of a plan is submitted, if the gate needs an independent review, the server queues a review request automatically as a `review` job, and a runner that offers review jobs claims it. Approval moves the part to integration. For a single task outside a plan, nothing is queued automatically; its review is requested when the developer lands it whole (see Landing a task whole, below), or they can complete an exact revision by hand with:

```sh
atelier merge t9 --head FULL_COMMIT_SHA --approve --note 'Reviewed changes'
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
developer in the registered checkout: it merges main into the task's workspace,
regenerates the project's fixtures when its policy declares how, pushes, runs
the required checks, submits and waits for the independent review the gate
needs — all without the landing lease — and only then takes the lease,
confirms main has not moved, and accepts and merges.

### Review before the runway (t550)

The project's landing lease is held for the merge alone. The orchestrator's
landing-queue timing log measured 71 landings between 2026-10-11 21:03 and
2026-10-12 16:47 UTC: together they held the single lease for 11.5 hours,
and the 34 that review rejected held it about 11 minutes each before they
failed, since the lease was taken first and kept through the merge of main,
the checks and the review. Now:

1. **Without the lease**, beside any other task's landing: the merge of main
   (with the moved-code comparison, t471), the regeneration, the push, the
   triage (t475), the required checks, the submission and the review. Two
   landings of different tasks check and review at the same time. A
   conflict, a failed check, a stopped triage, a rejection, a review timeout
   or a request no runner will serve ends the landing here, and the lease is
   never asked for.
2. **The gate**, asked before the lease: the server's gate, as `accept`
   reads it, must hold the pushed head with its required checks passing and
   an approval it counts (or none needed). Anything else stops the landing
   with the lease never taken.
3. **The lease, for the merge alone.** Every landing that reaches this point
   queues for the lease if another landing holds it, `--wait` or not: what
   it waits behind is another landing's merge, which takes minutes, never
   its checks or review. The queue keeps its order (below).
4. **Main confirmed under the lease.** The landing reads main again and
   merges only if it is still the commit the head was merged with, checked
   and reviewed against. If another landing merged meanwhile, it releases
   the lease without accepting or merging and goes round again from step 1:
   it merges the new main into the workspace, checks it and asks for the
   review again. That review request is where an approval may carry over a
   clean merge of main: the server decides, by its own rules (t459's
   approval carry, where deployed, answers that an approval already covers
   the change; a server without it asks for a new review, which the landing
   waits for as any other). The CLI never judges the carry itself, so the
   landing works with or without t459. A new conflict ends the landing as
   in step 1. After five rounds (`ATELIER_LAND_MAIN_MOVED_ROUNDS`) of main
   moving, it stops, unmerged.
5. **Accept and merge**, renewing the lease first (t232), then release it.
   Before accepting, the landing sends the main it confirmed to the server
   (`{ item, confirm: true, main }` on the landing-lease route), which reads
   main itself, refuses one it does not hold (`main_moved`, and the landing
   goes round again) and records the confirmed main with the head. The merge
   of that head into any other main is then refused by the server
   (`main_moved`), even if the landing loses the lease before it merges: the
   head goes back for a merge of main, new checks and a review.

A head pushed while the landing waits for the lease is not merged: the
recorded head is checked again before the acceptance and before the merge,
and a moved head stops the landing. `--no-review` leaves the task submitted
after step 1 and never takes the lease.

The landing records the time it spent before the lease and the time it held
it: the `land.lease` event carries `beforeLease` (milliseconds from the
round's start to the ask for the lease), `waited` (milliseconds in the
queue), the `head` and the `main` it was merged with, and a `land.release`
event's duration is the time the lease was held, with the `reason` it was
let go (`merged`, `main moved from A to B`, or the failure). The CLI also
prints both at the end. A server from before t550 does not publish
`land.review-first.v1` and refuses the new fields, so against it the plain
landing records only the `head` with the lease and prints the timing
instead; `--workflow` needs the capability and refuses such a server,
saying to deploy.

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
stopped landing (a merged main, a pushed head, a review already approved)
stands, and `atelier land t9` again, or `atelier merge t9` once the task is
accepted, finishes it after the other landing ends.

The steps in between:

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
   `land.workflow.v1` that each stand for one behaviour of the API, and
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
   before the lease is read. `claim`, `start`, `wrap`, `new`, `edit`, `init`, `publish`, `merge`, `plan refresh`,
   `review`, `review-claim`, `review-unparsable`, `token issue`, `token
   store`, `area`, `board`, the criteria review's `criteria-review`,
   `criteria-review-claim`, `criteria-verdict`, `criteria-review-failed`
   and `criteria-finding` (`reviews.criteria-review.v1`, t438) and the integrator's `integrated`,
   `integration-failed`, `refreshed` and `refresh-failed` declare theirs
   (`new` and `edit` declare the area assignment their `--area` posts, as
   `edit` declares the binding a change of criteria withdraws: a command
   declares what any of its flags may ask); a command with none, and
   `help`, `--help` and `--version` of any command, asks nothing, so the
   offline commands work with no server at all, including `init --rename-local`.
   The identity consumers (`adopt`, `revert`, `claim`, `start`, `wrap`, `init`, `merge`,
   `land` and runner jobs) require `projects.commit-identity.v1`;
   `models admit`, `withdraw` and `reviewers` require `reviews.admission.v1`;
   `models set` requires the pool's standing, `models.standing.v1` (t389),
   and `models add` asks for it only with `--state`, `--roles` or `--tier`;
   `init` and `land` require the durable post-merge runs, `land.post-merge.v1`
   (t477), and `land --post-merge` asks for that one alone; they also
   require the landing's triage step, `land.triage.v1` (t475); `init` and
   `publish REMOTE` (not bare `publish`) require the public mirror policy,
   `projects.publication-policy.v1` (t433); `stuck` requires the stuck
   report, `projects.stuck.v1` (t441). The home runner checks the
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

2. Main is fetched into the task's workspace and merged with `--no-ff`,
   without the lease (t550), through the merge pipeline (`cli/merge-pipeline.mjs`), the same one
   every merge Atelier makes with Git goes through: the developer's merge onto
   the baseline, `atelier update` (a pipeline merge wherever a declared
   generator must run, otherwise a rebase through the clone's merge
   drivers), a runner's merge-main, integrate and refresh merges, and the
   speculative merge `atelier check --merged` checks in its clean clone.
   The Worker makes no Git merge: the item page's merge preview, a plan's
   and a part's mergeability, and the merged tree `atelier check --merged
   --sandbox` checks read the same declarations through
   `src/merge-declarations.ts`, uniting record files by key and listing
   regenerable outputs apart from source conflicts. No generator runs
   there, so a sandbox merged check whose merge needs one is refused,
   naming `atelier check --merged`.
   `bin/merge-manifest.json` declares each generator (its name, its command
   as an argument list, the source inputs it reads and the outputs it
   writes), the record files that unite by key, and the registries whose
   entry files (one per command or route declaration) must keep unique keys;
   `.gitattributes` routes each declared output to `merge=atelier-generated`
   and each record file to `merge=atelier-records`. The pipeline first
   installs those drivers in the clone's own Git config (a fresh clone has
   none; without them Git would merge the paths as plain text), then merges
   the sources. Record files unite by key, while a key both sides changed
   differently, an edit against a deletion or a duplicate registry key stays
   a conflict. Generated outputs are left in conflict, unmarked, until every
   source has merged: a source or record conflict stops the merge there,
   with nothing generated, and the preview (`--dry-run`) and the stop both
   list source conflicts apart from regenerable outputs. Once the sources
   merge, each generator whose inputs or outputs both sides changed runs
   twice; a failing command, a missing output, a write outside its outputs
   or a second run that changes anything stops the merge. Output identical
   to one side is valid. The merge commit names which generators ran and
   what each output matches, the generator's log is kept under the clone's
   Git directory, and the landing's `land.merge` record carries the same
   provenance (`regenerated`). The regenerated head is pushed, so its checks
   and review are of the final output; nothing carries over from the head
   before. On
   conflicts the landing stops, leaves the merge in the workspace for the
   developer to resolve, and names the files. After resolving and committing,
   run `atelier push` in the workspace to record the resolution before running
   `atelier land t9` again. A rerun before that push stops before taking the
   lease, naming the commits the recorded head lacks and `atelier push`. Any
   other workspace not already set up at the recorded head (one behind it, one
   that has diverged from it, or one at it but not configured for the task) is
   moved to a backup; land names the backup and, for a diverged workspace, the
   commits it holds. The conflicts can also go
   back to the task's builder instead: `atelier dispatch t9 --job merge-main`
   (naming the holder with `--agent` and `--model`, as the message the
   landing prints says) sends the task to a runner, whose merge-main job
   merges main into the workspace again and leaves the conflicts for the
   builder to resolve, commit and push with `atelier push`; then `atelier land t9` again, with main
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
   picked from the pool, still without the lease. The landing says what the runners are busy with while the request is unclaimed, and, when no live runner offers the reviewer for the review job, that the request can never be claimed until one does, with the review by hand and the `--reviewer` that asks a model a runner offers. A rejection or a timeout stops the landing (the request stays open and the task stays submitted). `--no-review` skips the waiting and leaves the task submitted for the developer to settle by hand.
5. With the head checked and approved, the landing takes the lease,
   confirms main has not moved (above), and accepts and merges through the
   CLI's own `accept` and `merge` commands, each run as this CLI's child,
   so their checks and their journals behave exactly as when the developer runs
   them.

Each step, its duration and what it settled are recorded on the task as
`land.*` events (the commits that came from main, the files a conflict
stopped on and who resolved it, the reviewer and the verdict), so the cost
of integrating a task can be read from the ledger. A record is capped at
4,000 characters of JSON: a merge that brings more commits from main than
that (t293's landing once brought 103, and its merge step was refused
whole) is recorded as the first commit hashes with the count of all of
them beside it (`fromMainCount`); the hashes themselves are in the merge,
which names main's head. `--dry-run` prints the steps and the refusals
without changing anything.

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

The triage runs after the push and before the required checks. A
submission asks for the review, and so does the checks' passing evidence for
a task already submitted at an older head: the push withdraws its open
review request, and that evidence asks it again at the pushed head. Since
the triage runs first, one that stops has asked nothing of a reviewer. If the task was
submitted before the landing, the stop says it stays submitted, with any
request already open at the pushed head left open.

The triage reads the pushed head — after the merge of main and the
regeneration — as a diff against its merge base with main, with the task's
acceptance criteria (and a part's, numbered after them) as they are now.
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

Through the Workflow, the landing is started as one that triages and the
machine holding the workspace reports the triage's merge base and criteria
binding with the head. The Workflow submits, and later asks for the review,
only while the Ledger holds a pass, bypass or override recorded at that whole
binding and the task's head and criteria are still those; otherwise it ends,
saying what moved, with the lease never taken.

Only every criterion met goes on. A criterion not met or unsure, a task with
no criteria, a reply that cannot be read, a timeout, or a model that is
unavailable stops the landing before the task is submitted (through the
Workflow, before the head is reported, so the Workflow submits nothing): the
findings are printed with the command to run again, the lease is never
taken, and the task stays with its holder, its merged head pushed. The project
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

## Landing through a Cloudflare Workflow

`atelier land t9 --workflow` lands the task through a Cloudflare Workflow
(`src/landing-workflow.ts`, the `LANDING_WORKFLOW` binding in
`wrangler.jsonc`) instead of running every step on the developer's machine.
Without `--workflow`, `atelier land` runs exactly as the section above
describes; the Workflow is an opt-in per landing, and `--dry-run` with
`--workflow` is refused.

The Workflow runs the steps a Worker can do alone as durable steps
(`step.do`) with retries: five tries, 2 to 16 seconds apart, each step
bounded at five minutes. Each step reads and writes the Ledger Durable
Object directly, so it needs no write token, and a transient failure (a 503
from Artifacts, a Durable Object reset) is retried rather than ending the
landing. In order:

1. Read the task: a merged, abandoned or accepted task, or a plan, ends the
   Workflow at once with the plain landing's words, as does a landing a
   blocking pre-review fenced (t524).
2. Wait for the workspace (stage `workspace`, below), holding no lease
   (t550), then see the pushed head in the Ledger. A report must name the
   main head the push was merged with; one that names none ends the landing.
3. Settle the required checks in the landing's checks mode (below): in the
   `local` mode, read their observed results at the pushed head from the
   Ledger; in the `container` mode, run them in a Cloudflare container.
4. Submit the task in its holder's name, as `atelier submit` in the
   workspace does.
5. Request the review and wait for the verdict, polling the Ledger; the
   verdict is judged by `src/landing-verdict.ts`, which the plain landing
   uses too. `--no-review` ends here, leaving the task submitted and the
   lease never taken. A failed check or a rejection ends the landing before
   the lease, too.
6. Ask the gate, as the acceptance will, whether the head is ready: checks
   passing and the approval counted (or none needed).
   Steps 3 to 6 hold no lease to renew, so each asks the landing's record
   whether this instance is still the task's landing; one the server
   replaced (t430) stops there without checking, submitting or reviewing.
7. Take the project's landing lease (stage `lease`), queueing for it in the
   order the landings asked, for up to three hours, and record the time
   spent before it and in the queue.
8. Confirm main, read from Artifacts, is still the main head the executor
   reported. If it moved, release the lease (recording the time held),
   write the stage `workspace` of a new round saying main moved, and go
   back to step 2: the executor merges main again, and the new head is
   checked, submitted and reviewed as before, where the server carries the
   approval over a clean merge of main as far as its rules let it (t459,
   where deployed) or asks for a new review. Each round's steps are named
   for it, so none answers from an earlier round's cached result. After
   five rounds of main moving, the landing ends unmerged.
   Where main has not moved, record it with the head on the Ledger, so the
   merge of the head into any other main is refused (`main_moved`).
9. Read the fork's head from Artifacts, which must be the reviewed head,
   then renew the lease (a lease another landing took over stops this one)
   and accept it.
10. Wait for the merge to be recorded (stage `merge`, below), renewing the
    lease on every poll so it cannot lapse to another landing meanwhile,
    then release the lease, recording the time held.

Two kinds of step need Git with a working tree, which a Worker does not
have, and stay on the machine that holds the task's workspace: merging main
into the workspace (with the regenerate command and the route-level raise)
and pushing it, and the final `atelier merge` in the registered checkout,
which publishes to the baseline. The Workflow writes its stage to the
Ledger (`lease`, `workspace`, `conflict`, `checks`, `review`, `merge`,
`done` or `failed`), and `atelier land t9 --workflow` reads it through
`GET .../items/t9/landing-workflow`, says each new stage once, and acts on
two of them:

- At `workspace` the Workflow holds no lease, and the command merges main,
  regenerates and pushes with the same code as the plain landing, triages
  when the landing triages, in the `local` checks mode then runs the
  required checks in a clean clone (the plain landing's `atelier check`
  step), and reports the pushed head and the main it merged as a
  `workspace` event. A new round (main moved before the lease, or a
  conflict resolved) is worked the same way. A check that fails is
  reported as a failed workspace step instead, which ends the Workflow with
  the check's output.
  Every report names its round, so a report the Workflow buffered from an
  earlier round is passed over.
- At `merge` the Workflow holds the lease, renewing it until the merge is
  recorded, and has accepted, and the command runs `atelier merge t9` in the
  registered checkout. A merge the server refuses because main moved from
  the commit confirmed under the lease (`main_moved`) ends the command,
  nothing merged.

### Where the checks run

`atelier land t9 --workflow --checks local|container` chooses where the
required checks run; `local` is the default. The mode is a flag only: the
project's policy holds no default for it (adding an `atelier init` field
was more than this change needed, t305).

- `local`: after the push (and the triage, when the landing triages), the
  command runs the required checks on the
  developer's machine in a clean clone of the pushed head, exactly as the plain
  landing does, and the server records each result as observed evidence at
  the head it reads from Artifacts (only the task's holder can record a
  check, and only at that head). Only then does the command report the
  head. The Workflow starts no container: it reads the task's evidence from
  the Ledger and judges it with `evidenceAt` (`src/rules.ts`), the gate's
  own reading, so only an observed result at exactly the pushed head counts
  (never a report, a merged run, or a run at another head; under
  `sandboxOnly`, which counts only container runs, the local mode is
  refused and points at `--checks container`). Every required check that
  applies must pass. A failing one ends the landing, recorded as a failed
  `land.check`, with the lease never taken and nothing submitted. Checks
  with no result are waited for, polling, for up to 30
  minutes (`checksTimeoutMs` on the route), and then end the landing,
  naming them. The command records the `land.check` step it ran, as the
  plain landing does.
- `container`: the Workflow runs the checks in the same CheckRunner that
  `atelier check --sandbox` starts, polling the run to its end, and records
  `land.check`. A check the container refuses (one that deploys, installs
  or pushes) ends the Workflow; land such a project without `--workflow`.
  This suits a project whose suite finishes in the container's default
  instance; Atelier's own suite does not (2026-10-08: stopped at the 600 s
  step limit, then interrupted with no result after 62 minutes), which is
  why `local` is the default.

The server records the mode with the instance (`checks` in `GET
.../landing-workflow`), so a rerun that attaches to a live landing follows
the mode it was started with. A start that names no mode, as a command
older than the modes sends, runs the checks in the container, since that
command runs none itself; against a server older than the modes the
command warns that the checks run in the container.

### Conflicts and what the Workflow protects against

A merge of main that stops on conflicts is reported as such. The Workflow,
holding no lease, pauses at stage `conflict`, naming the files, for up to a
week. The developer (or the builder, through `atelier dispatch t9 --job
merge-main`) resolves and commits them, then runs `atelier land t9
--workflow` again: the command attaches to the live instance and sends a
`resume` event, and the Workflow asks for the workspace steps in a new round, since main may have moved while it waited.

What this protects against, and what it does not:

- A closed laptop or a killed command stops only the view. The Workflow
  keeps its place, and the same command run again attaches to the live
  instance and goes on from its stage. The submission, the review wait and
  the container mode's checks proceed with no machine attached; the
  workspace steps (with the local mode's checks) and the final merge wait
  for one. The Workflow holds no lease while it waits for the workspace
  (t550). While it waits for the merge it holds the lease and renews it, so
  no other landing can merge and move main under its accepted head; a
  machine that is gone therefore holds the project until the merge wait
  times out, or until `atelier land t9 --release-lease` frees the lease,
  which ends the Workflow at its next poll with the task still accepted.
  As a second guard the server refuses the merge of a head into any main
  other than the one the landing confirmed under the lease (`main_moved`):
  merge main into the workspace and push it, which withdraws the
  acceptance, then land again.
- A transient failure of the server's own steps is retried. A failure that
  outlasts the retries ends the Workflow with the stage `failed`, the
  reason, and the lease released; run the command again to start a new
  landing.
- The push uses the workspace's write token, as in the plain landing; an
  expired token there fails the workspace step, which ends the Workflow with
  the CLI's own message.
- Timeouts: a workspace that never reports ends the Workflow after 24 hours,
  a review after one hour (both before the lease is taken), a merge after
  24 hours (with the lease released), each naming the by-hand command.
- The lease wait has a limit, `LANDING_LEASE_WAIT_LIMIT_MS` in
  `src/landing/lease-wait.ts`: three hours, measured from the time the
  server recorded the instance entering the stage `lease` (`stageAt` of its
  landing-workflow record; the same stage written again in a round keeps
  it), never from the instance's own clock. The Workflow's own wait
  (`waitTimeoutMs`) is capped at it. Its timeout names the holder the final
  ask found, read on the server at that ask, or says that no landing held
  the lease (the queue ahead stood in the way), with the server's refusal.
- An instance the server records at `lease` for the limit or longer (the
  boundary included) is not attached to: `atelier land t9 --workflow`
  terminates it, reads its status back until it has ended, and only then
  starts a replacement, which keeps the task's place in the queue (t430).
  What counts is the status read after the terminate, not the terminate's
  own answer: a terminate that throws still allows the replacement when
  the status read back afterwards confirms the instance ended (terminated,
  errored or complete), and the failed terminate is ignored. A status that
  cannot be read, or one still live after the reads, is refused with a 503
  and nothing is started, whether the terminate succeeded or failed.
- Who starts the next instance is decided in the Ledger before anything
  is created (`claimLandingWorkflow`). The instance that follows a
  remembered one, whether that one was replaced or found already ended,
  has an id derived from it, and the claim is made only while the record
  still names the old instance. So of runs at once (two replacing it, or
  one replacing it and one that finds it already terminated) exactly one
  records the successor with its review options and creates it with those
  options; the others answer that record (`created: false`), so the
  options recorded are always those of the instance created. A missing
  instance never clears a pending claim: replacement after a missing read
  requires a previously recorded ended status or a recorded terminal stage
  (`done` or `failed`). This lets purged instances recover even when no
  status was observed, including older records. Only `instance.not_found`
  from `get()` permits this recovery; an unreadable `status()` still fails
  closed. Without that evidence the request leaves the claim intact. If
  the record has no observed status, remains at `lease`, and is at least
  60 seconds old (from its server-recorded `at`), a confirmed
  `instance.not_found` from `get()` allows reconciliation: create the same
  claimed ID using its recorded checks and review options. Concurrent
  retries and a delayed original creator use that same ID; an existing-ID
  error requires a readable status before attaching. Recovery uses default
  Workflow timeouts, since custom timeouts are not recorded. Other missing
  or unreadable instances return 503. A failed create keeps the claim for
  retry, including when creation may have succeeded before the error. The
  answer and the command name the reason and the old and new instances (`replaced`), and the record keeps them.
- The record keeps the review options an instance was started with
  (`reviewer`, `noReview`), and a replacement that names none keeps them.
  Before acceptance, a run naming an eligible reviewer (another family than
  every contributor) while the remembered one is no longer eligible
  replaces the instance the same safe way; a named reviewer who is not
  eligible replaces nothing and is reported. A record with no remembered
  reviewer is not ineligible, so naming one alone does not restart it.
  Successors of already-ended instances inherit unnamed review options and
  do not inherit a historical replacement reason. A fresh start reports a
  replacement only when that request's predecessor qualifies for one.
- A replaced instance, and the command attached to it, are fenced: the
  Workflow's lease calls and the command's lease renewals name their
  instance, and the Ledger refuses them (`stale_landing`) once the record
  names another, so neither can release, renew or take the replacement's
  lease; events must name the instance they answer, and one naming a
  replaced instance is refused, so a stale report cannot advance the
  replacement. The Workflow renews (and so checks the fence) before it
  submits, requests the review and accepts.

The routes the command calls (`landing-workflow`, GET and POST) raised the
route level to 14. The Workflow is tested in workerd with the Workflows test
helpers (`test/landing-workflow.spec.ts`: the step sequence, a retry after a
transient failure, a failure that outlasts the retries, the pause on a
conflict and its resume, the local checks mode with evidence present,
arriving late, missing or untrusted, and failing, and the routes), and the
command against a stand-in server (`test/land.test.mjs`, including the
local mode's checks run after the push and before the report, and
`test/land-lease-workflow.test.mjs`: `land --workflow` against a scripted
Workflow on that server, from the start without the lease to the merge under
it). No test drives the command against a Workflow running in workerd. On
Cloudflare itself the Workflow is live: `LandingWorkflow` has landed most of
the orchestrator's tasks since 2026-10-10, run as `atelier land tN --workflow`
with the default `--checks local`.
Claim reconciliation relies on Cloudflare rejecting duplicate Workflow IDs.
The remote smoke check before and after deploy must also leave a recorded
claim without creating its instance, wait 60 seconds, then retry concurrently
with different review options: verify one instance with the claimed ID and
recorded options, and that a delayed original create cannot clear its record.
Local tests cover these races with a binding double; they do not establish
production create visibility or duplicate-ID behavior.

## Integration basis

The integrator runner merges each part onto its plan's branch as `atelier/integrator`. Their commits remain in the integration history. The tick queues a `refresh` job to merge main into the plan's branch when it moves, so later parts fork from an updated basis. For a single task, `atelier land` merges main into the task's workspace before checks run. Local verification does not establish a successful production container run.
