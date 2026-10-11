# Design brief: Atelier's pages

Task t499, 2026-10-11. The owner's words, 2026-10-11: atelier.zone "feels
awkward to use. needs ui design attention"; "do it all". This brief says what
the app's pages are, who reads each and what each must answer, and the
constraints any redesign keeps. It is the reference the critique
([critique.md](critique.md)) judges against and the plan ([plan.md](plan.md))
designs to. Every route and state here is read from `src/` at the source
commit named in `screens/manifest.json`, and every state is drawn from the
seeded fixture (`test/fixtures/design/`) by `npm run design:capture`.

## 1. Constraints a redesign keeps

1. **One vocabulary and palette B (t367).** A task state has one name
   everywhere it is shown; t367 owns that vocabulary and palette B. Until
   t367 lands, the plan uses the state names in section 5 below and the
   tokens in `src/theme.css` (Night, light variant by device), measured in
   [contrast.md](contrast.md). Colour never carries a state alone: each state
   has a word, and on graphs a shape (DESIGN.md, "Marks on a lane").
   *Not verified here:* this run could not read t367 (`atelier show` is not
   available to it), so "palette B" is recorded as the owner's name for the
   choice; the plan's first task re-reads t367 before any token changes.
2. **Server rendering.** Every page is HTML from the Worker, complete without
   script. Every action is a form post bound to the revision on screen. The
   only script is `/live.js`, first party, under a per-request nonce, on the
   pages that refresh (Decisions, Flow, a project's Flow, a task's page).
3. **No production build step.** CSS ships as `src/theme.css` and
   `src/layout.css`, inlined by the Worker's text-module rule (wrangler
   `rules`, `**/*.css`); no bundler, preprocessor, framework or generated
   asset sits between the source and the page. The design tooling here
   (Playwright, fixtures) is development-only.
4. **WCAG 2.2 AA.** Contrast 4.5:1 for text and 3:1 for large text, UI
   components and focus indicators; every action reachable and visibly
   focused by keyboard; content reflows at 320 CSS px without two-way
   scrolling (a graph or code block may scroll inside its own frame); targets
   at least 24 by 24 CSS px; nothing conveyed by colour alone. Screenshots do
   not establish conformance; the critique records measurements separately.
