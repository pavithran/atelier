# Running Atelier for a project

This is the handbook for a session that runs Atelier for a project: one that
files tasks, sends them to coding agents, has their work reviewed, and lands
it for the owner. It is written from the work of 6 October 2026, when one
session landed about forty tasks on Atelier itself with agents from four
model families, and records what went wrong and what prevents it. The rules
Atelier enforces are in the README and on the `/how` page; this document is
about working within them well.

## The standing rules

`atelier guide --role orchestrate` prints these for any agent that runs a
project, whatever its company; each is explained in the sections below.

A session that drives Atelier by hand reads the project's AGENTS.md and what
its commands print, so Atelier reaches it there: `atelier status`, `ls` and
`new` end with one line naming this guide until the project's AGENTS.md states
the review path (`atelier land --reviewer`); fetching the guide does not
silence it, and a project with no checkout on this Mac always gets it.
`atelier init` offers a short AGENTS.md section that
points at it and states the review path (it does not edit the file).

- Use builders from several companies, chosen by tier, and not one company's
  models alone.
- Every protected or coordinated change is reviewed by a model from another
  company than every agent that worked on it.
- Never override a review, a check or a block, except on the owner's own
  confirmation. Ask, and cite the owner's words; never infer them.
- Judge each review finding against the code before acting, and record every
  verdict with `atelier finding`.
- File every task with its acceptance criteria, written before the build. A
  review judges the change against them, so a task without them gives the
  review nothing to bind to. Write with each criterion the edge cases it
  implies (an option left out, an empty list, a policy under which nothing
  qualifies), and have a model of another company than the orchestrator
  read the criteria before the task is dispatched. A case the criteria do not
  name is found by the reviewer instead, a round at a time: on 10 October
  one task took three review rounds and another five, each over a case the
  criteria left unstated.
- Before asking for the cross-company review, read the diff against the
  criteria yourself. Your reading does not count at the gate; it catches the
  plain misses before the expensive review does.
- Land one task at a time with `atelier land ID --reviewer H/M`, where
  `H/M` names a reviewer of another family than every contributor; the
  command merges main, checks, submits, waits for the independent review,
  then accepts and merges. Never land two together. An override while
  accepting is the owner's last resort when no reviewer qualifies, and
  never the way to land another agent's work.
- Report every run that ended without a result with `atelier run-report`.
- On a stall (a claimed task with no progress), check whether the agent's
  process still runs, then `atelier handoff` the task to another model or
  `atelier release` it. Do not start the same work twice.
- After two rejections on the same point, stop resending the task to the
  same builder: judge the findings, then hand it to a builder from another
  company or ask the owner.
- Record every judgement you make for the owner, with its reason: a finding's
  verdict (`atelier finding`), a decision (`atelier decide`), a hold released.
  Your judgements are measured like a reviewer's: a finding you refuted that
  later proves real counts against you.
- Investigate in parallel. A failing check or a large conflict can go to a
  helper agent of your own while you keep landing; do not stop the queue to
  read a log.
- Feed what you learn back into Atelier, as the last section says.

## The shape of the work

A task moves through five hands:

1. **The owner, or the session acting for the owner,** files it with
   `atelier new "title" --scope GLOB`, and reads its id from that command's
   output. Never assume the next number: another session may have filed one
   in between, and claiming the wrong id puts your work under someone else's
   task.
2. **A builder** (a model in a harness) claims it, works only in the
   workspace the claim prints, and commits there.
3. **The session** pushes, runs `atelier check`, and submits. The checks run
   in a clean clone of the exact head; what the agent says about its own
   tests is shown and never counted.
4. **A reviewer from another model family** than everyone who worked on the
   task reads the diff and approves or rejects with findings.
   A project with a review tier (`atelier init --review-tier H/M,H/M`)
   has a protected change's review asked of a tier model of another family
   first, and that one review serves both. Only when the gate's reviewer is
   outside the tier does one tier model that did not build the change
   review it as well, at the same time, whatever its family: its rejection
   sends the change back like any rejection, its approval never stands in
   for the cross-family review, and a landing never waits for it.
