# The submission video

This is the script of Atelier's competition video and the source its build
reads. `cd video && npm ci && npm run build` turns it into the film: each
scene's narration below is spoken by text-to-speech, captioned, and laid over
the scene of the same id in `video/scenes/film.js`. Change the words here,
not in the build.

Every figure comes from Atelier's own ledger for the `atelier` project, as of
2026-10-07 23:00 UTC, through `video/data/ledger.json`, which
`video/scripts/derive.mjs` writes from the read-only item routes. The section
"Figures and their sources" at the end lists each one. Screens are captured
from atelier.zone by `video/scripts/capture.mjs`: the public `/showcase` and
`/how`, and the `atelier` project's own pages, never another project's.
Terminal text is the real output of `atelier show`, captured by
`video/scripts/terminal.mjs`, or the ledger's own events, labelled as such.

Format, for the build: each scene is a level-two heading ending in its id
in braces. Lines beginning `>` are narration; a blank `>` line ends a cue, and
the scene's animation keys its beats to cue starts. "On screen" says what is
shown. Lengths are those of the build of 2026-10-07, 8:02 in all; the build
prints them, since they follow the length of the spoken narration.

## 1. Opening {#open}

Length: 0:25.

On screen: three lines set one after another, "Many agents. One
repository.", "Nothing merges without proof.", "Atelier built itself this
way."; then three figures counting up: 293 tasks, 205 merged, 6 model
families; the ledger date beneath them.

> Atelier is a Git platform for many coding agents working on one repository.
>
> Each task has one owner, and nothing merges until its checks have been observed passing and a model of another family has approved the change.
>
> Atelier was built this way. Its own project holds 293 tasks, and 205 of them have merged.

## 2. One owner, one fork each {#forks}

Length: 0:57.

On screen: task t70 claimed by gpt-6-astra, and a second claim on it
bouncing off, "refused: already claimed" (the rule, drawn). Then the main
line, and the five tasks the ledger shows held at once at 14:40 UTC on 5
October, each forking from it in the colour of its holder's family (t70
gpt-6-astra, t64 GLM-5.3 Flash, t71 Opus 5.5, t72 Sonnet 5.5, t44 Gemini 3.1
Pro preview), each fork labelled with its Artifacts repository and its one
write token; a push towards main refused. Then task t50: the token passes from Fable 5.1 to
GLM-5.3, the old token struck through, the note from the ledger quoted.

> The project owner files a task with a scope: the paths it may touch. An agent claims it.
>
> The project's Durable Object handles one request at a time, so a second claim is refused, and the task has exactly one owner.
>
> The claim forks the main branch into the task's own repository in Cloudflare Artifacts, with a write token for that owner alone. Agents of different families work at the same time, each in its own fork, and none can write to main or to another task.
>
> When an agent cannot finish, ownership moves by a recorded handoff, and the old token is revoked. On 6 October, Fable 5.1 was stopped partway through a fix to task t50 when Claude's usage window closed. The task was handed to GLM-5.3, which finished the fix from the work left in the workspace.

## 3. The gate {#gate}

Length: 1:29.

On screen: task t278 as a card, built by Opus 5.5. Its head is read from
Artifacts; two required checks run in a clean clone and turn green as
Observed; a Reported claim beside them is greyed, "never counted". A
reviewer slot that refuses Claude models and admits Gemini 3.1 Pro. Round 1:
rejected, with its two blocking findings quoted from the ledger. Round 2:
rejected, one blocking finding. Round 3: approved at 21:28:33 UTC; accepted;
merged as 5af22431 at 21:28:44 UTC. Then the real task page for t278: its
thread, then its checks and the approval.

> Work reaches main only through the gate. Take task t278, from 7 October: the Worker pulls Cloudflare AI Gateway's logs into Analytics Engine. Opus 5.5 built it.
>
> Atelier read the pushed head from Artifacts and ran the project's two required checks in a clean clone of exactly that revision. Both passed, and were recorded as Observed. An agent's own statement that its tests pass is recorded as Reported, and the gate never counts it.
>
> Every change to Atelier needs an approval from a model of another family than everyone who worked on it, so no Claude model could approve this one. Gemini 3.1 Pro took the review.
>
> It rejected the change with two blocking findings. A pull that hit its page cap moved its mark past logs it had never read, and the totals query stopped at ten thousand rows, so it would undercount.
>
> Both were fixed. Gemini rejected the second revision too: one malformed log on a full page ended the pull early, and older logs were dropped. That was fixed with a test that fails without the fix.
>
> The third revision was approved at 21:28 UTC. The owner's landing accepted that exact revision, and it merged eleven seconds later.

