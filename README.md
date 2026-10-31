# Atelier

For developer-token examples, set the acting model for the session:

```sh
export ATELIER_ACTING=claude-code/opus-5.5
```

Use your own registered harness/model. Owner commands such as `ship`,
`wrap`, `branch push|fetch`, `plan show`, `projects` and `import-tasks` keep
the owner actor and use `ATELIER_ACTING`; do not add `--as` to them.
Commands that act as a builder or reviewer use `--as H/M` to name that actor. Agent and runner tokens
name their own actors; leave `ATELIER_ACTING` unset with those tokens.

**Git keeps the code. Atelier brings the receipts.**

A Git platform for multiple coding agents, run from one Node server on your own machine.

Atelier is a multi-agent system for software work, built on Git: a planner
splits a goal into parts, builders of several model families work them at
the same time, each on a branch of its own, reviewers of another family check each
change, an integrator assembles the parts, and the developer, the one person the
project belongs to, decides what merges. None of them can trample another's work or
theirs. It runs as one Node server with a SQLite file for each project's
record and plain Git repositories, and is driven by a dependency-free
command, `atelier`, that any agent able to run a shell command can use.

Since the 2026-10-31 cut-over, Atelier 2.0 runs on the Mac called the Studio.
Main ships to production at [atelier.zone](https://atelier.zone); staging at
next.atelier.zone ships from the separate `atelier-trial` project. One page
at atelier.zone is public: [How it works](https://atelier.zone/how) states the
rules the code enforces and lists every command. The domain's root leads to the developer's
projects list, behind the sign-in, and each project's own page draws its work
as it was built by agents of several model families: each task, who held it,
its checks, reviews and decisions.

## What Atelier enforces, and why

Agents sharing a repository overwrite each other's work, report checks that
never ran, and approve their own changes. Atelier answers each of these with
a rule the server enforces, not a convention. A task lives in five steps,
and each has its rule.

### Claim

**One holder per task.** A task (an *item* in the API) has exactly one holder
at a time, granted atomically by the project's Ledger (its SQLite file) when an agent
runs `atelier start`, so a second claimant is refused. A task changes holder only
by a recorded handoff, which revokes the old Git grant.

### Branch

**Every task its own branch.** Each project is one Git repository on the
Atelier server. Each task works on a branch of it, `t/N`, its *workspace*,
and its holder has the only write grant for it. The server's pre-receive
hook refuses a push to any other branch ([docs/branches.md](docs/branches.md)),
so multiple agents work concurrently without touching each other's files.

### Prove

**The checks run on the exact head.** `atelier check` runs each required
check in a clean clone of exactly the head Atelier reads from the repository, on
the machine that asks (an agent's or a runner's). Atelier records the result
as *Observed* only when it names that head, with the paths the change
touches, which Atelier measures itself. The pass or fail of a run is the word
of the machine that ran it. Anything
an agent says it did is *Reported*: shown, never counted. A required check
with no observed result at the current head is *Pending*. Only Observed
passes count.

The same can be done in steps: `atelier accept ID` then `atelier merge ID`,
or `atelier merge ID --head FULL_SHA`, which accepts a submitted task at
that exact revision first. `--approve` on that merge records the developer's own
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

**Another company reviews, or in single-family mode another model.** A
change to a protected path needs approval from a model of another family than
every recorded contributor by default; in single-family mode, a different
model of the project's one company from every contributor. The
developer's approval is not that review; without one, they can accept only
by recording an override with its reason. Independence is enforced against
agents, whose tokens are bound to their own actor. The developer token can
act for anyone, a reviewer included, so the developer is trusted.

The cross-company rule above is the default policy. With
`atelier init --single-family COMPANY`, building and reviewing use only that
company's models: a reviewer must be a different model from every contributor,
never a contributor under another harness. This exception also applies to
criteria review, handoffs and conflict contributors. Only that company's tier
models qualify; if none qualifies, no separate tier review is requested.
`atelier init --cross-family` restores the default; both switches record who
made them and when. See [Single-family mode](docs/gate.md#single-family-mode).

### Land

**One merge at a time, with a receipt.** The developer is the person
the project belongs to; in the API they act as a reserved actor, `owner`
unless the deployment names another. Work reaches the project only when the
developer accepts one exact head through the gate and it merges, one merge per
project at a time (`atelier land` holds the project's landing lease for the
merge), with
the task's record attached to the merge as a git note: its receipt. A goal
too large for one task is split by a planner model into parts; once the
developer approves the split, each part is claimed on a branch of its own,
proven and reviewed by a model of another family the same way, and an
integrator merges it onto the plan's own branch, which lands as one task.

**Proven. Reviewed. Recorded.** What lands has every required check observed
passing at its exact head, an independent review where the change needs
one, and its whole history in the ledger. Git keeps the code. Atelier brings
the receipts.

The web inbox answers one question, *what needs the developer now?*, and
ranks the things a person must decide above the things an agent must fix.

## Git alone, and with Atelier

Atelier sits on Git: every project is a Git repository on the server, every
workspace a branch of it, and a merge is a Git merge. What Git and a forge leave open is everything around
the commit when multiple agents work at once, and that is what Atelier adds.

| The question | With Git and a forge alone | With Atelier |
| --- | --- | --- |
| Who holds this work? | Commits record authors, not who holds the work; two agents can take the same task, and a crashed one leaves its branch half done. | One holder per task, holding the only write grant for its workspace; a handoff is recorded and revokes the old grant; a restarted runner takes back the jobs a dead run left. |
| Did the checks really pass? | An agent reports that the tests passed, and the report is believed. | The required checks run in a clean clone of the exact head Atelier reads, and a merge is refused until every one is observed passing there. |
| Who checked it independently? | A model can review, and approve, its own work. | A change to a protected path needs approval from a model of another family than every contributor, and an agent's token speaks only for that agent. |
| Is main still sound after the merge? | Branches drift from main, and what merges may not be what was reviewed. | One merge at a time under a lease: main is merged in, checks run again, and the exact head that was reviewed is the one merged. A plan's parts are integrated on the plan's own branch first. |
| What needs the developer now? | A stream of pull requests and notifications. | A decision inbox, ranked, each entry with a recommendation; `atelier land` takes a task from review to merge in one command. |
| Which model is worth it? | Nothing records it. | Each model's track record and reliability from the ledger, and its calls, cost and latency from AI Gateway. |
| Who did what? | Commit metadata, which an agent writes itself. | Every claim, push, check, review, decision and merge is an event in the ledger, and each merge's builder, reviewer and head go into Git as provenance notes. |

The record shows what this catches. Atelier's own project was read from its
ledger at 2026-10-12 23:03 UTC with `atelier ls --all --json` and then
`atelier receipt ID --json` for each of the 568 items listed, counted the way
`video/scripts/derive.mjs` counts them. Models recorded 681 reviews; 268 sent
the work back, with 360 findings marked blocking, each found before the
change merged. Of the 365 merged by then (364 tasks and one plan), 317 carry
an approval from another model family at the revision that merged, and every
task merged from 22:11 UTC on 2026-10-06 to that reading does (228 tasks),
since the project developer extended the rule to every path in the project
that day. The public showcase that then stood at atelier.zone counted
live, so its figures have moved on since: read on 2026-10-13 for Gemini 4
Argon's claims audit, it showed 379 merged, all time, and, counted apart, 13
landed in fast mode. Those 13 landed on 2026-10-13, when the developer had
switched the project to fast mode while Artifacts, which held the 1.x
repositories, failed to create forks; a
task landed in fast mode is reviewed, when the developer asks for a review, after
the merge, not before it.

## What runs where

Atelier 2.0 is one Node server and the files it keeps, on the Studio (the
developer's Mac on the tailnet). Cloudflare still provides the tunnel, Access,
DNS, R2 for backups and AI Gateway analytics. [docs/studio.md](docs/studio.md)
holds the Studio's layout and its backups.

| Part | What it does in Atelier | State |
| --- | --- | --- |
| Node server | `node cli/serve.mjs` runs `src/index.ts` over Node's `http` (`src/runtime/server.mjs`): the API the CLI calls, the signed-in pages and the public pages. One process per environment, on port 4100 for production and 4101 for staging. The stage tick, stuck episodes and model snapshots run on timers inside it. | Live on production, atelier.zone, and on staging, next.atelier.zone |
| SQLite Ledgers | Each project's tasks, events, evidence and reviews are one SQLite file (`node:sqlite`, mode 600) under `DATA/ledgers`. Calls to one Ledger never interleave, which is what makes one holder per task hold (`claim` in `src/ledger.ts`). The index, `ledgers/__index.sqlite`, keeps what spans projects: the project list, agent tokens, the model pool, runner offers, usage and run reports. | Live on production and staging |
| Plain Git | One bare repository per project, served at `/git/PROJECT.git/` through `git http-backend`. A task works on the branch `t/N`; the server reads commits, trees and diffs from the repository to measure what a change touches and to preview its merge. Every credential is a grant the server minted, and `hooks/pre-receive` refuses any ref update the grant does not cover. `hooks/post-receive` reports each push to the server. | Live on production and staging |
| `atelierd` | The macOS service user that runs the server and owns the data, the repositories and the secrets; the server's code and its hooks are root's, read-only to it. Builders run as another user, who cannot read any of these. | Live on production and staging |
| Tunnel and Cloudflare Access | `cloudflared` carries atelier.zone to production and next.atelier.zone to staging. Access guards the developer's pages; the server verifies its assertion and the developer's email on every signed-in route ([setup](docs/setup.md#cloudflare-access-in-front-of-the-developers-pages)). `/api/*` and `/git/*` stay outside Access. | Live on production and staging |
| R2 backups | Nightly, `cli/backup.mjs` copies every Ledger, bundles every repository, packs and encrypts the result with age and uploads it to R2; 30 days are kept. `cli/restore.mjs` decrypts on the developer's Mac. | Live: installed on the Studio for production and staging by `scripts/studio/setup-backup.sh` |
| AI Gateway | Runners point opencode's pay-per-use providers at the gateway `atelier` (DeepSeek, OpenRouter and the API-key providers, each base URL `https://gateway.ai.cloudflare.com/v1/{ACCOUNT}/atelier/{provider}`); every call carries a `cf-aig-metadata` header naming the task, role and runner, and subscription harnesses stay direct. | Live: the home runners' DeepSeek and OpenRouter calls go through it ([AI Gateway costs](#ai-gateway-costs)) |
| GraphQL Analytics API | The Models page and `atelier runner --usage` read the gateway's calls from it (`src/usage/gateway.ts`): each model's calls, failures, tokens, cost, and median and p90 duration over the last 7 days. | Live: the Models page shows each model's calls, failures, cost and durations |
| Large objects | Large check logs and review diffs (`src/large.ts`) are files under `DATA/large`, named in briefs and the ledger by a reference ending in the payload's sha256, instead of carried inline. | Live on production and staging |

## Quickstart

From a clone to a first task landed. It needs Node 24 or later (`engines`
in package.json; see docs/runners.md for how runners reload) and git. The
server runs on the machine you choose; no Cloudflare account is needed to
run it.

**Try it without a server.** Nothing below needs a server until step 2. Atelier 2.0's
single public page, [atelier.zone/how](https://atelier.zone/how),
states each rule the code enforces and lists every command. The root at
[atelier.zone](https://atelier.zone) redirects 302 to `/home`, behind
Cloudflare Access sign-in. On your own
machine, step 1 installs and tests everything, and

```sh
node test/preview.mjs
```

serves a read-only preview of the pages with illustrative content, with no
account or token and no call to any Atelier server (the pages load their
fonts from Google Fonts); it prints its address
([Local visual review](docs/setup.md#local-visual-review)).

**1. Build and test.**

```sh
git clone https://github.com/pavithran/atelier
cd atelier
npm ci && npm test
```

`npm test` runs the whole suite under Node, with `node --test`; no Cloudflare
runtime is involved ([Local development](docs/setup.md#local-development)). On
the developer's Mac, on 1.x, the 143 landing check
runs that passed from 2026-10-11 to 2026-10-12 (each `npm ci`, the suite
and the typecheck, in a clean clone) took 4.4 to 10.6 minutes, median 6.0
(the `land.check` events in the ledger).

**2. Run the server.** `node cli/serve.mjs` is the whole server. It needs a
data directory, which it creates, and a secrets directory holding one file
per setting. Choose a server token (a random one is fine, kept where you
can paste it from) and run it on this machine alone:

```sh
mkdir -m 700 ~/atelier-secrets
openssl rand -hex 32 > ~/atelier-secrets/ATELIER_TOKEN
chmod 600 ~/atelier-secrets/ATELIER_TOKEN
node cli/serve.mjs --env production --data ~/atelier-data --secrets ~/atelier-secrets --host 127.0.0.1
```

`--env` is `production` (port 4100) or `staging` (port 4101); `--port`
overrides the port, and `--host` defaults to every address. `--repos` and
`--hooks` move the repositories (default `DATA/repos`) and the hooks they
name (default this checkout's `hooks/`). A setting is a file in the secrets
directory named for it, or an environment variable of the same name; the
names are listed as `SETTINGS` in `src/runtime/server.mjs`. On a machine
that other users share, keep the secrets directory readable by the server's
user alone. The server ends cleanly on SIGTERM and SIGINT.

On the Studio the server runs as the service user `atelierd` under a
LaunchDaemon. `scripts/studio/setup-server.sh --env staging|production` installs it,
`setup-tunnel.sh` adds the tunnel and Access, `setup-backup.sh` the nightly
backup and `setup-restore.sh` the restore; [docs/studio.md](docs/studio.md)
holds the layout and the backups.

`GET /api/version` reports the commit the server runs and its route level.
`atelier land` refuses to run against a server whose route level is below the
CLI's.

The server token is not enough for everything. Overriding a review that no
model qualified to give needs the developer's own confirmation, a factor no agent
session holds: either the developer's pages behind Cloudflare Access, or a
confirmation secret, `OVERRIDE_SECRET`, a second file in the secrets directory.
A server with neither confirms no override (`NO_OWNER_FACTOR` in
`src/rules.ts`). [Confirming an override](docs/setup.md#confirming-an-override)
sets up either.

**3. Install the CLI and sign in.** `login` asks for the token, checks it
against the server, and only then stores it (in the macOS Keychain, the
Linux Secret Service or a file readable only by you):

```sh
npm link
atelier login --server http://127.0.0.1:4100
```

The server is `https://`, or plain `http://` on this machine or on the
tailnet (100.64.0.0/10), which WireGuard encrypts. A machine off the tailnet
uses the public origin the tunnel serves.

**4. Register a project.** In the Git checkout of a project whose tests run
with `npm test`:

```sh
atelier init --title "My project" --check "npm test" --commit-name "Demo User" --commit-email demo@example.com --as claude-code/opus-5.5
```

`init` creates the project's bare repository on the server, pushes the current
branch to it (the one push of that branch the server token makes; later commits
reach it by a landing), and prints the policy it recorded: the branch, the required checks (each
shown read-only) and the protected paths. Without `--protect`, those are
`AGENTS.md`, `CLAUDE.md`, `wrangler.*` and `.atelier/prompts/**`, with every
file a check executes (here `package.json` and `.npmrc`, which decide what
`npm test` runs).

**5. File a task and do it as an agent.** `new` prints the task's id, here
`t1`:

```sh
atelier new "Fix the off-by-one in pagination" --scope "src/**" --as claude-code/opus-5.5
atelier start t1 --as claude-code/opus-5.5
```

`start` claims the task, makes the branch `t/1` at the project branch's tip,
clones it as the workspace and prints its path. Change the code there and commit, then, still in the workspace:

```sh
atelier done "Fix the off-by-one in pagination" --as claude-code/opus-5.5
```

`done` pushes, runs the required checks in a clean clone of the pushed head,
and submits only when they pass and the head has not moved. Its last line
says `Ready for the developer` or names what still blocks the task. Here the
developer's token acts for the agent named by `--as`; a real agent gets a token
of its own (see [Further setup](#further-setup)).

**6. Land it.** Back in the project checkout:

```sh
export ATELIER_ACTING=claude-code/opus-5.5
atelier land t1
```

Export `ATELIER_ACTING` so the child `accept` and `merge` commands inherit the acting model; `land` does not forward `--as`.

`land` checks the task's head without the project's landing lease.
This task needs no review if it changes only unprotected paths. When the
gate requires a review and no approval covers the head, name a qualifying
reviewer with `--reviewer H/M`; a live runner or local runner config with
that model and its agent token must be able to serve it. If approval is
missing, it records a land request and stops without waiting. Run it again after approval. Once
the head is approved (or needs no review) it takes the lease for the merge alone, accepts the task, merges it
into the checkout with `--no-ff`, runs the required checks on the merged
tree, and pushes the merge to the project's branch on the server with a
landing grant. Nothing is pushed to the task's branch, so the reviewed head
is the one merged. The merge commit carries
the task's provenance as a git note on `refs/notes/atelier`, and the command
prints how to read it. A change to a protected path needs a review
from another model family, which a runner serves; see [Review](#review) and
[Runners](#runners).

[docs/demo.md](docs/demo.md) walks a whole plan through the same server,
with what each command prints.

## Concepts

In outline: the project's main branch lives in the baseline, the bare
repository on the server. Each task is a branch of it, `t/N`, its
workspace. Agents work in their workspace, push to it, and run checks
against it. The developer merges accepted work into the real checkout, and
the merge is pushed to the baseline.

| Step | Who | What happens |
| --- | --- | --- |
| `atelier init` | the developer, in the project checkout | Creates the baseline repository and records the project's branch, required checks and protected paths. Every check must be read-only. |
| `atelier new "title" --scope GLOB` | the developer | Creates a task. The scope is what it intends to touch; overlapping live scopes are flagged. |
| `atelier claim t3 --as H/M` | an agent | Grants the task atomically, makes the branch `t/3` at the project branch's tip, mints a task grant for the holder alone, and clones the workspace. |
| `atelier push` | the task's holder | Pushes `HEAD` to `t/3`; the server's post-receive hook reports the push. The ledger records the head Atelier saw, not the one the agent named. |
| `atelier check` | the task's holder | Runs each required check in a fresh clone of that head on the caller's machine and records the results as Observed with the paths the change touches, which the server measures itself. |
| `atelier submit` | the task's holder | Marks the task ready; the gate states what still blocks it. |
| `atelier handoff t3 --to H/M` | the task's holder or the developer | Moves the task to a new holder and revokes the old grant; the workspace carries over. |
| `atelier review t3 --approve` | a model that did not work on the task | Required when the change touches a protected path, from another family than every contributor. |
| `atelier accept t3` | the developer | Allowed only when the gate is clear; pins the accepted head. |
| `atelier merge t3` | the developer, in the project checkout | Merges exactly the accepted head with `--no-ff`, attaches the provenance note and pushes the new main to the baseline with a landing grant. |

The **gate** for acceptance is a pure function in
[`src/rules.ts`](src/rules.ts). It requires every required check that
applies to the change observed passing at the current head; the changed
paths observed; no required check failing on the merge with a main that
moved after the head's own checks passed; no rejection at that head; and, if
a protected path changed, an approval at that head from a model of another
family than every recorded contributor's, or the developer's override of that
review. A model's family is read from its name
([`src/models/pool.ts`](src/models/pool.ts)); a family no name pattern
recognises never qualifies.

The files a check executes are protected automatically (a script it runs,
the `package.json` npm reads its scripts from, a `Makefile`, and others), so
a task cannot quietly weaken the check that grades it. A check must be
read-only: a command that deploys, installs, publishes, pushes, reaches
another machine or spends money is refused at `init`. A check may apply only
to changes that touch certain paths. The changed paths are measured by the
server against main as it is now, so no history an agent pushes can hide
one.

[docs/gate.md](docs/gate.md) holds the whole lifecycle, every rule of the
gate, check classes and checks that apply to some paths.

## Further setup

[docs/setup.md](docs/setup.md) holds every detail of this section.

- **Agent tokens.** Register the actor first with
  `ATELIER_ACTING=claude-code/opus-5.5 atelier models add gpt-6-astra --harness codex --where cloud`.
  Then give it a token, bound to one actor and shown once: `atelier token issue --as codex/gpt-6-astra --project
  my-project --days 30 --label "Task runner"`, then `atelier token ls` and
  `atelier token revoke ID`. Set `ATELIER_TOKEN` to it in the agent's
  session. Agent tokens can claim, push, record checks and reports, submit,
  hand off, release and review as themselves; creating tasks, developer
  decisions, project settings and token management need the developer token.
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
- **The developer's actor and name.** Set `OWNER_ACTOR` and `OWNER_NAME`, and
  `TIMEZONE` to an IANA zone for the pages' times, each a file in the secrets
  directory.
- **Project policy.** `atelier init` again changes only what it names.
  `--protect GLOB` sets the protected paths, `--refuse-overlap` refuses a claim whose scope
  overlaps a live task's, `--regenerate CMD` names the command that
  regenerates fixtures during a landing, and `--review-bar TEXT` states what
  may block a review.
- **Notifications.** Set `NTFY_TOPIC` (a file in the secrets directory) to have an ntfy message sent when a
  submitted task reaches the developer's inbox.

## Daily use

### Tasks

The developer files a task with `atelier new "title" --scope GLOB`, and
may frame it with `--non-goal`, `--stop-when` and `--next-gate`; `atelier
edit` changes that framing later. An agent then needs two commands:

```sh
atelier start ID --as claude-code/opus-5.5
# Work in the printed workspace and commit the changes.
atelier done "What changed and why" --as claude-code/opus-5.5
```

`start` claims the task, prepares the workspace as `claim` does, and prints
its title, scope and any dispatch note. Pass `--project NAME` when running
outside a registered checkout. `done` runs inside the task workspace. It
pushes, runs the required checks and submits the summary only after checks
pass and the revision remains unchanged. It stops at the first failed step
and names that step. The individual steps remain available: `claim`,
`push`, `update` (take the project's branch: a merge that regenerates declared outputs, or a rebase), `check [--merged]`,
`report` (a Reported claim), `submit`, `handoff`, `release`, and `block`
with `unblock` for a task waiting on something outside it.

`atelier inbox` prints each task that waits on the developer, one per task with
what to do and the link to do it (docs/owner.md, "What waits on the developer").
`atelier show ID` prints a task's decision brief with
the recorded evidence, a recommendation and the task's address; an agent
can relay that text unchanged. Both accept `--json`; the same brief is
`GET /api/projects/NAME/items/ID/brief`, which requires sign-in. The developer
still decides whether to accept and merge. `atelier ls` lists the
project's tasks, and `atelier status` prints what waits for the developer across
every project.

### Plans

A plan turns one goal into several tasks that merge together. The developer
states the goal with `atelier plan "goal" [--scope GLOB]... --planner H/M`.
The planner must be named. Without it, Atelier refuses and lists candidates.
A project has one active plan at a time.

A runner that offers plan jobs claims the plan item, which makes the
plan's integration branch, `plan/N`. It fetches the planner's brief
from the server (the goal, the scope and the schema to write), runs the
harness, posts the plan document (`atelier.plan.v1`: the goal and its parts,
each with a scope, dependencies, a brief and acceptance criteria) with
`atelier plan post ID FILE`, and releases the claim. An invalid document is
refused with every error, and the planner gets one more attempt before the
plan blocks.

`atelier plan show ID [--json]` prints the newest proposal with its hash.
`atelier plan approve ID --hash HASH --route KEY=BUILDER:REVIEWER [--allow-paid]` approves that exact
split, once; an older hash is refused, and `atelier plan revise ID --note
TEXT` sends a proposal back instead. Approval fixes the limits (two parts
live at once, three attempts a part, four dispatches a part, 24 hours) and
each part's routing: the builder and reviewer named by `--route` for every
part. The reviewer must be independent of the builder. No alternates are
stored. Without every route, approval is refused and lists candidates. The parts become
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
into the plan's branch so later parts start from an updated basis. Once every
part integrates, the integrator submits the plan item, and the developer lands
it whole: `atelier merge ID --head SHA`.

A plan that reaches a limit blocks and appears in the inbox; the developer
decides with `atelier plan retry ID`, `atelier plan reroute ID --to H/M`,
`atelier abandon ID --quote "Abandon this task"` or `atelier plan stop ID [--note TEXT]`, which closes
the plan and its open parts and revokes their Git grants. History and
evidence stay. [docs/orchestrator.md](docs/orchestrator.md) is the design.

### Landing

`atelier land ID --reviewer H/M` lands a single task from the registered
checkout. Before taking the lease, it checks and submits a claimed task at
its recorded head. A submitted task keeps its checked head. The landing
asks the named reviewer and records a land request. If approval is still
missing, it stops without waiting. Run it again after approval. Without a named reviewer, a needed review
is refused with the candidates listed.

With the gate satisfied, the landing takes the project's lease, accepts the
head, and merges it into the project's branch in the registered checkout.
It regenerates when policy declares how, checks the merged tree in a clean
clone, and pushes only the merge to the project's branch. It never writes
`t/N` (the task's branch). If main races the push, it undoes the merge and
merges and checks again, at most twice. A third refusal leaves the task
accepted with its approvals.

`--no-review` leaves the task submitted for the developer to settle.
`--dry-run` prints the steps without changing anything. Each step is a
`land.*` event. See [docs/landing.md](docs/landing.md).

### Review

A change to a protected path needs approval from a model of another family
than every recorded contributor: every actor who ever held the task, and the
push contributors Atelier recorded. A model's family is read from its name;
models are compared without letter case or a `:profile` suffix, and a name
the model registry ([`src/models/registry.ts`](src/models/registry.ts))
lists for a model, such as `claude-opus-5-5` for `opus-5.5`, is that model.
The developer may review too, and their rejection blocks, but their approval
never counts as this review.

A plan's part gets its review request automatically on submission. A single
task gets one when the developer lands it. A runner that offers review jobs
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
for a correctness, security or data-loss defect that the change introduces,
or fails to fix while claiming to, a behaviour change without a test that
covers it, docs or help that now contradict the code, a breaking change to a
command, route or API field without a migration, or a visible regression on a
user-facing page; anything else is a follow-up. `atelier init --review-tier
H/M,H/M` names a top tier of reviewers. A qualifying tier model's gate
review serves both. When a separate tier review is needed, Atelier records
the need and candidates. Request it with
`atelier review-request ID --reviewer H/M --tier-review`.

The developer records a verdict on each finding with `atelier finding ID --head
SHA --index N --verdict confirmed|refuted|fixed`. A later review of the task
shows the reviewer each earlier finding with the developer's verdict, and the
record counts each reviewer's precision.

### The receipt of a task

`atelier receipt ID` prints one task's whole story from the ledger, in the
order it was recorded: created, claimed, each handoff and release, each pushed
head as the server read it, each observed check at each head, each review
with its verdict and every finding, each finding judged by the developer
(confirmed, refuted or fixed), then the submission, acceptance and merge or
abandonment that ended it. `--json` carries the task's events as the ledger
holds them, in order. This is t278's receipt, recorded on 1.x; 2.0 prints "observed in
the repository" where it shows "observed in Artifacts", and the rest is the same:

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
and rejected it twice, each time for a real data-loss defect, and the developer
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

The developer sends a task to a kind of runner with `atelier dispatch ID --to
home|cloud|any --agent A --model M`, or "Send to an agent" on its page.
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
`~/.config/atelier/`, never the value); without one the review is refused,
naming the token to store, and never recorded by the developer token. The
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
waits on the developer, what is queued for a runner, the last five merges and
the latest handoff notes. It ends with whether this machine's checkout is in
step with the baseline and, for tasks with a workspace on this machine, what
each holds locally. The project page and `GET
/api/projects/NAME/standing` give the same.

**The signed-in pages.** Decisions puts reviews and blockers across projects
beside the selected task; Flow draws each task as a thread from main and
back; History keeps merged and closed tasks with their evidence; Studio
draws one lane per live task, banded by who held it; Models and Usage show
the pool, each model's record and spend. On a server without Cloudflare
Access, only the developer token signs in to the browser; behind Access, the
developer's Access sign-in starts the session with no token to paste
(docs/setup.md).

**The public pages.** `/how` explains what Atelier is, draws the loop from
task to merge, states the rules the code enforces, marks which parts of the
orchestrator are built, and lists every command. It reads no project and no
setting, and its command reference is drawn from `src/usage.ts`, the table
`atelier help` prints from; `test/how.test.ts` checks that the rules and
labels it names still match the code. The domain's root and `/showcase`
answer 302 to `/home`, the projects list, where a visitor who is not signed in
meets the sign-in as at any owner page; `/login` opens the developer's Home.
Each project has a showcase page of its own at `/p/NAME/showcase`, drawn from
that project's record and read after signing in.

**Protected actions.** An action whose effect reaches beyond the repository
and cannot be taken back by a revert (a deploy, a device install, a paid
model run, a Photos writeback, or a kind the project's ship files name) runs only with the
developer's approval for one exact revision of the main line, and each approval
is used by one run. Pushing the project branch to its own remotes needs no
protected-action approval:

```sh
atelier approve deploy --head "$(git rev-parse HEAD)" --note "release 12" --quote "Deploy release 12" --as claude-code/opus-5.5
ATELIER_ACTING=claude-code/opus-5.5 atelier ship --dry-run
ATELIER_ACTING=claude-code/opus-5.5 atelier ship
```

`atelier ship` composes the order from the project's ship file
(`docs/atelier/ship.json`), refuses before
running anything when a protected step lacks its approval, stops at the
first failure, never forces a push, and records every step on the ledger.
The ship files and what they run are protected like check scripts. The
design is [docs/ship.md](docs/ship.md); the local harness that runs a task
is the developer's own user, which no server rule confines, and the design for
confining it is [docs/harness-confinement.md](docs/harness-confinement.md).

**The developer's own work.** Sessions of direct work in the registered checkout
(`atelier unwrap` and `atelier wrap`), projects that use Git LFS or were moved
from 1.x with a rebuilt baseline, removing and renaming projects, the private
operations toolkit behind `atelier ops`, and cleaning finished workspaces
with `atelier clean` are in [docs/owner.md](docs/owner.md). What became of
ControlPlane is in [docs/control-plane.md](docs/control-plane.md).
[docs/using-atelier.md](docs/using-atelier.md) is the developer's guide to using
Atelier well, and [docs/orchestrating.md](docs/orchestrating.md) the
handbook for a session that runs Atelier for a project.
[docs/multi-mac.md](docs/multi-mac.md) covers working on one project from
several Macs: `atelier clone`, `pull`, `branch` and private files.

## Costs and usage

**The server.** Running Atelier costs the Studio's electricity and the
Cloudflare products it still uses: the tunnel and Access, R2 for backups and
AI Gateway analytics. Its Git repositories are files on the Studio and cost
nothing per operation; Artifacts, which billed operations and storage on 1.x,
is no longer used.

**Model usage.** `atelier runner --usage`, run on each machine that runs the
harnesses, reports Codex's 5-hour and weekly windows, the requests, tokens
and cost that zcode and opencode recorded by served model, and the DeepSeek
balance. The Usage page shows the last report of each tool, and the server
sends an ntfy alert once when a figure crosses the developer's threshold.
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
`atelier runner --usage` is asked for, the server sends one query to the
GraphQL Analytics API for the last 7 days of the gateway: each model's calls,
failed calls, tokens in and out, cost, and median and 90th percentile
duration. Set it up once:

1. Give the server the account id (the dashboard shows it on the account's
   overview) as the setting `CF_ACCOUNT_ID`, a file of that name in the
   secrets directory, so the public source names no account; unset, it keeps
   the figures off. `AI_GATEWAY_ID`, set the same way, names the gateway and
   defaults to `atelier`.

   ```sh
   printf '%s' ACCOUNT_ID > ~/atelier-secrets/CF_ACCOUNT_ID
   ```
2. In the dashboard, under My Profile → API Tokens → Create Token → Custom
   token, create a token with the permission Account · Account Analytics ·
   Read, scoped to this account only, and give it to the server the same
   way:

   ```sh
   printf '%s' TOKEN > ~/atelier-secrets/ANALYTICS_TOKEN
   ```

   Keep the file readable by the server's user alone. The server reads the
   secrets directory when it starts, so restart it after adding a file.

   Without it the Models page says
   "AI Gateway figures are off: set ANALYTICS_TOKEN".

Runners point opencode's pay-per-use providers at the gateway, with a
`cf-aig-authorization` header carrying a gateway token; the configuration is
in
[docs/models-and-usage.md](docs/models-and-usage.md#ai-gateway-costs).

## What is enforced and what is trusted

Enforced by construction:

- one holder per item, because the project's Ledger checks and records a
  claim in one step, and calls to one Ledger never interleave;
- one live write grant per workspace, minted for the holder and revoked on
  handoff, release or abandonment, and a pre-receive hook that refuses any
  push the grant does not cover;
- observed evidence tied to the head Atelier reads from the repository, not the
  head an agent reports;
- acceptance only through the gate, and merging only of the accepted head.

Trusted, and stated here so nobody assumes otherwise:

- **Agent tokens prove identity.** An agent token binds requests to one actor
  and optionally to projects. The developer token still permits declared actors
  for orchestration, a reviewer included: a review it records in a model's
  name counts as that model's (for a protected change, only when it answers
  a review request that model claimed for that head). Independence of review is therefore
  guaranteed against agents, not against whoever holds the developer token.
  Keep it with the developer's tools. A workspace's task grant
  controls Git pushes and is separate from an API token.
- **Git credentials stay off the command line.** The CLI hands every
  Git grant to git through git's environment (`GIT_CONFIG_COUNT`,
  `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`), never as an argument, because
  any local user can read a process's arguments with `ps`. A workspace keeps
  its grant in `.git/atelier-credentials`, readable only by its user
  (mode 0600), which `.git/config` includes; anything running as that user
  can still read it.
- **Check execution is explicit.** Local checks run in a clean clone at
  the verified head, but a caller authorised to record checks, the item's own
  agent included, can forge a local result. It cannot forge what the change
  touches: the changed paths are measured by the server from the repository for
  every check, so a protected change always needs its independent review,
  whatever a local result says. Atelier has no check it runs itself: the
  container check, which was the one result no agent could forge, was
  removed in t768, so a local result is always the word of the machine that
  ran it.
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
  redacts the API token, the read grant and the workspace's task grant. Redaction matches each token exactly as
  written, so a check that prints one encoded, reversed or in pieces is not
  caught. Atelier no longer has a sandbox for checks (t768), so do not run
  check code you do not trust.
- **Merging happens locally.** A task grant writes only `t/N`, and an owner
  push cannot move the project's branch. Atelier merges in git on the
  developer's machine and pushes the merge with a landing grant, which the
  hook accepts only as a merge of the accepted head onto the branch's tip
  ([docs/branches.md](docs/branches.md)). The iCloud checkout is the source
  of truth.
- **The user boundary is the isolation.** The repositories, hooks, grants and
  Ledgers belong to `atelierd`; builders run as another user. An agent with
  the administrator password could rewrite anything on the Studio, record
  included. Two copies stand outside it: the nightly encrypted backup to R2
  and the public mirror on GitHub.

## Development

`node cli/serve.mjs` runs the server (step 2 of the Quickstart). `npm
test` runs every test under Node with `node --test`: the pure functions, the
server's modules against real SQLite files, and the CLI against the real
server and the real Git hook; nothing needs workerd, wrangler or a Cloudflare
account (`test/no-cloudflare-imports.test.mjs` forbids importing them).
`npm run typecheck` runs `tsc -p . && tsc -p test`. `node test/preview.mjs`
serves a read-only preview of the pages with illustrative content.
[docs/setup.md](docs/setup.md#local-development) has the details.

### Concurrency proof

`bin/concurrency-proof.mjs` drives N simulated agents (N up to 1,000,
configurable) against a throwaway project over the CLI's own request protocol
(the developer token as a bearer header, `x-atelier-actor` naming the agent) and
reports what the run measured. It proves three things, and asserts each before
exiting cleanly:

- **claim spread**: N agents claim N tasks at once; all N succeed and each
  gets its own branch, `t/N`;
- **claim race**: N agents race for one task; exactly one wins and the other
  N-1 are refused, each refusal naming the holder;
- **pushes**: with `--push`, each agent clones its branch, makes a tiny commit
  and pushes it back to that branch with its task grant, and the push is
  observed at the branch's head (without
  `--push` no push is made and the phase is skipped, so the run stays cheap).

It then abandons every task it created and prints per-phase throughput and
median and p90 latency, every error, and the cost of the run (wall time and
request count; the agents are simulated, so the model cost is $0):

```sh
bin/concurrency-proof.mjs --project throwaway --agents 1000 --push
```

The tests run it against a stand-in server on localhost
(`test/concurrency-proof.test.mjs`). The figures below are one measured run
against that stand-in on 1.x, when the report counted forks, a single Node process on this machine, included
because the brief asks for measured numbers rather than claims; they are not
the live server's latency:

```
N=1000: claim spread 1000/1000 ok with 1000 distinct forks, median 77.3ms,
p90 78.1ms; claim race 1 winner, 999 refused each naming the holder, median
47.8ms, p90 48.6ms; cleanup 1001/1001; ~9172 req/s over 0.436s, 4002 requests.
```

The request count is every request the run sent: the 1001 that created the
tasks and the race, the 2000 claims, and the 1001 abandons. With `--push`, the
proof also reports how many of the git pushes ran at once (its peak live git
subprocesses): the pushes are concurrent, so all N overlap, and that figure is
asserted in the tests.

On 2026-10-09 the claim race ran once against the live 1.x server (deploy
3cad79b5): 1,000 agents raced for one task on atelier.zone. One agent got the
task, 976 were refused with a refusal naming the holder, and 23 were answered
with a retryable 503, the server saying it was busy. No second agent was
granted the task. These figures are as the orchestrating session reported
the run, and the run was not repeated. The ledger keeps them in the brief of
t364, the task filed that day to fix how the proof read the holder
(`atelier receipt t364 --json`; its page,
[atelier.zone/p/atelier/t364](https://atelier.zone/p/atelier/t364), is behind
the developer's sign-in), all but the count of 503s, which only that report
gives.

## Licence

MIT. See [LICENSE](LICENSE).
