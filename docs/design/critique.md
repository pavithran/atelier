# Design critique: every owner and public page

Task t499, 2026-10-11, against [brief.md](brief.md). Findings are numbered
**F1–F22** and ranked by severity: **Blocker** (wrong or unsafe: the page
says something false, or crosses the public boundary), **High** (the
five-second question cannot be answered), **Medium** (slows the answer or
fails a WCAG criterion in part), **Low** (polish). Each finding names the
proposals in [plan.md](plan.md) (**P1–P17**) that answer it.

## How this was measured

| Evidence | Where it comes from | Status |
|---|---|---|
| Every page's HTML, drawn by the production renderers from the seeded fixture | `test/fixtures/design/render.design.ts` (`npm run design:capture`, render step) | **Measured** in this run: statuses, text, word counts, list sizes, link and form counts quoted below |
| Fixture and page assertions | `test/fixtures/design/fixture.spec.ts` (in `npm test`) | **Passing**: 310 tasks, every state at its status and text, no secret on a public page |
| Palette contrast | [contrast.md](contrast.md), from the tokens | **Measured** |
| Full-page screenshots at 1440 and 390 px, rendered contrast, focus order, target size, reflow at 320 px | `npm run design:capture` → `screens/`, `screens/manifest.json`, `audit.json` | **Measured**: 96 screenshots of 48 states, source e9dbe08 (clean), Chromium 149.0.7827.55 (playwright-core 1.61.1), fixed time 2026-10-10 12:00 UTC. Every finding below was checked against them; corrections are marked *Capture:* |
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
heading). *Capture:* `task-open-long-390.png` puts the title about 380 px down,
under the rail's top bar, the breadcrumb and two rows of eight tabs. → **P1**.

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
`task-unreadable` (t191): "Checks passed on a runner, in a clean
clone · Ready to accept", then "Changes are unavailable. Approval and
acceptance are unavailable until the displayed changes match…". 
`task-scope` (t200): "Ready to accept" with the **Accept revision** button
first; "Changes outside the declared scope" comes after the thread. The
state line must be computed from everything the page knows, not from the
gate alone. → **P3**.

