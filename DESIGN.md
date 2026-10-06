# Atelier design

## Source of the tokens

Every colour, face, radius, spacing step and duration comes from the
portfolio design set, `ai-projects-design`, copied into `src/theme.css` by
`bin/sync-theme`. Atelier uses the set's Night theme, its default since
version 4.0.0; light and dark follow the device. The faces are the set's
default stacks: IBM Plex Sans, IBM Plex Mono, and Bricolage Grotesque for
display, loaded from Google Fonts, which the content security policy allows
and nothing else.

`src/layout.css` arranges those tokens. It defines colour only where the set
has no role: one colour per family of agent (`--m-anthropic`, `--m-openai`,
`--m-zai`, `--m-google`, `--m-other`, `--m-owner`) and the main
line (`--main-line`), each with a darker daylight value. It names three
tokens for their part here: the page is `--surface`, a raised sheet is
`--surface-raised`, and a selected row is `--inset`. To change how Atelier
looks, change the tokens in `ai-projects-design`, not this project.

## What the pages are for

Atelier's subject is several agents working at once under one owner, and
evidence graded by where it was observed. The pages show that subject, not
only a list of tasks.

- **Decisions** puts the next human decision beside its evidence. Its first
  screen also shows who is on the floor, so the parallel work is visible
  before anything is opened.
- **Studio** is the floor itself: one lane per live task on a shared time
  axis, drawn as the Flow graph draws a thread. A lane is banded by who held
  the task, each band and the thread along it in the holder's family colour
  (a local run dotted), so a handoff is a visible change of band and colour;
  the current holder's band runs to the "now" line, where the head breathes.
  Every recorded event is a mark on the lane. The page refreshes every
  fifteen seconds without script.
- **Code** and **Log** carry a stripe per entry and per commit in the family
  of the agent the commit's message names, with that name in words beside
  it; an entry's stripe is the commit that last changed it.
- **Sign in** stands over the public showcase's graph, dimmed, when the
  owner shows projects publicly; the graph is the showcase's redacted one.
- **Projects** is a card per project: its tally of tasks and the last two
  weeks of moves, a bar per day stacked by the family of the agent that made
  them, with the owner's decisions on top.
- **History** is the timeline of merges and closures across projects, by
  day, each marked in the family of the agent that held the task when it
  ended; a closure is a grey cap, not a dot.

## Evidence always says where

Wherever a check is reported as passed, the page says whether Atelier ran it
in a Cloudflare container or the agent's machine ran it: in the decision line
("Checks passed in a Cloudflare container"), and in each check's row. Under a
project's sandbox-only policy, a check that ran only on an agent's machine is
shown as waiting, with the reason. Reports are labelled as reported and never
read as passing.

## Marks on a lane

Each kind of event has its own shape as well as its own colour, because
colour never carries status alone.

| Event | Shape |
| --- | --- |
| Claimed | open square |
| Handed off | double chevron, signal colour |
| Pushed | vertical tick |
| Check passed in a Cloudflare container | filled circle |
| Check passed on the agent's machine | open circle |
| Check failed | cross |
| Reported, not verified | dashed circle |
| Submitted | open diamond |
| Approved | upward triangle |
| Changes requested | downward triangle |
| Accepted | filled diamond, signal colour |

Marks that land within about one per cent of the axis of each other are
staggered above and below the line so none hides another.

## Constraints

No script runs on any page; every action is a form post bound to the
revision on screen, and the content security policy forbids script. Badges
never wrap. Pages hold their layout without horizontal scrolling at 390 px,
and the navigation drops its icons below 720 px so all four destinations fit.

The [orchestrator design](docs/orchestrator.md) describes plans, review and integration, with implementation status.
