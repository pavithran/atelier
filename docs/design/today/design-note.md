# Design note: atelier.zone redesign, direction A "Today"

Written 2026-11-08 from local `main` at 23b951bd (read-only). Sources: the audit and mockups in `~/ai-projects/atelier-mockups/site-redesign/` (AUDIT.md, mockups/a-home.html, mockups/a-task.html, shots/a-*.png) and the code cited below. PAVI decided on 2026-11-08 ("Yes, all six"); those decisions are restated here, not reopened.

## Decided

1. **Home is Today.** `/`, the brand and the first nav item open Today. Today absorbs Home (`/home`), Now (`/now`) and Decisions (`/decisions`); their addresses redirect to it. Top bar: Today, Projects, History, Process, Models.
2. **Buttons act as PAVI.** Land, Answer and Override act server-side through his Cloudflare Access identity. Land queues the same runner landing `atelier land` uses. Answer records his reply as the developer's words. Override needs a typed reason, recorded as his quote. Built last, after Today ships read-only.
3. **Every page follows the device's light/dark setting.** This reverses commit 86c00308 (2026-10-12, "the owner's pages are Night only").
4. **Four tasks, one at a time, after t558**, sharing `src/ui.ts`, `src/index.ts` and `src/layout.css`: (a) Today read-only, (b) nav and theme, (c) verdict-first task page, (d) the buttons.

## What the code does today (facts, with file:line)

**Routes.** `/` and `/showcase` redirect to `/home` before the sign-in check (src/index.ts:4760). Owner pages are dispatched in `ui()` (src/index.ts:4190): `/projects` 301s to `/home` (4324), `/home` → `homePage` (4434), `/now` → `renderNow(nowViewOf(...))` (4332), `/decisions` → `decisionsPage` (4553). `knownUI` lists the owner page names that send a visitor to sign in (4987). `/api/now` is the JSON of the same view (4705 API_PATHS; 1709).

**Now view.** `nowViewOf` (src/index.ts:4484) reads, per project: `L.ownerRead(now, pool)` for items and inbox; every event of the last 48 h, paged by `readEvents` (src/now.ts:286); each task merged in that window's own record; `L.situationFacts(recent)` for stages, review requests, landings and runner progress; `attentionFor(...)` (src/attention.ts:195) for the owner's calls; `L.deploys(50)` (src/ledger.ts:5994, events of kind `ship.recorded`). `buildNow` (src/now.ts:249) is pure: it sorts live tasks into needs-you / running / waiting (`liveRow`, now.ts:175) and today's merges, Eastern day, into landed (`landedRow`, now.ts:219, which finds the first shipped deploy after the merge). Header: merges today, sound merges, live count, weighted tokens per sound merge against 700k (now.ts:22). An unreadable project is listed in `unread`, never counted as empty. Fixture: `test/fixtures/now.ts`; tests: test/now.test.ts, test/now-scheme.test.ts (Playwright, light/dark, 390 px), test/now-routes.spec.ts.

**Decisions.** `decisionsPage` (src/index.ts:4553) reads `projectViews`, `floorViewsOf` (400 events each), `ownerAttention` (4379: `L.inbox` + `attentionFor`), the queued tasks (open, unheld, dispatched), and for the selected task `L.detail`, `L.item` and `diffFor`; with none selected, the busiest project's `buildStory` over 3,000 events (STORY_EVENTS, src/index.ts:202). Renderer: `renderInbox` (src/ui.ts:554).

**Home.** `homePage` (src/index.ts:4434): `ownerViews` + 3,000 events per project; renderer `renderHome` (src/ui.ts:1332) with `buildPulse` (src/pulse.ts:52) for the 14-day bars.