5. **The owner** accepts that exact revision and merges it into the
   registered checkout with `atelier merge`.

Several builders can work at once, each on its own task and fork, except on
the project's core files: the queue does not start two pieces of work whose
scopes overlap in one. Name them with `atelier init --core GLOB`, once per
glob (for Atelier: `cli/runner.mjs`, `src/ledger.ts`,
`src/dispatch/rules.ts`, the files where a dozen tasks built at once left
half the landings on merge conflicts). A dispatch whose scope overlaps a
live item's (claimed, submitted or accepted) within a core file waits in the
queue until that item merges or is abandoned; `atelier status` names the item
it waits on, and `atelier dispatch ID --overlap-ok` lets it through when the
overlap is known to be harmless. Parts of one plan never hold each other,
since the plan orders overlapping parts already. Landing is the part that
must not run in parallel.

## Starting cold

A session that takes over has no memory of the last one; everything it needs
is in Atelier, the repository and this handbook. Before dispatching anything:

1. `atelier status` for what waits for the owner, and `atelier ls --project
   P` for every live task and who holds it.
2. For each claimed task, look at its workspace: uncommitted changes, a
   `COMMIT_MSG.txt` an agent left, a merge in progress, or an agent's log in
   `.scratch/`. Check whether the agent's process still runs before starting
   the same work again.
3. Check that main type-checks and that the deployed server holds main's
   routes.
4. Read the owner's standing decisions where the project keeps them, and
   the review bar in force (`atelier init` prints it; every review brief
   states it).

Then pick up where the record says the work stands, not where a summary
says it does.

The scripts this handbook refers to are in `bin/orchestrate/`, with their
setup in its README.

## Registering workspace preparation

After deploying the Worker and updating the runner's CLI, the owner registers
Atelier's preparation policy once, from the project checkout:

```sh
atelier init --prepare "npm ci --prefer-offline --no-audit --no-fund && npm run types" \
  --prepare-input package.json --prepare-input package-lock.json \
  --prepare-input wrangler.jsonc \
  --prepare-output node_modules --prepare-output worker-configuration.d.ts
```

This is an owner rollout step; a task build does not register the project.
The runner prepares build and plan workspaces after reset and automatic
merges, before starting the harness or finishing resumed work. Manual claims
print the command and directory for the caller to run. Reviews, integration
and refresh jobs do not prepare.

The declared inputs are the manifest, lockfile and Wrangler configuration;
`src` is not an input. A cached success also depends on the command and runtime,
and both declared outputs must still exist. Once preparation succeeds, an old
validation blocker written before successful preparation no longer holds the
build back. Omit `--prepare` on later init calls to preserve the policy, or
pass `--prepare ""` to clear it.

## Reading the server's logs

