# Atelier

Atelier lets several coding agents work on one project at the same time
without trampling each other or the person who owns the project. It runs on
Cloudflare Workers, Durable Objects and Artifacts, and is driven by a
dependency-free command, `atelier`, that any agent able to run a shell
command can use.

It rests on three rules.

1. **Every item of work has exactly one owner.** Ownership moves by a
   recorded handoff. The owner holds the only write token for the item's
   workspace, and a handoff revokes it.
2. **Evidence is graded.** A check that Atelier ran itself, in a clean clone
   of exactly the head it reads from Artifacts, is *Observed*. Anything an
   agent says it did is *Reported*. A required check with no observed result
   at the current head is *Pending*. Only Observed passes count.
3. **The project owner decides.** The project owner is the person the
   project belongs to; in the API they act as a reserved actor, `owner`
   unless the deployment names another (see Setup).
   Work reaches the project only when the project owner accepts it and
   merges it. Changes to protected paths also need approval from a model
   other than the item owner's, or from the project owner.

The web inbox answers one question, *what needs the project owner now?*, and ranks the
things a person must decide above the things an agent must fix.

## How it works

In outline: a project's main branch is copied into an Artifacts repository,
the *baseline*. Each item is a fork of the baseline, its *workspace*. Agents
work in their workspace, push to it, and run checks against it. The project owner merges
accepted work into the real checkout, and the baseline follows.

In detail:

| Step | Who | What happens |
| --- | --- | --- |
| `atelier init [--title TEXT]` | the project owner, in the project checkout | Creates the baseline repository and pushes the current branch to it. Records the required checks and the protected paths, and an optional display title. |
| `atelier new "title" --scope 'src/**'` | anyone | Creates an item. The scope is what the item intends to touch; overlapping live scopes are flagged in the inbox. |
| `atelier claim t3 --as claude-code/opus-5.5` | an agent | The project's Durable Object grants ownership atomically, so a second claimant is refused. The Worker forks the baseline and mints an eight-hour write token for the owner alone. The CLI clones the workspace into `~/Library/Caches/ai-projects/cloudflare-git/work/`. |
| `atelier push` | the item's owner | Pushes, then asks the Worker to read the workspace head from Artifacts. The ledger records the head Atelier saw, not the one the agent named. |
| `atelier check` | anyone | Clones the workspace afresh at that head (or runs in a Cloudflare container with `--sandbox` or `sandboxOnly` policy), runs each required check, measures which paths changed since the baseline, and records the results as Observed. A result for a head that has since moved is refused. |
| `atelier report "…"` | anyone | Records a Reported claim. It is shown and never counted. |
| `atelier submit` | the item's owner | Marks the item ready. The gate states what still blocks it. |
| `atelier handoff t3 --to codex/gpt-5.5` | the item's owner or the project owner | Moves ownership and revokes the old write token. The workspace and its history carry over; the work is not forked again. |
| `atelier review t3 --approve` | a different agent, or the project owner | Required when the item changes a protected path. A reviewer of the same model as the owner does not count. |
| `atelier accept t3` | the project owner, or the Accept button | Allowed only when the gate is clear. Pins the accepted head. |
| `atelier merge t3` | the project owner, in the project checkout | Fetches exactly the accepted head, merges it with `--no-ff`, attaches the item's provenance as a git note on `refs/notes/atelier`, and pushes the new main to the baseline. Pushing the code to GitHub stays a separate, deliberate step; after `atelier notes-remote github`, each merge pushes the provenance notes, and only them, to that remote. |

The gate for acceptance is a pure function in [`src/rules.ts`](src/rules.ts):
every required check observed passing at the current head; the changed paths
observed; no rejection at that head; and, if a protected path changed, an
approval at that head from a different model or from the project owner. What a check
executes is protected automatically: a script it runs (`./check.sh`,
`node scripts/verify.mjs`), and `package.json` when it goes through a package
manager, whose scripts an item could otherwise rewrite. An item therefore
cannot quietly weaken the check that grades it. Files a check only reads, such
as the code under test, are not protected, and nor is test configuration such
as `vitest.config.ts` unless the project protects it.

## Projects governed by ControlPlane

Atelier and ControlPlane each own different facts. ControlPlane owns policy:
who may act and what is protected. Atelier owns live state: who holds which
item now, the evidence at its head and its handoff chain. Git owns what
merged.

