# Using Atelier well

This guide is for the owner of a project registered in Atelier: the person
who decides what gets done and what goes in. Atelier and the agents do the
work; the owner makes three kinds of decision. What to do, whether a plan's
split is right, and whether finished work is accepted. Everything below is
about making those decisions well and leaving the rest to the system.

`docs/orchestrating.md` is the companion for a session that runs Atelier on
the owner's behalf; the How it works page (`/how`) holds every rule and
command.

## Start with what waits for you

```sh
atelier status
```

It lists, for every project, what needs the owner: a plan to approve, work
to accept, failing checks, a change outside its scope. The Decisions page
on the site shows the same, ranked. When nothing waits, there is nothing to
do.

`atelier status --project NAME` shows one project in detail. Its "On this
Mac" section says, for each live task with a workspace on this machine,
whether it has uncommitted or unpushed work, a merge in progress or an
agent's commit message waiting, and whether a landing is running.

`atelier unwrap` gives the fuller start-of-session picture: where the
project stands, the checkout against each of its remotes, the newest session
note and the project's state file. It reads and changes nothing, so it is
always safe; a session can run it for you.

## Give work: a goal for large things, a task for small ones

Something with several parts becomes a plan:

```sh
atelier plan "what should be true when this is done" --scope "src/**" --planner claude-code/opus-5.5
```

A planner proposes parts, Atelier routes each to a model from the pool, and
nothing is dispatched until the owner approves. For now the CLI refuses a
goal longer than 500 characters, because the plan job carries the goal as its
dispatch note, which is capped there (task t198).

One clear change becomes a task:

```sh
atelier new "short title" --brief "the whole task" --accept "what must be true" --scope "path/**"
```

The title, at most 80 characters, is what every list shows; the brief and the
acceptance criteria appear on the task's page and in the briefs its builder
and reviewer get, and a reviewer blocks a change that fails a criterion. One
long text with no `--brief` becomes the brief, with its first clause as the
title; `atelier edit ID --title T --brief B --accept A` changes them.

A task filed without `--accept` is created with a warning, because a review
would have no criteria to judge its change against. `atelier init
--require-criteria` makes that a refusal for the project, and under it
`atelier edit ID --accept ""` is refused too.

The owner also changes a live task's scope with `atelier edit ID --scope GLOB`
(once per glob, or `--scope ""` to clear it); the change is recorded. In a
project that refuses overlapping claims (`atelier init --refuse-overlap`), a
claim is refused while its scope overlaps a claimed, submitted or accepted
task's, in each of those states alike (a cancelled merge leaves a task
accepted), and an unscoped task overlaps every other. The refusal names the
overlapping task and points to `atelier edit --scope`.

Give it to a session ("get this done"), or queue it for a runner with
`atelier dispatch ID`.

A good goal or title says what should be true afterwards, names the files it
may touch, and asks that every claim match the code. Keep scopes narrow: two
live tasks whose scopes overlap usually conflict when the second lands, and
`atelier status` lists such pairs under their own heading.

## Approve a plan once, and read it first

```sh
atelier plan show ID
```

Check that the parts are sensible and ordered, interfaces first; that each
part went to a model you want doing it; and that nothing in the split
contradicts what you asked. Then:

- `atelier plan approve ID --hash HASH` approves the split, by the hash of
  its newest proposal. Add `--allow-paid` when a part is routed to a paid
  model.
- `atelier plan revise ID --note "what to change"` asks the planner again.
- `atelier plan reroute ID --to H/M` sends the planning or a part to another
  model.

After approval the runner builds the parts, checks them, has each reviewed
by a model of another family, and integrates them on the plan's own branch.
The owner accepts the whole once.

## Accept work deliberately

Before accepting anything, look at three things:

- **The gate.** Its checks were observed at that exact head, and any review
  it needs is in.
- **The reviewer's findings.** A reviewer's finding is a claim about the
  code and can be wrong; on 6 October about half of one reviewer's blocking
  findings did not hold. Have a wrong one answered with the file and line
  that show it, never overridden quietly.
- **The scope flag.** A change outside its declared scope is shown on the
  task.

A single task lands with:

```sh
atelier land ID --reviewer antigravity/gemini-3.1-pro
```

which takes the project's landing lease, merges main into the task,
regenerates fixtures if the project declares how, pushes, checks, submits,
waits for the independent review a runner serves, then accepts and merges.
`atelier land` never overrides a review. When no model of another family can
review a change, `atelier accept` and `atelier merge` take
`--override-review` with the reason; the override is recorded where everyone
can see it.

## Let a session act for you

A Claude Code session opened in the project's folder, with the
`atelier-orchestrating` skill, can do the routine work: "what is waiting?",
"keep going, merge and deploy as they land", "start a plan for X". It
follows the standing decisions you have recorded.

When you decide something that should hold beyond today (which models build,
what may be spent, what blocks a review), say it plainly; the session
records it in the skill's `decisions.md`, so every later session follows it.
Ask it to file anything odd as a task rather than work around it quietly:
that is how Atelier improves.

## Watch three numbers

- **Spend** on pay-per-use models, against the daily limit you set:
  `atelier runner --usage`, or the Usage page.
- **Plan windows** of the subscription tools, such as Codex's weekly window.
- **Each model's record** on the Models page: approvals at first review,
  rounds to merge, runs that stopped early. Use it when choosing who builds.

## Habits that save trouble

- Run one home runner per machine (`atelier runner --name home:NAME`), and
  check for one before starting another: `pgrep -f "atelier.mjs runner"`.
- Deploy a project between landings, after its full test suite passes, not
  while another task's checks run.
- `atelier gc --project NAME` previews the workspaces of finished tasks that
  are safe to remove; `--apply` removes them.
- Do not edit inside an agent's workspace while its agent runs. Wait for it,
  or hand the task off with `atelier handoff ID --to H/M`.
- `atelier wrap "summary"` is for work done directly in your own checkout:
  it runs the checks, commits, updates the baseline and leaves a session
  note. Work that goes through tasks and plans does not need it.
- When something breaks, ask what task it becomes, not only how to get past
  it.

## Commands at a glance

| To | Run |
| --- | --- |
| see what waits | `atelier status` |
| see one project | `atelier status --project NAME` |
| read the full picture | `atelier unwrap` |
| start something large | `atelier plan "goal" --scope GLOB --planner H/M` |
| review a plan | `atelier plan show ID`, then `approve`, `revise` or `reroute` |
| file one task | `atelier new "title" --scope GLOB` |
| queue it for a runner | `atelier dispatch ID` |
| land one task | `atelier land ID --reviewer H/M` |
| close a session of direct edits | `atelier wrap "summary"` |
| clear finished workspaces | `atelier gc --project NAME` |
| see spend and windows | `atelier runner --usage` |
