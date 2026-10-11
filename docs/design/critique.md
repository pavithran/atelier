# Design critique: every owner and public page

Task t499, 2026-10-11, against [brief.md](brief.md). Findings are numbered
**F1–F20** and ranked by severity: **Blocker** (wrong or unsafe: the page
says something false, or crosses the public boundary), **High** (the
five-second question cannot be answered), **Medium** (slows the answer or
fails a WCAG criterion in part), **Low** (polish). Each finding names the
proposals in [plan.md](plan.md) (**P1–P16**) that answer it.

## How this was measured, and what is still pending

| Evidence | Where it comes from | Status |
|---|---|---|
| Every page's HTML, drawn by the production renderers from the seeded fixture | `test/fixtures/design/render.design.ts` (`npm run design:capture`, render step) | **Measured** in this run: statuses, text, word counts, list sizes, link and form counts quoted below |
| Fixture and page assertions | `test/fixtures/design/fixture.spec.ts` (in `npm test`) | **Passing**: 310 tasks, every state at its status and text, no secret on a public page |
| Palette contrast | [contrast.md](contrast.md), from the tokens | **Measured** |
| Full-page screenshots at 1440 and 390 px, rendered contrast, focus order, target size, reflow at 320 px | `npm run design:capture` → `screens/`, `screens/manifest.json`, `audit.json` | **Not yet run**: no Chromium build for playwright-core 1.61.1 is cached on the machine this was written on, and the command never downloads one. The screenshot links below resolve once it runs; `screens.test.ts` fails until they do |
| The earlier sketch's 20 screenshots (d6db01d, older fixture) | `screens/sketch-d6db01d/` | **Measured heights** quoted where they bear on a finding |
| Live atelier.zone | The owner's note on t499 | `/p/atelier` is 27,968 px tall at 1440; t435's page said Ready after a send-back |

Screenshots alone do not establish WCAG conformance; the four checks
(contrast, keyboard and focus, reflow, public data) are recorded separately
at the end, each with what is measured and what is not.

## Cross-cutting findings

