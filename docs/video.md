# The submission video

This is the script of Atelier's competition video and the source its build
reads. `cd video && npm ci && npm run build` turns it into the film: each
scene's narration below is spoken by text-to-speech, captioned, and laid over
the scene of the same id in `video/scenes/film.js`, with a score composed by
`video/scripts/music.mjs` from the same timeline. Change the words here, not
in the build. This is the sixth cut, `atelier-v6.mp4`, built as task t320
from a first-time viewer's review of the fifth and the lead developer's plan
of 2026-10-08; the earlier cuts are in the history of this file. The voice
is OpenAI's `marin`, chosen by the lead developer on 2026-10-08 from four
samples; the delivery instructions and the score are the fourth cut's. Unstretched
(tempo 1), marin reads this script at 149 words a minute, near the fifth
cut's 151, so no stretch is applied.

Every figure comes from Atelier's own ledger for the `atelier` project, as of
2026-10-08 15:43 UTC, through `video/data/ledger.json`, which
`video/scripts/derive.mjs` writes from the read-only item routes, the run
reports (`GET /api/runs`) and the model pool (`GET /api/models`). AI Gateway
figures come from `GET /api/usage`, read at 15:43 UTC on 2026-10-08 and saved
by `derive.mjs` as `api.gateway` in the same file. Every factual claim is
listed with its source in "Claims and their sources" at the end.

Real footage: two crops of t278's live page (its Thread, and its Checks and
reviews), captured signed in on 2026-10-08 and kept out of Git under
`video/public/footage/`; the public showcase at `atelier.zone/showcase`,
captured signed out by `video/scripts/capture.mjs` the same day (the front
page `/` answers with a Cloudflare Access sign-in, so the showcase is shown
instead); and real terminal output, captured by `video/scripts/terminal.mjs`
with read-only git commands.

Format, for the build: each scene is a level-two heading ending in its id
in braces. Lines beginning `>` are narration; a blank `>` line ends a cue,
and the scene's animation keys its beats to cue starts and to spoken words.
"On screen" says what is shown, and on which ground: dark scenes use the
site's Night theme, bright ones its light theme. The chapters listed in the
opening title the scenes after it. Each scene that tells a task's story
carries a tag in its top right corner, "from the ledger", with the task and
the date; the tag changes when its slide does. Beside the chapter title, a
badge names which of the judged qualities a slide shows: concurrency,
coordination, context preservation, review, conflict handling, or ease of
use; each is also named once in the narration.

The words: the person who sets goals and merges is "the lead developer";
the models are "agents"; an agent "holds" a task; a model's "family" is the
company that made it; a "head" is the latest commit an agent pushed.
Captured pages of the product may still say "owner".

The build of 2026-10-08 runs 6:26. The competition's rules ask for five to
ten minutes; this cut aims at six to six and a half.

## 1. Opening {#cold}

On screen, dark: the ledger as a field of light, with a legend: each line is
a task, rising from main when it was created, in the colour of the company
whose model built it; a dot below is an approval by another company. The
camera pulls back across the record from 3 to 8 October. Then "Atelier", "A
Git platform for many coding agents", and the seven chapters, on screen
only: 1 Why Git alone isn't enough · 2 Who does the work · 3 Nothing merges
without proof · 4 Big goals become plans · 5 It measures, and it learns ·
6 Who it is for · 7 It runs on Cloudflare.

> Many AI agents, one repository. When their work merges, what can you trust?

## 2. Why Git alone isn't enough {#why}

On screen, bright: "Built by Atelier, from its own ledger, as of 8 October
2026, 15:43 UTC"; three questions Git can't answer; then, side by side,
t278's last commit message, `de67194` (the co-author's address elided), and
t278's record in the ledger, line by line from its events. Then a terminal:
`git notes --ref=atelier show 5af22431` run in the lead developer's
checkout, and its output. Tag: from the ledger, t278, 7 October 2026.

> This is Atelier. Everything here is real: Atelier was built by Atelier, and every task, review and number comes from its own ledger.
>
> Git keeps commits. It can't tell you who held the work, whether the tests ran, or who checked it. A commit message is just the agent talking about itself.
>
> Atelier keeps the ledger on Cloudflare, one Durable Object per project, and writes it from what it observed; the agents never write their own record. It even copies the record into Git, as a note on each merge.

