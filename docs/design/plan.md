# Design plan: what Atelier's pages should be

Task t499, 2026-10-11. Designs to [brief.md](brief.md) and answers
[critique.md](critique.md) (findings F1–F23). Mockups for every page are in
[mockups/](mockups/index.html), each with its desktop (1440) and phone (390)
frames side by side and numbered notes that cite the findings and
proposals below.

## 1. The principle

Each page answers its audience's five-second question (brief §2) in its
first screen, with **state before explanation, evidence before action, one
primary action**. Everything else is one click away, not one scroll away.

## 2. One shared navigation

Today: a rail (Home, Decisions, Studio, Settings ▸), eight project tabs, and
a breadcrumb, three systems that disagree about where the owner is (F1). The
plan replaces all three with **one bar in two rows**, drawn by one function
for every owner page, and a separate public bar.

### Owner bar, row 1: where in Atelier

```
Atelier   Decisions (14)   Projects   Activity          [Ledger Core ▾]  [Owner ▾]
```

| Item | Goes to | Replaces | Current when |
|---|---|---|---|
| **Decisions (n)** | `/decisions` | rail Decisions | `/decisions` |
| **Projects** | `/home` (titled "Projects") | rail Home, `/projects` | `/home`, and any `/p/…` page |
| **Activity** | `/studio`, with a switch *Now · Flow · Merges* to `/studio`, `/flow`, `/history` | rail Studio, Home's "Across projects" sentence | `/studio`, `/flow`, `/history` |
| **Project switcher ▾** | a `<details>` list of every project, waiting count beside each | the cards as the only way between projects | — |
| **Account ▾** (owner's name) | `<details>`: Models, Usage, Sign out | rail Settings ▸, rail foot | `/models`, `/usage` |

`n` is the one "waiting on you" count (P6) and is the same number everywhere.
The brand links to `/decisions`, the owner's first question.

### Owner bar, row 2: where in a project (only under `/p/NAME`)

```
Ledger Core › t197      Overview   Tasks (200)   Code   Activity   Settings
```

| Tab | Holds | Replaces |
|---|---|---|
| **Overview** | where it stands, waiting, running, recent merges, ship requests | Overview, Ship's pending requests |
| **Tasks** | every task with filters: state, holder, kind (Plans are kind = plan) | Tasks, Plans |
| **Code** | tree and file, with a *Files · Log* switch; commits and path history inside | Code, Log |
| **Activity** | the project's flow | Flow |
| **Settings** | policy, protected actions (approve, history), public showcase setting | Settings, Ship, Home's per-card showcase form |

Five tabs instead of eight; the left of the row is the location
(`Project › task`), which replaces the breadcrumb, so there is exactly one
"you are here". On a task page, Tasks is current and the task id is the last
crumb with `aria-current="page"`.

### Phone (under 720 px)

Row 1 becomes `Atelier · Decisions (14) · Menu ▾`; the menu is a
`<details>` (no script) holding Projects, Activity, the project list and the
account items. Row 2 keeps the location on its own line and the five tabs as
one row that scrolls sideways inside its own frame (permitted by 1.4.10),
with the current tab first in view. Total navigation height: 96 px, against
164 px plus wrapping tabs today.

### Landmarks and keyboard

- `<header>` holds both rows; row 1 is `<nav aria-label="Atelier">`, row 2
  `<nav aria-label="Project">`; one `<h1>` per page, in `<main>`.
- The skip link stays first and goes to `<main>`; pages with a graph add
  "Skip the graph" before it (P13).
- `aria-current="page"` on exactly one item per row.

### The owner/public boundary

| Shell | Drawn for | Holds |
|---|---|---|
| **Owner bar** | a request with a verified session (and Access, where configured) | the two rows above |
| **Public bar** | everyone else, on every page including errors | Atelier (to `/`), How it works, Source, Sign in |

The shell is chosen by who asked, not by which renderer answers: an error
page for a visitor draws the public bar (P2). No owner route renders the
public bar's Sign in link, and no public page renders anything from row 1.

## 3. Page by page

| Page | First screen answers | Changes (proposal) | Mockup |
|---|---|---|---|
| Decisions | the top decision and its action | dedupe overlap reasons; one count; orchestrator list folded to its count (P6) | [decisions](mockups/decisions.html) |
| Projects (`/home`) | which project needs me | cards keep tally + waiting; the lead becomes a legend; showcase form moves to Settings (P10); counts from P6 | [projects](mockups/projects.html) |
| Activity: Now (`/studio`) | who works on what | live.js instead of meta refresh, visible "Live · paused" control (P12); stale lanes marked (P7) | [activity-now](mockups/activity-now.html) |
| Activity: Flow (`/flow`) | what moved | latest 20 stories, older by "Show more" link; skip-the-graph (P8, P13) | [activity-flow](mockups/activity-flow.html) |
| Activity: Merges (`/history`) | what merged | one week per page, older/newer (P9) | [activity-merges](mockups/activity-merges.html) |
| Project Overview | where it stands | counts strip; top five waiting, rest behind "all 24"; no raw JSON (P5) | [project-overview](mockups/project-overview.html) |
| Project Tasks | find a task | state filter chips with counts, holder and kind filters, 50 per page, coloured state tags (P4) | [project-tasks](mockups/project-tasks.html) |
| Task | state, evidence, my one action | decision header (P3): state word, why, primary action; evidence; then the rest | [task](mockups/task.html) |
| Code (files, log, commit, path history) | what is in the baseline | one location row; Files · Log switch (P1) | [code](mockups/code.html) |
| Project Activity | this project's threads | as Flow, one project (P8) | [activity-flow](mockups/activity-flow.html) |
| Project Settings | what policy applies | policy, protected actions, public showcase (P10) | [project-settings](mockups/project-settings.html) |
| Models, Usage | is the pool healthy | state first: one row per model or tool with its status; explanations to `/how` (P11) | [models-usage](mockups/models-usage.html) |
| Errors | what happened, where to go | shell by audience; message by cause: not found, unavailable, no access (P2) | [errors](mockups/errors.html) |
| Showcase, How it works, Sign in | what Atelier is | public bar unchanged; shorter leads (P11) | [public](mockups/public.html) |

## 4. Proposed tasks

Each is sized for one task. Criteria are at most 300 characters. "Traces"
names the findings it answers.

**P1. One navigation for every owner page**
- Scope: `src/ui.ts` (`page`, `projectPage`, `projectTabs`, browse `frame`), `src/browse/view.ts`, `src/layout.css`, tests.
- Depends on: t456 (project areas; merged).
- Traces: F1, F12, F18.
- Criteria: Every owner page draws one header: row 1 Decisions, Projects, Activity, project switcher, account; under /p/ row 2 Project › task and the project's tabs as they stand. One aria-current per row. No rail or breadcrumb. 390 px: 96 px tall, no page overflow.

**P2. Error pages by audience and cause**
- Scope: `src/ui.ts` (`renderError`, `publicPage`), `src/index.ts` (the error path and bare `Not found.` answers), tests.
- Depends on: none (can land first).
- Traces: F2, F14, F22.
- Criteria: A request without a verified owner session gets the public bar on every error. Owner errors keep the project row. Not found, unavailable and no-access each have their own heading and next step. No bare "Not found." text remains.

**P3. The task page leads with one decision**
- Scope: `src/ui.ts` (`renderItem`, `reviewBody`), `src/rules.ts` (`stateLabel`, `decisionFor`), `src/brief.ts`, tests.
- Depends on: t367 (palette B, five steps), t498 (task headline, rounds; merged), t474 (owner actions).
- Traces: F3, F4, F5, F19, F23.
- Criteria: The header shows one state word (brief §5), one sentence why and one primary action; a rejection, failed check, scope change or unreadable diff overrides Ready. Evidence precedes secondary actions. The brief folds after 3 lines. Round summaries wrap at 320 px.

**P4. A task list the owner can scan**
- Scope: `src/ui.ts` (`renderProjectTasks`), `src/index.ts` (query parameters), `src/layout.css`, tests.
- Depends on: t497 (filters, paging), t456 (stages; merged), P3 (state names).
- Traces: F6, F11, F19.
- Criteria: On t497's filtered, paged list, each state tag is coloured by role with its word and shape, plans are a kind filter (the Plans tab's list), counts show beside each filter, and the create form is behind a button. Filters stay links that work without script.

