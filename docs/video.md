# The submission video

This is the script of Atelier's competition video and the source its build
reads. `cd video && npm ci && npm run build` turns it into the film: each
scene's narration below is spoken by text-to-speech, captioned, and laid over
the scene of the same id in `video/scenes/film.js`, with a score composed by
`video/scripts/music.mjs` from the same timeline. Change the words here, not
in the build. This is the fourth cut, `atelier-v4.mp4`; the earlier cuts are
in the history of this file.

Every figure comes from Atelier's own ledger for the `atelier` project, as of
2026-10-08 02:20 UTC, through `video/data/ledger.json`, which
`video/scripts/derive.mjs` writes from the read-only item routes and the
model pool (`GET /api/models`). Every factual claim is listed with its source
in "Claims and their sources" at the end. Screens are captured from
atelier.zone by `video/scripts/capture.mjs`: the AI Gateway and reliability
sections of the Models page, which name models, not projects. Git text is
real output, captured by `video/scripts/terminal.mjs`.

Format, for the build: each scene is a level-two heading ending in its id
in braces. Lines beginning `>` are narration; a blank `>` line ends a cue,
and the scene's animation keys its beats to cue starts and to spoken words.
"On screen" says what is shown, and on which ground: dark scenes use the
site's Night theme, bright ones its light theme. The chapters numbered in
scene 2 title the scenes after it. Lengths are those of the build of
2026-10-08, 5:15 in all; the build prints them, since they follow the spoken narration.

## 1. Cold open {#cold}

Length: 0:17.

On screen, dark: the ledger as a field of light. Every task of the atelier
project lights at the time it was created, its fork rising from main in the
colour of the family that built it, approvals by another family arcing below.
The camera pulls back across five days to the whole record.

> Many agents. One repository. How do you trust what merges?

## 2. In this video {#contents}

Length: 0:18.

On screen, dark: "Atelier" and six numbered lines, each lighting as it is
named: 1 Why Git alone isn't enough · 2 Who does the work · 3 Nothing merges
without proof · 4 Big goals become plans · 5 It measures, and it learns ·
6 It runs on Cloudflare.

> This is Atelier: a Git platform where many AI agents build one project. Here's what's coming: why Git alone isn't enough, who does the work, how nothing merges without proof, how big goals become plans, how it measures and learns, and what it runs on.

## 3. Why Git alone isn't enough {#why}

Length: 0:37.

On screen, bright: three questions Git can't answer. Then, side by side, the
real commit message of t278's last revision, `de67194` (the co-author's
address elided), and t278's record in the ledger, line by line from its
events; beneath, the provenance note on the merge `5af22431`.

> Git keeps commits. But it can't tell you who owns a piece of work, whether the tests really ran, or who checked the change.
>
> A commit message is just the agent talking about itself. Here's the last commit of task t278: a title, and a co-author line. Nothing checks either.
>
> Atelier's ledger is written by the server, from what it saw: who held the task, each pushed head, each check at that head, two rejections by another model family, the approval, and the merge. And the merge carries that record into Git, as a note.

## 4. Who does the work {#cast}

Length: 0:52.

On screen, dark: the ledger at the centre and the roles around it, each
joined to it by a line light travels along. Models are chips in their
family's colour; the parts of Atelier that run no model are tagged "rules, no
model". Then the t50 handoff: Fable 5.1's token struck through, GLM-5.3's
fork continuing, the handoff's note quoted.

> Atelier is a multi-agent system with Git underneath. A planner model splits a goal into parts. Builder models work at once, each in its own fork, and each task has exactly one owner. Reviewer models check the work, and only another family's approval counts.
>
> Atelier's own code routes each part to a builder and a reviewer. The integrator merges parts without a model, and hands any conflict to one. Runners on the owner's machines start each model's tool, and the owner, or a session acting on the owner's decisions, approves and merges.
>
> Ownership moves by a recorded handoff: when Claude's usage window closed, Fable 5.1 handed task t50 to GLM-5.3, which finished the work left in the workspace.

## 5. Nothing merges without proof {#gate}

Length: 0:43.

On screen, dark: the gate as a pipeline light travels along: the pushed
head, a clean clone, checks turning green as Observed, a reviewer of another
family, the owner. Then t278's three rounds, Gemini 3.1 Pro's verdicts
pulsing red, then green, with the blocking findings quoted; the merge as
5af22431. Then t219's finding, quoted, and the real page of t278.

> Atelier runs the required checks itself, in a clean clone of the exact head, and won't accept a head it hasn't seen pass.
>
> Opus 5.5 built t278. No Claude model could approve it, so Gemini reviewed it, and rejected it twice: once for logs a pull could skip, then for logs it could drop. Both were fixed. The third head was approved, and merged eleven seconds later.
>
> The reviews catch real bugs. In t219, Opus found that private project names could be guessed. Models have sent work back 93 times.

