# Atelier's implicit state machines, November 2026

PAVI asked (2026-11-09) for a read-only inventory of the state machines
Atelier runs without writing them down, ranked by measured harm, as the first
of four steps: this inventory, PAVI's pick of the worst, one design note and
task for it, and a repeat only if that measurably cut rework. This report
changes no code.

Every `file:line` below is read at main as it stood at commit `26a0f87f`
(Merge main at ff8ac5c1 into t602), the parent of the commit that adds this
file. The first draft was written at `c86e6077` (Merge t595) and the first
two fix rounds at `928978c0` (Merge t565). Between `928978c0` and this
parent, main merged t594 (`ff8ac5c1`), which adds lines to `src/ledger.ts`
before `:119`, `:492` and `:1105`, rewrites `requestLand` (`:11357-11392`),
adds the stale-head drop to `landJobs` (`:11460-11468`) and adds lines to
`src/index.ts`. The third fix round moved every `src/ledger.ts` and
`src/index.ts` number to this parent with a line map built from `git diff
928978c0 26a0f87f`, and a script then read each cited identifier at its new
line; the rewritten region is cited afresh in machine 5. No other file this
report cites changed between the two: `git diff --stat 928978c0 26a0f87f`
names, besides those two, only `src/page-actions.ts`, `src/page-requests.ts`
(both new, cited in machine 5), `src/situation.ts`, `src/task-verdict.ts`,
`src/today.ts`, `src/ui.ts`, two stylesheets and six tests this report does
not cite. Unless a path is given, a bare line number is in `src/ledger.ts`,
or in the file last named in the same table cell or sentence. A test is
named by the line of its `it(` or `test(` call.

## How to read this report

Each machine has three tables: its states and where each is stored, its
transitions with the function that makes them, the event each records and
the test that enters it, and a short list of states reached by more than one
path and transitions no test covers. The three cases PAVI saw on 2026-11-09
are traced in their own section. The ranking comes last, with the commands.

The rows were enumerated by method, not by reading. For each machine, every
function that writes its state was listed with a grep over the assignments,
the SQL and the `meta` writes, and for each writer the starting states its
guards let through were written out and compared with the rows. The grep each
machine used is named under its transitions table. Two reviews of this report
found omissions that reading had left; the enumeration found more, each marked
where it was added: a holder's renewal of its claim of a task it has submitted
(machine 1), the landing Workflow's record that nothing writes any more
(machine 5), the two approval events of a protected action (machine 6) and
five `meta` key families of the runner (machine 7). The third fix round
corrected two of those entries against the code (the holder's renewal keeps
the state and records no claim; an approval is `consumed`, never `used`),
renumbered every line to this commit's parent and added what t594 brought to
machine 5.

What this workspace could and could not measure:

- The ledger. The atelier project's ledger is on the server. This workspace
  holds none of it, and the task forbids running `atelier` here, so every
  ledger figure below is the command that counts it, not the number. The
  criteria review flagged this; the orchestrator runs the commands after
  deploy.
- Git history. Main's history since 2026-11-01 is here, so repairs that
  merged are counted from it, with the commands and their output. Those are
  proxies for the ledger's figures and are labelled as such.

## The machines, in brief

| Machine | Where its state lives | States | Transition rows | States with more than one entry path | Transitions with no test |
| --- | --- | --- | --- | --- | --- |
| 1 Task lifecycle | `items.state`, `items.owner`, `items.dispatch`, `items.blocked`, derived `events.stage` | 8 stored, 12 derived stages | 35 | 6 of 8 | 1 |
| 2 Review requests and reviews | `review_requests.state` plus 8 flag columns, `reviews` | 7 | 25 | 4 | 3 |
| 3 Criteria reviews | `criteria_reviews.state`, `criteria_revisions`, `criteria_resolutions` | 6 | 12 | 2 | 3 |
| 4 Pre-reviews | `prereviews.state`, `same_exits` | 9 | 22 | 5 | 3 |
| 5 Land jobs and landing | `land_jobs` (no state column), `page_requests`, 8 `meta` keys, events | 8, plus the 8 stages of a record nothing writes | 24 | 7 | 3 |
| 5b The post-merge run | `meta post-merge:RUN` JSON, `meta post-merge-item:ID`, `meta post-merge-active`, events `post-merge.*` | 6, plus step and attempt outcomes | 18 | 3 of 6 | 2 |
| 6 Ships and deploy steps | events, `action_approvals`, `deploy_notices`, `revert_notices`, a local file, `meta` | 7, plus 4 approval statuses | 19 | 4 | 2 |
| 7 Runner runs and test slots | `runs`, `runner_offers`, 12 `meta` key families, host SQLite pool | 15 | 27 | 4 | 0 |
| 8 Stuck episodes | `stuck_episodes.kind`, `stuck_notices`, `stuck_ticks` | 4 | 5 | 1 | 0 |

Transition rows counts the rows of the machine's transitions table.

Plans and parts, the refresh queue, secret flags and revert recovery also
carry state. They are named where a transition of a machine above touches
them and are otherwise outside this inventory.

## 1. The task lifecycle

Claim, release, dispatch, block and unblock are all moves of this one
machine, because each writes a different column of the same `items` row
and the others read all four.

### States and storage

| State | Stored as | Declared |
| --- | --- | --- |
| open, claimed, submitted, accepted, integrated, merged, abandoned, blocked | `items.state` (schema `:1045-1049`) | `ItemState`, `src/rules.ts:17` |
| held by someone | `items.owner`; every non-null write goes through `assignOwner` `:3646`, enforced by the SQL triggers at `:1148-1160` | |
| queued for a runner | `items.dispatch` (`:1122`), kept after a claim as the record | `Dispatch`, `src/dispatch/rules.ts` |
| which runner holds the claim | `items.runner` (`:1123`); reset to null on any owner change, `:11860-11861` | |
| blocked, and the state to return to | `items.blocked` JSON with `from` (`:1172`); `Block`, `src/rules.ts:119-139` | |
| claim in flight | `items.claim_gen`, `items.claim_pending` (`:1137-1145`) | |
| waiting on other tasks | `items.blocked_by` (`:1200`) | |
| the stage after each change | `events.stage` (`:1114`), written at `:12269-12272` from `stageNow` `:12242` | `STAGES`, `src/rules.ts:2273`: filed, agreed, queued, building, built, checked, reviewed, landable, landed, shipped; `eventStage` `src/rules.ts:2326` adds blocked and abandoned |

The stored states and the derived stages are two vocabularies for one
machine. "checked" and "landable" are never stored on the item: `stageOf`
(`src/rules.ts:2293`) computes them from evidence, reviews and policy each
time an event is logged, and only the result lands in `events.stage`.

### Transitions

| Transition | From, to (owner, dispatch, blocked) | Function | Event | Test |
| --- | --- | --- | --- | --- |
| create | none to open | `newItem` `:2869`, insert `:2905`; parts `:8883` | `item.created` `:2911` | `test/stage-events.test.mjs:82` |
| claim | open or claimed to claimed; owner set, `claim_gen` up, `claim_pending` set | `claim` `:3546` via `assignOwner` `:3633`; rules `assertNotTerminal` `src/rules.ts:1161`, `assertClaimable` `src/rules.ts:1167` (not blocked, not merged, abandoned or accepted; owner null or the actor), `assertDispatchedClaim` `src/dispatch/rules.ts:842` (open only) | `item.claimed` `:3636` | `test/ledger.spec.ts:389` |
| claim renewed by its holder | claimed stays claimed, submitted stays submitted: the holder's branch `:3623-3632` returns at `:3631`, before the state write at `:3633`; `assignOwner` `:3627` is given no state, writes the row only when a runner is adopted (`:3654`), and advances `claim_gen` and sets `claim_pending` (`:3655-3656`) | `claim` `:3623-3632` | `item.runner_adopted` `:3629`, only when a runner is adopted; otherwise none | `test/ledger.spec.ts:888` (claimed; a runner adopted, then a renewal that records nothing); from submitted, no test |
| claim rolled back (branch failed) | claimed to the saved prior state; owner null | `unclaim` `:4461`, write `:4473`; caller `src/index.ts:1368` | `item.claim_failed` `:4475` | `test/ledger.spec.ts:413` |
| release | claimed or submitted to open; owner and runner null; dispatch kept | `release` `:5462`, write `:5490`; rule `releaseAllowed` `:5413` | `item.released` `:5491` | `test/validation-blocked-task.spec.ts:76` |
| release with the validation_blocked mark | claimed or submitted to blocked; owner, runner and dispatch kept | `release` `:5471-5487`, write `:5486`; rule `validationBlockReason` `src/rules.ts:1520` | `item.blocked` with `validationBlocked: true` `:5487` | `test/validation-blocked-task.spec.ts:31` |
| handoff | claimed, submitted or accepted to claimed; owner changed | `handoff` `:5452` via `assignOwner` `:5457`; rule `assertHandoffTarget` `src/rules.ts:918` | `item.handoff` `:5458` | `test/ledger.spec.ts:445`, accepted at `:467` |
| submit | claimed or submitted to submitted | `submit` `:5128`, write `:5143` | `item.submitted` `:5144` | `test/ledger.spec.ts:965` |
| push | claimed stays, submitted stays, accepted to claimed | `recordPush` `:4658`, write `:4677-4682` | `push.observed` `:4683` | `test/ledger.spec.ts:1083` |
| block by hand | open, claimed or submitted to blocked; owner and dispatch kept | `block` `:5191`, write `:5201`; rule `assertBlockable` `src/rules.ts:1416` | `item.blocked` `:5202` | `test/ledger.spec.ts:1372` |
| block at the review round cap | submitted to blocked | `holdAtRoundCap` `:5099`, write `:5108`; rule `roundCapHold` `src/rules.ts:3103` | `item.blocked` `:5109`, `review.round_cap` `:5110` | `test/review-convergence.spec.ts:59` |
| block when approved criteria cannot dispatch | open to blocked | `dispatchApprovedCriteria` `:4052`, write `:4078` | `item.blocked` `:4079` | `test/dispatch-on-approval.spec.ts:129` |
| block a plan part | part state to blocked | `blockPart` `:9186`, write `:9189` | `item.blocked` `:9190` | `test/review-requests.spec.ts:199` |
| unblock | blocked to `blocked.from`; owner and dispatch untouched | `unblock` `:5217`, write `:5236` | `item.unblocked` `:5237` | `test/validation-blocked-task.spec.ts:54` |
| unblock for criteria | blocked to `from` | `unblockForCriteria` `:10722`, `clearCriteriaBlocksForFast` `:10734` | `item.unblocked` `:10726`, `:10742` | `test/criteria-review.spec.ts:579` |
| unblock by rerouting a part's reviewer | blocked part to submitted | `rerouteReviewer` `:8508`, write `:8536` | `item.unblocked` `:8537` | `test/model-roles.spec.ts:374` |
| accept | submitted or accepted to accepted; `accepted_head` set | `accept` `:5522`, write `:5582`; rule `gate` `src/rules.ts:2204` | `item.accepted` `:5590` | `test/ledger.spec.ts:135` |
| a review of accepted work | accepted to submitted | `addReview` `:4914`, write `:5031` | `review.approved` or `review.rejected` `:5032` | `test/ledger.spec.ts:135` |
| criteria change on accepted work | accepted to claimed; an open queued build undispatched | `criteriaChanged` `:3047`, writes `:3082`, `:3089` | `item.criteria_changed` `:3091`, `item.undispatched` `:3083` | `test/ledger.spec.ts:1723` |
| task refresh of accepted work | accepted to submitted; `accepted_head` cleared | `taskRefreshed` `:11668`, write `:11703` | `item.refreshed` `:11709` | `test/task-refresh.spec.ts:115` |
| merge | accepted to merged; owner, dispatch and token cleared | `merged` `:6933`, write `:6955`; a plan's parts `:6977` | `item.merged` `:6960`, `:6978` | `test/ledger.spec.ts:135` |
| merge recorded from outside | any live state to merged | `recordMerge` `:7612`, write `:7624` | `item.merge_recorded` `:7633`, `item.merged` `:7636` | `test/record-merge.spec.ts:69` |
| landed fast | any open state to merged | `landedFast` `:7527`, write `:7539`; no CLI caller found | `item.landed_fast` `:7541`, `item.merged` `:7542` | `test/fast-mode.spec.ts:104` |
| plan completed | plan to merged | plan `tick` `:8930`, write `:8949` | `plan.completed` `:8951` | `test/plans.spec.ts:429` |
| abandon | any open state to abandoned; owner, blocked and dispatch null | `abandon` `:7011`, write `:7016` | `item.abandoned` `:7019` | `test/ledger.spec.ts:445` |
| plan stopped | its parts to abandoned | `stopPlan` `:8576`, write `:8585` | `item.abandoned` `:8587`, `plan.stopped` | `test/plans.spec.ts:429` |
| part integrated | submitted part to integrated | `integratePart` `:10840`, write `:10859` | `part.integrated` `:10863` | `test/integration.spec.ts:117` |
| integration failed | submitted part to open; owner null | `integrationFailed` `:10881`, write `:10891` | `integration.failed` `:10892` | `test/integration.spec.ts:148` |
| part rework after a rejection | submitted part to open; owner null | `reworkPart` `:5119`, write `:5122` | `review.rework` `:5123` | `test/review-requests.spec.ts:199` |
| pre-review rework | submitted to claimed; owner kept | `deliverPrereviewRework` `:6697`, write `:6710` | `prereview.rework` `:6711` | `test/prereview.spec.ts:209` |
| plan reopened | plan submitted or accepted to open | `reopenPlan` `:11004`, write `:11006` | `plan.reopened` `:11007` | `test/plan-reopen.spec.ts:206` |
| dispatch | sets `dispatch`; a held claimed, submitted or accepted task is first released to open with `--release` | `dispatch` `:3756`, holder release `:3787-3791`, `setDispatch` `:8840`; rules `assertDispatchable` `src/dispatch/rules.ts:742`, `overlapRefusal` `src/dispatch/rules.ts:479` | `item.released` with the taken-back note `:3791`; `item.dispatched` `:3794` | `test/ledger.spec.ts:766`; held `:832`; refused `:749` |
| overlap hold released | dispatch only | `releaseHold` `:3852`; rule `retainDispatch` `src/dispatch/rules.ts:224` | `item.dispatched` with `retained: true` `:3868` | `test/retain-dispatch.test.ts:151` |
| undispatch by the developer | open; dispatch null | `undispatch` `:3944`, write `:3964` | `item.undispatched` `:3965` | `test/ledger.spec.ts:928` |
| undispatch by the server | dispatch null | `withdrawHeldDispatch` `:2060`, `withdrawForeignDispatches` `:2570`, `approvePlan` `:8376`, plan `tick` `:8940`, `:8964`, `:9030`, `:9038`, `plannerTick` `:11179` | `item.undispatched` at `:2067`, `:2579`, `:8429`, `:8941`, `:8965`, `:9031`, `:9039`, `:11186` | `test/review-requests.spec.ts:1128` |

