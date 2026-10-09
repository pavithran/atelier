# Atelier

Atelier is a multi-agent system for software work, built on Git: a planner
splits a goal into parts, builders of several model families work them at
the same time, each in its own fork, reviewers of another family check each
change, an integrator assembles the parts, and the one person who owns the
project decides what merges. None of them can trample another's work or the
owner's. It runs on Cloudflare Workers, Durable Objects and Artifacts, and is
driven by a dependency-free command, `atelier`, that any agent able to run a
shell command can use.

It is live at [atelier.zone](https://atelier.zone). Two pages there are
public: [How it works](https://atelier.zone/how) states the rules the code
enforces and lists every command, and the showcase, at the domain's root
[atelier.zone](https://atelier.zone), draws Atelier's own work as it was
built by agents of several model families: each task, who held it, its
checks, reviews and decisions.

## What Atelier enforces, and why

Agents sharing a repository overwrite each other's work, report checks that
never ran, and approve their own changes. Atelier answers each of these with
a rule the server enforces, not a convention.

1. **One exact owner per task.** A task (an *item* in the API) has exactly
   one owner at a time, granted atomically by the project's Durable Object,
   so a second claimant is refused. The owner holds the only write token for
   the task's workspace. Ownership moves only by a recorded handoff, which
   revokes the old token.
2. **Every agent in its own fork.** The project's main branch is copied into
   an Artifacts repository, the *baseline*. Each task works in a fork of the
   baseline, its *workspace*, so many agents work concurrently without
   touching each other's files.
3. **Checks observed, not reported.** A check that Atelier ran itself, in a
   clean clone of exactly the head it reads from Artifacts, is *Observed*.
   Anything an agent says it did is *Reported*: shown, never counted. A
   required check with no observed result at the current head is *Pending*.
   Only Observed passes count.
4. **Review by another model family.** A change to a protected path needs
   approval from a model of another family than every recorded contributor.
   The project owner's approval is not that review; without one, the owner
   can accept only by recording an override with its reason.
5. **Plans split by a planner and integrated on a plan branch.** A goal too
   large for one task goes to a planner model, which splits it into parts.
   Once the owner approves the split, runners build each part, a model of
   another family reviews it, and an integrator merges it onto the plan's own
   branch.
6. **The project owner accepts and merges.** The project owner is the person
   the project belongs to; in the API they act as a reserved actor, `owner`
   unless the deployment names another. Work reaches the project only when
   the owner accepts it through the gate and merges it.

The web inbox answers one question, *what needs the project owner now?*, and
ranks the things a person must decide above the things an agent must fix.

## Git alone, and with Atelier

Atelier sits on Git: every baseline and workspace is a Git repository, and a
merge is a Git merge. What Git and a forge leave open is everything around
the commit when many agents work at once, and that is what Atelier adds.

| The question | With Git and a forge alone | With Atelier |
| --- | --- | --- |
| Who owns this work? | Commits record authors, not ownership; two agents can take the same task, and a crashed one leaves its branch half done. | One exact owner per task, holding the only write token for its workspace; a handoff is recorded and revokes the old token; a restarted runner takes back the jobs a dead run left. |
| Did the checks really pass? | An agent reports that the tests passed, and the report is believed. | Atelier runs the required checks itself, in a clean clone of the exact head; a merge is refused until every required check is observed passing there. |
| Who checked it independently? | A model can review, and approve, its own work. | A change to a protected path needs approval from a model of another family than every contributor. |
| Is main still sound after the merge? | Branches drift from main, and what merges may not be what was reviewed. | One landing at a time under a lease: main is merged in, checks run again, and the exact head that was reviewed is the one merged. A plan's parts are integrated on the plan's own branch first. |
| What needs the owner now? | A stream of pull requests and notifications. | A decision inbox, ranked, each entry with a recommendation; `atelier land` takes a task from review to merge in one command. |
| Which model is worth it? | Nothing records it. | Each model's track record and reliability from the ledger, and its calls, cost and latency from AI Gateway. |
| Who did what? | Commit metadata, which an agent writes itself. | Every claim, push, check, review, decision and merge is an event in the ledger, and each merge's builder, reviewer and head go into Git as provenance notes. |

The record shows what this catches. In Atelier's own project, as of
2026-10-07 23:00 UTC, models recorded 303 reviews; 91 sent the work back,
with 57 findings marked blocking, each found before the change merged. Of the
205 merged tasks, 157 carry an approval from another model family at the
revision that merged, and every task merged since 22:11 UTC on 2026-10-06
does (68 in a row), since the project owner extended the rule to every
path in the project that day.

## Built on Cloudflare

| Product | What it does in Atelier | State |
| --- | --- | --- |
| Workers | One Worker (`src/index.ts`) serves the API the CLI calls, the signed-in pages and the public pages, on the custom domain atelier.zone. | Live |
| Durable Objects | The `Ledger` class, with SQLite storage. One instance per project handles one request at a time, which is what makes one owner per task hold; it keeps the project's tasks, events, evidence and reviews. One index instance keeps what spans projects: the project list, agent tokens, the model pool, runner offers, usage and run reports, and the showcase setting. | Live |
| Artifacts | Git repositories: each project's baseline, and a fork for every task and every plan. The Worker reads commits, trees and diffs through the binding to measure what a change touches and to preview its merge. Writes come only through a `git push` with a write token minted for one workspace. | Live (Artifacts is in open beta) |
| Containers | `CheckRunner`, a Durable Object with a container from the Cloudflare-managed `cloudflare/debian-trixie` image, runs a task's required checks with `--sandbox`. The container holds no credential and its Internet is off, except GET and HEAD requests to the npm registry. The image has no git; the Worker streams Debian's git package, pinned by sha256, into each container (docs/setup.md). | Built and configured in `wrangler.jsonc`; a successful run in production has not been established |
| Workers Analytics Engine | The `atelier_metrics` dataset (binding `METRICS`), with `src/metrics.ts` to write one typed data point (`writeMetric`) and read rows back through the Analytics Engine SQL API (`query`). Model speed (`src/models/speed.ts`) and reviewer precision (`src/models/precision.ts`) are computed from the ledger's own events, not written here. | Bound; nothing writes to it yet |
| AI Gateway | Runners point opencode's pay-per-use providers at the gateway `atelier` (DeepSeek, OpenRouter and the API-key providers, each base URL `https://gateway.ai.cloudflare.com/v1/{ACCOUNT}/atelier/{provider}`); every call carries a `cf-aig-metadata` header naming the task, role and runner, and subscription harnesses stay direct. | Live: the home runners' DeepSeek and OpenRouter calls go through it ([AI Gateway costs](#ai-gateway-costs)) |
| GraphQL Analytics API | The Models page and `atelier runner --usage` read the gateway's calls from it (`src/usage/gateway.ts`): each model's calls, failures, tokens, cost, and median and p90 duration over the last 7 days. | Live: the Models page shows each model's calls, failures, cost and durations |
| Workers Logs | `observability` is enabled in `wrangler.jsonc`, so the Worker's logs are kept. | Live |
| Queues | A consumer for Artifacts push notices (`cf.artifacts.repo.pushed`) is written in `src/index.ts`, but `wrangler.jsonc` declares no consumer, so no notice is delivered; the CLI reports each push to the Worker instead. | Written, not configured |
| Cloudflare Access | In front of the owner's pages: the Worker verifies the Access assertion and the owner's email on every signed-in route ([setup](docs/setup.md#cloudflare-access-in-front-of-the-owners-pages)). | Live: five Access applications on atelier.zone, with the Worker's own check on |
| Browser Rendering | A render check (`src/render-check.ts`, `test/render-check.test.mjs`) builds `/how` and the showcase from the pushed tree, posts each page to the reserved host `render.atelier.test`, and the Worker's `BROWSER` binding renders it in Cloudflare's headless browser and reports the laid-out geometry; a label wider than its box, overlapping boxes or a figure that shrinks instead of scrolling fails the check. | Built and configured in `wrangler.jsonc` |
| R2 | Large check logs and review diffs (`src/large.ts`), kept in the bucket `atelier-large` (binding `LARGE`) and named in briefs and the ledger by a reference ending in the payload's sha256, instead of carried inline. The same bucket caches the pinned Debian git package the check container installs (`fetchPinned` in `src/sandbox/runner.ts`). | Live: the bucket `atelier-large` exists and is bound |
| Workflows | The landing pipeline as a Cloudflare Workflow (`src/landing-workflow.ts`, binding `LANDING_WORKFLOW`): `atelier land ID --workflow` runs the lease, the checks, the submission, the review wait and the acceptance as durable steps with retries, and waits for the owner's machine to merge main, push and merge. | Live behind `atelier land --workflow` (local checks by default) |

## Quickstart

From a clone to a first task landed. It needs Node 24 or later, git, a
Cloudflare account on the Workers Paid plan (Artifacts is in open beta
there), and `wrangler` logged in.

**1. Build and test.**

```sh
git clone https://github.com/pavithran/atelier
cd atelier
npm ci && npm run types && npm test
```

**2. Deploy the Worker.** `wrangler.jsonc` routes the Worker to atelier.zone
as a custom domain and turns `workers.dev` off. In your copy, replace the
route with a domain on your own account, or remove `routes` and set
`workers_dev` to `true`. Choose a server token (a random one is fine, kept
where you can paste it from), deploy, and give the Worker the token as a
secret; wrangler reads it from the prompt, so it is not written on a command
line:

```sh
openssl rand -hex 32
npm run deploy
npx wrangler secret put ATELIER_TOKEN
```

`npm run deploy` runs `wrangler deploy` and records the commit it deployed,
which `GET /api/version` reports with the server's route level. `atelier
land` refuses to run against a server whose route level is below the CLI's.

**3. Install the CLI and sign in.** `login` asks for the token, checks it
against the server, and only then stores it (in the macOS Keychain, the
Linux Secret Service or a file readable only by you):

```sh
npm link
atelier login --server https://YOUR-WORKER-ADDRESS
```

**4. Register a project.** In the Git checkout of a project whose tests run
with `npm test`:

```sh
atelier init --title "My project" --check "npm test"
```

`init` creates the baseline in Artifacts, pushes the current branch to it,
and prints the policy it recorded: the branch, the required checks (each
shown read-only) and the protected paths. Without `--protect`, those are
`AGENTS.md`, `CLAUDE.md`, `wrangler.*` and `.atelier/prompts/**`, with every
file a check executes (here `package.json` and `.npmrc`, which decide what
`npm test` runs).

**5. File a task and do it as an agent.** `new` prints the task's id, here
`t1`:

```sh
atelier new "Fix the off-by-one in pagination" --scope "src/**"
atelier start t1 --as claude-code/opus-5.5
```

`start` claims the task, forks the baseline, clones the workspace and prints
its path. Change the code there and commit, then, still in the workspace:

```sh
atelier done "Fix the off-by-one in pagination"
```

`done` pushes, runs the required checks in a clean clone of the pushed head,
and submits only when they pass and the head has not moved. Its last line
says `Ready for the owner` or names what still blocks the task. Here the
owner's token acts for the agent named by `--as`; a real agent gets a token
of its own (see [Further setup](#further-setup)).

**6. Land it.** Back in the project checkout:

```sh
atelier land t1
```

`land` takes the project's landing lease, merges main into the workspace,
pushes, runs the required checks and submits, then accepts the task and
merges it into the checkout with `--no-ff`, and publishes the merge to the
baseline. The merge commit carries
the task's provenance as a git note on `refs/notes/atelier`, and the command
prints how to read it. A change to a protected path also waits for a review
from another model family, which a runner serves; see [Review](#review) and
[Runners](#runners).

[docs/demo.md](docs/demo.md) walks a whole plan through the same server,
with what each command prints.

## Concepts

In outline: the project's main branch is copied into the baseline. Each
task is a fork of the baseline, its workspace. Agents work in their
workspace, push to it, and run checks against it. The project owner merges
accepted work into the real checkout, and the baseline follows.

| Step | Who | What happens |
| --- | --- | --- |
| `atelier init` | the project owner, in the project checkout | Creates the baseline and records the project's branch, required checks and protected paths. Every check must be read-only. |
| `atelier new "title" --scope GLOB` | the project owner | Creates a task. The scope is what it intends to touch; overlapping live scopes are flagged. |
| `atelier claim t3 --as H/M` | an agent | Grants ownership atomically, forks the baseline, mints an eight-hour write token for the owner alone, and clones the workspace. |
| `atelier push` | the task's owner | Pushes, then asks the Worker to read the head from Artifacts. The ledger records the head Atelier saw, not the one the agent named. |
| `atelier check` | the task's owner; anyone with `--sandbox` | Runs each required check in a fresh clone of that head, or in a container, and records the results as Observed with the paths the change touches, which the Worker measures itself. |
| `atelier submit` | the task's owner | Marks the task ready; the gate states what still blocks it. |
| `atelier handoff t3 --to H/M` | the task's owner or the project owner | Moves ownership and revokes the old write token; the workspace carries over. |
| `atelier review t3 --approve` | a model that did not work on the task | Required when the change touches a protected path, from another family than every contributor. |
| `atelier accept t3` | the project owner | Allowed only when the gate is clear; pins the accepted head. |
| `atelier merge t3` | the project owner, in the project checkout | Merges exactly the accepted head with `--no-ff`, attaches the provenance note and publishes the new main to the baseline. |

The **gate** for acceptance is a pure function in
[`src/rules.ts`](src/rules.ts). It requires every required check that
applies to the change observed passing at the current head; the changed
paths observed; no required check failing on the merge with a main that
moved after the head's own checks passed; no rejection at that head; and, if
a protected path changed, an approval at that head from a model of another
family than every recorded contributor's, or the owner's override of that
review. A model's family is read from its name
([`src/models/pool.ts`](src/models/pool.ts)); a family no name pattern
recognises never qualifies.

The files a check executes are protected automatically (a script it runs,
the `package.json` npm reads its scripts from, a `Makefile`, and others), so
a task cannot quietly weaken the check that grades it. A check must be
read-only: a command that deploys, installs, publishes, pushes, reaches
another machine or spends money is refused at `init`. A check may apply only
to changes that touch certain paths. The changed paths are measured by the
Worker against main as it is now, so no history an agent pushes can hide
one.

[docs/gate.md](docs/gate.md) holds the whole lifecycle, every rule of the
gate, check classes and checks that apply to some paths.

## Further setup

[docs/setup.md](docs/setup.md) holds every detail of this section.

- **Agent tokens.** Give each agent its own token, bound to one actor and
  shown once: `atelier token issue --as codex/gpt-6-astra --project
  my-project --days 30 --label "Task runner"`, then `atelier token ls` and
  `atelier token revoke ID`. Set `ATELIER_TOKEN` to it in the agent's
  session. Agent tokens can claim, push, record checks and reports, submit,
  hand off, release and review as themselves; creating tasks, owner
  decisions, project settings and token management need the owner token.
  A home runner records each review with the reviewing model's own token,
  named per model in its config (`tokens`, [Runners](docs/runners.md)), so
  the task page shows the reviewer itself as the recorder; a model without
  one has its reviews refused, naming the missing token.
- **Agent instructions.** `atelier guide` prints what an agent needs to
  know; paste it into the project's `AGENTS.md` or `CLAUDE.md`.
- **Role prompts.** `atelier guide --role build|review|plan|orchestrate`
  prints the instructions for one role alone: what a builder, a reviewer, a
  planner or a session that runs Atelier for the project needs. A project
  may override a role's text with `.atelier/prompts/ROLE.md` (for example
  `.atelier/prompts/build.md`); the command prints that file when the
  project has one, and a runner passes the same text to the agent it runs,
  so the role's instructions live with the project and stay in sync between
  the guide and the briefs. The path is protected by default, so a change
  that rewrites a role's text needs another model family's review; and a
  reviewer's runner reads `.atelier/prompts/review.md` from the accepted
  branch, never from the change under review, so a change cannot author its
  own reviewer's instructions.
- **The owner's actor and name.** Set `OWNER_ACTOR` and `OWNER_NAME` as
  secrets or `vars`, and `TIMEZONE` to an IANA zone for the pages' times.
- **Project policy.** `atelier init` again changes only what it names.
  `--protect GLOB` sets the protected paths, `--sandbox-only` counts only
  checks run in a container, `--refuse-overlap` refuses a claim whose scope
  overlaps a live task's, `--regenerate CMD` names the command that
  regenerates fixtures during a landing, and `--review-bar TEXT` states what
  may block a review.
- **Notifications.** Set `NTFY_TOPIC` to have an ntfy message sent when a
  submitted task reaches the owner's inbox.

## Daily use

### Tasks

The project owner files a task with `atelier new "title" --scope GLOB`, and
may frame it with `--non-goal`, `--stop-when` and `--next-gate`; `atelier
edit` changes that framing later. An agent then needs two commands:

```sh
atelier start ID --as harness/model
# Work in the printed workspace and commit the changes.
atelier done "What changed and why"
```

`start` claims the task, prepares the workspace as `claim` does, and prints
its title, scope and any dispatch note. Pass `--project NAME` when running
outside a registered checkout. `done` runs inside the task workspace. It
pushes, runs the required checks and submits the summary only after checks
pass and the revision remains unchanged. It stops at the first failed step
and names that step. The individual steps remain available: `claim`,
`push`, `update` (rebase onto the baseline), `check [--sandbox] [--merged]`,
`report` (a Reported claim), `submit`, `handoff`, `release`, and `block`
with `unblock` for a task waiting on something outside it.

`atelier inbox` and `atelier show ID` print the owner's decision briefs with
the recorded evidence, a recommendation and the task's address; an agent
can relay that text unchanged. Both accept `--json`; the same brief is
`GET /api/projects/NAME/items/ID/brief`, which requires sign-in. The owner
still decides whether to accept and merge. `atelier ls` lists the
project's tasks, and `atelier status` prints what waits for the owner across
every project.

### Plans

A plan turns one goal into several tasks that merge together. The owner
states the goal with `atelier plan "goal" [--scope GLOB]... [--planner
H/M]`. Atelier creates the plan item and queues it as a plan job for the
planner named, or else for the first model in the pool for research work
that is not refused, not paid per token and may plan. A project has one
active plan at a time.

A runner that offers plan jobs claims the plan item, which forks the
baseline into the plan's integration branch. It fetches the planner's brief
from the server (the goal, the scope and the schema to write), runs the
harness, posts the plan document (`atelier.plan.v1`: the goal and its parts,
each with a scope, dependencies, a brief and acceptance criteria) with
`atelier plan post ID FILE`, and releases the claim. An invalid document is
refused with every error, and the planner gets one more attempt before the
plan blocks.

`atelier plan show ID [--json]` prints the newest proposal with its hash.
`atelier plan approve ID --hash HASH [--allow-paid]` approves that exact
split, once; an older hash is refused, and `atelier plan revise ID --note
TEXT` sends a proposal back instead. Approval fixes the limits (two parts
live at once, three attempts a part, four dispatches a part, 24 hours) and
each part's routing: a builder, two alternates and a reviewer of another
family, chosen from the model pool and the ledger's record. The parts become
tasks, and Atelier dispatches each once the parts it depends on have
integrated, merged or been abandoned.

A builder's runner claims a part, fetches its brief (the plan's goal, the
part's spec, acceptance criteria and interfaces, the heads its dependencies
landed at, its scope and the required checks), runs its harness, and
finishes with `atelier finish`, which pushes, runs the required checks and
submits. The part then goes to its routed reviewer as a review job. A
rejection sends it back to its builder with the findings in its brief; an
approval from another family moves it to integration. The integrator, a
runner started with `--integrate`, merges the part onto the plan's branch
with `--no-ff`, runs the plan's checks and reports `atelier integrated ID
--part KEY --merge-commit SHA`. When main moves, a `refresh` job merges it
into the plan's branch so later parts fork from an updated basis. Once every
part integrates, the integrator submits the plan item, and the owner lands
it whole: `atelier merge ID --head SHA`.

A plan that reaches a limit blocks and appears in the inbox; the owner
decides with `atelier plan retry ID`, `atelier plan reroute ID --to H/M`,
`atelier abandon ID` or `atelier plan stop ID [--note TEXT]`, which closes
the plan and its open parts and revokes their write tokens. History and
evidence stay. [docs/orchestrator.md](docs/orchestrator.md) is the design.

### Landing

`atelier land ID` runs the whole second half of a single task, for the
project owner in the registered checkout. It takes the project's landing
lease on the server, so two landings never race main; merges main into the
task's workspace, stopping on conflicts and naming the files; runs the
project's regenerate command when one is declared; pushes, runs the required
checks and submits; requests the independent review the gate needs and waits
for the verdict; then accepts and merges. `--reviewer H/M` names the
reviewer, `--wait` queues behind a landing that holds the lease, `--no-review`
leaves the task submitted for the owner to settle, and `--dry-run` prints
the steps and the refusals without changing anything. A landing stopped
partway resumes when the same command runs again, and each step is recorded
on the task as a `land.*` event; a merge that brings more commits from main
than the record has room for records the first hashes and the count of all
of them.

The same can be done in steps: `atelier accept ID` then `atelier merge ID`,
or `atelier merge ID --head FULL_SHA`, which accepts a submitted task at
that exact revision first. `--approve` on that merge records the owner's own
review, which is not the independent review. When no reviewer qualifies,
because no model of another family is available or a contributor's family
is not recognised, `accept` and `merge` take `--override-review "reason"`.
The override is recorded as an event of its own, never as a review, counts
only at the head it names, and waives that review and nothing else.

A merge keeps a journal under the CLI's cache, so an interrupted merge
resumes when rerun, and `atelier merge ID --cancel` ends one.
[docs/landing.md](docs/landing.md) holds the journal, the cancel, the lease
queue and every landing step.

### Review

A change to a protected path needs approval from a model of another family
than every recorded contributor: every actor who ever held the task, and the
push contributors Atelier recorded. A model's family is read from its name;
models are compared without letter case or a `:profile` suffix, and a name
the model registry ([`src/models/registry.ts`](src/models/registry.ts))
lists for a model, such as `claude-opus-5-5` for `opus-5.5`, is that model.
The project owner may review too, and the owner's rejection blocks, but the
owner's approval never counts as this review.

A plan's part gets its review request automatically on submission. A single
task gets one when the owner lands it. A runner that offers review jobs
claims the request with `atelier review-claim ID [--runner home:NAME]`,
reads the diff, writes a verdict and findings, and records them with
`atelier review ID --approve|--reject --head SHA --criteria BINDING
--request N --findings JSON`. A review is bound to the head and to the
acceptance criteria its reviewer was given, the task's and a part's from
the approved plan: the claim names their binding, `atelier show` prints
it, and a verdict that names none, or criteria the task no longer has, is
refused. Changing a task's criteria withdraws every review and live review
request of the old ones, and an acceptance, and they never count again. Every
review brief states the project's review bar; unset, the default bar blocks
only for a correctness, security or data-loss defect that the change
introduces, or fails to fix while claiming to. `atelier init --review-tier
H/M,H/M` names a top tier of reviewers that reviews every protected change.

The owner records a verdict on each finding with `atelier finding ID --head
SHA --index N --verdict confirmed|refuted|fixed`. A later review of the task
shows the reviewer each earlier finding with the owner's verdict, and the
record counts each reviewer's precision.

### The receipt of a task

`atelier receipt ID` prints one task's whole story from the ledger, in the
order it was recorded: created, claimed, each handoff and release, each pushed
head as Artifacts answered it, each observed check at each head, each review
with its verdict and every finding, each finding judged by the owner
(confirmed, refuted or fixed), then the submission, acceptance and merge or
abandonment that ended it. `--json` carries the task's events as the ledger
holds them, in order. This is t278's receipt:

```text
atelier/t278  Pull forward a slice of t271 (PAVI, 2026-10-07, 'do it'): the Worker reads Cloudflare AI Gateway logs for the gateway named by AI_GATEWAY_ID (default 'atelier') in account CF_ACCOUNT_ID, through GET /accounts/ACCOUNT/ai-gateway/gateways/GATEWAY/logs with a Worker secret AI_GATEWAY_TOKEN (AI Gateway Read), on the ledger's alarm or a scheduled handler every few minutes, newest first since the last log seen; it records per call model, provider, tokens in/out, cost, duration and the cf-aig-metadata tags (task, role, runner) in a usage table, and the Models page and atelier runner --usage show per-model cost, tokens and median latency over a stated window with the sample size; with no secret set it does nothing and says so on the Models page. Document in README how the owner creates the token (AI Gateway Read) and sets it with wrangler secret put AI_GATEWAY_TOKEN, and how runners point opencode providers at https://gateway.ai.cloudflare.com/v1/ACCOUNT/atelier/PROVIDER with a cf-aig-metadata header
The whole story from the ledger, in order.
2026-10-07 20:27 UTC  created by pavi
2026-10-07 20:27 UTC  claimed by claude-code/opus-5.5
2026-10-07 20:54 UTC  head 2d7ac626 pushed by claude-code/opus-5.5, observed in Artifacts
2026-10-07 20:56 UTC  check passed, observed in a clean clone: npm ci --prefer-offline --no-audit --no-fund && npm test at 2d7ac626
2026-10-07 20:56 UTC  check passed, observed in a clean clone: npm run types && npm run typecheck at 2d7ac626
2026-10-07 20:56 UTC  submitted by claude-code/opus-5.5 at 2d7ac626: Merged with main at 51c0dd47; the required checks pass.
2026-10-07 21:02 UTC  rejected by antigravity/gemini-3.1-pro at 2d7ac626: I found two blocking defects: the scheduled pull silently drops logs if the backlog exceeds the 1,000-log page limit, and the analytics query silently underreports the 7-day totals if there are more than 10,000 calls.
                      1. blocking src/index.ts:1694 If a pull hits `MAX_PAGES` before reaching the last mark (e.g. after a spike of >1,000 calls), `fetchNewLogs` returns the newest 1,000 logs and `pullGateway` unconditionally advances the mark to the newest of them, permanently dropping all older unread logs.
                      owner's verdict: fixed. Fixed in 5342723: a capped pull records the gap in the index DO and the Models page and runner --usage say the totals undercount it; tests in test/gateway.spec.ts and test/gateway.test.ts.
                      2. blocking src/usage/gateway.ts:201 `windowSql` selects individual rows with a hard limit of 10,000; if there are more than 10,000 calls in the 7-day window, older calls are silently omitted from the query result, causing the Models page and CLI to underreport the window's true total cost, tokens, and calls.
                      owner's verdict: fixed. Fixed in 5342723: totals are summed per model in SQL weighted by _sample_interval with no row limit; only the median reads a capped sample, shown with n.
                      3. follow-up src/index.ts:1694 If the `METRICS` binding is somehow missing or misconfigured, `writeLog` returns false and writes nothing, but the mark is still advanced, meaning those logs will be skipped forever once the binding is fixed.
                      owner's verdict: fixed. Fixed in 5342723: logs are written oldest first and the mark moves only past logs written; a missing binding or failed write keeps the mark.
2026-10-07 21:13 UTC  head 04cafbf6 pushed by claude-code/opus-5.5, observed in Artifacts
2026-10-07 21:16 UTC  check passed, observed in a clean clone: npm ci --prefer-offline --no-audit --no-fund && npm test at 04cafbf6
2026-10-07 21:16 UTC  check passed, observed in a clean clone: npm run types && npm run typecheck at 04cafbf6
2026-10-07 21:16 UTC  submitted by claude-code/opus-5.5 at 04cafbf6: Merged with main at c7b73504; the required checks pass.
2026-10-07 21:20 UTC  rejected by antigravity/gemini-3.1-pro at 04cafbf6: The earlier blocking findings are resolved (a capped pull records its gap, totals are summed in SQL without a row limit, and writing oldest-first prevents advancing the mark on failure), but a new data-loss defect was found where pagination stops prematurely and drops older logs if the API returns invalid logs on a full page.
                      1. blocking src/usage/gateway.ts:190 `fetchNewLogs` uses the filtered `found.length < PAGE_SIZE` to stop paging; if the API returns a full page of 50 logs but one fails to parse (e.g., missing ID), `found.length` is less than 50, causing the pull to stop prematurely, return `gap: null`, and silently drop all older valid logs without recording a gap.
                      owner's verdict: fixed. Fixed: fetchNewLogs judges a short page by the raw result length, not the parsed logs; test in test/gateway.test.ts fails without it.
2026-10-07 21:21 UTC  head de671943 pushed by claude-code/opus-5.5, observed in Artifacts
2026-10-07 21:24 UTC  check passed, observed in a clean clone: npm ci --prefer-offline --no-audit --no-fund && npm test at de671943
2026-10-07 21:24 UTC  check passed, observed in a clean clone: npm run types && npm run typecheck at de671943
2026-10-07 21:24 UTC  submitted by claude-code/opus-5.5 at de671943: The required checks pass.
2026-10-07 21:28 UTC  approved by antigravity/gemini-3.1-pro at de671943: I verified that all earlier blocking findings are resolved (capped pulls correctly record the gap, SQL queries sum totals without row limits, failed writes leave the mark unchanged, and short pages are accurately judged by raw result length), and I found no new correctness, security, or data-loss defects in this change.
2026-10-07 21:28 UTC  accepted by pavi at de671943
2026-10-07 21:28 UTC  merged by pavi: de671943 accepted, merge commit 5af22431 on the baseline
https://atelier.zone/p/atelier/t278
```

Every line is an event the ledger recorded. Opus 5.5 built the change, so no
Claude agent could approve it: Gemini 3.1 Pro, of another family, reviewed it
and rejected it twice, each time for a real data-loss defect, and the owner
judged every finding fixed. The third head was approved at 21:28:33 and
merged at 21:28:44, eleven seconds later: strict where it matters, no wait
once the proof is in.

### Runners

A runner asks Atelier for work; it is never sent any. `atelier runner --name
home:NAME` is the home runner: it polls the queue every 30 seconds, claims
one eligible job, and runs the harness its config names for that job's
model. It offers `build`, `plan` and the merge jobs (`merge-main`,
`merge-main-task`, `merge-plan`) for every harness in its config, and
`review` when the config lists it. After a harness exits with a new commit,
the runner runs `finish`. A runner with `--integrate`
runs no harness and takes only the plans' `integrate` and `refresh` jobs.

The owner sends a task to a kind of runner with `atelier dispatch ID --to
home|cloud|any [--agent A] [--model M]`, or "Send to an agent" on its page.
A runner's config, at `~/.config/atelier/runner.json` or `--config PATH`,
lists each harness as an argv array with placeholders:

```json
{
  "agents": [
    {
      "agent": "opencode",
      "models": ["GLM-5.3-Flash-4_8bit"],
      "command": ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "Read the attached task brief and complete it in {workspace}."],
      "env": ["ZAI_API_KEY"]
    }
  ],
  "jobs": ["review"]
}
```

A harness does not inherit the runner's environment: it gets the toolchain's
variables and the ones its entry names in `env`, never a variable named
`ATELIER_*` or one whose name says it holds a token, key or secret. A review
job authenticates with the reviewing model's own agent token, which `tokens`
in the config locates (a Keychain entry name or a file under
`~/.config/atelier/`, never the value); without one the review is refused
unless `ownerRecordsReviews` opts into the owner-recorded path. The
harness leads a process group of its own, and every process left in it is
ended when the harness ends. No cloud runner ships: a task sent to `cloud`
waits for a runner named `cloud:NAME`, any program that speaks the queue's
two requests.

[docs/runners.md](docs/runners.md) holds the dispatch protocol, every
placeholder and setting, the failure counters, `atelier runner --discover`
(which model each harness actually serves) and `atelier runner --usage`.

## Operations

**Where a project stands.** `atelier status --project NAME` prints the
project's standing as plain text: who holds each task and since when, what
waits on the owner, what is queued for a runner, the last five merges and
the latest handoff notes. It ends with whether this machine's checkout is in
step with the baseline and, for tasks with a workspace on this machine, what
each holds locally. The project page and `GET
/api/projects/NAME/standing` give the same.

**The signed-in pages.** Decisions puts reviews and blockers across projects
beside the selected task; Flow draws each task as a thread from main and
back; History keeps merged and closed tasks with their evidence; Studio
draws one lane per live task, banded by who held it; Models and Usage show
the pool, each model's record and spend. Only the owner token signs in to
the browser.

**The public pages.** `/how` explains what Atelier is, draws the loop from
task to merge, states the rules the code enforces, marks which parts of the
orchestrator are built, and lists every command. It reads no project and no
setting, and its command reference is drawn from `src/usage.ts`, the table
`atelier help` prints from; `test/how.test.ts` checks that the rules and
labels it names still match the code. `/showcase` shows the projects the
owner names, as the Flow page draws them, to anyone without signing in. It
leaves out what anyone wrote (review notes, reports, check commands and
closing notes), the diffs, every form and every link into the signed-in
pages. Every email address goes too: from task and project titles, and from
the agent names read from commit trailers in the history before Atelier,
where a name that is only an address is not taken. The owner adds a project
with `atelier showcase set NAME [--named|--anonymous]` or the form on the
signed-in Home page, and takes it off with `atelier showcase remove NAME`.
Anonymous is the default: the project's card and stories carry a neutral
label from its kind, never its name, a task title, a path, a commit message
or an address. The `SHOWCASE` variable (names separated by commas, each
optionally followed by `:named` or `:anonymous`; a bare name is shown named)
seeds the same setting and overrides it for the names it lists. Nothing is
public until a project is named, and the page is cached for a minute. The
showcase is the front door: `/` serves it to everyone, signed in or not
(`/showcase` serves the same page), and its header's Sign in leads to
`/login`, which opens the owner's Home at `/home`.

**Protected actions.** An action whose effect reaches beyond the repository
and cannot be taken back by a revert (a deploy, a device install, a push of
the project's branch to its own remotes, a paid model run, a Photos
writeback, or a kind the project's ship files name) runs only with the
owner's approval for one exact revision of the main line, and each approval
is used by one run:

```sh
atelier approve deploy --head "$(git rev-parse HEAD)" --note "release 12"
atelier ship --dry-run
atelier ship
```

`atelier ship` composes the order from the project's own files
(`docs/atelier/ship.json`, or ControlPlane's ship policy), refuses before
running anything when a protected step lacks its approval, stops at the
first failure, never forces a push, and records every step on the ledger.
The ship files and what they run are protected like check scripts. The
design is [docs/ship.md](docs/ship.md); the local harness that runs a task
is the owner's own user, which no server rule confines, and the design for
confining it is [docs/harness-confinement.md](docs/harness-confinement.md).

**The owner's own work.** Sessions of direct work in the registered checkout
(`atelier unwrap` and `atelier wrap`), projects that use Git LFS or have a
history too large for Artifacts, removing and renaming projects, the private
operations toolkit behind `atelier ops`, and cleaning finished workspaces
with `atelier gc` are in [docs/owner.md](docs/owner.md). Projects governed by
ControlPlane, and moving one to Atelier with `atelier adopt`, are in
[docs/control-plane.md](docs/control-plane.md).
[docs/using-atelier.md](docs/using-atelier.md) is the owner's guide to using
Atelier well, and [docs/orchestrating.md](docs/orchestrating.md) the
handbook for a session that runs Atelier for a project.

## Costs and usage

**Artifacts.** Artifacts bills operations and storage from 14 October 2026:
the first 10,000 operations and 1 GB each month are included in Workers
Paid, then $0.15 per thousand operations and $0.50 per GB-month. One task
uses a fork, a few token mints and a handful of pushes, fetches and clones,
so ordinary use should stay inside the included allowance. That is an
estimate from the operations the CLI performs, not a measurement.

**Model usage.** `atelier runner --usage`, run on each machine that runs the
harnesses, reports Codex's 5-hour and weekly windows, the requests, tokens
and cost that zcode and opencode recorded by served model, and the DeepSeek
balance. The Usage page shows the last report of each tool, and the Worker
sends an ntfy alert once when a figure crosses the owner's threshold.
Claude's plan limits and Gemini's spend have no record on the machine and
are not reported.

**Each model's record.** The Models page and `GET /api/reliability` show,
for every model across every project, how much of its work was approved at
first review, how many rounds a merged task took, its rejections, defects
traced to its accepted work, its reviews' precision, and the runs that
failed. Routing reads the record only to order candidates of equal score.

[docs/models-and-usage.md](docs/models-and-usage.md) holds the pool, the
record, the usage thresholds and the AI Gateway figures in full.

### AI Gateway costs

Calls that runners send through Cloudflare AI Gateway are counted by
Cloudflare, not by a tool's record on a machine. Each time the Models page or
`atelier runner --usage` is asked for, the Worker sends one query to the
GraphQL Analytics API for the last 7 days of the gateway: each model's calls,
failed calls, tokens in and out, cost, and median and 90th percentile
duration. Set it up once:

1. Give the Worker the account id (the dashboard shows it on the account's
   overview) as the secret `CF_ACCOUNT_ID`, so the public source names no
   account; unset, it keeps the figures off. `AI_GATEWAY_ID` under `vars` in
   `wrangler.jsonc` names the gateway and defaults to `atelier`.

   ```sh
   npx wrangler secret put CF_ACCOUNT_ID
   ```
2. In the dashboard, under My Profile → API Tokens → Create Token → Custom
   token, create a token with the permission Account · Account Analytics ·
   Read, scoped to this account only, and give it to the Worker:

   ```sh
   npx wrangler secret put ANALYTICS_TOKEN
   ```

   Without it the Models page says
   "AI Gateway figures are off: set ANALYTICS_TOKEN".

Runners point opencode's pay-per-use providers at the gateway, with a
`cf-aig-authorization` header carrying a gateway token; the configuration is
in
[docs/models-and-usage.md](docs/models-and-usage.md#ai-gateway-costs).

## What is enforced and what is trusted

Enforced by construction:

- one owner per item, because the project's Durable Object handles one
  request at a time;
- one live write token per workspace, minted for the owner and revoked on
  handoff, release or abandonment;
- observed evidence tied to the head Atelier reads from Artifacts, not the
  head an agent reports;
- acceptance only through the gate, and merging only of the accepted head.

Trusted, and stated here so nobody assumes otherwise:

- **Agent tokens prove identity.** An agent token binds requests to one actor
  and optionally to projects. The owner token still permits declared actors
  for orchestration. Keep it with the owner's tools. A workspace write token
  controls Git pushes and is separate from an API token.
- **Git credentials stay off the command line.** The CLI hands every
  Artifacts token to git through git's environment (`GIT_CONFIG_COUNT`,
  `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`), never as an argument, because
  any local user can read a process's arguments with `ps`. A workspace keeps
  its write token in `.git/atelier-credentials`, readable only by its user
  (mode 0600), which `.git/config` includes; anything running as that user
  can still read it.
- **Check execution is explicit.** Local checks run in a clean clone at
  the verified head, but a caller authorised to record checks, the item's own
  agent included, can forge a local result. It cannot forge what the change
  touches: the changed paths are measured by the Worker from Artifacts for
  every check, so a protected change always needs its independent review,
  whatever a local result says. Cloudflare container checks execute on the
  server and are available with `--sandbox`; `sandboxOnly` policy requires
  that evidence.
  The container integration still needs deployment and a live runtime check.
- **A local check runs with the caller's file access.** `atelier check`,
  `finish` and `done` run the item's check code on the caller's machine as
  the caller, so it can read their files and Keychain and reach the network.
  It is given only the environment variables toolchains need: `PATH`,
  `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TMPDIR`, `CI`,
  `DEVELOPER_DIR`, `TOOLCHAINS`, the Node and OpenSSL certificate settings
  and `npm_config_*`. It never gets `ATELIER_*`, `SSH_AUTH_SOCK` or a
  variable whose name says it holds a token, key, secret, password or
  credential; a check that needs another variable sets it in its own
  command. Before the output is printed or uploaded as evidence, the CLI
  redacts the API token, the read tokens for the fork and the baseline, and
  the workspace's write token. Redaction matches each token exactly as
  written, so a check that prints one encoded, reversed or in pieces is not
  caught. Run untrusted code in the sandbox: `atelier check --sandbox`,
  `atelier finish --sandbox`, or a project registered with
  `atelier init --sandbox-only`.
- **Merging happens locally.** The Artifacts binding and REST API can read
  repositories (commits, trees, blobs, files, a first-parent log) but cannot
  write. The only way to write is a git push with a write token, so Atelier
  merges in git on the owner's machine and pushes. The iCloud checkout is the
  source of truth.

## Development

`npm run dev` serves the Worker on localhost; the Artifacts binding reaches
the real account even then, so local runs create real repositories. `npm
test` runs the pure functions under `node --test` and the `test/*.spec.ts`
files inside the Workers runtime against the Ledger Durable Object; `npx tsc
-p . && npx tsc -p test` type-checks both. `node test/preview.mjs` serves a
read-only preview of the pages with illustrative content.
[docs/setup.md](docs/setup.md#local-development) has the details.

### Concurrency proof

`bin/concurrency-proof.mjs` drives N simulated agents (N up to 1,000,
configurable) against a throwaway project over the CLI's own request protocol
(the owner token as a bearer header, `x-atelier-actor` naming the agent) and
reports what the run measured. It proves three things, and asserts each before
exiting cleanly:

- **claim spread** — N agents claim N tasks at once; all N succeed and each
  gets its own fork;
- **claim race** — N agents race for one task; exactly one wins and the other
  N-1 are refused, each refusal naming the holder;
- **pushes** — with `--push`, each agent makes a tiny commit and pushes it to
  its own fork, and the push is observed at that fork's head (without
  `--push` no push is made and the phase is skipped, so the run stays cheap).

It then abandons every task it created and prints per-phase throughput and
median and p90 latency, every error, and the cost of the run (wall time and
request count; the agents are simulated, so the model cost is $0):

```sh
bin/concurrency-proof.mjs --project throwaway --agents 1000 --push
```

The tests run it against a stand-in server on localhost
(`test/concurrency-proof.test.mjs`); the proof is never run against the live
server. The figures below are one measured run against that stand-in, a single
Node process on this machine, included because the brief asks for measured
numbers rather than claims — they are not the live server's latency:

```
N=1000: claim spread 1000/1000 ok with 1000 distinct forks, median 77.3ms,
p90 78.1ms; claim race 1 winner, 999 refused each naming the holder, median
47.8ms, p90 48.6ms; cleanup 1001/1001; ~9172 req/s over 0.436s, 4002 requests.
```

The request count is every request the run sent — the 1001 that created the
tasks and the race, the 2000 claims, and the 1001 abandons. With `--push`, the
proof also reports how many of the git pushes ran at once (its peak live git
subprocesses): the pushes are concurrent, so all N overlap, and that figure is
asserted in the tests.

A run against the live server prints the live numbers; this README reports
only what a run measured.

## Licence

MIT. See [LICENSE](LICENSE).