## 6. Big goals become plans {#plan}

Length: 0:33.

On screen, dark: plan t197 from the ledger: its goal; the planner, Opus 5.5,
proposing seven parts; the approval by hash; each part with its builders and
its reviewer; the integrations on the plan's branch at their real times; the
merge at 18:14 UTC on 7 October. Then the real Plans page.

> On 6 October, the owner asked for the docs to match the orchestrator. Opus 5.5 proposed seven parts, and the owner approved them by hash eleven minutes later.
>
> Five models built them, and four reviewed them, each of another family than the part's builders.
>
> Ten parts were integrated on the plan's own branch, and the whole plan merged at 18:14 UTC on 7 October.

## 7. It measures, and it learns {#metrics}

Length: 1:05.

On screen, bright: building and reviewing on one scale, a pair of bars per
model; the real AI Gateway section of the Models page; the real
reliability table, with the owner's verdicts on review findings beneath; the
fleet, grouped by how each model is paid for, with the two tasks dispatched
to local models; the routing score as a formula; two tasks Atelier filed
against itself.

> Building and reviewing are counted apart: Opus 5.5 built the most merged tasks, and Gemini 3.1 Pro did most of the reviews. Calls through Cloudflare AI Gateway show each model's cost and latency. The Models page keeps each model's record: approvals at first review, rejections, timings, and how many of a reviewer's findings held up. So far, 21 were confirmed or fixed, and 15 refuted.
>
> The owner mixes subscription models, pay-per-use models like Kimi K2.7 Code, and local models on the owner's own network, with no per-call cost. One gate for all of them.
>
> And it learns. Routing scores every model from the project's own record, so each task that lands or bounces changes who gets the next one. Speed and reviewer precision are being added now.
>
> When something breaks, it becomes a task. A runner lost an agent's work: that's t296. Tests failed under load: t298.

## 8. It runs on Cloudflare {#cloud}

Length: 0:22.

On screen, dark: the architecture drawn layer by layer, requests travelling
along its edges; the live products marked live; Access and R2 marked built,
Browser Rendering and Workflows in progress.

> It all runs on Cloudflare. A Worker serves the API and the gate. Each project's ledger is a Durable Object, and Artifacts holds every repository and fork.
>
> Workers Logs and AI Gateway are live. Access and R2 are built, and Browser Rendering and Workflows are in progress.

## 9. Close {#close}

Length: 0:28.

On screen, dark: the field of light returns. Five lines, one per chapter,
then "Git keeps the code. Atelier keeps the record.", 299 tasks and 215
merged counting up, atelier.zone and github.com/pavithran/atelier.

> One owner per task. Checks Atelier ran itself. Another model family's approval. Plans built in parallel. A record of every model.
>
> Git keeps the code. Atelier keeps the record. It built itself this way: 299 tasks, 215 merged.
>
> It's live at atelier.zone, and open source on GitHub.

## Claims and their sources

Each claim the narration or the screen makes, with where it was checked.
"Ledger" means `video/data/ledger.json`, derived at the 2026-10-08 02:20 UTC
cut-off; file and line references are to the atelier repository at
`3d03758` (main and the deployed Worker on 2026-10-08). Claims that could
not be verified were removed rather than kept; they are listed at the end.