**P5. A compact project overview**
- Scope: `src/ui.ts` (`renderProject`, `standingSection`), tests.
- Depends on: t504 (owner-action rule), t497 (overview fits 1440x900).
- Traces: F6, F13.
- Criteria: The overview shows a counts strip, at most five waiting tasks with a link to all, running work and the last five merges; briefs are not inlined. The empty project offers "Create the first task" and shows no raw event JSON. 1440 px height under 2,500 px.

**P6. One "waiting on you" count, without overlap noise**
- Scope: `src/rules.ts` (`inboxFor`, `isOwnCall`), `src/ui.ts` (Home, Overview, Decisions, nav count), tests.
- Depends on: t504 (one rule for Home, Overview, status and inbox), P1 (the bar that shows the count).
- Traces: F7, F9.
- Criteria: The bar's Decisions (n) and the project switcher use t504's rule and equal Decisions per project. In t504's overlap disclosure each task is one line naming at most three others and "n more"; a task with no scope is said so once.

**P7. Stale is shown where the task is**
- Scope: `src/rules.ts`, `src/ui.ts` (task page, Studio lanes, task list), tests.
- Depends on: P3, t498.
- Traces: F3.
- Criteria: A claimed task with no push for 12 hours shows "Working · stale 2 d" on its page, its list row and its Studio lane, with the handoff and release actions first, matching the inbox's "Needs a handoff" entry.