### F1. Two navigations, three location systems — High
Every project page carries the rail (Home, Decisions, Studio, Settings ▸),
eight project tabs (Overview, Tasks, Flow, Plans, Code, Log, Ship, Settings)
and, on task and code pages, a breadcrumb (Home / Ledger Core / t182). The
rail marks **Home** as current on every project page, on Flow and on
History, so the rail never says where the owner is. Flow and History have
no entry at all; they are reached from a sentence on Home ("Across
projects: the whole flow · the timeline of merges"). "Settings" means the
account (Models, Usage) in the rail and the project policy in the tabs. On a
phone the rail becomes a top bar with a Settings disclosure, and the tabs
wrap below it (sketch `home-390.png`: 164 px of navigation before the
heading). → **P1**.

### F2. Visitors see the owner's navigation on every error — Blocker
`renderError` always draws the owner's shell. A visitor without Access's
sign-in (`public-owner-route`, 401) and a visitor to a server with no
showcase (`public-showcase-none`, 404) both get the rail with Home,
Decisions, Studio, Settings, "Project owner" and a **Sign out** button
(seen in sketch `public-proj-390.png`). No record leaks (see Public data
below), but the boundary in brief §1.5 is crossed, and every link in that
rail leads a visitor to a 401. The headline "Let's resolve this." and the
advice "Go back, refresh the evidence, and try the available action again"
are the same for a 404 task id (`task-not-found`), an unreadable project
(`project-unavailable`, 503) and a missing workspace (`fork-none`), where no
evidence or action exists. → **P2**.

### F3. One state, many names; the badge contradicts the decision — Blocker
The task page's eyebrow badge is `stateLabel`; the decision line is
`decisionFor`; the recommendation is the brief's verdict; the inbox tag is
`KIND`. They disagree on the same page (fixture, measured):

| State | Badge | Decision line | Recommendation | Primary button |
|---|---|---|---|---|
| `task-sent-back` (t197) | In review | Changes requested | send back | **Approve revision** |
| `task-failed` (t188) | In review | Checks need attention | send back | Request changes |
| `task-stale` (t163) | Working | — | wait: "The task is in progress" | Request changes |
| `task-blocked` (t166) | Blocked | Blocked | decide | Unblock |
| `task-protected` (t195) | In review | Waiting for an independent review | — | Approve revision |

A claimed task alone is "Working", "in progress", "running", "Claimed" and
"Handed off" across Home, Flow, the graph and Studio; accepted is "Ready to
merge", "accepted" and "Accepted"; abandoned is "Closed", "Task closed",
"closed without merging" and "abandoned". The stale task's page never says
it is stale, while Decisions and Home call it "Needs a handoff". The live
t435 page said Ready after a send-back; this fixture's send-back at the same
head reads "Changes requested" in the decision line but "In review" in the
badge with Approve offered, so the owner is shown three answers. (A
send-back followed by a new push at a new head is legitimately ready again;
the page does not say that a rejection stands on an older revision.) → **P3**
(after t367 and t498).

### F4. The decision says Ready while the page refuses — Blocker
`task-ready-unavailable` (t191): "Checks passed on a runner, in a clean
clone · Ready to accept", then "Changes are unavailable. Approval and
acceptance are unavailable until the displayed changes match…". 
`task-scope` (t200): "Ready to accept" with the **Accept revision** button
first; "Changes outside the declared scope" comes after the thread. The
state line must be computed from everything the page knows, not from the
gate alone. → **P3**.

### F5. Actions before evidence on every live task — High
On every live task page the first things under the title are the forms
"Request changes / What needs to change? / Send review" and "Block this task
/ What is it waiting on?" with a 25-word explanation, before the revision,
the thread, the evidence and the recommendation. The owner is offered
actions before being told what is true. `task-protected` carries 9 forms.
→ **P3**.

### F6. Unbounded pages — High
Nothing is paged or filtered except the Log:
- `tasks`: all 200 tasks as one list (200 `<li>`, 3,083 words). The sketch's
  50-task list measured 4,808 px at 1440 (96 px a row) and 16,071 px at 390
  (321 px a row): 200 tasks is about 19,000 px and 64,000 px. There is no
  filter by state, holder or kind and no search.
- Live `/p/atelier` measured 27,968 px at 1440 (owner).
- `project` overview: 2,541 words, 42 `<details>` (every briefed task's
  brief is a disclosure), 24 items "waiting on you".
- `history`: 231 merges and 10 closures on one page (276 `<li>`, 4,796 words).
- `decisions`: 14 entries plus the orchestrator list; the sketch's measured
  5,881 px at 1440 is mostly "Handled by the orchestrator".
- `flow`: 1.5 MB of HTML and 1,681 links (see F10). → **P4, P5, P6, P8, P9** (t497).

### F7. "Waiting on you" counts three ways — High
For ledger-core at the same instant: Home's card says **9 waiting on you**,
the Overview says **24 things waiting on you here**, Decisions says **14
decisions need your attention** (all projects; ledger-core's share differs
again). Home counts distinct tasks whose entry is the owner's own call
(`isOwnCall`, src/rules.ts); the Overview counts distinct tasks with any
entry but a failing check, overlaps and scope changes included
(`standingSection`, src/ui.ts); Decisions counts its own-call group across
every project, with the orchestrator's entries in a second list.
The owner cannot trust any number. → **P6** (t496).

### F8. Sentences in place of state — Medium
Sentences of 30 words or more in `<main>`: Decisions 14, Home 7, Models 7,
Usage 6, `/how` 111. Home opens with 32 words explaining the card; Usage
opens with the four threshold settings' names; the Ship tab with a 40-word
policy statement; every live task page repeats the block-form explanation.
Each of these is a fact the page could show as state (a legend, a threshold
beside its meter, a tag) or move to `/how`. → **P11**.

### F9. Overlap noise — Medium
A task with no declared scope overlaps every other live task. The fixture's
`project` overview lists for t191 "scope overlaps t192 …; scope overlaps
t193 …" seven times in one entry; the sketch's Decisions shows "Overlapping
work · Overlapping work · …" repeated twenty times per row. → **P6**.

### F10. Page weight — Medium
`/flow` is 1,533 KB of HTML with 1,681 links; `/p/ledger-core/flow` 1,107 KB
with 1,244 links; every page inlines 72 KB of CSS. On a phone the flow is
slow to parse and, for a keyboard, 1,681 tab stops long (Keyboard below).
→ **P8**.

### F11. Status is not scannable — Medium
Task-list tags are one grey except Merged; a failed, blocked, sent-back or
stale task looks like a working one at a glance (sketch
`proj-states-tasks-1440.png`). → **P4**, with P3's one vocabulary.

### F12. The rail ends at the first screen — Low
On a page taller than the viewport the rail's background stops at 900 px
(every sketch capture at 1440). → **P1** removes the rail.

### F13. Raw internals on an empty project — Low
`project-empty` shows "Ledger events · project set owner" with the policy as
raw JSON (`{ "policy": { "checks": [ "npm test" ] … } }`) and the API
address. → **P5**.

### F14. Bare "Not found." — Low
An unknown path under the owner's routes, `/p/NAME/a/b/c` and an unknown
form verb answer the bare text "Not found." with no page, no navigation and
no way back (src/index.ts). → **P2**.

### F15. Studio reloads the whole page every 15 s — Medium (WCAG 2.2.1)
Studio uses `<meta http-equiv="refresh" content="15">`, which reloads the
page, resetting scroll and focus and interrupting a screen reader, with no
way to pause. Decisions, Flow and the task page use `/live.js`, which swaps
`<main>` only and stops on a revision change. → **P12**.

### F16. Focus indicator gaps — Medium (WCAG 2.4.7, 2.4.13)
`layout.css:64` draws the focus ring for `a, button, summary, input,
textarea, pre` only. Not covered: `select` (Home's showcase setting,
Ship's duration), `ol.code-lines[tabindex=0]` (`code-file`), and graph beads,
whose `outline: none` (`layout.css:546`) is replaced by a scale-up and a
stroke that have not been measured against 3:1. → **P13**.

### F17. Family colours as text in light mode — Medium (WCAG 1.4.3)
Measured ([contrast.md](contrast.md)): `--m-anthropic` 4.15, `--m-openai`
4.03, `--m-google` 4.49 and `--m-qwen` 3.88 on `--inset`; `--m-openai`
4.46 and `--m-qwen` 4.29 on the sheet. These colour text in `.lane .who
strong`, `.journey .n` and the legends. Every role token passes in both
schemes. → **P14** (palette changes wait for t367).

### F18. The live state is hidden — Low
The "Live" note sits in the rail's foot; when it refreshes is shown only on
hover or focus, and on a phone the rail foot is hidden, so a phone user is
never told the page refreshes. → **P1, P12**.

### F19. Long text — Medium
`task-open-long`: the 79-character title and 860-character brief open the
page in full before any state or action; the brief has no fold. On cards
and list rows titles wrap to three lines at 390 (sketch `decisions-390`).
→ **P3, P4**.

### F20. What is strong — keep
- The public showcase's redaction is complete for every secret in the
  fixture (Public data below), and it reads well as a portfolio.
- Evidence always says where it ran ("passed on a runner, in a clean clone",
  "in a Cloudflare container"), as the brief requires.
- Every action is a form bound to the revision on screen; the live script
  stops rather than swap a different revision in.
- The palette's role tokens pass 4.5:1 in both schemes; there is a skip link.
- The thread graph and the Studio lanes show parallel work at a glance.

## Page by page

Screenshots: `screens/<id>-1440.png` and `screens/<id>-390.png` for each
state id (written by `npm run design:capture`; see the status table above).

| Page / state | Screens | Strengths | Failures | Severity | Proposed |
|---|---|---|---|---|---|
| Showcase `public-showcase` | [1440](screens/public-showcase-1440.png) · [390](screens/public-showcase-390.png) | Redaction complete; tallies; story threads | 775 words before the cards end; lead is 35 words (F8) | Low | P11 |
| No showcase `public-showcase-none` | [1440](screens/public-showcase-none-1440.png) · [390](screens/public-showcase-none-390.png) | Says why | Owner rail and Sign out to a visitor (F2) | Blocker | P2 |
| Explainer `public-how` | [1440](screens/public-how-1440.png) · [390](screens/public-how-390.png) | Complete reference | 13,073 words; 111 sentences of 30+ words; no way back to `/` but the brand | Medium | P11 |
| Visitor on owner URL `public-owner-route` | [1440](screens/public-owner-route-1440.png) · [390](screens/public-owner-route-390.png) | Same answer for any name: no enumeration | Owner rail (F2); "Let's resolve this." | Blocker | P2 |
| Sign in `signin` | [1440](screens/signin-1440.png) · [390](screens/signin-390.png) | Clear single form; backdrop is decorative and `aria-hidden` | Backdrop draws 12 threads behind the form: contrast of the form text over it is unmeasured | Low | — |
| Home `home` | [1440](screens/home-1440.png) · [390](screens/home-390.png) | Cards put waiting work first; family bars | 32-word lead (F8); counts disagree with Overview and Decisions (F7); Flow and History only as a sentence (F1); the showcase select on every card mixes a setting into a status page | High | P1, P6, P10 |
| Decisions `decisions` | [1440](screens/decisions-1440.png) · [390](screens/decisions-390.png) | Next decision beside its evidence; phone shows list and detail as two views | 14 long sentences; orchestrator list unbounded (F6); overlap reasons repeated (F9) | High | P6 |
| Decisions, sent back `decisions-sent-back` | [1440](screens/decisions-sent-back-1440.png) · [390](screens/decisions-sent-back-390.png) | The note is shown | Badge "In review", line "Changes requested", button Approve (F3) | Blocker | P3 |
| Decisions, blocked `decisions-blocked` | [1440](screens/decisions-blocked-1440.png) · [390](screens/decisions-blocked-390.png) | Reason and who blocked | Recommendation "decide" names no decision | Medium | P3 |
| Studio `studio` | [1440](screens/studio-1440.png) · [390](screens/studio-390.png) | Lanes show who holds what | Meta refresh (F15); sketch 8,585 px at 390; whether a stale lane is marked is unmeasured until the capture | Medium | P12, P7 |
| Flow `flow` | [1440](screens/flow-1440.png) · [390](screens/flow-390.png) | The whole portfolio's threads | 1.5 MB, 1,681 links (F10); no rail entry (F1) | Medium | P8, P1 |
| Flow filtered `flow-filtered` | [1440](screens/flow-filtered-1440.png) · [390](screens/flow-filtered-390.png) | Filters are links, work without script | Filter state not reflected in the heading | Low | P8 |
| History `history` | [1440](screens/history-1440.png) · [390](screens/history-390.png) | By day, family mark | 241 rows, no paging (F6); unreadable-project notice lacks `role=status` | Medium | P9 |
| Models `models` | [1440](screens/models-1440.png) · [390](screens/models-390.png) | Empty states say what to add | 7 long sentences; the empty pool is below 1,100 words of record | Medium | P11 |
| Usage `usage` | [1440](screens/usage-1440.png) · [390](screens/usage-390.png) | Alerts first; stale reports tagged | Lead names four environment settings (F8) | Medium | P11 |
| Overview `project` | [1440](screens/project-1440.png) · [390](screens/project-390.png) | "Where it stands" is the right idea | 24 waiting incl. overlaps (F7, F9); 42 disclosures; 2,541 words; live analogue 27,968 px (F6) | High | P5, P6 |
| Overview, empty `project-empty` | [1440](screens/project-empty-1440.png) · [390](screens/project-empty-390.png) | Says nothing waits | Raw JSON event (F13); no "create the first task" action | Low | P5 |
| Overview, unavailable `project-unavailable` | [1440](screens/project-unavailable-1440.png) · [390](screens/project-unavailable-390.png) | 503, retryable | Error shell loses the project's tabs; generic advice (F2) | Medium | P2 |
| Tasks `tasks` | [1440](screens/tasks-1440.png) · [390](screens/tasks-390.png) | One list, newest first, holder and time | 200 rows, no filter or paging (F6); grey tags (F11); create form above the list | High | P4 |
| Tasks, empty `tasks-empty` | [1440](screens/tasks-empty-1440.png) · [390](screens/tasks-empty-390.png) | Points to the form | — | Low | — |
| Project flow `project-flow` | [1440](screens/project-flow-1440.png) · [390](screens/project-flow-390.png) | — | 1.1 MB, 1,244 links (F10) | Medium | P8 |
| Plans `plans` | [1440](screens/plans-1440.png) · [390](screens/plans-390.png) | Empty state is short | A whole tab for a list that is empty in most projects (F1); raw phase word beside the state tag | Medium | P1, P10 |
| Ship `ship` | [1440](screens/ship-1440.png) · [390](screens/ship-390.png) | Approval bound to one revision | 40-word policy lead; the form precedes "nothing approved yet" | Medium | P1, P11 |
| Settings `settings` | [1440](screens/settings-1440.png) · [390](screens/settings-390.png) | Policy in plain words | Shares the name "Settings" with the account menu (F1) | Low | P1 |
| Code `code`, `code-dir`, `code-file` | [1440](screens/code-1440.png) · [390](screens/code-390.png), [dir](screens/code-dir-1440.png), [file](screens/code-file-1440.png) | Stripes name the family that last changed each entry | Breadcrumb plus tabs plus rail (F1); code lines lack a focus ring (F16) | Medium | P1, P13 |
| No commits `code-no-commits` | [1440](screens/code-no-commits-1440.png) · [390](screens/code-no-commits-390.png) | Says why | Error shell: tabs and project lost (F2) | Low | P2 |
| Log `log`, `log-page-2` | [1440](screens/log-1440.png) · [390](screens/log-390.png), [p2](screens/log-page-2-1440.png) | The only paged list (50) | "Log" and "History" mean different things in the tabs and the rail | Low | P1 |
| Commit `commit`, path history `path-history` | [1440](screens/commit-1440.png) · [390](screens/commit-390.png), [path](screens/path-history-1440.png) | Diff per file | — | Low | P1 |
| Task, open long `task-open-long` | [1440](screens/task-open-long-1440.png) · [390](screens/task-open-long-390.png) | Brief and criteria in full on the one page that shows them | Brief unfolded before state (F19) | Medium | P3 |
| Task, working `task-working` | [1440](screens/task-working-1440.png) · [390](screens/task-working-390.png) | Revision and holder | Actions before evidence (F5) | High | P3 |
| Task, stale `task-stale` | [1440](screens/task-stale-1440.png) · [390](screens/task-stale-390.png) | — | Not called stale; "wait" recommendation (F3) | High | P3, P7 |
| Task, blocked `task-blocked` | [1440](screens/task-blocked-1440.png) · [390](screens/task-blocked-390.png) | Who, when, why, and Unblock | "decide" verdict without a decision | Medium | P3 |
| Task, failed `task-failed` | [1440](screens/task-failed-1440.png) · [390](screens/task-failed-390.png) | Failed check opens with its output tail | Badge "In review" (F3) | High | P3 |
| Task, ready, diff unreadable `task-ready-unavailable` | [1440](screens/task-ready-unavailable-1440.png) · [390](screens/task-ready-unavailable-390.png) | Refuses to accept unseen changes | Says Ready and unavailable at once (F4) | Blocker | P3 |
| Task, ready `task-ready` | [1440](screens/task-ready-1440.png) · [390](screens/task-ready-390.png) | One primary action; summary marked "not verified" | Badge "In review" beside "Ready to accept" (F3) | High | P3 |
| Task, protected `task-protected` | [1440](screens/task-protected-1440.png) · [390](screens/task-protected-390.png) | Override needs the owner's own sign-in | 9 forms; 676 words before the diff | High | P3 |
| Task, sent back `task-sent-back` | [1440](screens/task-sent-back-1440.png) · [390](screens/task-sent-back-390.png) | The reviewer's note is kept | Three answers (F3); Approve is primary | Blocker | P3 |
| Task, accepted `task-accepted` | [1440](screens/task-accepted-1440.png) · [390](screens/task-accepted-390.png) | The exact merge command | 40-hex command in a `pre` at 390 (reflow unmeasured) | Medium | P3 |
| Task, scope `task-scope` | [1440](screens/task-scope-1440.png) · [390](screens/task-scope-390.png) | Out-of-scope files are listed | Accept offered before the warning (F4) | Blocker | P3 |
| Task, merged `task-merged` | [1440](screens/task-merged-1440.png) · [390](screens/task-merged-390.png) | Diff as it landed; says deploy is separate | — | Low | — |
| Task, closed `task-abandoned` | [1440](screens/task-abandoned-1440.png) · [390](screens/task-abandoned-390.png) | History kept | Shows a merge preview ("Up to date… merges as it is") for work that will never merge | Low | P3 |
| Task not found `task-not-found` | [1440](screens/task-not-found-1440.png) · [390](screens/task-not-found-390.png) | 404 | "refresh the evidence" advice (F2) | Medium | P2 |
| Fork browsed `fork-code`; no fork `fork-none` | [1440](screens/fork-code-1440.png) · [390](screens/fork-code-390.png), [none](screens/fork-none-1440.png) | Same browser for fork and baseline | Error shell loses the task (F2) | Low | P2 |

## Separate checks

### Contrast (WCAG 1.4.3, 1.4.11)
- **Palette, measured** ([contrast.md](contrast.md)): every role token
  (text, text-bright, text-muted, text-dim, signal, signal-hot, observed,
  caution, fault) is at least 4.85:1 on every surface in both schemes; the
  lowest is `--text-dim` on `--inset` in light, 4.85. Family colours fail as
  normal text in light on the sheet and inset (F17). The focus ring
  (`--signal-hot`) is at least 6.05:1 against every surface (1.4.11 met for
  the ring's own colour).
- **Rendered, not yet measured**: tinted tag backgrounds
  (`rgba(var(--observed-rgb), …)`), text over the sign-in backdrop and over
  the task sheet's gradient, and opacity-dimmed graph labels.
  `scripts/design/audit.ts` measures every text element in both schemes and
  writes `audit.json`; elements over a gradient are counted as unknown, not
  as passing.

### Keyboard and focus (WCAG 2.1.1, 2.4.1, 2.4.3, 2.4.7, 2.4.11, 2.5.8)
- **Measured statically**: a skip link is the first element on owner pages;
  the focus ring rule covers `a, button, summary, input, textarea, pre`
  only (F16). Graph beads and lane links are focusable: `/flow` has 1,681
  links in `<main>`, so after the skip link a keyboard user tabs through the
  graph to reach anything below it; no "skip the graph" link exists. A live
  task page puts 3–9 forms (each 2–3 stops) before the evidence (F5).
- **Not yet measured**: the actual tab order, whether each stop draws a
  visible indicator, whether the focused element is scrolled into view and
  not obscured, and targets under 24 px — `audit.ts` walks up to 200 Tab
  stops at 1440 and records each into `audit.json`.

### Reflow (WCAG 1.4.10, 1.4.4)
- **Measured statically**: the graphs keep a minimum width inside frames
  that scroll sideways (permitted); the rail turns into a top bar under
  720 px; the Decisions desk splits into two views under 700 px.
- **Sketch screenshots at 390**: no horizontal page overflow in the 10 pages
  captured, but the long-content risks (40-hex commands in `pre`, long
  unbroken paths, 79-character titles) were not in that fixture.
- **Not yet measured**: `audit.ts` sets each page to 320 px and records the
  document's scroll width and the outermost elements that overflow outside
  a scrolling frame.

### Public-data exposure (brief §1.5)
- **Measured** by `fixture.spec.ts` on every page a visitor or a signed-out
  owner can reach (`public-*`, `signin`): none of `field-notes`, `Field
  Notes`, `Keychain.swift`, `jo@private.example`, the check command or the
  review note appears. The anonymised project is "An iOS app"; its stories
  are kinds of work.
- **Crossing found**: the owner's navigation and Sign out on public error
  pages (F2). It holds no record, but it is owner chrome on a public
  answer, and it tells a visitor which areas exist.
- **By design, recorded**: the owner's name appears on the public showcase
  ("Pavi made 79 decisions") and a named project's task titles appear.
- **Not covered**: the 60-second showcase cache after a project is removed
  (tested elsewhere, test/showcase.spec.ts).
