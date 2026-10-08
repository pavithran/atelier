# The submission video

This is the script of Atelier's competition video and the source its build
reads. `cd video && npm ci && npm run build` turns it into the film: each
scene's narration below is spoken by text-to-speech, captioned, and laid over
the scene of the same id in `video/scenes/film.js`, with a score and sound
composed by `video/scripts/music.mjs` from the same timeline. Change the
words here, not in the build. This is the second cut, `atelier-v2.mp4`; the
first is in the history of this file.

Every figure comes from Atelier's own ledger for the `atelier` project, as of
2026-10-08 00:30 UTC, through `video/data/ledger.json`, which
`video/scripts/derive.mjs` writes from the read-only item routes. "Figures
and their sources" at the end lists each one. Screens are captured from
atelier.zone by `video/scripts/capture.mjs`: the public `/showcase` and
`/how`, the `atelier` project's own pages, and the AI Gateway section of the
Models page, never another project's. Terminal text is the real output of
`atelier show`, captured by `video/scripts/terminal.mjs`.

Format, for the build: each scene is a level-two heading ending in its id
in braces. Lines beginning `>` are narration; a blank `>` line ends a cue,
and the scene's animation keys its beats to cue starts. "On screen" says
what is shown. Each scene first states the idea in general terms, then shows
the instance from the ledger. Lengths are those of the build of 2026-10-08, 8:57 in all;
the build prints them, since they follow the spoken narration.

## 1. Cold open {#cold}

Length: 0:21.

On screen: the ledger as a field of light. Every task of the atelier project
is a point that lights at the time it was created, above a main line, in the
colour of the family of the model that built it; its fork rises from main
and returns where it merged; each approval by another family arcs below the
line in the reviewer's colour. The camera starts close on 3 October and
pulls back across five days to the whole record, then the points draw in to
the title.

> Many agents. One repository. How do you trust what merges?

## 2. A multi-agent system {#cast}

Length: 1:10.

On screen: the ledger at the centre, glowing; the cast enters around it one
role at a time, each joined to the ledger by a line that light travels
along. The planner (Opus 5.5, which proposed plan t197's seven parts). The
builders, a chip for each of the six families that built merged work, each
with its own fork. The reviewers, with arcs that cross from one family to
another (Gemini 3.1 Pro, which recorded 182 of the 310 reviews, largest).
The integrator, merging parts onto a plan's branch. The runners on the
owner's machines, with the four tools they start. The owner, in the
signal colour, the only person.

> Atelier is a multi-agent system for software work, with Git underneath. Agents in distinct roles coordinate through one ledger.
>
> A planner splits a goal into parts. For plan t197, that was Opus 5.5.
>
> Builders, many at once, each work in their own fork. Models of six families have built Atelier: Claude, GLM, GPT, DeepSeek, Gemini and MiMo.
>
> Reviewers check each change, and a review counts only from a model of another family than its builders. Gemini 3.1 Pro has recorded the most.
>
> An integrator merges approved parts onto a plan's branch. It runs no model.
>
> Runners on the owner's machines take the jobs from the queue, and start each model's own tool.
>
> And the owner approves the plan and accepts the result. The owner is the only person in the system.

## 3. Why Atelier, and not Git alone {#why}

Length: 1:43.

On screen: the title moves up into a header, and the camera travels along a
strip of panels. Each panel asks one question and splits the screen: on the
left, "With Git alone", the risky state drawn in grey and red; on the right,
"With Atelier", the governed state in the site's colours, with a proof from
the record beneath it. Ownership: two agents on one branch against one owner
and one token (15 handoffs recorded). Tests: an agent's "tests pass" against
checks Atelier ran itself (1,012 observed check results). Review: an author
approving its own change against another family's approval (310 reviews, 92
sent back, 59 blocking findings). Main: two merges colliding against one
landing at a time (t278, merged at the approved head). The owner's attention:
a cascade of pull requests against a decision inbox. Models: question marks
against each model's record and AI Gateway's figures. History: a commit's
claimed co-author against a provenance note on the merge.