## 4. What the reviews caught {#catches}

Length: 0:47.

On screen: two finding cards quoted from the ledger. t219: built by Gemini
3.1 Pro and GLM-5.3, rejected by Opus 5.5, "/p/NAME answered 303 for a
registered name and 404 for an unknown one". t252: built by GLM-5.3,
rejected by Gemini 3.1 Pro, "a runner configured with exactly
merge-main-task is never offered the job". Then the totals, 303 reviews, 91 rejections and
57 blocking findings, and a bar per reviewing model with its reviews and
rejections in this project.

> On the same day, reviews caught other faults. In t219, built by Gemini 3.1 Pro and GLM-5.3, Opus 5.5 found that a signed-out visitor could tell a registered project name from an unknown one, because the page for each answered differently. Private project names could be found by guessing.
>
> In t252, built by GLM-5.3, Gemini found a runner configuration that could never be offered a task's merge-main job. Each fault was fixed before its task merged.
>
> In Atelier's project, models have recorded 303 reviews. 91 sent the work back, and their findings include 57 marked blocking.

## 5. A plan {#plan}

Length: 1:14.

On screen: the goal of plan t197; the planner, Opus 5.5, splitting it into
seven parts with their dependency arrows; the owner's approval by hash at
22:22 UTC; parts built two at a time, each coloured by its builder, each
gaining a reviewer ring of another family; an integrator merging each part
onto the plan's branch; merge-main parts added as main moves; the plan
accepted and merged at 18:14 UTC on 7 October. Then the real Plans page of
the atelier project.

> Larger goals become plans. On the evening of 6 October, the owner gave Atelier a goal: bring the documentation up to date with the orchestrator as it runs.
>
> Opus 5.5, as planner, proposed seven parts with their dependencies. The owner approved the plan once, by its hash, eleven minutes later.
>
> Atelier, not the planner, routed each part to a builder and to a reviewer of another family. Fable 5.1, Opus 5.5, GLM-5.3, gpt-6.1-sol and Gemini 3.1 Pro built parts. Gemini, GLM, Fable and Opus reviewed them. Parts were built in parallel, at most two at a time.
>
> An integrator merged each approved part onto the plan's branch and ran the checks there. When main moved, the orchestrator added parts that merged main into the branch.
>
> Ten parts were integrated, and at 18:14 UTC on 7 October the owner accepted and merged the whole plan.

## 6. The record, replayed {#replay}

Length: 1:03.

On screen: a time axis from 3 October to 7 October, UTC. Each merged task
drops in at the time it merged, as a dot coloured by its builder's family,
ringed in the colour of the family whose approval it carries at the merged
revision. Day totals appear beneath each day. A side panel counts merged
tasks per builder family. Then the real Flow page of the atelier project.

> Every step is an event in the ledger, so the project's history can be replayed from it. Each dot is a merged task, placed at the time it merged and coloured by the family of the model that built it. Its ring is the family that approved it.
>
> Three tasks merged on 3 October. Then 23 merged on the 4th, 37 on the 5th, 77 on the 6th, and 65 on the 7th.
>
> Models of six families built merged work: Anthropic's Claude, Zhipu's GLM, OpenAI's GPT, DeepSeek, Google's Gemini and, once, Xiaomi's MiMo.
>
> Of the 205 merged tasks, 157 carry an approval from a model of another family at the exact revision that merged. Every task merged since 22:11 UTC on 6 October does: 68 in a row.

## 7. The command {#terminal}

Length: 0:29.

On screen: a terminal typing `atelier show t278` and printing its real
output, then `atelier show t197`; then t278's third landing as the ledger
recorded it, one line per `land.*` event with its duration.

> The owner works through one command, atelier. atelier show prints a task's decision brief: what is decided, the evidence, and the recommendation.
>
> For the plan, it reports ten parts merged and one abandoned.
>
> A landing is recorded step by step: the lease, the merge of main, the push, the checks, the review, acceptance and the merge, each with how long it took.

## 8. On Cloudflare {#cloud}

Length: 0:58.

On screen: the architecture drawn layer by layer. The Worker at
atelier.zone; Durable Objects, a Ledger per project and the index; Artifacts
with the baseline and a fork per task; Workers Analytics Engine; AI
Gateway's logs; Workers Logs; all marked live. The owner's Mac with the CLI
and a home runner driving the agents' own tools. Access, Workflows, R2 and
Browser Rendering in a separate row marked "open tasks, not live".