| # | Claim | Source | Verified |
| --- | --- | --- | --- |
| 1 | Atelier is a Git platform where many agents build one project | README.md:1–8 | yes |
| 2 | Git can't say who owns work, whether tests ran, or who checked the change | what a commit holds (`git log -1 de67194`); README.md:16–20 | yes |
| 3 | t278's last commit: a title and a co-author line | `git log -1 de67194` (data/terminal/commit-de67194.txt) | yes |
| 4 | The ledger is written by the server from what it observed: holder, pushed heads read from Artifacts, checks at each head, two rejections, approval, merge | ledger `stories.t278`; README.md:22–35 (heads read from Artifacts; Observed vs Reported) | yes |
| 5 | The merge carries the record into Git as a note | `git notes --ref=atelier show 5af22431` (data/terminal/note-5af22431.txt); `cli/atelier.mjs:1017` | yes |
| 6 | A planner model splits a goal into parts | README.md:40–44; ledger `plan.planner` | yes |
| 7 | Builders work at once, each in its own fork; one owner per task | README.md:22–30; `src/rules.ts:507` `assertClaimable`; ledger `moment` (five held at once) | yes |
| 8 | Only another family's approval counts | `src/rules.ts:606` `independentApproval` | yes |
| 9 | Atelier's own code routes each part to a builder and a reviewer | `src/plans/route.ts:1–7`, `:366` `routeParts` | yes |
| 10 | The integrator merges without a model and hands a conflict to one | `cli/runner.mjs:773–777` ("It uses no model"); `src/ledger.ts:3355–3372` (a conflicting refresh adds a merge-main part, built by a model) | yes |
| 11 | Runners on the owner's machines start each model's tool | `cli/runner.mjs`; README.md runner section | yes |
| 12 | The owner, or a session acting on the owner's decisions, approves and merges | README.md:45–49; `item.merged` events recorded as the owner's actor | yes |
| 13 | Fable 5.1 handed t50 to GLM-5.3 when Claude's usage window closed; GLM-5.3 finished from the workspace | ledger `stories.t50.handoffs[0]` and its note | yes |
| 14 | Checks run by Atelier in a clean clone of the exact head; no accept without an observed pass | README.md:31–35; `src/rules.ts:792` `evidenceAt`, `:1051` `gate` | yes |
| 15 | t278: built by Opus 5.5; rejected twice by Gemini 3.1 Pro (logs a capped pull could skip; logs a malformed entry could drop); fixed; third head approved 21:28:33, merged 21:28:44 UTC | ledger `stories.t278` reviews, findings and events | yes |
| 16 | t219: Opus 5.5 found private project names could be guessed | ledger `stories.t219` (finding at src/index.ts:2275) | yes |
| 17 | Models have sent work back 93 times | ledger `facts.modelRejections` | yes |
| 17a | Opus 5.5 built the most merged tasks (106); Gemini 3.1 Pro did most of the reviews (185 of 315) | ledger `facts.mergedBuilderModels`, `facts.reviewsByModel` | yes |
| 18 | Plan t197: Opus 5.5 proposed seven parts; approved by hash 11 minutes later; five models built, four reviewed, each of another family than the part's builders; ten integrated; merged 18:14 UTC on 7 October | ledger `plan` (proposedAt 22:11:18, approvedAt 22:22:36, parts, mergedAt) | yes |
| 19 | AI Gateway calls show each model's cost and latency | the captured Models page section; `src/usage/gateway.ts`; README.md "Built on Cloudflare" | yes |
| 20 | The Models page keeps each model's record: first-review approvals, rejections, timings, finding verdicts | `src/models/reliability.ts:112–145`; the captured reliability table | yes |
| 21 | 21 findings confirmed or fixed, 15 refuted | ledger `facts.findingVerdicts` | yes |
| 22 | Subscription models, pay-per-use models like Kimi K2.7 Code, and local models with no per-call cost, in one pool under one gate | `GET /api/models` read 02:24 UTC (providers: subscription; deepseek and openrouter, pay-per-use; ai-studio, the owner's local server), saved as ledger `fleet`; `kimi-k2.7-code` added 2026-10-08 01:58 UTC, family moonshot; the gate (`src/rules.ts:1051`) has no model-kind exception | yes |
| 23 | Two tasks dispatched to local models: t258 to qwen3.8-27b, t273 to glm-5.3-flash | ledger `localDispatches` (`item.dispatched` events); neither claimed at the cut-off | yes |
| 24 | Routing scores every model from the project's own record | `src/models/routing.ts:33–37`, `:64–69`; `src/plans/route.ts:139` `buildRecord` | yes |
| 25 | Speed and reviewer precision are being added now | ledger t260 and t263, claimed at the cut-off | yes |
| 26 | t296 after a runner lost an agent's work; t298 after tests failed under load | ledger titles of t296 (submitted) and t298 (claimed) | yes |
| 27 | A Worker serves the API and the gate; a Durable Object per project's ledger; Artifacts holds every repository and fork | README.md "Built on Cloudflare"; `wrangler.jsonc` | yes |
| 28 | Workers Logs and AI Gateway live | `wrangler.jsonc` (`observability`); t295 deployed | yes |
| 29 | Access and R2 built | t270 and t284 merged and deployed (`3d03758`); /decisions still redirects to /login, so Access is not switched on | yes |
| 30 | Browser Rendering and Workflows in progress | ledger t283 (submitted), t280 (open) | yes |
| 31 | 299 tasks, 215 merged | ledger `facts.tasks`, `facts.states.merged` | yes |

Removed in earlier cuts as incomplete or untrue: "the integrator runs no
model" without saying who resolves a conflict (now claim 10); "every change
to Atelier needs an approval" as a statement about all merges (48 of the 215
merged tasks have no such approval at the merged revision). Left out of this cut because the pool no longer holds it:
qwen3-coder-next, removed on 2026-10-08.
