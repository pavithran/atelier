# Atelier design

## Source of the tokens

Every colour, face, radius, spacing step and duration comes from the
portfolio design set, `ai-projects-design`, copied into `src/theme.css` by
`bin/sync-theme`. `src/layout.css` arranges those tokens and defines no colour
of its own; it names three of them for their part here: the page is
`--surface`, a raised sheet is `--surface-raised`, and a selected row is
`--inset`. Light and dark follow the Graphite theme. To change how Atelier
looks, change the tokens in `ai-projects-design`, not this project.

## What the pages are for

Atelier's subject is several agents working at once under one owner, and
evidence graded by where it was observed. The pages show that subject, not
only a list of tasks.

- **Decisions** puts the next human decision beside its evidence. Its first
  screen also shows who is on the floor, so the parallel work is visible
  before anything is opened.
- **Studio** is the floor itself: one lane per live task on a shared time
  axis. A lane is banded by who held the task, so a handoff is a visible
  change of band, and the current holder's band is tinted with the signal
  colour and runs to the "now" line. Every recorded event is a mark on the
  lane. The page refreshes every fifteen seconds without script.
- **Projects** and **History** list work in motion and work finished.

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