The Worker writes Workers Logs (`observability` in wrangler.jsonc): every
invocation — a fetch, a queue delivery, the five-minute cron tick — and every
`console.error` it prints is kept for seven days, three on the free plan, and
can be queried after the fact. That is the first tool for diagnosing the
server, not `wrangler tail`: on 7 October 2026 the queue's timeouts had to be
caught with ninety seconds of tail by hand, and the same lines sat in the
stored logs all along. In the Cloudflare dashboard, open Workers & Pages,
select the `atelier` Worker, and open **Observability**; filter by time, by
outcome (an invocation that errored), or by message text — a task or run id,
or one of the Worker's own lines: `AI Gateway pull failed`, `Atelier plan
tick failed`, `Artifacts could not revoke a write token`. What is happening
right now can still be watched live — `wrangler tail` from a checkout of this
repository, or the dashboard's Logs → Live — but the tail shows only what
arrives while it runs; read the stored logs first.

When the queue is slow, `GET /api/queue` (and a runner's POST of the same
route) answers with a `server-timing` header — `index`, `projects`, `total`,
in milliseconds — so a slow poll can be measured while it happens.

Anything the Worker logs is kept in the account's logs, so no log may carry
a token or a key. The Worker logs error codes and messages only — the AI
Gateway token travels in the authorization header, never in a logged URL or
message (src/usage/gateway.ts) — and test/workers-logs.test.mjs fails the
suite if a `console.*` call in `src/` names one. Add logs the same way:
messages and identifiers, never a bearer token, a cookie, or a secret.

## Briefing an agent

A brief is the whole of what an agent knows. Write it so it cannot be
misread:

- Name the workspace, the task id and what is already true. Say which files
  to read first.
- State exactly what each command does when the brief mentions one. A brief
  that describes `--push` loosely will be copied into every project's
  guide loosely.
- Ask for a test that fails without the fix, and for the agent to confirm it
  does.
- A change that depends on a platform limit or runtime behaviour local tests
  cannot reproduce names it in the task, and the project declares a remote
  smoke check run before and after deploy.
- Give the task's acceptance criteria in the brief, and have them written
  before the build. On 2026-10-09 the seven ourai tasks t20 to t26, login
  security among them, were filed with none, so their reviews had nothing to
  judge against. `atelier new` now warns on a task filed without criteria, and
  `atelier init --require-criteria` refuses one for the project.
- Say what the agent must not do: push, deploy, run `atelier` against the
  real server, or touch the owner's checkout.
- Before sending one brief to many projects, pilot it on the project whose
  documents carry the most rules, and have the pilot reviewed. A fault in a
  brief is copied into every project it reaches.

## Running agents in each harness

- **opencode** (GLM, DeepSeek): give each run its own data folder
  (`XDG_DATA_HOME`) or concurrent runs deadlock on a shared database, and
  start it with standard input from `/dev/null` or it waits forever. It
  refuses any read or write outside its working folder, and a refused access
  can end the run silently with nothing changed: say in the brief that
  outside paths are refused, put any material it needs inside the
  workspace, and tell it to edit, not only read. It prints nothing until the
  run ends; watch its log file for progress.
- **Antigravity** (Gemini, GPT-OSS): in plan mode it cannot run commands,
  and an attempt returns an empty answer. Reviews therefore run in a
  throwaway clone with commands allowed and the terminal sandboxed, so the
  reviewer can search the code and run tests before it calls something a
  defect: a session runs `bin/orchestrate/review.sh`, and a home runner
  serving a review job runs `cli/agy-review.mjs`, the adapter its config
  names as the review command, which hands `agy` the brief and the diff as
  one prompt on standard input and writes its reply as the verdict.
- **Agents that write a commit message to a file** (`COMMIT_MSG.txt`) also
  stage it; check that no such file, and no `.scratch/` file, is committed.
- **A run can outlive the shell that started it.** If the session's shells
  are stopped, the agents may still be working; look for their processes
  before starting the same work again.

Count every run that ends without the asked-for result. Atelier records them
as run reports; a model that stops early often is a model to brief
differently or to use elsewhere.

## Landing, one task at a time

Every task forks from main as it was when the task was claimed. By the time
it is approved, main has usually moved, and the merge conflicts or, worse,
merges cleanly into something broken. On 6 October two tasks merged cleanly
one after the other and together broke main's type check; another pair broke
a test neither had touched.

So land one task at a time, in this order:

1. Merge main into the task's workspace. Resolve conflicts keeping both
   sides' behaviour; regenerate generated files (the CLI's help fixtures)
   from the merged code rather than merging them by hand.
2. Push and run the checks at that head.
3. Get the independent review at that head. An approval is bound to the
   revision it read; any later push, a merge of main included, needs a new
   one.
   Where the project has a tier, the server asks a qualifying tier model
   for this review first, and it serves as the tier review too. A
   `--reviewer` outside the tier gets a separate tier review alongside;
   `atelier land` waits only for the independent review, stops on a tier
   rejection, and the acceptance withdraws a tier request still open.
4. Accept and merge at once, before anything else lands.
5. Run the type check on main after every merge, and the full suite before
   pushing main to its own remotes.

`atelier land` (task t187, `cli/land.mjs`) is the default way to land a
task: `atelier land ID --reviewer H/M` does these steps under the
project's landing lease, taken on the server, so two sessions never land
at once: while one landing runs, another in the same project is refused
with who holds the lease and since when. It regenerates the project's
fixtures when its policy declares how, asks the server for the
independent review the gate needs and waits for the verdict (`--reviewer
H/M` names the reviewer, `--no-review` leaves the task submitted), then
accepts and merges. Each step and how long it took are recorded on the
task as `land.*` events, and a landing stopped partway is resumed by
running the same command again, which takes its lease back. The same
lease guards every merge, a plan's included (`POST items/tP/landing` in
`cli/atelier.mjs`). `bin/orchestrate/queue.sh` and `land.sh` are the
fallback for a session without a runner to serve the review. When the
review waits because the runners are busy (one runner works one job at a
time), the session can start a second runner (`atelier runner --name
home:NAME-2`, see "The home runner" in `bin/orchestrate/README.md`) or
review by hand.

**Report after each landing.** The report the owner gets after every landing
is `atelier status --brief`, under 20 lines: the recent merges, the commit
the server is deployed at, live builds, reviews and the landing running, and
the last 24 hours' spend against the daily limit. Give it as it prints; do
not assemble it by hand.

**Deploy when the CLI needs it.** On a machine where the CLI runs from the
project's own checkout, a merge that adds a route the CLI calls, or changes
the meaning of a route the CLI already calls, breaks every check until the
server has the new behaviour too. Each such merge raises `ROUTE_LEVEL`
(`src/route-level.ts`) by one, and `atelier land` and the home runner refuse
before they start while the server's route level (`GET /api/version`) is
older than the CLI's, naming both levels and saying to deploy. Deploy after
such merges, before landing the next task or starting a runner.

**Keep the machine's load down.** Checks run the whole suite. A dozen agents
and checks at once pushed the load average past 100 and made timing tests
fail at random; run checks one after another when the machine is busy.

## The loop with runners

This section is the procedure, step by step, as one session ran it on
10 October 2026 to land Atelier's own tasks: runners build and review, and
the session watches, chooses reviewers, lands, judges findings, resolves
what the runners cannot, deploys and publishes. Atelier always runs with an
AI in this role beside the lead developer, a frontier model such as Fable,
Opus or GPT-6 Astra; this is what that AI does all day. The steps assume
its judgement (of findings, conflicts and reviewers) but no one company's
tools: every step is an Atelier command, git, or the shell. Each step names the command and what each of its outcomes means. The
open tasks named here replace a manual step; when one merges, the step
becomes a command.

### The runners

Run one process per runner name, each as its own long-lived background job
whose output is kept in a file (`docs/runners.md` sets them up):

- build runners, one per job the machine can carry at once (four on a
  64 GB laptop): `atelier runner --name home:NAME --config
  ~/.config/atelier/runner-build.json`;
- two review runners, so one slow review does not hold every landing:
  `atelier runner --name home:NAME-rev --config ~/.config/atelier/runner-review.json`;
- one integrator for plans: `atelier runner --name home:NAME-int
  --integrate`, with the integrator's own token.

Restart a runner when:

- **the server was deployed with a change the runner's code depends on**:
  a runner keeps the code it started with (t265 makes it reload);
- **its log says `atelier/tN needs the owner's attention after 2 failures;
  skipped for this process`**: the runner will not take tN again until it
  restarts. First read the two failures above that line and fix their cause;
  restarting without a fix only repeats them;
- **a review runner has printed nothing for a long time while a review
  waits**: restart it (t351, t353). A review it had claimed may need
  `atelier review-release ID`.

To restart, stop that runner's recorded process with `kill -TERM PID`, wait
for it to exit, then repeat its original `atelier runner` command above.
A missing PID means it already exited; an error in the new process's log
means fix the configuration before retrying. Do not start a duplicate with
the same name while its old process is still alive.

Each harness's command must give agents no MCP servers or plugins, and a
build sandbox that allows the network, the package manager's cache and
localhost: a build that cannot install or run the tests is not a model's
failure. Check both whenever a harness is updated.

### Watching

Watch every runner's output and the landing queue's together, for these
lines only (t434 makes this a command):

```sh
tail -n0 -F RUNNER-OUTPUTS... | grep -E --line-buffered \
  "^LANDQ |^t[0-9]+ submitted|^runner: failed: harness|needs the owner's attention|Error loading config"
