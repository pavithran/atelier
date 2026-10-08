# The submission video

This is the script of Atelier's competition video and the source its build
reads. `cd video && npm ci && npm run build` turns it into the film: each
scene's narration below is spoken by text-to-speech, captioned, and laid over
the scene of the same id in `video/scenes/film.js`, with a score composed by
`video/scripts/music.mjs` from the same timeline. Change the words here, not
in the build. This is the third cut, `atelier-v3.mp4`; the earlier cuts are
in the history of this file.

Every figure comes from Atelier's own ledger for the `atelier` project, as of
2026-10-08 01:30 UTC, through `video/data/ledger.json`, which
`video/scripts/derive.mjs` writes from the read-only item routes. Every
factual claim is listed with its source in "Claims and their sources" at the
end. Screens are captured from atelier.zone by `video/scripts/capture.mjs`:
the public `/showcase` and `/how`, the `atelier` project's own pages, and the
AI Gateway and reliability sections of the Models page, never another
project's. Terminal and Git text is real output, captured by
`video/scripts/terminal.mjs`.

Format, for the build: each scene is a level-two heading ending in its id
in braces. Lines beginning `>` are narration; a blank `>` line ends a cue,
and the scene's animation keys its beats to cue starts. "On screen" says
what is shown, and on which ground: dark scenes use the site's Night theme,
bright ones its light theme. Lengths are those of the build of 2026-10-08, 7:48 in all;
the build prints them, since they follow the spoken narration.

## 1. Cold open {#cold}

Length: 0:20.

On screen, dark: the ledger as a field of light. Every task of the atelier
project lights at the time it was created, above a main line, in the colour
of the family of the model that built it; its fork rises from main and
returns where it merged; each approval by another family arcs below the line
in the reviewer's colour. The camera pulls back across five days to the
whole record, then the title.

> Many agents. One repository. How do you trust what merges?

## 2. The cast {#cast}

Length: 1:14.

On screen, dark: the ledger at the centre; the roles enter around it one at
a time, each joined to the ledger by a line light travels along. Models are
drawn as chips in their family's colour; the parts of Atelier that run no
model are drawn in the signal colour and marked "rules, no model".

> Atelier is a multi-agent system for software work, with Git underneath. Agents in distinct roles coordinate through one ledger, and Atelier's own rules decide who does what.
>
> A planner model splits a goal into parts. Opus 5.5 planned plan t197.
>
> Builder models, many at once, each work in their own fork. Six model families have built Atelier.
>
> Reviewer models check each change, and a review counts only from another family than the builders.
>
> The orchestrator is Atelier's own code. It routes each part to a builder and a reviewer, from the model pool and each model's track record.
>
> The integrator merges approved parts onto a plan's branch, and calls no model. When a merge of main conflicts, Atelier sends the conflict to a model as a merge-main job.
>
> Runners on the owner's machines take the jobs and start each model's own tool: models by subscription, pay-per-use models through AI Gateway, and local models on the owner's own network, all under the same gate. And the owner, or a session acting on the owner's standing decisions, approves the plan and merges the result.

## 3. Why Atelier, and not Git alone {#why}

Length: 0:57.

On screen, bright: a strip of panels. Each asks one question and splits the
screen: on the left, "With Git alone", an illustration of the risk; on the
right, "With Atelier", what Atelier does, with a proof from the record
beneath it.

> Git can't say who owns the work, whether the tests really ran, or who checked the change. With many agents at once, Atelier answers each of these, on top of Git.
>
> Who owns the work? Every task has exactly one owner, with a write token for its own fork, revoked on handoff.
>
> Did the tests run? Atelier runs the required checks itself, in a clean clone of the exact head, and won't accept a head it hasn't seen pass.
>
> Who checked it? A model of another family has to approve every protected change.
>
> Is main still sound? Atelier lands one task at a time: it merges main in, runs the checks again, and merges exactly the head that was reviewed.
>
> And instead of a stream of pull requests, the owner gets an inbox of decisions, each with a recommendation.

