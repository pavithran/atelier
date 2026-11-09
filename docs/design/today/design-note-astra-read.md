Reading additional input from stdin...
OpenAI Codex v0.160.0
--------
workdir: /Users/pavi/ai-projects/atelier
model: gpt-6-astra
provider: openai
approval: never
sandbox: read-only
reasoning effort: medium
reasoning summaries: none
session id: 01a1bb47-976b-78b0-8f7c-7566559bd1e4
--------
user
You are reviewing a design note for Atelier, read-only. The note is at: /Users/pavi/Library/Application Support/Claude/side-session-notes/local_61e13c59-1352-4794-98af-3973ffc56c7e/redesign-today-design-note.md . Read it and check it against the code in this checkout (local main). The developer has already decided the 'Decided' sections; do not reopen those choices. Report only blocking problems: a fact about the code that is wrong (cite file:line), a figure Today shows that is not recorded anywhere, a missing crash/retry/repeat/timeout behaviour for the buttons, a criterion whose strictest reading is impossible, or a requirement of a task brief that no criterion of that task tests. For each: the note section, what is wrong, and the smallest fix. End with one line: VERDICT: approve or VERDICT: changes.
codex
I’ll review the note against local `main`, read-only, and leave the Decided choices intact. I’m using this session’s GPT-6 model for the review, with no additional agents.
exec
/bin/zsh -lc "cat '/Users/pavi/Library/Application Support/Claude/side-session-notes/local_61e13c59-1352-4794-98af-3973ffc56c7e/redesign-today-design-note.md'" in /Users/pavi/ai-projects/atelier
 succeeded in 0ms:
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

- **Reads:** `nowViewOf` as is (src/index.ts:4484), plus `buildPulse` over each project's events for the project cards, and the deploys it already reads. No new ledger reads. One pure builder, `buildToday(now: NowView, projects, deploys, at)` in **src/today.ts**, returns headline, four tiles, needs-you cards, running lanes, the today timeline and project cards. Renderer `renderToday` in src/today.ts, CSS in **src/today.css**.
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

exec
/bin/zsh -lc "rg -n 'Atelier|atelier' /Users/pavi/.codex/memories/MEMORY.md" in /Users/pavi/ai-projects/atelier
 succeeded in 0ms:
85:- Related skill: skills/atelier-fast-mode-release/SKILL.md
101:- `atelier submit` rejects a summary over 600 characters; shorten it before resubmitting. [Task 1]
106:applies_to: cwd=/Users/pavi/ai-projects/thisisit; reuse_rule=Atelier identity, task state, Git heads, Worker rollout, authenticated browser state, and D1/migration state are live; recheck them before taking ownership or making release claims.
116:- thisisit, unwrap, Atelier, `codex/gpt-6-astra`, `unregistered_acting`, t31, `fb93a574`, `docs/STATE.md`, `docs/CONTROL_BOARD.md`, `docs/LIVING_ARTIFACT.md`, `fast-xml-parser`, `npm ci --prefer-offline --no-audit --no-fund`, `CLAUDE.md`
136:- t33, gathering-rollover, `0821201b`, `b5a4dde1`, `0c42a18e`, `2026-11-01-gathering-rollover-1`, `/api/version`, `THISISIT_E2E_PORT=8797 npm run test:e2e`, port 8787, Safari, 26 messages, unsent draft, `atelier merge --landing`
140:- when the user asked to “Resolve the Atelier identity issue, file the defect, and reconcile the stale pickup docs” -> resolve the exact registered identity and complete the filing instead of stopping at an error report. [Task 1]
153:- Do not invent or shorten Atelier identities; query runtime metadata or `atelier models`. Do not infer deployment parity from merge approval or a task receipt: check assets, `/api/version`, Worker rollout, and migrations separately. [Task 1]
155:- When port 8787 is occupied, use `THISISIT_E2E_PORT=8797 npm run test:e2e`; do not stop another listener. `atelier merge --landing` requires an `atelier land` attempt, so use plain `atelier merge` after acceptance outside that flow. Native automation timing out on the pinned tab means a separate authenticated tab is valid evidence only for that tab. [Task 3]
169:- tapestries, GuidedLoomStudio, `src/components/GuidedLoomStudio.tsx`, `flexWrap: 'wrap'`, activity actions, 390px, 1280px, `scrollWidth`, `pnpm test`, `pnpm typecheck`, `54d132d2`, Atelier t14
209:# Task Group: Atelier fast-mode repair, scope control, and stop-wrap
210:scope: Repair ourAI relay findings through Atelier, assess broad orchestration work, and safely stop with WIP/claims/durable state recorded; do not infer a release, deployment, or completed task from this session.
211:applies_to: cwd=/Users/pavi/ai-projects/atelier and /Users/pavi/ai-projects/ourai; reuse_rule=task ownership, exact heads, check/review status, and workspace state are live; reconcile with current Atelier listing, Git, and project state before acting.
217:- rollout_summaries/2026-10-20T16-53-38-U4bL-atelier_fast_mode_t187_t190_stop_and_wrap.md (cwd=/Users/pavi/ai-projects/ourai, rollout_path=/Users/pavi/.codex/archived_sessions/rollout-2026-10-20T12-53-38-01a15a3b-9af3-7d71-b390-b10bd9754489.jsonl, updated_at=2026-10-22T16:05:54+00:00, thread_id=01a15a3b-9af3-7d71-b390-b10bd9754489, targeted repair validated; not finally submitted or landed)
221:- t67, `atelier unwrap --project ourai`, `relay/src/verify.ts`, `relay/src/openai-responses.ts`, Responses API, reasoning items, function-call, budget reservation, `relay/scripts/in-cache.sh`, `expected 429, received 401`, `SSL_ERROR_SYSCALL`, t137
227:- rollout_summaries/2026-10-20T16-53-38-U4bL-atelier_fast_mode_t187_t190_stop_and_wrap.md (cwd=/Users/pavi/ai-projects/ourai, rollout_path=/Users/pavi/.codex/archived_sessions/rollout-2026-10-20T12-53-38-01a15a3b-9af3-7d71-b390-b10bd9754489.jsonl, updated_at=2026-10-22T16:05:54+00:00, thread_id=01a15a3b-9af3-7d71-b390-b10bd9754489, WIP pushed and claims released; tasks remain open/unclaimed)
231:- Atelier, fast-mode, t187, t190, affected-tests, full-suite, `cli/wave-suite.mjs`, cancellation-race, SIGTERM, `SHOULD_NOT_RUN`, `cc6fe139`, `91ec690c`, Observed, Reported, scope-control
233:- Related skill: skills/atelier-fast-mode-release/SKILL.md
239:- rollout_summaries/2026-10-20T16-53-38-U4bL-atelier_fast_mode_t187_t190_stop_and_wrap.md (cwd=/Users/pavi/ai-projects/ourai, rollout_path=/Users/pavi/.codex/archived_sessions/rollout-2026-10-20T12-53-38-01a15a3b-9af3-7d71-b390-b10bd9754489.jsonl, updated_at=2026-10-22T16:05:54+00:00, thread_id=01a15a3b-9af3-7d71-b390-b10bd9754489, clean stop-wrap with checks skipped; no submit, landing, deployment, or publication)
243:- wrap, `atelier push`, `atelier release`, `atelier wrap --no-check --project atelier`, open, unclaimed, `1f667ff2`, skipped checks
247:- when the user said “Take t67 and fix the review findings, then run the required checks and submit through Atelier” and “use atelier in fast mode” -> use the named Atelier lane and fast mode while preserving required checks and independent review. [Task 1]
248:- when the user said “Stop here. Commit and push your work in progress on t187 and t190 with `atelier push`, then release both claims with `atelier release`. Don’t start anything new.” -> stop active work, preserve WIP, release ownership, and do not submit, land, deploy, or start follow-up work. [Task 2][Task 3]
253:- `atelier unwrap --project ourai` established the initial pickup. Follow it with Git/state/context checks; clean Git does not establish release parity. [Task 1]
257:- `atelier wrap --no-check` records skipped checks; it does not push, deploy, or publish unless separately authorized. State reporting must distinguish saved WIP, ownership, checks, submission/landing, and deployment. [Task 3]
324:- Miqra, edge-cache, `view`, `date`, New York calendar day, `src/lib/edgeCache.ts`, `tests/edge-cache.test.ts`, Atelier t54, GPT-6 Astra, `e65c580`, `npm run deploy`, `7403`, `2be1c2e0`, `RECEIPT.md`
329:- when the user approved t54, they required: "Include Miqra view and date in the public cache key, handle date-dependent default readings, and add regression coverage for cached navigation. Preserve content and privacy filtering. Get one GPT-6 Astra review, merge through Atelier, and deploy only after all release checks pass. No production data writes or gate bypasses." -> preserve narrow scope, explicit criteria, independent review, and guarded deployment. [Task 3]
336:- When an Atelier task overlaps live scopes, narrow it before starting (t54: `atelier edit t54 --scope src/lib/edgeCache.ts --scope tests/edge-cache.test.ts`). The fixed code passed real middleware/rendered-HTML coverage for view/date switching, leap day, midnight, cache hits, privacy, and unchanged notes; restoring old code failed three focused regressions. [Task 3]
533:# Task Group: cloudflare-git Atelier authentication verification
534:scope: Confirm usable Atelier authentication/project access without exposing credentials or mutating tasks/workspaces.
537:## Task 1: Verify Atelier sign-in through project task listing, success
541:- rollout_summaries/2026-10-04T15-52-13-rj7C-verify_atelier_authentication_cloudflare_git.md (cwd=/Users/pavi/Library/Mobile Documents/com~apple~CloudDocs/ai-projects/cloudflare-git, rollout_path=/Users/pavi/.codex/archived_sessions/rollout-2026-10-04T11-52-13-01a1079d-a293-7b53-b191-ece36bd686ec.jsonl.zst, updated_at=2026-10-04T15:54:04+00:00, thread_id=01a1079d-a293-7b53-b191-ece36bd686ec, successful authenticated API query)
545:- Atelier, authentication, sign-in, `atelier ls --project cloudflare-git`, `atelier.API_TOKEN`, Keychain, `AGENTS.md`
549:- `atelier ls --project cloudflare-git` exit 0 with a populated task list is the practical authentication/project-access check. The CLI reads its token from Keychain under `atelier.API_TOKEN`; do not inspect or expose its value. [Task 1]
550:- `AGENTS.md` requires claimed Atelier workspaces for task work rather than edits in the main checkout. [Task 1]
556:# Task Group: Atelier cache cleanup and decision-centered product/recovery work
557:scope: Use Atelier-owned cache workspaces for guarded local cleanup or decision-first UI/landing work; distinguish merged t5 work from submitted, blocked t9 work and from undeployed cloud behavior.
560:## Task 1: Add guarded `atelier gc` local-cache cleanup, success
564:- rollout_summaries/2026-10-03T22-50-39-Lxu0-atelier_cache_cleanup_and_decision_centered_redesign.md (cwd=/Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/cloudflare-git/t5, rollout_path=/Users/pavi/.codex/archived_sessions/rollout-2026-10-03T18-50-39-01a103f6-5cd1-7760-bb40-694d284efd20.jsonl.zst, updated_at=2026-10-04T04:18:42+00:00, thread_id=01a103f6-5cd1-7760-bb40-694d284efd20, merged guarded cleanup)
568:- Atelier, t5, `atelier gc`, `--apply`, cache workspace, check clone, child PID, `cli/gc.mjs`, `src/rules.ts`, `7fb0d960`
574:- rollout_summaries/2026-10-03T22-50-39-Lxu0-atelier_cache_cleanup_and_decision_centered_redesign.md (cwd=/Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/cloudflare-git/t9, rollout_path=/Users/pavi/.codex/archived_sessions/rollout-2026-10-03T18-50-39-01a103f6-5cd1-7760-bb40-694d284efd20.jsonl.zst, updated_at=2026-10-04T04:18:42+00:00, thread_id=01a103f6-5cd1-7760-bb40-694d284efd20, submitted t9; protected-path approval and live verification remain open)
582:- when the user said “take t5” and then “done” -> use Atelier ownership, its assigned cache workspace, checks, submission, and review workflow rather than editing the iCloud checkout. [Task 1]
587:- `atelier gc` previews by default; `--apply` removes only verified-safe cache items. Preserve active/unmerged, dirty/ignored, unpublished, linked-worktree, submodule, symlink, Git-operation, current-ancestor, foreign/unknown/recent/live directories and failed API refreshes. Stale check clones require process exit plus 24 hours. [Task 1]
588:- Required Atelier flow is commit -> `atelier push` -> `atelier check` -> `atelier submit`; protected-path changes require owner or independent-model approval. t5 passed 36 tests plus type generation/typecheck, was committed `7702a24`, and merged `7fb0d960`; main was neither pushed nor deployed. [Task 1]
593:- `atelier: owned: t5 is owned by codex/gpt-5.5; ask for a handoff` -> arrange handoff before claiming. Future runs stop at submission unless the user explicitly authorizes owner actions. [Task 1][Task 2]
858:- sidebar-menu, `t59`, `relay/src/web.ts`, `check-sidebar-menu.mjs`, `check-browser.mjs`, `atelier check`, Reported, Observed, Chromium, WebKit, `216d1cb0`, `b4701dec`
880:- For Workers acceptance evidence, run full verification through `atelier check`; reported/local success is not sufficient. Run `atelier check -- 'cd relay && npm run verify'` before review. [Task 3]
888:- The first Atelier revision was rejected because full verification was Reported rather than Observed. Initial browser coverage missed action selection and did not restore global API/account state; add both coverage and cleanup before review. [Task 3]

exec
/bin/zsh -lc 'git status --short; git branch --show-current; cat /Users/pavi/.agents/skills/house-style/SKILL.md' in /Users/pavi/ai-projects/atelier
 succeeded in 4988ms:
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-3TUis9Rr' (errno=Operation not permitted)
2026-11-08 08:10:04.360 xcodebuild[74623:141358827]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-11-08 08:10:04.701 xcodebuild[74623:141358822] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-GxyiQicT' (errno=Operation not permitted)
2026-11-08 08:10:05.320 xcodebuild[74672:141358963]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-11-08 08:10:05.560 xcodebuild[74672:141358961] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-7A8YFk5F' (errno=Operation not permitted)
2026-11-08 08:10:06.649 xcodebuild[74690:141359107]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-11-08 08:10:06.815 xcodebuild[74690:141359106] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-hgNjn0qX' (errno=Operation not permitted)
2026-11-08 08:10:07.366 xcodebuild[74699:141359177]  DVTFilePathFSEvents: Failed to start fs event stream.
2026-11-08 08:10:07.541 xcodebuild[74699:141359173] [MT] DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR from confstr(3), error = Error Domain=NSPOSIXErrorDomain Code=5 "Input/output error". Using NSCachesDirectory instead.
main
---
name: house-style
description: Pavi's house style for expository writing across all projects. Load before writing, assessing, editing or rewriting any explanatory prose (articles, docs, briefings, reports, figure text) and before any editorial pass. Canonical copy lives in ai-projects-house-style/house-style.md; this is a verbatim mirror.
---

# House style for expository writing

The standard for every piece of explanatory prose across the portfolio. It
governs writing that exists to be understood. Polemic, fiction and verse are
written to be savoured and answer to different rules.

It covers articles, documentation, briefings, reports, handoffs, audit
findings, the text inside figures, the body of a commit message, comments in
source code, briefs and prompts written for agents, and long prose inside a
product, such as a privacy policy. It does not cover interface labels,
buttons and other short interface strings, which answer to the project's own
voice document (section 6), nor a chronicle written for pleasure.

Presentational text is a narrow class of its own: a film's narration, the
headline or tagline of a showcase, the keywords on a slide. It is written to
be remembered as well as understood, and a terse, memorable line is
permitted in it, as an opening, a recurring line or the close, when the line
is true and the piece has earned it. Every other rule here governs it as it
governs exposition. The permission goes no further. The rules against
aphorism and verbal cleverness in section 3 stay in force for every other
class: exposition, documentation, reports, commit bodies, briefs, and
writing to PAVI (section 9). PAVI drew the boundary after an agent cut the
Atelier film's closing line, "Git keeps the code. Atelier brings the
receipts.", as a slogan, and he restored it (AT-19, AT-20): "it fit there.
not sure if i want it in general" (PAVI, 2026-10-14).

The subject line of a commit names the change in at most 72 characters. It is
not an epigram.

Most prose in the portfolio is now written by agents. An agent loads this
standard before writing any class it covers, commit bodies and comments
included.

It was settled on 2026-08-21 from two sources that turned out to agree:
PAVI's brief for the llm-basics article, and the defensible half of David
Bentley Hart's rules for writing well. Where the two conflicted, the
article's purpose decided, and the decisions are recorded here so they are
not re-argued.

On 2026-10-14 the rules were checked against PAVI's own words on writing:
123 dated quotations from 11 projects, collected in
`prose-harvest-2026-10-14.md`, and the comparison in
`prose-assessment-2026-10-14.md`, both in
`~/Documents/ai-project-data/ai-projects-house-style/`. A citation such as
(AT-19) names an entry in that harvest, which quotes his words and says what
they answered. The letters name the project or the subject: AT is Atelier,
LB llm-basics, RP his replies to agents' reports.

## 1. The principle

Respect the reader by being exact. Every rule below is an instance of it.

The reader is intelligent, has a dictionary, and is willing to learn. Do not
write down to them; do not write past them to admire yourself. The prose is
the glass the subject is seen through, and a reader who notices the glass has
stopped looking at the subject.

## 2. Words

- Use the word that most exactly means what you mean, whatever its
  familiarity. Never choose a word because it is short, long, common or rare.
- Use the standard term of art and explain it once, plainly, at first use.
  Then use it consistently: "learning rate", not "step size" thereafter;
  "residual stream", not "running total"; "gradient", not "corrections". A
  term explained once and then abandoned for a synonym teaches the reader
  two words for one thing and leaves them unsure whether they are the same.
- Define again later only when the gap since first use is long enough that a
  reader could reasonably have lost it, and then in a clause, not a paragraph.
- Never soften a precise term with an apology. "The mathematics" is not a
  section title; the equation is titled by what it contains, and the prose
  around it states the arithmetic on real numbers.
- Avoid jargon, which is a term used to signal membership rather than to
  name a thing. A term of art names a thing; the test is whether the sentence
  loses information when the word is replaced.