Every event is written by `log` (`:12257`), which also calls
`dispatchWaiting()` after each `item.*` or `plan.*` event (`:12283`), so a
release re-enters the queue in the same write. The queue itself is
`dispatchWaiting` `:4164`: open, no owner, a dispatch (`:4165`). A blocked
task's job goes back to its holder's runner through `heldJobs` `:4401`
(`:4429-4430`).

Rows enumerated with `grep -n 'update([^)]*state:' src/ledger.ts` (29
writes, every one through `update`, whose `UPDATE items SET state` at
`:11836` is the only such statement), `grep -n 'INSERT INTO items'
src/ledger.ts` (`:2905`, `:8883`) and `grep -n 'assignOwner(' src/ledger.ts`
(`:3627`, `:3633`, `:5457`; the first is given no state); each write is a
row above. The guard of each was then
read for the states it lets through: `assertLive` (`src/rules.ts:2588`:
claimed or submitted, not blocked) bounds submit, release and a live push;
`assertBlockable` (`src/rules.ts:1416`) the block; `handoffAllowed` (`:5163`) claimed,
submitted or accepted; `gate` (`src/rules.ts:2207`) submitted;
`assertNotTerminal` (`src/rules.ts:1161`) abandon, a recorded merge and a
fast landing, which therefore take a blocked task too; `assertClaimable`
(`src/rules.ts:1167`) the claim, which lets a submitted task's own holder
through to the renewal branch, where the state stays submitted; the second
fix round wrote that renewal as a move to claimed, which the third
corrected.

### States reached by more than one path

- open: create (`:2905`, `:8883`), release (`:5490`), taken back by a
  dispatch (`:3790`), claim rollback (`:4473`), integration failed
  (`:10891`), part rework (`:5122`), plan reopened (`:11006`), unblock when
  `from` was open (`:5236`, `:10725`, `:10741`).
- claimed: claim (`:3633`, from open or claimed), handoff (`:5457`), push on accepted work
  (`:4679`), criteria change on accepted work (`:3089`), pre-review rework
  (`:6710`), unblock (`:5236`, `:10725`, `:10741`), claim rollback to a
  claimed snapshot (`:4473`).
- submitted: submit (`:5143`), review of accepted work (`:5031`), task
  refresh of accepted work (`:11703`), reroute unblock (`:8536`), unblock
  (`:5236`).
- blocked: by hand (`:5201`), validation block (`:5486`), round cap
  (`:5108`), criteria dispatch refused (`:4078`), part block (`:9189`).
- merged: merge (`:6955`), a plan's parts (`:6977`), landed fast (`:7539`),
  recorded merge (`:7624`), plan completion (`:8949`).
- abandoned: abandon (`:7016`), plan stopped (`:8585`).
- accepted and integrated each have one entry.

### Transitions with no test

- A holder's renewal of its claim of a task it has submitted (`:3623-3632`,
  let through by `assertClaimable` `src/rules.ts:1167`): the state stays
  submitted, `assignOwner` `:3627` advances the claim generation
  (`:3655-3656`) and nothing is logged unless a runner is adopted (`:3629`).
  No test in `test/` claims a submitted task as its holder: every claim test
  starts from open or claimed, and the rework tests that follow a rejection
  with a claim (`test/rework-rereview.spec.ts:41`, `test/ledger.spec.ts:1533`)
  dispatch first, which releases a submitted holder to open (`holds` `:3940`,
  the release `:3790`).

The first draft of this report listed the task refresh that
returns accepted work to submitted (`:11703`); `test/task-refresh.spec.ts:115`
enters it, asserting the submitted state, the cleared acceptance and the
`item.refreshed` event.

## 2. Review requests and reviews

### States and storage

| State | Stored as | Declared |
| --- | --- | --- |
| open, claimed, answered, withdrawn, lapsed, released, no_verdict | `review_requests.state` (schema `:1210-1213`) | `ReviewRequestView`, `src/review/needed.ts:34` |
| which head, which reviewer, who claimed, when | `review_requests.head`, `.dispatch`, `.claimedBy`, `.claimedAt` (`:9527`; renewed `:10102`) | |
| asked by name | `.wanted` (`:9876`) | |
| withdrawn because the head moved | `.moved` (`:9988`) | |
| made by carrying a moved request | `.carried` (`:3134`, `:10039`) | |
| asked about criteria the task has left | `.superseded` (`:3072`) | |
| the developer withdrew it | `.developerWithdrawnAt` (`:10162`) | |
| stop record and same-exit count | `.stopped`: read at `:7506`, `:7791`, `:9234`, `:9263`, `:9302`, `:9475`, `:9500`; never written. `stopAfter` is imported at `:99` and never called | |
| when it last became open | `.openedAt`: read at `:7859`; never written | |
| the verdict | `reviews` (schema `:1053-1055`, columns `head` and `approve` `:1078-1087`), inserted `:5029` and `:4758` | |

Two columns, `stopped` and `openedAt`, are part of the machine on paper and
not in practice: nothing writes them, so the `review_stopped` refusal at
`:9501` fires only for rows older ledgers hold, and the same-exit count that
`:9266` reads for code reviews is always absent. The header of
`src/review/stopped.ts:1-9` describes a release that opens a successor,
which no code does.

### Transitions