## 4. Better than a commit message {#commit}

Length: 0:40.

On screen, bright: side by side. On the left, the real commit message of
t278's last revision, `de67194`, as Git holds it (the co-author's address
elided). On the right, t278's record in the ledger, line by line: claimed by
Opus 5.5; three pushes, each head read from Artifacts; the checks observed
at each; two rejections by Gemini 3.1 Pro with their findings; the owner's
verdict on each finding; the approval; the acceptance at de671943; the merge
as 5af22431. Beneath, the provenance note on that merge, from
`git notes --ref=atelier`.

> A commit message is what an agent writes about itself. It can claim the tests passed, name any author, and leave out what it didn't do. Nothing checks it.
>
> Here is the last commit of task t278. It says what changed, and who co-wrote it. That is all.
>
> The ledger was written by the server, from what it observed: who held the task, each pushed head, each check's result at that head, two rejections by another family with their findings, the approval, and the merge. And the merge carries that record into Git, as a note.

## 5. One owner, one fork each {#forks}

Length: 0:22.

On screen, dark: the five tasks the ledger shows held at once at 14:40 UTC on
5 October (t70 gpt-6-astra, t64 GLM-5.3 Flash, t71 Opus 5.5, t72 Sonnet 5.5,
t44 Gemini 3.1 Pro preview), forking from main with commits flowing along
each fork. Then task t50: the token passes from Fable 5.1 to GLM-5.3, the old
token struck through, the handoff's note quoted from the ledger.

> At 14:40 UTC on 5 October, five tasks were held at once, by models of four families, each in its own fork.
>
> When Claude's usage window closed, Fable 5.1 handed task t50 to GLM-5.3, which finished the fix from the work left in the workspace.

## 6. The gate {#gate}

Length: 0:38.

On screen, dark: task t278, built by Opus 5.5: three rounds, each with its
revision, its observed checks and Gemini 3.1 Pro's verdict, pulsing red on
rejection with the blocking findings quoted from the ledger, and green on
approval; accepted at 21:28:36 and merged as 5af22431 at 21:28:44 UTC. Then
the real page of t278.

> Here's the gate at work. Opus 5.5 built t278. No Claude model could approve it, so Gemini 3.1 Pro reviewed it, and rejected it: a pull that hit its page cap skipped logs, and the totals stopped at ten thousand rows.
>
> Both were fixed. Gemini rejected the next revision too: one malformed log ended the pull early. That was fixed, with a test.
>
> The third revision was approved, accepted at exactly that head, and merged eleven seconds later.

## 7. A plan {#plan}

Length: 0:38.

On screen, dark: plan t197 from the ledger: its goal; the planner, Opus 5.5,
proposing seven parts at 22:11 UTC; the owner's approval by hash at 22:22
UTC; each part with its builders and its reviewer; the integrations at their
real times on 7 October, with the merge-main parts added as main moved; the
plan merged at 18:14 UTC. Then the real Plans page.

> A larger goal becomes a plan. On 6 October, the owner asked for the docs to match the orchestrator as it runs. Opus 5.5 proposed seven parts, and the owner approved them by hash eleven minutes later.
>
> Atelier routed the parts. Five models built them, and four reviewed them, each of another family than the part's builders. As main moved, merge-main parts were added.
>
> Ten parts were integrated, and at 18:14 UTC on 7 October, the owner merged the whole plan.

## 8. The record, replayed {#replay}

Length: 0:32.

On screen, dark: a time axis from 3 to 8 October, UTC; each merged task drops
in at its merge time, a dot in its builder's family colour, ringed in the
colour of the family whose approval it carries at the merged revision; day
totals count up. The camera moves in on the evening of 6 October. Then the
real Flow page.

> Every claim, push, check, review and merge is an event in the ledger, so the project's history replays exactly. Each dot is a merged task, ringed in the colour of the family that approved it.
>
> Of the 212 merged tasks, 164 carry another family's approval at the exact revision that merged, and every task merged since 22:11 UTC on 6 October does.

