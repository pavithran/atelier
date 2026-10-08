# The submission video

This is the script of Atelier's competition video and the source its build
reads. `cd video && npm ci && npm run build` turns it into the film: each
scene's narration below is spoken by text-to-speech, captioned, and laid over
the scene of the same id in `video/scenes/film.js`, with a score composed by
`video/scripts/music.mjs` from the same timeline. Change the words here, not
in the build. This is the fifth cut, `atelier-v5.mp4`, built as task t312
from the lead developer's notes on the fourth of 2026-10-08; the earlier cuts
are in the history of this file. Voice, pace and score are the fourth cut's,
unchanged.

Every figure comes from Atelier's own ledger for the `atelier` project, as of
2026-10-08 14:50 UTC, through `video/data/ledger.json`, which
`video/scripts/derive.mjs` writes from the read-only item routes and the
model pool (`GET /api/models`). Speed, stalls and reviewer precision come
from `GET /api/reliability`, read at 14:53 UTC on 2026-10-08 and saved by
`derive.mjs` as `api` in the same file. Every factual claim is listed with
its source in "Claims and their sources" at the end.

Screens of signed-in pages (`/p/atelier/t278`, `/p/atelier/plans`) are the
fourth cut's captures of 2026-10-08 near 02:20 UTC, made by
`video/scripts/capture.mjs`. Since about 14:30 UTC that day Cloudflare
Access guards those pages, and the script's sign-in no longer reaches them,
so this cut takes no new captures of them; the Models page's figures are
drawn from the API instead. Git text is real output, captured by
`video/scripts/terminal.mjs`.

Format, for the build: each scene is a level-two heading ending in its id
in braces. Lines beginning `>` are narration; a blank `>` line ends a cue,
and the scene's animation keys its beats to cue starts and to spoken words.
"On screen" says what is shown, and on which ground: dark scenes use the
site's Night theme, bright ones its light theme. The chapters numbered in
scene 2 title the scenes after it. Each scene that tells a task's story
carries a tag in its top right corner, "from the ledger", with the task and
the date. Lengths are those of the build of 2026-10-08; the build prints
them, since they follow the spoken narration: 5:15 in all, the same as
the fourth cut.

The words: the person who sets goals and merges is "the lead developer";
the models are "agents"; an agent "holds" a task. Captured pages of the
product may still say "owner".

## 1. Cold open {#cold}

Length: 0:17.

On screen, dark: the ledger as a field of light. Every task of the atelier
project lights at the time it was created, its fork rising from main in the
colour of the family that built it, approvals by another family arcing below.
The camera pulls back across five days to the whole record.

> Many agents. One repository. How do you trust what merges?

## 2. In this video {#contents}

Length: 0:25.

On screen, dark: "Atelier", then the line "Built by Atelier · every task,
review and figure from its own ledger · as of 8 October 2026, 14:50 UTC";
then six numbered lines, each lighting as it is named: 1 Why Git alone
isn't enough · 2 Who does the work · 3 Nothing merges without proof · 4 Big
goals become plans · 5 It measures, and it learns · 6 It runs on Cloudflare.

> This is Atelier: a Git platform where many AI agents build one project. Everything here is real: Atelier was built by Atelier, and every task, review and number comes from its own ledger.
>
> Here's what's coming: why Git alone isn't enough, who does the work, how nothing merges without proof, how big goals become plans, how it measures and learns, and what it runs on.

## 3. Why Git alone isn't enough {#why}

Length: 0:34.

On screen, bright: three questions Git can't answer. Then, side by side, the
real commit message of t278's last revision, `de67194` (the co-author's
address elided), and t278's record in the ledger, line by line from its
events; beneath, the provenance note on the merge `5af22431`. Tag: from the
ledger, t278, 7 October 2026.