| Transition | Function | Write | Event | Test |
| --- | --- | --- | --- | --- |
| to open, asked by the developer or by land | `askReview` `:9695` via `requestReview` `:9650`, `requestReviews` `:9673`, `askCheckedReview` `:2385`, `askSubmissionReview` `:3708`, `askPostMergeReview` `:6996` | `:9876` | `review.requested` `:9877`, `review.asked_together` `:9685` | `test/review-requests.spec.ts:469` |
| to open, a plan part's tick | `reviewTick` `:9056` | `:9170` | `review.requested` `:9178` | `test/review-requests.spec.ts:97` |
| to open, carried after the head moved | `reaskReview` `:10012` | `:10039` | `review.requested` via `head-moved` `:10041` | `test/review-head-moves.spec.ts:89` |
| to open, carried after criteria changed | `reaskForCriteria` `:3111` | `:3134` | `review.requested` via `criteria-changed` `:3136` | `test/review-head-moves.spec.ts:233` |
| open to claimed | `bindReview` `:9450` from `claimReview` `:9393` | `:9527` | `review.claimed` `:9529` | `test/review-requests.spec.ts:112` |
| claimed or open to answered | `answerReviewRequest` `:9947` from `addReview` `:4914` | `:9949`, `:9957`, `:9961` | `review.approved` or `review.rejected` `:5032` | `test/review-requests.spec.ts:136` |
| claimed tier request to answered | `addReview` | `:5035` | same | no test (tier requests exist only in older ledgers, t518) |
| claimed to released | `releaseReview` `:10110` via `endReviewClaim` `:10052` | `:10053` | `review.released` `:10127` | `test/review-requests.spec.ts:1572` |
| claimed to no_verdict | `unparsableReview` `:10182` via `endReviewClaim` | `:10053` | `review.unparsable` `:10193`, `review.released` with `noVerdict` `:10210` | `test/review-requests.spec.ts:154` |
| claimed to lapsed, after `REVIEW_LEASE_MS` (5 min, `src/rules.ts:2651`) | `expireReviewClaims` `:10061` | `:10066` | `review.expired` `:10067` | `test/production-paths.test.mjs:192` |
| expired claim to withdrawn, owner names another reviewer | `askReview` | `:9750` | `review.expired` `:9751` | reached by `test/land-routes.spec.ts:511`, state not asserted |
| open to withdrawn, redirected | `askReview` | `:9781` | `review.withdrawn` `:9782` | `test/land-routes.spec.ts:586` |
| open to withdrawn, every runner skipped it | `renewSkippedRequest` `:9343` | `:9353` | `review.withdrawn` `:9354` | `test/land-routes.spec.ts:409` |
| open to withdrawn by the developer | `withdrawReviewRequest` `:10140` | `:10162` | `review.withdrawn` `:10163` | `test/land-routes.spec.ts:552` |
| open to withdrawn, model held | `withdrawHeldRequest` `:2073` from `poolChanged` `:2022`, `bindReview` `:9512` | `:2074` | `review.withdrawn` `:2075` | `test/review-requests.spec.ts:1050`, `test/model-set.spec.ts:168` |
| open or claimed (`:2596`) to withdrawn, single-family switch | `withdrawForeignRequests` `:2594` | `:2603` | `review.withdrawn` `:2604` | `test/single-family.spec.ts:71` |
| open or claimed (`:2730`) to withdrawn, admission withdrawn | `withdrawRequestsOf` `:2729` | `:2733` | `review.withdrawn` `:2734` | `test/reviewer-admission.spec.ts:163` |
| open or claimed (`:3067`) to withdrawn and superseded, criteria changed | `criteriaChanged` `:3047` | `:3069`, `:3072` | `review.withdrawn` `:3070` | `test/review-head-moves.spec.ts:233` |
| open or claimed (`:9985`) to withdrawn and moved, head moved | `withdrawStaleRequests` `:9984` from `update` `:11877`, `bindReview` `:9465`, `reviewWaiting` `:9249` | `:9988` | `review.withdrawn` `:9989` | `test/review-head-moves.spec.ts:89` |
| open to withdrawn, part's reviewer rerouted | `rerouteReviewer` `:8508` | `:8528` | `review.withdrawn` `:8529` | `test/review-requests.spec.ts:607` |
| open to withdrawn, part head moved in the tick | `reviewTick` | `:9079` | `review.withdrawn` `:9080` | no test |
| open or claimed (`:9093`) to withdrawn, contributor or family; open only for standing (`:9102`) | `reviewTick` | `:9104` | `review.withdrawn` `:9105` | `test/review-requests.spec.ts:451` |
| tier requests, open or claimed, or open only when so asked (`:9968-9969`), to withdrawn | `withdrawTierRequests` `:9967` from `:5045`, `:5583`, `:10860` | `:9971` | `review.withdrawn` `:9972` | no test |
| open or claimed (`:11848`) to withdrawn, task merged or abandoned | `update` `:11820` | `:11850` | `review.withdrawn` `:11851` | `test/ledger.spec.ts:1825` |
| verdict kept across a clean regeneration | `reviews` insert | `:4758` | `review.retained` `:4759`, `review.not_retained` `:4744` | `test/review-retention.spec.ts:63` |

Every `review.*` kind the code writes, one site each: requested `:9877`,
asked_together `:9685`, claimed `:9529`, released `:10127`, unparsable
`:10193`, expired `:10067`, withdrawn `:10163`, approved and rejected
`:5032`, tests_unrun `:5024`, round_cap `:5110`, rework `:5123`, overridden
`:5573`, unasked `:7007`, finding `:7116`, finding_cause `:7144`, skipped
`:9288`, diff `:9420`, retained `:4759`, not_retained `:4744`.

Rows enumerated with `grep -n "UPDATE review_requests SET\|INSERT INTO
review_requests" src/ledger.ts`: 27 lines, four inserts, 22 writes of `state`
and the renewal of `claimedAt` at `:10102`, each a row or a storage entry
above. `grep -rl review_requests src cli` names only `src/ledger.ts` and
`src/how-data.ts`, which reads. The starting state of each write is the
`WHERE state` of the statement or of the select that feeds it, cited in the
first column.

### States reached by more than one path

- open: four inserts.
- answered: four writes.
- withdrawn: fifteen writes, from twelve functions.
- The kind `review.expired` is logged for two different states, lapsed
  (`:10066-10067`) and withdrawn (`:9750-9751`); `review.released` is logged
  for released and for no_verdict.

### Transitions with no test

- The tier answer at `:5035`.
- `withdrawTierRequests` at `:9971`.
- The tick's stale-head withdrawal of a part's request at `:9079`.

Also stale: the comment at `:10148` says a lapsed claim is asked again as an
open request first; `expireReviewClaims` now leaves it lapsed. `reaskReview`
logs `via: "head-moved"` even when it carries a request a criteria change
superseded, and `test/ledger.spec.ts:1806` asserts that.

## 3. Criteria reviews

### States and storage

| State | Stored as | Declared |
| --- | --- | --- |
| open, claimed, approved, rejected, failed, withdrawn | `criteria_reviews.state` (schema `:1260-1263`) | `CriteriaReviewState`, `src/review/criteria.ts:60` |
| the revision reviewed | `criteria_reviews.rev`, from `criteria_revisions` (`:1257-1259`), written by `recordCriteriaRevision` `:10233` | |
| the claim | `.claimedBy`, `.runner`, `.claimedAt` (`:10528`) | |
| the verdict | `.decidedAt`, `.summary`, `.findings`, `.failure`, `.checks` (`:10654`) | |
| the owner's answers | `criteria_resolutions` (`:1269-1272`), insert `:10708` | |
| lapsed | not a state: a lapse is `failed` with the text "the claim lapsed" (`lapseCriteriaReviews` `:10320`); `criteriaStatus` finds it by searching that text, `src/review/criteria.ts:387` | |
| same-exit run | `same_exits` (`:1289`), `noteExit` `:10443`, `clearSameExit` `:10457` | |

### Transitions

| Transition | Function | Write | Event | Test |
| --- | --- | --- | --- | --- |
| to open | `askCriteriaReview` `:10372` via `requestCriteriaReview` `:10350`, `askCriteriaReviewAtFiling` `:4040`, `resumeRevertRecoveries` `:4127` | `:10421` | `criteria_review.requested` `:10424` | `test/criteria-review.spec.ts:118`; at filing `test/dispatch-on-approval.spec.ts:72` |
| open (`:10501`) to claimed | `claimCriteriaReview` `:10495` | `:10528` | `criteria_review.claimed` `:10529` | `test/criteria-review.spec.ts:118` |
| claimed (`:10634`) to approved or rejected | `addCriteriaReview` `:10599` | `:10654` | `criteria_review.approved` or `.rejected` `:10656` | `:118`, `:170` |
| claimed (`:10677`) to failed, by the runner | `failCriteriaReview` `:10671` | `:10682` | `criteria_review.failed` `:10686` | `test/criteria-review.spec.ts:170` |
| claimed to failed, lapsed after 2 h (`src/review/criteria.ts:118`) | `lapseCriteriaReviews` `:10320` | `:10325` | `criteria_review.failed` `:10326` | `test/criteria-review.spec.ts:170` |
| open or claimed (`:10335`) to withdrawn, criteria changed | `withdrawCriteriaReviews` `:10332` from `criteriaChanged` `:3075` | `:10336` | `criteria_review.withdrawn` `:10337` | `test/criteria-review.spec.ts:118` |
| open or claimed to withdrawn, stale revision found at claim | `claimCriteriaReview` `:10507` | `:10336` | same | no test |
| open or claimed to withdrawn, stale revision found at verdict | `addCriteriaReview` `:10628` | `:10336` | same | no test |
| open to withdrawn, owner names another reviewer | `askCriteriaReview` | `:10388` | `criteria_review.withdrawn` `:10389` | no test |
| open or claimed (`:2082`) to withdrawn, model held | `withdrawHeldCriteriaReview` `:2081` from `poolChanged` `:2031`, claim `:10521`, verdict `:10642` | `:2082` | `criteria_review.withdrawn` `:2083` | `test/criteria-review.spec.ts:694`, `:713`, `:736` |
| open or claimed (`:11841`) to withdrawn, task closed | `update` | `:11842` | `criteria_review.withdrawn` `:11843` | `test/runner-keeps-server.test.mjs:471` |
| finding resolved (no state change) | `resolveCriteriaFinding` `:10695` | `:10708` | `criteria_review.finding` `:10710` | `test/criteria-review.spec.ts:170` |

Related: `criteria.revised` `:10236`; `criteria_review.needed` `:10772`, a
log with no write.

Rows enumerated with `grep -n "UPDATE criteria_reviews SET\|INSERT INTO
criteria_reviews" src/ledger.ts`: nine lines, one insert and eight writes of
`state`, each a row above. Three writes (`:10528`, `:10654`, `:10682`) carry
no `WHERE state`; their starting state is the check in the code before them,
cited in the first column. No other file writes the table.

### States reached by more than one path

- failed: the runner's report and the lapse.
- withdrawn: six call paths.

### Transitions with no test

- The owner naming another reviewer (`:10388`).
- The stale-revision withdrawals at claim (`:10507`) and at verdict
  (`:10628`).

## 4. Pre-reviews

### States and storage

| State | Stored as | Declared |
| --- | --- | --- |
| open, claimed, passed, blocked, conflict, preparation, unavailable, stale, withdrawn | `prereviews.state` (schema `:1280-1284`) | `PrereviewState`, `src/dispatch/prereview.ts:54` |
| binding and its key | `.binding`, `.bindingKey` | |
| the claim | `.claimedBy`, `.runner`, `.claimedAt` (`:6530`; renewed `:6546`) | |
| tries and when to retry | `.attempts`, `.retryAt` | |
| what settled it | `.result`, `.settledAt` (`:6408`) | |
| result no longer controls the landing | `.detached` (`:6429`) | |
| the fence on the landing after a blocking verdict | `meta prereview-fence:ID`, deleted by `unblock` `:5232` | |
| same-exit run | `same_exits`, `noteExit` from `prereviewOutcome` `:6587` | |

### Transitions

Every settled state is written by `settlePrereview` (`:6407`, write
`:6408`, guarded to rows still open or claimed), which logs
`prereview.<state>` at `:6413`.