## 9. What Atelier measures, and how it learns {#metrics}

Length: 1:35.

On screen, bright: first, two charts on one scale, labelled "built" and
"reviewed", a pair of bars per model, with merged tasks built per family as
the headline for building. Then the real AI Gateway section of the Models
page; then the local models: the four the pool gained on 8 October, each
with its family, the two tasks dispatched to them, and the five merged tasks
local builds worked on earlier; then the real reliability table of the Models page, with its timings
and findings columns. Then the routing score as a formula, and two tasks
from this week's ledger that Atelier filed against itself.

> Atelier measures its models. Building and reviewing are counted apart: Opus 5.5 built the most merged tasks, and Gemini 3.1 Pro did most of the reviewing.
>
> Calls sent through Cloudflare AI Gateway show each model's cost, failures and latency, read from Cloudflare's GraphQL Analytics.
>
> Local models cost nothing per call. On 8 October, four joined the pool, served on the owner's network: GLM-5.3 Flash, two Qwen models and MiniMax M3. Two tasks were dispatched to them at once. Earlier, local builds of GLM and DeepSeek worked on five merged tasks, and the same record counts them all.
>
> The Models page keeps each model's record across projects: approved at first review, rejections, timings, and the owner's verdict on each review finding. So far the owner has confirmed or marked fixed 21 findings, and refuted 15.
>
> And Atelier learns from use. Plan routing scores every model from this project's own record: each observed pass, approval and merge counts for it, each failure and rejection against it. So every task that lands or bounces changes who gets the next one. Routing by speed and by reviewer precision is being built now.
>
> Failures become tasks in the same ledger. When a runner lost an agent's work, the fix became t296. When tests failed under load, that became t298. Each goes through the same gate.

## 10. On Cloudflare {#cloud}

Length: 0:31.

On screen, dark: the architecture drawn layer by layer, with requests
travelling along its edges: the owner's machine with the CLI and a home
runner; the Worker; Durable Objects, a Ledger per project and the index;
Artifacts; Workers Logs; AI Gateway with GraphQL Analytics; all marked live.
Cloudflare Access and R2 marked "built, not yet on"; Browser Rendering and
Workflows marked "in progress".

> It all runs on Cloudflare. A Worker serves the API, the pages and the gate. Each project's ledger is a Durable Object, which handles one request at a time, so one owner per task holds. Artifacts holds the Git repositories: a baseline per project, and a fork for every task.
>
> Workers Logs and AI Gateway are live. Access and R2 are built, and Browser Rendering and Workflows are in progress.

## 11. Close {#close}

Length: 0:20.

On screen, dark: the field of light from the opening returns, whole; "Git
keeps the code. Atelier keeps the record."; the figures count up: 299 tasks,
212 merged, models of six families; then atelier.zone,
github.com/pavithran/atelier and the MIT licence; "This film is task t293 in
the same ledger."

> Git keeps the code. Atelier keeps the record. It built itself this way: 299 tasks, 212 merged, by models of six families.
>
> It's live at atelier.zone, and open source on GitHub.

## Claims and their sources

Each claim the narration or the screen makes, with where it was checked.
"Ledger" means `video/data/ledger.json`, derived at the 2026-10-08 01:30 UTC
cut-off; file and line references are to the atelier repository at
`3d03758` (main on 2026-10-08), the deployed Worker being `aba5dc9`. Every
claim below was verified; claims that could not be verified were removed
from the script rather than kept.