> Git records commits. It cannot say who owns a piece of work, whether the tests really ran, or who checked the change. A system of many agents must answer each of these, and a forge leaves them to people. Atelier answers them on top of Git.
>
> With Git alone, two agents can take the same work. With Atelier, every task has exactly one owner, with a write token for its own fork, revoked on handoff.
>
> An agent can say its tests pass. Atelier runs the required checks itself, in a clean clone of the exact head, and will not accept a head it has not seen pass.
>
> A model reviewing its own work shares its blind spots. Atelier requires approval from a model of another family for every protected path.
>
> Merging can break main. Atelier lands one task at a time: it merges main into the task, runs the checks again, and merges exactly the head that was reviewed. Plans are integrated on their own branch first.
>
> Instead of a stream of pull requests, the owner gets an inbox of decisions, each with a recommendation, and one command lands a task.
>
> Which model is worth it? Each model has a track record, and calls through Cloudflare AI Gateway show their cost and latency.
>
> And every merge records who built it, who reviewed it, and the exact head, in the ledger and as a provenance note in Git.

## 4. One owner, one fork each {#forks}

Length: 0:38.

On screen: the record: the five tasks the ledger shows held at once at 14:40
UTC on 5 October (t70 gpt-6-astra, t64 GLM-5.3 Flash, t71 Opus 5.5, t72
Sonnet 5.5, t44 Gemini 3.1 Pro preview), forking from main, commits flowing
along each fork, each with its Artifacts repository and its one write token.
Then task t50: the token passes from Fable 5.1 to GLM-5.3, the old token
struck through, the handoff's note quoted from the ledger.

> Here is ownership in the record. At 14:40 UTC on 5 October, five tasks were held at once, by models of four families, each in its own fork.
>
> When an agent cannot finish, ownership moves by a recorded handoff. On 6 October, Fable 5.1 stopped partway through a fix to task t50 when Claude's usage window closed. GLM-5.3 took the task, and finished the fix from the work left in the workspace.

## 5. The gate {#gate}

Length: 1:02.

On screen: the gate as a pipeline that light travels along: the pushed head
read from Artifacts, a clean clone, checks turning green as Observed, a
reviewer slot that refuses the builder's family, the owner. Then task t278,
built by Opus 5.5: three rounds, each with its revision, its observed
checks, Gemini 3.1 Pro's verdict pulsing red on rejection with the blocking
findings quoted from the ledger, and green on approval; accepted at
21:28:36 and merged as 5af22431 at 21:28:44 UTC. Then the real page of
t278: its thread, then its checks and the approval.

> Here is the gate at work. On 7 October, Opus 5.5 built task t278, which pulled AI Gateway's logs. Its checks were observed passing in a clean clone. No Claude model could approve it, so Gemini 3.1 Pro reviewed it.
>
> Gemini rejected it: a pull that hit its page cap skipped logs it had never read, and the totals stopped at ten thousand rows.
>
> Both were fixed. Gemini rejected the second revision too: one malformed log on a full page ended the pull early. That was fixed, with a test that fails without the fix.
>
> The third revision was approved at 21:28 UTC, accepted at exactly that revision, and merged eleven seconds later.

## 6. What the reviews caught {#catches}

Length: 0:23.

On screen: two finding cards quoted from the ledger. t219: built by Gemini
3.1 Pro and GLM-5.3, rejected by Opus 5.5. t252: built by GLM-5.3, rejected
twice by Gemini 3.1 Pro. Each resolves to "fixed, approved, merged". Then
a bar per reviewing model with its reviews and rejections in this project.

> The same day, Opus 5.5 found in t219 that private project names could be found by guessing, and Gemini found in t252 a runner configuration that could never be offered a merge-main job. Both were fixed before they merged.

## 7. A plan {#plan}

Length: 1:04.