```

| Line | Meaning | Next step |
| --- | --- | --- |
| `tN submitted` | A build finished, pushed and passed its own checks | Triage its diff against every criterion, then queue its landing (below) |
| `runner: failed: harness …` | A run ended without a commit or with an error | Read the run's lines above it; `atelier run-report` if the model stopped early |
| `… needs the owner's attention after 2 failures` | The runner gave up on that task | Read both failures, fix the cause, restart the runner |
| `Error loading config` | A harness's own configuration is broken | Fix it before anything else: every run of that harness fails |
| `LANDQ tN: …` | A landing ended | See "Landing outcomes" |

`atelier status` lists dispatches waiting for a runner, with the reason each
is not being taken.

Before starting an agent in a fresh workspace on another machine, run
`npm ci` and `npm run types` there. If either fails, fix the dependency or
configuration failure before starting the agent. A stale
`.git/atelier-validation-blocked` marker strands an otherwise finished build:
read it with `cat .git/atelier-validation-blocked`, fix the reported cause,
run `npm test` and `npm run typecheck`, then remove the stale marker with
`rm .git/atelier-validation-blocked` only after both pass and retry
`atelier finish`. A remaining failure stays blocked.

### Choosing a reviewer

Before queueing, read `atelier show tN` and, in the task workspace,
`git fetch origin main` then `git diff origin/main...HEAD`. Triage the diff
against each acceptance criterion. Missing behaviour goes back to the
builder with `atelier dispatch tN --to home --agent A --model M --note "…"`;
a complete diff proceeds to independent review. A criterion the builder
cannot verify, such as a signed-in browser flow, belongs to the orchestrator
after deploy: record that check and do not claim it passed from local tests.