- `atelier init` reads `docs/control-plane/agent-policy.v1.json`,
  `execution-policy.v1.json` and `project-adapter.v1.json` when they exist.
  Eligible agents are the available ones; overlapping claims are refused when
  the policy says `overlapping_claims: refuse`; protected paths are the
  adapter's protected surfaces, the maintenance paths, and the agent and
  ControlPlane files themselves. Atelier never writes these files.
- Copying a project into Artifacts is an off-machine copy, so `init` refuses
  a ControlPlane project until the project owner's approval is recorded with
  `--approval "…"`. The approval is kept in the project's policy and quoted in
  every merge receipt.
- `atelier merge` writes a `control-plane.landing-receipt` into
  `docs/control-plane/landing-receipts/` as part of the merge commit, so the
  merge and its record are one change.
- `atelier owners` prints one line per live item for a wrap to copy into the
  project's state record; `atelier owners --json` and
  `GET /api/projects/NAME/owners` give the same view without titles, scopes
  or paths. Publishing it to Observatory is ControlPlane's to do, because
  Observatory reads only what ControlPlane publishes.

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

- **Identity is declared.** Every caller shares one API token, and the actor
  name (`harness/model`) is what the caller says it is. The token proves only
  that the caller is one of the project owner's own tools. The write token is what stops
  a non-owner from pushing.
- **Check execution is explicit.** Local checks run in a clean clone at
  the verified head, but a caller with the shared token can forge local
  evidence. Cloudflare container checks execute on the server and are
  available with `--sandbox`; `sandboxOnly` policy requires that evidence.
  The container integration still needs deployment and a live runtime check.
- **Merging happens locally.** The Artifacts binding and REST API can read
  repositories (commits, trees, blobs, files, a first-parent log) but cannot
  write. The only way to write is a git push with a write token, so Atelier
  merges in git on the owner's machine and pushes. The iCloud checkout is the
  source of truth.

## Setup

Requirements: Node 24 or later, git, a Cloudflare account on the Workers Paid
plan (Artifacts is in open beta there), and `wrangler` logged in.

```bash
npm install && npm run types && npm test
```

Write the server token into the Keychain once, by hand:

```bash
security add-generic-password -s atelier.API_TOKEN -a "$USER" -w
```

Deploy, then make the Worker's secret match the Keychain:

```bash
npx wrangler deploy
```

```bash
security find-generic-password -s atelier.API_TOKEN -w | tr -d '\n' | npx wrangler secret put ATELIER_TOKEN
```

The project owner acts as the actor `owner`, and the inbox asks "What needs
you now?". To use your own actor and name, set `OWNER_ACTOR` and
`OWNER_NAME`, either as `vars` in `wrangler.jsonc` or as secrets, which keeps
them out of the configuration:

```bash
printf jo | npx wrangler secret put OWNER_ACTOR
```

```bash
printf Jo | npx wrangler secret put OWNER_NAME
```

`atelier login` asks the server for the owner's actor, so the CLI follows
whatever the Worker is set to.

Point the CLI at the Worker and register a project:

```bash
npm link
```

```bash
atelier login --server https://atelier.example.workers.dev
```

```bash
atelier init --title "My project" --check "npm test" --protect AGENTS.md --protect "wrangler.*"
```

Run `init` inside the project checkout. `atelier guide` prints the
instructions an agent needs; paste them into the project's `AGENTS.md` or
`CLAUDE.md`.

Running `atelier init` again changes only what it names: `--title` changes the
title, `--check` replaces the required checks, `--protect` replaces the
protected paths (with the defaults), and everything not named keeps its value.
`atelier init --reset` rebuilds the policy from the options given and the
defaults, as a first init does; the project's title and creation date are kept.

When the checkout is already registered locally, `init` reuses its registered
name, even if the folder has a different name. A different `--name NAME` is
refused. `atelier init --name NAME --rename-local` changes only that local
config entry and then returns. It does not rename a server project, update
its title or policy, or push a baseline. The server refuses a new project
when its baseline repository belongs to another registered project.

## Owner notifications

Set `NTFY_TOPIC` to receive an ntfy notification when submission, review or
check results put a submitted task in the owner's inbox:

```sh
printf 'TOPIC' | npx wrangler secret put NTFY_TOPIC
```