On screen: the idea first: a goal splits into parts with dependency arrows;
each part takes a builder's colour and a reviewer's ring of another family;
parts flow onto the plan's branch; the branch merges into main. Then plan
t197 from the ledger: its goal; the planner, Opus 5.5, proposing seven parts
at 22:11 UTC; the owner's approval by hash at 22:22 UTC; each part with its
builders and reviewer; the integrations at their real times on 7 October,
with the parts added to merge main as main moved; the plan merged at 18:14
UTC. Then the real Plans page of the atelier project.

> A larger goal becomes a plan, and the whole cast works on it. The owner approves the split once, by its hash, and Atelier routes each part to a builder and to a reviewer of another family.
>
> On 6 October, the owner asked for the documentation to match the orchestrator as it runs. Opus 5.5 proposed seven parts, and the owner approved them eleven minutes later.
>
> Fable 5.1, Opus 5.5, GLM-5.3, gpt-6.1-sol and Gemini 3.1 Pro built parts, and Gemini, GLM, Fable and Opus reviewed them. When main moved, the orchestrator added parts that merged main into the branch.
>
> Ten parts were integrated, and at 18:14 UTC on 7 October, the owner merged the whole plan.

## 8. The record, replayed {#replay}

Length: 0:57.

On screen: the idea first: claims, pushes, checks, reviews and merges flow
into the ledger as events. Then the record: a time axis from 3 to 8 October,
UTC; each merged task drops in at its merge time, a dot in its builder's
family colour, ringed in the colour of the family whose approval it carries
at the merged revision; day totals count up; a panel counts merged tasks per
builder family. The camera moves in on the evening of 6 October, where the
unbroken run of cross-family approvals begins. Then the real Flow page.

> Every claim, push, check, review and merge is an event in the ledger, so a project's history can be replayed from it.
>
> This is Atelier's own project. Each dot is a merged task, in the colour of the family that built it, ringed in the colour of the family that approved it.
>
> Three tasks merged on 3 October, then 23, 37, 77, and on the 7th, 70. Models of six families built them.
>
> Of the 211 merged tasks, 163 carry an approval from another family at the exact revision that merged. Every task merged since 22:11 UTC on 6 October does.

## 9. The owner's command, and the models {#runners}

Length: 0:29.

On screen: a terminal typing `atelier show t278` and printing its real
output. Then the real AI Gateway section of the Models page.

> The owner works through one command. atelier show prints any task's decision brief: what is decided, the evidence, and the recommendation.
>
> The Models page keeps each model's record, and reads AI Gateway's figures from Cloudflare's GraphQL Analytics: calls, failures, tokens, cost and latency.

## 10. On Cloudflare {#cloud}

Length: 0:39.

On screen: the architecture drawn layer by layer, with requests travelling
along its edges: the owner's machine with the CLI and a home runner; the
Worker at atelier.zone; Durable Objects, a Ledger per project and the index;
Artifacts with the baseline and a fork per task and plan; Workers Logs; AI
Gateway with the GraphQL Analytics API; all marked live. Cloudflare Access,
Browser Rendering, R2 and Workflows in a dashed row marked "in progress".

> Atelier runs on Cloudflare. A Worker serves the API, the pages and the gate. Each project's ledger is a Durable Object with SQLite storage; because it handles one request at a time, one owner per task holds.
>
> Artifacts holds the Git repositories: a baseline for each project, and a fork for every task and plan. Workers Logs keeps the Worker's logs.
>
> Cloudflare Access, Browser Rendering, R2 and Workflows are in progress.

## 11. Close {#close}

Length: 0:32.

On screen: the field of light from the opening returns, whole; "Nothing
merges without proof."; the figures count up beneath it: 295 tasks, 211
merged, models of six families; then atelier.zone,
github.com/pavithran/atelier and the MIT licence; "This film is task t293 in
the same ledger."

> Git keeps the code. Atelier keeps the record: who did the work, what was observed, and who approved it. It built itself this way: 295 tasks, 211 merged, by models of six families.
>
> It is live at atelier.zone, and its source is on GitHub, under the MIT licence.

## Figures and their sources

All from `video/data/ledger.json` (facts), derived by
`video/scripts/derive.mjs` from `GET /api/projects/atelier/items/ID` for
every task, cut off at 2026-10-08 00:30 UTC, unless named otherwise.