The reviewer must be of another company than every contributor to the task,
not only its last builder: `atelier show tN` names who worked on it, and the
task's history may include an earlier builder or a session that fixed a
conflict. Among qualifying reviewers, alternate between companies so that
no one reviewer's queue holds every landing. A reviewer that has rejected
the same task several rounds running is still the right reviewer; see
"Judging a review".

### The landing queue

`bin/orchestrate/land-queue.sh` lands tasks one after another, waiting for
the machine's load to fall under 25 before each, and prints one `LANDQ tN:`
line per landing. After a successful merge it synchronously runs
`bin/orchestrate/post-merge.sh tN`; the next task stays queued until that
step checks main, deploys and publishes successfully. Start it once from the project's checkout as a long-lived
background job, then add each submitted task with `--add`:

```sh
bin/orchestrate/land-queue.sh            # once, in the background
bin/orchestrate/land-queue.sh --add t405:codex/gpt-6-astra
```

`--add` takes the queue's lock (the directory `atelier.queue.lock` beside the
queue file), as the queue does when it takes the first line, so an addition
made while a landing is being taken off the queue is never lost. A bare
`echo … >>` does not take the lock and can be lost; do not use it. The queue
prints `LANDQ tN: …` for each landing and, once nothing has been queued for
two hours, `LANDQ idle: …` and exits: start it again then.

Order the queue so the tasks that touch core files land first: everything
else will merge around them, and a core-file change landed late conflicts
with every task that landed before it. Within that, put first the tasks that
another piece of work waits on. To reorder it, hold the lock while you edit the queue file:
`mkdir "$ATELIER_CACHE/land-queue/atelier.queue.lock"`, edit, then `rmdir` it.

Do not chain landings by having a shell wait on `pgrep -f "… tN"`: the
waiting shell's own command line contains the pattern, so `pgrep` finds the
waiter itself and it waits forever. On 10 October two landings sat for fifty
minutes that way. If a wait on a process is unavoidable, write the pattern so
it cannot match itself (`pgrep -f "land-queue.sh t40[5]"`). t408 replaces
these waits with a command.

A failed post-merge step prints `LANDQ tN: post-merge blocked` and exits
nonzero. Read `$ATELIER_CACHE/land-queue/atelier.queue.post-merge` for the
pending task and `$ATELIER_CACHE/land-queue/tN.post-merge.log` for the error.
Fix it and restart `bin/orchestrate/land-queue.sh`; it retries that step
before consuming any task, even after a process restart. Do not delete the
marker or requeue the already merged task. `post-merge complete` means the
barrier cleared. `LAND_QUEUE_POST_MERGE=/absolute/path/to/hook` may replace
the step only with an executable that performs all the same operations;
zero means they all finished, any other status holds the queue.

