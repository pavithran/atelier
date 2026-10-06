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
- **The public showcase** is the owner's portfolio, read only: a card per
  project the owner opted in, with its two weeks of activity as a bar per day
  stacked by family, its tasks merged, sent back and in progress, and a few
  task stories drawn as threads. An anonymised project is titled by a neutral
  label from its kind and its stories by their kind of work; its name, task
  titles, paths, commit messages, review notes, people and addresses are
  left out on the server, before anything is rendered. Nothing is public
  until the owner's setting says so, and a project may instead be shown
  named.
- **Sign in** stands over the portfolio's activity, dimmed and clipped to
  the viewport, when the owner shows projects publicly; the graph is the
  showcase's, anonymised as the setting says.
- **Home** is the portfolio: a card per project with what needs the owner
  there, what is running, its two weeks of moves as a bar per day stacked by
  the family of the agent that made them, and its last merge. Projects with
  something waiting come first. The portfolio's Flow and its timeline are
  reached from here, and the Models and Usage pages live under the account
  menu, out of the work navigation.
- **A project's area**, under /p/NAME, is the unit the owner works in:
  Overview (where it stands and what waits on the owner there), Tasks (one
  list of every task, each row with its state, its holder and when it last
  moved), Flow (the project's own graph), Plans (each plan as one unit with
  its parts, their state and why each went to its agent), Code, Log, Ship
  (protected actions and their history) and Settings (the checks with their
  classes and path conditions, the protected paths, the eligible agents, the
  ControlPlane policy). A task's page sits inside the area.
- **History** is the timeline of merges and closures across projects, by
  day, each marked in the family of the agent that held the task when it
  ended; a closure is a grey cap, not a dot. It is reached from Home, and a
  project's own record is its Log tab.

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

Every page reads fully without script, and every action is a form post
bound to the revision on screen. Flow, Decisions and a task's page also
carry Atelier's own script, served from this origin under a nonce made for
the request, which the content security policy names and the script tag
carries; no inline script and no script from elsewhere runs, and every
other page keeps the policy that forbids script. The script only refreshes
those pages and animates what arrived, and adds the scrubber that steps
through a task's recorded events in order. A refresh never changes the
revisions on screen: when the fetched copy binds its forms to revisions
other than the ones the page shows, one moved, new or gone, the page keeps
what it shows, says a new revision arrived with a link to reload, and
stops refreshing. Badges never wrap. Pages hold their layout without horizontal scrolling at 390 px,
and the navigation drops its icons below 720 px so its three work destinations
and the account menu fit.

The [orchestrator design](docs/orchestrator.md) describes plans, review and integration, with implementation status.