| Transition | Caller | Event | Test (`test/prereview.spec.ts` unless named) |
| --- | --- | --- | --- |
| to open | `requestPrereview` `:6323`, insert `:6352` | `prereview.requested` `:6355` | `:114` |
| open to claimed | `bindPrereview` `:6492`, write `:6530`, from `claimReview` `:9404` | `prereview.claimed` `:6533` | `:114` |
| claimed to passed | `prereviewVerdict` `:6676` | `prereview.passed` | `:178` |
| claimed to passed or blocked, detached | `prereviewVerdict` `:6668`; `detachPrereviews` `:6422`, `:6429` | `prereview.detached` `:6430` | `:360` |
| claimed to blocked, with the fence | `prereviewVerdict` `:6687` | `prereview.blocked`, `prereview.rework` `:6711` | `:209` |
| claimed to conflict or preparation | `prereviewOutcome` `:6590` | `prereview.conflict`, `prereview.preparation` | `:391` |
| to stale, outcome note | `:6591` | `prereview.stale` | no test |
| to stale, tick drift | `prereviewTick` `:6297` | `prereview.stale` | `:536` |
| to stale, claim drift | `bindPrereview` `:6526` | `prereview.stale` | no test (`test/prereview.spec.ts:536` covers the tick's drift and `:304` the verdict's; no test claims against a drifted binding) |
| to stale, verdict drift | `prereviewVerdict` `:6658` | `prereview.stale` | `:304`, `:507` |
| to stale, left the queue before a result | `:6672` | `prereview.stale` | no test |
| lost claim, state unchanged | `:6624` | `prereview.stale` | `:340` |
| claimed to unavailable, timed out | `expirePrereviewClaims` `:6440` | `prereview.unavailable` | `:340` |
| to unavailable, malformed, skipped, runner, no reviewer | `prereviewOutcome` `:6592` from `releaseReview` `:10116`, `unparsableReview` `:10189`, `recordReviewSkip` `:9283` | `prereview.unavailable` | `:391`, `:437` |
| claimed to unavailable, contradictory verdict | `:6638` | `prereview.unavailable` | `:546` |
| to withdrawn, pool hold | `poolChanged` `:2037` | `prereview.withdrawn` | `:658` |
| to withdrawn, hold at claim or verdict | `:6514`, `:6629` | `prereview.withdrawn` | `:668` |
| to withdrawn, left the queue | `prereviewTick` `:6285` | `prereview.withdrawn` | `:380` |
| to withdrawn, ineligible | `retirePrereview` `:6401` from `:6461`, `:6519` | `prereview.withdrawn` | `:571` |
| open to withdrawn, task took the lease | `detachPrereviews` `:6426` | `prereview.withdrawn` | `:360` |
| to withdrawn, task closed | `update` `:11846` | `prereview.withdrawn` | `test/runner-keeps-server.test.mjs:483` |
| fence lifted, no state change | `unblock` `:5232-5233` | `prereview.retried` `:5233` | `test/prereview.spec.ts:209` |

Rows enumerated with `grep -n "UPDATE prereviews SET\|INSERT INTO prereviews"
src/ledger.ts`: six lines, the insert `:6352`, the claim `:6530`, its renewal
`:6546`, the settle `:6408`, the detach flag `:6429`, and at `:6294` a
rewrite of an open request's binding that gives it the main head first
observed after it was made, with no state change; and with `grep -n
"settlePrereview(" src/ledger.ts`: 19 callers, each a row above. Every
settle starts from open or claimed (`:6408`), the claim from open (`:6530`).

### States reached by more than one path

- withdrawn: eight; stale: five; unavailable: four; passed and blocked:
  two each.

### Transitions with no test

- The stale outcome note (`:6591`), stale after leaving the queue
  (`:6672`), and the claim-drift stale (`:6526`).

## 5. Land jobs and landing

### States and storage