- A private label is jargon of another kind: a task id, a lane, a decision
  number, an internal code or a nickname that the reader was never given.
  It names a thing for the writer only. It comes with what it is, in plain
  words, at first use, or it is left out: not "t5" but "t5, the Atelier task
  that adds the review gate". The same holds for words a product's team uses
  among itself and its users never learned (PAVI, 2026-08-09 to 2026-10-03;
  RP-2, RP-3, RP-5, RP-11, PH-17).
- A foreign phrase is permitted when it says the thing with more economy than
  any English equivalent, and not otherwise.
- No thesaurus. Synonym lists give a word's neighbours, not its meaning.
- The pointer verb is "hover over": "hover over a mark", "while the pointer
  hovers over it", never "hover a mark" or "when it is hovered". The CSS
  selector `:hover` is a string fixed by another party and keeps its spelling
  (PAVI, 2026-10-05).

## 3. Sentences

- Cut every word that carries nothing. This is most of editing. It is a
  different cut from Hart's "cut what mars the effect", and both apply.
- Never cut a word that is doing work merely because the sentence survives
  without it. A qualifier that makes a claim true is not excess.
- Concise is not short. Cutting what carries nothing is half of concision;
  the other half is that nothing the reader needs is missing. Never trade
  completeness for brevity: a step, a definition or a piece of evidence the
  reader needs is added however long the piece already is, and a piece is
  not better for being shorter. PAVI rejects verbose drafts, yet whenever
  he was offered the short account or the complete one, he chose the
  complete one:
  "we're already long, so if it helps make a complete presentation, i'm all
  for adding both" (PAVI, 2026-08-14, LB-10; also LB-1, LB-4, IW-1). A
  quotation given as evidence must be long enough to mean something (E4-5).
- Use the voice that puts the emphasis where the argument is. The passive is
  the natural voice for much technical prose, because the agent is often
  obvious or irrelevant: "the weights are updated", "the loss is measured on
  held-out text". Do not force an agent into a sentence to satisfy a rule.
- Semicolons join two clauses that belong together but are not one thought.
  Use them. Colons introduce what was promised. Full stops end thoughts.
- Almost no dashes. A dash lets the writer avoid deciding how two ideas
  relate; the semicolon, the colon and the full stop each force the decision,
  and the reader benefits from its having been made. Use one when the
  interruption is genuinely parenthetical and a parenthesis would read worse.
  The rule concerns the dash as punctuation. A range (10–15), a minus sign
  and a dash inside a quoted string are not its business.
- No verbal cleverness. A phrase the writer enjoyed is a moment the reader is
  looking at the writer and not at the subject. Presentational text may
  carry a terse, memorable line (opening section); no other class may.
- No hackneyed metaphor. A fresh metaphor is permitted when it carries an
  idea the literal statement cannot, and it is dropped the moment it has
  done so. A metaphor that runs through a section has become a second
  argument.
- No flourishes, no aphoristic closing sentences, no sentence that exists to
  round off a section rather than to say something. In presentational text
  a closing line that is true and earned is permitted (opening section;
  AT-19, AT-20); in every other class the rule stands.
- Read every sentence aloud. If it is awkward on the tongue it is awkward on
  the page.

## 4. Structure

A piece read from start to finish, such as an article or a briefing:

- Each step must make sense in the light of what came before it. If a
  paragraph needs a fact the reader has not yet been given, the fact moves
  or the paragraph does.
- One narrative line through the whole. The reader should be able to say at
  any point what question the current section is answering and why it comes
  here.
- Offer more than one level of abstraction: the whole process in outline, the
  same process in detail, and the arithmetic on real numbers from the run.
  A reader should be able to hold the outline while reading the detail.
- Nothing is described as optional, advanced or skippable. If it is in the
  piece it is part of the argument; if it is not part of the argument it is
  not in the piece.

A piece read out of order by someone deciding what to do, such as a handoff,
a status report, an audit finding, a runbook or a reference document:

- The verdict comes first, then the evidence for it, under the rules of
  section 5.
- What was not verified is said plainly, in the place where the reader would
  otherwise assume it was.
- Dates are absolute. "Today" and "earlier" are false by the time they are
  read.
- Each section stands alone. It names what it depends on and does not rely
  on the reader having come from the section above.
- A step in a procedure may be called optional when it is; the rule against
  the word belongs to argument, not to instruction.

Every piece:

- No redundancy between sections. Say a thing once, in the place where it is
  needed, and refer back by name. Repetition that is intended, as a reminder
  after a long gap, is one clause and says that it is one.
- Between documents, each fact has one owner. A handoff or a ledger may
  restate a fact that another document owns; it names the owner, and where
  the two disagree the owner is right.
- Headings name what the section contains, in the same grammatical form
  throughout a piece: all noun phrases or all clauses, not a mixture.
  A heading is not a joke, a question the section does not answer, or a
  promise the section does not keep.
- A section id, slug or anchor is derived from its heading and changes with
  it, so that nothing can say one thing in the index and another on the page.

## 5. Figures and claims

- Every quoted number is derivable. Be able to point at the code, the
  checkpoint or the measurement that produced it, and say in the text when
  it is an extrapolation.
- A number earns its place. It says what it means: what it is out of or
  compared with ("22 of the 23 files", not "22 files"), and what it shows
  for the case being made. A number that makes no case is cut, however true
  and however hard it was to measure: "check to make sure every bit of data
  mentioned actually has value in making the case" (PAVI, 2026-10-12,
  AT-18; also AT-4, MA-2).
- A number that appears in more than one place (prose, measured data, a
  fallback string, a caption) must be reconciled in all of them after any
  change. A stale figure in one copy has shipped before.
- A number drawn from a window of data states the window: its dates and its
  sample size. A rate without its window is not yet a finding.
- A number produced by reasoning is an estimate and is labelled as one
  wherever it appears. It does not become a measurement by being repeated,
  by the writer or by anyone else.
- Write what the evidence supports and no more. "Often" is not "always";
  "appears to" is not "does". Hedge where the claim is uncertain and nowhere
  else; a hedge on a certain claim weakens the whole piece's authority.

## 6. Spelling and register

- Spelling follows the context the writing belongs to, and is consistent
  within it. Writing for a product or a body of text that already has an
  orthography uses that orthography: an app whose interface is in American
  English is documented in American English, and a piece for a British
  publication is written in British English. Where no context decides, the
  writer chooses one and holds it through the piece. The error is the
  mixture: two orthographies in one piece, or in one product.
- A string that must be exact keeps its own spelling whatever surrounds it:
  identifiers and file names (`model/quantize.py`), published titles
  (*Root Mean Square Layer Normalization*), and strings fixed by another
  party, such as a vendor's `cancelled` inside an American-English codebase.
- This rule replaced "British spelling throughout" on 2026-09-20, by PAVI's
  decision. The one exception then on record, MicahApp's American
  orthography (settled on 2026-08-20 to match the 1,618 annotations already
  shipped in the app, confirmed on 2026-09-13), is now an instance of the
  rule and needs no exception.
- A project that needs an exception to any rule here records it in this
  section, not only in the project, so the standard and the project can
  never disagree without knowing it. One is on record. Photograph's voice
  document (`photograph/docs/voice-and-tone.md`, "Two registers", recorded
  there on 2026-09-20) lets the app's assistant voice, the critiques and
  captions its model writes, use dashes and prefer the shorter clause,
  against section 3. Its long prose follows this standard, and its
  interface strings need no exception, being outside this standard's scope.
- ourAI's British English and llm-basics' British spelling are not
  exceptions. Each is the orthography its product already uses, and
  following it is the spelling rule above. A project's agent instructions
  state such a choice as the project's own, not as the house rule.
- A project may adopt a controlled language, such as Simplified Technical
  English, for its interface text. That is a choice of register for short
  strings read at a glance, not a claim about good prose, and section 7
  applies to it as to any rule. The project's voice document states the
  choice and this section records it. Photograph writes its interface text
  in Simplified Technical English (PAVI, 2026-08-09).
- Plain and calm. Technical register, not conversational and not academic.
  No "we" that means the author, except where the author genuinely did
  something; no "you" that instructs the reader how to feel.
- Current and correct. A term, a figure or a practice that the field has
  superseded is either updated or stated as historical.
- A comment in source code describes what the code does now, and why. Its
  history belongs to version control: no dates, no attributions and no
  account of what the code used to do, unless the history is the reason the
  code has its present shape, and then in one clause.

## 7. On rules of style

Style guides are not evidence. Strunk and White's examples of the passive
voice include sentences that are not passive; Orwell's "never use a long
word when a short one will do" is a rule against precision. A rule, or a
prose checker built from one, is worth nothing until it has been shown to
fail on a bad sentence and pass a good one. Before trusting a pass, make
the instrument fail.

The dash rule has an instrument, `bin/dash-count`, which reports punctuation
dashes per thousand words. It is a report and never a gate, and it was shown
to fail on a bad paragraph before its first pass was believed.

The same holds for this document. Where it produces worse prose, the prose
wins and the rule is corrected here.

## 8. Applying it in a pass

When asked to assess and rewrite a piece under this style:

1. Archive the current version first, under a dated name, so the next pass
   can compare.
2. Read the whole piece end to end before changing a sentence. The defects
   this style cares about (a term introduced twice, a step that depends on a
   later one, a number out of step with its source) are visible only across
   the whole.
3. Decide whether to edit or to rewrite. When revisions have piled up and
   the piece carries layers of earlier drafts, rewrite it from a blank page,
   with the archived version as a source and not as a base: "a fresh start
   rather than evolving from previous versions might help" (PAVI,
   2026-10-12, AT-17).
4. Edit every paragraph. A pass is a line edit of the whole piece, not a
   search for defects; a piece can be free of defects and still badly
   written, and a clean read for defects is not a finished pass. "why did
   you reduce the entire task to a defect read?" (PAVI, 2026-08-22, LB-20).
5. Edit in the source of truth, never in generated output.
6. Rebuild and validate once at the end, not after every edit.
7. Run a second, adversarial read under the same rules, looking for what the
   first pass introduced.
8. Record in the session note what was changed and why, by section, so the
   decisions are not re-argued.

## 9. Writing to PAVI

PAVI is the developer whose portfolio this is, and much of what agents
write is written to him: reports, handoffs, decision and approval requests,
and the summary at the end of a session. He reads them to decide or to act,
so section 4's rules for a piece read out of order govern them. The harvest
holds fourteen of his replies to agents' reports, from six projects, and
nine of the fourteen ask to be told again, in plain words, what he had
just been told (RP-1 to RP-14; the prose assessment of 2026-10-14). These
rules are what those replies asked for.

- The verdict comes first (section 4), and in the first sentence: what
  happened, or what he must decide.
- No private label without what it is, in plain words (section 2). "d10"
  told him nothing (RP-11), and a list of five internal names drew
  "explain these" (RP-5).
- A choice is offered as the options, what each does, and which is
  simplest: "i dont even understand the choices. what's simplest?" (PAVI,
  2026-08-20, RP-8; also RP-4, RP-10, RP-12).
- A command he may run, or text he may paste, is given complete and ready
  to paste, in a fenced block of its own, with nothing in it he must change
  first unless the change is named: "always, always, give me paste,
  convenientily formated to click-copy" (PAVI, 2026-08-17, RP-6; also RP-9,
  RP-10).
- What was not verified (section 4) is said in the message itself, not left
  for him to find in a file: what was not run, read or checked, and what
  therefore rests on inference.

exec
/bin/zsh -lc "tail -30 '/Users/pavi/Library/Application Support/Claude/side-session-notes/local_61e13c59-1352-4794-98af-3973ffc56c7e/redesign-today-design-note.md'; sed -n '4480,4555p' src/index.ts; cat src/pulse.ts" in /Users/pavi/ai-projects/atelier
 succeeded in 0ms:

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
// newest event recorded and since when, the owner's calls, the open review
// requests, the landings, the runners' progress, the events and the deploys.
// A project whose ledger cannot be read is named in `unread`, never counted as
// empty.
async function nowViewOf(env: Env, now: Date) {
  const projects = await index(env).projects();
  const [offers, pool] = await Promise.all([offersOf(env), poolOf(env)]);
  const unread: string[] = [];
  const read = await Promise.all(projects.map(async (project): Promise<NowProject | null> => {
    const L = ledgerOf(env, project);
    try {
      const { items, inbox } = await L.ownerRead(now.toISOString(), pool);
      // Every event of the last 48 hours, page by page, so no merge of today falls outside a window.
      const since = now.getTime() - 48 * 3_600_000;
      const events = await readEvents((before) => L.events(undefined, EVENTS_PAGE, before) as unknown as Promise<LedgerEvent[]>, EVENTS_PAGE, (last) => Date.parse(last.at) < since);
      const recent = [...new Set(events.filter((e) => e.kind === "item.merged" && e.itemId && Date.parse(e.at) >= since).map((e) => e.itemId!))];
      // The reviewer and the findings of a merged task may be older than the window: read its own record, page by page to its start.
      const seen = new Set(events.map((e) => e.seq));
      for (const id of recent) {
        for (const e of await readEvents((before) => L.events(id, EVENTS_PAGE, before) as unknown as Promise<LedgerEvent[]>, EVENTS_PAGE)) if (!seen.has(e.seq)) { seen.add(e.seq); events.push(e); }
      }
      const facts = await L.situationFacts(recent);
      return {
        name: project.name, title: titleOf(project), items: facts.items, stages: facts.stages,
        owner: attentionFor(project.name, items, inbox, offers, now).owner, reviewRequests: facts.reviewRequests,
        landings: facts.landings, progress: facts.progress ?? {}, events, deploys: await L.deploys(50),
      };
    } catch { unread.push(project.name); return null; }
  }));
  return { ...buildNow(read.filter((p): p is NowProject => p !== null), now), unread };
}

async function studioPage(c: Ctx): Promise<Response> {
  const { env } = c;
  const { projects, views } = await projectViews(env);
  const floor = buildFloor(await floorViewsOf(env, views), new Date());
  return html(renderStudio(floor, ownerName(env), new Date(), views.some((v) => v.unavailable), projects, ownerActor(env)));
}

async function flowPage(c: Ctx, live: { nonce: string; refresh: number }): Promise<Response> {
  const { env } = c;
  const { views } = await projectViews(env);
  const floorViews = await floorViewsOf(env, views);
  // The graph reads a project's longer record.
  const owner = ownerActor(env);
  const cutoffs = new Map<string, number | null>();
  const story = async (v: FloorView, filters?: { since?: string; family?: string }) => {
    try {
      const events = (await ledgerOf(env, v.project).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
      cutoffs.set(v.project.name, firstTaskAt(v.items));
      return buildStory(v.project.name, v.items, events, owner, events.length >= STORY_EVENTS, titleOf(v.project), filters);
    } catch { return null; }
  };
  // Unknown values are ignored: the page shows all time, every family.
  const sinceRaw = c.url.searchParams.get("since") ?? "all";
  const sinceParam = ["1d", "7d", "all"].includes(sinceRaw) ? sinceRaw : "all";
  const familyParam = c.url.searchParams.get("family");
  let sinceIso: string | undefined = undefined;
  if (sinceParam === "1d") sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  if (sinceParam === "7d") sinceIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const familyAllowed = VENDOR_NAMES.some(([v]) => v === familyParam) && familyParam ? familyParam : undefined;

  const unfilteredStories = (await Promise.all(floorViews.map((v) => story(v)))).filter((s): s is NonNullable<typeof s> => s !== null);
  const familiesPresent = [...new Set(unfilteredStories.flatMap(s => Object.keys(s.tally.byVendor) as string[]))];

  const stories = (sinceParam === "all" && !familyAllowed) ? unfilteredStories :
    (await Promise.all(floorViews.map((v) => story(v, { since: sinceIso, family: familyAllowed })))).filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => (b.moments.at(-1)?.at ?? "").localeCompare(a.moments.at(-1)?.at ?? ""));
  const incomplete = views.some((v) => v.unavailable) || stories.length < floorViews.length;
  const imported = await importedAll(env, floorViews.map((v) => v.project), cutoffs);
  return html(renderFlow(stories, stories.reduce((t, s) => addTally(t, s.tally), emptyTally()), owner, ownerName(env), incomplete, imported, sinceParam, familyAllowed, familiesPresent, live), 200, live.nonce);
}

