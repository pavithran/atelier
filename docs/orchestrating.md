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

- Use builders from several companies, chosen by tier, and not one company's
  models alone.
- Every protected or coordinated change is reviewed by a model from another
  company than every agent that worked on it.
- Never override a review, a check or a block, except on the owner's own
  confirmation. Ask, and cite the owner's words; never infer them.
- Judge each review finding against the code before acting, and record every
  verdict with `atelier finding`.
- Land one task at a time with `atelier land ID`. Never land two together.
- Report every run that ended without a result with `atelier run-report`.
- On a stall (a claimed task with no progress), check whether the agent's
  process still runs, then `atelier handoff` the task to another model or
  `atelier release` it. Do not start the same work twice.
- After a repeated rejection of the same task, stop resending it: judge the
  findings, then hand it to a builder from another company or ask the owner.
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
- Record the verdict on each finding (`atelier finding`, task t186). Which
  reviewers are right, and how often, is the most useful thing Atelier can
  measure about them. The next review brief shows each verdict and its note,
  so put the file and line that answer a refuted finding in the note.

## Keeping the record honest

- The task's holder is who the ledger says did the work. Before another
  model works on a task, hand it off (`atelier handoff`); an accepted task
  cannot be handed off, so integrate it under its holder or not at all.
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