### Landing outcomes

| `LANDQ tN:` says | What happened | Next step |
| --- | --- | --- |
| `tN landed through the landing Workflow` | Merged on main | "After each merge" |
| `paused at its conflict stage` | Main has moved and the merge conflicts | "Conflicts" |
| `… rejected tN at SHA: …` | The reviewer asked for changes | "Judging a review" |
| `… route level N, this CLI route level N+1` | A merge raised `ROUTE_LEVEL` and the server is older | Deploy, then queue the task again |
| `the landing lease was not tN's within 3 hours` | The landing reattached to an old Workflow run that had been waiting for the lease and has now timed out (t430) | Queue the task again: the next landing starts a fresh run |
| `FAIL … npm test @ SHA` | The checks failed in a clean clone at the merged head, or ran out of time (`check exceeded its time limit` in the landing's output) | If it timed out, the machine was too loaded: lower the load, or raise `ATELIER_CHECK_TIMEOUT` for the landing, and queue it again. Otherwise run the suite in the task's workspace, keeping the whole output, to name the failing test; then send it back or fix it |

### Conflicts

In the task's workspace, `git diff --name-only --diff-filter=U` lists the
conflicting files.

- **A mechanical conflict**, however many files it spans, is resolved by the
  orchestrator: two sides each adding entries to help or usage text, an
  import list, a table or a registry, and generated fixtures (regenerate them
  from the merged code). Keep both sides, run the type check and the tests of
  the files touched, commit the merge with your own `Agent:` line, push with
  `atelier push --as H/M` from the workspace, and queue the landing again.
  The commit makes you a contributor, so the reviewer must be of another
  company than you as well as the builder.
- **A conflict that changes behaviour** (two sides changing the same logic): `git merge --abort` in the workspace, then send it
  back to its builder:
  `atelier dispatch tN --job merge-main --to home --agent A --model M --overlap-ok`.
  For a task with many conflicting files in core code, name the strongest
  builder available rather than the original one.

A task built before a code move is ported by its builder, even if Git can
merge it cleanly: dispatch `atelier dispatch tN --job merge-main --to home
--agent A --model M --overlap-ok` and wait for the builder's port and checks
before queueing it again. Moving paths is not a mechanical resolution when
imports, registries or behaviour need adapting.

The same files conflict almost every time on Atelier: `cli/atelier.mjs`,
`src/usage.ts`, `src/ledger.ts` and the CLI's help and usage fixtures. A
merge-main job merges main as it is when a runner claims it (t429), so the
job needs no redispatch to pick up a newer main.

A build job, a fix after findings included, submits the head it built on
the fork's old base without merging main first, so on 10 October nearly
every resubmitted task stopped at the conflict stage and cost a further
round; t435 has the runner merge main before submitting.

### Held dispatches

Scope each task as narrowly as the change allows. A scope of `src/**`
reaches every core file, so the task is held behind any live task in any of
them: on 10 October twelve tasks filed with broad scopes all waited on one
task, while a second machine's runners sat idle.

When runners sit idle, read `atelier queue` first: held dispatches are work
waiting on scope overlaps, not an empty backlog. If none are held, use
`atelier status` to check runner eligibility and health.

`atelier status` shows `Held: waits on tX … both scopes reach core file F`
for a dispatch whose scope overlaps a live task's in a core file. Check that
tX is really moving (its workspace's last commit, an agent process in it). If
tX is stuck, fix tX first. If many tasks wait on one, release the few that
matter most with `atelier dispatch tN --overlap-ok`, not all of them: tasks
released together into the same core file mostly conflict with each other at
landing.

### After each merge

The queue runs `bin/orchestrate/post-merge.sh tN` in the project checkout
and waits for it. It requires a clean `main`, pulls with `--ff-only`, runs
`npm run typecheck` and `npm test`,
deploys, audits outgoing history and publishes. Any failed command stops it
and holds the next landing. The steps below explain those operations and
manual diagnosis; never start a second queue while this barrier is pending.
The script runs the full suite in the clean checkout; a clean clone below
can reproduce failures independently.

For a task whose platform/runtime behaviour needs a remote smoke check, set
`POST_MERGE_SMOKE=/absolute/path/to/check`; the executable receives `before`
and `after` around deployment and must return zero for each. A failure
holds the queue. Include the orchestrator's signed-in browser criterion in
that verification after deployment; a local pass cannot stand in for it.

1. Update and type check:

   ```sh
   PREVIOUS=$(git rev-parse HEAD)
   git pull --ff-only
   npm run typecheck
   ```

   `git pull` failing as not fast-forward means the checkout holds a commit
   main does not: stop and find it. A type error is a break on main: name the
   task whose merge caused it (`git log $PREVIOUS..HEAD`) and send it back.
2. Check main's full suite in a clean clone, with the whole output kept so a
   failure can be named:

   ```sh
   rm -rf /tmp/main-check; git clone -q . /tmp/main-check
   (cd /tmp/main-check && npm ci && npm test) > /tmp/main-check.log 2>&1; echo $?
   ```

   `0`: main is good, go on. Non-zero: do not deploy. Find the failing test
   in the log and run it a second time; a failure that does not repeat is a
   flaky test to file, one that repeats is a break on main to send back to
   the task that caused it.
3. Deploy once the suite passes (the owner's decision d6: landed changes are
   deployed after main's full suite passes, not only when `ROUTE_LEVEL`
   rises):

   ```sh
   git diff $PREVIOUS HEAD -- src/route-level.ts
   npm run deploy
   ```

   The diff shows whether `ROUTE_LEVEL` rose; if it did, queue again every
   landing refused on route level once the deploy is done. `npm run deploy`
   does not run tests, which is why step 2 comes first. If it fails, report
   the error and queue no landing that needs the new route.
4. Publish main to the public mirror once it is checked (t433 makes this a
   command). Name the mirror's remote `public` (`git remote -v` lists them;
   `git remote add public URL` once) and run:

   ```sh
   : "${NOREPLY:?Set the recorded public no-reply address}"
   git fetch public
   # a. every new commit's author and committer address must be the public
   #    no-reply address; this prints the ones that are not
   git log --format='%H %ae %ce' public/main..HEAD | awk -v expected="$NOREPLY" '$2 != expected || $3 != expected'
   # b. inspect every outgoing commit, including additions later removed
   git log -p -m --root --format=fuller --binary public/main..HEAD | grep -E '^\+' | grep -iE 'api[_-]?key|token|secret|password|PRIVATE KEY|sk-[A-Za-z0-9]{20,}|([0-9]{1,3}\.){3}[0-9]{1,3}|@[a-z0-9-]+\.[a-z]{2,}'
   # c. private paths must not appear in any outgoing commit
   git log --name-only -m --root --format= public/main..HEAD | grep -E '^(PROJECT|AGENTS)\.md$|^\.env'
   # d. read all outgoing metadata, messages and patches too; pattern scans
   #    only flag candidates and cannot prove prose or binary assets public
   git log -p -m --root --format=fuller --binary public/main..HEAD
   # after every candidate is cleared, let the pending post-merge step push
   export PUBLIC_AUDIT_HEAD=$(git rev-parse HEAD)
   bin/orchestrate/land-queue.sh
   ```

   `NOREPLY` is the public no-reply address, read from the project's
   recorded decisions (`atelier guide --role orchestrate`). An unset or empty `NOREPLY` is a stop, never a pass.
   Compare author and committer separately with exact equality: either
   private address holds publication. Output from a: those commits must be rewritten
   before they are published, so send their task back. Output from b: read
   each line; a test fixture or a documented placeholder is fine, a real
   value goes back to its task. Output from c: the file must be removed from every outgoing
   commit that contains it. Deleting it at the tip does not remove it from
   published history. Stop publication and coordinate history repair with
   the owner; do not rewrite shared main casually. Re-audit the entire
   outgoing range after any repair. The `-m --root` scans include merge
   changes and initial commits. Review commit messages, metadata and binary
   files as well as added lines for private details, including spend figures.
   Any unresolved candidate holds the push.

   The script saves addresses, paths and the full patch under
   `$(git rev-parse --git-path public-audit)` and stops until
   `PUBLIC_AUDIT_HEAD` names the exact audited head. Setting it acknowledges
   that human inspection; it cannot bypass bad addresses or private paths.
   On restart, the pending step repeats checks and deployment before pushing;
   it takes the next task only after the push succeeds. If the push is rejected as
   non-fast-forward, the mirror has a commit main does not: fetch, find it,
   and never force the push.
5. Report to the lead developer: what merged, what was deployed, what is
   landing and what went back.

## Judging a review

A reviewer's finding is a claim about the code, and it can be wrong. On
6 October about half of one reviewer's blocking findings did not hold: code
it could not see, a language feature it thought missing, a decision by the
owner it read as a defect. The other half were real, and some were serious.

- Check each blocking finding against the code before acting on it.
- When it holds, fix it in a new commit with a test that fails without the
  fix, and send the task back to the same reviewer.
- When it does not, say why in the review's context, with the file and line
  that show it, and ask for the review again. Do not override the review
  quietly, and never let a reviewer overrule the owner's decision.
- A rejection is bound to the revision it read. Another reviewer's approval
  of the same revision does not clear it: the gate still sees a reviewer who
  asked for changes with no push since. So a refuted finding is answered
  either by the same reviewer reading the refutation, or by a new push. When
  one reviewer rejects the same task round after round on narrower and
  narrower points, a small change that meets the point usually costs less
  than another round; the refutation stays on the record either way.
- When a confirmed finding names a case the criteria did not state, add the
  case to the criteria (`atelier edit tN --accept "…"`, all criteria
  restated) before sending the task back, so the review that follows, and the
  next task like it, start with the case written down.
- Read a review's findings with `atelier show tN --json` (the `reviews`
  list, each with its `head` and `findings`); the text summary shortens them.
  Send a confirmed finding back with
  `atelier dispatch tN --to home --agent A --model M --note "…"`, naming in
  the note exactly what to change and what not to.