async function decisionsPage(c: Ctx, live: { nonce: string; refresh: number }): Promise<Response> {
  const { env } = c;
  const { projects, views } = await projectViews(env);
// What the Projects and History pages show at a glance, as data. A project's
// pulse is a count of moves per day over the last two weeks, each move in
// the family of the agent that made it; the timeline is every merge and
// closure across projects, each with the family that held the task when it
// ended. Pure functions over the Ledger's items and events, so the pages
// that draw them and the tests that check them read the same model.

import type { LedgerEvent, ProjectRecord } from "./ledger.ts";
import { modelKey, type Item } from "./rules.ts";
import { DECISIONS, isAtelier, QUIET, vendorOf, type ShowcaseCounts, type Vendor } from "./graph.ts";
import { dayOf } from "./time.ts";

export const PULSE_DAYS = 14;

export interface PulseDay {
  day: string;                           // "2026-10-05", in the owner's zone
  byVendor: Partial<Record<Vendor, number>>;
  moves: number;                         // agents' moves that day
  decisions: number;                     // the owner's decisions that day
}

export interface Pulse {
  days: PulseDay[];                      // one per day of the window, oldest first
  moves: number;
  decisions: number;
  merges: number;                        // merges recorded in the window
  sentBack: number;                      // reviews in the window that sent the work back
  agents: string[];                      // every agent that moved in the window, first appearance first
  byVendor: Partial<Record<Vendor, number>>;
  lastAt: string | null;                 // the newest event read, of any kind
  cut: boolean;                          // the record read ran out inside the window, so older moves in it are not counted
}

// The last `days` calendar days in the owner's zone, oldest first. The clock
// is walked back half a day at a time and distinct days kept, so a change of
// daylight saving time never loses or doubles a day.
export function windowDays(now: Date, days = PULSE_DAYS): string[] {
  const out: string[] = [];
  for (let t = now.getTime(); out.length < days; t -= 12 * 3600_000) {
    const d = dayOf(t);
    if (out[0] !== d) out.unshift(d);
  }
  return out;
}

// `cut` says the events were read up to a limit, so the record may hold
// older ones. Moves are counted as the Flow graph's buildStory counts them:
// an agent's move is any event of theirs that is not bookkeeping (QUIET);
// what Atelier itself recorded (an observed push) is the
// platform's work and no one's move; the owner's decisions are counted
// apart, and nothing else of the owner's counts.
export function buildPulse(events: LedgerEvent[], owner: string, now: Date, cut = false, days = PULSE_DAYS): Pulse {
  const keys = windowDays(now, days);
  const index = new Map(keys.map((k, i) => [k, i]));
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const oldest = sorted.reduce<string | null>((m, ev) => (m === null || ev.at < m ? ev.at : m), null);
  const pulse: Pulse = {
    days: keys.map((day) => ({ day, byVendor: {}, moves: 0, decisions: 0 })),
    moves: 0, decisions: 0, merges: 0, sentBack: 0, agents: [], byVendor: {},
    lastAt: sorted.reduce<string | null>((m, ev) => (m === null || ev.at > m ? ev.at : m), null),
    // Read up to the limit and the oldest event read is inside the window:
    // older events in the window went unread.
    cut: cut && oldest !== null && index.has(dayOf(oldest)),
  };
  for (const ev of sorted) {
    const slot = index.get(dayOf(ev.at));
    if (slot === undefined) continue;
    const day = pulse.days[slot];
    if (ev.kind === "item.merged") pulse.merges++;
    if (ev.kind === "review.rejected") pulse.sentBack++;
    if (QUIET.has(ev.kind) || isAtelier(ev.actor)) continue;
    if (ev.actor === owner) {
      if (DECISIONS.has(ev.kind)) { day.decisions++; pulse.decisions++; }
      continue;
    }
    const v = vendorOf(ev.actor, owner);
    day.byVendor[v] = (day.byVendor[v] ?? 0) + 1;
    day.moves++;
    pulse.byVendor[v] = (pulse.byVendor[v] ?? 0) + 1;
    pulse.moves++;
    if (!pulse.agents.includes(ev.actor)) pulse.agents.push(ev.actor);
  }
  return pulse;
}

// The same pulse from the Ledger's counts (Ledger.showcaseCounts), which
// cover every event of the window however busy the record is, so nothing
// in it is cut. The Ledger has already placed each count on its day in the owner's zone.
export function pulseFromCounts(c: ShowcaseCounts, owner: string, now: Date, days = PULSE_DAYS): Pulse {
  const keys = windowDays(now, days);
  const index = new Map(keys.map((k, i) => [k, i]));
  const pulse: Pulse = {
    days: keys.map((day) => ({ day, byVendor: {}, moves: 0, decisions: 0 })),
    moves: 0, decisions: 0, merges: 0, sentBack: 0, agents: [], byVendor: {}, lastAt: c.last, cut: false,
  };
  for (const r of [...c.days].sort((a, b) => a.day.localeCompare(b.day))) {
    const slot = index.get(r.day);
    if (slot === undefined) continue;
    const day = pulse.days[slot];
    if (r.kind === "item.merged") pulse.merges += r.n;
    if (r.kind === "review.rejected") pulse.sentBack += r.n;
    if (QUIET.has(r.kind) || isAtelier(r.actor)) continue;
    if (r.actor === owner) {
      if (DECISIONS.has(r.kind)) { day.decisions += r.n; pulse.decisions += r.n; }
      continue;
    }
    const v = vendorOf(r.actor, owner);
    day.byVendor[v] = (day.byVendor[v] ?? 0) + r.n;
    day.moves += r.n;
    pulse.byVendor[v] = (pulse.byVendor[v] ?? 0) + r.n;
    pulse.moves += r.n;
    if (!pulse.agents.includes(r.actor)) pulse.agents.push(r.actor);
  }
  return pulse;
}

// ── the timeline ───────────────────────────────────────────────────────────

export interface TimelineEntry {
  project: ProjectRecord;
  item: Item;
  at: string;                            // when it merged or closed
  ending: "merged" | "closed";
  // Who held the task when it ended, from its claims and handoffs in the
  // record read; failing that, the last contributor the item names; else nobody known.
  holder: string | null;
  vendor: Vendor | null;
  commit: string | null;                 // the merge commit, when recorded
  recorded: boolean;                     // the ending event itself was among the events read
}

export interface TimelineView { project: ProjectRecord; items: Item[]; events: LedgerEvent[] }

// Every merged and closed task across the views, newest ending first.
export function buildTimeline(views: TimelineView[], owner: string): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const { project, items, events } of views) {
    const holders = new Map<string, string>();
    const endings = new Map<string, LedgerEvent>();
    for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
      if (!ev.itemId) continue;
      if (ev.kind === "item.claimed") holders.set(ev.itemId, ev.actor);
      else if (ev.kind === "item.handoff" && typeof ev.data?.to === "string" && ev.data.to) holders.set(ev.itemId, ev.data.to);
      else if (ev.kind === "item.merged" || ev.kind === "item.abandoned") endings.set(ev.itemId, ev);
    }
    for (const item of items) {
      if (item.state !== "merged" && item.state !== "abandoned") continue;
      const ev = endings.get(item.id);
      const holder = holders.get(item.id) ?? item.pushActors?.at(-1) ?? null;
      const commit = typeof ev?.data?.mergeCommit === "string" && ev.data.mergeCommit ? ev.data.mergeCommit : null;
      out.push({
        project, item, at: ev?.at ?? item.updatedAt, ending: item.state === "merged" ? "merged" : "closed",
        holder, vendor: holder ? vendorOf(holder, owner) : null, commit, recorded: !!ev,
      });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.item.id.localeCompare(b.item.id));
}

