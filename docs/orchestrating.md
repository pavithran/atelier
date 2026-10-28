# Running Atelier for a project

The cross-company rules below describe the default policy. With
`atelier init --single-family COMPANY`, building and reviewing use only that
company's models: a reviewer must be a different model from every contributor,
never a contributor under another harness. This exception also applies to
criteria review, handoffs and conflict contributors. Only that company's tier
models qualify; if none qualifies, no separate tier review is requested.
`atelier init --cross-family` restores the default; both switches record who
made them and when. See [Single-family mode](gate.md#single-family-mode).

This is the handbook for a session that runs Atelier for a project: one that
files tasks, sends them to coding agents, has their work reviewed, and lands
it for the developer. It is written from the work of 6 October 2026, when one
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

- By default use builders from several companies, chosen by tier. In
  single-family mode use only the selected company's models.
- Every protected or coordinated change is reviewed by a model from another
  company than every agent that worked on it; in single-family mode, only a
  different model of the selected company from every contributor counts.
- Never override a review, a check or a block, except on the developer's own
  confirmation. Ask, and cite the developer's words; never infer them.
- Judge each review finding against the code before acting, and record every
  verdict with `atelier finding ... --as H/M`, naming yourself, as you name
  yourself on `atelier decide`, `atelier decisions withdraw` and on an
  override: the Models page measures your verdicts as it measures a
  reviewer's. Without `--as` the record cannot tell you from the developer, and
  the page counts the judgement as unknown.
- File every task with its acceptance criteria, written before the build. A
  review judges the change against them, so a task without them gives the
  review nothing to bind to. Write with each criterion the edge cases it
  implies (an option left out, an empty list, a policy under which nothing
  qualifies), and have a model of another company than the orchestrator
  read the criteria before the task is dispatched. A case the criteria do not
  name is found by the reviewer instead, a round at a time: on 10 October
  one task took three review rounds and another five, each over a case the
  criteria left unstated.
- When a criterion requires that every path be guarded (every write of an
  developer, every call that needs a check), ask for a runtime boundary, never
  for a test that scans the source for the paths. Ask for one guarded entry
  point that does the write and checks the guard, and for the low-level
  write to refuse any call that does not come through it, tested by calling
  the low-level write directly. A text scan can never prove that no path is
  missed. t389's criterion 4 said "a test enumerates those paths and fails
  if one is added without the check"; gpt-6-astra rejected it ten times from
  9 to 12 October, each time over an assignment path the checks missed, and
  the last two over developer writes the builder's scanner of regular
  expressions missed (the last was
  `const fields = { owner: to }; this.update(id, fields, at)`).
- Before asking for the independent review, read the diff against the
  criteria yourself. Your reading does not count at the gate; it catches the
  plain misses before the expensive review does.
- Land with `atelier land ID --reviewer H/M`, where `H/M` names a reviewer
  of another family than every contributor; the command merges main, checks,
  submits, waits for the independent review, then accepts and merges. When no
  live runner offers that reviewer, the landing runs a one-shot review on this
  Mac: it claims the request and runs the reviewer's model from this Mac's
  runner config, so the reviewer records its own verdict under its own token,
  never you under its name. A model missing from the config is named and the
  landing stops with the request open; a same-family reviewer is refused as
  before; the one-shot runner exits after one verdict and holds no claim. Land a
  wave with `atelier land ID ID…`, which runs several of these side by
  side, up to `--parallel N`, while the project's landing lease lets one
  merge into main at a time. An override while accepting is the developer's
  last resort when no reviewer qualifies, and never the way to land another
  agent's work.
- Report every run that ended without a result with `atelier run-report`.
- On a stall (a claimed task with no progress), check whether the agent's
  process still runs, then `atelier handoff` the task to another model or
  `atelier release` it. Do not start the same work twice.
- After two rejections on the same point, stop resending the task to the
  same builder: judge the findings, then hand it to a builder from another
  company or ask the developer.
- Record every judgement you make for the developer, with its reason: a finding's
  verdict (`atelier finding`), a decision (`atelier decide`), a hold released.
  Your judgements are measured like a reviewer's: a finding you refuted that
  later proves real counts against you.
- Investigate in parallel. A failing check or a large conflict can go to a
  helper agent of your own while you keep landing; do not stop the queue to
  read a log.
- Feed what you learn back into Atelier, as the last section says.

## The shape of the work

A task moves through five hands:

1. **The developer, or the session acting for the developer,** files it with
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
   review it as well, at the same time, whatever its family in the default mode (only the selected company in single-family mode): its rejection
   sends the change back like any rejection, its approval never stands in
   for the cross-family review, and a landing never waits for it.
5. **The developer** accepts that exact revision and merges it into the
   registered checkout with `atelier merge`.

Several builders can work at once, each on its own task and fork, except on
the project's core files: the queue does not start two pieces of work whose
scopes overlap in one. Name them with `atelier init --core GLOB`, once per
glob (for Atelier: `cli/runner.mjs`, `src/ledger.ts`,
`src/dispatch/rules.ts`, the files where a dozen tasks built at once left
half the landings on merge conflicts). A dispatch whose scope overlaps,
within a core file, a claimed item's or that of the item a live landing
lease names waits in the queue until each claimed blocker submits or is
released and each landing ends; a submitted or accepted item that is not
landing holds nothing. `atelier status` names every item it waits on, and `atelier dispatch ID --overlap-ok` lets it through when the
overlap is known to be harmless. Parts of one plan never hold each other,
since the plan orders overlapping parts already. Landings run beside one
another (a wave's `--parallel` bounds how many), but merges into main take the
project's landing lease one at a time ("Landing a wave" below).

## Starting cold

A session that takes over has no memory of the last one; everything it needs
is in Atelier, the repository and this handbook. Before dispatching anything:

1. `atelier status` for what waits for the developer, and `atelier ls --project
   P` for every live task and who holds it.
2. For each claimed task, look at its workspace: uncommitted changes, a
   `COMMIT_MSG.txt` an agent left, a merge in progress, or an agent's log in
   `.scratch/`. Check whether the agent's process still runs before starting
   the same work again: `atelier status` ends with the runners and agent
   processes live on this Mac, by task, with no command lines.
3. Check that main type-checks and that the deployed server holds main's
   routes.
4. Read the developer's standing decisions where the project keeps them, and
   the review bar in force (`atelier init` prints it; every review brief
   states it).

Then pick up where the record says the work stands, not where a summary
says it does.

The scripts this handbook refers to are in `bin/orchestrate/`, with their
setup in its README.

## The handover

Every turn of an orchestrating session resends what it read at the start, so
what a session reads at the start is kept small. The note one session leaves
the next, wherever the orchestrator keeps it, holds only what Atelier cannot
tell the next session:

- **Decisions still open.** Each with the question, what the developer has
  said so far, and what the session recommends. A decision the developer has
  settled is recorded with `atelier decide`, listed by `atelier decisions`,
  and leaves the note.
- **Work in flight that Atelier does not record.** A suite, deploy or push to
  the public mirror started outside Atelier (see What stays outside Atelier),
  a process still running, a promise made to the developer. Each with how to
  check it and what to do when it ends.

It does not hold what Atelier already holds, and the next session reads those
from the source, never from the note:

- Task states, holders, reviews and findings: `atelier status` and `atelier ls
  --project P`, and `atelier show ID` for one task.
- Merges: `atelier status --brief` lists the recent ones; the ledger is the
  record.
- The deployed commit: `GET /api/version`, not the ledger and not the note.
  Whether it matches main is the next session's to check.

A note that restates the ledger goes stale the moment a task moves, and the
session that trusts it dispatches on a state that no longer holds. When the
note and Atelier disagree, Atelier is right; correct the note.

When the note outgrows one screen, the decisions it holds have usually been
settled, or the in-flight work has ended. Settle or record them, and move the
older sections to an archive that no session reads at the start. Standing
decisions are kept as `atelier decide` entries, summarised where a later one
supersedes an earlier one. Changing the orchestrator's own skill folder and
moving old sections to the archive happen outside this repository; this
section states the shape they aim for.

The same care applies to the briefs Atelier composes. The fixed instruction
blocks of the build and review briefs, the build rules, the builder's test
instructions and the review rules, are capped in UTF-8 bytes in
`test/brief-rules.test.mjs`. Beside each cap are the commit the size was
measured at, the measured size and the margin. The cap leaves out the task's
text, the diff and the findings, which vary with the work. A change that
grows a block past its cap fails there; raising the cap is a decision made in
that file, with the new measurement.

## Registering workspace preparation

After deploying the Worker and updating the runner's CLI, the developer registers
Atelier's preparation policy once, from the project checkout:

```sh
atelier init --prepare "npm ci --prefer-offline --no-audit --no-fund && npm run types" \
  --prepare-input package.json --prepare-input package-lock.json \
  --prepare-input wrangler.jsonc \
  --prepare-output node_modules --prepare-output worker-configuration.d.ts
```

This is a developer rollout step; a task build does not register the project.
The runner prepares build and plan workspaces after reset and automatic
merges, before starting the harness or finishing resumed work. Manual claims
print the command and directory for the caller to run. Reviews, integration
and refresh jobs do not run that preparation policy. Before a code reviewer
starts, the runner links available Node dependencies from the task workspace
into the review clone, including nested packages. Otherwise it installs
package dependencies on the host, using npm ci when a lockfile exists.
The reviewer’s sandbox remains read-only.

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

When only the Worker's errors matter, the developer runs `atelier server-errors
[--minutes N]` from a checkout of this repository. It tails the Worker
(`wrangler tail --format json`) for N minutes, 2 by default, and prints one
line for each event that logged an error or threw: its time, method, path and
error text. It never prints a header, a query string or a body. It sees only
what arrives while it runs, so it sits beside the dashboard, not in place of it.

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
- Before dispatch, run each "existing tests pass" criterion against the change
  the task asks for, and name any test the change must rewrite. The criterion
  is binding on the builder, so one that the fix itself falsifies sends the
  builder to choose between the criterion and the fix. hqpe-control t54 was
  filed with "t52's tests pass unchanged" while its own fix made one t52 test
  (the 3x ratio, with only the Nx filter) wrong by design; reading the test
  before dispatch caught it, and nothing else would have. Write "t52's tests
  pass except the 3x ratio test, which the task rewrites" instead.
- A builder runs the project's full required test command (`npm test`)
  inside a test slot and pushes only when it passes (t219). Failures found
  only in the clean clone cost a rebuilt run each, about an hour; goal 1's six
  tasks took about 300 builder runs. The suite's time budget counts from slot
  acquisition, so queueing cannot time it out; on a timeout the builder commits
  and reports `validation_blocked` with the slot wait and run time. A merge's
  resolution and a wave's checks run whole as before. A project that names
  another test command in its own instructions (`AGENTS.md`) has the builder
  run that one. For a visual
  change the build brief says to use the project's documented screenshot
  workflow against the workspace's own revision, reusing the server that
  workflow manages and never starting a second, or to follow the project's
  setup when it documents none; review briefs do not say it. In ikon-weblog on
  2026-10-15 and 16 builders ran the full gate after small edits and opened dev
  servers of their own for screenshots, which multiplied wall time.
- Say what the agent must not do: push, deploy, run `atelier` against the
  real server, or touch the developer's checkout.
- Point the agent to the project's prose standard, the path `atelier init
  --prose-standard` records (Atelier's is
  `../ai-projects-house-style/house-style.md`), and have it load the standard
  before it writes commit messages, comments, docs or its report. Every
  brief Atelier composes for a build, a plan or a review names it, and so do
  `atelier show` and `bin/orchestrate/review.sh`; a brief written by hand
  names it the same way.
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

## Landing

Every task forks from main as it was when the task was claimed. By the time
it is approved, main has usually moved, and the merge conflicts or, worse,
merges cleanly into something broken. On 6 October two tasks merged cleanly
one after the other and together broke main's type check; another pair broke
a test neither had touched.

So every landing does these steps in this order, and only one task merges
into main at a time:

1. Merge main into the task's workspace. Resolve conflicts keeping both
   sides' behaviour; regenerate generated files (the CLI's help fixtures)
   from the merged code rather than merging them by hand.
2. Push and run the checks at that head.
3. Get the independent review at that head. An approval is bound to the
   revision it read; any later push, a merge of main included, needs a new
   one.
   Where the project has a tier, the server asks a qualifying tier model
   for this review first, and it serves as the tier review too. A
   `--reviewer` outside the tier gets a separate tier review alongside only
   when a tier model qualifies under the family policy;
   `atelier land` waits only for the independent review, stops on a tier
   rejection, and the acceptance withdraws a tier request still open.
4. Accept and merge under the landing lease, so that nothing else merges
   between the check that main has not moved and the merge.
5. Run the type check on main after every merge, and the full suite before
   pushing main to its own remotes. These two steps stay outside
   `atelier land` ("What stays outside Atelier" below).

`atelier land` (task t187, `cli/land.mjs`) is the default way to land a
task: `atelier land ID --reviewer H/M` does these steps. Since t550 it
merges main, regenerates the project's fixtures when its policy declares
how, pushes, runs the checks, submits, asks the server for the
independent review the gate needs and waits for the verdict (`--reviewer
H/M` names the reviewer, `--no-review` leaves the task submitted) without
the project's landing lease, beside any other task's landing. Only once
the head is checked and approved does it take the lease, for the merge
alone, so two sessions never merge at once: a second landing that reaches
that point queues behind the first and merges in its turn. Under the
lease it confirms main is still the commit the head was checked and
reviewed against (if not, it releases the lease and goes round again from
the merge of main), then accepts and merges. Each step and how long it
took are recorded on the task as `land.*` events, and a landing stopped
partway is resumed by running the same command again. `atelier land`
does not push commits that exist only in the task's workspace: a builder
dispatched by hand (a script that runs an agent which commits but holds no
token to push) leaves its work unpushed, and an orchestrator's own fix
committed in the workspace is work the ledger has not seen. Landing stops
before the lease with "holds N commits the recorded head lacks" and
changes nothing. Run `atelier push` in the workspace first, then land;
the push is a deliberate step so that nothing reaches review unseen. The same
lease guards every merge, a plan's included (`POST items/tP/landing` in
`cli/atelier.mjs`). To wait on a landing, a runner's build or an agent, use
`atelier wait ID` (`cli/wait.mjs`), never a hand-written `pgrep` or `lsof`
loop, which matches its own command line and cannot see a death:
`--for merged` (the default) ends when the task merges, `--for submitted`
when its agent submits, `--for reviewed` when a review is recorded at its
head and current acceptance criteria, and `--for any-change` at the first
change of state, head, holder or review count. It prints one line and exits 0 when reached, 1 when the task
failed (abandoned, blocked, or rejected in review), 3 at `--timeout`, 4 when
the task cannot be read. A task whose agent died stays claimed, so pair a
long wait with `--timeout` and look at `atelier status` when it ends.
When the
review waits because the runners are busy (one runner works one job at a
time), the session can start a second runner (`atelier runner --name
home:NAME-2`, see "The home runner" in `bin/orchestrate/README.md`) or
review by hand.

A request for an admitted reviewer is refused `no_runner` while no live runner offers the review job for it. When the developer will serve the review by hand, open the request with `atelier review-request ID --reviewer H/M --hand`: it skips that one check (every other check on the reviewer stands), needs no runner and no agent token for the reviewer, and the claim below then serves it (t694).

A runner is offered the oldest review request it can serve, whatever older ones it cannot; a request whose reviewer no live runner offers for 15 minutes shows in `atelier stuck` as `review-unoffered`: reroute it with `atelier review-request ID --reviewer H/M` to a reviewer a live runner offers, or withdraw it with `atelier review-withdraw ID --reason TEXT` (t220).

The stage tick reroutes a queued dispatch no live runner offers, or one left unclaimed 10 minutes, once to a model a live runner offers (`stage.rerouted`), and replaces a task fork preparing over 30 minutes with no commit recorded twice, under new names; a third miss is `stage.told`, and `atelier stuck` lists the task with its fork names, ages and the way out: `atelier release ID`, then `atelier start ID --as H/M`, which starts the count of replacement forks again and keeps the task's history (t245, t254, t378).

The tick also releases a review claim unanswered for 2 hours (`reviewAnswerHours`) and asks again once per task and head (`stage.retried`); the next stale claim at that head is `stage.told`. A checked task whose review request stays unclaimed 10 minutes moves once to another reviewer a live runner offers, of another family than every contributor (`stage.rerouted`); with none, it is `stage.stuck` and `stage.told` (t225).

The stage tick queues one land job (`stage.land-queued`), keyed by task and head, for a task left landable over 5 minutes that is accepted or in a project in fast mode, with no landing lease held. A lease lapsed for 15 minutes queues it again; main moving queues it again at most twice. A landable task not yet accepted is `stage.told` naming `atelier accept`, and with no live runner that lists `land` and holds the checkout it is `stage.stuck` and `stage.told` (t253).

To serve a review by hand, claim it as the reviewer with `atelier
review-claim ID --as HARNESS/MODEL`. Besides its JSON, the claim prints the
request number, the head, the criteria binding and the exact command that
records the verdict, `atelier review ID --head SHA --request N --criteria
BINDING --approve|--reject --note "…" --as HARNESS/MODEL`; run that command
as printed. The claim's lease lasts 5 minutes, as a runner's does, and a
reviewer that outlasts it loses the claim and its verdict is refused (t573's
review, on 2026-10-13, ran about 6 minutes). While the review runs, renew
the lease every 2 minutes with `atelier review-claim ID --renew --as
HARNESS/MODEL`, naming the reviewer that claimed it, which uses the route a
runner renews with. The server skips a renewal within 30 seconds of the
last, so a renewal is sure of 4 minutes 30 seconds, not 5. This machine
remembers the request it last claimed for the task, so `--renew` and
`atelier review` without `--request` both use that request, and `review`
names it; it does not remember the reviewer, so each still needs `--as`.

**Report after each landing.** The report the developer gets after every landing
is `atelier status --brief`, under 20 lines: the recent merges, the commit
the server is deployed at, live builds, reviews and the landing running, and
the last 24 hours' spend against the daily limit. Give it as it prints; do
not assemble it by hand.

**Deploy when the CLI needs it.** On a machine where the CLI runs from the
project's own checkout, a merge that adds a route the CLI calls, or changes
the meaning of a route the CLI already calls, breaks every check until the
server has the new behaviour too. Such a merge declares a named capability
(below), and `atelier land`, every command that needs it and the home runner
refuse before they start while the server (`GET /api/version`) lacks it,
naming the missing capability and saying to deploy. Deploy after such
merges, before landing the next task or starting a runner.

Since t458 they check named capabilities instead: each command declares what
it needs in its module (`capabilities` in `src/usage/commands/NAME.ts`, or
under one of its `subcommands`), each runner job in `JOB_CAPABILITIES`
(`src/route-level.ts`), the server lists what it supports in `capabilities`
beside `routeLevel`, and every command that declares some is refused before
its first request while the server lacks one, naming the missing
capabilities, the server's revision and the deploy to run; the runner
refuses the same way before its first poll, for the jobs it offers. A change
that adds API behaviour a command relies on declares a new capability on a
line of its own under its family in `src/route-level.ts` and names it in
that command's module, or in the job's row; a command that names one the
file does not declare fails to load, naming the module. An incompatible
change takes a new name (`…v2`). Do not raise `ROUTE_LEVEL`: it is frozen
(t522) and published only for clients and servers that predate
capabilities, as [Landing](landing.md) says; a new declaration has no
level, and `test/capabilities.test.mjs` pins the frozen number.

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

- **its checkout is behind the deploy**: an idle runner reloads itself in
  place once its checkout holds the deployed commit (t265), and says once in
  its log when the checkout is behind; update the checkout (the post-merge
  steps do on this Mac and the Studio) rather than restarting. A reload
  starts a fresh process, which forgets the tasks it gave up on;
- **its log says `atelier/tN needs the developer's attention after 2 failures;
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

Watch every runner's output, and the output of the `atelier land` command you
started (kept in a file), together, for these lines only (t434 makes this a
command):

```sh
tail -n0 -F RUNNER-OUTPUTS... LAND-OUTPUT... | grep -E --line-buffered \
  "^t[0-9]+ (landed|failed)|^t[0-9]+ submitted|^runner: failed: harness|needs the owner's attention|Error loading config"
```

| Line | Meaning | Next step |
| --- | --- | --- |
| `tN submitted` | A build finished, pushed and passed its own checks | Triage its diff against every criterion, then land it (below) |
| `runner: failed: harness …` | A run ended without a commit or with an error | Read the run's lines above it; `atelier run-report` if the model stopped early |
| `… needs the owner's attention after 2 failures` | The runner gave up on that task | Read both failures, fix the cause, restart the runner |
| `Error loading config` | A harness's own configuration is broken | Fix it before anything else: every run of that harness fails |
| `tN landed.` or `tN failed (…)` | One landing of a wave ended | See "Landing outcomes" |

`atelier status` lists dispatches waiting for a runner, with the reason each
is not being taken.

A stuck episode still open an hour after it was first seen reaches the
developer in `NTFY_TOPIC` messages per project (a large batch is split into several), once per episode; a
recurrence after it cleared is told again.

Before starting an agent in a fresh workspace on another machine, run
`npm ci` and `npm run types` there. If either fails, fix the dependency or
configuration failure before starting the agent. A stale
`.git/atelier-validation-blocked` marker strands an otherwise finished build:
read it with `cat .git/atelier-validation-blocked`, fix the reported cause,
run `npm test` and `npm run typecheck`, then remove the stale marker with
`rm .git/atelier-validation-blocked` only after both pass and retry
`atelier finish`. A remaining failure stays blocked.

### Choosing a reviewer

Before landing, read `atelier show tN` and, in the task workspace,
`git fetch origin main` then `git diff origin/main...HEAD`. Triage the diff
against each acceptance criterion. Missing behaviour goes back to the
builder with `atelier dispatch tN --to home --agent A --model M --note "…"`;
a complete diff proceeds to independent review. A criterion the builder
cannot verify, such as a signed-in browser flow, belongs to the orchestrator
after deploy: record that check and do not claim it passed from local tests.

The reviewer must be of another company than every contributor to the task,
not only its last builder: `atelier show tN` names who worked on it, and the
task's history may include an earlier builder or a session that fixed a
conflict. Among qualifying reviewers, alternate between companies (between models of
the selected company in single-family mode) so that
no one reviewer's queue holds every landing. A reviewer that has rejected
the same task several rounds running is still the right reviewer; see
"Judging a review".

### Comparing two versions of a reviewer

A change to what a reviewer is given or who it is (the review brief,
`REPLY_FORMAT`, `DEFAULT_REVIEW_BAR`, a model, a harness) can make it better or
worse, and one landing does not show which. Run both versions on the same
cases and read the two scores side by side. The cases are the checked-in set in
`bin/orchestrate/review-cases/v1`: judged builds with their confirmed defects,
and clean builds. They need nothing from your home folder.

```sh
cases=bin/orchestrate/review-cases/v1
bin/orchestrate/review-bake.sh run   --cases $cases --out before --reviewers codex/MODEL
bin/orchestrate/review-bake.sh score --cases $cases --out before --version "current brief" --write
# change the brief, the model or the harness, then:
bin/orchestrate/review-bake.sh run   --cases $cases --out after --reviewers codex/MODEL
bin/orchestrate/review-bake.sh score --cases $cases --out after --version "shorter brief" --write
```

Each `scores.md` and `scores.json` records the case-set hash, the case set's
brief version, the harness and model, and your `--version` label, with
precision, recall, wrong verdicts (an approval of a defective build or a
rejection of a clean one), failed runs and unjudged blocking findings. Compare
only two scores with the same hash; a different hash means different cases.
Read them together: a higher recall bought with more false blocking findings,
or with more failed runs, is not an improvement. A failed run counts against a
reviewer and is never left out of its totals. Unjudged findings are not
counted as true or false: read them and label them in `labels.json` before you
trust a precision.

The case set is small, so one case moves recall by a large step. Treat a
difference of one case as noise and run the cases again before you act. The result informs your decision. It changes no assignment,
writes nothing to the ledger and gates no merge.

### Landing a wave

Land a wave with `atelier land t1 t2 t3 --reviewer H/M`, or one task with
`atelier land t1 --reviewer H/M`. Each task goes through the steps in
"Landing" above, exactly as `atelier land ID` does them alone; the wave only
starts several of them at once and keeps the order.

- **How many at once.** `--parallel N` (a positive integer) bounds the
  landings in progress at a time. It is per command, on this machine, not
  across machines or across commands, and defaults to `DEFAULT_PARALLEL` in
  `cli/land-queue.mjs` (`atelier land --help` says it). Tasks start in the
  order named, so name the ones that touch core files first: everything else
  merges around them, and a core-file change landed late conflicts with every
  task that landed before it. Within that, put first the tasks that another
  piece of work waits on. A task named twice lands once.
- **What runs beside what, and what does not.** Merging main, the checks and
  the reviews of different tasks overlap, except that the checks queue for the
  machine's test slots, one at a time unless the developer raised the capacity
  (`atelier slots set N`; `docs/test-slots.md`). The merge itself does not: each
  landing takes the project's landing lease only once its head is checked
  and approved, and the server hands the lease to the waiting landings in the
  order they queued. The flags you give (`--reviewer`, `--triage`,
  `--no-review` and the rest) go to every landing of the wave. Leave out
  `--reviewer` and the server suggests a reviewer for each task, of another
  company than every contributor to that task; name one only when every task
  of the wave may be reviewed by that model.
- **How many reviews.** A project with risk reviews (`atelier init
  --risk-reviews`) sets how many independent approvals a change needs by its
  class: docs or tests, other, core. `atelier land` asks only for the
  approvals the gate still lacks, one reviewer after another, and never asks
  a model that has already approved (under any name or harness). A rejection
  ends that landing at once and prints the reviewer's note and each blocking
  finding. The landing stops after a few asks (`REVIEW_PASSES` in
  `cli/land.mjs`) and says how many approvals are missing; `atelier show ID`
  says what the gate counts. A project without risk reviews needs the one
  review it always did, and `--reviewer` or `--no-review` takes one ask, as
  before. An approval is bound to the head and the criteria it read: a push,
  or a change of criteria, starts the count again, except where an
  approval is retained (next).
- **Filling the reviews of a core change.** When the project's
  `riskReviews` ask two or more independent reviews for a change, the gate
  asks no separate tier review: two approvals from different families, none
  a contributor's, clear it, and a tier model's approval counts as
  independent when its family is not a contributor's. Name two reviewers of
  different families with `--reviewer`; a tier model may be one of them.
  A change that needs none or one independent review keeps the tier as
  before: a separate tier review's approval is never the independent one.
  Finding, on 2026-10-25: t265 sat an hour with approvals from astra and
  argon counted as one independent, because astra's approval filled the tier
  slot. PAVI decided that two independent families suffice.
- **Retained approvals.** An approval may stand across a merge of main, and
  the server alone decides, when the push arrives (the review-retention
  rule, t56; [Landing](landing.md) has the conditions): the merge must be
  main merged into the approved head, change no file the task changed, hold
  only the task holder's commits, resolve no conflict by hand and leave the
  criteria as they were. Any doubt means a full review. A carried approval
  is carried once; a second merge of main asks again. Acceptance never
  carries, and the checks run again at the new head. The landing counts
  whatever the gate counts, so a carried approval shortens the wait without
  the CLI judging it; an older server carries nothing and asks.
- **When main moves.** Under the lease the landing confirms that main is
  still the commit its head was merged with, checked and reviewed against.
  If another landing merged first, it releases the lease, merges the new
  main into its workspace, checks it, asks for the approvals still missing
  (none, when the merge was retained) and tries again. After
  `ATELIER_LAND_MAIN_MOVED_ROUNDS` rounds (`cli/land.mjs` says the default)
  it stops with the task still submitted; run the same command once main
  settles. A conflict ends that landing, names the files and holds no lease:
  resolve it as under "Conflicts", then run the command again.
- **Failures.** Each result prints the moment its landing ends: `tN landed.`,
  or `tN failed (…)` with what the landing printed, the reviewer's findings
  included. A failure never stops the others that already run or the tasks
  not yet started, with one exception below; the command ends with a line
  that counts what landed, was already merged, failed or never started, and
  exits non-zero if any failed or never started. A task already merged is
  reported and not launched again, unless post-merge work for it is still
  open, which the landing then finishes first.
- **After a post-merge failure.** When a landing fails with a post-merge run
  open (a project that declares post-merge steps, `atelier init
  --post-merge`), no task not yet started is begun, and the server's
  post-merge barrier holds the merge of any landing already running. Read the
  run with `atelier land ID --post-merge status`, fix or settle it with the
  other `--post-merge` actions, then run the same command again.
- **Recovery.** `atelier land` is resumable: a stopped wave is resumed by
  running the same command, which reads each task's state from the ledger.
  Ctrl-C (SIGINT) or SIGTERM reaches every landing, each releases its own
  lease and no other holder's, and nothing more starts; a landing that has
  not ended after 30 seconds, or a second signal, is killed. A lease nobody
  renews is treated as free by the server after 15 minutes; `atelier land ID
  --release-lease` frees one at once, and only the developer should.
- **What a wave refuses.** `--workflow`, `--release-lease` and `--post-merge`
  act on one task, so with several the command refuses them before any
  request. A landing that runs as a Cloudflare Workflow (`--workflow`) is
  not pooled, because stopping its client does not stop it.

Wait for a landing started elsewhere with `atelier wait tN --project atelier
--for merged`. For a runner's build use `--for submitted`, for an agent's
review use `--for reviewed`, and to observe the next task change use `--for
any-change`. Add `--timeout 600` to bound the wait, including a stalled
server read. The command prints the outcome and exits 0 when reached, 1 when
the task fails, 3 on timeout, or 4 when it cannot read the task. A merge does
not confirm deployment or publishing; check the post-merge step's outcome
separately.

### What stays outside Atelier

`atelier land` merges a task into the project's main. It does not do the
steps that follow, and the developer has not yet decided to move them:

- **The wave suite.** `atelier land` runs the project's required checks on
  each task's merged head, in a clean clone, before that task merges. The
  full suite on main once a whole wave has merged is still the
  orchestrator's: `bin/orchestrate/post-merge.sh` runs the type check and
  `npm test` in the checkout. Whether the server should run one suite per
  wave, in place of the full suite per task or beside it, is the developer's
  decision and is open; the cost of a per-task suite is measured by `atelier
  flow`, which a wave's landings feed. Until it is decided, run the suite on
  main after each wave.
- **The deploy and the push to the public mirror.** The same script deploys
  main and pushes it to the `public` remote after the audit under "After
  each merge". Atelier can run named post-merge steps for a project (`atelier
  init --post-merge`, with `atelier land ID --post-merge` to read and resolve
  a run), but a deploy and a push to a remote the project does not host need
  the developer's decision, so they stay a script a session runs, once after
  the wave and not once per task.

`bin/orchestrate/review.sh` also stays: a session without a runner reviews by
hand with it until the replacement is confirmed in use.

### Accepted work waiting while main moves

Accepted work that sits unmerged while other tasks land is the costliest
kind of delay. On 16 October three accepted schema tasks in ikon-weblog
waited for the developer's migration approval. Three other tasks merged
into the same files meanwhile, so each held task conflicted at merge time,
and every resolution made a new head that needed fresh checks and a fresh
review.

- **Land promptly.** Get any approval a change needs before building it, or
  land it right after its review, with the wave landing above. Do not let
  reviewed work wait while other tasks land in the same files.
- **Merge main early.** When accepted work must wait, merge main into it
  while it waits (`atelier update`), so the conflict is met with the
  author's context and not at merge time. A merge of main is retained only
  under the review-retention rule above, which is conditional; otherwise it
  is a full review. Acceptance never carries to the new head, and the
  checks run again at it.
- **See which work is behind.** `atelier status --project NAME` lists each
  accepted task whose head does not contain the main head the server last
  recorded, with both revisions, in text and in the JSON's `accepted`
  field; a task whose history could not be read says `unknown`. The list
  reads history only: it runs no check, dispatches nothing and changes no
  acceptance. Behind is not a conflict. `atelier check ID --merged` runs
  the checks on the would-be merge and shows whether the two collide.
  `atelier status --new` is unchanged: it reports what others did to
  tasks, not how their commits relate.
- **No stacking.** A task is based on main, never on another task's head.
  Land the lower task first, then the one above it.

### Pre-review while the lease is busy

While one landing holds the project's lease, Atelier pre-reviews the next
two landings queued behind it (t524; `src/dispatch/prereview.ts`), so a
defect is found before a task's turn rather than after it spends the lease.
This replaces the orchestrator's hand-run `prereview.brief`. Every ask of the
landing queue, by an `atelier land` (every landing queues, `--wait` or
not) or a landing Workflow, and every
renewal of the lease asks what is missing: one request per waiter and
binding (its recorded head, the criteria binding, its contributors, main's
actual SHA and how many merges main has had), never a second for the same
binding. Polling reads the baseline again, so a push without a recorded
merge gives a settled pre-review a fresh binding. If that read is unavailable,
the last observation remains; claims and verdicts still require a fresh read.
A waiter whose landing stops asking, gives up its place or closes is no longer
pre-reviewed: the queue's list of jobs and the claim check this themselves,
so a waiter that expired is never offered to a runner even when no landing
call has come since. While no lease is live, a pending pre-review waits.

The reviewer is picked as a gate reviewer is picked: from the pool's models
(an admitted reviewer included), of another family than every contributor,
or a different model of the one company in single-family mode. Only models
that a live runner offers for the `prereview` job count. A runner whose config takes
`review` advertises `prereview` too. While no live runner advertises it,
nothing is asked. A task with a gate review request open gets no
pre-review, and a runner takes the gate's reviews before any pre-review.
Pool changes withdraw open pre-reviews for models held from reviewing;
claims and verdicts recheck that standing before they can affect the queue.

The claim binds the request to main's head as the server reads it from the
baseline then; a claim made while it cannot be read is refused and the
request stays open. The runner clones the task's recorded head into a
scratch folder of its own, merges that main into it as `atelier land` does
(a baseline that moved before the merge makes the pre-review stale), raising the route level
and regenerating the fixtures, and records the main head it merged and the
tree it prepared. The reviewer's brief names the merged tree's tests for the
changed files, the project's required checks to run there, the task's
recorded results (from its own tree, not the merged one) and the evidence
that is missing. Nothing is pushed, and the builder's workspace is never touched.

The result is pre-review evidence only. It does not satisfy or reject the
gate, answer a review request or count a round, and the landing never waits
for it. It is checked before it is applied: a verdict whose head, main,
criteria or contributors moved, or that came after its claim was lost, is
recorded as stale and changes nothing. Main counts as moved when the
baseline's head, read again when the verdict arrives, is not the main the
tree was prepared from, whatever moved it (a merge, or `atelier sync`
pushing without one). A rejection that names no blocking finding, or an
approval that names one, is a malformed reply, however it was posted.

| Result | What it does | Next step |
| --- | --- | --- |
| pass | Nothing: the task keeps its place | None |
| blocking findings | The task leaves the queue and its landing is fenced (`prereview_blocked`, for the CLI and the Workflow alike). The builder and head stay; a runner's builder gets the claim back with the findings in its rework brief | Once they are fixed, `atelier unblock tN`, then `atelier land tN` again |
| blocking, builder unavailable | As above, but the inbox says developer action is needed | Hand the task over (`atelier handoff`) or dispatch it, then unblock |
| conflict, preparation failed | Recorded apart from a result; the task keeps its place | The landing will meet the same conflict or failure: resolve it ahead |
| unavailable (no reviewer, skipped, timed out, malformed reply, runner failure) | Nothing: the task keeps its place and lands normally | None; it is tried at most three times in all, and after no reviewer qualified, not again for five minutes |
| task took the lease first | The result is kept as evidence and controls nothing | None |

The task detail (`GET /api/projects/P/items/tN`) carries `prereviews`, each
with its state, binding, reviewer, findings and recovery, and
`prereviewFence`. The landing status (`GET …/landing-lease`) adds each
waiting row's newest `prereview`.

### Landing outcomes

| `atelier land` printed | What happened | Next step |
| --- | --- | --- |
| `tN landed.` (a wave), or the landing's own closing lines | Merged on main | "After each merge" |
| A merge that stops on conflicts, naming the files | Main has moved and the merge conflicts | "Conflicts" |
| `… rejected tN at SHA: …` | The reviewer asked for changes; the landing printed the note and each blocking finding | "Judging a review" |
| `tN still needs N more approvals at SHA after N reviews` | Every ask was answered with an approval and the gate still lacks some | `atelier show tN` says what the gate counts; look for an approver the gate sets aside (a contributor, or one model asked under two names) |
| `main moved under the lease N times` | Other landings kept merging first; the task stays submitted | Run the same command once main settles |
| `… lacks capabilities …` | A merge declared a capability the server does not publish yet | Deploy, then land the task again |
| `Starting no more landings: …` | A failed landing left post-merge work open, so a wave starts nothing more | `atelier land tN --post-merge status`, resolve it, then run the same command |
| `the landing lease was not tN's within 3 hours` | The landing reattached to an old Workflow run that had been waiting for the lease and has now timed out (t430) | Land the task again: the next landing starts a fresh run |
| `FAIL … npm test @ SHA` | The checks failed in a clean clone at the merged head, or ran out of time (`check exceeded its time limit` in the landing's output) | If it timed out, the machine was too loaded: lower the load, or raise `ATELIER_CHECK_TIMEOUT` for the landing, and land it again. Otherwise run the suite in the task's workspace, keeping the whole output, to name the failing test; then send it back or fix it |

### Conflicts

In the task's workspace, `git diff --name-only --diff-filter=U` lists the
conflicting files.

- **A mechanical conflict**, however many files it spans, is resolved by the
  orchestrator: two sides each adding entries to help or usage text, an
  import list, a table or a registry, and generated fixtures (regenerate them
  from the merged code). Keep both sides, run the type check and the tests of
  the files touched, commit the merge with your own `Agent:` line, push with
  `atelier push --as H/M` from the workspace, and land it again.
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
before landing it again. Moving paths is not a mechanical resolution when
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
reaches every core file, so the task is held behind any claimed or landing task in
any of them: on 10 October twelve tasks filed with broad scopes all waited on one
task, while a second machine's runners sat idle.

When runners sit idle, read `atelier queue` first: held dispatches are work
waiting on scope overlaps, not an empty backlog. If none are held, use
`atelier status` to check runner eligibility and health.

`atelier status` shows `Held: waits on tX … both scopes reach core file F`
for a dispatch whose scope overlaps, in a core file, a claimed task's or the
landing task's. Check that
tX is really moving (its workspace's last commit, an agent process in it). If
tX is stuck, fix tX first. If many tasks wait on one, release the few that
matter most with `atelier dispatch tN --overlap-ok`, not all of them: tasks
released together into the same core file mostly conflict with each other at
landing.

### After each merge

Run `bin/orchestrate/post-merge.sh tN` in the project checkout once a wave
has landed (after each task when you land one by one) and wait for it. It
works on main as the checkout pulls it, so one run covers every task the wave
merged; `tN` names the last. It requires a clean `main`, pulls with
`--ff-only`, runs `npm run typecheck` and `npm test`, deploys, audits
outgoing history and publishes: the steps that stay outside Atelier. Any
failed command stops it and holds the next wave. The steps below explain
those operations and manual diagnosis; start no further landing while this
step is pending.
The script runs the full suite in the clean checkout; a clean clone below
can reproduce failures independently.

For a task whose platform/runtime behaviour needs a remote smoke check, set
`POST_MERGE_SMOKE=/absolute/path/to/check`; the executable receives `before`
and `after` around deployment and must return zero for each. A failure
holds the next landing. Include the orchestrator's signed-in browser criterion in
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
3. Deploy once the suite passes (the developer's decision d6: landed changes are
   deployed after main's full suite passes, not only when a capability is
   added):

   ```sh
   git diff $PREVIOUS HEAD -- src/capability-declarations.ts
   npm run deploy
   ```

   The diff shows whether a capability was declared; if one was, queue
   again every landing refused for lacking it once the deploy is done. `npm run deploy`
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
   bin/orchestrate/post-merge.sh tN
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
   the developer; do not rewrite shared main casually. Re-audit the entire
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

### After a deploy

A Durable Object keeps running the code it started with until it goes
idle, so a deploy leaves a busy Ledger on the older code. On 2026-10-13
from 09:35 to 10:05 EDT, after the deploys of t578 and t585, the atelier
Ledger answered "The RPC receiver does not implement the method" for
`showcaseCounts` and `mode`, and the showcase showed zeros. Stopping every
runner for about 70 s let it go idle and start again on the new code.

Since t586 the Worker handles this itself (src/ledger-stub.ts):

- The first time a Worker isolate addresses a Ledger, it sends its own
  `DEPLOYED_MAIN` (`ledgerVersion`). A Ledger reads the `DEPLOYED_MAIN` of
  the deploy whose code it runs, so a Ledger on older code sees the two
  differ and restarts (`ctx.abort()`) once no call is in flight
  (src/restart-gate.ts), or after 30 s if it is never idle. New methods are
  served within a minute, with the runners left running.
- A call the Ledger lacks asks it to restart (`restartForUpdate`) and
  answers 503 `server_updating`, "the server is updating; try again in a
  minute", instead of a 500. The showcase says "The server is updating" and
  is kept for ten seconds only.
- A Ledger restarts at most once a minute (`ledgerRestart` in
  src/rules.ts), and not again for a Worker whose restart brought the same
  code back, so an old Worker isolate lingering after a deploy cannot keep
  restarting it. `npm run deploy` sets `DEPLOYED_MAIN`; a deploy without it
  restarts a Ledger only when a method is missing.
- The Worker log says which Ledger restarted and why (`Ledger restarting
  for an update: ...`).

The first deploy of t586 still needs the manual step once. A Ledger built
before t586 has no `ledgerVersion` and no `restartForUpdate`, and nothing it
already does resets it safely: it never calls `ctx.abort()` or
`blockConcurrencyWhile`, and an error from a call, the missing-method error
included, does not reset a Durable Object. The only other
resets are its running out of memory or CPU, which are not safe to provoke.
So after deploying t586, if a page or the CLI says the server is updating,
or the Worker log says a Ledger "predates ledgerVersion", stop every runner
for 70 s and start them again. From then on every Ledger runs code that
restarts itself on the first call after a deploy.

### Before a switch of the server

The Ledger's schema only moves forward: a deploy adds tables and columns
(src/ledger.ts, the constructor) and never takes them away, and
`atelier events` exports the events alone, not the items, reviews, plans,
tokens and models the other tables hold. A switch of the server, such as
1.0 to 1.1, therefore needs a way back recorded before it starts. Since
t342 the developer has four commands for it, each refused with 403 to an
agent's or a runner's token, or a request without one.

Before the switch:

1. Stop the runners, so nothing writes while you read.
2. Record a bookmark of each project:
   `atelier ledger bookmark --project P`. It records the point-in-time
   bookmark of the project's Ledger and of the index (which holds every
   project's registration, the tokens and the pool), prints both, and
   prints the id, `b1` say, that restores them. Keep the id with the
   switch's notes. Cloudflare keeps a Durable Object's history for 30
   days, so a bookmark is a way back for 30 days.
3. Dump each project: `atelier ledger dump --project P --file P.json`.
   The file holds every table of the project's Ledger with its rows, the
   schema version (a hash of every table's columns) and the commit that
   wrote it. Tokens appear only as their hashes, which is all the Ledger
   keeps; a token pasted into a brief, a note, or the project's title or
   policy is replaced with `[redacted]`. When it has read every table, the
   dump checks each one's rows against a checksum of the table as it stands
   then, and fails, writing nothing, if the rows it read differ from that
   final state, even when the count held. It does not catch every write
   made while it read: a row added to a page not yet read is read with the
   rest and passes, since the dump then matches the Ledger as it stood at
   the end, and a change undone before the check goes unseen. So stop the
   runners before you dump, and if the dump fails, dump again. The file is the project's whole record: keep it as you would
   the owner token.

Rehearse the switch on staging before production:

1. On a staging server that runs the same code as production, import the
   dump: `ATELIER_SERVER=https://staging… atelier ledger import --project
   P --file P.json`. The import refuses a Ledger that already holds
   anything, a dump of another project, and a dump whose tables have
   other columns than the server's (`schema_mismatch`: import into a
   server running the code that wrote the dump, then deploy the new code
   there). It registers the project when staging does not list it yet.
   An import that stops halfway leaves its rows behind, and a second one
   is refused; rehearse again under a project staging has not had.
2. Deploy the new version to staging and watch the Ledger migrate the
   imported rows: open the project's pages, run `atelier status --project
   P` and `atelier stuck --project P`, and compare what they show with
   production.
3. Switch production only when staging shows nothing missing.

To roll back production after the switch:

1. Deploy the version you switched from.
2. Restore each project: `atelier ledger restore --project P --bookmark
   b1`. Only a bookmark `atelier ledger bookmark` recorded for that project
   is taken. Each Ledger restores to it on its next start, which it is
   asked to make at once; the command says which. Everything written since
   the bookmark is gone, in the project's Ledger and in the index, and the
   index is every project's: restore every project to bookmarks recorded
   together, or the other projects lose what the index gained for them
   since.
3. The restore records a bookmark of the state just before it, and prints
   the command that returns to it, should the rollback itself be the
   mistake.

The local runtime keeps no history, so the tests cannot restore a
bookmark: they stand in for the storage's restore call. Try a restore on
staging before the first switch that may need one.

## Fast mode

Atelier has two modes. Full mode is the default: every task is claimed,
built on its fork, checked, reviewed and landed one at a time, as above.
Fast mode is the developer's, for when that path cannot run. On 2026-10-13
Artifacts failed every new fork, so no task could be claimed, and four
finished tasks (t575 to t578) were merged by hand, outside the record. Fast
mode makes that path a recorded one.

Only the developer switches. `atelier mode fast --reason TEXT` puts the project
in fast mode; the switch is recorded as a standing decision with the
reason, so every review brief carries it. Fast mode has no end time.

Fast mode lands tasks without the gate, so it is held to what an override
of the independent review is (Astra's audit of 2026-10-13, finding 3). The
developer's direction switches to it: the developer's own words in
`--quote` and the model acting on them in `--as H/M`, with the developer
token, on any project (t629, the developer's decision of 2026-10-13: their
recorded direction suffices):

```text
atelier mode fast --reason "Artifacts fails every new fork" --quote "go to fast mode" --as claude-code/opus-5.5 --project demo
```

Both are required and both are recorded: on the mode, its standing
decision and its `mode.fast` event, and in each fast landing's receipt.
Without them the developer token alone does not switch: the developer
first presses "Allow fast mode from the command line" on the project's
Settings page, under their Cloudflare Access sign-in or giving the
server's confirmation secret (OVERRIDE_SECRET), and then runs `atelier mode
fast` within 15 minutes; one permission allows one switch. Without either
the command is refused and says so. A project set up with `atelier init
--no-override` refuses the switch to fast mode and every fast landing.
Switching back with `atelier mode full` needs no confirmation. A server
without `projects.developer-direction.v1` takes no `--quote`; the command
says so, and the Settings page is the way until it is deployed.
`atelier mode` prints `Mode: full` or `Mode: fast since TIME (reason)`,
followed for a switch on the developer's direction by their words and the
model that relayed them, and the project's Overview says so while fast
mode stands.

### Runner builds in fast mode

A runner's build in fast mode claims with a fork, as every build does. The
fork-less build (t589), which took a dispatched build with `atelier fast
take` and reported its commit with `atelier fast ready`, was removed in
t228: forks work since t772, and t18 and t181 handle a stuck one. Fast mode
is a flag on the one path, and on that path fast mode lands now and reviews
after (t300). The gate counts a task ready when its required checks pass at
its head and no secret flag stands; the independent review is not required
before the merge, so `atelier land` (and the lander that runs it for a
queued task) asks none, and merges. A rejection already standing at the head
still blocks, as does a failed check. The criteria review is skipped.

Once the merge is recorded, `atelier land` asks the post-merge review, of
`--reviewer` or the reviewer the server picks, and it is owed until a
verdict stands. That reviewer may share the builder's family; the review
records `same-family (fast mode)`. A rejection files a fix task. If the ask
fails, the landing says the review is owed and the task stays merged; ask it
with `atelier review-request tN --reviewer H/M`. A merge made in fast mode by
`land`, the lander or `atelier merge` is listed by `atelier fast status` and
by the switch back to full mode, as a landing with a receipt is, and the
review it is owed may come from the builder's family when the server picks
the reviewer too. Full mode is unchanged:
the review comes before the merge.

- The queue marks no build fast. The routes `POST items/tN/fast-take` and
  `fast-ready` remain only for a runner older than t228: each answers 409
  `not_fast_build` and records nothing, and that runner falls back to the
  claim with a fork.
- The server writes no `item.fast_taken` or `item.fast_ready`. Events
  already recorded still replay: a standing `item.fast_ready` shows its task
  as built, in `atelier fast status` as a `tN=SHA` line and on the task
  page, until the task lands. Record its merge as before.
- The route group is the named capability `runners.fast-build.v1`, kept so
  `atelier fast status` can name what it reads.

There is no command that lands a batch. The developer merges a reported
build in their own checkout of main, runs the checks they trust, publishes
main, and then records the merge with `atelier record-merge` (see its help
for the review it needs). A task recorded that way is shown as merged
outside Atelier, recorded afterwards, with the reviews as the developer
gave them. `atelier fast land` and `atelier fast record` were removed in
t767; the landings they made stay in the ledger and in `atelier fast
status`, with the review state of each.

`atelier fast status` lists every fast landing with its review's state,
then every build reported ready as a `tN=SHA` line and the command that
records a merge. `atelier mode full` (or `atelier fast close`) returns the
project to full mode, withdraws the decision and prints the same list. The
task page names a fast landing as "Landed in fast mode" with its receipt,
and a ready build as "Ready to merge at SHA"; the showcase counts fast
landings apart from gated merges.

## Judging a review

A reviewer's finding is a claim about the code, and it can be wrong. On
6 October about half of one reviewer's blocking findings did not hold: code
it could not see, a language feature it thought missing, a decision by the
developer it read as a defect. The other half were real, and some were serious.

- Check each blocking finding against the code before acting on it.
- When it holds, fix it in a new commit with a test that fails without the
  fix, and send the task back to the same reviewer.
- When it does not, say why in the review's context, with the file and line
  that show it, and ask for the review again. Do not override the review
  quietly, and never let a reviewer overrule the developer's decision.
- A rejection is bound to the revision it read. Another reviewer's approval
  of the same revision does not clear it: the gate still sees a reviewer who
  asked for changes with no push since. So a refuted finding is answered
  either by the same reviewer reading the refutation, or by a new push.
- Hold each finding against the review bar, which names what may block (the
  project's own, or the default `atelier init` prints). A finding outside the
  bar is a follow-up. A defect the change itself introduces still blocks,
  however small. The bar is not a file glob: a finding in a file the task did
  not list can still be a defect the change introduces, and a finding in a
  file it did list can still be outside the bar. A follow-up does not clear
  any approval: every review the change needs for its risk (a protected path,
  a coordinated change, a tier review) still has to approve the revision.
- When one reviewer rejects the same task round after round on narrower and
  narrower points, do not make another small change to meet each one. Stop
  and decide against the bar, as the developer's decision. Read the newest
  finding and ask whether this change introduces the defect, or whether it is
  a more remote variant of a threat the earlier rounds already closed. If it
  is inside the bar, fix it. If it is outside, record it with `atelier
  finding` (`confirmed` when the finding is true, `refuted` when it is not),
  with a `--note` that names the bar and the earlier finding it varies, and
  file the follow-up as its own task with `atelier new` and its own criteria.
  The rejection still stands until the same reviewer reads the note or a push
  follows, as above, and the other approvals the change needs are unchanged.
  Atelier decides none of this: no verdict turns a finding into a task, and no
  task is filed for you.

  Example, fast landing, 2026-10-13: the change let the developer land tasks
  without the gate, and the threat class was a caller who is not the developer
  landing that way. Review took ten rounds with one reviewer. Each round
  found a real case, and each was a more remote variant of that one class: a
  route or state the fixes before it had not named, reachable only by a
  caller who already held more than the change gave them. Round by round, a
  small change met each finding and the next round found another. Against the
  bar, the first findings were defects the change introduced and rightly
  blocked. Once the path the change itself opened was closed, the later
  ones were not: each is a follow-up task that can be built and reviewed on
  its own, while a finding that the new code opened a fresh path would still
  block at any round. The developer set that stopping rule after the tenth.
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
- Pass `--as H/M` with every verdict, naming the harness/model you are; it
  must be a model in the pool. Your verdicts are measured too (task t440):
  the Models page counts each upheld when another named model later agrees,
  contradicted when a later verdict corrects it or a defect names it, and
  unresolved otherwise. `atelier finding` prints the verdict's event number;
  a defect that shows a refuted or fixed verdict wrong names it with
  `atelier defect ID --note "…" --contradicts SEQ#N`.

## Seeing what others filed

Between two looks at the queue, someone else may file or edit tasks: on
15 and 16 October 2026 a project session filed about twenty tasks while one
session orchestrated, and that session never saw them, because nothing in its
loop listed new filings. Run `atelier status --new --project P` at the start
of a session and before dispatching each next batch. A batch boundary is the
point before you dispatch the next batch of tasks, after the last batch has
landed or been judged.

It lists each task, closed ones included, that someone other than you filed or
edited since you last looked, with the latest such actor and time. It reads
the `item.created` and `item.edited` events, never a task's holder or update
time, and "you" is the actor `--as` or `ATELIER_ACTOR` names, so each agent on
a Mac has its own place. The place is a bookmark kept on that Mac, per server,
project and actor; it moves only after a complete read has been printed. The
first run reads the last 24 hours and says so.

- A line saying the list may be incomplete means the server's newest 50 events
  do not reach back to your bookmark. The bookmark stays where it was; read
  `atelier ls --project P` for the tasks and run the command more often.
- `unread` means the source could not be read, or the bookmark was corrupt or
  could not be saved, and the command exits with status 1. It never means
  nothing is new; the old bookmark is kept.
- `--since 2026-10-16T08:00Z` reads from an instant with a time and a zone
  instead, refuses an invalid or future one, and leaves the bookmark alone.
- `--brief` prints one line and `--json` prints the status (`ok`,
  `incomplete` or `unread`) with the tasks.

## Keeping the record honest

- The task's holder is who the ledger says did the work. Before another
  model works on a task, hand it off (`atelier handoff`). The developer
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
- **A decision by the developer**: record it where the project keeps its
  decisions and cite the developer's words; never infer one.

## The weekly model review

Which model takes which role is the developer's judgement, recorded as a
role assignment (`atelier models assign`). Models change under their names
and measures accumulate, so the judgement is reviewed once a week by the
owner. `atelier models review [--as-of TIME]` prints what the records say; it
is read-only (it fetches nothing and records, assigns and dispatches
nothing), so running it early or twice costs nothing. The steps:

1. **Cards.** `atelier models show ID` for each model in the pool. Look for
   cards recorded since the last review, cards read more than 90 days ago,
   and claims that conflict under the same conditions. A card is the vendor's
   word: it can prompt a question, and it moves no proposal.
2. **Sources.** Refresh the sources of cards that are stale or in conflict
   through t625 once it lands (the Atelier task that adds refreshing a card's
   sources; until then, read the source again and record a new card with
   `atelier models card`, naming the one it corrects or supersedes).
3. **Measures.** Recompute them: `atelier models review` reads the events
   as of now (or of `--as-of TIME`, which reproduces an earlier review from
   the records held by then) and prints, for each role, each candidate's
   quality and speed with its window, sample size and threshold. Cost is
   unknown: Atelier records none per model and role, and the review says so
   rather than printing zero.
4. **Snapshots and decisions.** The review prints, for each model, how many
   of the last 14 days have a snapshot and where points are not joined, and
   cites each standing assignment by id (a1, a2, ...) with the earlier ones
   that were superseded or withdrawn. `atelier models show ID --trend` shows
   the days themselves; `atelier models roles` lists the decisions.
5. **Judge.** Read each proposal against its evidence and counterevidence:
   - *keep*: the first choice's quality figure is usable and no comparable
     figure is ahead of it by 10 points or more.
   - *change*: another model's quality figure is comparable (same window and
     threshold) and at least 10 points ahead; a lead of exactly 10 points
     counts, one of 9 does not. Speed, cost, cards, notes and
     history never decide this; they are cited so that you can.
   - *insufficient-evidence*: the role is not measured (security review,
     claims review and plan are not), the record is partial, or the first
     choice's quality figure has too few cases to count. Nothing is proposed
     from sparse or incompatible figures.
6. **Record.** Recording the outcome and applying a change are two actions
   of yours, neither done by the review. For each role, record a dated
   judgement: `atelier models assign ROLE ... --reason` (with `--replaces aN`
   for a change), or a note, `atelier models note ID 'text'`, when you keep
   the assignment. The reason names the evidence it rests on (the tasks, the
   figures with their sample sizes), how uncertain it is, and the date the
   next review is due (seven days on). A kept assignment is worth a
   dated note, so the next review can see that it was looked at.

The rules, thresholds and their reasons are in `src/models/review.ts`.

## What to record

Atelier records what passes through it: claims, pushes, observed checks,
submissions, reviews with their findings, handoffs, acceptances, merges and
run reports. Work done outside it is invisible. When you judge a finding,
resolve a conflict, or watch a run fail, record it, so the comparison
between models grows from every project and not only from the sessions that
remember to write it down.