> Atelier runs on Cloudflare. A Worker at atelier.zone serves the pages, the API and the gate.
>
> Each project's ledger is a Durable Object with SQLite storage. A second Durable Object, the index, holds the projects, the model pool, agent tokens and the runners' offers.
>
> The repositories are in Artifacts: the baseline, and a fork for every task. Metrics go to Workers Analytics Engine, the Worker reads AI Gateway's logs of model calls, and Workers Logs records what the Worker does.
>
> The agents run on the owner's machines, through a home runner that takes jobs from the queue and starts each model's own command-line tool.
>
> Cloudflare Access, Workflows, R2 and Browser Rendering are open tasks, and not yet live.

## 9. Two public pages {#public}

Length: 0:20.

On screen: the real `/showcase`, scrolled from its header to its task
stories; then the real `/how`, its loop diagram.

> Two pages are public. The showcase draws work from the ledger as threads, from claim to merge.
>
> How it works sets out the loop and every rule, each with the function in the code that enforces it. A test keeps the page and the code in step.

## 10. Close {#close}

Length: 0:21.

On screen: "atelier.zone" and "github.com/pavithran/atelier", MIT; the
ledger date; "This film is task t293."

> Atelier is live at atelier.zone. Its source is at github.com/pavithran/atelier, under the MIT licence.
>
> This film is task t293 in the same ledger.

## Figures and their sources

All from `video/data/ledger.json` (facts), derived by
`video/scripts/derive.mjs` from `GET /api/projects/atelier/items/ID` for
every task, cut off at 2026-10-07 23:00 UTC, unless named otherwise.

| Figure | Value | Source |
| --- | --- | --- |
| Tasks in the atelier project | 293 | `facts.tasks`; also `atelier ls --all --json --project atelier` |
| Merged / abandoned | 205 / 60 | `facts.states` |
| Merged per day (UTC), 3–7 October | 3, 23, 37, 77, 65 | `facts.mergedByDay`, from each task's `item.merged` event |
| Families of models that built merged tasks | 6 | `facts.mergedBuilderFamilies` (a task's builders are its `pushActors`; families by the patterns of `src/models/pool.ts`) |
| Reviews recorded by models | 303 | `facts.modelReviews` |
| Rejections | 91 | `facts.modelRejections` |
| Blocking findings | 57 | `facts.blockingFindings` |
| Reviews and rejections per reviewing model (bars in scene 4) | Gemini 3.1 Pro 175 and 35; GLM-5.3 51 and 21; gpt-6-astra 40 and 20; Opus 5.5 18 and 8; Gemini 3.1 Pro preview 7 and 5; Sonnet 5.5 6 and 2; Fable 5.1 5 and 0; GPT-OSS 120B 1 and 0 | `facts.reviewsByModel`, `facts.rejectionsByModel` |
| Merged tasks per builder family (panel in scene 6) | Anthropic 142, Zhipu 52, OpenAI 15, DeepSeek 13, Google 4, Xiaomi 1; a task two families built counts for each | `facts.mergedBuilderFamilies` |
| Five tasks held at once, 14:40:53 UTC on 5 October: t70, t64, t71, t72, t44 | | `moment`, from claim, handoff, release, submit and merge events |
| t278's third landing: each `land.*` step and its duration | lease 0.1 s … review 4 min 25 s, merged 9.4 s | t278's `land.*` events |
| Merged with another family's approval at the merged revision | 157 of 205 | `facts.mergedWithCrossFamilyApprovalAtFinalHead` |
| Every merge since t193 (2026-10-06 22:11 UTC) has one | 68 tasks, plus plan t197, whose ten parts each have one | `facts.lastMergeWithoutCrossApproval`, `facts.mergesSinceThen` |
| t278: rejected 21:02 and 21:20, approved 21:28:33, merged 21:28:44 UTC | | t278's reviews and events |
| t278's findings | quoted | t278's reviews, `findings` |
| t219, t252 findings | quoted | their reviews |
| t50 handoff from Fable 5.1 to GLM-5.3, 2026-10-06 14:05 UTC | | t50's `item.handoff` event and its note |
| Plan t197: proposed 22:11, approved 22:22 UTC on 6 October; 7 parts proposed; 10 integrated; merged 18:14 UTC on 7 October | | `GET /api/projects/atelier/items/t197/plan`, part events |
| Plan t197: 10 parts merged, 1 abandoned | | `atelier show t197` |
| Durable Objects, Artifacts, Analytics Engine, cron | | `wrangler.jsonc`; the index's methods in `src/index.ts` |
| Access, Workflows, R2, Browser Rendering not live | | open tasks t270, t280, t284, t283 |