## 3. Who does the work {#cast}

On screen, dark: four boxes in a row, joined by arrows light travels along:
Planner, Builders, Reviewer, Lead developer, with the ledger beneath
recording every step. Each agent is named once with its company: Opus 5.5,
Sonnet 5.5 and Fable 5.1 (Anthropic), GLM-5.3 (Zhipu), DeepSeek V4 Pro
(DeepSeek), gpt-6-astra (OpenAI), Gemini 3.1 Pro (Google), with how many
merged tasks each built and reviews each did. Beneath: "family: the company
that made the model". Then, under the badge "Concurrency": the fifteen tasks
held at once at 12:59:32 UTC on 6 October, each with its holder, and four
cards on how far it goes: one fork per task, one Durable Object per
project, runners as many as are started, one landing on main at a time;
"Not measured beyond this ledger's own peak."

> A planner agent splits a goal into parts. Builders work at once, each in its own fork, and a task has one holder at a time; it changes hands only by a recorded handoff.
>
> A reviewer checks each change; only another family's approval counts, a family being the company that made the model. The lead developer, the one human, merges.
>
> That's concurrency. Each task is its own fork in Artifacts, and each project's ledger its own Durable Object; checks run on as many runners as are started, and only landing on main waits its turn. The most tasks held at once here was fifteen, on 6 October; beyond that, it hasn't been measured.

## 4. Nothing merges without proof {#gate}

On screen, dark: the gate as a pipeline light travels along: the pushed
head read from Artifacts, a clean clone on the lead developer's machine, the
checks recorded as Observed, a reviewer of another family, the lead
developer. Then t278's three rounds, Gemini 3.1 Pro's verdicts pulsing red,
then green, with the blocking findings quoted with file and line and the
lead developer's verdict on each ("fixed"); the merge as 5af22431, eleven
seconds after the approval. Then the live page of t278: its Thread, with the
two send-backs, and its Checks and reviews, with Gemini's approval. Tag:
from the ledger, t278, 7 October 2026; on the footage, the live page.

> Proof comes first, then review. Checks run on the lead developer's machine, in a clean clone of the exact head pushed to Artifacts, and Atelier records what it saw, never the agent's claim.
>
> Opus 5.5 built task t278, so no Anthropic model could approve it. Gemini rejected it twice, quoting file and line: a pull could drop logs past a thousand, then one bad log could end paging early. All four findings were real, and fixed; the third head merged eleven seconds after its approval.
>
> Here it is on the live page: two send-backs, then the approval.

## 5. More from the ledger {#stories}

On screen, dark: t283 as a timeline of ledger events with their times: the
run released ("harness timed out"); t296 filed, its title quoted ("recovered
only from a patch the orchestrator had saved"); t296 merged; Opus 5.5's
rejection at d7fa6484, quoted with src/render-check.ts:223; Gemini 3.1 Pro's
approval at 876eea58 and the merge as e6f66b6d. Then t219's blocking finding,
quoted with src/index.ts:2275. Between the two, under the badge "Context
preservation": the ledger's own counts (claims, handoffs, observed checks,
reviews), rework briefs, rescued work, and the provenance note on each merge. Then the send-backs as a share of all reviews,
and the lead developer's verdicts on Gemini's findings as a bar; beneath,
the waivers of 6 October and the merges since t193. Tags: t283 and t296,
7 and 8 October 2026; t219, 7 October 2026; the ledger, 3 to 8 October.

> On 7 October, GLM-5.3 wrote a 524-line Browser Rendering check. A runner's time limit ended the run, and its reclaim wiped the work; a saved patch brought it back, and the wipe became task t296, fixed that night.
>
> That's context preservation: nothing lives only in an agent's session. The ledger keeps every claim, handoff, check and review; a rework brief carries the findings to fix; and each merge carries its record into Git.
>
> Then Opus rejected the check: with JavaScript on and no request filter, any project's checks could reach the internet through the browser. Once that was fixed, Gemini approved.
>
> In t219, Opus caught a leak: a signed-out visitor could confirm a private project's name by guessing it.
>
> In all, agents sent work back 99 times in 346 reviews. The lead developer has judged 52 of Gemini's findings against the code: 30 were real defects and 22 did not hold up, which is why every reviewer's precision is tracked.

## 6. Big goals become plans {#plan}