**The bar.** `NAV` is Decisions, Now, Projects (`/home`), Activity (`/studio`) (src/ui.ts:106); `NAV_OF` maps pages to items (ui.ts:115); Models and Usage sit in the account menu (`ACCOUNT`, ui.ts:117); the brand links to `/decisions` (ui.ts:209). `withShell` (src/index.ts:4413) calls `ownerViews` on every owner page to fill the Decisions badge and switcher. Project tabs: `PROJECT_AREA_TABS` = tasks, flow, plans, ship, settings, showcase (src/index.ts:4595). t558 (built at b6e0fb0d, not merged) adds `GET /p/NAME/process` as a project tab beside Flow, in src/process.ts and src/process.css. There is no cross-project `/process`.

**Theme.** `page()` writes `data-theme="night"` and, unless `own.device`, `data-scheme="night"` and `color-scheme: dark` (src/ui.ts:200-204). Only Now passes `device: true` (ui.ts:2861). The light tokens exist: theme.css switches under `@media (prefers-color-scheme: light)` with `:root:not([data-scheme="night"])` (src/theme.css:64-65, and per theme at 190, 316, 442). theme.css is a copy made by `bin/sync-theme`; never edited.

**CSS weight.** Every page inlines theme.css (12,541 B) + layout.css (74,079 B) = 86,620 B, about 84.6 KiB (`wc -c`), plus its own CSS, inside `<style>` (ui.ts:205). The audit's 84.5 KB is this.

**Deploy state.** `ship.recorded` events hold `{ ship, head, by, result: shipped|failed, at, step?, warning?, final? }` (DeployRecord, src/checkout-lease.ts:29; written by `recordDeploy`, src/ledger.ts:5974). `GET /api/version` answers `DEPLOYED_MAIN` and `sourceMain` (main as the ledger last observed it) (src/index.ts:4831, 611). Post-merge runs: `postMergeRun(item)` and `activePostMerge()` (src/ledger.ts:6553, 6565), states reserved / pending / running / failed / uncertain / complete. **"Main green" is not recorded in the ledger.** The full-suite result lives on the Studio at `/Users/Shared/atelier-main-suite/result.json`, read over ssh by `~/.local/bin/atelier-pulse` (lines 27-35). The Worker cannot read it.

**POST actions and the owner.** All page forms go to `POST /ui/PROJECT/ID/VERB` (src/index.ts:4201). CSRF defence: the `Origin` header must equal the site's (4202-4203) and the session cookie is `SameSite=Strict` (index.ts:359). No per-form token exists. Stale-page defence: every form carries `head` (`assertRevision`) and the decision forms carry `criteria` (stale_criteria, 4255-4258); accept/override/approve/reject also check the workspace head (`verifyRevision`, 4183, error `stale_head`); an override from a page drawn before acceptance is refused (`not_submitted`, 4262). Owner identity: Access is checked at the entry by `accessVouches` (src/access.ts:105: the `cf-access-jwt-assertion` JWT, issuer, audience and owner email), 401 when missing (index.ts:4787). Behind Access a GET without a session starts one; a POST without one is sent to `/login` (4993-4995). The override forms also need `c.signedIn` and the owner factor (`ownerFactorIn`, index.ts:156), which is `access` when `c.access` is set. A form with an unknown verb gets `renderError("Unknown action.")` (4309). A refusal of a task form is drawn on the task page beside its form (TASK_FORMS, 4180; FormError).

**Server-side landing.** Capability `land.runner-job.v1` (src/capability-declarations.ts:29). `POST /api/projects/P/items/tN/land-job` (src/index.ts:3102, owner only) calls `Ledger.requestLand(id, by, quote?)` (src/ledger.ts:11026): refuses merged, abandoned or blocked tasks; a repeat while queued returns `queued: false` and records nothing; a landing that failed at this head is requeued with `requeued`; it logs `land.requested`. `cancelLand` (11080) undoes it before the merge step. `atelier land ID --queue` calls it (cli/commands/land.mjs:41), as does `atelier land` on a machine without the checkout (cli/land.mjs:996). `requestLand` records no head: the runner lands the head the task has when it runs.

