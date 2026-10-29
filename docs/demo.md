# Demo: one goal, end to end

For developer-token examples, set the acting model for the session:

```sh
export ATELIER_ACTING=claude-code/opus-5.5
```

Use your own registered harness/model. Owner commands such as `ship`,
`wrap`, `branch push|fetch` and `plan show` keep the owner actor and use
`ATELIER_ACTING`; do not add `--as` to them. Commands that act as a builder
or reviewer use `--as H/M` to name that actor. Agent and runner tokens
name their own actors; leave `ATELIER_ACTING` unset with those tokens.

This walks one goal through Atelier's orchestrator, from the developer
stating it to the plan's merge into main, with what each command prints in
outline and where to watch each step. A last section lands a single task
that is not part of a plan. Every command and flag here is in
`atelier help`; what the code does not yet do is listed at the end, not
described along the way.

The project is called `demo`. Its developer is `pavi`. The goal is a small
feature with two parts, so the plan's dependency order, the automatic
cross-family review and the integration branch all show up once.

## Before you start

**Sign in.** In the project's checkout, sign in
to your own Atelier server, the address you set up in the README's
[Quickstart](../README.md#quickstart) (atelier.zone is the project's own
server and takes only its developer's token):

```sh
atelier login --server https://YOUR-SERVER-ADDRESS
```

**Fill the model pool.** Routing needs a model that can build each part
and a model of another family that can review it; an approval is refused
otherwise. On a fresh server, register the acting model first, while the pool is empty.
If the pool already has entries, add your acting model on the Models page
before running these commands. Two entries are enough here:

```sh
atelier models add opus-5.5 --harness claude-code --where cloud --as claude-code/opus-5.5
atelier models add glm-5.3 --harness opencode --where home --as claude-code/opus-5.5
```

**Register the project.** In the demo checkout:

```sh
ATELIER_ACTING=claude-code/opus-5.5 atelier init --name demo --title "Demo" --check "npm test" --protect "src/rules.ts"
```

`init` creates the project's bare repository on the server, the baseline, pushes the current
branch to it, and records the branch, the checks and the protected paths.
It prints the policy it recorded:

```text
Demo (demo): demo's repository on this server now holds main @ 5ebb64e9.
Checks:     npm test
  npm test: read-only, a known build or test command
Ship:       0 protected commands
Protected:  src/rules.ts
Overlap:    flagged
```

A check runs in a clean clone on the machine that runs it, and is recorded
as Observed there.

`atelier models` lists the pool with each model's family and what a runner
last found. Atelier never stores a key; `--keychain NAME` names the Keychain
entry that holds one when a harness needs it.

**Configure a home runner with build, plan and review jobs.** Save this
as `~/.config/atelier/runner.json`. The installed harnesses must be signed in
and able to use the registered models. The built-in adapters supply the
brief, plan and verdict files; `cli/runner-config.mjs` selects them when
`command` is omitted.

```json
{
  "agents": [
    { "agent": "opencode", "models": ["glm-5.3"], "env": ["ZAI_API_KEY"] },
    { "agent": "claude-code", "models": ["opus-5.5"] }
  ],
  "jobs": ["build", "plan", "review"]
}
```

Issue a runner credential with `atelier token issue --runner home:studio
--project demo --days 30` in the developer session. In a separate terminal,
store the printed credential with `atelier token store --runner home:studio`.
Leave `ATELIER_TOKEN` and `ATELIER_ACTING` unset there so the runner uses
its stored credential. Then start it and leave it running:

```sh
atelier runner --name home:studio
```

It polls the queue every thirty seconds and prints one line per step as
`runner: …`. `--once` handles one job and exits, which suits a rehearsal.

**Start the integrator.** It offers the `integrate` and `refresh` jobs,
runs no harness and takes no config. It must use an agent token bound to
`atelier/integrator`. The developer token and a runner token cannot claim
these jobs.

Provision that token through `POST /api/tokens` with the developer bearer
credential, `x-atelier-actor: owner`, `x-atelier-acting:
claude-code/opus-5.5`, and the body
`{"actor":"atelier/integrator","projects":["demo"],"days":30}`.
The current `atelier token issue` command uses `--as` for both the token's
actor and the acting declaration, so it cannot issue this reserved actor's
token. Use the API for this step. In another terminal, set `ATELIER_TOKEN`
to the returned token, unset `ATELIER_ACTING`, and run:

```sh
atelier runner --name home:integrator --integrate
```

**Open the places to watch.** Three views show the whole walk:

- `atelier inbox` prints what waits on the developer, one line of what to do
  and a link per task, in the order of docs/owner.md's table. The
  Decisions page at `/decisions` shows the same.
- The Studio at `/studio` draws one lane per live task, banded by holder,
  with a mark for every claim, push, check, submission and review. Each
  part becomes a lane when a runner claims it.
- `atelier plan show tP --project demo` prints the plan's phase, its parts
  with their state and routing, and the command for every decision waiting
  on the developer. It is the page for the plan in text; run it after each step.

## 1. State the goal

```sh
atelier plan "Add JSON output to the export script and document it" --scope "src/export.ts" --scope "test/export.test.ts" --scope "README.md" --planner claude-code/opus-5.5 --project demo --as claude-code/opus-5.5
```

Atelier creates the plan item and queues it as a plan job for the planner.
Without `--planner`, Atelier refuses and lists candidates. It picks no planner. A project has one
active plan at a time.

```text
t10 is a plan for: Add JSON output to the export script and document it
Planner: claude-code/opus-5.5. Named by the developer
The plan job waits in the queue for claude-code/opus-5.5; a runner that offers plan jobs takes it. To plan by hand, claim t10 as claude-code/opus-5.5 with --runner home:NAME, then atelier plan post t10 FILE. When a proposal arrives, read it with atelier plan show t10 --project demo.
```

`atelier plan show t10 --project demo` now says `Phase: planning.`, `No
valid proposal yet.` and that the plan job is waiting in the queue. The
plan does not appear in the inbox yet: nothing waits on the developer.

## 2. The planner's job

Within a poll the runner takes the plan job. Its log, in outline:

```text
runner: claimed
runner: workspace reset to HEAD and untracked files removed
runner: plan posted: 3f9c…e21b
runner: released: the plan job is done
```

What happened: the runner claimed the plan item as the planner, which makes the
branch `plan/N` at the project branch's tip. That branch is the plan's integration branch. It fetched the
planner's brief from the server (the goal, the scope, and the schema to
write), ran the harness with the brief and the plan file, posted the file
the harness wrote to the plan item, and released the claim.