| Figure | Value | Source |
| --- | --- | --- |
| Tasks in the atelier project | 295 | `facts.tasks`; also `atelier ls --all --json --project atelier` |
| Merged / abandoned | 211 / 60 | `facts.states` |
| Merged per day (UTC), 3–7 October | 3, 23, 37, 77, 70 (and 1 on 8 October before the cut-off) | `facts.mergedByDay`, from each task's `item.merged` event |
| Plan t197's planner: Opus 5.5; reviews by Gemini 3.1 Pro: 182 of 310; the integrator runs no model (`atelier runner --integrate`) | | `plan.planner`, `facts.reviewsByModel`; README "Plans" and docs/demo.md |
| Families of models that built merged tasks | 6: Anthropic 146, Zhipu 55, OpenAI 15, DeepSeek 13, Google 4, Xiaomi 1; a task two families built counts for each | `facts.mergedBuilderFamilies` (a task's builders are its `pushActors`; families by the patterns of `src/models/pool.ts`) |
| Handoffs recorded | 15 | `facts.handoffs`, `item.handoff` events |
| Observed check results | 1,012 | `facts.observedChecks`, `evidence.observed` events |
| Reviews recorded by models / rejections / blocking findings | 310 / 92 / 59 | `facts.modelReviews`, `facts.modelRejections`, `facts.blockingFindings` |
| Reviews and rejections per reviewing model (bars in scene 5) | Gemini 3.1 Pro 182 and 36; GLM-5.3 51 and 21; gpt-6-astra 40 and 20; Opus 5.5 18 and 8; Gemini 3.1 Pro preview 7 and 5; Sonnet 5.5 6 and 2; Fable 5.1 5 and 0; GPT-OSS 120B 1 and 0 | `facts.reviewsByModel`, `facts.rejectionsByModel` |
| Merged with another family's approval at the merged revision | 163 of 211 | `facts.mergedWithCrossFamilyApprovalAtFinalHead` |
| Every task merged since t193 (2026-10-06 22:11 UTC) has one | 74 tasks, and plan t197, whose ten parts each have one | `facts.lastMergeWithoutCrossApproval`, `facts.mergesSinceThen` |
| Five tasks held at once, 14:40:53 UTC on 5 October: t70, t64, t71, t72, t44 | | `moment`, from claim, handoff, release, submit and merge events |
| t50 handoff from Fable 5.1 to GLM-5.3, 2026-10-06 14:05 UTC, and its note | | t50's `item.handoff` event |
| t278: rejected 21:02 and 21:20, approved 21:28:33, accepted 21:28:36, merged 21:28:44 UTC; its findings | quoted | t278's reviews and events |
| t219, t252 findings and approvals | quoted | their reviews |
| Plan t197: proposed 22:11, approved 22:22 UTC on 6 October; 7 parts proposed; 10 integrated; merged 18:14 UTC on 7 October | | `GET /api/projects/atelier/items/t197/plan`, part events |
| AI Gateway figures on the Models page | as captured | the Models page, AI Gateway section, from Cloudflare's GraphQL Analytics (t295, deployed as f209f068) |
| Cloudflare products live | Workers, Durable Objects, Artifacts, Workers Logs, AI Gateway with GraphQL Analytics | `wrangler.jsonc`; README "Built on Cloudflare" at f209f068 |
| The claims of scene 2 | | README.md "What Atelier enforces, and why" and docs/gate.md at f209f068 (one owner and its token, revoked on handoff; checks in a clean clone at the head and the gate in `src/rules.ts`; another family's approval; `atelier land`: lease, merge of main, checks, review, accept, merge of the accepted head; plans integrated on their own branch; the inbox and decision briefs with a recommendation; each model's record on the Models page; the provenance note on `refs/notes/atelier`) |
| In progress, not live | Access (t270, submitted), Browser Rendering (t283, claimed), R2 (t284, claimed), Workflows (t280, open) | the ledger at the cut-off |