**The developer's words.** `atelier unblock --quote "…" --as H/M` sends `quote`; `itemDirection` (src/index.ts:816) accepts it only on the owner token, and `ownerDirection` (src/rules.ts:257, max 2,000 chars) requires an acting model. `Ledger.unblock` (src/ledger.ts:5027) logs `item.unblocked` with `{ confirmed: "direction", quote, acting }`. The page's unblock verb (index.ts:4295) records no words. **The builder never sees the quote:** the job brief (`jobBrief`, src/ledger.ts:7908) carries neither `item.unblocked` data nor `item.context`. The override reason is the form's `note`, passed to `L.accept(..., note, ..., factor, ...)` (index.ts:4288; textarea maxlength 500, test/ui.spec.ts:98).

## Mechanisms

### M1. Today view (task a)

- **Reads (revised after astra's read, 2026-11-08):** `nowViewOf` returns only `buildNow(...)` and `unread` over a 48-hour window (src/index.ts:4494, 4511), and `NowView` holds no raw deploys or project events (src/now.ts:91), so Today gets one shared reader, `todayInputsOf` in **src/today.ts**: per project it reads the events once for the longer of the two windows (48 h for NowView, 14 days for Home's pulse), passes the 48-hour slice to `buildNow` and the 14-day slice to `buildPulse`, and counts deploys from the `ship.recorded` events of the Eastern day in that read, never from `lastDeploys`' 50-record limit (src/ledger.ts:5994). `nowViewOf` and `/api/now` keep their output byte for byte. One pure builder, `buildToday(inputs, at)` in src/today.ts, returns headline, four tiles, needs-you cards, running lanes, the today timeline and project cards. Renderer `renderToday` in src/today.ts, CSS in **src/today.css**.
- **Figures and where they come from:** Need you = the needs-you group, one per task (same `attentionFor` as the bar badge). Running now = running + waiting groups; a waiting row with `stuck` set shows as stuck. Merged today = `header.mergesToday`. Deploys today = `ship.recorded` with `result: "shipped"` on the Eastern day, per project; a failed one shows as failed. Five-stage lane track (Claim, Branch, Prove, Review, Land) is a pure map from STAGES (src/rules.ts:2271) in today.ts. Merged tile bars = landed rows by Eastern hour. "Main has not moved" is dropped from cards: it needs a merge preview per task (ui.ts:2819), too slow for a list.
- **Entry point:** `GET /` in `ui()`; core change is the routing only.
- **Crash / partial data:** an unreadable project is named on the page, as `unread` does today; its tiles say "not read", never 0.
- **Repeat / timeout:** read-only; live refresh as Now (`live` nonce).
- **Proof:** test/today.test.ts on test/fixtures/now.ts: every tile equals the NowView it came from; test/today-routes.spec.ts for redirects.

### M2. Redirects and nav (tasks a and b)

- `/` serves Today behind Access (index.ts:4760 stops redirecting; `/` stays in `knownUI`). `/home` and `/now` 302 to `/`. `/decisions?project=P&task=T` 302 to `/p/P/T`; bare `/decisions` to `/`. `/api/now` is unchanged (`atelier status` reads it).
- `NAV` becomes Today `/`, Projects, History `/history`, Process, Models `/models`; brand → `/`. Usage stays in the account menu. Studio and Flow keep their addresses, reached from History and the project tabs.
- **Proof:** a spec asserting each old address's status and Location, and the bar's five links on every owner page.

### M3. Device theme (task b)

- Drop `data-scheme="night"` from `page()` and set `color-scheme: dark light` for every owner page; delete the `device` option once nothing passes it. The error and 401 pages follow too. No theme.css edit.
- **Proof:** extend test/now-scheme.test.ts to Today, a task page and the error page at 1280 and 390, light and dark; and invert its existing assertion that a non-Now owner page stays Night.

### M4. Verdict-first task page (task c)