The document is `atelier.plan.v1`: the goal and a list of parts, each with
a `key`, a `title`, a `kind` (interface, build, tests or docs), a
`taskKind`, a `scope` of up to six globs, `dependsOn`, `provides` and
`uses`, a `brief`, at least one observable `acceptance` criterion, and a
`size` of S or M. Here the planner proposes two parts: `export-json`, which
builds the output and its test, and `docs-json`, which documents it and
depends on the first.

An invalid document is refused with every error. The runner logs
`failed: the plan was refused (attempt 1 of 2): …` and releases; the plan
job goes back in the queue with the errors in the planner's next brief.
After two failed attempts the plan blocks and appears in the inbox as
"Plan blocked", with `atelier plan revise`, `plan retry`, `plan reroute`
and `plan stop` as the decisions open.

On the Studio, the planner's claim and release are one short band on the
plan's lane.

## 3. Read the split and approve it

The inbox now lists the plan first; the Decisions page shows it as "Plan
to approve". The entry is the plan item's decision brief, in outline:

```text
demo/t10  Add JSON output to the export script and document it
…
Phase: proposed.
Proposal 1: 2 parts, 3f9c2a7b1d4e, by claude-code/opus-5.5.
Recommendation: decide. Read the split with atelier plan show t10, then approve it by its hash or send it back with a note.
https://YOUR-SERVER-ADDRESS/p/demo/t10
```