// The entries by the day they ended, in the owner's zone, newest day first.
export function byDay(entries: TimelineEntry[]): { day: string; entries: TimelineEntry[] }[] {
  const groups: { day: string; entries: TimelineEntry[] }[] = [];
  for (const x of entries) {
    const day = dayOf(x.at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.entries.push(x);
    else groups.push({ day, entries: [x] });
  }
  return groups;
}

// ── a project's showcase ───────────────────────────────────────────────────

// How many merged tasks the project's showcase page lists.
export const SHOWCASE_MERGES = 8;

export interface ShowcaseMerge {
  id: string;
  title: string;
  at: string;                            // when it merged
  model: string | null;                  // the model that built it, as its actor spells it; null when the record does not say
  vendor: Vendor | null;
}

export interface ProjectShowcase {
  pulse: Pulse;                          // the last PULSE_DAYS days, by family
  mergedAllTime: number;                 // tasks merged through the gate, as the global showcase counts them
  models: number;                        // distinct models that built the merged tasks (modelKey)
  recent: ShowcaseMerge[];               // the newest SHOWCASE_MERGES merges, newest first
}

// What one project's page of the showcase draws, all from its own record
// and by the computations the global showcase uses: the strip is
// pulseFromCounts, the all-time figure is the merged tasks less those landed
// in fast mode, and each merge's builder is the holder buildTimeline names.
// `events` is the recent window of the record; a merge older than it still
// lists, under the last contributor the task names, or under no model.
export function projectShowcase(project: ProjectRecord, counts: ShowcaseCounts, items: Item[], events: LedgerEvent[], owner: string, now: Date): ProjectShowcase {
  const merged = buildTimeline([{ project, items, events }], owner).filter((x) => x.ending === "merged");
  const builders = new Set(merged.flatMap((x) => (x.holder ? [modelKey(x.holder)] : [])));
  return {
    pulse: pulseFromCounts(counts, owner, now),
    mergedAllTime: items.filter((i) => i.state === "merged").length - (counts.landedFast ?? 0),
    models: builders.size,
    recent: merged.slice(0, SHOWCASE_MERGES).map((x) => ({ id: x.item.id, title: x.item.title, at: x.at, model: x.holder, vendor: x.vendor })),
  };
}

exec
/bin/zsh -lc "sed -n '11015,11115p' src/ledger.ts; sed -n '5020,5075p' src/ledger.ts; sed -n '4190,4318p' src/index.ts" in /Users/pavi/ai-projects/atelier
 succeeded in 0ms:
        : target.state === "resolve" || (target.state === "leased" && target.lease?.job === "resolve") ? "task-resolve" as const : null;
      if (!job || (offer && !(offer.jobs ?? []).includes(job))) continue;
      const [agent, model] = job === "task-resolve" && target.resolver ? [target.resolver.slice(0, target.resolver.indexOf("/")), target.resolver.slice(target.resolver.indexOf("/") + 1)] : ["atelier", "integrator"];
      jobs.push({ ...item, dispatch: { to: "home", agent, model, by: ORCHESTRATOR, at: target.updatedAt, note: `refresh from main at ${target.mainHead.slice(0, 8)}`, job, head: target.mainHead, expectedHead: item.head ?? undefined } });
    }
    return jobs;
  }

  // Queues a task's landing for a runner that holds the registered checkout
  // (t226, atelier land ID --queue). A task already merged or closed has no
  // landing to run; one already queued keeps its place.
  requestLand(id: string, by: string, quote?: string): { item: string; by: string; at: string; quote?: string; queued: boolean; requeued?: { failedStep: string; attempt: number } } {
    const item = this.item(id);
    this.assertParallelCriteriaReviewed(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("not_landable", `${id} is ${item.state}, so there is nothing to land`, 409, "run atelier ls to pick another task");
    const at = new Date().toISOString();
    if (item.state === "blocked") throw new RuleError("blocked", `${id} is blocked, so it is not queued to land: ${item.blocked?.reason ?? "no reason recorded"}`, 409, `run atelier unblock ${id}, then atelier land ${id} --queue`);
    const existing = this.sql.exec(`SELECT by, at, quote FROM land_jobs WHERE item = ?`, id).toArray()[0];
    // A landing that failed at this head is queued again only by asking
    // again (G1): the record says so, and the lander may take it once more.
    const stopped = this.landingStopped(item);
    const said = quote?.trim().slice(0, 500) || null;
    if (stopped) {
      this.saveLandingRecord(id, { ...stopped, requeued: at });
      if (existing) this.sql.exec(`UPDATE land_jobs SET at = ? WHERE item = ?`, at, id);
      else this.sql.exec(`INSERT INTO land_jobs (item, by, at, quote) VALUES (?, ?, ?, ?)`, id, by, at, said);
      this.log(id, by, "land.requested", { by, requeued: true, failedStep: stopped.failedStep, attempt: stopped.attempt, ...(said ? { quote: said } : {}) }, at);
      return { item: id, by, at, ...(said ? { quote: said } : {}), queued: true, requeued: { failedStep: stopped.failedStep!, attempt: stopped.attempt } };
    }
    if (existing) return { item: id, by: existing.by as string, at: existing.at as string, ...(existing.quote ? { quote: existing.quote as string } : {}), queued: false };
    this.sql.exec(`INSERT INTO land_jobs (item, by, at, quote) VALUES (?, ?, ?, ?)`, id, by, at, said);
    this.log(id, by, "land.requested", { by, ...(said ? { quote: said } : {}) }, at);
    return { item: id, by, at, ...(said ? { quote: said } : {}), queued: true };
  }

  // The landing enters its merge (G1): `atelier merge ID --landing` calls
  // this before it merges anything. The Ledger runs one call at a time, so
  // this and cancelLand cannot interleave: a cancel recorded first refuses
  // the merge, and one asked after finds the record at merge-main and
  // refuses, naming the step.
  beginLandMerge(id: string, actor: string, attempt?: number): LandingRecord {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer lands a task", 403, `only the developer can: atelier land ${id}`);
    this.item(id);
    const prev = this.landingRecord(id);
    const at = new Date().toISOString();
    // Only the landing that holds this task's live lease, in the attempt
    // the record names and has not failed, enters its merge: a stale or
    // direct call changes nothing, and a failure's evidence stands until a
    // new attempt starts.
    const held = this.projectLanding();
    if (!held || held.item !== id || !this.landingLive(held, at)) throw new RuleError("no_lease", `${id}'s landing holds no live landing lease, so it cannot enter its merge; nothing was changed`, 409, `run atelier land ${id}`);
    if (!prev || attempt === undefined || prev.attempt !== attempt) throw new RuleError("stale_landing", `${id}'s landing record is at attempt ${prev?.attempt ?? "none"}, not ${attempt ?? "unnamed"}, so this merge belongs to no current attempt; nothing was changed`, 409, `run atelier land ${id}`);
    if (prev.failedStep) throw new RuleError("landing_failed", `${id}'s landing (attempt ${prev.attempt}) failed at its ${prev.failedStep} step, so it does not enter its merge; nothing was changed`, 409, `run atelier show ${id} --json for the failure, then atelier land ${id} to start a new attempt`);
    if (prev.cancelled) throw new RuleError("landing_cancelled", `${id}'s queued landing was cancelled at ${prev.cancelled.slice(0, 16).replace("T", " ")} UTC, before its merge began, so nothing is merged`, 409, `run atelier land ${id} --queue to queue it again, or atelier land ${id} to land it here`);
    const record: LandingRecord = { ...prev, step: "merge-main", at };
    this.saveLandingRecord(id, record);
    return record;
  }

  // Removes a task's queued landing (G1, atelier land ID --queue --cancel).
  // Nothing queued answers so, changing nothing, so the command may be run
  // twice. A landing of the task that holds the lease and has begun its
  // merge is not interrupted: the cancel refuses, naming the step it is at.
  // One before its merge loses its queue row, and the record says when, so
  // the landing stops before it merges.
  cancelLand(id: string, by: string): { item: string; queued: boolean; cancelled: boolean; at?: string } {
    if (by !== this.owner) throw new RuleError("not_project_owner", "only the developer cancels a queued landing", 403, `only the developer can: atelier land ${id} --queue --cancel`);
    this.item(id);
    const record = this.landingRecord(id);
    const held = this.projectLanding();
    const at = new Date().toISOString();
    if (record && !record.failedStep && LAND_PAST_MERGE.has(record.step) && held?.item === id && this.landingLive(held, at)) {
      throw new RuleError("landing_past_merge", `${id}'s landing (attempt ${record.attempt}) is at its ${record.step} step, past the merge, so it is not cancelled or interrupted; it ends on its own, landed or failed`, 409, `run atelier show ${id} --json to read the landing as it goes; if it fails, it is not tried again unless you run atelier land ${id} --queue`);
    }
    const existing = this.sql.exec(`SELECT 1 FROM land_jobs WHERE item = ?`, id).toArray().length > 0;
    if (!existing) return { item: id, queued: false, cancelled: false };
    this.sql.exec(`DELETE FROM land_jobs WHERE item = ?`, id);
    if (record) this.saveLandingRecord(id, { ...record, cancelled: at });
    this.log(id, by, "land.cancelled", { by, ...(record ? { step: record.step, attempt: record.attempt } : {}) }, at);
    return { item: id, queued: false, cancelled: true, at };
  }

  // The land jobs a runner is offered (t226): the queued landings, to a
  // runner whose offer lists the job and names this project among the
  // checkouts it holds, and to no other. A job whose task has been closed, or has merged
  // with no post-merge work left, is dropped here.
  // `names` is every name the project has had, current first.
  landJobs(offer: RunnerOffer, names: string[]): Item[] {
    if (!(offer.jobs ?? []).includes("land") || !names.some((n) => (offer.checkouts ?? []).includes(n))) return [];
    const jobs: Item[] = [];
    for (const r of this.sql.exec(`SELECT item, by, at FROM land_jobs ORDER BY at, item`).toArray()) {
      const item = this.item(r.item as string);
      // A merged task keeps its job while its post-merge run is open: the
      // merge is recorded before the journal is cleared and the run executes,
      // and a landing killed between them resumes from here. A failed run
      // was reported by the landing that ran it, so it is not offered again.
      const run = item.state === "merged" ? this.postMergeRun(item.id) : null;
      if (item.state === "abandoned" || (item.state === "merged" && (!run || run.state === "complete" || run.state === "failed"))) { this.sql.exec(`DELETE FROM land_jobs WHERE item = ?`, item.id); continue; }
      // A blocked task is never landed, and a landing that failed at the
      // task's head is not tried again until the head changes or the
      // developer queues it again (G1): the job stays queued, unoffered.
    return this.item(id);
  }

  //
  // Unblocking is also the explicit retry after a blocking pre-review
  // (t524): it lifts the fence on the task's landing, so atelier land may
  // queue it again; the builder or the owner says the findings are dealt with.
  unblock(id: string, actor: string, proved = false, direction: OwnerDirection | null = null): Item {
    const item = this.item(id);
    const fence = this.prereviewFence(id);
    const roundCap = item.blocked?.by === ORCHESTRATOR && /^\d+ review rounds were rejected and no further round starts on its own/.test(item.blocked.reason);
    if (roundCap && (actor !== this.owner || !direction?.quote.trim() || !direction.acting)) {
      throw new RuleError("direction_needed", "A review round cap needs the developer's words: unblock with --quote \"what the developer said\" --as H/M", 403, `atelier unblock ${id} --quote \"what the developer said\" --as H/M`);
    }
    if (!fence && (item.state !== "blocked" || !item.blocked)) throw new RuleError("not_blocked", `${id} is ${item.state}, not blocked`, 409, "run atelier show ID");
    // A block that is a fact (G7: a run stopped at its limit) waits on no
    // one's decision, so any model with standing in the project lifts it.
    const fact = !fence && item.blocked?.fact ? item.blocked.fact : null;
    if (actor !== this.owner && !fact) assertOwner(item, actor);
    const at = new Date().toISOString();
    const said = direction ? { confirmed: "direction", quote: direction.quote, acting: direction.acting } : {};
    if (fence) {
      this.sql.exec(`DELETE FROM meta WHERE key = ?`, `prereview-fence:${id}`);
      this.log(id, actor, "prereview.retried", { request: fence.request, head: fence.head, current: item.head, ...said }, at, proved);
    }
    if (item.state !== "blocked" || !item.blocked) return this.item(id);
    this.update(id, { state: item.blocked.from, blocked: null }, at);
    this.log(id, actor, "item.unblocked", { reason: item.blocked.reason, to: item.blocked.from, ...(fact ? { fact } : {}), ...said }, at, proved);
    return this.item(id);
  }

  // The secret flag a push scan records or clears (t332). `hits` names the
  // file, line, fingerprint and commit of every line a commit of the task up
  // to `head` added that held a key pattern, and `unscanned` names every path
  // a commit changed and the scan could not read as text, with why and the
  // hash of its object; an empty list of both clears the flag. A later commit
  // that removes the line does not: the commit that added it is still in the
  // task's history, and the push to GitHub sends it (t295).
  // Only the file, line, fingerprint and commit ever reach the Ledger, never
  // the value.
  //
  // A finding whose file and fingerprint the owner has cleared before
  // (clearSecret) is recorded as cleared: it is kept, so the record shows the
  // scan found it, and it does not block. The match is by content, not line
  // number, so a push that keeps the cleared line where it was, or moves it
  // within its file, is not blocked again; a line changed in any way, or the
  // same line in another file, is a new finding and blocks.
  //
  // The result is applied only if `head`, the head it scanned, is still the
  // item's recorded head: the read and the write happen in one synchronous
  // step of the Durable Object, so nothing moves the head between them. A
  // result for any other head is dropped, and the newer head's own pending
  // scan stands. The scan pending for `head` is cleared in the same write as
  // the flags, whether the findings changed or not.
  //
  // `refused` records the findings of a push the hook refused (hookScanned),
  const { env, req } = c;
  // One nonce per request, for the pages that carry the live script.
  const nonce = newNonce();
  const live = { nonce, refresh: LIVE_REFRESH };
  if (parts[0] === "models" && (parts.length === 1 || (parts.length === 2 && req.method === "POST"))) return await modelsPage(c, parts[1]);
  if (parts[0] === "usage" && parts.length === 1 && req.method === "GET") {
    const I = index(env);
    const [reports, alerts, track] = await Promise.all([I.usage(), I.usageAlerts(), trackRecords(env)]);
    const reliability = { models: track.reliability, events: track.events, unread: track.unread.map(titleOf) };
    return html(renderUsage(reports as unknown as UsageReport[], thresholds(env), alerts, new Date(), ownerName(env), reliability));
  }
  if (req.method === "POST" && parts[0] === "ui") {
    const origin = req.headers.get("origin");
    if (origin !== c.url.origin) return html("Cross-origin form refused.", 403);
    const form = await req.formData();
    const [, named, id, verb] = parts; // /ui/<project>/<id>/<verb>
    // A form posted from a page opened before a rename still acts; its
    // answer sends the browser to the page under the name the project has now.
    const ref = await resolveProject(env, named ?? "");
    const project = ref.name;
    const L = ledger(env, ref.key);
    // A browser posts each line break of a textarea as CRLF, which the page
    // counts as one character; the dispatch form folds them to LF here, so
    // the limit the page showed holds. The API and CLI text is never changed.
    const note = verb === "dispatch" ? String(form.get("note") ?? "").replace(/\r\n?/g, "\n") : String(form.get("note") ?? "");
    const owner = ownerActor(env);
    // The page's forms name a builder or a new holder, kept as declared, as
    // the API's explicit dispatch and handoff keep them (canonicalNames).
    const formNames: NameFields = { to: form.get("to") ?? undefined, agent: form.get("agent") ?? undefined, model: form.get("model") ?? undefined };
    if (id === "new" && !verb) {
      // A long title with no brief becomes the brief, with a short title derived from it (itemText).
      const brief = String(form.get("brief") ?? "");
      const item = await L.newItem(String(form.get("title") ?? ""), String(form.get("scope") ?? "").split(",").map(s=>s.trim()).filter(Boolean), owner, brief.trim() ? { brief } : {});
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${item.id}`,c.url).toString(),303);
    }
    // The Revert link on the Now page: a task to revert the merged one, which
    // records the merge commit as the CLI's revert does (Ledger.newItem).
    if (verb === "revert") {
      const made = await L.newItem("", [], owner, { revertOf: id });
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(made.id)}`, c.url).toString(), 303);
    }
    // The Settings tab's permission for atelier mode fast, given as the task
    // page's override permission is: from the developer's own sign-in, with
    // the factor no agent holds (Astra's audit of 2026-10-13, finding 3).
    if (id === "mode" && verb === "allow-fast") {
      if (!c.signedIn) throw new RuleError("fast_mode_unconfirmed", `fast mode needs the developer's own sign-in, not the developer token: ${fastModePageHint(project, c.url.origin, ownerFactorOf(env))}`, 403, `${fastModePageHint(project, c.url.origin, ownerFactorOf(env))}`);
      await L.confirmFastMode(owner, ownerFactorIn(env, c, form, project, null));
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/settings`, c.url).toString(), 303);
    }
    // The Ship tab's protected-action forms: approve at the head it showed, or withdraw.
    if (id === "actions") {
      await actionForm(L, verb, form, owner, async (commit) => onMainLine(env, (await L.project()).repo, commit));
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/ship`, c.url).toString(), 303);
    }
    // A refusal of one of the task page's own forms (approve, request
    // changes, accept, override, the command-line permission) is answered
    // with the task's page, drawn again from the record, the refusal beside
    // the form it came from and the reason typed kept; never the
    // confirmation secret (t457). Any other failure goes to the error page.
    try {
      const before = await L.item(id);
      const expected = String(form.get("head") ?? "");
      if (before.head) assertRevision(before, expected);
      if (["accept", "override", "allow-override", "approve", "reject"].includes(verb)) await verifyRevision(env, ref.key, id, expected);
      // Every form of the page carries the criteria it showed beside the
      // head: the decision forms must name them, and any form that does is
      // refused once they changed, so an override or a permission is never
      // made from a page showing other criteria than the task's (t457).
      const shownCriteria = form.get("criteria");
      if ((TASK_FORMS.has(verb) || shownCriteria !== null) && shownCriteria !== criteriaOf(before)) {
        throw new RuleError("stale_criteria", `${id}'s acceptance criteria changed since you opened this page; reload it and read them again`, 409, "reload the task page, read the criteria, then decide again");
      }
      // An override sent from a page drawn before the task was accepted (an
      // old tab) would record a second override and acceptance; it is
      // refused, the page drawn again with the acceptance on it (t457).
      if (verb === "override" && before.state !== "submitted") {
        throw new RuleError("not_submitted", before.state === "accepted"
          ? `${id} was already accepted at ${(before.acceptedHead ?? before.head ?? "").slice(0, 8)} since this page was drawn, so this override would record a second override and acceptance`
          : `${id} is ${before.state}; an override is made only on a submitted revision`, 409, `run atelier show ${id}`);
      }
      if (verb === "accept" || verb === "override") await assertPlanMergeable(env, L, id);
      // The override forms are the owner's confirmation only with the factor
      // no agent holds (t371, ownerFactorIn): posted with the owner token as a
      // bearer, as an agent could, or from a session alone, which that token
      // buys, they are refused as the API's override is.
      let factor: OwnerFactor | undefined;
      if (verb === "override" || verb === "allow-override") {
        if (!c.signedIn) throw new RuleError("override_unconfirmed", `an override of the independent review needs the developer's own sign-in, not the developer token: ${overrideConfirmationHint(project, id, c.url.origin, ownerFactorOf(env))}`, 403, `${overrideConfirmationHint(project, id, c.url.origin, ownerFactorOf(env))}`);
        factor = ownerFactorIn(env, c, form, project, id);
      }
      // A change of owner takes the write token with it, as on the API routes:
      // the Ledger clears the id read here only if it is still the one recorded.
      const oldToken = await L.tokenId(id);
      // As on the API routes: a change of owner is checked, the holder's
      // write token revoked, and only then the change made.
      const moving = verb === "abandon" || verb === "release" || verb === "handoff" || verb === "dispatch";
      if (moving) {
        if (verb === "dispatch") await L.checkDispatch(id, owner, { to: formNames.to, agent: formNames.agent, model: formNames.model, note });
        else if (verb === "abandon") await L.checkAbandon(id, owner, note);
        else if (verb === "release") await L.checkRelease(id, owner, note);
        else await L.checkHandoff(id, owner, String(formNames.to ?? ""), note);
        await revoke(env, oldToken);
      }
      if (verb === "dispatch") await L.dispatch(id, owner, { to: formNames.to, agent: formNames.agent, model: formNames.model, note }, oldToken, await namedBuilderReasons(env, ref.key, { agent: formNames.agent || undefined, model: formNames.model || undefined }, owner));
      else if (verb === "undispatch") await L.undispatch(id, owner);
      else if (verb === "accept") await L.accept(id, owner, expected, undefined, undefined, undefined, undefined, String(shownCriteria));
      // The page's override form: accept with the owner's override of a missing
      // independent review, its reason in the note.
      else if (verb === "override") await L.accept(id, owner, expected, note, undefined, factor, await reviewerAvailability(env, L, id), String(shownCriteria));
      // The page's permission for an override from the command line (t371).
      else if (verb === "allow-override") await L.confirmOverride(id, owner, expected, factor!, String(shownCriteria));
      else if (verb === "abandon") await L.abandon(id, owner, note, oldToken);
      else if (verb === "block") await L.block(id, owner, note);
      else if (verb === "unblock") await L.unblock(id, owner);
      else if (verb === "clear-secret") await L.clearSecret(id, owner, note);
      else if (verb === "release") await L.release(id, owner, note, false, oldToken);
      else if (verb === "handoff") await L.handoff(id, owner, String(formNames.to ?? ""), note, false, oldToken);
      else if (verb === "approve" || verb === "reject") {
        await L.addReview({ itemId: id, by: owner, head: expected, criteria: String(form.get("criteria") ?? ""), approve: verb === "approve", note, at: new Date().toISOString() }, c.url.origin, false, "page");
      } else return html(renderError("Unknown action.", "/home", ownerName(env)), 400);
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`, c.url).toString(), 303);
    } catch (err) {
      const rule = parseRuleError(err);
      if (!rule || !TASK_FORMS.has(verb)) throw err;
      const kept = verb === "override" || verb === "reject" ? note : "";
      const formError: FormError = { verb: verb as FormError["verb"], message: rule.detail, ...(kept ? { note: kept } : {}) };
      return html(await taskPage(env, L, id, formError), rule.status);
    }
  }

codex
The data boundary needs attention: `nowViewOf` returns the built Now view, while the proposal also needs raw deploys and a longer event history. I’m checking the button retry paths and the criteria against the briefs next. I’m using the house-style skill for the review prose.
exec
/bin/zsh -lc "cat '/Users/pavi/ai-projects/atelier-mockups/site-redesign/mockups/a-home.html'" in /Users/pavi/ai-projects/atelier
 succeeded in 0ms:
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>A · Today · Atelier</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="base.css">
<style>
.bar { position: sticky; top: 0; z-index: 10; background: rgba(var(--surface-rgb), .92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
.bar-in { max-width: 1040px; margin: 0 auto; padding: 0 24px; height: 56px; display: flex; align-items: center; gap: 28px; }
.brand { font: 800 19px/1 var(--font-display); }
.nav { display: flex; gap: 4px; }
.nav a { padding: 8px 12px; border-radius: 8px; color: var(--text-muted); font-weight: 500; }
.nav a[aria-current] { color: var(--text); background: var(--inset); }
.nav .soon { border: 1px dashed var(--line-bright); }
.who { margin-left: auto; display: flex; align-items: center; gap: 10px; color: var(--text-muted); font-size: 13px; }
.live { display: inline-flex; align-items: center; gap: 6px; } .live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: breathe 2.4s infinite; }
main { max-width: 1040px; margin: 0 auto; padding: 40px 24px 80px; }
.date { color: var(--text-muted); font-size: 14px; margin-bottom: 6px; }
h1 { font-size: 44px; font-weight: 800; line-height: 1.05; }
h1 em { font-style: normal; color: var(--signal); }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 28px 0 44px; }
.tile { background: var(--surface-raised); border: 1px solid var(--line); border-radius: var(--radius-medium); padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; transition: border-color .2s; }
.tile:hover { border-color: var(--line-bright); }
.tile .n { font: 800 34px/1 var(--font-display); }
.tile .l { font-size: 13px; color: var(--text-muted); }
.tile.you { border-color: var(--wire); background: rgba(var(--signal-rgb), .07); } .tile.you .n { color: var(--signal); }
.dots { display: flex; gap: 4px; flex-wrap: wrap; height: 10px; } .dots i { width: 10px; height: 10px; border-radius: 3px; background: var(--fam); }
.spark { display: flex; align-items: end; gap: 3px; height: 22px; } .spark i { flex: 1; background: var(--ok); border-radius: 2px; opacity: .8; }
.ships { display: flex; gap: 6px; } .ships i { width: 22px; height: 10px; border-radius: 3px; background: var(--ok); } .ships i.off { background: rgba(var(--text-rgb), .12); }
section { margin-bottom: 44px; }
.sh { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
.sh h2 { font-size: 22px; font-weight: 700; } .sh .c { color: var(--text-muted); font: 500 14px var(--font-mono); } .sh a { margin-left: auto; font-size: 13px; color: var(--text-muted); }
.ask { display: grid; grid-template-columns: 1fr auto; gap: 6px 20px; padding: 18px 20px; border: 1px solid var(--line); border-left: 3px solid var(--signal); border-radius: var(--radius-medium); background: var(--surface-raised); margin-bottom: 10px; align-items: center; }
.ask .t { font-weight: 600; font-size: 16px; } .ask .meta { font-size: 13px; color: var(--text-muted); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.ask .why { grid-column: 1; font-size: 14px; color: var(--text-muted); }
.ask .acts { grid-row: 1 / span 3; grid-column: 2; display: flex; gap: 8px; }
.lane { display: grid; grid-template-columns: 22px 1fr 220px 90px; gap: 16px; align-items: center; padding: 14px 4px; border-bottom: 1px solid var(--line); }
.lane .t { font-weight: 500; } .lane .sub { font-size: 13px; color: var(--text-muted); }
.lane .st { font-size: 12px; color: var(--text-muted); margin-top: 6px; display: flex; justify-content: space-between; }
.lane .el { text-align: right; font: 13px var(--font-mono); color: var(--text-muted); }
.lane.stuck .el { color: var(--warn); }
.landed { position: relative; padding-left: 26px; }
.landed::before { content: ""; position: absolute; left: 6px; top: 6px; bottom: 6px; width: 2px; background: var(--line-bright); }
.ev { position: relative; padding: 8px 0 14px; display: flex; gap: 14px; align-items: baseline; }
.ev::before { content: ""; position: absolute; left: -25px; top: 13px; width: 12px; height: 12px; border-radius: 50%; background: var(--surface); border: 2px solid var(--fam, var(--ok)); }
.ev.deploy::before { background: var(--ok); border-color: var(--ok); border-radius: 3px; }
.ev .tm { font: 13px var(--font-mono); color: var(--text-muted); width: 52px; flex: none; }
.ev .t { font-weight: 500; } .ev .sub { font-size: 13px; color: var(--text-muted); }
.projects { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.proj { border: 1px solid var(--line); border-radius: var(--radius-medium); padding: 16px; background: var(--surface-raised); }
.proj h3 { font-size: 18px; } .proj .k { font-size: 13px; color: var(--text-muted); margin: 4px 0 12px; }
.bars { display: flex; align-items: end; gap: 3px; height: 34px; } .bars i { flex: 1; border-radius: 2px; background: var(--fam); }
@media (max-width: 760px) {
  .bar-in { padding: 0 16px; gap: 12px; } .nav a { padding: 8px 8px; font-size: 14px; } .nav .hide-s, .who .hide-s { display: none; }
  main { padding: 24px 16px 60px; } h1 { font-size: 32px; }
  .tiles { grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 20px 0 32px; } .tile .n { font-size: 28px; }
  .ask { grid-template-columns: 1fr; } .ask .acts { grid-row: auto; grid-column: 1; margin-top: 8px; }
  .lane { grid-template-columns: 14px 1fr 70px; } .lane .trk { grid-column: 2 / span 2; }
  .projects { grid-template-columns: 1fr; }
}
</style></head><body>
<header class="bar"><div class="bar-in">
  <a class="brand" href="#">Atelier</a>
  <nav class="nav"><a aria-current="page">Today</a><a>Projects</a><a class="soon" title="Designed separately">Flow</a><a class="hide-s">History</a></nav>
  <div class="who"><span class="live">Live</span><span class="hide-s">PAVI ▾</span></div>
</div></header>
<main>
  <div class="date">Sunday 8 November · 10:42 EST</div>
  <h1><em>3 things</em> wait for you.<br>5 agents are building.</h1>

  <div class="tiles">
    <a class="tile you"><span class="n">3</span><span class="l">Need you</span><div class="dots"><i class="f-you"></i><i class="f-you"></i><i class="f-you"></i></div></a>
    <a class="tile"><span class="n">5</span><span class="l">Running now</span><div class="dots"><i class="f-anthropic"></i><i class="f-anthropic"></i><i class="f-openai"></i><i class="f-zai"></i><i class="f-google"></i></div></a>
    <a class="tile"><span class="n">7</span><span class="l">Merged today</span><div class="spark"><i style="height:30%"></i><i style="height:55%"></i><i style="height:20%"></i><i style="height:70%"></i><i style="height:45%"></i><i style="height:90%"></i><i style="height:60%"></i></div></a>
    <a class="tile"><span class="n">2</span><span class="l">Deploys today · main green</span><div class="ships"><i></i><i></i><i class="off"></i></div></a>
  </div>

  <section>
    <div class="sh"><h2>Needs you</h2><span class="c">3</span><a href="#">All decisions →</a></div>
    <div class="ask"><div class="t">Report's help states its length limit</div>
      <div class="meta"><span class="mono">atelier · t553</span><span class="chip ok">Ready to land</span><span class="f-anthropic"><span class="fam-dot"></span> opus-5.5</span></div>
      <div class="why">2 of 2 checks passed on a runner; reviewed by gpt-6. Main has not moved.</div>
      <div class="acts"><a class="btn primary">Land</a><a class="btn">Diff</a></div></div>
    <div class="ask"><div class="t">Tasks naming one design note wait for each other</div>
      <div class="meta"><span class="mono">atelier · t538</span><span class="chip warn">Blocked</span><span class="f-openai"><span class="fam-dot"></span> gpt-6-astra</span></div>
      <div class="why">“The baseline's fixture for sessions is missing; which login flow is current?”</div>
      <div class="acts"><a class="btn primary">Answer</a><a class="btn">Open</a></div></div>
    <div class="ask"><div class="t">Offline sync of notes</div>
      <div class="meta"><span class="mono">field-notes · t70</span><span class="chip bad">Needs a reviewer</span><span class="f-zai"><span class="fam-dot"></span> glm-5.3</span></div>
      <div class="why">Touches a protected path; no reviewer of another family is online.</div>
      <div class="acts"><a class="btn primary">Allow override</a><a class="btn">Open</a></div></div>
  </section>

  <section>
    <div class="sh"><h2>Running</h2><span class="c">5</span><a href="#">Flow →</a></div>
    <div class="lane f-anthropic"><span class="fam-dot"></span><div><div class="t">A review mentioning ‘too long’ is not a size refusal</div><div class="sub"><span class="mono">atelier · t554</span> · opus-5.5</div></div><div class="trk"><div class="track"><i class="done"></i><i class="done"></i><i class="now"></i><i></i><i></i></div><div class="st"><span>Prove · checks running</span></div></div><div class="el">12 min</div></div>
    <div class="lane f-openai"><span class="fam-dot"></span><div><div class="t">Show the design hold on the task page</div><div class="sub"><span class="mono">atelier · t556</span> · gpt-6-astra</div></div><div class="trk"><div class="track"><i class="done"></i><i class="done"></i><i class="done"></i><i class="now"></i><i></i></div><div class="st"><span>Review · by opus-5.5</span></div></div><div class="el">4 min</div></div>
    <div class="lane f-zai"><span class="fam-dot"></span><div><div class="t">Search across notebooks</div><div class="sub"><span class="mono">field-notes · t72</span> · glm-5.3</div></div><div class="trk"><div class="track"><i class="done"></i><i class="now"></i><i></i><i></i><i></i></div><div class="st"><span>Branch · building</span></div></div><div class="el">38 min</div></div>
    <div class="lane f-google stuck"><span class="fam-dot"></span><div><div class="t">Refactor paging on the log</div><div class="sub"><span class="mono">ledger-core · t193</span> · gemini-3.1-pro</div></div><div class="trk"><div class="track"><i class="done"></i><i class="now"></i><i></i><i></i><i></i></div><div class="st"><span>Branch · no push for 2 h</span></div></div><div class="el">2 h · stuck</div></div>
    <div class="lane f-anthropic"><span class="fam-dot"></span><div><div class="t">Share sheet keeps the last folder</div><div class="sub"><span class="mono">field-notes · t74</span> · sonnet-5.5</div></div><div class="trk"><div class="track"><i class="now"></i><i></i><i></i><i></i><i></i></div><div class="st"><span>Claim · queued for a runner</span></div></div><div class="el">1 min</div></div>
  </section>

  <section>
    <div class="sh"><h2>Merged and deployed today</h2><span class="c">7 · 2 deploys</span><a href="#">History →</a></div>
    <div class="landed">
      <div class="ev deploy"><span class="tm">10:20</span><div><div class="t">Deployed atelier at 23b951bd</div><div class="sub">3 merges shipped · post-merge checks green</div></div></div>
      <div class="ev f-anthropic"><span class="tm">10:05</span><div><div class="t">t551 Review notices name the finding they answer</div><div class="sub">atelier · opus-5.5 · reviewed by gpt-6</div></div></div>
      <div class="ev f-openai"><span class="tm">09:41</span><div><div class="t">t549 Design hold applies with no core files</div><div class="sub">atelier · gpt-6-astra · 2 findings fixed</div></div></div>
      <div class="ev f-zai"><span class="tm">08:12</span><div><div class="t">t69 Keychain crash on first launch</div><div class="sub">field-notes · glm-5.3</div></div></div>
      <div class="ev deploy"><span class="tm">07:30</span><div><div class="t">Deployed field-notes at 4be01c7</div><div class="sub">2 merges shipped</div></div></div>
    </div>
  </section>

  <section>
    <div class="sh"><h2>Projects</h2><span class="c">3 active</span><a href="#">All →</a></div>
    <div class="projects">
      <a class="proj f-anthropic"><h3>atelier</h3><div class="k">2 need you · 3 running · last merge 37 min</div><div class="bars"><i style="height:40%"></i><i style="height:65%"></i><i style="height:30%"></i><i style="height:80%"></i><i style="height:55%"></i><i style="height:90%"></i><i style="height:70%"></i><i style="height:45%"></i><i style="height:60%"></i><i style="height:100%"></i><i style="height:75%"></i><i style="height:50%"></i><i style="height:85%"></i><i style="height:65%"></i></div></a>
      <a class="proj f-zai"><h3>field-notes</h3><div class="k">1 needs you · 2 running · last merge 2 h</div><div class="bars"><i style="height:20%"></i><i style="height:35%"></i><i style="height:50%"></i><i style="height:25%"></i><i style="height:40%"></i><i style="height:30%"></i><i style="height:55%"></i><i style="height:60%"></i><i style="height:20%"></i><i style="height:45%"></i><i style="height:35%"></i><i style="height:70%"></i><i style="height:40%"></i><i style="height:50%"></i></div></a>
      <a class="proj f-google"><h3>ledger-core</h3><div class="k">1 stuck · last merge 1 d</div><div class="bars"><i style="height:30%"></i><i style="height:20%"></i><i style="height:45%"></i><i style="height:15%"></i><i style="height:10%"></i><i style="height:25%"></i><i style="height:5%"></i><i style="height:10%"></i><i style="height:5%"></i><i style="height:20%"></i><i style="height:8%"></i><i style="height:4%"></i><i style="height:12%"></i><i style="height:6%"></i></div></a>
    </div>
  </section>
</main>
<div class="mock-note">Direction A · Today · mockup data</div>
</body></html>

exec
/bin/zsh -lc "nl -ba src/now.ts | sed -n '25,120p;245,286p'; nl -ba src/ledger.ts | sed -n '11026,11048p;5990,6007p'; cat test/fixtures/now.ts" in /Users/pavi/ai-projects/atelier
 succeeded in 0ms:
    25	const LANDING_FRESH_MS = 30 * 60_000;
    26	
    27	export type NowGroupKey = "needs-you" | "running" | "waiting" | "landed";
    28	export const NOW_GROUPS: { key: NowGroupKey; label: string }[] = [
    29	  { key: "needs-you", label: "Needs you" },
    30	  { key: "running", label: "Running" },
    31	  { key: "waiting", label: "Stuck or waiting on a session" },
    32	  { key: "landed", label: "Landed today" },
    33	];
    34	
    35	// What one project's ledger recorded, as the route reads it (situationFacts,
    36	// the owner's attention, the recent events and the deploys).
    37	export interface NowProject {
    38	  name: string;
    39	  title: string;
    40	  items: Item[];
    41	  stages: Record<string, { stage: string; since: string }>;
    42	  owner: OwnerTask[];
    43	  reviewRequests: { item: string; state: string; claimedBy: string | null; claimedAt: string | null }[];
    44	  landings: Record<string, LandingRecord>;
    45	  progress: Record<string, ProgressRecord>;
    46	  events: Pick<LedgerEvent, "seq" | "kind" | "itemId" | "at" | "actor" | "data">[];
    47	  deploys: Pick<DeployRecord, "ship" | "head" | "by" | "result" | "at">[];
    48	}
    49	
    50	export interface NowRow {
    51	  id: string;
    52	  project: string;
    53	  projectTitle: string;
    54	  title: string;
    55	  group: NowGroupKey;
    56	  stage: string;
    57	  waitingOn: string;
    58	  since: string;
    59	  sinceText: string;
    60	  next: string;
    61	  tokens: number | null;
    62	  tokensText: string;
    63	  // Landed rows: the weighted tokens of the task's runs, null when a run has no parts.
    64	  weightedTokens?: number | null;
    65	  // Runs of this task whose record has no token parts.
    66	  unknownRuns?: number;
    67	  stuck: string | null;
    68	  href: string;
    69	  // Landed today only.
    70	  deployedAt?: string | null;
    71	  deployedText?: string;
    72	  reviewer?: string | null;
    73	  findingsFixed?: number;
    74	  revertHref?: string | null;
    75	  reverted?: boolean;
    76	  // The revert task filed for it, merged or not.
    77	  revertTask?: string | null;
    78	}
    79	
    80	export interface NowHeader {
    81	  mergesToday: number;
    82	  soundMergesToday: number;
    83	  liveCount: number;
    84	  tokensPerSoundMerge: number | null;
    85	  tokensPerSoundMergeText: string;
    86	  target: number;
    87	  targetText: string;
    88	  onTarget: boolean;
    89	}
    90	
    91	export interface NowView {
    92	  at: string;
    93	  header: NowHeader;
    94	  groups: { key: NowGroupKey; label: string; rows: NowRow[] }[];
    95	  // Projects whose ledger could not be read, which the route sets: their
    96	  // tasks are not in the groups, and the page and the text say so.
    97	  unread?: string[];
    98	}
    99	
   100	const parts = (at: string) => {
   101	  const f = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(new Date(at));
   102	  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
   103	  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
   104	};
   105	// "2026-11-07 07:00 EST": the moment in Eastern time, the zone's abbreviation
   106	// in force at that moment (EDT before the first Sunday of November).
   107	export const easternStamp = (at: string): string => parts(at);
   108	
   109	// "10 min", "6 h", "1 h 30 min".
   110	function span(ms: number): string {
   111	  const m = Math.max(1, Math.round(ms / 60_000));
   112	  if (m < 60) return `${m} min`;
   113	  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
   114	}
   115	
   116	// The bars' rule (t527): input x1, cache write x1.25, cache read x0.1, output x5.
   117	export const weighted = (p: TokenParts): number => p.input + 1.25 * p.cacheWrite + 0.1 * p.cacheRead + 5 * p.output;
   118	const partsOf = (run: object): TokenParts | null => {
   119	  const p = (run as { parts?: Partial<Record<keyof TokenParts, unknown>> }).parts;
   120	  if (!p || typeof p !== "object") return null;
   245	
   246	// The view at `now`. A merge is sound unless a revert of it was asked for;
   247	// the header's tokens are those spent on every merge today, sound or not,
   248	// divided by the sound ones.
   249	export function buildNow(projects: NowProject[], now: Date): NowView {
   250	  const today = dayInZone(now, EASTERN);
   251	  const live: NowRow[] = [], landed: NowRow[] = [];
   252	  for (const p of projects) {
   253	    for (const item of p.items) {
   254	      if (item.state === "abandoned") continue;
   255	      if (item.state === "merged") {
   256	        const at = mergedAt(p.events, item.id);
   257	        if (at && Date.parse(at) <= now.getTime() && dayInZone(at, EASTERN) === today) landed.push(landedRow(p, item, at, now));
   258	        continue;
   259	      }
   260	      live.push(liveRow(p, item, now));
   261	    }
   262	  }
   263	  const bySince = (a: NowRow, b: NowRow) => a.since.localeCompare(b.since) || a.project.localeCompare(b.project) || a.id.localeCompare(b.id, "en", { numeric: true });
   264	  landed.sort((a, b) => b.since.localeCompare(a.since) || a.id.localeCompare(b.id, "en", { numeric: true }));
   265	  const groups = NOW_GROUPS.map((g) => ({ ...g, rows: g.key === "landed" ? landed : live.filter((r) => r.group === g.key).sort(bySince) }));
   266	  const sound = landed.filter((r) => !r.reverted).length;
   267	  const measured = landed.filter((r) => r.weightedTokens != null);
   268	  const complete = measured.length === landed.length;
   269	  const unknownRuns = landed.reduce((n, r) => n + (r.unknownRuns ?? 0), 0);
   270	  const spentToday = measured.reduce((n, r) => n + r.weightedTokens!, 0);
   271	  const per = sound && complete ? Math.round(spentToday / sound) : null;
   272	  return {
   273	    at: now.toISOString(),
   274	    header: {
   275	      mergesToday: landed.length, soundMergesToday: sound, liveCount: live.length, tokensPerSoundMerge: per,
   276	      tokensPerSoundMergeText: per !== null ? fmtM(per) : !complete ? `unknown: ${unknownRuns} ${unknownRuns === 1 ? "run" : "runs"} without token parts` : landed.length ? "no sound merge yet" : "no merges yet",
   277	      target: TARGET_TOKENS_PER_MERGE, targetText: fmtM(TARGET_TOKENS_PER_MERGE), onTarget: per !== null && per <= TARGET_TOKENS_PER_MERGE,
   278	    },
   279	    groups,
   280	  };
   281	}
   282	
   283	// Every event a reader returns, newest first, page by page until a short page:
   284	// no cap on the count. `stop` ends the walk early once a page reaches back far
   285	// enough (the project window); a task's own record is read to its start.
   286	export async function readEvents<E extends { seq: number }>(page: (before: number | undefined) => Promise<E[]>, size: number, stop?: (last: E) => boolean): Promise<E[]> {
  5990	    return this.deploys(1)[0] ?? null;
  5991	  }
  5992	
  5993	  // The newest deploys first.
  5994	  deploys(limit = 50): DeployRecord[] {
  5995	    return this.sql.exec(`SELECT data FROM events WHERE kind = 'ship.recorded' ORDER BY seq DESC LIMIT ?`, Math.max(1, Math.min(200, limit))).toArray()
  5996	      .map((r) => JSON.parse(r.data as string) as DeployRecord);
  5997	  }
  5998	
  5999	  // ── pre-review (t524, src/dispatch/prereview.ts) ─────────────────────────
  6000	  // While a landing holds the lease, the next PREREVIEW_DEPTH landings
  6001	  // queued behind it are reviewed against the tree their own landing would
  6002	  // test. The requests and results live in the prereviews table, never in
  6003	  // review_requests or reviews, so the gate never reads one. They reach the
  6004	  // runner through the queue's review list and come back through the review
  6005	  // routes under request numbers past PREREVIEW_REQUEST_BASE.
  6006	
  6007	  // The pre-reviews the live lease calls for. The pool and the runner offers
 11026	  requestLand(id: string, by: string, quote?: string): { item: string; by: string; at: string; quote?: string; queued: boolean; requeued?: { failedStep: string; attempt: number } } {
 11027	    const item = this.item(id);
 11028	    this.assertParallelCriteriaReviewed(id);
 11029	    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("not_landable", `${id} is ${item.state}, so there is nothing to land`, 409, "run atelier ls to pick another task");
 11030	    const at = new Date().toISOString();
 11031	    if (item.state === "blocked") throw new RuleError("blocked", `${id} is blocked, so it is not queued to land: ${item.blocked?.reason ?? "no reason recorded"}`, 409, `run atelier unblock ${id}, then atelier land ${id} --queue`);
 11032	    const existing = this.sql.exec(`SELECT by, at, quote FROM land_jobs WHERE item = ?`, id).toArray()[0];
 11033	    // A landing that failed at this head is queued again only by asking
 11034	    // again (G1): the record says so, and the lander may take it once more.
 11035	    const stopped = this.landingStopped(item);
 11036	    const said = quote?.trim().slice(0, 500) || null;
 11037	    if (stopped) {
 11038	      this.saveLandingRecord(id, { ...stopped, requeued: at });
 11039	      if (existing) this.sql.exec(`UPDATE land_jobs SET at = ? WHERE item = ?`, at, id);
 11040	      else this.sql.exec(`INSERT INTO land_jobs (item, by, at, quote) VALUES (?, ?, ?, ?)`, id, by, at, said);
 11041	      this.log(id, by, "land.requested", { by, requeued: true, failedStep: stopped.failedStep, attempt: stopped.attempt, ...(said ? { quote: said } : {}) }, at);
 11042	      return { item: id, by, at, ...(said ? { quote: said } : {}), queued: true, requeued: { failedStep: stopped.failedStep!, attempt: stopped.attempt } };
 11043	    }
 11044	    if (existing) return { item: id, by: existing.by as string, at: existing.at as string, ...(existing.quote ? { quote: existing.quote as string } : {}), queued: false };
 11045	    this.sql.exec(`INSERT INTO land_jobs (item, by, at, quote) VALUES (?, ?, ?, ?)`, id, by, at, said);
 11046	    this.log(id, by, "land.requested", { by, ...(said ? { quote: said } : {}) }, at);
 11047	    return { item: id, by, at, ...(said ? { quote: said } : {}), queued: true };
 11048	  }
import type { NowProject } from "../../src/now.ts";

// The Now view's fixture (t525): one project with one task per stage, read at
// 10:00 EST on 2026-11-07 (15:00 UTC), after the clocks went back on 2026-11-01.
// Tokens and times are fixed so each test names its expected values.

export const NOW = new Date("2026-11-07T15:00:00.000Z");
export const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
export const min = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
export const item = (id: string, patch: Record<string, unknown> = {}) => ({
  id, title: `Title of ${id}`, scope: [], state: "open", owner: null, workspace: null, base: null, head: null, acceptedHead: null,
  createdAt: h(30), updatedAt: h(1), lastPushAt: null, ...patch,
});
const runs = (...tokens: (number | null)[]) => tokens.map((t, i) => ({ actor: "claude-code/sonnet-5.5", startedAt: h(20 - i), costUsd: null, tokens: t }));
export const progress = (id: string, over: Record<string, unknown>, ...tok: (number | null)[]) =>
  ({ task: id, actor: "claude-code/sonnet-5.5", runner: "mac-mini", harness: "claude-code", telemetry: true, startedAt: h(3), endedAt: null, at: min(1), commands: { started: 3, completed: 3 }, current: null, last: null, childAlive: true, commits: 1, changedFiles: 1, logBytes: 10, tokens: null, costUsd: null, receivedAt: min(1), changedAt: min(2), runs: runs(...tok), ...over });

// Parts of a run's tokens, weighed input x1, cache write x1.25, cache read x0.1, output x5.
export const withParts = (p: Record<string, unknown>, parts: { input: number; cacheWrite: number; cacheRead: number; output: number }) =>
  ({ ...p, runs: (p.runs as object[]).map((r) => ({ ...r, parts })) });

export const project = (): NowProject => ({
  name: "atelier", title: "Atelier",
  items: [
    item("t1", { createdAt: h(30) }),
    item("t2"),
    item("t3", { dispatch: { to: "any", agent: "claude-code", model: "sonnet-5.5", at: min(40) } }),
    item("t4", { state: "claimed", owner: "claude-code/sonnet-5.5" }),
    item("t5", { state: "submitted", head: "a".repeat(40), owner: "codex/gpt-6-astra" }),
    item("t6", { state: "submitted", head: "b".repeat(40) }),
    item("t7", { state: "submitted", head: "c".repeat(40) }),
    item("t8", { state: "accepted", head: "d".repeat(40) }),
    item("t9", { state: "integrated", head: "e".repeat(40) }),
    item("t10", { state: "blocked", owner: "claude-code/opus-5.5", blocked: { reason: "waiting for the Cloudflare quota", by: "claude-code/opus-5.5", at: h(5), from: "claimed" } }),
    item("t11", { state: "merged", head: "f".repeat(40), createdAt: h(40) }),
    item("t12", { state: "merged", head: "9".repeat(40), createdAt: h(40) }),
    item("t13", { state: "merged", head: "8".repeat(40), createdAt: h(60) }),
  ] as never,
  // The stage each task's newest event recorded and when that run began.
  stages: {
    t1: { stage: "filed", since: h(30) }, t2: { stage: "agreed", since: h(26) }, t3: { stage: "queued", since: min(40) },
    t4: { stage: "building", since: h(3) }, t5: { stage: "built", since: min(50) }, t6: { stage: "checked", since: min(25) },
    t7: { stage: "reviewed", since: h(3) }, t8: { stage: "landable", since: min(15) }, t9: { stage: "landed", since: min(20) },
    t10: { stage: "blocked", since: h(5) },
  },
  // t8 is the developer's to land; t10 waits on the developer to unblock it.
  owner: [
    { id: "t8", title: "Title of t8", call: "land", sentence: "Land it.", href: "/p/atelier/t8", command: null, why: "ready", notices: [] },
    { id: "t10", title: "Title of t10", call: "unblock", sentence: "Unblock it.", href: "/p/atelier/t10", command: null, why: "blocked", notices: [] },
  ] as never,
  reviewRequests: [{ item: "t6", state: "claimed", claimedBy: "codex/gpt-6-astra", claimedAt: min(5) }],
  landings: {},
  progress: {
    t4: progress("t4", {}, 120_000, 80_000), t5: progress("t5", { endedAt: min(55), childAlive: false }, 50_000),
    // t11 weighs 300,000 (50,000 + 50,000 + 50,000 + 150,000); t12 weighs 800,000.
    t11: withParts(progress("t11", { endedAt: h(9) }, 400_000), { input: 50_000, cacheWrite: 40_000, cacheRead: 500_000, output: 30_000 }),
    t12: withParts(progress("t12", { endedAt: h(9) }, 900_000), { input: 100_000, cacheWrite: 80_000, cacheRead: 1_000_000, output: 100_000 }),
    t13: progress("t13", { endedAt: h(30) }, 5_000_000),
  } as never,
  events: ([
    { kind: "item.merged", itemId: "t11", at: "2026-11-07T06:30:00.000Z", actor: "owner", data: { mergeCommit: "1".repeat(40) } },
    { kind: "item.merged", itemId: "t12", at: "2026-11-07T14:00:00.000Z", actor: "owner", data: { mergeCommit: "2".repeat(40) } },
    // 04:30 UTC is 23:30 EST on the 6th: before today's Eastern day, though the 7th in UTC.
    { kind: "item.merged", itemId: "t13", at: "2026-11-07T04:30:00.000Z", actor: "owner", data: { mergeCommit: "3".repeat(40) } },
    { kind: "review.rejected", itemId: "t11", at: h(12), actor: "codex/gpt-6-astra", data: { findings: [{ file: "a", line: 1, severity: "blocking", text: "x" }, { file: "b", line: 2, severity: "blocking", text: "y" }, { file: "c", line: 3, severity: "blocking", text: "z" }, { file: "d", line: 4, severity: "follow-up", text: "w" }] } },
    { kind: "review.finding", itemId: "t11", at: h(11), actor: "owner", data: { index: 1, verdict: "fixed", review: 5 } },
    { kind: "review.finding", itemId: "t11", at: h(11), actor: "owner", data: { index: 2, verdict: "fixed", review: 5 } },
    { kind: "review.finding", itemId: "t11", at: h(11), actor: "owner", data: { index: 3, verdict: "refuted", review: 5 } },
    { kind: "review.finding", itemId: "t11", at: h(11), actor: "owner", data: { index: 4, verdict: "confirmed", review: 5 } },
    { kind: "review.approved", itemId: "t11", at: h(10), actor: "codex/gpt-6-astra", data: {} },
    { kind: "review.approved", itemId: "t12", at: h(10), actor: "claude-code/opus-5.5", data: {} },
    { kind: "item.revert_requested", itemId: "t12", at: min(30), actor: "owner", data: { itemId: "t99" } },
  ] as Omit<NowProject["events"][number], "seq">[]).map((e, i) => ({ ...e, seq: i + 1 })),
  deploys: [{ ship: "s1", head: "x", by: "owner", result: "shipped", at: "2026-11-07T07:10:00.000Z" }],
});


exec
/bin/zsh -lc "rg -n 'accept\\(|transactionSync|async accept|confirmed|postMerge' src/ledger.ts | head -45; nl -ba src/index.ts | sed -n '4770,4805p;4965,5010p'; nl -ba src/ui.ts | sed -n '105,125p;195,212p'; rg -n 'atelier land|override|refus|FormError' test/ui.spec.ts" in /Users/pavi/ai-projects/atelier
 succeeded in 0ms:
37:  projectMode, modeSwitch, modeLine, fastReceipt, assertFastModeAllowed, assertFastModeConfirmed, ownerDirection, type OwnerDirection, type FastModeConfirmation, postMergeIndependence, postMergeOwed, postMergeNotes, fixTaskFromNote, reviewNotes, openNotes, noteKey, type GoalNote, rejectedRounds, roundCapHold, FINDING_LABELS, reviewAuthorized, type FindingLabel, type ProjectMode, type FastReceipt,
129:  // Whether the post-merge review is still due (rules.ts postMergeOwed).
340:  postMerge?: PostMergePolicy | null;
801:      ...((i.postMerge === undefined ? p?.postMerge : i.postMerge) ? { postMerge: (i.postMerge === undefined ? p?.postMerge : i.postMerge)! } : {}),
1597:    this.ctx.storage.transactionSync(() => {
1632:    return this.ctx.storage.transactionSync(() => {
1888:    this.ctx.storage.transactionSync(() => {
2161:    return this.ctx.storage.transactionSync(() => {
2235:    return this.ctx.storage.transactionSync(() => {
2288:    return this.ctx.storage.transactionSync(() => {
2354:      this.ctx.storage.transactionSync(() => this.askReview(item.id, this.owner, reviewer, this.poolStanding(), false, false, undefined, offers, false, [], decision.id));
2514:    if (init.postMerge !== undefined) init = { ...init, postMerge: parsePostMerge(init.postMerge, actor, new Date().toISOString()) };
2602:    this.ctx.storage.transactionSync(() => {
2643:    this.ctx.storage.transactionSync(() => {
2677:    this.ctx.storage.transactionSync(() => {
2739:    this.ctx.storage.transactionSync(() => {
2784:    return this.ctx.storage.transactionSync(() => {
2835:      return this.ctx.storage.transactionSync(() => {
2849:      return this.ctx.storage.transactionSync(() => {
3604:    return this.ctx.storage.transactionSync(() => {
3663:      this.ctx.storage.transactionSync(() => {
3967:        dispatch: (id, agent, model, reason) => this.ctx.storage.transactionSync(() => {
4350:    this.ctx.storage.transactionSync(() => {
4759:      const { refusal } = postMergeIndependence(admissionActor(r.by, admission), contributorsOf(item).map((a) => admissionActor(a, admission)), singleFamily(policy), item.state === "merged" && this.mergedFast(item.id));
4828:    const fastFamily = fastReceiptOf ? postMergeIndependence(r.by, contributorsOf(item), singleFamily(policy), true).independence : null;
4829:    r = { ...r, ...(item.state === "merged" ? { postMerge: true } : {}), ...(fastFamily ? { independence: fastFamily } : {}), recordedBy: proved ? recordedActor : this.owner, proved, claimed, ...(tierClaim ? { tier: true } : {}), ...(topTier ? { topTier: true } : {}) };
4833:    this.log(r.itemId, r.by, r.approve ? "review.approved" : "review.rejected", { note: r.note, head: r.head, criteria: r.criteria, role: this.reviewRoleOf(item), ...(r.reviewerAdmission ? { reviewerAdmission: r.reviewerAdmission } : {}), ...(r.request !== undefined ? { request: r.request } : {}), recordedBy: r.recordedBy, ...(r.postMerge ? { postMerge: true } : {}), ...(r.independence ? { independence: r.independence } : {}), ...(claimed ? { claimed } : {}), ...(r.tier ? { tier: true } : {}), ...(r.topTier ? { topTier: true } : {}), ...(r.findings?.length ? { findings: r.findings } : {}), ...(via && r.by === this.owner ? { via } : {}) }, at, proved);
4860:    if (!r.approve && !r.postMerge && r.by !== this.owner) this.holdAtRoundCap(r.itemId, at, origin);
4866:      const blocking = postMergeNotes(item.id, { by: r.by, head: r.head, note: r.note, request: r.request, findings: r.findings, fast: !!fastReceiptOf });
4867:      if (blocking.length) this.log(item.kind === "part" && item.plan ? item.plan : item.id, ORCHESTRATOR, "goal.notes", { itemId: item.id, head: r.head, by: r.by, request: r.request, notes: blocking, postMerge: true }, at);
4888:    if (r.postMerge || r.tier || r.by === this.owner || item.state === "merged" || item.kind === "part" || item.kind === "plan") return;
5012:    this.log(id, actor, "item.blocked", { reason: text, from: item.state, ...(day ? { until: day } : {}), ...(direction ? { confirmed: "direction", ...said } : {}) }, at, proved);
5040:    const said = direction ? { confirmed: "direction", quote: direction.quote, acting: direction.acting } : {};
5219:    this.log(id, actor, "secret.cleared", { reason: text, head: item.head, flags: standing.map((f) => ({ file: f.file, line: f.line })), ...(direction ? { confirmed: "direction", ...said } : {}) }, at, proved);
5315:  // An override needs the owner's own confirmation (t371): `confirmedBy` is
5332:  accept(id: string, actor: string, expected?: string, overrideReason?: string, note?: string, confirmedBy?: OwnerFactor, availability?: ReviewerAvailability, criteria?: string, acting: string | null = null, quote?: unknown): Item {
5348:    const confirmation = overrideReason === undefined || confirmedBy || quote !== undefined ? null : confirmationAt(current, now, this.owner);
5351:    if (override) override.override.confirmedAt = confirmation?.at ?? at;
5373:    const direction = override && !confirmedBy ? ownerDirection(quote, acting, "an override of the independent review") : null;
5374:    if (override && !confirmedBy && !confirmation && !direction) {
5375:      throw new RuleError("override_unconfirmed", `an override of the independent review needs the developer's confirmation: ${overrideConfirmationHint(project.name, id)}`, 403, `only the developer can: ${overrideConfirmationHint(project.name, id)}`);
5381:      // The record says where the owner confirmed and with what factor.
5382:      const factor = confirmedBy ?? confirmation?.factor;
5386:        confirmed: confirmedBy ? "page" : direction ? "direction" : "command line", confirmedAt: override.override.confirmedAt, ...(factor ? { factor } : {}),
5422:    if (factor !== "access" && factor !== "secret") throw new RuleError("override_unconfirmed", "an override is allowed only with the developer's Access identity or the confirmation secret", 403, "only the developer can confirm an override with the Access identity or the confirmation secret");
  4770	      // against the team's published keys and the owner's email — /login too,
  4771	      // so the server token can no longer be tried, let alone
  4772	      // guessed, without Access's sign-in first (the open form the 2026-10-06
  4773	      // audit noted). Never the /api routes, which take bearer tokens the CLI
  4774	      // sends without passing Access; the sign-out form stays open. A request
  4775	      // that passes is the owner's sign-in, and starts a session (t534).
  4776	      // Access set in part, or with a value it cannot use, refuses those same
  4777	      // routes outright, naming what is wrong and no value, rather than read
  4778	      // as no Access and leave the token alone to guard them (Astra's audit
  4779	      // of 2026-10-13, finding 11). Set wholly or not at all, as before.
  4780	      const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  4781	      const accessConfigured = accessConfig(env as unknown as Record<string, string | undefined>);
  4782	      const guarded = parts[0] !== "api" && pathname !== "/logout";
  4783	      if (accessConfigured.state === "broken" && guarded) {
  4784	        return html(renderError(`This server's Cloudflare Access settings are incomplete or unusable, so the developer's pages are refused until they are fixed: ${accessConfigured.problem}`, ""), 503);
  4785	      }
  4786	      const access = accessConfigured.state === "on" ? accessConfigured.settings : null;
  4787	      if (access && guarded && !(await accessVouches(req, access))) {
  4788	        return html(renderError("This page is behind Cloudflare Access, whose sign-in this request did not carry. Sign in at the Access prompt and retry.", ""), 401);
  4789	      }
  4790	      if (pathname === "/login") {
  4791	        // Behind Access the assertion just verified is the owner's sign-in,
  4792	        // and the token form would prove nothing more (t534): /login starts
  4793	        // the session at once, or keeps the one the browser holds, and goes
  4794	        // on to Home. Never for a request from another site (accessSignIn).
  4795	        if (access) {
  4796	          if (await authorised(req, env) === "ui") return Response.redirect(new URL("/home", url).toString(), 303);
  4797	          return await accessSignIn(req, env, url, "/home", async () => new Response(null, { status: 303, headers: { location: "/home" } }));
  4798	        }
  4799	        if (req.method === "POST") {
  4800	          // A cross-site form post carries another origin and is refused. A
  4801	          // post without an Origin header did not come from a browser form,
  4802	          // so the token alone judges it, as it always has.
  4803	          const origin = req.headers.get("origin");
  4804	          if (origin !== null && origin !== url.origin) return html("Cross-origin form refused.", 403);
  4805	          const token = String((await req.formData()).get("token") ?? "");
  4965	        } catch (error) {
  4966	          const held = await noteRefusal(error);
  4967	          if (held) throw held;
  4968	          if (token?.runner && parseRuleError(error)?.status === 403) throw runnerDenied(token);
  4969	          throw error;
  4970	        }
  4971	        if (ref?.former) res.headers.set("x-atelier-project", ref.name);
  4972	        return res;
  4973	      }
  4974	      // A visitor who is not signed in is asked to sign in — but only on a
  4975	      // path the app itself serves (the front door at / is answered above). A path no page lives at answers 404,
  4976	      // never a redirect that funnels stray traffic to the sign-in page.
  4977	      // /how serves one public page at exactly that path (above); anything
  4978	      // else asked under the name is sent to sign in like the app's own
  4979	      // pages. Every path under /p/ is sent to sign in alike (below).
  4980	      if (!how) {
  4981	        if (req.headers.has("authorization")) return json({ error: "unauthorised" }, 401);
  4982	        // A path under /p/ is answered the same whether or not a project is
  4983	        // registered under the name it holds: the visitor is sent to sign in
  4984	        // either way, so a guessed name learns nothing — a 404 for the rest
  4985	        // would say which names, anonymised or private, are real.
  4986	        const projectArea = parts[0] === "p" && parts.length >= 2;
  4987	        const knownUI = parts.length === 0 || projectArea || ["home", "models", "usage", "projects", "flow", "history", "studio", "decisions", "how", "ui", "now"].includes(parts[0]);
  4988	        if (!knownUI) return html("Not found.", 404);
  4989	        // Behind Access, a page the owner opens without a session starts one
  4990	        // and is served as signed in (t534). A form post is not a sign-in:
  4991	        // it is sent to /login, as before, which starts the session there.
  4992	        if (access && (req.method === "GET" || req.method === "HEAD")) {
  4993	          return await accessSignIn(req, env, url, url.pathname + url.search, async () => withShell(env, url, await ui({ env, req, url, actor: ownerActor(env), body: null, signedIn: true, access: true }, parts).catch((err) => failed(err, req, url, pathname, env))));
  4994	        }
  4995	        return Response.redirect(new URL("/login", url).toString(), 303);
  4996	      }
  4997	      if (typeof how === "object") return how.runner ? json({ error: "runner_forbidden", detail: runnerDenied(how).message }, 403) : html("Agent tokens cannot use browser routes.", 403);
  4998	      // Every request past the check above is one Access vouched for, where
  4999	      // the server names its Access team.
  5000	      // An owner page that fails is answered with the error page in the
  5001	      // same bar, filled as every owner page is.
  5002	      return await withShell(env, url, await ui({ env, req, url, actor: ownerActor(env), body: null, signedIn: how === "ui", access: access !== null }, parts).catch((err) => failed(err, req, url, pathname, env)));
  5003	    } catch (err) {
  5004	      return failed(err, req, url, pathname, env);
  5005	    }
  5006	  },
  5007	} satisfies ExportedHandler<Env>;
  5008	
  5009	// The gate on a runner's text (round 13): a field a runner fills from an
  5010	// error, a child process or a log must be facts in the grammar
   105	// the owner's first question.
   106	const NAV: [label: string, url: string][] = [
   107	  ["Decisions", "/decisions"],
   108	  ["Now", "/now"],
   109	  ["Projects", "/home"],
   110	  ["Activity", "/studio"],
   111	];
   112	// Which row-1 item each page's `active` makes current: Home and every page in
   113	// a project's area are Projects; the Studio, Flow and History are Activity's
   114	// Now, Flow and Merges.
   115	const NAV_OF: Record<string, string> = { Decisions: "Decisions", Now: "Now", Home: "Projects", Projects: "Projects", Studio: "Activity", Flow: "Activity", History: "Activity", Activity: "Activity" };
   116	
   117	const ACCOUNT: [string, string][] = [
   118	  ["Models", "/models"],
   119	  ["Usage", "/usage"],
   120	];
   121	
   122	// What the bar needs from more than the page it is drawn on: the number
   123	// waiting on the owner (the Decisions list's count, one per task, from the
   124	// same attention the list reads), whether every project was read for it,
   125	// and the projects for the switcher with their task and waiting counts. The
   195	  const liveNote = live?.refresh
   196	    ? `<p class="meta live-note" hidden><span class="pulse" aria-hidden="true"></span>Live<span class="live-when"> · this copy is from ${e(clock(new Date().toISOString()))}; it refreshes every ${live.refresh} seconds.</span></p>`
   197	    : "";
   198	  const script = live ? `\n<script nonce="${e(live.nonce)}" src="/live.js" defer></script>` : "";
   199	  // The owner's pages stay in Night; one that sets `device` follows the
   200	  // device's scheme as the public pages do (no data-scheme pins it).
   201	  return `<!doctype html><html lang="en" data-theme="night"${own.device ? "" : ' data-scheme="night"'}><head><meta charset="utf-8">
   202	<meta name="viewport" content="width=device-width,initial-scale=1">
   203	<meta name="color-scheme" content="${own.device ? "dark light" : "dark"}">
   204	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
   205	<link rel="stylesheet" href="${FONTS}">${refreshSeconds ? `\n<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
   206	<title>${e(title)} · Atelier</title><style>${theme}\n${layout}${own.css ? `\n${own.css}` : ""}</style></head><body>
   207	<a class="skip" href="#main">Skip to content</a>
   208	<header class="owner-bar">
   209	  <div class="bar-row">
   210	    <a class="brand" href="/decisions">Atelier</a>
   211	    <nav class="bar-nav" aria-label="Atelier">${nav}</nav>
   212	    ${liveNote}