- Order: title and state; the verdict sentence and its action; the stage track as one row; evidence as a checklist (checks with runner, time; review verdict and family; scope); the agent's summary marked "not verified"; the diff; thread, rounds and technical details folded. Data is the existing `Detail` (src/ui.ts:232ff) and `diffFor`; nothing new is read.
- New markup in **src/task-verdict.ts**, CSS in **src/task-verdict.css**; `renderItem` calls it. Until task d, Land shows as today's text, not a shell command: "Ready to land; land it from chat or atelier land".
- **Proof:** test/task-verdict.test.ts on a ready, blocked and no-reviewer task: the verdict block comes before the evidence in the HTML; existing test/ui.spec.ts form assertions still pass.

### M5. The buttons (task d)

All three are forms posting to `POST /ui/P/tN/VERB` with hidden `head` and `criteria`, drawn on Today cards and the task page. A shared guard, `ownerPageAct(c, form, item)` in **src/page-actions.ts**, runs first.

- **Access assertion missing or not the owner:** the entry already answers 401 (index.ts:4787). Inside, the guard also requires `c.signedIn && c.access`; a POST on the owner bearer token (`how === "api"`) is refused 403, as the override forms are (index.ts:4277). A server with no Access configured offers no buttons.
- **CSRF:** the existing Origin check and SameSite=Strict cookie. No new token: Access's own cookie is not sent cross-site with Strict, and a forged Origin cannot come from a browser.
- **Stale head / criteria:** `assertRevision` + `verifyRevision` + stale_criteria, as the decision forms do. Refused 409 and drawn beside the form (add the three verbs to TASK_FORMS and FormError).
- **Double-click and two tabs:** the button disables on submit (no JS needed for correctness); the server is idempotent per verb, below.

**Land** (`land`): calls `L.requestLand(id, owner, quote?)`, the same as `atelier land --queue`. A second click or tab gets `queued: false` and the page says "already queued since HH:MM". Blocked, merged or abandoned → 409 from requestLand, shown. A landing already running for another task: the job waits in the queue; the card shows "queued". Failed earlier at this head: requeued, and the page says which step failed. Shown only for owner calls `land` and `accept`. Proof: test/page-actions.spec.ts: click twice → one `land.requested` event; bearer-token POST → 403; stale head → 409 with no event; blocked → 409.

**Answer** (`answer`, for owner call `unblock`): textarea, 1-2,000 chars (DIRECTION_QUOTE_MAX). Records `item.unblocked` with `{ confirmed: "page", quote, factor: "access" }` through a new `pageDirection()` beside `ownerDirection` in src/rules.ts, since no model acts. Repeat after the unblock → `not_blocked` 409, shown. Proof: rules.test.ts for `pageDirection`; spec: one answer → one event carrying the quote; a second → 409 and no event.

**Override** (`override`, for owner call `override`): reuses the existing verb (index.ts:4288) and its guards, reason required, ≤500 chars, recorded as the note. Second tab after acceptance → `not_submitted` 409 (exists). Proof: the existing override spec plus one from the Today card's form.

**Crash and timeout:** each verb is one Ledger call in one Durable Object transaction, so a crash leaves it either recorded or not; reloading shows which. A failed POST returns the error page with the record unchanged.

## Faked in the mockups, and what happens to each

| Faked | Becomes |
| --- | --- |
| All data (ids, titles, agents, times, counts, tokens, sparklines) | Real from M1's sources; the design fixture renders Today for screenshots |
| Land, Answer, Allow-override buttons | Real in task d (M5); "Allow override" is labelled Override |
| Deploy count and "main green" on Today | Deploys real from `ship.recorded`; "main green" dropped until recorded (Open 2) |
| Merged tile sparkline, deploy pills | Real: landed rows by hour; one pill per deploy today |
| Project card 14-day bars | Real: `buildPulse` as Home draws them |
| Flow entry in the nav (placeholder) | Dropped from the top bar; replaced by Process (t558); Flow stays a project tab |
| "Main has not moved" on the Today card | Dropped from Today; stays on the task page's merge preview |
| Moves-per-hour pulse (direction C) | Dropped; C was not chosen |

## The four tasks