- Record the verdict on each finding (`atelier finding`, task t186). Which
  reviewers are right, and how often, is the most useful thing Atelier can
  measure about them. The next review brief shows each verdict and its note,
  so put the file and line that answer a refuted finding in the note.

## Keeping the record honest

- The task's holder is who the ledger says did the work. Before another
  model works on a task, hand it off (`atelier handoff`). The project owner
  can send an accepted task back to building with `atelier handoff ID --to H/M`
  or `atelier dispatch ID --job merge-main` after a merge conflict. The earlier
  reviews and acceptance stay in the history; the new revision is submitted,
  reviewed and accepted again. A merge holding the landing lease must finish
  or be cancelled first. Plans use `atelier plan refresh ID` instead.
- Every commit carries an `Agent:` line naming who wrote it.
- When a closing note turns out to be wrong, say so where the record can
  hold it; never leave a false statement standing.
- Close bundled tasks against the task they landed in, naming its merge.

## Feeding what you learn back into Atelier

A session that learns something and keeps it in its own notes has taught the
next session nothing. Each kind of lesson has a place in Atelier:

- **A judgement about a model** (a review finding right or wrong, a run that
  stopped early): record it with `atelier finding` or `atelier run-report`,
  so the Models page compares models on every project's evidence.
- **A workaround** (a script, a manual step, a check done by hand): it is a
  missing feature. File it as a task on the atelier project, naming what
  the workaround does; `atelier land` began as such a script.
- **A rule about how to work** (a failure and what prevents it): change this
  handbook through a task, so the change is reviewed like code.
- **A decision by the owner**: record it where the project keeps its
  decisions and cite the owner's words; never infer one.

## What to record

Atelier records what passes through it: claims, pushes, observed checks,
submissions, reviews with their findings, handoffs, acceptances, merges and
run reports. Work done outside it is invisible. When you judge a finding,
resolve a conflict, or watch a run fail, record it, so the comparison
between models grows from every project and not only from the sessions that
remember to write it down.