> Git keeps commits. But it can't tell you who holds the work, whether the tests really ran, or who checked the change.
>
> A commit message is just the agent talking about itself. Here's the last commit of task t278: a title, and a co-author line. Nothing checks either.
>
> The ledger is written by the server, from what it saw: who held the task, each head and its checks, two rejections by another family, the approval and the merge, which carries the record into Git as a note.

## 4. Who does the work {#cast}

Length: 0:42.

On screen, dark: the ledger at the centre and the roles around it, each
joined to it by a line light travels along. Agents are chips in their
family's colour; the parts of Atelier that run no model are tagged "rules, no
model". Then the t50 handoff: Fable 5.1's token struck through, GLM-5.3's
fork continuing, the handoff's note quoted. Tag: from the ledger, t50,
6 October 2026.

> A planner agent splits a goal into parts. Builder agents work at once, each in its own fork, each task held by one of them. Reviewer agents check the work, and only another family's approval counts.
>
> Atelier's own code routes each part to a builder and a reviewer, and the integrator merges parts without a model, handing any conflict to an agent. Runners on the lead developer's machines start each agent's tool; the lead developer approves and merges.
>
> A task changes hands only by a recorded handoff: when Claude's usage window closed, Fable 5.1 handed task t50 to GLM-5.3.

## 5. Nothing merges without proof {#gate}

Length: 0:47.

On screen, dark: the gate as a pipeline light travels along: the pushed
head, a clean clone, checks turning green as Observed, a reviewer of another
family, the lead developer. Then t278's three rounds, Gemini 3.1 Pro's
verdicts pulsing red, then green, with the blocking findings quoted and the
lead developer's verdict on each ("fixed"); the merge as 5af22431, eleven
seconds after the approval. Then t219's finding, quoted; the send-backs as a
share of all reviews; and the real page of t278. Tags: t278, 7 October
2026; then t219, 7 October 2026.

> Atelier runs the required checks itself, in a clean clone of the exact head, and won't accept a head it hasn't seen pass.
>
> Opus 5.5 built t278, so no Claude agent could approve it. Gemini reviewed it and rejected it twice: for logs a pull could skip, then for logs it could drop. Both were real defects, and both were fixed. The third head was approved and merged eleven seconds later: strict where it matters, no wait once the proof is in.
>
> In t219, Opus found that private project names could be guessed. Agents have sent work back 98 times, more than one review in four: each a change Git alone would have merged.

## 6. Big goals become plans {#plan}

Length: 0:29.

On screen, dark: plan t197 from the ledger: its goal; the planner, Opus 5.5,
proposing seven parts; the approval by hash; each part with its builders and
its reviewer; the integrations on the plan's branch at their real times,
the three added merge parts marked apart; the merge at 18:14 UTC on
7 October. Then the real Plans page. Tag: from the ledger, t197, 6 and
7 October 2026.

> On 6 October, the lead developer asked for the docs to match the orchestrator. Opus 5.5 proposed seven parts, approved by hash eleven minutes later.
>
> Five agents built them, each part reviewed by another family. Three more parts merged main in as it moved, so ten were integrated, and the whole plan merged at 18:14 UTC on 7 October.

## 7. It measures, and it learns {#metrics}

Length: 1:04.

On screen, bright: building and reviewing on one scale, a pair of bars per
agent; the lead developer's verdicts on review findings, 26 held up and 17
refuted, as a bar; each agent's speed and stalls over fourteen days, from
the Models page's own figures, with n and the window; what AI Gateway
records, without figures; the fleet, grouped by how each agent is paid for,
with the two tasks dispatched to local models, both merged; two tasks
Atelier filed against itself, both merged. Tags: the window of each figure;
then t296 and t298, 8 October 2026.

> Building and reviewing are counted apart: Opus 5.5 built the most, and Gemini 3.1 Pro did most of the reviews.
>
> The most honest number here: of 43 findings the lead developer judged against the code, 26 held up. Reviewers are right about six times in ten, so no finding is taken on trust, and precision is tracked.
>
> Each agent is timed too: over two weeks, Gemini's median review took under four minutes, and Opus 5.5's median build about fifteen, with one stall in 118 runs. Routing scores agents by their record in the ledger, and orders reviewers by precision. AI Gateway tracks paid calls' cost and latency.
>
> Subscription, pay-per-use and local agents all pass the same gate.
>
> When something breaks, it becomes a task. A runner lost an agent's work: that's t296. Tests failed under load: t298.