`atelier show t10 --project demo` prints the same brief. The split itself:

```sh
ATELIER_ACTING=claude-code/opus-5.5 atelier plan show t10 --project demo
```

```text
t10  plan  Add JSON output to the export script and document it
Goal: Add JSON output to the export script and document it
Phase: proposed.
Scope: src/export.ts, test/export.test.ts, README.md
Planner: claude-code/opus-5.5.
Proposal 1, by claude-code/opus-5.5 at 2026-10-06 09:12 UTC: 2 parts. Hash: 3f9c…e21b

Parts:
  export-json  build, feature, size S  Add JSON output to the export script
      scope src/export.ts, test/export.test.ts; depends on nothing
      brief: …
      acceptance: the export script prints the rows as a JSON array when asked for JSON; the test covers it
      would be built by opencode/glm-5.3: …
      reviewer claude-code/opus-5.5, of another family
  docs-json  docs, docs, size S  Document the JSON output in the README
      scope README.md; depends on export-json
      …

…

Approve this split: atelier plan approve t10 --hash HASH --route export-json=opencode/glm-5.3:claude-code/opus-5.5 --route docs-json=opencode/glm-5.3:claude-code/opus-5.5 --project demo
  or send it back: atelier plan revise t10 --note "what to change" --project demo
```

Atelier lists candidates from the pool and their records. The developer
names each part's builder and independent reviewer with `--route`. Approval
stores no alternates. Without every route, Atelier refuses and lists candidates.

To send the proposal back, `atelier plan revise t10 --note "Split the test
into its own part" --project demo` returns the plan to its planner with the
note; the next proposal replaces this one and the old hash can no longer be
approved. To approve, copy the full 64-character hash the command printed:

```sh
atelier plan approve t10 --hash HASH --route export-json=opencode/glm-5.3:claude-code/opus-5.5 --route docs-json=opencode/glm-5.3:claude-code/opus-5.5 --project demo --as claude-code/opus-5.5
```

```text
t10 is approved at 3f9c2a7b1d4e: t11 export-json, t12 docs-json.
Queued now: t11 for opencode/glm-5.3.
Follow it with atelier plan show t10 --project demo
```

Approval fixes the routing and the limits: two parts live at once, three
attempts a part, four dispatches a part, and twenty-four hours. The parts
become items, and Atelier dispatches each one as `atelier/orchestrator`
once the parts it depends on have landed. `t11` is queued now; `plan show`
lists `t12` as `waits for export-json (t11)`. The approval is refused, and
nothing changes, if some part has no eligible builder or no reviewer of
another family; `--allow-paid` lets models paid per token build and review.

## 4. The parts are built

The runner takes `t11` on its next poll, claiming it as `opencode/glm-5.3`
with `--runner home:studio`. A part's branch starts at the plan's branch, not at the
project's, and is measured against it. The runner fetches the part's brief
from the server: the plan's goal, the part's spec, acceptance criteria and
interfaces, the heads its dependencies landed at, its scope, and the
project's required checks. It runs the harness in the part's workspace,
and when the harness exits with a new commit, it runs `finish`. The log
names each phase:

```text
runner: claimed
runner: workspace reset to HEAD and untracked files removed
runner: working
runner: committed
runner: submitted
```

`finish` pushes, runs the required checks and submits, in that order, and
stops at the first step that fails. A part whose checks fail is released
with the failing output in its next brief. Approval stores no alternates.
When the builder exhausts its attempts, the plan blocks. The developer or
orchestrator chooses another builder with `atelier plan reroute`. A runner
that gives up with no commit also releases the part; repeated failures
need the same explicit reroute.

`atelier plan show t10 --project demo` now shows:

```text
  t11  export-json  submitted by opencode/glm-5.3  Add JSON output to the export script
      scope src/export.ts, test/export.test.ts; depends on nothing
      builder opencode/glm-5.3: …
      reviewer claude-code/opus-5.5, of another family
      attempts: opencode/glm-5.3 finished
  t12  docs-json  waits for export-json (t11)  Document the JSON output in the README
```

On the Studio, `t11` has a lane with a claim, a push, a check mark and a
submission. The part's own page under `/p/demo/` shows the diff against
the plan's branch and the recorded evidence.

The routed builder can do the same by hand, in a session that is not a
runner. A part is claimed only through its dispatch, so the claim names a
runner and the actor the dispatch asks for:

```sh
atelier start t11 --project demo --as opencode/glm-5.3 --runner home:studio
# Change directory to the workspace printed by start, then build and commit.
atelier done "Add JSON output to the export script" --as opencode/glm-5.3
```

`start` claims the part, prints the workspace to work in, and prints its
title, scope and dispatch note. `done` is `finish` with a required summary,
and its last line is `Ready for the developer` or what still blocks the part.
After `done`, return to the registered demo checkout before running owner
commands such as `plan show`.

## 5. Checks

Each required check runs in a clean clone of exactly the head the server
holds for the task's branch, never in the agent's workspace, and is recorded as Observed with the
paths that changed since the part's base. A line per check, then the paths
the server measured:

```text
PASS  npm test  @ 8c44da71
changed: src/export.ts, test/export.test.ts
```

`atelier report "what you verified and how"` records a Reported claim at
the current head. It is shown and never counted as a check.

## 6. The automatic cross-family review

Once a part is submitted with every required check passing at its head,
the Ledger asks for a review from the part's routed reviewer: a model of
another family than every contributor. The request goes in the queue as a
`review` job, and the runner that offers review jobs takes it:

```text
runner: reviewed: approve
```

The runner claimed the request with `review-claim`, which gives it the
part, the brief's inputs and a read grant for the task's branch. It cloned the head
read-only into a folder of its own, wrote the diff to the diff file, built
the reviewer's brief (the goal, the part's spec and acceptance criteria,
the scope and any paths outside it, the builder's summary, the observed
checks and where each ran, every run recorded at the head with its latest
result and the end of its output, ad-hoc `atelier check -- CMD` runs apart
from the required checks and reports labelled Reported, earlier findings,
and the diff), and ran the
harness. The harness wrote a verdict: approve or reject, a summary, and
findings, each with a path, a severity (blocker, should or nit) and a note.
The runner posted it as `atelier review t11 --approve --head SHA --criteria BINDING --request N --note
"…" --findings JSON` as the reviewer. A harness that writes no valid
verdict makes the runner keep the reply with `review-unparsable` and release
the claim. On other failures it sends `review-release t11 --request N`, where
N is the request number returned by `review-claim`, ending that request.
The developer or orchestrator must ask again with `atelier review-request
t11 --reviewer claude-code/opus-5.5`. Agents must supply the request number;
only the developer's credentials may
omit it to release the named actor's current claim.

**A rework.** Say the reviewer rejects the first head with a blocker
finding: the test does not cover an empty export. The runner logs
`reviewed: reject`. The part is released back to its builder, and the
builder is dispatched again with the findings in its brief, under the
heading rework. `plan show` records it:

```text
  t11  export-json  queued for opencode/glm-5.3  Add JSON output to the export script
      attempts: opencode/glm-5.3 released after a failed finish
```

The builder's runner takes `t11` again, the earlier commits still in the
workspace, fixes the test, and runs `finish`. The re-review goes to the
named reviewer. Approval stores no alternate builder. When attempts are
exhausted, the plan blocks and appears in the inbox; the developer or
orchestrator chooses a builder with `atelier plan reroute`. On the
Studio the lane shows both bands, the review marks and the new push.

Review verdicts and findings live on the part's page, and
`atelier show t11 --project demo` prints them in the brief. Later, the
developer can record `atelier finding t11 --head SHA --index 1 --verdict
confirmed` to say the finding was right, which counts toward the
reviewer's precision on the Models page.