14:// A server behind Access, whose task page offers the override forms (t371).
93:it('acceptance renders only after an independent approval and passing evidence; the owner\'s approval leaves the override instead',()=>{
98: expect(own).toContain('Accept without an independent review');expect(own).toContain('action="/ui/example/t1/override"');expect(own).toContain('<textarea name="note" required rows="3" maxlength="500">');
101: expect(independent).toContain('atelier land t1 --project');expect(independent).not.toContain('Accept without an independent review');
112:  expect(html).toContain('atelier land t1 --project');
113:  expect(html.indexOf('atelier land t1')).toBeLessThan(html.indexOf('id="changes"'));
114:  // The override stays available for when no reviewer qualifies.
126:  expect(html).not.toContain('atelier land t1');
128: it('the owner\'s override is shown with its reason, apart from the reviews, and only at its head',()=>{
133:  expect(html).toContain('Review overridden');expect(html).toContain('No &lt;b&gt;other&lt;/b&gt; family is available');expect(html).toContain("the developer's override, not a review");
135:  expect(html).toContain('The developer overrode the independent review at this revision: No &lt;b&gt;other&lt;/b&gt; family is available.');expect(html).toContain('atelier land t1 --project');
141: it('an override stored before the project forbade overrides is shown as not counted, until the task merged on it',()=>{
146:  expect(html).toContain('Override not counted');expect(html).toContain('this project now forbids overrides');expect(html).not.toContain('Review overridden');
151:it('an accepted revision offers its re-acceptance under the current policy, which a merge refused after a policy change asks for',()=>{
651: expect(sheet).toContain('<p class="dec-because">Required checks passed for this revision. Run atelier land to check, review and merge it.</p>');
653: expect(sheet).toContain('atelier land t1 --project &#39;example&#39;');
654: expect(page).toContain('atelier land t1 --project &#39;example&#39;');
674:it('a protected change asks for a reviewer with the landing command, and links to the task page\'s override as a last resort',()=>{
680: expect(sheet).toContain("atelier land t1 --project &#39;example&#39;");
682: expect(renderItem(project,d,'PAVI',shown(d))).toContain("atelier land t1 --project &#39;example&#39;");
684: expect(sheet).toContain('As a last resort, <a href="/p/example/t1">record an override</a> on the task page.');
685: expect(renderItem(project,d,'PAVI',shown(d))).toContain('<details class="override-disclosure"><summary>');
686: // No override link where the task page offers no override form.
688: expect(renderInbox([],[project],'PAVI',{project,detail:forbidden,diff:shown(d)})).not.toContain('record an override');
689: expect(renderInbox([],[project],'PAVI',{project,detail:{...d,ownerFactor:null},diff:shown(d)})).not.toContain('record an override');
814: const p:ProjectRecord={...project,title:'Stand <ing>',policy:{...project.policy,...(over.approval?{approval:over.approval,eligible:['claude'],refuseOverlap:true}:{})}};
859: expect(more).toContain('<summary>1 task queued · <span class="merged-by-override">0 merges by override</span> · 1 handoff note</summary>');

exec
/bin/zsh -lc "nl -ba src/checkout-lease.ts | sed -n '25,48p'; nl -ba src/ledger.ts | sed -n '6545,6580p'; nl -ba src/index.ts | sed -n '4780,4797p;4980,5003p'; nl -ba src/ledger.ts | sed -n '4740,4795p'; nl -ba src/index.ts | sed -n '4434,4460p'" in /Users/pavi/ai-projects/atelier
 succeeded in 0ms:
    25	// A change to the checkout made outside the lease, as the next taker is told.
    26	export interface CheckoutFact { code: "checkout_moved"; was: string; now: string; since: string; detail: string; next: string }
    27	// One run of atelier ship, as it recorded itself: the head shipped, who, and
    28	// how it ended (shipped, or failed at a step or before finishing).
    29	export interface DeployRecord {
    30	  ship: string; head: string; by: string; result: "shipped" | "failed"; at: string;
    31	  step?: string; ran?: string[]; note?: string;
    32	  // A step after the deploy failed; the deploy itself shipped.
    33	  warning?: string;
    34	  // A failure no retry is left for: the one that is announced.
    35	  final?: true;
    36	}
    37	
    38	// The liveness limit: the landing lease's, so both leases lapse alike.
    39	export const CHECKOUT_LEASE_EXPIRY_MS = LANDING_LEASE_EXPIRY_MS;
    40	
    41	export function checkoutLeaseLapsed(lease: CheckoutLease, now: number): boolean {
    42	  return now - Date.parse(lease.renewedAt ?? lease.since) >= CHECKOUT_LEASE_EXPIRY_MS;
    43	}
    44	
    45	const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
    46	const short = (sha: string) => sha.slice(0, 8);
    47	
    48	// Who holds the lease, in words: "t3's landing (its merge step), owner on
  6545	      return [{ project, itemId: id, title: item.title, kind: "blocked" as const, reason: `developer action needed: ${fenceText(id, fence)}`, weight: 70 }];
  6546	    });
  6547	  }
  6548	
  6549	  mergeGeneration(): number {
  6550	    return Number(this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS generation FROM events WHERE kind = 'item.merged'`).toArray()[0].generation);
  6551	  }
  6552	
  6553	  postMergeRun(item: string): PostMergeRun | null {
  6554	    const latest = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `post-merge-item:${item}`).toArray()[0];
  6555	    const row = latest ? this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `post-merge:${latest.value}`).toArray()[0] : null;
  6556	    const run: PostMergeRun | null = row ? JSON.parse(row.value as string) : null;
  6557	    if (run) {
  6558	      const before = run.state;
  6559	      expireAttempt(run, Date.now());
  6560	      if (before !== run.state) this.savePostMerge(run, this.owner, "uncertain");
  6561	    }
  6562	    return run;
  6563	  }
  6564	
  6565	  activePostMerge(): PostMergeRun | null {
  6566	    const active = this.sql.exec(`SELECT value FROM meta WHERE key = 'post-merge-active'`).toArray()[0];
  6567	    const row = active ? this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `post-merge:${active.value}`).toArray()[0] : null;
  6568	    const run: PostMergeRun | null = row ? JSON.parse(row.value as string) : null;
  6569	    return run?.state === "complete" ? null : run;
  6570	  }
  6571	
  6572	  private assertPostMergeFree(item: string): void {
  6573	    const held = this.activePostMerge();
  6574	    if (held && !held.members.includes(item)) throw new RuleError("post_merge_blocked", `post-merge run ${held.id} for ${held.members.join(", ")} is ${held.state}; resolve it before another merge`, 409, `run atelier land ${held.members[0]} --post-merge status`);
  6575	  }
  6576	
  6577	  private savePostMerge(run: PostMergeRun, actor: string, action: string): void {
  6578	    this.ctx.storage.transactionSync(() => {
  6579	      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `post-merge:${run.id}`, JSON.stringify(run));
  6580	      for (const item of run.members) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `post-merge-item:${item}`, run.id);
  4780	      const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  4781	      const accessConfigured = accessConfig(env as unknown as Record<string, string | undefined>);
  4782	      const guarded = parts[0] !== "api" && pathname !== "/logout";
  4783	      if (accessConfigured.state === "broken" && guarded) {
  4784	        return html(renderError(`This server's Cloudflare Access settings are incomplete or unusable, so the developer's pages are refused until they are fixed: ${accessConfigured.problem}`, ""), 503);
  4785	      }
  4786	      const access = accessConfigured.state === "on" ? accessConfigured.settings : null;
  4787	      if (access && guarded && !(await accessVouches(req, access))) {
  4788	        return html(renderError("This page is behind Cloudflare Access, whose sign-in this request did not carry. Sign in at the Access prompt and retry.", ""), 401);
  4789	      }
  4790	      if (pathname === "/login") {
  4791	        // Behind Access the assertion just verified is the owner's sign-in,
  4792	        // and the token form would prove nothing more (t534): /login starts
  4793	        // the session at once, or keeps the one the browser holds, and goes
  4794	        // on to Home. Never for a request from another site (accessSignIn).
  4795	        if (access) {
  4796	          if (await authorised(req, env) === "ui") return Response.redirect(new URL("/home", url).toString(), 303);
  4797	          return await accessSignIn(req, env, url, "/home", async () => new Response(null, { status: 303, headers: { location: "/home" } }));
  4980	      if (!how) {
  4981	        if (req.headers.has("authorization")) return json({ error: "unauthorised" }, 401);
  4982	        // A path under /p/ is answered the same whether or not a project is
  4983	        // registered under the name it holds: the visitor is sent to sign in
  4984	        // either way, so a guessed name learns nothing — a 404 for the rest
  4985	        // would say which names, anonymised or private, are real.
  4986	        const projectArea = parts[0] === "p" && parts.length >= 2;
  4987	        const knownUI = parts.length === 0 || projectArea || ["home", "models", "usage", "projects", "flow", "history", "studio", "decisions", "how", "ui", "now"].includes(parts[0]);
  4988	        if (!knownUI) return html("Not found.", 404);
  4989	        // Behind Access, a page the owner opens without a session starts one
  4990	        // and is served as signed in (t534). A form post is not a sign-in:
  4991	        // it is sent to /login, as before, which starts the session there.
  4992	        if (access && (req.method === "GET" || req.method === "HEAD")) {
  4993	          return await accessSignIn(req, env, url, url.pathname + url.search, async () => withShell(env, url, await ui({ env, req, url, actor: ownerActor(env), body: null, signedIn: true, access: true }, parts).catch((err) => failed(err, req, url, pathname, env))));
  4994	        }
  4995	        return Response.redirect(new URL("/login", url).toString(), 303);
  4996	      }
  4997	      if (typeof how === "object") return how.runner ? json({ error: "runner_forbidden", detail: runnerDenied(how).message }, 403) : html("Agent tokens cannot use browser routes.", 403);
  4998	      // Every request past the check above is one Access vouched for, where
  4999	      // the server names its Access team.
  5000	      // An owner page that fails is answered with the error page in the
  5001	      // same bar, filled as every owner page is.
  5002	      return await withShell(env, url, await ui({ env, req, url, actor: ownerActor(env), body: null, signedIn: how === "ui", access: access !== null }, parts).catch((err) => failed(err, req, url, pathname, env)));
  5003	    } catch (err) {
  4740	    assertLength(r.note, NOTE_MAX, "the review note");
  4741	    if (r.findings !== undefined && !validFindings(r.findings)) {
  4742	      throw new RuleError("bad_findings", "findings must be a list of {file, line, severity, text}, severity blocking or follow-up; a label (pre-existing or unverified) is only for a follow-up", 400);
  4743	    }
  4744	    // The claim's rule applies to a review too: a harness the rule refuses
  4745	    // does not review (the stored ControlPlane roles are retired, t152).
  4746	    const policy = this.project().policy;
  4747	    const recordedActor = r.by;
  4748	    const admission = reviewerAdmission(r.by, policy);
  4749	    if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn; use atelier models admit`, 403, `only the developer can: atelier models admit ${admission.id} --project NAME --reason TEXT`);
  4750	    if (!admission?.active) assertEligible(r.by, policy, this.owner);
  4751	    // Never trust a client-supplied admission snapshot.
  4752	    r = { ...r, by: admission?.active ? admissionActor(r.by, admission) : r.by, reviewerAdmission: admission?.active ? admission : undefined };
  4753	    // Under single-family mode no other company's model reviews, however its
  4754	    // review comes (t394); the owner's own review is the owner's, not a model's.
  4755	    const foreign = sameActor(r.by, this.owner) ? null : companyRefusal(r.by, singleFamily(policy));
  4756	    if (foreign) throw new RuleError("single_family", `${foreign}: its review is not recorded; return to cross-family review with atelier init --cross-family`, 409, "only the developer can: atelier init --cross-family");
  4757	    const item = this.reviewItem(r.itemId);
  4758	    if (admission?.active) {
  4759	      const { refusal } = postMergeIndependence(admissionActor(r.by, admission), contributorsOf(item).map((a) => admissionActor(a, admission)), singleFamily(policy), item.state === "merged" && this.mergedFast(item.id));
  4760	      if (refusal) throw new RuleError("not_independent", `${r.by}: ${refusal}`, 403, `name a reviewer from another family with atelier review-request ${item.id} --reviewer H/M`);
  4761	    }
  4762	    // Without a request a CLI verdict still names the submitted head after
  4763	    // landing. Give request recovery before comparing it with the merge head.
  4764	    if (item.state === "merged" && r.request === undefined) {
  4765	      this.expireReviewClaims();
  4766	      const live = this.sql.exec(`SELECT id, criteria, claimedBy FROM review_requests WHERE item = ? AND head = ? AND state = 'claimed' ORDER BY id`, item.id, item.head!).toArray()
  4767	        .find((c) => typeof c.claimedBy === "string" && sameActor(c.claimedBy, r.by));
  4768	      if (live) throw new RuleError("stale_request", "a post-merge verdict must answer the review request this reviewer claimed", 409, `run atelier review ${item.id} --head ${item.head} --request ${live.id} --criteria ${live.criteria} --${r.approve ? "approve" : "reject"} --note "…" --as ${r.by}`);
  4769	      throw new RuleError("closed", `${item.id} is merged; a review must answer a claimed post-merge review request`, 409, `run ${this.reviewRecoveryCommand(item.id, r.by)}, then give the verdict using the command the claim prints`);
  4770	    }
  4771	    assertReviewAllowed(item, proved);
  4772	    if (item.state !== "accepted" && item.state !== "merged") assertLive(item);
  4773	    else if (this.landing(item.id)) throw new RuleError("landing", "cancel the interrupted landing before reviewing again", 409, `run atelier merge ${item.id} --cancel`);
  4774	    // The holder under another letter case, profile or registered name is still the holder.
  4775	    if (item.owner && sameActor(item.owner, r.by)) throw new RuleError("self_review", "a holder cannot review their own item", 403, `ask another model to review ${item.id}: atelier review-request ${item.id} --reviewer H/M`);
  4776	    if (r.head !== item.head) throw new RuleError("stale_head", "review is for an older head", 409, `run atelier show ${item.id}, then review the current head`);
  4777	    // The review is bound to the criteria the reviewer was given, as it names
  4778	    // them; one that names none, or criteria the task no longer has, is
  4779	    // refused here, before anything is recorded or any request answered.
  4780	    assertCriteria(item, r.criteria);
  4781	    const at = new Date().toISOString();
  4782	    // Who recorded it: the reviewer when its own token proved it, the project
  4783	    // owner when the owner token named it. A review answering a request the
  4784	    // reviewer claimed at this head, for these criteria, was served through
  4785	    // the request flow, which the gate counts even when the owner token
  4786	    // recorded it. A claim the criteria change withdrew is not live, so a
  4787	    // verdict on it never answers the request that replaced it.
  4788	    this.expireReviewClaims();
  4789	    const claims = this.sql.exec(`SELECT id, claimedBy, tier, topTier FROM review_requests WHERE item = ? AND head = ? AND state = 'claimed' AND criteria = ?`, r.itemId, r.head, r.criteria!).toArray()
  4790	      .filter((c) => typeof c.claimedBy === "string" && sameActor(c.claimedBy, r.by));
  4791	    // A reviewer that names the request it claimed answers that one only:
  4792	    // when it is no longer its live claim, the verdict is for a request that
  4793	    // was withdrawn or replaced, and is refused.
  4794	    const hadClaim = this.sql.exec(`SELECT claimedBy FROM review_requests WHERE item = ? AND head = ? AND claimedBy IS NOT NULL`, r.itemId, r.head).toArray()
  4795	      .some((c) => sameActor(c.claimedBy as string, r.by));
  4434	async function homePage(c: Ctx): Promise<Response> {
  4435	  const { env } = c;
  4436	  const now = new Date();
  4437	  const { views, attention } = await ownerViews(env, now);
  4438	  const home: HomeView[] = await Promise.all(views.map(async (v, i) => {
  4439	    if (v.unavailable) return v;
  4440	    // The moves not read are said on the card, and what waits on the owner
  4441	    // from the tasks read still shows.
  4442	    const waiting = attention[i];
  4443	    try {
  4444	      const events = (await ledgerOf(env, v.project).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
  4445	      return { ...v, events, cut: events.length >= STORY_EVENTS, waiting };
  4446	    } catch { return { ...v, eventsUnread: true, waiting }; }
  4447	  }));
  4448	  return html(renderHome(home, ownerName(env), now, ownerActor(env)));
  4449	}
  4450	
  4451	// Home and History read each project's recent record: the cards count the
  4452	// last two weeks of moves from it, and the timeline finds who held each task
  4453	// when it merged.
  4454	async function withEvents(env: Env, views: ProjectView[]): Promise<ProjectView[]> {
  4455	  return Promise.all(views.map(async (v) => {
  4456	    if (v.unavailable) return v;
  4457	    try {
  4458	      const events = (await ledgerOf(env, v.project).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
  4459	      return { ...v, events, cut: events.length >= STORY_EVENTS };
  4460	    } catch { return { ...v, unavailable: true }; }

exec
/bin/zsh -lc "nl -ba src/ledger.ts | sed -n '7908,7972p'; nl -ba test/ui.spec.ts | sed -n '101,116p'; rg -n 'land.requested|post.merge|postMerge' src/now.ts src/ledger.ts | tail -20; nl -ba src/index.ts | sed -n '350,362p'" in /Users/pavi/ai-projects/atelier
 succeeded in 0ms:
  7908	  async jobBrief(id: string, actor: string): Promise<{ job: "plan" | "build" | "rework"; text: string; hash: string; proseStandard: string | null; latestVerdict?: "approve" | "reject" | null; history?: HistoryRead; checkLimits?: CheckLimits }> {
  7909	    const item = this.item(id);
  7910	    if (item.kind !== "plan" && item.kind !== "part") {
  7911	      // An ordinary task's runner writes its own brief; the server adds only
  7912	      // what it alone holds: for a task sent back to a runner, the latest
  7913	      // rejecting review at its head, with its findings. Anyone but the
  7914	      // holder is told there is no brief, as before.
  7915	      if (item.owner !== actor || item.state !== "claimed") {
  7916	        throw new RuleError("not_a_plan", `${id} is not a plan or a part of one; its runner writes its own brief`, 404, "run atelier show ID");
  7917	      }
  7918	      assertOwner(item, actor);
  7919	      const rejection = this.reviewsFor(id).filter((r) => !r.approve && r.head === item.head).at(-1) ?? null;
  7920	      // A blocking pre-review at this head (t524) sends its findings the same
  7921	      // way, beside a gate rejection's, each under its own reviewer: the
  7922	      // pre-review's are what fenced the landing, so neither hides the other.
  7923	      const sections = [this.prereviewFindings(id, item.head), rejection ? reviewFindings(rejection) : null].filter((f): f is ReviewFindings => f !== null);
  7924	      // What the criteria reviewers found and how the owner answered (t438),
  7925	      // so the builder reads the criteria as they were questioned.
  7926	      const criteria = this.criteriaBriefSection(id);
  7927	      // The project's prose standard (t675), which the runner's own brief
  7928	      // cannot know: the server holds the policy.
  7929	      const prose = proseStandardLine(this.project().policy.proseStandard);
  7930	      // A blocking finding on a file the scope lacks cannot be fixed from this
  7931	      // workspace (t270); the brief says so and names the edit that adds it.
  7932	      const gap = reviewScopeGap(item, this.reviewsFor(id));
  7933	      const scopeNote = gap ? `## The scope lacks a file a finding names\n\n${scopeGapText(item, gap)}` : "";
  7934	      const text = [...sections.map((f) => findingsSection(f)), scopeNote, criteria, prose].filter(Boolean).join("\n\n");
  7935	      // Past findings on the files in scope (t14), beside the text: the
  7936	      // runner alone can tell which of those files exist at the commit its
  7937	      // build starts from, so it filters and renders them. A field an older
  7938	      // runner does not read changes nothing for it.
  7939	      // The project's check limit (G7), which the runner's brief gives the
  7940	      // builder as its suite's budget, counted from the held test slot.
  7941	      // The latest review's verdict at this head, which job does not say: a
  7942	      // rejection a later approval superseded still makes job "rework" (t548).
  7943	      const latest = this.reviewsFor(id).filter((r) => r.head === item.head).at(-1) ?? null;
  7944	      return { job: sections.length ? "rework" : "build", latestVerdict: latest ? (latest.approve ? "approve" : "reject") : null, text, hash: await sha256(text), proseStandard: this.project().policy.proseStandard ?? null, history: this.pastFindings(item), checkLimits: checkLimits(this.project().policy) };
  7945	    }
  7946	    assertOwner(item, actor);
  7947	    const project = this.project();
  7948	    if (item.kind === "plan") {
  7949	      const record = this.planRecord(id);
  7950	      const { failed, lastErrors } = plannerAttempts(this.events(id));
  7951	      const revised = this.events(id).find((e) => e.kind === "plan.revised");
  7952	      const note = revised && typeof revised.data.note === "string" && revised.data.note ? revised.data.note : null;
  7953	      return {
  7954	        job: "plan",
  7955	        ...await plannerBrief({
  7956	          item: { id, project: project.name }, goal: record.goal, scope: record.scope,
  7957	          actor: record.planner, attempt: failed + 1, note, errors: lastErrors,
  7958	          proseStandard: project.policy.proseStandard ?? null,
  7959	        }),
  7960	        proseStandard: project.policy.proseStandard ?? null,
  7961	      };
  7962	    }
  7963	    const planId = item.plan!;
  7964	    const record = this.planRecord(planId);
  7965	    const approval = record.approval;
  7966	    if (!approval) throw new RuleError("no_approval", `${id} is a part of ${planId}, which has no approved plan`, 409, `run atelier plan show ${planId}`);
  7967	    const document = planWithAdded(this.approvedPlan(planId, approval.hash), record);
  7968	    const spec = document.parts.find((p) => p.key === item.partKey);
  7969	    if (!spec) throw new RuleError("no_proposal", `${id}'s key ${item.partKey} is not in ${planId}'s approved plan`, 500);
  7970	    const parts = this.planParts(planId);
  7971	    const landed = new Map(parts.map((p) => [p.partKey!, p]));
  7972	    const dependencies: Dependency[] = (item.deps ?? []).flatMap((key) => {
   101	 expect(independent).toContain('atelier land t1 --project');expect(independent).not.toContain('Accept without an independent review');
   102	 d.evidence[0].passed=false;expect(renderItem(project,d,'PAVI',diff)).not.toContain('Accept revision');
   103	});
   104	it('while the gate waits for the independent review, asking a reviewer is the primary action and the owner\'s Approve is secondary',()=>{
   105	  const diff={head,base:'b'.repeat(40),files:[],truncated:false};
   106	  const html=renderItem(project,detail(),'PAVI',diff);
   107	  // The owner's approval cannot satisfy the gate, so its button is not the primary one.
   108	  expect(html).not.toContain('<button class="primary">Approve revision</button>');
   109	  expect(html).toContain('<button>Approve revision</button>');
   110	  // The primary action is the move that settles it: the landing that requests the review and waits, above the diff.
   111	  expect(html).toContain('ask a model of another family to review the revision');
   112	  expect(html).toContain('atelier land t1 --project');
   113	  expect(html.indexOf('atelier land t1')).toBeLessThan(html.indexOf('id="changes"'));
   114	  // The override stays available for when no reviewer qualifies.
   115	  expect(html).toContain('Accept without an independent review');
   116	});
src/ledger.ts:7301:      // post-merge review is asked below and may be same-family (t331).
src/ledger.ts:7323:  // post-merge review filed, and the review requests and verdicts since the
src/ledger.ts:7359:  // review is post-merge and may come from the builder's family.
src/ledger.ts:7685:    return { item, repairs: this.repairLinks(id), ...(lastDeploy ? { lastDeploy } : {}), postMerge: this.postMergeRun(id), prereviews: this.prereviewsFor(id), prereviewFence: this.prereviewFence(id), criteria: criteriaOf(item), policy, acceptanceProtected, acceptancePolicy, acceptanceFamily, evidence, reviews, unparsable: this.unparsableFor(id), liveReview: this.liveReviewOf(item), reviewClaims: this.openReviewClaims(id), ownerActor: this.owner, gate: gate(item, policy, evidence, reviews, this.owner, { fast: this.mode().mode === "fast" }), mode: this.mode(), ...this.scopeGapOf(item, reviews), criteriaReview: this.criteriaReviewView(id), events: this.events(id), fastLanding: this.fastLandingEvents(id), defining: this.definingEvents(id), judgementEvents: this.judgementEvents(id), landing: this.landingRecord(id), notes: this.numberedNotes(id), openRequests: this.openRequests(id, offers), lapsedRequests: this.lapsedRequests(id), blockers: (item.blockedBy ?? []).map((b) => this.blockerOf(b)), progress: this.progressOf(id), landJob: this.landJobOf(id) };
src/ledger.ts:8958:  // task at its merge commit, where the post-merge review is asked, so
src/ledger.ts:9063:    const postMergeRequest = item.state === "merged" && this.sql.exec(`SELECT id FROM review_requests WHERE item = ? AND state = 'open' LIMIT 1`, itemId).toArray().length > 0;
src/ledger.ts:9064:    if (!postMergeRequest) assertNotTerminal(item);
src/ledger.ts:9123:      const { refusal } = postMergeIndependence(admissionActor(actor, admission), contributorsOf(item).map((a) => admissionActor(a, admission)), singleFamily(this.project().policy), item.state === "merged" && this.mergedFast(itemId));
src/ledger.ts:9228:      requests: [], verdicts: this.findingVerdicts(item.id), wanted, postMerge: item.state === "merged", tier, now: new Date(at), owner: this.owner,
src/ledger.ts:9374:      // A post-merge review of a task landed in fast mode may come from a
src/ledger.ts:9378:        const family = postMergeIndependence(reviewer, contributorsOf(item), singleFamily(policy), this.mergedFast(id));
src/ledger.ts:9400:        const { refusal } = postMergeIndependence(reviewer, contributorsOf(item).map((a) => admissionActor(a, admission)), singleFamily(policy), item.state === "merged" && this.mergedFast(id));
src/ledger.ts:9472:      requests: this.reviewRequests(id).filter((r) => !((r.state === "open" || r.state === "claimed") && besideMe(r.reviewer))), verdicts: this.findingVerdicts(id), wanted, postMerge: item.state === "merged", now: new Date(at), owner: this.owner,
src/ledger.ts:9543:    this.log(id, actor, "review.requested", { head: need.head, reviewer: chosen, round: need.round, role: this.reviewRoleOf(item, null, need.changedPaths), via: item.state === "merged" ? "post-merge" : "land", ...(standingDecision ? { standingDecision } : {}), ...(choiceReason ? { reason: choiceReason } : {}), ...(wanted ? { wanted: true } : {}) }, at, proved);
src/ledger.ts:9565:        const family = item.state === "merged" ? postMergeIndependence(actor, contributors, single, this.mergedFast(item.id)).refusal : independenceRefusal(actor, contributors, single);
src/ledger.ts:11041:      this.log(id, by, "land.requested", { by, requeued: true, failedStep: stopped.failedStep, attempt: stopped.attempt, ...(said ? { quote: said } : {}) }, at);
src/ledger.ts:11046:    this.log(id, by, "land.requested", { by, ...(said ? { quote: said } : {}) }, at);
src/ledger.ts:11100:  // with no post-merge work left, is dropped here.
src/ledger.ts:11107:      // A merged task keeps its job while its post-merge run is open: the
src/ledger.ts:11111:      const run = item.state === "merged" ? this.postMergeRun(item.id) : null;
   350	// up there. The server enforces the expiry, so a copied cookie stops working
   351	// when the session ends whatever the browser kept, and logout deletes the row,
   352	// which ends the session at once. A stored session rather than a signed
   353	// cookie because revocation needs server state in any case, and a random id
   354	// then needs no signing key: nothing to set beyond ATELIER_TOKEN, and nothing
   355	// derivable from it. The lookup costs one Durable Object read per browser
   356	// request, as an agent token costs per API request.
   357	const SESSION_SECONDS = 30 * 24 * 60 * 60;
   358	const COOKIE = /(?:^|;\s*)atelier=([a-f0-9]{64})/;
   359	const cookieFlags = "Path=/; HttpOnly; Secure; SameSite=Strict";
   360	
   361	async function startSession(env: Env, now: number): Promise<string> {
   362	  const id = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

codex
I found two concrete conflicts: the task-page tests require command text that the new task-page brief removes, and the bearer-token criterion requires 403 where the Access entry guard returns 401. The criteria also omit tests for the decided builder-answer delivery and queued-head checks.
codex
- **M1 — Today’s read contract cannot supply its figures.** `nowViewOf` reads a 48-hour event window and returns only `buildNow(...)` plus `unread` ([src/index.ts:4494](/Users/pavi/ai-projects/atelier/src/index.ts:4494), [src/index.ts:4511](/Users/pavi/ai-projects/atelier/src/index.ts:4511)). `NowView` contains neither raw deploys nor project events ([src/now.ts:91](/Users/pavi/ai-projects/atelier/src/now.ts:91)). It cannot supply Home’s 14-day pulse “as is” with “no new ledger reads.” **Smallest fix:** explicitly allow a shared reader that exposes the required inputs and reads the pulse window, preserving `/api/now`’s response.

- **M1 — Deploys today can be undercounted.** The proposed source is the latest 50 records, not all records from today; the ledger applies a SQL limit ([src/ledger.ts:5994](/Users/pavi/ai-projects/atelier/src/ledger.ts:5994)). **Smallest fix:** count/filter the complete Eastern-day event window, and test a day exceeding the current limit.

- **M5 / task d — The authentication criterion contradicts the entry guard.** A bearer-token POST without Access receives **401** before `ownerPageAct` runs ([src/index.ts:4787](/Users/pavi/ai-projects/atelier/src/index.ts:4787)); the criterion demands 403. **Smallest fix:** require 401 for missing Access, and separately test 403 for a bearer-authenticated request carrying valid Access but lacking the owner session.

- **M5, Answer — Page direction cannot currently lift a review-round-cap block.** `Ledger.unblock` requires `direction.acting` for that block, while `pageDirection` deliberately has no acting model ([src/ledger.ts:5031](/Users/pavi/ai-projects/atelier/src/ledger.ts:5031)). It also hardcodes `confirmed: "direction"` ([src/ledger.ts:5041](/Users/pavi/ai-projects/atelier/src/ledger.ts:5041)). **Smallest fix:** specify a ledger-supported page-direction variant, including the round-cap authorization and recorded fields; test Answer on that block.

- **M5, stale-page protection — The check and mutation are separate.** The page reads and validates the item before subsequent RPCs ([src/index.ts:4250](/Users/pavi/ai-projects/atelier/src/index.ts:4250)); `requestLand` and `unblock` accept no expected criteria or revision ([src/ledger.ts:11026](/Users/pavi/ai-projects/atelier/src/ledger.ts:11026), [src/ledger.ts:5027](/Users/pavi/ai-projects/atelier/src/ledger.ts:5027)). A change between guard and mutation escapes the stated protection. **Smallest fix:** pass expected head and criteria into the ledger mutation and validate there; test an intervening change.

- **M5, crash / timeout — A failed response does not prove an unchanged record.** A mutation may commit before the response is lost. Land also treats a later request after failure as an explicit requeue ([src/ledger.ts:11035](/Users/pavi/ai-projects/atelier/src/ledger.ts:11035)), so replaying an uncertain POST can start another attempt. **Smallest fix:** specify an unknown-outcome state, reload reconciliation, and how a transport retry differs from an intentional retry; test response loss after commit.

- **Task a — The chosen visual result is untested.** The brief requires matching `shots/a-home-*.png`, but its criteria test content, data, redirects and speed only. **Smallest fix:** add rendered comparison against the chosen mockup, allowing the note’s explicit departures.

- **Task b — Required navigation changes lack criteria.** No criterion checks the brand destination or that `/projects` actually serves the portfolio. **Smallest fix:** add assertions for brand → `/` and an authenticated `/projects` response containing the portfolio.

- **Task c — Brief coverage and unchanged tests conflict.** No criterion verifies checklist evidence or folded history. Meanwhile, unchanged tests require the old landing command before the diff ([test/ui.spec.ts:110](/Users/pavi/ai-projects/atelier/test/ui.spec.ts:110)), contrary to the replacement action specified in M4. **Smallest fix:** preserve existing form/refusal assertions, permit updating obsolete action assertions, and add checklist and folded-history criteria.

- **Task d — Decided behavior and form placement lack criteria.** The criteria do not test that Answer reaches `jobBrief`, that the runner refuses a queued head which subsequently changes, or that all forms appear on both Today and the task page. **Smallest fix:** add those assertions explicitly and make the already-decided ledger/runner scope unconditional.

VERDICT: changes
hook: Stop
hook: Stop Completed
tokens used
57,208
- **M1 — Today’s read contract cannot supply its figures.** `nowViewOf` reads a 48-hour event window and returns only `buildNow(...)` plus `unread` ([src/index.ts:4494](/Users/pavi/ai-projects/atelier/src/index.ts:4494), [src/index.ts:4511](/Users/pavi/ai-projects/atelier/src/index.ts:4511)). `NowView` contains neither raw deploys nor project events ([src/now.ts:91](/Users/pavi/ai-projects/atelier/src/now.ts:91)). It cannot supply Home’s 14-day pulse “as is” with “no new ledger reads.” **Smallest fix:** explicitly allow a shared reader that exposes the required inputs and reads the pulse window, preserving `/api/now`’s response.

- **M1 — Deploys today can be undercounted.** The proposed source is the latest 50 records, not all records from today; the ledger applies a SQL limit ([src/ledger.ts:5994](/Users/pavi/ai-projects/atelier/src/ledger.ts:5994)). **Smallest fix:** count/filter the complete Eastern-day event window, and test a day exceeding the current limit.

- **M5 / task d — The authentication criterion contradicts the entry guard.** A bearer-token POST without Access receives **401** before `ownerPageAct` runs ([src/index.ts:4787](/Users/pavi/ai-projects/atelier/src/index.ts:4787)); the criterion demands 403. **Smallest fix:** require 401 for missing Access, and separately test 403 for a bearer-authenticated request carrying valid Access but lacking the owner session.

- **M5, Answer — Page direction cannot currently lift a review-round-cap block.** `Ledger.unblock` requires `direction.acting` for that block, while `pageDirection` deliberately has no acting model ([src/ledger.ts:5031](/Users/pavi/ai-projects/atelier/src/ledger.ts:5031)). It also hardcodes `confirmed: "direction"` ([src/ledger.ts:5041](/Users/pavi/ai-projects/atelier/src/ledger.ts:5041)). **Smallest fix:** specify a ledger-supported page-direction variant, including the round-cap authorization and recorded fields; test Answer on that block.

- **M5, stale-page protection — The check and mutation are separate.** The page reads and validates the item before subsequent RPCs ([src/index.ts:4250](/Users/pavi/ai-projects/atelier/src/index.ts:4250)); `requestLand` and `unblock` accept no expected criteria or revision ([src/ledger.ts:11026](/Users/pavi/ai-projects/atelier/src/ledger.ts:11026), [src/ledger.ts:5027](/Users/pavi/ai-projects/atelier/src/ledger.ts:5027)). A change between guard and mutation escapes the stated protection. **Smallest fix:** pass expected head and criteria into the ledger mutation and validate there; test an intervening change.

- **M5, crash / timeout — A failed response does not prove an unchanged record.** A mutation may commit before the response is lost. Land also treats a later request after failure as an explicit requeue ([src/ledger.ts:11035](/Users/pavi/ai-projects/atelier/src/ledger.ts:11035)), so replaying an uncertain POST can start another attempt. **Smallest fix:** specify an unknown-outcome state, reload reconciliation, and how a transport retry differs from an intentional retry; test response loss after commit.

- **Task a — The chosen visual result is untested.** The brief requires matching `shots/a-home-*.png`, but its criteria test content, data, redirects and speed only. **Smallest fix:** add rendered comparison against the chosen mockup, allowing the note’s explicit departures.

- **Task b — Required navigation changes lack criteria.** No criterion checks the brand destination or that `/projects` actually serves the portfolio. **Smallest fix:** add assertions for brand → `/` and an authenticated `/projects` response containing the portfolio.

- **Task c — Brief coverage and unchanged tests conflict.** No criterion verifies checklist evidence or folded history. Meanwhile, unchanged tests require the old landing command before the diff ([test/ui.spec.ts:110](/Users/pavi/ai-projects/atelier/test/ui.spec.ts:110)), contrary to the replacement action specified in M4. **Smallest fix:** preserve existing form/refusal assertions, permit updating obsolete action assertions, and add checklist and folded-history criteria.

- **Task d — Decided behavior and form placement lack criteria.** The criteria do not test that Answer reaches `jobBrief`, that the runner refuses a queued head which subsequently changes, or that all forms appear on both Today and the task page. **Smallest fix:** add those assertions explicitly and make the already-decided ledger/runner scope unconditional.

VERDICT: changes