## 8. It runs on Cloudflare {#cloud}

Length: 0:27.

On screen, dark: the architecture drawn layer by layer, requests travelling
along its edges. Live: Worker, Durable Objects, Artifacts, Workers Logs, AI
Gateway, Access ("the Worker checks each Access token and the lead
developer's email"), R2 (`atelier-large`), Workflows ("t293 and t307 among
the first"). Built, not yet in daily use: Browser Rendering (render checks
of /how and the showcase), Containers (a full suite not yet proven),
Analytics Engine (bound; nothing writes to it yet).

> It all runs on Cloudflare. A Worker serves the API and the gate. Each project's ledger is a Durable Object, and Artifacts holds every repository and fork.
>
> Workers Logs, AI Gateway and Access are live, R2 holds large logs, and landings run as Workflow steps. Browser Rendering and Containers are built; Analytics Engine is bound, not yet used.

## 9. Close {#close}

Length: 0:29.

On screen, dark: the field of light returns. Five lines, one per chapter,
then "Git keeps the code. Atelier keeps the record.", 312 tasks and 236
merged counting up, with the rest beneath ("the other 76: 61 abandoned
along the way, 15 open, blocked or in flight · normal for a working
project"), atelier.zone and github.com/pavithran/atelier.

> One agent holds each task. Checks Atelier ran itself. Another model family's approval. Plans built in parallel. A record of every agent.
>
> Git keeps the code. Atelier keeps the record. It built itself this way: 312 tasks, 236 merged.
>
> It's live at atelier.zone, and open source on GitHub.

## Claims and their sources

Each claim the narration or the screen makes, with where it was checked.
"Ledger" means `video/data/ledger.json`, derived at the 2026-10-08 14:50 UTC
cut-off from `GET /api/projects/atelier/items/ID` for every task;
"reliability" means `GET /api/reliability`, read 2026-10-08 14:53 UTC and
saved in the ledger file as `api`. File and line references are to the
atelier repository at `64845a8` (main on 2026-10-08 14:30 UTC); the deployed
Worker was `3db45af` (`GET /api/version`). Claims that could not be verified
were removed rather than kept; they are listed at the end.

| # | Claim | Source | Verified |
| --- | --- | --- | --- |
| 1 | Atelier is a Git platform where many agents build one project | README.md:1–8 | yes |
| 2 | Atelier was built by Atelier; every task, review and number comes from its own ledger | the ledger is the atelier project's own; `derive.mjs` reads only it and the API | yes |
| 3 | Git can't say who holds work, whether tests ran, or who checked the change | what a commit holds (`git log -1 de67194`); README.md:16–20 | yes |
| 4 | t278's last commit: a title and a co-author line | `git log -1 de67194` (data/terminal/commit-de67194.txt) | yes |
| 5 | The ledger is written by the server from what it observed: holder, pushed heads read from Artifacts, checks at each head, two rejections, approval, merge | ledger `stories.t278`; README.md:22–35 | yes |
| 6 | The merge carries the record into Git as a note | `git notes --ref=atelier show 5af22431` (data/terminal/note-5af22431.txt) | yes |
| 7 | A planner agent splits a goal into parts | README.md:40–44; ledger `plan.planner` | yes |
| 8 | Builders work at once, each in its own fork; each task held by exactly one | `src/rules.ts` `assertClaimable`; ledger `moment` (five held at once) | yes |
| 9 | Only another family's approval counts | `src/rules.ts` `independentApproval` | yes |
| 10 | Atelier's own code routes each part to a builder and a reviewer | `src/plans/route.ts` `routeParts` | yes |
| 11 | The integrator merges without a model and hands a conflict to an agent | `cli/runner.mjs` ("It uses no model"); `src/ledger.ts` `addMergeMain` (a conflicting refresh adds a merge-main part, built by an agent) | yes |
| 12 | Runners on the lead developer's machines start each agent's tool | `cli/runner.mjs`; README.md runner section | yes |
| 13 | The lead developer approves and merges, directly or through a session acting on those decisions | README.md:45–49; `item.merged` events recorded under the owner's actor | yes |
| 14 | Fable 5.1 handed t50 to GLM-5.3 when Claude's usage window closed (6 October, 14:05 UTC); GLM-5.3 finished from the workspace | ledger `stories.t50.handoffs[0]` and its note | yes |
| 15 | Checks run by Atelier in a clean clone of the exact head; no accept without an observed pass | README.md:31–35; `src/rules.ts` `evidenceAt`, `gate` | yes |
| 16 | t278: built by Opus 5.5; rejected twice by Gemini 3.1 Pro (a capped pull advanced the mark past logs it had not fetched; a page with an unparsable log ended paging and dropped the rest); each finding judged "fixed" by the lead developer; third head approved 21:28:33, merged 21:28:44 UTC on 7 October (11 s) | ledger `stories.t278` reviews, verdicts and landing events | yes |
| 17 | t219: Opus 5.5 found private project names could be guessed (7 October, 17:55 UTC) | ledger `stories.t219` (finding at src/index.ts:2275) | yes |
| 18 | Agents sent work back 98 times, of 341 model reviews: 29 %, more than one in four | ledger `facts.modelRejections`, `facts.modelReviews` | yes |
| 19 | Each send-back was a change Git alone would have merged | Git has no review gate: a push to the branch merges whatever it holds; the 98 were rejections of pushed heads | yes, as a statement about Git |
| 20 | Plan t197: Opus 5.5 proposed seven parts; approved by hash 11 minutes later (22:11:18 to 22:22:36 UTC, 6 October) | ledger `plan` (`proposed`, `proposedAt`, `approvedAt`) | yes |
| 21 | Five agents built the ten integrated parts (Fable 5.1, GLM-5.3, Opus 5.5, gpt-6.1-sol, Gemini 3.1 Pro); four reviewed (Gemini 3.1 Pro, GLM-5.3, Fable 5.1, Opus 5.5), each of another family than its part's builders | ledger `plan.parts[].builders`, `approvedBy` | yes |
| 22 | Four merge-main parts were added as main moved (t241, abandoned; t255, t267, t269, merged), so seven proposed plus three added makes the ten integrated; merged 18:14 UTC on 7 October | ledger `plan.parts[].added`, `integratedAt`, `plan.mergedAt` | yes |
| 23 | Opus 5.5 built the most merged tasks (117); Gemini 3.1 Pro did most of the reviews (211 of 341) | ledger `facts.mergedBuilderModels`, `facts.reviewsByModel` | yes |
| 24 | 43 findings judged by the lead developer: 26 held up (10 confirmed, 16 fixed), 17 refuted; 60 %, about six in ten. All 43 are findings by Gemini 3.1 Pro, the only reviewer with judged findings | ledger `facts.findingVerdicts`; reliability `models[gemini-3.1-pro].findingsConfirmed` 26, `findingsRefuted` 17; every `review.finding` event names `antigravity/gemini-3.1-pro` | yes |
| 25 | Each reviewer's precision is tracked | `src/models/precision.ts`; the Models page (`renderModels(..., precision, ...)` in `src/index.ts`) | yes |
| 26 | Speed over 14 days (2026-09-24 14:53 to 2026-10-08 14:53 UTC), across Atelier's projects: Gemini 3.1 Pro median review 225 s (3.8 min), n 121; Opus 5.5 median build 887 s (14.8 min), n 115, 1 stall in 118 build runs; GLM-5.3 12 stalls in 109 build runs (11 %) | reliability `speed` (`src/models/speed.ts`, SPEED_DAYS 14, medians over 3 or more samples) | yes |
| 27 | Routing scores agents by their record in the ledger (observed passes, approvals and merges against failures and rejections) and orders reviewers by precision | `src/plans/route.ts` (`buildRecord` score; `byPrecision`); `src/review/reviewer.ts`, `src/review/tier.ts`; `src/ledger.ts` passes `precision` to `routeParts` | yes; speed and cross-project reliability are terms in the routing code (`pacesFor`, `input.reliability`) but the ledger's calls to `routeParts` do not yet pass them, so the narration does not claim them |
| 28 | AI Gateway records each pay-per-use call's tokens, cost and latency | `src/usage/gateway.ts`; README.md "Built on Cloudflare" | yes; no figure shown: at 14:53 UTC `GET /api/usage` reported the gateway query refused (fixed by t311, merged 14:51 UTC, not yet deployed) |
| 29 | Subscription, pay-per-use and local agents all pass the same gate; on screen, Kimi K2.7 Code among the pay-per-use (joined 8 October) | `GET /api/models` (ledger `fleet`: subscription; openrouter and deepseek, pay-per-use; ai-studio, local); `src/rules.ts` `gate` has no model-kind exception | yes |
| 30 | Two tasks dispatched to local models, both merged: t258 to qwen3.8-27b, t273 to glm-5.3-flash | ledger `localDispatches` | yes |
| 31 | t296 filed after a runner lost an agent's work; t298 after tests failed under load; both merged | ledger `selfTasks` | yes |
| 32 | A Worker serves the API and the gate; a Durable Object per project's ledger; Artifacts holds every repository and fork | `wrangler.jsonc` (`main`, `durable_objects`, `artifacts`) | yes |
| 33 | Workers Logs and AI Gateway live | `wrangler.jsonc` `observability`; `AI_GATEWAY_ID` | yes |
| 34 | Access live; the Worker checks each Access token and the lead developer's email | `src/access.ts` (issuer, audience, `CF_ACCESS_OWNER_EMAIL`); `curl -I https://atelier.zone/p/atelier` at 14:55 UTC answered 302 to `pavi.cloudflareaccess.com` | yes; the count of five Access applications is from the orchestrator and is not checkable from the code, so it is not said |
| 35 | R2 holds large logs and diffs | `wrangler.jsonc` `r2_buckets` (`atelier-large`); `src/large.ts`; t284 merged | yes |
| 36 | Landings run as durable Workflow steps | `wrangler.jsonc` `workflows`; `src/landing-workflow.ts`; docs/landing.md "Landing through a Cloudflare Workflow"; t307's and t308's titles record t293 and t307 landed with `--workflow` | yes for t293 and t307; t308, t309 and t311 are the orchestrator's word, since the ledger keeps no workflow mark once a task closes |
| 37 | Browser Rendering and Containers built | `wrangler.jsonc` `browser`, `containers`; `src/render-check.ts`, `src/sandbox/runner.ts` | yes; a full suite in a container is not yet proven, so they are called built, not live |
| 38 | Analytics Engine bound, not yet written to | `wrangler.jsonc` `analytics_engine_datasets`; `writeMetric` in `src/metrics.ts` has no caller | yes |
| 39 | 312 tasks, 236 merged; of the rest 61 abandoned, 6 open, 5 blocked, 2 claimed, 2 submitted | ledger `facts.tasks`, `facts.states` | yes |

Removed in earlier cuts as incomplete or untrue: "the integrator runs no
model" without saying who resolves a conflict (now claim 11); "every change
to Atelier needs an approval" as a statement about all merges. Not in this
cut: AI Gateway cost figures (none readable at the cut-off; claim 28); speed
as a live routing term (claim 27); the count of Access applications (claim
34). The Models page captures of the fourth cut are no longer shown: their
figures are of 02:20 UTC and the page itself can no longer be captured
behind Access.
