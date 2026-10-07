# Demo: one goal, end to end

This walks one goal through Atelier's orchestrator, from the project owner
stating it to the plan's merge into main, with what each command prints in
outline and where to watch each step. A last section lands a single task
that is not part of a plan. Every command and flag here is in
`atelier help`; what the code does not yet do is listed at the end, not
described along the way.

The project is called `demo`. Its owner is `pavi`. The goal is a small
feature with two parts, so the plan's dependency order, the automatic
cross-family review and the integration branch all show up once.

## Before you start

**Sign in and register the project.** In the project's checkout:

```sh
atelier login --server https://atelier.zone
atelier init --title "Demo" --check "npm test" --protect "src/rules.ts"
```

`init` creates the baseline repository in Artifacts, pushes the current
branch to it, and records the branch, the checks and the protected paths.
It prints the policy it recorded:

```text
Demo (demo): baseline demo now holds main @ 5ebb64e9.
Checks:     npm test
  npm test: read-only, a known build or test command
Ship:       0 protected commands
Protected:  src/rules.ts
Eligible:   any agent
Overlap:    flagged
```

Add `--sandbox-only` to count only checks run in a Cloudflare container.
Without it, a check runs in a clean clone on the machine that runs it, and
is recorded as Observed there.

**Fill the model pool.** Routing needs a model that can build each part
and a model of another family that can review it; an approval is refused
otherwise. Two entries are enough here:

```sh
atelier models add glm-5.3 --harness opencode --where home
atelier models add opus-5.5 --harness claude-code --where cloud
```

`atelier models` lists the pool with each model's family and what a runner
last found. Atelier never stores a key; `--keychain NAME` names the Keychain
entry that holds one when a harness needs it.

**Configure a home runner with build, plan and review jobs.** The runner
offers `build` and `plan` jobs for every harness in its config, and
`review` when the config lists it. Save `~/.config/atelier/runner.json`
with one entry per harness; the README's Home runner section has a full
example. The three placeholders that matter for this walk:

- `{plan_file}` in a harness's command lets it take plan jobs: the harness
  writes the plan document there and commits nothing.
- `{diff_file}` and `{verdict_file}` let it take review jobs: it reads the
  diff and writes its verdict.
- `"jobs": ["review"]` at the top level makes the runner offer review jobs.

```json
{
  "agents": [
    { "agent": "opencode", "models": ["glm-5.3"],
      "command": ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "…"],
      "env": ["ZAI_API_KEY"] },
    { "agent": "claude-code", "models": ["opus-5.5"],
      "command": ["claude", "…", "{model}", "{brief_file}", "{plan_file}", "{diff_file}", "{verdict_file}"] }
  ],
  "jobs": ["review"]
}
```

Set each command to match the installed harness; the runner runs it without
a shell. Then start the runner, and leave it running:

```sh
atelier runner --name home:studio
```

It polls the queue every thirty seconds and prints one line per step as
`runner: …`. `--once` handles one job and exits, which suits a rehearsal.

**Start the integrator.** A second runner, with `--integrate`, runs no
harness and takes no config. It offers only the `integrate` and `refresh`
jobs and merges each part onto its plan's branch as `atelier/integrator`:

```sh
atelier runner --name home:integrator --integrate
```

**Open the places to watch.** Three views show the whole walk:

- `atelier inbox` prints what waits on the owner, most urgent first. The
  Decisions page at `/decisions` shows the same.
- The Studio at `/studio` draws one lane per live task, banded by holder,
  with a mark for every claim, push, check, submission and review. Each
  part becomes a lane when a runner claims it.
- `atelier plan show tP --project demo` prints the plan's phase, its parts
  with their state and routing, and the command for every decision waiting
  on the owner. It is the page for the plan in text; run it after each step.

## 1. State the goal

```sh
atelier plan "Add JSON output to the export script and document it" --scope "src/export.ts" --scope "test/export.test.ts" --scope "README.md" --planner claude-code/opus-5.5 --project demo
```

Atelier creates the plan item and queues it as a plan job for the planner.
Without `--planner`, the planner is the first model in the pool for research
work that is not refused, not paid per token and may plan. A project has one
active plan at a time.