**P8. Flow pages that load on a phone**
- Scope: `src/ui.ts` (`renderFlow`, `renderProjectFlow`), `src/graph.ts`, `src/index.ts`, tests.
- Depends on: t497.
- Traces: F6, F10.
- Criteria: /flow and /p/NAME/flow draw at most 20 stories by default, with a link for more; the HTML is under 300 KB with the fixture's 310 tasks; the filter state is in the heading; a "Skip the graph" link precedes each graph.

**P9. Merges paged by week**
- Scope: `src/ui.ts` (`renderHistory`), `src/index.ts`, tests.
- Depends on: P1 (Activity switch).
- Traces: F6.
- Criteria: /history shows one week per page with newer and older links that work without script, the week's merge and closure counts in the heading, and the unreadable-project notice as role=status.

**P10. Settings live in Settings**
- Scope: `src/ui.ts` (Home cards, `renderProjectSettings`, `renderProjectShip`, `renderProjectPlans`), `src/index.ts` (tab routes, 301s), tests.
- Depends on: P1 (the project row it cuts to five tabs).
- Traces: F1, F8.
- Criteria: The project row has five tabs. The showcase setting moves from Home's cards to project Settings; Ship's approvals join Settings and its pending requests the Overview; Plans become Tasks filtered by kind. Old tab URLs answer 301.

**P11. State instead of sentences**
- Scope: `src/ui.ts`, `src/usage/page.ts`, `src/how.ts` copy only, tests that pin copy.
- Depends on: t367 (vocabulary).
- Traces: F8.
- Criteria: No page lead is over 20 words; Home, Usage, Models and Ship replace their explanatory leads with legends, thresholds beside their meters, or a link to the matching /how section. /how keeps every removed explanation.

**P12. Studio refreshes like the other live pages**
- Scope: `src/ui.ts` (`renderStudio`), `src/index.ts`, `src/live.ts`, tests.
- Depends on: P1 (where the live state is shown).
- Traces: F15, F18.
- Criteria: Studio uses /live.js instead of a meta refresh, keeps scroll and focus across refreshes, and shows a visible "Live" state with a pause control in the page, on phones too.