| # | Claim | Source | Verified |
| --- | --- | --- | --- |
| 1 | Agents in distinct roles coordinate through one ledger | README.md:16–49; `src/ledger.ts` (the `Ledger` Durable Object) | yes |
| 2 | A planner model splits a goal into parts; Opus 5.5 planned t197 | README.md:40–44; ledger `plan.planner` = claude-code/opus-5.5 | yes |
| 3 | Six model families built merged tasks (Claude, GLM, GPT, DeepSeek, Gemini, MiMo) | ledger `facts.mergedBuilderFamilies` (anthropic 146, zai 56, openai 15, deepseek 13, google 4, xiaomi 1) | yes |
| 4 | A review counts only from another family than the builders | `src/rules.ts:606` `independentApproval`; README.md:36–39 | yes |
| 5 | The orchestrator is Atelier's own code; it routes each part to a builder and a reviewer from the pool and each model's track record | `src/plans/route.ts:1–7`, `:139` (`buildRecord`), `:366` `routeParts`; `src/plans/state.ts:24` (`atelier/orchestrator`) | yes |
| 6 | The integrator merges approved parts onto the plan's branch and calls no model | `cli/runner.mjs:773–777` ("It uses no model") | yes |
| 7 | When a merge of main into a plan's branch conflicts, Atelier sends it to a model as a merge-main job | `src/ledger.ts:3355–3372` (`refreshFailed` adds a merge-main part); `cli/runner.mjs:310–323` | yes |
| 8 | Runners on the owner's machines take jobs and start each model's own tool | README.md runner section; `cli/runner.mjs` | yes |
| 9 | The owner, or a session acting on the owner's standing decisions, approves and merges | README.md:45–49; the ledger's `item.merged` events are recorded as the owner's actor (`pavi`), from sessions working under PAVI's standing decisions | yes |
| 10 | One owner per task; a write token for its fork, revoked on handoff | README.md:22–27; `src/rules.ts:507` `assertClaimable`; docs/gate.md handoff row | yes |
| 11 | Checks run by Atelier in a clean clone of the exact head; no accept without an observed pass at the head | README.md:31–35; `src/rules.ts:792` `evidenceAt`, `:1051` `gate` | yes |
| 12 | Another family must approve every protected change | README.md:36–39; `src/rules.ts:606` | yes |
| 13 | Landing: one at a time, merges main in, checks again, merges exactly the reviewed head | `src/ledger.ts:1615` `beginProjectLanding`; `cli/land.mjs:110` `runLand`, `:228`; docs/demo.md section 9 | yes |
| 14 | An inbox of decisions, each with a recommendation | README.md:50–52; real `atelier show t278` output (data/terminal/show-t278.txt) | yes |
| 15 | t278's last commit message says what changed and who co-wrote it | `git log -1 de67194` in the atelier checkout (data/terminal/commit-de67194.txt) | yes |
| 16 | t278's ledger record: holder, pushed heads, observed checks, two rejections with findings, approval, merge | ledger `stories.t278` (events and reviews) | yes |
| 17 | The merge carries the record into Git as a note | `git notes --ref=atelier show 5af22431` (data/terminal/note-5af22431.txt); `cli/atelier.mjs:1017` | yes |
| 18 | 14:40 UTC on 5 October: five tasks held at once, models of four families | ledger `moment` (t70, t64, t71, t72, t44) | yes |
| 19 | Fable 5.1 handed t50 to GLM-5.3 when Claude's usage window closed; GLM finished from the workspace | ledger `stories.t50.handoffs[0]` and its note | yes |
| 20 | t278: built by Opus 5.5; rejected twice by Gemini 3.1 Pro with the findings stated; fixed with a test; approved; accepted at that head; merged 11 s later | ledger `stories.t278` (21:02:06, 21:20:50 rejections; 21:28:33 approval; 21:28:36 accepted; 21:28:44 merged); the finding verdict "test … fails without it" | yes |
| 21 | Plan t197: goal, seven parts proposed, approved 11 minutes later by hash | ledger `plan` (proposedAt 22:11:18, approvedAt 22:22:36, hash) | yes |
| 22 | Five models built its parts and four reviewed them, each of another family than the part's builders; merge-main parts added; ten integrated; merged 18:14 UTC on 7 October | ledger `plan.parts` (builders, approvedBy, added, integratedAt), `plan.mergedAt` | yes |
| 23 | 212 merged; 164 with another family's approval at the merged revision; every task merged since 22:11 UTC on 6 October | ledger `facts.states.merged`, `facts.mergedWithCrossFamilyApprovalAtFinalHead`, `facts.lastMergeWithoutCrossApproval`, `facts.mergesSinceThenAllCross` | yes |
| 24 | Opus 5.5 built the most merged tasks; Gemini 3.1 Pro did most of the reviewing | ledger `facts.mergedBuilderModels` (opus-5.5 105), `facts.reviewsByModel` (gemini-3.1-pro 182 of 312) | yes |
| 25 | AI Gateway calls show cost, failures and latency per model, from GraphQL Analytics | README.md "Built on Cloudflare" table; `src/usage/gateway.ts`; the captured Models page section | yes |
| 26 | The Models page keeps each model's record across projects: first-review approvals, rejections, timings, the owner's finding verdicts | `src/models/reliability.ts:112–145` (`ModelReliability`); README.md:499–503; the captured reliability table | yes |
| 27 | The owner has confirmed or marked fixed 21 findings and refuted 15 | ledger `facts.findingVerdicts` (confirmed 10, fixed 11, refuted 15) | yes |
| 28 | Plan routing scores every model from this project's own record: passes, approvals, merges for; failures, rejections against | `src/models/routing.ts:33–37`, `:64–69` (±100 each); `src/plans/route.ts:139` `buildRecord` | yes |
| 29 | Routing by speed and by reviewer precision is being built now | ledger t260 and t263, both claimed at the cut-off | yes |
| 30 | t296 filed after a runner lost an agent's work; t298 after tests failed under load | ledger titles of t296 and t298 | yes |
| 31 | A Worker serves the API, the pages and the gate; a Durable Object per project, one request at a time; Artifacts with a baseline and forks | README.md "Built on Cloudflare"; `wrangler.jsonc` | yes |
| 32 | Workers Logs and AI Gateway live | `wrangler.jsonc:6` (`observability`); README.md table; t295 deployed | yes |
| 33 | Access and R2 built, not yet on | t270 merged and deployed (`aba5dc9`), and /decisions still redirects to /login, so Access is not configured; t284 merged at `3d03758`, after the deployed commit | yes |
| 34 | Browser Rendering and Workflows in progress | ledger t283 (submitted), t280 (open) | yes |
| 36 | Runners start models by subscription, pay-per-use through AI Gateway, and local models on the owner's network, under the same gate | README.md "Built on Cloudflare" (AI Gateway row); `src/models/pool.ts:64` (`LOCAL_BUILD`); `GET /api/models` (pool entries with `where: home`); the gate in `src/rules.ts:1051` names no model kind | yes |
| 37 | Four local models joined the pool on 8 October: glm-5.3-flash, qwen3-coder-next, qwen3.8-27b, minimax-m3 | `GET /api/models`, read 2026-10-08 01:55 UTC (`addedAt` 01:53 UTC, `where: home`), saved in `video/data/ledger.json` (`localPool`) | yes |
| 38 | Two tasks dispatched to them: t258 to qwen3-coder-next, t273 to glm-5.3-flash | the ledger's `item.dispatched` events, 01:54 UTC on 8 October (`localDispatches`); neither had been claimed when read, so the film says dispatched, not built | yes |
| 39 | Local builds of GLM and DeepSeek worked on five merged tasks earlier | ledger: merged tasks whose builders match `LOCAL_BUILD` (t27, t44, t64, t65, t84, on 4 and 5 October) | yes |
| 35 | 299 tasks; 212 merged; six families | ledger `facts.tasks`, `facts.states`, `facts.mergedBuilderFamilies` | yes |

Removed as unverifiable or wrong in an earlier cut: "the integrator runs no
model" without saying who resolves conflicts (made complete in claim 7);
"Every change to Atelier needs an approval" as a statement about all merges
(30 earlier merges lack one; the film states the measured 164 of 212).