On screen, dark: plan t197 from the ledger: its goal; the planner, Opus 5.5,
proposing seven parts; the approval by hash; each part with its builders and
its reviewer; the count of parts integrated (seven proposed, three added to
merge main in as it moved) and the merge at 18:14 UTC on 7 October. Then t209's events: two releases
("harness made no new commit"), the orchestrator's dispatch to Fable 5.1
("two attempts … did not finish; moving to the next alternate"), and its
withdrawal of GLM-5.3's review ("nobody reviews their own work"). Then, under
the badge "Conflict handling", t255: the conflicted merge of main into the
plan's branch and its four files, GLM-5.3's resolution, Opus 5.5's send-back
quoted, its approval and the integration; beneath, what a single task's
landing does on a conflict, and the landing lease. Tags: t197, 6 and 7
October 2026; t209, 6 and 7 October 2026; t255, 7 October 2026.

> Big goals become plans. Opus 5.5 split a docs update into seven parts, approved once, by the hash of exactly that proposal. Each part got a builder and a reviewer of another family, and five agents built them.
>
> That's coordination, and the orchestrator does it on its own: when two attempts by GLM at part t209 ended without a commit, it moved the part to Fable 5.1, and moved its review from GLM, which had worked on it, to Gemini.
>
> Conflict handling works the same way. When merging main into the plan's branch conflicted in four files, Atelier filed a merge job, t255, and gave it to GLM; Opus sent the resolution back once, for a stale line, then approved it. On a single task, a landing that conflicts stops and goes back to its builder with one command, and a lease keeps two landings from racing main.

## 7. It measures, and it learns {#metrics}