**P13. Every focusable thing shows focus**
- Scope: `src/layout.css`, `src/graph.ts`, `src/browse/view.ts`, tests.
- Depends on: none.
- Traces: F16, F22, keyboard check.
- Criteria: select, code lines and graph beads draw a focus indicator of at least 2 px with 3:1 contrast against adjacent colours; each graph is preceded by a Skip the graph link; public pages have a skip link; audit.json records no focus stop without an indicator.

**P14. Company colours only inside charts (d9)**
- Scope: `src/layout.css` (`--m-*`), `src/ui.ts` (Studio lanes, Home, History marks), `src/browse/view.ts` (file and log stripes), tests.
- Depends on: t367 (palette B, whose light family colours measure 5.30 or more: brief §1.1).
- Traces: F17, standing decision d9.
- Criteria: No --m-* colour is drawn outside a chart or its legend: no swatches, stripes, lane edges or coloured names; agents are named in text colour; graph lines keep 3:1 and legend text passes 4.5:1 in both schemes.

**P15. Captures with plans, refreshed after each landing**
- Scope: `test/fixtures/design/**`, `scripts/design/**`, `docs/design/**`.
- Depends on: none; the first full capture is done (e9dbe08, recaptured at c2915e3, Chromium 149.0.7827.55).
- Traces: capture status in the critique.
- Criteria: The fixture adds a plan proposed, building and blocked, and tasks in areas; npm run design:capture writes every brief state at 1440 and 390 with audit.json; it is rerun after each task in section 6 lands and the critique's status table updated.

**P16. Clear the measured accessibility failures**
- Scope: whatever `docs/design/audit.json` names; tests.
- Depends on: P15 (capture), P3 (round summaries, F23), P13 and P14, which clear most of it.
- Traces: F23; contrast, keyboard and reflow checks.
- Criteria: Every contrast failure, focus stop without an indicator, target under 24 px outside running text, and page wider than 320 px (overflows in audit.json, also with disclosures open) is fixed or recorded in the critique as an accepted exception.

**P17. An unreadable project shows no numbers**
- Scope: `src/ui.ts` (Home's project card, the nav's project switcher), tests.
- Depends on: P6 (the count it would otherwise show); t504 labels unread data; this proposal draws it.
- Traces: F21.
- Criteria: A project whose records cannot be read shows "Unavailable" in place of its four counts on Home and in the switcher, with a Retry link; it shows no zero it did not count, and its showcase setting stays editable.

## 5. Existing tasks: what they cover and what is new

Each task below was re-read on 2026-10-11 with `atelier show tN` (and
`atelier ls --project atelier` for its holder and head); the "Record" column
is what the ledger said then. Coverage is judged from each task's own
acceptance criteria, not from its title. The captures at c2915e3 already
include t456 and t498, which had merged.