## 7. Integration onto the plan's branch

An approval from another family moves the part to integration. The Ledger
dispatches an `integrate` job on the plan item, naming the part and its
head, to the reserved actor `atelier/integrator`. The plan item has
exactly one holder, so integrations are serialized. The integrator runner
takes it. Its log is quiet when an integration succeeds; it prints
`runner: failed: …` when one does not, and one line after the last part
(below).

It claimed the plan item (the server first checks that the part's head
merges cleanly onto the plan's branch, and sends it back to the builder if
not), fetched the part's head with `git-token` (`kind: "read"`), merged it with `--no-ff`,
pushed, and ran the plan's checks on the branch with `atelier check t10`.
The plan item's checks compare against the baseline, which is right for
the whole branch. Then it reported `atelier integrated t10 --part
export-json --merge-commit SHA`; the server verifies the commit is on the
branch's log with the part's head among its parents before the part
becomes `integrated`. Had the merge conflicted or the checks failed, the
integrator would have rolled the branch back to its previous head and
reported `atelier integration-failed t10 --part export-json --reason
"…"`, which sends the part back to its builder for rework with the reason.

```text
  t11  export-json  integrated as 9b2e4c10  Add JSON output to the export script
  t12  docs-json  queued for opencode/glm-5.3  Document the JSON output in the README

Integration branch at 9b2e4c10.
```

With `t11` on the branch, `t12`'s dependency has landed and the tick
dispatches it. `t12`'s branch starts from the plan's branch as it is now, so it sees
the new output. It is built, checked, reviewed and integrated the same way.
After the last part integrates, the integrator submits the plan item:

```text
runner: every part is integrated; the plan item is submitted for the owner
```

## 8. The developer accepts and merges the plan

The plan now waits on the developer. `atelier inbox` lists it, and
`atelier plan show t10 --project demo` ends with the command:

```text
Phase: ready.
…
Integration branch at c71d0a32.

The plan is integrated (export-json and docs-json); accept and land it: atelier merge t10 --head c71d0a32… --project demo
```

The plan's gate adds to the ordinary one: every part integrated, each with
a cross-family approval at the head that was integrated. In the registered
checkout:

```sh
atelier merge t10 --head FULL_REVISION --project demo --as claude-code/opus-5.5
```

With `--head`, a submitted plan is accepted at that exact revision first,
and any other revision is refused; then the merge lands the plan's branch
in the checkout with `--no-ff`, publishes it to the baseline, and records
the merge. Every part is marked merged through the plan. The same can be
done in two steps, `atelier accept t10 --project demo` then
`atelier merge t10 --project demo`, or from "Accept revision" on the
plan item's page, which then shows the merge command to copy.

**If the plan touches a protected path.** `src/rules.ts` is protected
here. Had a part changed it, the plan item itself would need an independent
review, and no reviewer qualifies: `atelier/integrator` is one of the
plan's contributors and its family is not recognised. The developer then
accepts with an override, and the reason goes on the record as an event of
its own, never as a review:

```sh
atelier merge t10 --head FULL_REVISION --override-review "Each part was reviewed by another family; the integrator only merged them" --quote "Override the plan review and merge it" --project demo --as claude-code/opus-5.5
```

The merge ends by naming the merge commit and where the provenance is:

```text
t10 merged as 9f1e2b3c in /Users/pavi/Projects/demo; baseline and ledger agree.
Provenance: git notes --ref=atelier show 9f1e2b3c
The project branch was not pushed to its own remotes. Nothing was deployed.
```

The note says who held the plan, what was observed and where, who approved,
and any override with its reason. `atelier notes-remote origin --project
demo` would push that notes ref, and only that ref, on each merge.

`atelier plan show t10 --project demo` now ends `The plan is complete: each
part has merged or was abandoned. Nothing waits.`, the Studio's lanes for
the parts have closed, and the Flow page draws the work as threads that
return to main. The project is ready for another plan.