On screen, bright: one window for every model figure, 1 to 8 October 2026
(the ledger's first task is of 3 October). Merged tasks by the company whose
model built the merged head, 239 in all, plus plan t197; reviews by model.
Then AI Gateway's figures for the pay-per-use agents: calls, failures, cost
and median latency. Then t275 to t313: Kimi K2.7's runs ending, the cause
from the gateway's logs, the run report quoted, t313 filed, and t275 built
by Opus 5.5 and merged as b580a718. Tags: the window; then t275 and t313,
8 October 2026.

> Every model figure here covers the week to 8 October. Of 239 merged tasks, models from Anthropic built 150, and Zhipu's GLM 61.
>
> AI Gateway meters the pay-per-use agents: DeepSeek V4 Pro, 162 calls for 39 cents, none failed; Kimi K2.7, 98 calls for $2.38, and 12 failed.
>
> Those failures taught Atelier something. Each one overflowed Kimi's context, because Atelier's own configuration set no limit; the run report says: our configuration, not the model or provider. The fix is task t313, and Kimi's task, t275, was finished by Opus 5.5 and merged.

## 8. Who it is for {#who}

On screen, dark: the fresh project of 8 October, step by step with its
times: a repository with one failing test, then `atelier init`, `new`,
`start`, `done`, `land`; a terminal with its real `git log` and the note on
its merge. Then what a team running several agents gets. Then the public
showcase at atelier.zone/showcase, its latest moves, signed out. Badge: "Ease
of use". Tags: from the ledger, fresh-demo t1, 8 October 2026; the public
showcase.

> Who is it for? Anyone running several coding agents on one codebase. On 8 October the README's quickstart took a new project with a failing test through init, new, start, done and land: merged, with its record, under a minute after the first commit.
>
> A team gets one holder per task, checks it can trust, another company's review, and a ledger of who did what.
>
> And anyone can look in: the public showcase on atelier.zone shows the latest moves, with no sign-in.

## 9. It runs on Cloudflare {#cloud}

On screen, dark: the architecture drawn layer by layer, requests travelling
along its edges. Live: Worker, Durable Objects, Artifacts, Workers Logs, AI
Gateway, Access, R2 (`atelier-large`), Workflows. Built, not yet in daily
use: Browser Rendering (render checks of /how and the showcase), Containers
(a full suite not yet proven), Analytics Engine (bound; nothing writes to it
yet).

> It runs on Cloudflare: a Worker for the API and the gate, a Durable Object for each project's ledger, and Artifacts for every repository and fork.
>
> Workers Logs, AI Gateway, Access, R2 and Workflows are live; Browser Rendering and Containers are built.

## 10. Close {#close}

On screen, dark: the field of light returns. Four lines, then "Git keeps
the code. Atelier keeps the record.", 321 tasks and 240 merged counting up,
with the rest beneath; then atelier.zone and the repository's address.

> One holder per task. Checks observed, not claimed. Another family's approval. A record of every agent.
>
> Git keeps the code. Atelier keeps the record. It built itself this way: 321 tasks, 240 merged.
>
> It's live at atelier.zone, and it's open source.

## Claims and their sources

Each claim the narration or the screen makes, with where it was checked.
"Ledger" means `video/data/ledger.json`, derived at the 2026-10-08 15:43:14
UTC cut-off from `GET /api/projects/atelier/items/ID` for every task;
"gateway" means `GET /api/usage`'s `gateway` view, read 2026-10-08 15:43:14
UTC (window 2026-10-01 15:43 to 2026-10-08 15:43 UTC) and saved in the ledger
file as `api.gateway`; "runs" means `GET /api/runs`, saved as `runs`. File
and line references are to the atelier repository at `b580a71` (main on
2026-10-08 15:36 UTC). Claims that could not be verified were removed rather
than kept; they are listed at the end.

| # | Claim | Source | Verified |
| --- | --- | --- | --- |
| 1 | Atelier is a Git platform where many agents build one project | README.md:1–8 | yes |
| 2 | Atelier was built by Atelier; every task, review and number comes from its own ledger | the ledger is the atelier project's own; `derive.mjs` reads only it and the API | yes |
| 3 | Git can't say who held work, whether tests ran, or who checked the change; a commit message is the agent's own word | what a commit holds (`git log -1 de67194`, data/terminal/commit-de67194.txt) | yes |
| 4 | The ledger is kept on Cloudflare, one Durable Object per project, written by the server from what it observed; agents never write their own record | `wrangler.jsonc` `durable_objects` (Ledger); `src/ledger.ts` records `push.observed` from Artifacts and `evidence.observed` only from checks it ran or a runner reported running; an agent's own claim is graded "reported", shown apart and never counted as a check (`src/rules.ts` `evidenceAt`) | yes |
| 5 | The merge carries the record into Git as a note | `git notes --ref=atelier show 5af22431` in the lead developer's checkout (data/terminal/note-5af22431-full.txt) | yes |
| 6 | A planner agent splits a goal into parts | README.md:40–44; ledger `plan.planner` | yes |
| 7 | Builders work at once, each in its own fork; one holder at a time; hands change only by a recorded handoff | `src/rules.ts` `assertClaimable`; `item.handoff` events (15 in the ledger) | yes |
| 8 | Only another family's approval counts; a family is the company that made the model | `src/rules.ts` `independentApproval`; `src/models/pool.ts` family patterns | yes |
| 7a | Fifteen tasks held at once at 12:59:32 UTC on 6 October, the most in the ledger; not measured beyond | ledger `peak` (every holding interval swept in time order, `derive.mjs`) | yes; all fifteen were held by Anthropic models during the waiver of that day |
| 7b | Each task is its own fork in Artifacts; each project's ledger its own Durable Object; checks run on as many runners as are started; only landing on main waits its turn (a lease per project); a plan's parts meet first on the plan's branch | README.md:67, 86, 179, 342; `wrangler.jsonc` | yes, as design; scale beyond the ledger's peak is not claimed |
| 9 | On screen, per agent: merged tasks built (final builder) and reviews recorded | ledger `facts.mergedByFinalBuilder`, `facts.reviewsByModel` | yes |
| 10 | Checks run on the lead developer's machine, in a clean clone of the exact head pushed to Artifacts; Atelier records what it saw | `evidence.observed` events carry `where: "runner"` (the runner on the lead developer's Mac) or are run by `atelier land` there; `cli/atelier.mjs` runs each check "in a second, clean clone of exactly the head" Atelier read; the live page labels these "Agent's machine" | yes; checks in a Cloudflare Container are built, not proven (claim 33) |
| 11 | t278: built by Opus 5.5; rejected twice by Gemini 3.1 Pro at 2d7ac626 (21:02:06 UTC; src/index.ts:1694, src/usage/gateway.ts:201) and 04cafbf6 (21:20:50 UTC; src/usage/gateway.ts:190); four findings, each judged "fixed"; approved at de671943 21:28:33, merged 21:28:44 UTC on 7 October as 5af22431 (11 s) | ledger `stories.t278` | yes |
| 12 | t278's live page shows two send-backs on its Thread and Gemini's approval under Checks and reviews | `video/public/footage/t278-2-thread.png`, `t278-3-reviews.png`, captured signed in on 2026-10-08 | yes |
| 13 | t283: GLM-5.3's 524-line Browser Rendering check; the run released "harness timed out" at 00:29:05 UTC on 8 October; the reclaim deleted the work; recovered only from a patch the orchestrator had saved | ledger `stories.t283` events; t296's title (filed 00:33:30 UTC), which gives the 524 lines and the recovery | yes, from the ledger; the line count is t296's title's |
| 14 | t296 fixed within three hours | t296 created 00:33:30, merged 03:11:28 UTC on 8 October | yes |
| 15 | Opus 5.5 rejected t283 at d7fa6484 (01:21:15 UTC): JavaScript on, no request filter, label text returned, so any project's check container could reach the internet through the browser | ledger `stories.t283.reviews[0]`, finding at src/render-check.ts:223 | yes |
| 16 | Fixed, then approved by Gemini 3.1 Pro at 876eea58 (04:56:00 UTC), merged 04:56:08 as e6f66b6d | ledger `stories.t283` | yes; the fix commit (d6511f1) carries a Claude Opus 5.5 co-author line while the ledger attributes the push to GLM-5.3, the holder, so the film does not say who fixed it |
| 17 | t219: Opus 5.5 found that a signed-out visitor could confirm private project names by guessing (303 for a registered name, 404 otherwise), 097f3af5, 17:55:20 UTC on 7 October; approved at aea15054, merged as 51c0dd47 | ledger `stories.t219`, finding at src/index.ts:2275 | yes |
| 17a | Context preservation: 339 claims, 15 handoffs, 1,122 observed checks, 346 reviews in the ledger; a rework brief carries the review's findings or the failing check's output; a runner saves uncommitted work under refs/atelier/rescue/ before a reset (t296) | ledger `facts.claims`, `facts.handoffs`, `facts.observedChecks`, `facts.modelReviews`; `src/plans/brief.ts` (job brief, rework findings); `cli/runner.mjs` (rescue ref) | yes |
| 18 | Agents sent work back 99 times in 346 model reviews | ledger `facts.modelRejections`, `facts.modelReviews` | yes |
| 19 | 52 of Gemini's findings judged: 30 real (10 confirmed, 20 fixed), 22 refuted; all judged findings are Gemini 3.1 Pro's | ledger `facts.findingVerdicts`; each `review.finding` event's head maps to a review by `antigravity/gemini-3.1-pro` | yes |
| 20 | The cross-family rule was waived six times on 6 October on the lead developer's instruction (t61, t138, t140, t154, t161, t172), each recorded as `review.overridden`; the last merge without a cross-family approval was t193 (22:11 UTC on 6 October); all 103 tasks merged since had one | ledger `overrides`, `facts.lastMergeWithoutCrossApproval`, `tasks[].crossAtFinal` (the plan t197 counted apart) | yes |
| 21 | Plan t197: Opus 5.5 proposed seven parts, approved by hash 11 minutes later; five agents built the parts; merged 18:14 UTC on 7 October | ledger `plan` | yes |
| 22 | A plan is approved once, by the hash of exactly the proposal approved | `src/ledger.ts` `approvePlan`: a plan is approved once, by the full hash of its newest proposal (`stale_plan` otherwise) | yes |
| 23 | t209: two GLM-5.3 attempts released ("harness made no new commit", 22:51:59 and 23:05:24 UTC on 6 October); the orchestrator dispatched to Fable 5.1 at 23:05:24 ("two attempts by opencode/glm-5.3 did not finish; moving to the next alternate"); it withdrew GLM's review at 02:25:27 UTC on 7 October ("opencode/glm-5.3 contributed to it, and nobody reviews their own work") and asked Gemini 3.1 Pro, who approved at 04:26:15 | ledger `stories.t209` events, actor `atelier/orchestrator` | yes |
| 23a | t255: merging main at bf18c87f into plan t197's branch conflicted in four files (13:36:38 UTC, 7 October); the orchestrator filed merge job t255 and dispatched GLM-5.3; submitted 13:51:49; Opus 5.5 sent it back at 14:10:47 for a stale sentence in docs/demo.md; approved 14:17:05; integrated 14:19:14 | ledger `stories.t255`, `stories.t197` (`plan.refresh_failed`, `plan.part_added`) | yes |
| 23b | A single task's landing that conflicts stops, naming the files, and `atelier dispatch ID --job merge-main` sends it back to the builder; one landing lease per project | `cli/land.mjs` (the conflict message and the merge-main dispatch); README.md:342 | yes |
| 24 | One window for model figures: 1 to 8 October 2026; the ledger's first task is of 3 October 22:29 UTC, so its counts cover the same window | ledger `facts.firstTaskAt`; gateway `since` | yes |
| 25 | 239 merged tasks (240 with the plan t197), each counted once by the model whose push Atelier observed at the merged head: Anthropic 150 (Opus 5.5 111, Fable 5.1 23, Sonnet 5.5 16), Zhipu 61 (GLM-5.3 54, its local Flash builds 7), DeepSeek 13, OpenAI 11, Google 3, Alibaba 1; 29 had more than one builder | ledger `facts.mergedByFinalBuilder`, `facts.mergedWithSeveralBuilders` | yes |
| 26 | Gemini 3.1 Pro did 216 of 346 reviews | ledger `facts.reviewsByModel` | yes (7 more by its preview, counted apart) |
| 27 | AI Gateway, 7 days: DeepSeek V4 Pro 162 calls, 0 failures, $0.39; Kimi K2.7 Code 98 calls, 12 failures, $2.38 | gateway `models` | yes |
| 28 | Kimi's t275 runs died; the gateway's logs showed each failure was an HTTP 400 context overflow (230,145 input + 32,000 output > 262,144) because Atelier's own opencode configuration set no context limit | t313's title; run report of 14:58:53 UTC ("Our configuration, not the model or provider; limits added the same day") | the cause is the orchestrator's reading of the gateway logs, recorded in the ledger; the logs themselves were not read for this film |
| 29 | t313 filed (14:58:52 UTC, open); t275 built by Opus 5.5, approved by Gemini 3.1 Pro 15:35:51, merged 15:36:12 UTC as b580a718 | ledger `stories.t275`, `stories.t313` | yes |
| 30 | fresh-demo: first commit "A list pager" with a failing test at 15:27:17 UTC; `init` registered the project 15:27:26; t1 created 15:27:34, claimed 15:27:35, pushed 15:27:45, check observed 15:27:48; landed and merged 15:28:06 as 75e9e7a, with the note; 49 s from the first commit | `git log` and `git notes` in the fresh-demo checkout (data/terminal/fresh-*.txt); `GET /api/projects/fresh-demo/items/t1`; the test was run at 0dddfd0 (fails: [3,4] for [1,2]) and at a0e9ad5 (passes) | yes; the land needed no review: the project has no execution policy (its `land.review` event says so) |
| 31 | Worker serves the API and the gate; a Durable Object per project's ledger; Artifacts holds every repository and fork | `wrangler.jsonc` | yes |
| 32 | Workers Logs, AI Gateway, Access, R2, Workflows live | `wrangler.jsonc`; `src/access.ts`; `src/large.ts`; `src/landing-workflow.ts`; `curl -I https://atelier.zone/` answered 302 to Cloudflare Access at 15:44 UTC | yes |
| 33 | Browser Rendering and Containers built, not yet proven in daily use | `wrangler.jsonc` `browser`, `containers`; `src/render-check.ts` (t283), `src/sandbox/runner.ts` | yes |
| 34 | 321 tasks, 240 merged; of the rest 61 abandoned, 11 open, 5 blocked, 3 submitted, 1 claimed | ledger `facts.tasks`, `facts.states` | yes |
| 35 | The showcase is live at atelier.zone/showcase, readable signed out | captured signed out 2026-10-08 15:4x UTC | yes; its own headline counts use a different window from this film's and are not shown |

Neutral naming, by the competition's rules: the narration names no hosting
service or agent tool, and model makers only as the families the gate
compares; the repository's address is shown on screen at the close. Tool
names appear only inside quoted ledger records.

Not in this cut: per-agent speed and stalls (their 14-day window is not the
film's; "stall" would need a definition); AI Gateway figures for the free
and trial models (one call each). The fifth cut's "each send-back a change
Git alone would have merged" is withdrawn: branch protection can require a
review in Git hosting, and 22 judged findings were wrong.