| Task | Record (2026-10-11) | What its criteria cover | Findings it covers | Left as new work here | Captures to refresh after it lands |
|---|---|---|---|---|---|
| **t367** One vocabulary and palette B | **Submitted**, head 7d64b297, held by claude-code/opus-5.5; checks passed on a runner; waits for a review by another family | Palette B on every page (#4d8bff the only accent, company colours inside charts only, no copper or brown, AA tested); red only for failures, deletions and destructive actions; the five steps Claim, Fork, Prove, Review, Land on the task page, in /how, the showcase and the README; no route or field renamed | F17 (its light family colours pass: brief §1.1); F8 in part (/how's headings). Not F3: steps, not state names | Its vocabulary is the five *steps*, not the state names: brief §5's one name per state stays this plan's (P3, P4); P11 the copy; P14 checks that no family mark is left outside charts (d9) | all 48 states (palette); `task-*` (step strip); `public-how`, `public-showcase` (headings) |
| **t456** Tasks grouped by function, with each task's stage | **Merged** at d3ace584 (merge 92e5824e) | Areas with stable ids, `new/edit --area`, an Unsorted area; one pure stage function for web and CLI; both views show area purpose, title, stage and holder | F6 in part (grouping), F3 in part (one stage word per row) | P1 navigation; P4 state tags, plan kind, create behind a button; P10 tab merge; P15 seeds areas (the fixture has none, so `tasks` shows one Unsorted area) | none: in the c2915e3 captures (`tasks`, `tasks-empty`) |
| **t474** Owner actions need a path that is not the terminal | **Open**, unclaimed, nothing pushed, checks waiting; the record holds a title and no parsable criteria | As titled: owner actions performed from the page rather than the terminal (t504's criterion 3 says "t474 performs it") | F5 in part | P3 orders state → evidence → actions and picks one primary, on t474's controls | `task-*`, `decisions*` |
| **t496** Waiting on you lists only what needs the owner | **Abandoned**, nothing pushed; refiled as t504 with the same criteria | — | — | — | — |
| **t504** Waiting on you holds only what needs the owner | **Submitted**, head ad97b0b6, held by claude-code/opus-5.5; checks passed on a runner; waits for a review by another family | One pure rule places each live task in owner action or a t456 stage; Home, Overview, `status` and `inbox` agree; counts are distinct tasks; unread data labelled; one sentence and a link per owner item; overlaps in a disclosure | F7, F9 (inline overlaps), F21 in part (labels unread data) | P6 the bar's count and the switcher, and overlap lines inside the disclosure; P5 overview layout; P17 draws "Unavailable" instead of zeros | `home`, `decisions*`, `project`, `project-unavailable` |
| **t497** Long owner pages become scannable | **Blocked** by the owner until t504 lands; nothing pushed | Task list filtered by stage, holder and company with search, filters and page in the URL, closed hidden by default; 50 a page, stable sort; on a 500-task fixture the overview fits 1440 × 900, no page overflows at 390, overview under five phone screens; long sections behind disclosures | F6, F11 | P4 (state tags, kinds, create button); P5 (counts strip, five waiting); P8 and P9 (Flow and Merges, which t497 does not touch) | `tasks`, `tasks-empty`, `project`, `project-empty`, `decisions*` |
| **t498** A task page states its state once and collapses stale notices | **Merged** at fc8a3fe2 (merge 80bcf202) | One ledger-derived headline with the latest reason; notices grouped by kind, check and binding, originals in a disclosure; rounds by submission, newest first | F3 on the task page in part; F4 in part | P3 (header order, overrides, one primary); P7 stale; F23, which t498's round summary introduced (its full head hash does not wrap at 320 px) | none: in the c2915e3 captures (`task-*`, `decisions*`) |

Not covered by any existing task: F2 (public boundary on errors), F10 (page
weight), F12–F16, F18, F22 and F23 — P2, P8, P12, P13 and P16 are new, and
P17 finishes what t504 starts for F21.

## 6. Dependency order

Every proposal comes after each task and proposal its "Depends on" names
(`test/fixtures/design/docs.test.ts` checks this order and that the graph
has no cycle).

0. Merged already, and in the captures at c2915e3: **t456**, **t498**.
1. **P15, first capture** — done: 96 screenshots, first at e9dbe08,
   recaptured at f32c997 and at c2915e3 (main with t498's task headline and
   t456's board on the Tasks page), the baseline every later capture is
   compared with.
2. **P2** and **P13** — no dependencies; P2 closes a Blocker.
3. **t367** (submitted, awaiting review), then **P11** and **P14**.
4. **P1**, then **P10**, **P9** and **P12** — the navigation needs t456's
   areas (merged); the tab merge, Merges and Studio's live state need the
   navigation.
5. **t474**, then **P3** (with t367 and t498), then **P7**.
6. **t504** (submitted, awaiting review), then **P6**, then **P17**.
7. **t497** (blocked until t504 lands), then **P4**, **P5** and **P8**.
8. **P15 again** after each of steps 3–7 (refresh the captures the table in
   section 5 names), then **P16** on the final capture.

## 7. Mockups

[mockups/index.html](mockups/index.html) lists them. Each file is static HTML
with one shared stylesheet (`mockups/mockup.css`, palette B as fixed in
brief.md §1.1, from t367's
`src/theme.css`), no script, desktop and phone frames side by side, and
numbered notes citing F and P numbers. They are drawn at the fixture's
numbers, so each can be compared with its capture.