5. **The public boundary.** A visitor who is not the owner reads only `/`,
   `/how` and the sign-in page. They never see the owner's navigation, a
   project's name when it is anonymised, task titles, paths, commands,
   commit hashes, review notes or addresses (DESIGN.md, "The public
   showcase"). Cloudflare Access stands in front of every owner route.
6. **Evidence always says where.** A passed check says whether it ran in a
   Cloudflare container or on a runner's clean clone (DESIGN.md).

## 2. Audiences and their five-second questions

| Audience | Arrives at | The question the first screen must answer in five seconds |
|---|---|---|
| **Owner, deciding** | `/decisions`, a notification link to a task | "What is waiting on me, and what do I do about the top item?" |
| **Owner, surveying** | `/home` | "Is anything stuck or broken, in which project?" |
| **Owner, inside a project** | `/p/NAME`, its tabs | "Where does this project stand: what is waiting, running, failing, merged?" |
| **Owner, on one task** | `/p/NAME/tN` | "What state is this task in, is the evidence current, and what is my one next action?" |
| **Owner, watching** | `/studio`, `/flow`, `/history` | "Who is working on what right now, and what moved?" |
| **Owner, administering** | `/models`, `/usage`, a project's Settings and Ship | "Is the pool healthy and within limits; what policy applies?" |
| **Visitor (public)** | `/`, `/how` | "What is Atelier, and is real work happening here?" |
| **Owner, signed out** | `/login` (behind Access) | "Am I on the right page to sign in?" |

## 3. HTML routes (from `src/index.ts`)

Owner routes need Cloudflare Access's assertion and an Atelier session.

| Route | Renderer | Audience | Navigation drawn today |
|---|---|---|---|
| `/` | `renderShowcase` (src/ui.ts) | public | public bar: How it works, Source, Sign in |
| `/how` | `renderHow` (src/how.ts) | public | public bar: Source, Sign in |
| `/login` | `renderLogin` (src/ui.ts) | owner signed out | public bar: How it works, Source |
| `/home` | `renderHome` | owner | rail: Home, Decisions, Studio, Settings ▸ (Models, Usage) |
| `/decisions` (`?project=&task=`) | `renderInbox` | owner | rail |
| `/studio` | `renderStudio` | owner | rail |
| `/flow` (`?since=1d\|7d\|all&family=`) | `renderFlow` | owner | rail (Home marked current; no entry of its own) |
| `/history` | `renderHistory` | owner | rail (Home marked current) |
| `/models` | `renderModels` | owner | rail, Settings menu open |
| `/usage` | `renderUsage` (src/usage/page.ts) | owner | rail, Settings menu open |
| `/p/NAME` | `renderProject` | owner | rail + eight project tabs |
| `/p/NAME/tasks` | `renderProjectTasks` | owner | rail + tabs |
| `/p/NAME/flow` | `renderProjectFlow` | owner | rail + tabs |
| `/p/NAME/plans` | `renderProjectPlans` | owner | rail + tabs |
| `/p/NAME/ship` | `renderProjectShip` | owner | rail + tabs |
| `/p/NAME/settings` | `renderProjectSettings` | owner | rail + tabs |
| `/p/NAME/code/PATH` | `renderTree`, `renderBlob` (src/browse/view.ts) | owner | rail + breadcrumb + tabs |
| `/p/NAME/log` (`?page=`) | `renderLog` | owner | rail + breadcrumb + tabs |
| `/p/NAME/commit/HASH` | `renderCommit` | owner | rail + breadcrumb + tabs |
| `/p/NAME/history/PATH` | `renderHistory` (browse) | owner | rail + breadcrumb + tabs |
| `/p/NAME/tN` | `renderItem` | owner | rail + breadcrumb + tabs (Tasks marked) |
| `/p/NAME/tN/{code,log,commit,history}/…` | browse renderers on the task's fork | owner | rail + breadcrumb + tabs |
| any error | `renderError` | anyone | **the owner's rail, even for a visitor** |

Form posts (not pages): `/login`, `/logout`, `/projects/showcase`,
`/models/add`, `/models/remove`, `/ui/NAME/new`, `/ui/NAME/tN/VERB`,
`/ui/NAME/actions/VERB`. `/live.js` is the live script. `/api/*` is the CLI's.

### Aliases and redirects

| Address | Answers | Asserted in |
|---|---|---|
| `/showcase` | the same page as `/` (200) | fixture.spec.ts |
| `/projects` | 301 to `/home` | fixture.spec.ts |
| `/flow?project=NAME` | 301 to `/p/NAME/flow` | fixture.spec.ts |
| `/p/FORMER-NAME/…` | 301 to the project's current name | src/index.ts `movedTo` |
| an owner route, Access signed in, no session | 303 to `/login` | fixture.spec.ts |
| an owner route without Access's assertion | 401 error page | captured: `public-owner-route` |
| an unknown path | 404 `Not found.` as bare text, no page | src/index.ts |

## 4. Page states

Every state below is captured at 1440 and 390 px as
`screens/<id>-<width>.png` and listed in `screens/manifest.json`; the
capture fails when one is missing (`test/fixtures/design/screens.test.ts`
fails too). Fixture: `test/fixtures/design/seed.ts`, fixed time 2026-10-10
12:00 UTC, 310 tasks across three projects with work (ledger-core 200,
field-notes 70, open-tool 40), plus `blank-slate` (no tasks) and
`cold-storage` (its Ledger unreadable). Ids in the paths are the fixture's.

| State | Address | Audience | What it shows |
|---|---|---|---|
| `public-showcase` | `/` | public | Showcase, one project named (open-tool), one anonymised (field-notes) |
| `public-showcase-none` | `/` | public | No project shown publicly (404) |
| `public-how` | `/how` | public | The explainer |
| `public-owner-route` | `/p/ledger-core` | public | A visitor on an owner URL without Access (401) |
| `signin` | `/login` | Access only | Sign-in over the anonymised backdrop |
| `home` | `/home` | owner | Portfolio: dense, empty and unavailable projects |
| `decisions` | `/decisions` | owner | Inbox, first decision selected |
| `decisions-sent-back` | `/decisions?project=ledger-core&task=t197` | owner | A sent-back task selected |
| `decisions-blocked` | `/decisions?project=ledger-core&task=t166` | owner | A blocked task selected |
| `studio` | `/studio` | owner | The floor: live, stale and overlapping work |
| `flow` | `/flow` | owner | Every project's flow, all time (1.5 MB of HTML) |
| `flow-filtered` | `/flow?since=1d&family=anthropic` | owner | Flow filtered to one day and one family |
| `history` | `/history` | owner | 231 merges and 10 closures, one project unreadable |
| `models` | `/models` | owner | Empty pool; track record from 2,293 events; Gateway off |
| `usage` | `/usage` | owner | Two runners' reports, one stale, two alerts |
| `project` | `/p/ledger-core` | owner | Dense overview (200 tasks) |
| `project-empty` | `/p/blank-slate` | owner | A project with no tasks |
| `project-unavailable` | `/p/cold-storage` | owner | A project whose Ledger cannot be read (503) |
| `tasks` | `/p/ledger-core/tasks` | owner | All 200 tasks on the area board, in one Unsorted area |
| `tasks-empty` | `/p/blank-slate/tasks` | owner | Task board with no tasks: one empty Unsorted area |
| `project-flow` | `/p/ledger-core/flow` | owner | One project's flow |
| `plans` | `/p/ledger-core/plans` | owner | No plans |
| `ship` | `/p/ledger-core/ship` | owner | No protected action approved |
| `settings` | `/p/ledger-core/settings` | owner | Checks and protected paths |
| `code` | `/p/ledger-core/code` | owner | Baseline root directory |
| `code-dir` | `/p/ledger-core/code/src` | owner | A directory |
| `code-file` | `/p/ledger-core/code/src/ui.ts` | owner | A file |
| `code-no-commits` | `/p/blank-slate/code` | owner | A baseline with no commits (404) |
| `log` | `/p/ledger-core/log` | owner | Log, first page of 157 commits |
| `log-page-2` | `/p/ledger-core/log?page=1` | owner | Log, second page |
| `commit` | `/p/ledger-core/commit/HASH` | owner | One commit (the first) |
| `path-history` | `/p/ledger-core/history/src/ui.ts` | owner | Commits that changed one path |
| `task-open-long` | `/p/ledger-core/t168` | owner | Unclaimed, long title and brief |
| `task-working` | `/p/ledger-core/t182` | owner | Claimed and pushed, no checks yet |
| `task-stale` | `/p/ledger-core/t163` | owner | Claimed, nothing pushed for two days |
| `task-blocked` | `/p/ledger-core/t166` | owner | Blocked by its holder |
| `task-failed` | `/p/ledger-core/t188` | owner | Submitted with a failing check |
| `task-unreadable` | `/p/ledger-core/t191` | owner | Ready to accept; the diff cannot be read from Artifacts |
| `task-ready` | `/p/ledger-core/t192` | owner | Ready to accept, diff shown |
| `task-protected` | `/p/ledger-core/t195` | owner | Protected path: independent review required |
| `task-sent-back` | `/p/ledger-core/t197` | owner | Checks passed, then sent back (the t435 shape) |
| `task-accepted` | `/p/ledger-core/t198` | owner | Accepted, waiting for the merge |
| `task-scope` | `/p/ledger-core/t200` | owner | Changes outside its declared scope |
| `task-merged` | `/p/ledger-core/t1` | owner | Merged, diff as it landed |
| `task-abandoned` | `/p/ledger-core/t157` | owner | Closed without merging |
| `task-not-found` | `/p/ledger-core/t9999` | owner | A task that does not exist (404) |
| `fork-code` | `/p/ledger-core/t182/code` | owner | A task's workspace, browsed |
| `fork-none` | `/p/ledger-core/t168/code` | owner | Browsing a task with no workspace (404) |

Not captured, and why: the sign-in error (a POST answer; same layout as
`signin` with an alert), a project's plans with a live plan (the fixture
seeds none; `plans` is the empty state, and a plan fixture is a follow-up in
the plan, P10), a binary or oversized file (same frame as `code-file`).

## 5. One name per state (the vocabulary the plan uses until t367 decides)

Today one Ledger state is named up to five ways (critique F3). The plan
draws each state with one word, its colour role and a shape:

| Ledger state | Name everywhere | Role | Today also called |
|---|---|---|---|
| open | **Ready to start** | neutral | open, ready to start |
| claimed | **Working** (+ "Stale" qualifier after 12 h with no push) | neutral / caution | in progress, running, Claimed, Needs a handoff |
| submitted, gate ready | **Ready to accept** | go | In review, accept |
| submitted, review needed | **Needs review** | ask | Review required, Waiting for an independent review |
| submitted, rejected at head | **Sent back** | fault | Changes requested, send back, In review |
| submitted, check failed | **Checks failed** | fault | Checks need attention, In review |
| accepted | **Ready to merge** | go | accepted, Accepted |
| blocked | **Blocked** | caution | decide |
| merged | **Merged** | done | Merged into the project |
| abandoned | **Closed** | done | Task closed, closed without merging, abandoned |