| State | Stored as |
| --- | --- |
| queued to land | a row of `land_jobs (item, by, at, quote, at_head)` (`:1102`, `:1104`, `:1106`). No state column. `at_head` is the head a page's Land showed (t594), null for a job the command line or the tick queued (`:1105`). |
| a page's Land press, answered once | `page_requests (id, item, verb, at, answer)` (`src/page-requests.ts:28`, created from `src/ledger.ts:1107`): the one-use request id with the first answer, written by `keepRequest` `src/page-requests.ts:45` from `src/ledger.ts:11391`, in the call that queued the job; rows older than 30 days are pruned at the next request (`src/page-requests.ts:36`, `:46`) |
| the current attempt: step, attempt number, head, failed step, requeued, cancelled | `meta landing-record:ID`; `LandingRecord` `:494`, written `:6920` |
| stopped (failed at the task's current head, not requeued) | derived by `landingStopped` `:6928-6930` |
| waiting for the project's landing lease | `meta landing-queue` (`:5865`, `:5878`) |
| lease held | `meta landing-lease` (`:5749`); 15-minute expiry, `src/landing-lease.ts:10-13` |
| main confirmed under the lease | `meta lease-main:ID` (`:6041`) |
| merge reservation | `meta landing:ID` (`:5661`, `:5731`) |
| checkout lease and the checkout's last head | `meta checkout-lease`, `meta checkout-head` (`:6080`, `:6085`); expiry `src/checkout-lease.ts:39-41` |
| the landing Workflow's stage: lease, workspace, conflict, checks, review, merge, done or failed, with its round, the instance it replaced and its last status | `meta landing-workflow:ID`; `LandingWorkflowRecord`, `LandingWorkflowStage` `:429`. Written by `setLandingWorkflow` `:5776`, `claimLandingWorkflow` `:5794`, `setLandingWorkflowStage` `:5818` and `observeLandingWorkflowStatus` `:5826`; deleted with the task's other landing state at `:6953`, `:7018` and `:7626`. No route or CLI command calls a writer: the Workflow was removed, and `test/land-grant.test.mjs:326` requires its route to answer 404. The record is still read, by `fenceLandingInstance` `:5842` and by the t550 refusal in `renewProjectLanding` `:6004`. The first draft left it out. |

### Transitions

| Transition | Function | Event | Test |
| --- | --- | --- | --- |
| to queued, by the developer's command or by land at the review ask | `requestLand` `:11367`, one transaction (`:11368`), `requestLandIn` `:11371`; the plan `planLand` `src/page-requests.ts:87` (`:106`); insert `src/ledger.ts:11388`; route `src/index.ts:3165-3172`; CLI `cli/commands/land.mjs:41`, `cli/land.mjs:994-997` | `land.requested` `:11390`, with no head | `test/land-request.spec.ts:19`; no head `test/page-requests.spec.ts:201` |
| to queued, by the page's Land at the head it showed (t594) | route `src/index.ts:4393`, after `ownerPageAct` `src/page-actions.ts:18` (`src/index.ts:4293`); a used request id answers as the first press did and acts not again, `replayOf` `src/page-requests.ts:57` from `src/ledger.ts:11372-11375`; the shown head and criteria checked by `assertShown` `src/page-requests.ts:65` (`src/ledger.ts:11377`); insert `:11388` with `at_head`; the id kept with the answer `:11391` | `land.requested` with `head` `:11390`; a replay records nothing | `test/page-requests.spec.ts:61`; the replay `:90`, `:211`; the refusals `:44`, `:69`; the route `test/page-actions.spec.ts:69` |
| queued at an older head to queued at the page's head | `planLand` `src/page-requests.ts:87` (`:100-101`), update `src/ledger.ts:11389` | `land.requested` with `head` and `replaces` `:11390` | `test/page-requests.spec.ts:110` |
| queued, asked again at the same head or with none: nothing written | `planLand` `src/page-requests.ts:87` (`:103-104`) | none | `test/page-requests.spec.ts:102` |
| stopped to queued again | `planLand` `src/page-requests.ts:87` (`:92-98`); the record marked requeued `src/ledger.ts:11387`, the row updated `:11389` or inserted `:11388` | `land.requested` with `requeued: true` `:11390` | `test/land-node-2.test.mjs:51`; from the page `test/page-requests.spec.ts:110` |
| to queued, by the stage tick | `queueLandFromTick` `:2404`, insert `:2405`, from `stageTick` `:2313`, `:2377`; decision `decideLandQueue` `src/stage-tick.ts:77` | `stage.land-queued` `:2406` | `test/auto-land.spec.ts:34`; requeues `test/stage-tick.test.ts:168`, `:175` |
| queued to offered to a runner | `landJobs` `:11447`; queue route `src/index.ts:1890` | none | `test/land-job.spec.ts:25` |
| offered to running | `runLandTask` `cli/runner.mjs:5082`, `runLandJob` `cli/land-queue.mjs:264`. The server records no claim of a land job. | none | `test/land-job.test.mjs:33`, `:121` |
| attempt started | `startAttempt` `cli/land.mjs:365`, then `landEvent` `:6846`, `noteLandingStep` `:6893-6896` | `land.start` | `test/land-node.test.mjs:11` |
| join or leave the lease wait | `queueProjectLanding` `:5906` (`:5916`, `:5921`); CLI `cli/land.mjs:620`, `:507` | `landing.queued`, `landing.dequeued` | `test/stage-events.test.mjs:211` |
| lease taken, or a lapsed one taken over | `beginProjectLanding` `:5936`, write `:5980`; route `src/index.ts:2371`; CLI `cli/land.mjs:644-653`, `cli/commands/merge.mjs:442` | `landing.leased` `:5982`, with `replaced` on takeover | `test/land-routes.spec.ts:70`, `:90` |
| lease renewed | `renewProjectLanding` `:5995`; CLI `cli/land.mjs:724`, `:743` | none | `test/land-routes.spec.ts:90` |
| main confirmed under the lease | `confirmLeaseMain` `:6030`; route `src/index.ts:2363-2368` | none | `test/land-routes.spec.ts:300`; no CLI caller found |
| checkout lease taken, renewed, released | `takeCheckoutLease` `:6097`, `renewCheckoutLease` `:6122`, `releaseCheckoutLease` `:6138`; route `src/index.ts:2381-2385`; CLI `cli/checkout-lease.mjs:27`, `cli/checkout-hold.mjs:11`, `cli/commands/merge.mjs:216` | `checkout.leased`, `checkout.moved` `:6116`, `checkout.released` `:6148`; renew logs none | `test/checkout-lease.test.mjs:180`, `:229`, `:363` |
| merge begun (step `merge-main`) | `beginLandMerge` `:11400` (`:11414-11415`); route `src/index.ts:3159-3163`; CLI `cli/commands/merge.mjs:236` | none | `test/land-node.test.mjs:247` |
| Workflow stage recorded or instance replaced | `setLandingWorkflowStage` `:5818`, fenced to the recorded instance `:5807`; `claimLandingWorkflow` `:5794`; no production caller | none | written only by tests of what reads it: `test/land-routes.spec.ts:324`, `test/prereview.spec.ts:209` |
| merge reservation begun or cancelled | `beginLanding` `:5676` (`:5732`), with `assertLandingChecks` `src/landing-checks.ts:6`; `cancelLanding` `:5666` (`:5672`); route `src/index.ts:3461-3485` | `landing.begun`, `landing.cancelled` | `test/stage-events.test.mjs:243` |
| each step, and a failed step | `landEvent` `:6846` (`LAND_STEPS` `:478`, log `:6873`), `noteLandingStep` `:6890`; CLI `cli/land.mjs:1114`, `cli/commands/merge.mjs:200`, `:414`, `:543`, `:550`, `:601-667` | `land.<step>` | `test/land-routes.spec.ts:643`; failures `test/land-node.test.mjs:53`, `:77` |
| review verdict read | `landingVerdict` `src/landing-verdict.ts:33`, read `cli/land.mjs:982` | `land.review` | `test/land-node-2.test.mjs:138` |
| merged | `merged` `:6933`; `recordMerge` `:7612` | `item.merged` `:6960`, `:7636` | `test/land-node.test.mjs:11` |
| lease released | `cancelProjectLanding` `:6055` (`:6065`); CLI `cli/land.mjs:284`, `:546`, `cli/commands/merge.mjs:575` | `landing.released` | `test/land-routes.spec.ts:195` |
| queued to removed by cancel | `cancelLand` `:11425`, delete `:11436`; refused past the merge `:11431`; CLI `cli/commands/land.mjs:37` | `land.cancelled` `:11438` | `test/land-node-2.test.mjs:75` |
| queued to removed because the task merged or was abandoned | lazily in `landJobs` `:11459`; neither `merged` nor `abandon` deletes the row | none | `test/land-job.spec.ts:42`, `:72`, `:95` |
| queued at a head the task has left, to removed when a runner polls (t594) | `landJobs` `:11447` (`:11463-11468`), delete `:11465`; a job with no `at_head` is kept (`:11464`) | `land.stopped` with `reason: "stale_head"` and both heads `:11466` | `test/page-requests.spec.ts:187`; the command line's job kept `:201`; the page after it `test/page-actions.spec.ts:200` |

Rows enumerated with `grep -n land_jobs src/ledger.ts` (inserts `:2405`,
`:11388`; the update of `by`, `at` and `at_head` `:11389`; deletes `:11436`,
`:11459`, `:11465`; reads `:3270`, `:3331`, `:11434`, `:11450`), `grep -rn
page_requests src` (the table `src/page-requests.ts:28`, its prune and
select `:36-37`, its insert `:46-47`; no other file names it) and `grep -n
"INTO meta\|DELETE FROM meta" src/ledger.ts`, read for the keys
`landing`, `landing-record`, `landing-queue`, `landing-lease`, `lease-main`,
`checkout-lease`, `checkout-head` and `landing-workflow`. The last was
missing from the first draft; `deployed-main` (`:8736`) and `main-head`
(`:10913`) are the project's record of main, not a landing's.

### States reached by more than one path

- queued: the developer's command, the page's Land or the tick.
- the `land_jobs` row removed: `cancelLand` (`:11436`), the lazy drop of a
  merged or abandoned task in `landJobs` (`:11459`), or the drop of a page's
  job whose head moved (`:11465`).
- lease taken: `cli/land.mjs` or a manual `atelier merge`.
- merged: `merged` or `recordMerge`.
- `meta landing:ID` deleted: `merged` `:6952`, `recordMerge` `:7625`,
  `cancelLanding` `:5671`.
- `failedStep` set: by `cli/land.mjs` or by `cli/commands/merge.mjs`.
- `meta landing-workflow:ID` deleted: `merged` `:6953`, `abandon` `:7018`,
  `recordMerge` `:7626`.

### Transitions with no test

- The kind `land.cancelled` is never asserted in `test/`; the behaviour is
  tested at `test/land-node-2.test.mjs:75`.
- `confirmLeaseMain` has a route test and no CLI caller.
- The landing Workflow's record (`:5776-5826`) has no production writer at
  all; the tests that write it (`test/land-routes.spec.ts:324`,
  `test/prereview.spec.ts:209`) test the refusals that read it.

## 5b. The post-merge run

A landing with post-merge steps (checks, a deploy, a publication) carries a
second machine beside the land job: the run that executes those steps after
the merge is recorded. The developer's `atelier land` runs it; the server
holds every transition and refuses the next merge in the project until the
run is complete. The first draft of this report left it out.

### States and storage

| State | Stored as | Declared |
| --- | --- | --- |
| reserved, pending, running, failed, uncertain, complete | `state` inside the run's JSON, `meta post-merge:RUN` (`:6809`) | `PostMergeRun.state`, `src/post-merge.ts:40` |
| which run is a task's | `meta post-merge-item:ID` (`:6810`); deleted at `:5726` when the policy is cleared after a cancelled reservation | |
| the one run that blocks merges | `meta post-merge-active` (`:6811-6812`): set on every save, deleted when the run is complete | |
| the merge the run follows | `before` from the landing row (`:5728`); `after` null until the merge is recorded (`:6949`) | `src/post-merge.ts:38` |
| each step: pending, not_applicable, passed, waived | `steps[].outcome` | `src/post-merge.ts:42` |
| each attempt: running, uncertain, failed, passed, waived, with `commandOutcome`, `deployment`, `publication`, `retry` | `steps[].attempts[]` | `Attempt`, `src/post-merge.ts:28-36` |
| diff prepared | `paths`, null until prepared (`src/post-merge.ts:96`) | |
| every change | event `post-merge.<action>` with the whole run in its data (`:6813`): reserved, merged, prepared, start, command, finish, retry, skip, reconcile, uncertain, cancelled | |

The ledger does not compute the state: every write goes through
`savePostMerge` (`:6807`), which stores the run, points each member task at
it, sets or clears the active key and logs one event. The state itself is
set by the pure functions of `src/post-merge.ts`, which the ledger calls.

### Transitions

| Transition | Function | Event | Test |
| --- | --- | --- | --- |
| none to reserved, at the start of a landing with steps | `beginLanding` `:5727-5729` via `reservePostMerge` `src/post-merge.ts:83`; route `src/index.ts:3485` | `post-merge.reserved` | `test/post-merge.spec.ts:68`, `:148` |
| reserved to complete, landing cancelled before the merge | `cancelLanding` `:5668-5670`; refused once `after` is set `:5669`; route `src/index.ts:3475-3478` | `post-merge.cancelled` | `test/post-merge.spec.ts:204` |
| reserved, the merge recorded (`after` set, state unchanged) | `merged` `:6945-6950`; refused when the run is not reserved `:6948` | `post-merge.merged` | `test/post-merge.spec.ts:68`; the refusal with no reservation `:168` |
| reserved to pending, or to complete when no step applies | `preparePostMerge` `:6817` (`:6821`) via `src/post-merge.ts:92` (`:98`); route `src/index.ts:2407-2414`; CLI `cli/post-merge.mjs:179` | `post-merge.prepared` | `test/post-merge.spec.ts:68`; unit `test/post-merge.test.mjs:41` |
| pending to running | `postMergeAction` `:6829` via `startAttempt` `src/post-merge.ts:100` (`:106`); route `src/index.ts:2438`; CLI `cli/post-merge.mjs:198` | `post-merge.start` | `test/post-merge.spec.ts:68` (two racing starts, one refused) |
| running, the command's outcome recorded (state unchanged) | `:6830` via `recordCommand` `src/post-merge.ts:129`; CLI `cli/post-merge.mjs:204` | `post-merge.command` | `test/post-merge.spec.ts:181` |
| running to pending or complete, step passed | `:6831-6833` via `finishAttempt` `src/post-merge.ts:138` (`:145`); a deploy needs the version the route verified, `src/index.ts:2417-2437`; CLI `cli/post-merge.mjs:209` | `post-merge.finish` | `test/post-merge.spec.ts:68`, `:181` |
| running to failed | same `:145`; a failed check also logs the failing test names `:6834-6836` via `recordCheckFailure` `:7165`; CLI `cli/post-merge.mjs:209`, `:216` | `post-merge.finish`, `check.failed_tests` with `where: "main"` `:7168` | `test/post-merge.spec.ts:68`; the names `test/finding-cause.spec.ts:156` |
| running to uncertain, deadline passed | `expireAttempt` `src/post-merge.ts:88` (`:90`), run on every read by `postMergeRun` `:6789-6790`, and before a start `:101` or a recovery `:148` | `post-merge.uncertain`, from the read only | `test/post-merge.spec.ts:101`; unit `test/post-merge.test.mjs:63` |
| uncertain or running to failed, reconciled as no-effect | `:6839` via `recoverPostMerge` `src/post-merge.ts:152-162` (`:161`); CLI `cli/land.mjs:231` | `post-merge.reconcile` | `test/post-merge.spec.ts:101`; unit `test/post-merge.test.mjs:63` |
| uncertain or running to pending or complete, reconciled as completed | same `:161`; a deploy needs the verified deployment `:154-157`, `src/index.ts:2417` | `post-merge.reconcile` | no test |
| failed to pending, retry | `src/post-merge.ts:169-172`; CLI `cli/land.mjs:231`, then the executor `:236` | `post-merge.retry` | `test/post-merge.spec.ts:101`; unit `test/post-merge.test.mjs:41` |
| failed to pending or complete, step waived | `recoverPostMerge` `src/post-merge.ts:173-175`; the guard `:168` refuses running, uncertain and reserved and lets failed and pending through | `post-merge.skip` | `test/post-merge.spec.ts:68` (the waiver at `:91`); unit `test/post-merge.test.mjs:41` (`:57`) |
| pending to pending or complete, step waived: the next step has no attempt, or a retried one | same `:173-175`, through the same guard `:168`; `paths` is set once pending, so `:175` cannot give reserved | `post-merge.skip` | no test: every waiver in `test/` starts from failed or reserved |
| reserved with a recorded merge to reserved, pending or complete, step waived | same `:173-175`; the reserved waiver `:167` | `post-merge.skip` | `test/post-merge.spec.ts:127` (`:138`); unit `test/post-merge.test.mjs:77` (`:83`); CLI `:96` (`:99`) |
| refusal: a merge of another task while a run is not complete | `assertPostMergeFree` `:6802-6804`, from `beginLanding` `:5677`, `beginProjectLanding` `:5937`, `merged` `:6944`, `landedFast` `:7536`, `recordMerge` `:7594` | none | `test/post-merge.spec.ts:68`, `:127`; the CLI's wait on that refusal, against a fake server, `test/land-4.test.mjs:145` |
| a merged task's land job kept while the run is open, dropped when complete or failed | `landJobs` `:11458-11459` | none | `test/land-job.spec.ts:72`, `:95` |
| the executor runs each pending step in turn, then hands a failed check to the revert | `executePostMerge` `cli/post-merge.mjs:176-216`, from `cli/land.mjs:305` and `:236`; the barrier the land queue reads before starting another landing `cli/land-queue.mjs:131`, `:182` | the events above | `test/post-merge.test.mjs:164`, `:258`, `:381`; `test/land-queue.test.mjs:102`, `:137` |

Rows enumerated with `grep -n "run.state = " src/post-merge.ts` (`:90`,
`:98`, `:106`, `:145`, `:161`, `:172`, `:175`), the reservation at `:85`, and
`grep -n "savePostMerge(" src/ledger.ts` (`:5670`, `:5729`, `:6790`, `:6821`,
`:6840`, `:6950`); for each write the guard's starting states were read. The
guard at `:168` refuses running, uncertain and reserved, short of the
reserved waiver at `:167`, so retry and skip both start from failed or
pending; retry then refuses pending at `:170`, and skip does not. The first
draft wrote failed and reserved for the skip and missed pending, which the
second review caught.

### States reached by more than one path

- pending: prepared (`src/post-merge.ts:98`), a step passed with more to
  run (`:145`), reconciled as completed (`:161`), retry (`:172`), a waiver
  with more to run (`:175`), from failed or from pending.
- complete: prepared with no step applying (`:98`), the last step passed
  (`:145`), reconciled as completed (`:161`), the last step waived (`:175`),
  a reservation cancelled before the merge (`:5670`).
- failed: a step failed (`:145`) or reconciled as no-effect (`:161`).
- reserved, running and uncertain each have one entry.
- The kind `post-merge.uncertain` is logged by a read, `postMergeRun`
  (`:6790`), under the owner's name whoever asked; the other kinds are
  logged by the write that made them.

### Transitions with no test

- Reconciling an uncertain attempt as completed (`src/post-merge.ts:161`,
  resolution `completed`). No test in `test/` passes that resolution; the
  no-effect resolution is tested at `test/post-merge.spec.ts:101`.
- Waiving a pending step (`src/post-merge.ts:173-175`, entered with the run
  pending: the next step has no attempt, or a retried one). Every waiver in
  `test/` starts from failed (`test/post-merge.spec.ts:91`,
  `test/post-merge.test.mjs:57`) or from a reserved run with a recorded merge
  (`test/post-merge.spec.ts:138`, `test/post-merge.test.mjs:83`, `:99`); none
  from pending.

Also: `post-merge-item:ID` is deleted at `:5726` only when the policy is
cleared and the last run was a cancelled reservation; with the policy kept,
a complete run stays the task's run, and the next landing of the same task
reserves a new one (`:5727`), so one task can have two runs in `meta` and
only the latest reachable.

## 6. Ships and deploy steps

A ship has no row. Its id is generated in the CLI (`cli/ship.mjs:612`), and
its state is the sequence of events under that id, plus two notice tables, a
local file and a meta key for revert recovery.

### States and storage

| State | Stored as |
| --- | --- |
| begun | memory only: `ctx.began` (`cli/ship.mjs:636`, `cli/commands/ship.mjs:87`) |
| step started | event `action.started` (`src/actions.ts:224`) |
| approval consumed | event `action.consumed` (`src/actions.ts:216`) |
| approval active, consumed, withdrawn or expired | `action_approvals (n, id, json)` (`src/actions.ts:142`); `ApprovalStatus` `src/actions.ts:59`; the status is derived by `approvalStatus` `:62-66` from the row's `consumed` (`:56`, written at `:214`), `withdrawn` (`:55`) and `expiresAt` (`:54`) |
| step ran, passed or failed | event `action.ran` (`src/actions.ts:239`) |
| shipped, or failed at a step, with `warning` and `final` | event `ship.recorded` (`:6170`), read back by `deploys` `:6224` |
| final failure announced | `deploy_notices (ship, at)` (`:6167`, insert `:6171`) and event `deploy.failed_notice` (`:6173`) |
| deploy on landing: running, pending, deployed, waiting | the local file `<gitDir>/atelier-auto-deploy` (`cli/ship.mjs:808-851`, `cli/commands/ship.mjs:110-115`) |
| reverted, and the recovery: filing, recovering, complete | `revert_notices (merge, at)` (`:6203`, `:6213`), event `revert.notice` (`:6214`), `meta revert-recovery:MERGE` (`:12500`) |

### Transitions

| Transition | Function | Event | Test |
| --- | --- | --- | --- |
| refused before running | `ship` `cli/ship.mjs:549`, refusals `:607-608` | none | `test/ship.test.mjs:716`, `:318` |
| checkout lease taken | `holdCheckout` `cli/commands/ship.mjs:28` | `checkout.leased` | `test/checkout-lease.test.mjs:304` |
| begun | `cli/ship.mjs:636` | none | no test |
| approval given | `approveAction` `src/actions.ts:165`, insert `:178`; ledger `:7733`; route `src/actions-api.ts:37`; CLI `cli/commands/approve.mjs:27` | `action.approved` `src/actions.ts:179` | `test/actions.test.ts:60` |
| approval withdrawn, while active | `withdrawAction` `src/actions.ts:183`, write `:190`; ledger `:7743`; route `src/actions-api.ts:53`, `:66` | `action.withdrawn` `src/actions.ts:191` | `test/actions.test.ts:100` |
| approval consumed | `consumeAction` `src/actions.ts:198`; ledger `:7747`; route `src/actions-api.ts:47`; CLI `cli/ship.mjs:647` | `action.consumed` | `test/actions.test.ts:77` |
| step started | `startActionRun` `src/actions.ts:221`; CLI `cli/ship.mjs:620-627` | `action.started` | `test/ship-stuck.test.mjs:61` |
| step ran | `recordActionRun` `src/actions.ts:228`; CLI `cli/ship.mjs:615`, `:697` | `action.ran` | `test/ship.test.mjs:351` |
| step failed, ship failed | `cli/ship.mjs:717` to `deployed` `cli/commands/ship.mjs:49` to `POST /deploys` (`src/index.ts:2390-2393`) to `recordDeploy` `:6164` | `ship.recorded`, result `failed` | `test/checkout-lease.test.mjs:335` |
| delivery unconfirmed, failed at verify-delivery | `cli/ship.mjs:713`, `:728` | `ship.recorded` | `test/ship.test.mjs:414` |
| wrap failed after the deploy passed, shipped with a warning | `cli/ship.mjs:716` | `ship.recorded` with `warning` | `test/ship.test.mjs:1124` |
| shipped | `cli/ship.mjs:733` | `ship.recorded`, result `shipped` | `test/checkout-lease.test.mjs:304` |
| checkout lease lost, failed | `stayHeld` `cli/checkout-hold.mjs:28` via `cli/commands/ship.mjs:89` | `ship.recorded` | `test/checkout-lease.test.mjs:424` |
| process ended before finishing, failed | `onExit` `cli/commands/ship.mjs:45-48` | `ship.recorded` | no test |
| deploy on landing: claim, queued, waiting, deployed, superseded, final failure | `autoDeploy` `cli/ship.mjs:884` (`:886`, `:901`, `:913`, `:919`, `:926`); started by `deployOnLanding` `cli/post-merge.mjs:150` | the final failure writes `ship.recorded` with `final` and `deploy.failed_notice` | `test/auto-deploy.test.mjs:40`, `:137`, `:163`, `:309`, `:365`; `test/deploy-notice.spec.ts:33` |
| merge recorded as shipped | `recordMerge` `:7641-7644` | `action.ran`, step `recorded` | `test/record-merge.spec.ts` |
| revert notice, recovery filing | `recordRevertNotice` `:6192` (`:6210`); route `src/index.ts:2397-2399` | `revert.notice` | `test/auto-revert-ledger.test.mjs:211` |
| recovery filing to recovering to complete, on the tick | `resumeRevertRecoveries` `:4103` (`:4113`, `:4120`) | `item.dispatched` for the fix task | `test/auto-revert-ledger.test.mjs:125`, `:299` |
| revert could not land | `wake` `cli/post-merge.mjs:484` | `ship.recorded`, step `auto-revert` | `test/auto-revert-production.test.mjs:114` |

Rows enumerated with `grep -rn 'result: "failed"\|result: "shipped"'
cli/ship.mjs cli/commands/ship.mjs cli/post-merge.mjs` (eight writers of
`ship.recorded`, each a row above), `grep -n '"action\.' src/actions.ts`
(five kinds: approved `:179`, withdrawn `:191`, consumed `:216`, started
`:224`, ran `:239`; the first two were missing from the first draft) and
`grep -n "deploy_notices\|revert_notices" src/ledger.ts` (the inserts `:6171`
and `:6213`), with the two writes of the recovery record at `:4108` and
`:6211`.

### States reached by more than one path

- failed: six paths (`cli/ship.mjs:717`, `:728`, lease loss, `onExit`,
  `autoDeploy` `cli/ship.mjs:926`, `cli/post-merge.mjs:484`).
- shipped: with a warning (`:716`) or clean (`:733`).
- `action.ran`: from a ship or from a recorded merge.
- recovering: from the notice or from the tick.

### Transitions with no test

- `onExit`'s record "atelier ship ended before it finished".
- `deployStore.announced` (`cli/ship.mjs:838`) has no caller.

## 7. Runner runs and test slots

### States and storage

| State | Stored as |
| --- | --- |
| offered | `runner_offers (runner, json)` (`:1044`); live for 2 h, `OFFER_LIVE_MS` `src/dispatch/rules.ts:885` |
| dispatched | `items.dispatch` and `item.dispatched` (machine 1) |
| claimed, running | `items.state = 'claimed'`, `items.runner`; `meta claim-rollback:ID`, `meta runner-job:*` |
| last poll or heartbeat | `meta runner-polls` (`:4228`) |
| idle | `meta runner-idle:R`, valid 90 s (`src/dispatch/rules.ts:567`) |
| orphaned (no poll for `RUNNER_GONE_MS`, `src/dispatch/rules.ts:299`) | derived by `orphanedBy` `src/dispatch/rules.ts:312`; never written |
| ended without a result, gave up | `meta run-skip:ID:R` (`:4268`, `:4299`); derived by `endedRun` `src/dispatch/rules.ts:331` |
| claim refused | `meta claim-refused:ID:R` (`:4335`) |
| run report | `runs (id, json)` (`:1043`); outcomes `src/models/reliability.ts:33-39` |
| live log | `meta runner-log:ID` (`:3288`), `src/runner-log.ts:30` |
| told to forget a task's remembered stop | `meta runner-forget:R` (`:2533`); deleted once the runner's memory no longer holds the task, `:2504` |
| the offer by token, with its age | `meta runner-offer:TOKEN` (`:3431`), judged against `OFFER_LIVE_MS`; `runner-offer-polls:TOKEN` is deleted at `:3434` and written nowhere |
| the reports a poll authorised | `meta runner-report:TOKEN:ID:ACTOR:ROLE` (`:3447`), checked by `assertRunnerReport` `:3452` |
| a build's progress | `meta task-progress:ID` (`:3323`) |
| a core hold, since when and until | `meta core-holds` (`:4194`) |
| test slot: queued, started, claimed, idle-reserved | the host pool `/tmp/atelier-test-slots-v2/pool.sqlite`, table `pool(id = 1, data)` (`cli/load.mjs:15`, `:114`) |

No `run.*` or `runner.*` event kind exists. A run is visible in the ledger
only through the task's `item.*` events, the `runs` table and meta keys.
`docs/test-slots.md:27` names the pool path as
`/tmp/atelier-test-slots-v1.sqlite`; the code and `docs/runners.md:675` use
the v2 path.

### Transitions

| Transition | Function | Event | Test |
| --- | --- | --- | --- |
| offer recorded | `askQueue` `:2459` to `putRunnerOffer` `:2450`; route `src/index.ts:1817`, `:1837` | none | `test/runner-routes.test.mjs:670` |
| offer recorded by token, cut of forgotten tasks | `runnerPoll` `:3426` (`:3431`); `cutForgotten` `:2499` from `askQueue` `:2462`; route `src/index.ts:1884` | none | `test/runner-routes.test.mjs:1086` |
| a remembered stop forgotten | `forgetSkip` `:2518` (`:2529`, `:2533`); route `src/index.ts:1954`, and on a review request `:3100`; CLI `cli/commands/forget-skip.mjs:11`; the runner drops it at `cli/runner.mjs:4752` | none | `test/review-request-forget.test.mjs:126`; `test/runner-keeps.test.mjs:371` |
| report authorised | `runnerPoll` `:3447`; checked by `assertRunnerReport` `:3452` from `src/index.ts:5039-5059` | none | `test/claimed-task-review-offer.spec.ts:53` |
| progress recorded | `recordProgress` `:3304` (`:3323`); route `src/index.ts:1853-1857` | none | `test/progress.test.mjs:194`, `:318` |
| core hold begun, kept or dropped | `dispatchWaiting` `:4164` (`:4194`) | none | `test/dispatch-hold.spec.ts:52` |
| heartbeat | `recordRunnerPolls` `:4228`; route `src/index.ts:1864-1865`; CLI `cli/runner.mjs:5374`, `:5380` | none | `test/orphaned-claim.spec.ts:91` |
| dispatched | `dispatch` `:3756` | `item.dispatched` `:3794` | `test/runner-routes.test.mjs:717` |
| claimed | `claim` `:3546` | `item.claimed` `:3636` | `test/runner-routes.test.mjs:717` |
| claimed again by a new runner | `claim` `:3623-3630` | `item.runner_adopted` `:3629` | `test/ledger.spec.ts:888` |
| claim rolled back | `unclaim` `:4461` | `item.claim_failed` `:4475` | `test/ledger.spec.ts:413` |
| claim refused | `noteClaimRefusal` `:4322` | none | `test/queue-why.spec.ts:30` |
| run ended, report posted | `runOutcome` `cli/runner.mjs:4410`, `reportRun` `cli/runner.mjs:5406` to `POST /runs` `src/index.ts:1774` to `putRun` `:2132` | none | `test/reliability.spec.ts:55` |
| run reported by hand | `cli/commands/run-report.mjs:9` | none | `test/reliability.spec.ts:182` |
| ended without a result, gave up | `recordRunSkip` `:4284`; route `src/index.ts:3040-3052`; CLI `cli/runner.mjs:5484-5495` | `item.gave_up` `:4306`, only when not held | `test/core-hold-ended.spec.ts:25` |
| submitted | `submit` `:5128` | `item.submitted` `:5144` | `test/runner-routes.test.mjs:717` |
| released | `release` `:5462`; CLI `cli/runner.mjs:2404` | `item.released` `:5491` | `test/runner-routes.test.mjs:717` |
| released with the validation_blocked mark | `release` `:5471-5487` | `item.blocked` `:5487` | `test/validation-blocked-task.spec.ts:31` |
| orphaned, restored | derived, no write | none | `test/orphaned-claim.spec.ts:52` |
| held job offered back after a crash | `heldJobs` `:4401` | none | `test/core-hold-ended.spec.ts:98` |
| slot queued to started to claimed | `acquireSlot` `cli/load.mjs:168` (`:200-212`) | none | `test/load.test.mjs:96` |
| slot released or idle-reserved | `releaseSlot` `cli/load.mjs:225` (`:229-232`) | none | `test/load.test.mjs:317`, `:347` |
| idle reservation to claimed | `acquireSlot` `:181-188` | none | `test/load.test.mjs:317` |
| slot reclaimed (process gone or reservation expired) | `poolTransaction` `cli/load.mjs:129` | none | `test/load.test.mjs:75` |
| slot wait cancelled | `acquireSlot` `:218` | none | `test/load.test.mjs:86` |
| capacity set | `setSlotCapacity` `cli/load.mjs:143` | none | `test/load.test.mjs:227` |
| slot trial applied | `applySlotTrial` `src/runners/slot-trial.ts:54` | none | `test/slot-trial.test.mjs:90` |

Rows enumerated with `grep -n "INTO meta\|DELETE FROM meta" src/ledger.ts`,
read for every key named `runner-*`, `run-*`, `claim-*`, `task-progress` and
`core-holds`, with `grep -n "runner_offers\|INTO runs" src/ledger.ts`
(`:2133`, `:2451`, `:2529`) and `grep -n "function acquireSlot\|function
releaseSlot\|function poolTransaction" cli/load.mjs`. Five key families were
missing from the first draft: `runner-forget`, `runner-offer:TOKEN`,
`runner-report`, `task-progress` and `core-holds`.

### States reached by more than one path

- open again: `release` or `unclaim`.
- claimed: a fresh claim or a renewal.
- gave up: `recordRunSkip`, or implied by a release note starting with
  `GAVE_UP` (`:4305`).
- a slot leaves the pool on release or by reclamation.

### Transitions with no test

None found.

## 8. Stuck episodes

### States and storage

| State | Stored as |
| --- | --- |
| open, cleared | `stuck_episodes.kind`, only `opened` or `cleared` (`src/stuck/episodes.ts:10`); schema `:2253` |
| notified | `stuck_notices (project, key)` (`:2262`) and the ledger's `notices` key `stuck:…` (`:4857`) |
| latest observation | `stuck_ticks (project, at)` (`:2263`) |
| cause | `stuck_episodes.cause`, from `causeOf` `src/stuck/episodes.ts:15-18`: `ship`, `task-idle`, `orphan-lease`, `core-hold`, `runner-skip`, `orphaned-claim`, `runner-give-up`, `review-input-size`, `idle-runner`, and `task:`, `review:`, `review-unoffered:`, `review-skipped:` with the reason (`src/stuck/report.ts:86-251`) |

Until t533 (merged 2026-11-09, `b91b451d`) the digest went out as a push notification and left
no event; t518 (2026-11-07) deleted the older stuck-stage events. So the
ledger's events hold stuck episodes only from 2026-11-09, and the table is
the only record before that.

### Transitions

The timer runs every 10 minutes (`src/limits.ts:29`,
`src/runtime/server.mjs:226`) into `recordStuckEpisodes` `src/index.ts:3858`.

| Transition | Function | Event | Test |
| --- | --- | --- | --- |
| none or cleared to opened, with the next episode number | `reconcile` `src/stuck/episodes.ts:26` (`:33`); `recordStuckTick` `:2266` (`:2280`) | none | `test/stuck-episodes.test.ts:23`, `test/stuck-episodes.spec.ts:41` |
| opened to cleared, on a complete read only | `src/stuck/episodes.ts:34`; `:2273` | none | `test/stuck-episodes.spec.ts:59` |
| stale observation ignored | `:2270` | none | `test/stuck-episodes.spec.ts:110` |
| opened to notified, after 60 min or the standing `notice-delay` | `dueNotices` `src/stuck/notices.ts:16`; `stuckDue` `:2288`; `recordStuckDigest` `:4855` (`:4859`); `stuckNotified` `:2295`; `notifyStuck` `src/index.ts:3847` | `stuck.digest_notice` (`src/notify.ts:8`) | `test/stuck-episodes.spec.ts:137`, `:173` |
| read | `GET /stuck/episodes` `src/index.ts:1992-1995`; `openStuck` `src/stuck/view.ts:20`; `atelier status` reads it at `cli/status.mjs:356` | none | `test/stuck-view.test.mjs` |

Rows enumerated with `grep -n "stuck_episodes\|stuck_notices\|stuck_ticks"
src/ledger.ts`: three writes, the tick `:2271`, the episodes `:2280` and the
notices `:2297`, each a row above.

### States reached by more than one path

- opened: from none and from cleared, with a new episode number
  (`test/stuck-episodes.spec.ts:196`). The cause `runner-give-up` is written
  from two places (`src/stuck/report.ts:215`, `:232`).

### Transitions with no test

None found. `recordStuckEpisodes` itself is exercised only through the timer
(`test/timers.test.mjs:120`).

## The three cases of 2026-11-09

All three are the machines above behaving as their tests say they should.
None is a bug by the code's own account. Each is a transition whose effect
on a neighbouring column was decided once and never written down as part of
a machine, so the orchestrator met it as a surprise.

### Unblocking t595 left it claimed by the old builder, so a dispatch was refused

- `block` writes only `state` and `blocked` (`:5201`); a validation block
  does the same (`:5486`). Neither touches `owner`, `runner` or `dispatch`.
- `unblock` writes `state = blocked.from` and clears `blocked` (`:5236`).
  The task comes back claimed, owned by its old builder, with its dispatch
  intact. `test/validation-blocked-task.spec.ts:54` requires exactly this:
  "unblocking it offers it back to its holder's runner".
- `atelier dispatch` on that task hits `refuseLiveHolder` (`:3834`), which
  throws `held` at `:3841` unless `--release` is given or the runner is
  orphaned (`:3839`). While the task is still blocked, `assertDispatchable`
  (`src/dispatch/rules.ts:742-746`) throws `not_open` instead. A claim by
  anyone else is refused by `assertClaimable` (`src/rules.ts:1173-1174`).
- Machine 1, state claimed, reached by unblock. The ledger counts it with
  `item.unblocked` events whose `data.to` is `claimed`.

### Release keeps the dispatch, so a runner claims again within seconds

- `release` writes `owner: null, state: "open"` (`:5490`). `update` nulls
  `runner` (`:11860-11861`) and clears `dispatch` only for merged or
  abandoned (`:11826-11833`). The comment at `:3956-3957` states the rule:
  a released task "waits in the queue again".
- `log` calls `dispatchWaiting()` after every `item.*` event (`:12283`),
  and `dispatchWaiting` (`:4164-4165`) selects open, unowned tasks with a
  dispatch. The next runner poll claims it. `test/validation-blocked-task.spec.ts:76`
  requires released tasks to appear in `waiting()`.
- Machine 1, state open, reached by release with `dispatch` carried over.
  The ledger counts it with an `item.claimed` within 60 s of an
  `item.released` on the same task.

### A queued land job records no head

- As seen on 2026-11-09, before t594 merged (`ff8ac5c1`, the same day):
  `land_jobs` had the columns `item, by, at` and `quote`, and both inserts
  recorded only those.
- At this commit's parent the columns are `item, by, at, quote` and
  `at_head` (`:1102`, `:1104`, `:1106`). The command line's `atelier land
  --queue` still records no head: its route passes no shown head
  (`src/index.ts:3172`), `planLand` writes `head: null`
  (`src/page-requests.ts:91`, `:106`) and the insert stores it
  (`src/ledger.ts:11388`); `test/page-requests.spec.ts:201` requires that job
  to be offered whatever the head becomes. The tick's insert (`:2405`) names
  no head column either: it puts the head in the `stage.land-queued` event's
  data (`:2406`) and nowhere in the row. Only the page's Land fills
  `at_head` (`src/index.ts:4393`), and `landJobs` drops that job once the
  head moves (`:11464-11467`).
- For a job with no `at_head`, the head is read back from the item each
  time: `landJobs` hands the runner the item with its own `head` (`:11473`);
  `cli/land.mjs:789-790` starts the attempt from `acceptedHead` or `head`;
  `noteLandingStep` falls back to `item.head` (`:6895`, `:6901`); the stage
  tick matches its queueings by the event's head (`:2367`). So a job the
  command line or the tick queued lands whatever head the task has when a
  runner takes it, and nothing can say which head was asked for.
- Machine 5, state queued. Every `land.requested` since 2026-11-01 whose
  data has no `head` is a count of this case; before `ff8ac5c1` that is
  every one.

## Ranking by measured harm since 2026-11-01

### What the ledger would count, and how

Run each from a checkout with the developer's credentials. Dates are the
window `--from 2026-11-01`. The output of each is a number, or a short
table of numbers by kind or cause.

Rejections:

```sh
atelier events --project atelier --from 2026-11-01 --kind review.rejected | jq length
```

Repairs, and which task each repairs (attribution to a machine needs the
repaired task's title, read with `atelier show`):

```sh
atelier events --project atelier --from 2026-11-01 --kind item.fix_of | jq length
atelier events --project atelier --from 2026-11-01 --kind item.fix_of | jq -r '.[] | "\(.item) repairs \(.data.itemId)"'
```

Stuck episodes by cause, from the digest events (only since 2026-11-09, see
machine 8; the full table is behind `GET /api/projects/atelier/stuck/episodes`,
which no CLI command prints whole):

```sh
atelier events --project atelier --from 2026-11-01 --kind stuck.digest_notice \
  | jq '[.[].data.episodes[]] | group_by(.cause) | map({cause: .[0].cause, n: length})'
```

Recorded workarounds. The ledger has no kind for a workaround; these are
the orchestrator's moves that the handbook names as such
(`docs/orchestrating.md:1038-1107`), each recorded as an event:

```sh
# dispatch --release, a claim taken back
atelier events --project atelier --from 2026-11-01 --kind item.released \
  | jq '[.[] | select(.data.note | startswith("taken back by the developer"))] | length'
# dispatch --overlap-ok, a hold overridden
atelier events --project atelier --from 2026-11-01 --kind item.dispatched \
  | jq '[.[] | select(.data.overlapOk == true)] | length'
# a conflict sent back as a merge-main job
atelier events --project atelier --from 2026-11-01 --kind item.dispatched \
  | jq '[.[] | select(.data.job == "merge-main")] | length'
# the server could not send a rejection back on its own
atelier events --project atelier --from 2026-11-01 --kind item.redispatch_refused_notice | jq length
```

The post-merge run (machine 5b):

```sh
# finishes that left the run failed, then the same by the step that failed
atelier events --project atelier --from 2026-11-01 --kind post-merge.finish \
  | jq '[.[] | select(.data.run.state == "failed")] | length'
atelier events --project atelier --from 2026-11-01 --kind post-merge.finish \
  | jq '[.[] | select(.data.run.state == "failed") | (.data.run.steps | map(select(.outcome == "pending")) | first | .name)] | group_by(.) | map({step: .[0], n: length})'
# the developer's recoveries: retries, waivers and reconciliations
atelier events --project atelier --from 2026-11-01 --kind post-merge.retry --kind post-merge.skip --kind post-merge.reconcile \
  | jq 'group_by(.kind) | map({kind: .[0].kind, n: length})'
# attempts that went uncertain (executor died or timed out)
atelier events --project atelier --from 2026-11-01 --kind post-merge.uncertain | jq length
```

A merge refused because another run was open (`post_merge_blocked`) is a
refusal, not an event, so its count is not measurable from the ledger.

The three cases:

```sh
# unblocks that returned a task to its old holder
atelier events --project atelier --from 2026-11-01 --kind item.unblocked \
  | jq '[.[] | select(.data.to == "claimed")] | length'
# a claim within 60 s of a release on the same task
atelier events --project atelier --from 2026-11-01 --kind item.released --kind item.claimed \
  | jq '[group_by(.item)[] | sort_by(.seq) | . as $e | range(1; length) as $i
        | select($e[$i].kind == "item.claimed" and $e[$i-1].kind == "item.released"
          and ((($e[$i].at | sub("\\.[0-9]+Z$"; "Z") | fromdate) - ($e[$i-1].at | sub("\\.[0-9]+Z$"; "Z") | fromdate)) < 60))] | length'