### (a) Today replaces Home, Now and Decisions, read-only

Brief: Serve Today at `/` from `nowViewOf` and Home's pulse, drawn as mockups/a-home.html, in src/today.ts and src/today.css. Redirect `/home`, `/now`, `/decisions`. No buttons yet: needs-you cards link to the task page. Core files only wire the route and the redirects. Match shots/a-home-*.png.

- GET / returns 200 behind Access with the headline, four tiles, Needs you, Running, Merged and deployed today, Projects; test/today.test.ts checks each tile equals the NowView and deploys of test/fixtures/now.ts.
- GET /home, /now and /decisions answer 302 to /; /decisions?project=P&task=T to /p/P/T; /api/now is unchanged; test/today-routes.spec.ts asserts each.
- A project whose ledger cannot be read is named on Today and its figures read "not read", never 0; tested with one ledger stub that throws.
- A day with no merges, deploys or live tasks shows one plain line per empty section, not four "Nothing."; tested on an empty fixture.
- Today renders in under 1 s locally on the design fixture's 310 tasks, measured and stated in the commit.
- Rendered from the design fixture at 1280 and 390 px, light and dark, the four screenshots are committed to docs/design/today/ beside copies of shots/a-home-*.png, and the commit message lists each difference from the mockup with its reason (a departure this note allows, or data the fixture lacks).
- Deploys today counts every shipped `ship.recorded` of the Eastern day: tested with 60 ships in one day (above lastDeploys' 50) and one at 11:59 pm Eastern the day before, which is not counted; `/api/now`'s JSON for test/fixtures/now.ts is unchanged (a snapshot test).

Scope: `src/today.ts`, `src/today.css`, `src/index.ts`, `src/ui.ts`, `test/today*.ts`, `test/fixtures/now.ts`, `docs/design/today/**`.

### (b) Top bar: Today, Projects, History, Process, Models; device theme

Brief: Replace NAV and NAV_OF, point the brand at `/`, give Projects its own address (Open 3), and add Process (Open 1). Remove the Night pin from `page()` so every owner page follows the device; this reverses 86c00308.

- Every owner page's bar lists Today, Projects, History, Process, Models in that order with one aria-current; test/ui.spec.ts asserts on five pages.
- Owner pages carry no data-scheme and color-scheme "dark light"; test/now-scheme.test.ts renders Today, a task page and the error page at 1280 and 390 in light and dark, with no sideways scroll at 390.
- The visitor 401 page draws no owner bar; a spec asserts its HTML has no Decisions, switcher or Sign out (audit problem 10).
- Process links to the current project's /p/NAME/process inside a project and to Open 1's default elsewhere; tested on both.

Scope: `src/ui.ts`, `src/index.ts`, `src/layout.css`, `test/ui.spec.ts`, `test/now-scheme.test.ts`.

### (c) The task page leads with its verdict and evidence

Brief: Reorder the task page as mockups/a-task.html: verdict and action first, a one-row stage track, evidence as a checklist, the diff, then folded history. New markup in src/task-verdict.ts and .css; no new reads.

- On a ready task the verdict block precedes evidence and diff in the HTML; test/task-verdict.test.ts checks order for ready, blocked and no-reviewer.
- The stage track is one row at 390 px, no taller than 80 px; measured in the Playwright test at 390 light and dark.
- No shell command is shown as the action; a test asserts the ready page has no `<code>atelier land`.
- Existing task-page forms (approve, reject, accept, override) and their refusals still render beside their forms; test/ui.spec.ts passes unchanged.

Scope: `src/task-verdict.ts`, `src/task-verdict.css`, `src/ui.ts`, `test/task-verdict.test.ts`.

### (d) Land, Answer and Override act from the page as PAVI

Brief: Add the three forms of M5 to Today cards and the task page, through src/page-actions.ts, using requestLand, a new pageDirection and the existing override verb. Each needs Access; each is idempotent and refuses stale pages.

- POST /ui/P/tN/land with the shown head queues one land.requested; a second POST records nothing and says "already queued"; test/page-actions.spec.ts.
- Each verb is refused 403 on the owner bearer token without Access, 403 cross-origin, and 409 on a stale head or criteria, with no event recorded; the spec covers all three per verb.
- Answer records item.unblocked with the typed quote and factor access; blank or over 2,000 chars is refused 400; a repeat gets 409 not_blocked; tested in rules.test.ts and the spec.
- Override requires a 1-500 char reason recorded as the note; a second tab after acceptance gets 409 not_submitted; the spec posts from Today's form.

Scope: `src/page-actions.ts`, `src/rules.ts`, `src/index.ts`, `src/ui.ts`, `src/today.ts`, `src/task-verdict.ts`, `test/page-actions.spec.ts`, `test/rules.test.ts`. Add `src/ledger.ts` and `cli/land.mjs` only if Open 4 or 5 is chosen.

## Decided by PAVI (2026-11-08 about 8:40 am EST, "Yes, all five": each recommendation below is decided)

1. **Where Process goes outside a project.** t558 builds only /p/NAME/process. Recommend: in a project, its Process; elsewhere, the atelier project's (SOURCE_PROJECT). Why: no cross-project figure exists yet, and atelier is where the process is refined.
2. **"Main green".** The suite result is on the Studio, not in the ledger. Recommend: Today says "post-merge checks passed" from the deploy and post-merge records, and a separate task records the main suite as a ledger event. Why: a page must not show a state it cannot read.
3. **Projects' address.** /home redirects to Today, so Projects needs one. Recommend: /projects serves the portfolio (reversing index.ts:4324). Why: the name matches the nav label, and old /home links still land.
4. **Answer reaching the builder.** The job brief does not carry the unblock quote. Recommend: task d adds the newest developer's words since the block to `jobBrief`. Why: otherwise Answer only unblocks, and the agent resumes without the answer.
5. **Land and the head PAVI saw.** requestLand records no head. Recommend: record the shown head in land.requested and have the land job stop with stale_head if it moved. Why: the click then lands what he read; today the review gate catches an unreviewed head, but later and less clearly.


## After astra's read (codex/gpt-6-astra, 2026-11-08, VERDICT: changes; full text in redesign-today-note-astra-read.md)

Task a is revised above (shared reader; deploys from the day's events; screenshots beside the mockup). Before tasks b, c and d are filed, their criteria take these, decided by the orchestrator as the smallest fixes astra named:
- **b:** a criterion that the brand links to `/`, and one that a signed-in GET /projects answers 200 with the portfolio.
- **c:** criteria for the evidence checklist and the folded history; existing form and refusal assertions in test/ui.spec.ts stay, and assertions of the old landing command (test/ui.spec.ts:110) may be updated to the new action.
- **d, authentication:** a POST with no Access sign-in answers 401 (the entry guard, src/index.ts:4787, runs first); a request with Access but without the owner session answers 403; one test each.
- **d, Answer on a round-cap block:** `Ledger.unblock` needs `direction.acting` for that block and hardcodes `confirmed: "direction"` (src/ledger.ts:5031, 5041). Task d adds a page-direction variant to the ledger: the developer typed it on the page, no model acting, recorded as `confirmed: "page"` with the Access email's hash; it may lift a round-cap block; tested on that block.
- **d, stale page:** the expected head (Land) and the expected criteria revision (Answer, Override) go into the ledger mutation itself (`requestLand`, `unblock`), which refuses with stale_head or stale_criteria if they moved; a test changes the head between the page's read and the mutation.
- **d, unknown outcome:** each form carries a one-use request id; the ledger records it with the mutation, and a repeat with the same id returns the first result instead of acting again (so a transport retry never starts a second landing, while a new click, with a new id, is an intentional retry). A test drops the response after commit and replays it.
- **d, coverage:** criteria that Answer's words reach `jobBrief`, that the land job refuses when the head moved after queueing, and that the three forms appear on both Today and the task page.