```text
t10 is a plan for: Add JSON output to the export script and document it
Planner: claude-code/opus-5.5. Named by the project owner
The plan job waits in the queue for claude-code/opus-5.5; a runner that offers plan jobs takes it. To plan by hand, claim t10 as claude-code/opus-5.5 with --runner home:NAME, then atelier plan post t10 FILE. When a proposal arrives, read it with atelier plan show t10 --project demo.
```

`atelier plan show t10 --project demo` now says `Phase: planning.`, `No
valid proposal yet.` and that the plan job is waiting in the queue. The
plan does not appear in the inbox yet: nothing waits on the owner.

## 2. The planner's job

Within a poll the runner takes the plan job. Its log, in outline:

```text
runner: claimed
runner: workspace reset to HEAD and untracked files removed
runner: plan posted: 3f9c…e21b
runner: released: the plan job is done
```

What happened: the runner claimed the plan item as the planner, which forks
the baseline. That fork is the plan's integration branch. It fetched the
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
https://atelier.zone/p/demo/t10
```

`atelier show t10 --project demo` prints the same brief. The split itself:

```sh
atelier plan show t10 --project demo
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

The routing shown is what an approval would fix now, without paid models; it is computed again when you approve.

Approve this split: atelier plan approve t10 --hash 3f9c…e21b --project demo
  or send it back: atelier plan revise t10 --note "what to change" --project demo
```

Routing is computed by Atelier, never taken from the planner: for each part
a builder, two alternates and a reviewer of a different family, chosen from
the pool, the registry and the ledger's record of each model. The reasons
say why each was chosen and who was passed over.

To send the proposal back, `atelier plan revise t10 --note "Split the test
into its own part" --project demo` returns the plan to its planner with the
note; the next proposal replaces this one and the old hash can no longer be
approved. To approve, copy the full 64-character hash the command printed:

```sh
atelier plan approve t10 --hash HASH --project demo
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
with `--runner home:studio`. A part forks from the plan's fork, not from the
baseline, and is measured against it. The runner fetches the part's brief
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
instead of kept, so it goes back to the same builder once with the failing
output in its next brief, then to an alternate. A runner that gives up
with no commit releases the part too, and after two such releases the
dispatch moves to the next alternate.

`atelier plan show t10 --project demo` now shows:

```text
  t11  export-json  submitted by opencode/glm-5.3  Add JSON output to the export script
      scope src/export.ts, test/export.test.ts; depends on nothing
      builder opencode/glm-5.3: …
      alternates claude-code/opus-5.5
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
# Work in the printed workspace and commit the changes.
atelier done "Add JSON output to the export script"
```

`start` claims the part, prints the workspace to work in, and prints its
title, scope and dispatch note. `done` is `finish` with a required summary,
and its last line is `Ready for the owner` or what still blocks the part.

## 5. Checks

Each required check runs in a clean clone of exactly the head Artifacts
holds, never in the agent's workspace, and is recorded as Observed with the
paths that changed since the part's base. A line per check, then the paths
the Worker measured:

```text
PASS  npm test  @ 8c44da71
changed: src/export.ts, test/export.test.ts
```

With `--sandbox` on `finish`, `done` or `check`, or under a project set up
with `init --sandbox-only`, the checks run in a Cloudflare container started
from the Worker, and each line ends with its duration and `in Cloudflare`:

```text
PASS  npm test  @ 8c44da71  (41s, in Cloudflare)
```

The container holds no token; the Worker streams the exact files into it,
and its only network reach is the npm registry, to download. Under `--sandbox-only` a
check run on an agent's machine does not count, and the pages say so.

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
part, the brief's inputs and a read token for the fork. It cloned the head
read-only into a folder of its own, wrote the diff to the diff file, built
the reviewer's brief (the goal, the part's spec and acceptance criteria,
the scope and any paths outside it, the builder's summary, the observed
checks and where each ran, earlier findings, and the diff), and ran the
harness. The harness wrote a verdict: approve or reject, a summary, and
findings, each with a path, a severity (blocker, should or nit) and a note.
The runner posted it as `atelier review t11 --approve --head SHA --note
"…" --findings JSON` as the reviewer. A harness that writes no valid
verdict makes the runner release the request with `review-release`, so
another reviewer may take it.

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
same reviewer first. After two rounds the part goes to an alternate
builder; after that the plan is blocked and appears in the inbox. On the
Studio the lane shows both bands, the review marks and the new push.

Review verdicts and findings live on the part's page, and
`atelier show t11 --project demo` prints them in the brief. Later, the
owner can record `atelier finding t11 --head SHA --index 1 --verdict
confirmed` to say the finding was right, which counts toward the
reviewer's precision on the Models page.

## 7. Integration onto the plan's branch

An approval from another family moves the part to integration. The Ledger
dispatches an `integrate` job on the plan item, naming the part and its
head, to the reserved actor `atelier/integrator`. The plan item has
exactly one owner, so integrations are serialized. The integrator runner
takes it. Its log is quiet when an integration succeeds; it prints
`runner: failed: …` when one does not, and one line after the last part
(below).

It claimed the plan item (the Worker first checks that the part's head
merges cleanly onto the plan's branch, and sends it back to the builder if
not), fetched the part's head with `read-token`, merged it with `--no-ff`,
pushed, and ran the plan's checks on the branch with `atelier check t10`.
The plan item's checks compare against the baseline, which is right for
the whole branch. Then it reported `atelier integrated t10 --part
export-json --merge-commit SHA`; the Worker verifies the commit is on the
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
dispatches it. `t12` forks from the plan's branch as it is now, so it sees
the new output. It is built, checked, reviewed and integrated the same way.
After the last part integrates, the integrator submits the plan item:

```text
runner: every part is integrated; the plan item is submitted for the owner
```

## 8. The owner accepts and merges the plan

The plan now waits on the owner. `atelier inbox` lists it, and
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
atelier merge t10 --head FULL_REVISION --project demo
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
plan's contributors and its family is not recognised. The owner then
accepts with an override, and the reason goes on the record as an event of
its own, never as a review:

```sh
atelier merge t10 --head FULL_REVISION --override-review "Each part was reviewed by another family; the integrator only merged them" --project demo
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
from now on, `atelier abandon t11 --note "…"` gives a part up, and
`atelier plan stop t10 --note "…"` closes the plan and every part not yet
merged, revoking their write tokens. History and evidence stay.