**Decisions along the way.** A plan that reaches a limit blocks rather
than continuing silently, and its inbox entry names the decisions:
`atelier plan retry t11` counts a part's attempts afresh,
`atelier plan reroute t11 --to claude-code/opus-5.5` names who builds it
from now on, `atelier abandon t11 --note "Part cancelled" --quote "Abandon this part"` gives a part up, and
`atelier plan stop t10 --note "…"` closes the plan and every part not yet
merged, revoking their write tokens. History and evidence stay.

## 9. One task outside a plan: `atelier land`

Not every change needs a plan. For one task, the developer files it and either
dispatches it to a runner or lets an agent take it:

```sh
atelier new "Show the time each check took on its row" --scope "src/ui.ts" --project demo --as claude-code/opus-5.5
atelier dispatch t13 --to home --agent opencode --model glm-5.3 --project demo --as claude-code/opus-5.5
```

The runner builds it as in step 4, and the agent's `done` leaves it
submitted. Then the developer lands it whole, in the registered checkout:

```sh
atelier land t13 --reviewer claude-code/opus-5.5 --project demo --as claude-code/opus-5.5
```

```text
Landing t13 from recorded source 5d31b9c0….
Landing lease taken for t13 (submitted) for its merge alone; one merge at a time in demo.
t13 landed: merged as 2b8d41e7.
t13 spent 9 min landing without the lease and held it 20 s.
The landing lease for demo is released; another task may merge.
```

`land` lands the head the task was checked and reviewed at, and pushes nothing
to the task's branch. Without the project's landing lease, beside any other
task's landing, it compares the task's edits with code main moved, submits the
task after running its required checks in a clean clone if it is still
claimed, and asks the named reviewer. If approval is missing, it records a
land request and stops without waiting; run it again after approval. The
output above shows a task whose approval is already recorded. Only
with the head checked and approved does it take the lease, for the merge
alone, so two sessions never race main (a second landing queues behind it).
Under the lease it accepts and merges through the CLI's own `accept` and
`merge --landing`, run as its children, whose output it prints only when one
fails: the accepted head is merged into the project's branch in the registered
checkout, the project's regenerate command (declared with `init --regenerate`)
runs on the merged tree and its changes join the merge commit, the required
checks run once on that tree, and the merge commit goes to the project's branch
with a landing grant. If main moved meanwhile, Git and the hook refuse the push
and the merge and checks are made again, twice at most. A third refusal
leaves the task accepted with its approvals. Each step and its
duration are recorded on the task as `land.*` events. `--reviewer H/M` names
the reviewer, `--no-review` leaves the task submitted for the developer to
settle by hand, and `--dry-run` prints the steps and the refusals without
changing anything. A landing stopped partway is resumed by running the same
command again. [landing.md](landing.md) gives the order step by step.

## What this walk does not show

`docs/orchestrator.md` lists these under Deferred work, and nothing above
relies on them:

- A web page for plans. This walk reads a plan with `atelier plan show`.
- Merging inside the server. Every merge, the integrator's and the developer's,
  runs in local git on a Mac, and the server's repository changes only through
  a push that a grant allows.
- A second model reviewing the plan document before the developer sees it.
  The developer reads the split and decides alone.
- More than one active plan per project, and re-planning after approval.
  Changing the split means `atelier plan stop` and a new plan.
- A cloud runner. Every job is taken by a home runner.
- Metering spend per token. `atelier runner --usage` reports each tool's
  allowance, tokens and cost, but nothing feeds that to routing, so paid
  models are an opt-in at approval, not a budget Atelier counts.

Nor does `plan show` yet show the plan branch's combined checks or its
mergeability with main. Main never moves in this walk, so the `refresh`
job that merges main into the plan's branch — dispatched by the tick
once main has moved, and run again by `atelier plan refresh` after a
failed one — never runs here.