### F5. Actions before evidence on every live task — High
On every live task page the actions come directly under the decision line,
before the revision, the thread, the evidence and the recommendation. The
owner is offered actions before being told what is true. `task-protected`
carries 9 forms. *Capture:* the forms are folded: what shows is a row of
three buttons (`task-sent-back-1440.png`: Approve revision, Request changes,
Block this task) whose forms open on demand. The bulk is smaller than the
HTML suggested; the order, and a primary button that contradicts the
evidence below it (F3), remain. → **P3**.

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
(every sketch capture at 1440). *Capture:* confirmed on every tall page at
1440, e.g. `home-1440.png` (rail ends at 900 of 1,905 px) and
`task-sent-back-1440.png`. → **P1** removes the rail.

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
textarea, pre` only. *Capture:* `select` (Home's showcase setting, Ship's
duration) and `ol.code-lines[tabindex=0]` (`code-file`) fall back to
Chromium's own `outline: auto` ring: visible, but unthemed and not measured
against 3:1. The measured gap is the graph beads, whose `outline: none`
(`layout.css:546`) leaves a scale-up and a stroke that the audit does not
count as an indicator: 73 of 200 stops on `flow`, 61 on `project-flow`, 10
on each `decisions*`, 2 on `flow-filtered`, 1–2 on each live task page.
→ **P13**.

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

### F21. An unreadable project reads as an idle one — Medium
*Capture:* on Home (`home-1440.png`) the cold-storage card shows "0 waiting
on you, 0 running, 0 ready to start, 0 merged" in the same large numerals
as the healthy cards, with "Temporarily unavailable. Open to retry." in
small text beneath. The zeros are not known; they are drawn as if they
were. → **P17**.

### F22. The public showcase is the least keyboard-ready page — Medium (WCAG 2.4.1, 2.4.7)
*Capture:* every owner page's first Tab stop is "Skip to content";
`public-showcase`, `public-how` and `signin` start at the brand link with
no skip link, and on `public-showcase` 8 of its 13 stops are graph beads
with no indicator, so a visitor's focus disappears into the story threads.
→ **P13**, **P2**.

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
| Showcase `public-showcase` | [1440](screens/public-showcase-1440.png) · [390](screens/public-showcase-390.png) | Redaction complete; tallies; story threads | 775 words before the cards end; lead is 35 words (F8); no skip link, 8 of 13 focus stops without indicator (F22) | Medium | P11, P13 |
| No showcase `public-showcase-none` | [1440](screens/public-showcase-none-1440.png) · [390](screens/public-showcase-none-390.png) | Says why | Owner rail and Sign out to a visitor (F2) | Blocker | P2 |
| Explainer `public-how` | [1440](screens/public-how-1440.png) · [390](screens/public-how-390.png) | Complete reference | 13,073 words; 111 sentences of 30+ words; no way back to `/` but the brand | Medium | P11 |
| Visitor on owner URL `public-owner-route` | [1440](screens/public-owner-route-1440.png) · [390](screens/public-owner-route-390.png) | Same answer for any name: no enumeration | Owner rail (F2); "Let's resolve this." | Blocker | P2 |
| Sign in `signin` | [1440](screens/signin-1440.png) · [390](screens/signin-390.png) | Clear single form; backdrop is decorative and `aria-hidden` | Backdrop draws 12 threads behind the form: the audit reads CSS backgrounds, not the drawn threads, so contrast over them is still unmeasured; no skip link (F22) | Low | P13 |
| Home `home` | [1440](screens/home-1440.png) · [390](screens/home-390.png) | Cards put waiting work first; family bars | 32-word lead (F8); the unreadable project's card shows four zeros (F21); counts disagree with Overview and Decisions (F7); Flow and History only as a sentence (F1); the showcase select on every card mixes a setting into a status page | High | P1, P6, P10, P17 |
| Decisions `decisions` | [1440](screens/decisions-1440.png) · [390](screens/decisions-390.png) | Next decision beside its evidence; phone shows list and detail as two views | 14 long sentences; orchestrator list unbounded (F6); overlap reasons repeated (F9) | High | P6 |
| Decisions, sent back `decisions-sent-back` | [1440](screens/decisions-sent-back-1440.png) · [390](screens/decisions-sent-back-390.png) | The note is shown | Badge "In review", line "Changes requested", button Approve (F3) | Blocker | P3 |
| Decisions, blocked `decisions-blocked` | [1440](screens/decisions-blocked-1440.png) · [390](screens/decisions-blocked-390.png) | Reason and who blocked | Recommendation "decide" names no decision | Medium | P3 |
| Studio `studio` | [1440](screens/studio-1440.png) · [390](screens/studio-390.png) | Lanes show who holds what | Meta refresh (F15); 6,000 px at 1440, 9,807 at 390; the three stale lanes (t163–t165, last push 1 d ago) are tagged "Working" like the rest, and only their long tinted bars hint at age (F3) | Medium | P12, P7 |
| Flow `flow` | [1440](screens/flow-1440.png) · [390](screens/flow-390.png) | The whole portfolio's threads | 1.5 MB, 1,681 links (F10); no rail entry (F1) | Medium | P8, P1 |
| Flow filtered `flow-filtered` | [1440](screens/flow-filtered-1440.png) · [390](screens/flow-filtered-390.png) | Filters are links, work without script | Filter state not reflected in the heading | Low | P8 |
| History `history` | [1440](screens/history-1440.png) · [390](screens/history-390.png) | By day, family mark | 241 rows, no paging (F6); unreadable-project notice lacks `role=status` | Medium | P9 |
| Models `models` | [1440](screens/models-1440.png) · [390](screens/models-390.png) | Empty states say what to add | 7 long sentences; the empty pool is below 1,100 words of record | Medium | P11 |
| Usage `usage` | [1440](screens/usage-1440.png) · [390](screens/usage-390.png) | Alerts first; stale reports tagged | Lead names four environment settings (F8) | Medium | P11 |
| Overview `project` | [1440](screens/project-1440.png) · [390](screens/project-390.png) | "Where it stands" is the right idea | 24 waiting incl. overlaps (F7, F9); 42 disclosures; 2,541 words; live analogue 27,968 px (F6) | High | P5, P6 |
| Overview, empty `project-empty` | [1440](screens/project-empty-1440.png) · [390](screens/project-empty-390.png) | Says nothing waits | Raw JSON event (F13); no "create the first task" action | Low | P5 |
| Overview, unavailable `project-unavailable` | [1440](screens/project-unavailable-1440.png) · [390](screens/project-unavailable-390.png) | 503, retryable | Error shell loses the project's tabs; generic advice (F2) | Medium | P2 |
| Tasks `tasks` | [1440](screens/tasks-1440.png) · [390](screens/tasks-390.png) | t456's area board: stage word and holder per row | Fixture assigns no areas, so all 200 rows sit in one "Unsorted" area: no filter or paging (F6); "Holder: unheld" repeated 200 times; a stage word per row beside no state tag (F3); create form above the board | High | P4 |
| Tasks, empty `tasks-empty` | [1440](screens/tasks-empty-1440.png) · [390](screens/tasks-empty-390.png) | Short | Since t456's board an empty project draws an "Unsorted 0/0 merged" area, its purpose line and "No tasks.": three lines for nothing, and the old pointer to the create form is gone | Low | P4, P5 |
| Project flow `project-flow` | [1440](screens/project-flow-1440.png) · [390](screens/project-flow-390.png) | — | 1.1 MB, 1,244 links (F10) | Medium | P8 |
| Plans `plans` | [1440](screens/plans-1440.png) · [390](screens/plans-390.png) | Empty state is short | A whole tab for a list that is empty in most projects (F1); raw phase word beside the state tag | Medium | P1, P10 |
| Ship `ship` | [1440](screens/ship-1440.png) · [390](screens/ship-390.png) | Approval bound to one revision | 40-word policy lead; the form precedes "nothing approved yet" | Medium | P1, P11 |
| Settings `settings` | [1440](screens/settings-1440.png) · [390](screens/settings-390.png) | Policy in plain words | Shares the name "Settings" with the account menu (F1) | Low | P1 |
| Code `code`, `code-dir`, `code-file` | [1440](screens/code-1440.png) · [390](screens/code-390.png), [dir](screens/code-dir-1440.png), [file](screens/code-file-1440.png) | Stripes name the family that last changed each entry | Breadcrumb plus tabs plus rail (F1); code lines lack a focus ring (F16) | Medium | P1, P13 |
| No commits `code-no-commits` | [1440](screens/code-no-commits-1440.png) · [390](screens/code-no-commits-390.png) | Says why | Error shell: tabs and project lost (F2) | Low | P2 |
| Log `log`, `log-page-2` | [1440](screens/log-1440.png) · [390](screens/log-390.png), [p2](screens/log-page-2-1440.png) | The only paged list (50) | "Log" and "History" mean different things in the tabs and the rail | Low | P1 |
| Commit `commit`, path history `path-history` | [1440](screens/commit-1440.png) · [390](screens/commit-390.png), [path](screens/path-history-1440.png) | Diff per file | — | Low | P1 |
| Task, open long `task-open-long` | [1440](screens/task-open-long-1440.png) · [390](screens/task-open-long-390.png) | Brief and criteria in full on the one page that shows them | Brief unfolded before state (F19): at 390 the brief fills about 520 px before "Ready to start" | Medium | P3 |
| Task, working `task-working` | [1440](screens/task-working-1440.png) · [390](screens/task-working-390.png) | Revision and holder | Actions before evidence (F5) | High | P3 |
| Task, stale `task-stale` | [1440](screens/task-stale-1440.png) · [390](screens/task-stale-390.png) | — | Not called stale; "wait" recommendation (F3) | High | P3, P7 |
| Task, blocked `task-blocked` | [1440](screens/task-blocked-1440.png) · [390](screens/task-blocked-390.png) | Who, when, why, and Unblock | "decide" verdict without a decision | Medium | P3 |
| Task, failed `task-failed` | [1440](screens/task-failed-1440.png) · [390](screens/task-failed-390.png) | Failed check opens with its output tail | Badge "In review" (F3) | High | P3 |
| Task, ready, diff unreadable `task-unreadable` | [1440](screens/task-unreadable-1440.png) · [390](screens/task-unreadable-390.png) | Refuses to accept unseen changes | Says Ready and unavailable at once (F4) | Blocker | P3 |
| Task, ready `task-ready` | [1440](screens/task-ready-1440.png) · [390](screens/task-ready-390.png) | One primary action; summary marked "not verified" | Badge "In review" beside "Ready to accept" (F3) | High | P3 |
| Task, protected `task-protected` | [1440](screens/task-protected-1440.png) · [390](screens/task-protected-390.png) | Override needs the owner's own sign-in | 9 forms; 676 words before the diff | High | P3 |
| Task, sent back `task-sent-back` | [1440](screens/task-sent-back-1440.png) · [390](screens/task-sent-back-390.png) | The reviewer's note is kept | Three answers (F3); Approve is primary | Blocker | P3 |
| Task, accepted `task-accepted` | [1440](screens/task-accepted-1440.png) · [390](screens/task-accepted-390.png) | The exact merge command | — (*Capture:* the 40-hex command scrolls inside its `pre`; no page overflow at 320) | Low | P3 |
| Task, scope `task-scope` | [1440](screens/task-scope-1440.png) · [390](screens/task-scope-390.png) | Out-of-scope files are listed | Accept offered before the warning (F4) | Blocker | P3 |
| Task, merged `task-merged` | [1440](screens/task-merged-1440.png) · [390](screens/task-merged-390.png) | Diff as it landed; says deploy is separate | — | Low | — |
| Task, closed `task-abandoned` | [1440](screens/task-abandoned-1440.png) · [390](screens/task-abandoned-390.png) | t498's single headline, "Task closed", says the history remains | Still shows a merge preview ("Up to date… merges as it is") and two "Waiting" required checks ("The task owner must run this required check") for work that will never merge; "Submission history is unavailable" twice | Low | P3 |
| Task not found `task-not-found` | [1440](screens/task-not-found-1440.png) · [390](screens/task-not-found-390.png) | 404 | "refresh the evidence" advice (F2) | Medium | P2 |
| Fork browsed `fork-code`; no fork `fork-none` | [1440](screens/fork-code-1440.png) · [390](screens/fork-code-390.png), [none](screens/fork-none-1440.png) | Same browser for fork and baseline | Error shell loses the task (F2) | Low | P2 |

## Separate checks

All "measured" numbers below are from `audit.json` (source e9dbe08,
Chromium 149.0.7827.55), checked at 1440 in light and dark and at 390 and
320 px. An automated pass is not a conformance claim: it misses meaning,
order that is logical but wrong, and text over drawn backgrounds.

### Contrast (WCAG 1.4.3, 1.4.11)
- **Palette, measured** ([contrast.md](contrast.md)): every role token
  (text, text-bright, text-muted, text-dim, signal, signal-hot, observed,
  caution, fault) is at least 4.85:1 on every surface in both schemes; the
  lowest is `--text-dim` on `--inset` in light, 4.85. Family colours fail as
  normal text in light on the sheet and inset (F17). The focus ring
  (`--signal-hot`) is at least 6.05:1 against every surface (1.4.11 met for
  the ring's own colour).
- **Rendered, measured**: 13,402 text elements checked across the 48 states
  in both schemes. **Dark: no failure. Light: 33 failures, all small text**:
  - family colours as graph labels, as F17 predicted: GPT `#0b7a5c` on
    `#e4e0d5` 4.03 (every task page's thread, 11 states) and on `#eeebe2`
    4.46 (`decisions*`, `public-showcase`); Qwen `#4d7a12` on `#eeebe2` 4.29;
    Claude `#b4461c` 4.15 as a filter link on `flow-filtered`;
  - the selected Decisions row's "Ready to accept" tag, `#1d6b3c` on the
    selection tint `#ccd2c3`, 4.21 (`decisions`): new, a role colour on a
    tinted surface the token table does not cover. → **P14**, **P16**.
- **Not measured**: 3,728 elements sit over a background image or gradient
  (the task sheet, mostly; 60–103 per task page in each scheme) and are counted as unknown,
  not passing. Text over the sign-in backdrop's drawn threads is read
  against the CSS background only. Non-text contrast (1.4.11) of tag
  borders, bead strokes and chart bars is not measured.
- *Method note:* the first run reported dark primary buttons at 3.00:1; the
  buttons' background transition had not finished after the scheme switch.
  The capture now turns transitions off before the contrast pass (after the
  screenshot), and the dark failures are gone.

### Keyboard and focus (WCAG 2.1.1, 2.4.1, 2.4.3, 2.4.7, 2.4.11, 2.5.8)
- **Measured, skip link**: the first Tab stop is "Skip to content" on all
  45 owner and error states; the three public pages (`public-showcase`,
  `public-how`, `signin`) have none (F22).
- **Measured, indicators**: no stop without an indicator except graph beads
  (F16, F22); `select` and the code lines use the browser's default ring.
- **Measured, length**: the walk stops at 200 stops; `flow`, `project-flow`,
  `history` and `tasks` reach it, so the main content of each is more than
  200 stops long and has no skip-the-list or skip-the-graph link (F6, F10).
  `decisions*` take 126–129 stops.
- **Measured, obscured**: no stop was off screen when focused (2.4.11).
- **Measured, target size at 390** (2.5.8, links in running text excepted):
  graph beads at 11–19 px are the bulk (975 on `flow`, 711 on
  `project-flow`); task-id links at 15 px high in the Overview's waiting
  list (69); commit links at 21 px in the Log (50 a page) and path history;
  the tag-row links "Changes"/"Checks" at 22 px on each task page; Home's
  card task links at 22 px (22). → **P16**.
- **Not measured**: whether the order is meaningful (it follows the DOM,
  which puts actions before evidence, F5), screen-reader names beyond the
  label text recorded, and focus behaviour inside the opened forms.

### Reflow (WCAG 1.4.10, 1.4.4)
- **Measured at 320 px**: no state scrolls the page sideways; graphs and
  `pre` blocks scroll inside their frames (permitted).
- **Measured, one exception**: on `task-open-long` ten elements of a form
  (labels, a select, inputs, the primary button) reach 370 px with no
  scrolling ancestor. The audit does not check visibility, so this is
  probably the closed "Send to an agent" form; whether it overflows when
  opened is not verified. → **P16**.
- **Captured at 390**: titles of 79 characters wrap to four lines; the
  project tabs wrap to two rows (F1).
- **Not measured**: 200% text zoom (1.4.4) and text-spacing overrides
  (1.4.12).

### Public-data exposure (brief §1.5)
- **Measured** by `fixture.spec.ts` on every page a visitor or a signed-out
  owner can reach (`public-*`, `signin`): none of `field-notes`, `Field
  Notes`, `Keychain.swift`, `jo@private.example`, the check command or the
  review note appears. The anonymised project is "An iOS app"; its stories
  are kinds of work. The screenshots of those states agree.
- **Crossing found**: the owner's navigation and Sign out on public error
  pages (F2), confirmed in `public-owner-route-1440.png` ("Project owner",
  Sign out) and `public-showcase-none-1440.png`. It holds no record, but it
  is owner chrome on a public answer, and it tells a visitor which areas
  exist.
- **By design, recorded**: the owner's name appears on the public showcase
  ("Owner made 79 decisions") and a named project's task titles appear.
  Owner pages show the private project's names in full (`home-1440.png`:
  "Fix the Keychain.swift crash for jo@private.example"), as they should.
- **Not covered**: the 60-second showcase cache after a project is removed
  (tested elsewhere, test/showcase.spec.ts).