## 9. One task outside a plan: `atelier land`

Not every change needs a plan. For one task, the owner files it and either
dispatches it to a runner or lets an agent take it:

```sh
atelier new "Show the time each check took on its row" --scope "src/ui.ts" --project demo
atelier dispatch t13 --to home --agent opencode --project demo
```

The runner builds it as in step 4, and the agent's `done` leaves it
submitted. Then the owner lands it whole, in the registered checkout:

```sh
atelier land t13 --project demo
```

```text
Landing lease taken for t13 (submitted); one landing at a time in demo.
Merged main at 1e0f77a2 into t13's workspace (4 commits from main).
Pushed 5d31b9c0 to t13's fork.
Review requested for claude-code/opus-5.5: …. Waiting for the verdict…
claude-code/opus-5.5 approved t13 at 5d31b9c0.
t13 landed: t13 merged as 2b8d41e7 in /Users/pavi/Projects/demo; baseline and ledger agree.
The landing lease for demo is released; another task may land.
```

`land` takes the project's landing lease on the server, so two sessions
never race main; merges main into the task's workspace, stopping on
conflicts and naming the files for the owner to resolve by hand; runs the
project's regenerate command when `init --regenerate` declared one;
pushes; runs the required checks; submits; asks the server for the
independent review the gate needs and waits for the verdict; then accepts
and merges through the CLI's own `accept` and `merge`, run as its children,
whose output it prints only when one fails. Each step and its duration are
recorded on the task as `land.*` events. `--reviewer H/M`
names the reviewer, `--no-review` leaves the task submitted for the owner
to settle by hand, and `--dry-run` prints the steps and the refusals
without changing anything. A landing stopped partway is resumed by running
the same command again.

## What this walk does not show

`docs/orchestrator.md` lists these under Deferred work, and nothing above
relies on them:

- A web page for plans. This walk reads a plan with `atelier plan show`.
- Merging in Cloudflare. Every merge, the integrator's and the owner's,
  runs in local git on a Mac, because the Artifacts binding can read a
  repository but not write it.
- A second model reviewing the plan document before the owner sees it.
  The owner reads the split and decides alone.
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