Topics on ntfy.sh are readable by anyone who knows the name. Use a long,
random topic. The notification carries the task title and the task page's
one-line decision brief, capped at 500 characters, with a link to that page.
See [ntfy publishing](https://docs.ntfy.sh/publish/) for topic and header details.

Without the setting, nothing is sent. The Ledger records at most one attempt
per task and head, including failed attempts, across restarts. Delivery runs
in the background; failures do not fail the action and are logged without
the topic. A push that withdraws acceptance does not send a notification.

## Removing a project

The owner can run `atelier projects remove NAME` to remove a project from
the index and from the local config. It disappears from Projects, Flow,
Decisions and the public showcase. Claimed, submitted or accepted items, and
open items queued for a runner, block removal unless the owner adds `--force`.
The local config entry is deleted whole, and the command lists what it held,
such as the checkout path, branch and `notesRemote`, so a setting made by hand
can be restored.

Removal retains the Artifacts repository and all project Ledger data,
including items, evidence and history. Deleting a repository requires a
separate, deliberate action by the owner. Reinitialising the same project
can register its retained Ledger again.

## Local cache cleanup

`atelier gc --project NAME` previews local directories eligible for removal.
Add `--apply` to remove them. `--dry-run` explicitly requests the preview.
The command uses the configured cache (`ATELIER_CACHE` when set) and never
deletes Artifacts repositories or changes the project's checkout.

A workspace is eligible only when the server confirms that its item merged,
its HEAD equals the accepted head, and it has no changed, untracked or ignored
files, extra commits in refs or reflogs, linked worktrees, initialized
submodules, or a Git operation in progress. Cleanup checks
its recorded project and item identity and refreshes the item's state before
removal. The current directory and its ancestors are preserved. Symlinked
directories are not followed. Stop editing a candidate before applying cleanup.

Check and diff clones carry a local record of their project, creation time,
and process. A recorded clone is eligible after 24 hours only when its process
and any recorded check child have exited. Runs for other projects, records
that cannot be verified, and older clones without records are preserved.
Normal completion removes both the clone and its record.

## Local development

`npm run dev` serves the Worker on localhost. The Artifacts binding always
reaches the real account, even locally, so local runs create real
repositories. Pass a throwaway token with
`npx wrangler dev --var ATELIER_TOKEN:localtest`; do not write `.dev.vars`
into an iCloud project.

`npm test` runs two pools. The pure functions in `src/rules.ts` and
`src/diff.ts` are tested by `node --test` (`test/*.test.ts`). The
`test/*.spec.ts` files run inside the Workers runtime through the Workers
test pool, against the Ledger Durable Object with its real SQLite storage
and no network access; `tsc -p test` typechecks them against the types
`wrangler types` generates. Workerd logs each refusal those tests assert as
an uncaught promise rejection (`uncaught exception … 409|owned|…`); those
lines are the refusals under test, not failures.

## Cost

Artifacts bills operations and storage from 14 October 2026: the first
10,000 operations and 1 GB each month are included in Workers Paid, then
$0.15 per thousand operations and $0.50 per GB-month. One item uses a fork,
a few token mints and a handful of pushes, fetches and clones, so ordinary
use should stay inside the included allowance. That is an estimate from the
operations the CLI performs, not a measurement.

## Licence

MIT. See [LICENSE](LICENSE).

## Decisions, projects, and history

The Decisions page puts reviews and blockers across projects beside the
selected task. Passing output stays collapsed; failed checks show their
output. Projects contains active work and task creation. History retains
merged and closed tasks with their evidence. Ownership and Git details
remain available inside each task.

Approval and acceptance forms carry the revision displayed on the page.
The server checks both the ledger and Artifacts before accepting that
revision. A stale page must be refreshed. Each reviewer's latest verdict
at a revision replaces their earlier verdict; another reviewer's rejection
still blocks acceptance.

## Dispatch

The project owner can send an open task to a kind of runner instead of
waiting for an agent to choose it: `atelier dispatch t11 --to home --agent
opencode --model glm-5.3-flash`, or "Send to an agent" on the task's page.
`--to` is `home` (a runner on one of your machines), `cloud` (a Cloudflare
container) or `any`; the agent and model are optional. Model names may carry a
`:profile` suffix, as the AI Studio's do. No runner ships yet: the home and
cloud runners are items t13 and t12, and until then a runner is anything that
speaks the two requests below.

Runners are not sent work. A runner asks for it, describing what it can run,
with `POST /api/queue` and a body such as
`{"runner": "home:studio", "agents": [{"agent": "opencode", "models": ["glm-5.3-flash"]}]}`.
Atelier answers with the waiting tasks it may take, across every project,
oldest first, each with the name to claim under. The runner then claims
through the ordinary atomic claim with the header `X-Atelier-Runner`; a
dispatched task refuses any claim from a different kind of runner, agent or
model, and refuses a claim with no runner at all until the owner withdraws
the dispatch. A runner that gives up releases the task, and it waits in the
queue again. `atelier queue` lists everything waiting. If a project cannot be read, the
response names it in the `X-Atelier-Incomplete` header and `atelier queue` says so.

A runner's name is declared, like every actor's; what a dispatch guarantees
is that the task goes to the first matching runner that asks, and to no one
else, while it waits.

## Home runner

`atelier runner` polls the queue every 30 seconds, claims one eligible task,
and runs its configured harness in the claimed workspace. The brief is kept
outside that workspace. After a successful harness exit with a new commit,
the runner calls `finish` to push, run required checks, and submit. Failure
releases a claim only when no new commit was made. Otherwise the claim stays
in place for inspection. Two counters are kept for each project and task id,
across revision changes. The task counter never resets. Two task failures,
including harness failures and finish failures other than exit 4, skip the
task for the rest of the process. A separate counter skips it after three consecutive infrastructure failures,
including claim errors other than refusals, workspace preparation errors,
HEAD read errors after successful harness exits, and finish exit 4. This
counter resets on a task failure, success, claim refusal or validation skip. Claim refusals and validation skips do not
increase either counter. Interruptions stop the runner without updating either
counter. An infrastructure failure moves on to the next offered task in the
same poll; `--once` still handles at most one task.
Reaching either cap logs that the task needs the owner's attention; the
infrastructure message includes the reason. Project names rejected by runner
validation are skipped and remembered so other tasks
can run.
SIGINT stops polling and interrupts the active child process. A second
interrupt exits immediately.

Save a config at `~/.config/atelier/runner.json`, or select one with `--config PATH`:

```json
{
  "agents": [
    {
      "agent": "opencode",
      "models": ["GLM-5.3-Flash-4_8bit"],
      "command": ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "Read the attached task brief and complete it in {workspace}."]
    }
  ]
}
```

Agent ids are `opencode`, `claude-code`, `codex`, or `zcode`. Set model ids
and command arguments to match the installed harness. Commands are argv
arrays with `{model}`, `{brief_file}`, and optional `{workspace}` placeholders;
the runner invokes them directly without a shell. The example requires that
model to be configured in opencode. Atelier login and credentials are shared
with the ordinary CLI. Set `taskTimeoutMs` in the config to change the harness
deadline from 45 minutes, and `finishTimeoutMs` to change the whole finish
deadline from 60 minutes. Expiry terminates the process group, with forced
termination after five seconds. A finish timeout leaves the claim held.

```sh
atelier runner --name home:studio
```

Add `--once` to handle at most one task and exit, including when the queue
is empty.

The CLI's exit codes let the runner tell a task's own failure from the
server's: 0 success, 1 a refusal or failure of the command, 3 a claim the
server refused, 4 the server unavailable or a request that failed in
transit (retry later).

## The public showcase

`/showcase` is the one page anyone can read without signing in. It shows the
projects the owner names, as the Flow page draws them: each task's thread,
who held it, its checks, reviews and decisions, and the tally. It leaves out
what anyone wrote (review notes, reports, check commands and closing notes),
the diffs, every form and every link into the signed-in pages. Nothing is
shown until the owner names a project:

```text
printf 'cloudflare-git' | npx wrangler secret put SHOWCASE
```

`SHOWCASE` takes project names separated by commas; deleting it hides the
page again. The page is cached for a minute, so a change to `SHOWCASE` shows
within a minute. With a showcased project still registered, a visitor who is not signed in opens
`atelier.zone` on it; signed in, `/` opens Decisions while something is
waiting and Flow when nothing is, and `/decisions` is always Decisions.

## The model pool

The Models page (`/models`) and `atelier models` hold the models Atelier
can dispatch to. Each entry names the model as its harness does, the
harness (OpenCode, Claude Code, Codex, ZCode or the Gemini CLI), where it
runs, its provider and, for an API, the name of the Keychain entry on the
runner's machine that holds its key. Atelier stores that name and never a
key; a form or request that carries one is refused.

```text
atelier models add GLM-5.3-Flash-4_8bit --harness opencode --where home --endpoint http://studio.local:8000/v1
atelier models add gemini-3.1-pro --harness opencode --where cloud --provider google --keychain gemini.API_KEY
atelier models
```

A model's family (Claude, GPT, GLM, Gemini, DeepSeek, Qwen and others) is
recognised from its name, so a new release is coloured correctly on the
graph the day it appears; a name no family claims is shown as not
recognised. A runner reports what it finds for each model through
`POST /api/models/ID/status`, naming itself in `X-Atelier-Runner`: a home
model is reported only by a home runner and a cloud model only by a cloud
runner, and the Models page shows each report with the runner that made it.
Changing how a model is reached (its harness, where it runs, provider,
endpoint or Keychain entry) clears its status until it is checked again.
An endpoint carrying a query string, or a Keychain entry name that looks
like a key, is refused.

## The Studio

`/studio` shows the floor: one lane per live task on a shared time axis,
banded by who has held it, with a mark for every claim, push, check,
handoff, submission and review. A handoff is a visible change of band, and
every check mark says whether it ran in a Cloudflare container or on the
agent's machine. The page refreshes every fifteen seconds. The Decisions page
shows the same agents in brief before anything is opened. `DESIGN.md`
describes the marks.

## Finish and merge

After committing, an agent runs `atelier finish` in its claimed workspace.
It pushes, runs required checks, and submits only if those checks pass and
the workspace remains unchanged. A project with `sandboxOnly` enabled uses
the cloud runner automatically. `--sandbox` selects it explicitly.

The project owner can complete an exact revision with:

```sh
atelier merge t9 --head FULL_COMMIT_SHA --approve --note 'Reviewed changes'
```

`--approve` records an explicit owner review. Without it, any required review
must already exist. Acceptance still goes through the gate. Already accepted
work needs only `atelier merge t9 --head FULL_COMMIT_SHA`.

Merging records a journal in the registered checkout's Git directory,
`atelier-landing.json`. If publishing the baseline or recording the merge
fails, rerun the same command. It resumes from the local merge commit. It
refuses a different revision, a dirty checkout, or concurrent merge. If a
process stops during the uncommitted Git merge, inspect `git status` and
resolve or abort that merge before retrying. The journal preserves the
original revision and starting commit. Never remove it to bypass a mismatch.

The browser provides this local command after acceptance. It does not run a
network-accessible local executor. Deployment and pushing the project branch
to its own remotes remain separate decisions.

## Push event setup

The Worker has a Queues consumer for `cf.artifacts.repo.pushed` notices in
the `atelier` namespace. It rereads the default branch from Artifacts,
ignores unrelated branches and duplicate events, and retries failed reads.
A new push invalidates acceptance and evidence for the previous revision.
The CLI's push observation remains available when event delivery is delayed.

`bin/setup-push-events` prints what provisioning needs and nothing else. With
`--apply` it creates two queues, `atelier-push-events` and its dead-letter
queue `atelier-push-events-dead-letter`, and runs nothing more: it never
deploys the Worker and never edits `wrangler.jsonc`.

The consumer belongs in the release configuration. Add this to
`wrangler.jsonc`, alongside the other top-level keys, then deploy:

```json
"queues": { "consumers": [{ "queue": "atelier-push-events", "max_batch_size": 10, "max_retries": 5, "dead_letter_queue": "atelier-push-events-dead-letter" }] }
```

Events reach the queue only through a subscription, and a repository-level
subscription selects one repository. Every item's workspace is a separate fork
repository, so each fork needs its own subscription under the `atelier`
namespace; a fork without one has no event delivery, and only the CLI's push
observation covers it. The installed wrangler (4.147.0) has no flag for a
subscription's namespace or repository, so create those subscriptions in the
Cloudflare dashboard or through the API. `bin/setup-push-events` prints this
as a TODO rather than guessing at a command.

Queue provisioning, subscription creation, and deployment are release actions;
adding the consumer handler alone does not activate event delivery. See
[Artifacts event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/).

## Local visual review

Run `node test/preview.mjs` for a local, read-only preview with illustrative
content. It prints its URL. The preview cannot approve, merge, or create live
tasks. Use `?state=empty`, `/p/cloudflare-git/t1?state=failed`, `state=ready`,
`state=accepted`, `state=merged`, `state=unavailable`, or `state=long` to inspect
important states. Append `theme=dark` to inspect the dark palette.

The visual composition is saved in `.impeccable/mocks/decisions.png` with its
prompt. Product intent lives in `PRODUCT.md`; the implemented visual system
is recorded in `DESIGN.md`.

## Integration basis

The decision workspace integrates t1 at `5ebb64e9` (cloud checks), t4 at
`8c44da71` (real Ledger runtime tests), and the merged t5 cleanup work.
Their commits remain in the integration history. Combined test discovery
runs TypeScript and JavaScript unit tests and the Workers runtime suite.
Cloud checks now bound retained output and mark interrupted runs failed
instead of leaving them indefinitely running. Local verification does not
establish a successful production container run.