# land requests that record no head (every one before t594 merged, 2026-11-09)
atelier events --project atelier --from 2026-11-01 --kind land.requested \
  | jq '[.[] | select(.data.head == null)] | length'
```

None of these could be run here: the workspace holds no ledger and the task
forbids `atelier` commands. The orchestrator runs them after deploy and
fills the ledger column of the table below.

### What git history counts

Main's history since 2026-11-01 is in the workspace. The merged tasks of the
window, read by title and assigned to the machine each repaired, are the
proxy for repairs. Each command was run at `c86e6077`.

```sh
git log --since=2026-11-01 --format=%s | grep -c '^Merge t'
```

Output: `114`.

```sh
git log --since=2026-11-01 --format=%s | grep -ciE '^t[0-9]+ fix|^fix\b|^fix\(|^repair'
```

Output: `21` (fix rounds and repairs committed inside tasks, the rework a
rejection or a failed check caused).

```sh
git log --since=2026-11-01 --format=%s | grep -c '^Merge main at\|^Merge baseline\|^Merge main into'
```

Output: `94` (merges of main into task branches: each is a conflict or a
rebase the landing machine demanded).

```sh
git log --since=2026-11-01 --format=%s -- src/post-merge.ts cli/post-merge.mjs | wc -l
git log --since=2026-11-01 --format=%s -- src/post-merge.ts cli/post-merge.mjs | grep -ci revert
git log --since=2026-11-01 --format=%s | grep -c '^Merge t524'
```

Output: `16`, `10`, `1`. Sixteen commits touched the post-merge run's two
files; ten of them are t524's automatic revert, which hangs off a failed
post-merge check, and the rest are t519's deploy on landing (machine 6),
t536's failing test names and t460's runner logs. Each command was run at
`928978c0`.

The 114 merged tasks, by the machine their title names:

| Machine | Merged repairs | Tasks |
| --- | --- | --- |
| 2 Review requests and reviews | 19 | t566 t513 t502 t496 t495 t554 t523 t571 t536 t436 t431 t437 t455 t445 t446 t421 t531 t441 t505 |
| 7 Runner runs and test slots | 19, of which 5 concern the run or slot machine itself (t336 t465 t480 t528 t590); the rest are the suite's health on the runners | t595 t590 t570 t573 t336 t465 t458 t486 t480 t483 t479 t485 t453 t478 t516 t528 t460 t482 t489 |
| 1 Task lifecycle | 16 | t583 t539 t548 t537 t538 t522 t510 t503 t335 t456 t443 t432 t419 t521 t434 t435 |
| 6 Ships and deploy steps | 12 | t584 t515 t519 t501 t475 t481 t472 t468 t447 t439 t452 t293 |
| 5 Land jobs and landing | 9 | t520 t512 t517 t509 t451 t450 t429 t547 t466 |
| 8 Stuck episodes | 6 | t474 t467 t427 t461 t518 t430 |
| 3 Criteria reviews | 2 | t535 t504 |
| 5b The post-merge run | 1 (the first draft counted it under machine 6) | t524 |
| 4 Pre-reviews | 0 | |
| none (pages, docs, usage, help) | 30 | the rest |

Of the 21 fix-round commits, the seven that name their task (t586 twice,
t585, t562 three times, and the fix-round claim test of t539) are rework
after a rejection; the rejection loop is machine 2's, whatever the task was
about.

### The ranking

| Rank | Machine | Git proxy | Ledger count | Why it ranks here |
| --- | --- | --- | --- | --- |
| 1 | 2 Review requests and reviews | 19 merged repairs, 7 named fix rounds | rejections, not measurable here | The most repairs, and structurally the worst: seven states, eight flag columns of which two are never written, fifteen writes to one state from twelve functions, one event kind for two states, two stale comments. Every rejection and every rework round passes through it. |
| 2 | 1 Task lifecycle | 16 merged repairs | unblock-to-claimed and release-then-claim, not measurable here | Two of the three cases of 2026-11-09. Six of eight states have more than one entry; owner, dispatch and blocked are four columns read as one machine and written separately. |
| 3 | 7 Runner runs and test slots | 19 by title, 5 on the machine itself | gave-ups and claim refusals, not measurable here | The raw count is the suite's health on the runners, not the run machine. The machine itself is small and fully tested, with no event of its own. |
| 4 | 6 Ships and deploy steps | 12 merged repairs | failed `ship.recorded`, not measurable here | No row at all: state is events, a local file and memory. Failed is reached six ways. |
| 5 | 5 Land jobs and landing | 9 merged repairs, 94 merges of main into branches | land requests with no head, not measurable here | One of the three cases. Eight meta keys and a table with no state column, whose head column only the page's Land fills (t594). |
| 6 | 8 Stuck episodes | 6 merged repairs | episodes by cause, only since 2026-11-09 | Two states, well tested; its history was lost twice this month (t518, t533). |
| 7 | 3 Criteria reviews | 2 merged repairs | criteria rejections, not measurable here | One hidden state (lapsed as failed with a text search). |
| 8 | 5b The post-merge run | 1 merged repair, 16 commits to its files | failed finishes and recoveries, not measurable here | The best-written of the nine: a closed state list, one save function, one event per change. Its two untested transitions are the reconcile-as-completed path and the waiver of a pending step; its harm is that an open run blocks every merge in the project. |
| 9 | 4 Pre-reviews | 0 | pre-review outcomes, not measurable here | Nine states and the most write paths per state, but no repair this month traced to it. |

Adding the post-merge run moved no rank above it: it enters at 8 of 9 with
one merged repair, and machine 6 drops from 13 to 12 and stays fourth.
The ledger counts may reorder ranks 1 to 3. The git proxy counts repairs
that merged; it does not count rejections, nor the orchestrator's workaround
moves, which only the ledger holds.

The second fix round added the waiver of a pending step (machine 5b), the
holder's renewal of its claim of a submitted task (machine 1), the landing
Workflow's record (machine 5), the approval events (machine 6) and five `meta`
key families of the runner (machine 7). None changes a harm figure: the git
proxy counts merged tasks by title and the ledger commands count events by
kind, and no added row adds or removes a task or an event kind from those
counts. The ranking is unchanged.

The third fix round corrected the holder's renewal (machine 1) and the
approval's `consumed` field (machine 6), moved every line to this commit's
parent, and added to machine 5 the page's Land, its replay record and the
stale-head drop that t594 brought. The git commands above were run at
`c86e6077` and `928978c0`; run at `ff8ac5c1`, the main this parent merges,
the first prints `116` and the third `97`: the two tasks merged since are
t565 (criteria reviews, machine 3, from 2 to 3) and t594 (machine 5, from 9
to 10), with three more merges of main into branches. The fix-round count
and the post-merge files' count are unchanged (`21`, `16`). No rank moves:
machine 3 stays below machine 8, and machine 5 stays between machines 6
and 8.

## The top machine, and the table it would need

By the measurable record, the top machine is review requests and reviews.

An explicit table for it would hold one row per ask: the task, the head, the
reviewer asked, the criteria revision the ask is bound to, and one `state`
from a closed list (open, claimed, answered, released, no_verdict, lapsed,
withdrawn), with `entered_at` and `entered_by` for the current state. It
would carry one `cause` for how the row left open or claimed, in place of
today's eight flags: head moved, criteria changed, model held, developer
withdrew, every runner skipped, task closed, redirected, lapsed, released
without a verdict. It would name its predecessor when it was carried from a
moved or superseded ask, and its successor when one was made, so a review
asked for is one chain, not fifteen withdrawals. It would hold the same-exit
count and the stop that `stopped` was meant to hold and never did, so the
runner's refusal to retry a reviewer that keeps failing has a record. And
every write would go through one function that records the ask's own event
with the state it entered, so `review.expired` and `review.released` each
mean one thing.
