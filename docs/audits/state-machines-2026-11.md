# Atelier's implicit state machines, November 2026

PAVI asked (2026-11-09) for a read-only inventory of the state machines
Atelier runs without writing them down, ranked by measured harm, as the first
of four steps: this inventory, PAVI's pick of the worst, one design note and
task for it, and a repeat only if that measurably cut rework. This report
changes no code.

Every `file:line` below is read at main as it stood when this report was
written, commit `c86e6077` (Merge t595), the parent of the commit that adds
this file. The fix round that added the post-merge run (section 5b) was
written on main at `928978c0` (Merge t565), the parent of that fix commit;
between the two, `src/ledger.ts` changes two lines in place at `:3436-3437`
and `src/index.ts` gains two lines at `:4121-4123`, after every line this
report cites, so every number holds at both. Unless a path is given, a bare
line number is in `src/ledger.ts`. A test is named by the line of its `it(`
or `test(` call.

## How to read this report

Each machine has three tables: its states and where each is stored, its
transitions with the function that makes them, the event each records and
the test that enters it, and a short list of states reached by more than one
path and transitions no test covers. The three cases PAVI saw on 2026-11-09
are traced in their own section. The ranking comes last, with the commands.

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

| Machine | Where its state lives | States | Transition sites | States with more than one entry path | Transitions with no test |
| --- | --- | --- | --- | --- | --- |
| 1 Task lifecycle | `items.state`, `items.owner`, `items.dispatch`, `items.blocked`, derived `events.stage` | 8 stored, 12 derived stages | 29 | 6 of 8 | 0 |
| 2 Review requests and reviews | `review_requests.state` plus 8 flag columns, `reviews` | 7 | 24 | 4 | 3 |
| 3 Criteria reviews | `criteria_reviews.state`, `criteria_revisions`, `criteria_resolutions` | 6 | 12 | 2 | 3 |
| 4 Pre-reviews | `prereviews.state`, `same_exits` | 9 | 22 | 5 | 3 |
| 5 Land jobs and landing | `land_jobs` (no state column), 7 `meta` keys, events | 8 | 21 | 6 | 2 |
| 5b The post-merge run | `meta post-merge:RUN` JSON, `meta post-merge-item:ID`, `meta post-merge-active`, events `post-merge.*` | 6, plus step and attempt outcomes | 15 | 3 of 6 | 1 |
| 6 Ships and deploy steps | events only, `deploy_notices`, `revert_notices`, a local file, `meta` | 7 | 19 | 4 | 2 |
| 7 Runner runs and test slots | `runs`, `runner_offers`, 6 `meta` key families, host SQLite pool | 10 | 22 | 4 | 0 |
| 8 Stuck episodes | `stuck_episodes.kind`, `stuck_notices`, `stuck_ticks` | 4 | 5 | 1 | 0 |

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
| open, claimed, submitted, accepted, integrated, merged, abandoned, blocked | `items.state` (schema `:1041-1045`) | `ItemState`, `src/rules.ts:17` |
| held by someone | `items.owner`; every non-null write goes through `assignOwner` `:3639`, enforced by the SQL triggers at `:1141-1153` | |
| queued for a runner | `items.dispatch` (`:1115`), kept after a claim as the record | `Dispatch`, `src/dispatch/rules.ts` |
| which runner holds the claim | `items.runner` (`:1116`); reset to null on any owner change, `:11833-11834` | |
| blocked, and the state to return to | `items.blocked` JSON with `from` (`:1165`); `Block`, `src/rules.ts:119-139` | |
| claim in flight | `items.claim_gen`, `items.claim_pending` (`:1130-1138`) | |
| waiting on other tasks | `items.blocked_by` (`:1193`) | |
| the stage after each change | `events.stage` (`:1107`), written at `:12242-12245` from `stageNow` `:12215` | `STAGES`, `src/rules.ts:2273`: filed, agreed, queued, building, built, checked, reviewed, landable, landed, shipped; `eventStage` `src/rules.ts:2326` adds blocked and abandoned |

The stored states and the derived stages are two vocabularies for one
machine. "checked" and "landable" are never stored on the item: `stageOf`
(`src/rules.ts:2293`) computes them from evidence, reviews and policy each
time an event is logged, and only the result lands in `events.stage`.

### Transitions

| Transition | From, to (owner, dispatch, blocked) | Function | Event | Test |
| --- | --- | --- | --- | --- |
| create | none to open | `newItem` `:2862`, insert `:2898`; parts `:8876` | `item.created` `:2904` | `test/stage-events.test.mjs:82` |
| claim | open or claimed to claimed; owner set, `claim_gen` up, `claim_pending` set | `claim` `:3539` via `assignOwner` `:3626`; rules `assertClaimable` `src/rules.ts:1167`, `assertDispatchedClaim` `src/dispatch/rules.ts:842` | `item.claimed` `:3629` | `test/ledger.spec.ts:389` |
| claim renewed, runner adopted | claimed to claimed | `claim` `:3615-3622` | `item.runner_adopted` `:3622` | `test/ledger.spec.ts:888` |
| claim rolled back (branch failed) | claimed to the saved prior state; owner null | `unclaim` `:4454`, write `:4466`; caller `src/index.ts:1367` | `item.claim_failed` `:4468` | `test/ledger.spec.ts:413` |
| release | claimed or submitted to open; owner and runner null; dispatch kept | `release` `:5455`, write `:5483`; rule `releaseAllowed` `:5406` | `item.released` `:5484` | `test/validation-blocked-task.spec.ts:76` |
| release with the validation_blocked mark | claimed or submitted to blocked; owner, runner and dispatch kept | `release` `:5464-5480`, write `:5479`; rule `validationBlockReason` `src/rules.ts:1520` | `item.blocked` with `validationBlocked: true` `:5480` | `test/validation-blocked-task.spec.ts:31` |
| handoff | claimed, submitted or accepted to claimed; owner changed | `handoff` `:5445` via `assignOwner` `:5450`; rule `assertHandoffTarget` `src/rules.ts:918` | `item.handoff` `:5451` | `test/ledger.spec.ts:445`, accepted at `:467` |
| submit | claimed or submitted to submitted | `submit` `:5121`, write `:5136` | `item.submitted` `:5137` | `test/ledger.spec.ts:965` |
| push | claimed stays, submitted stays, accepted to claimed | `recordPush` `:4651`, write `:4670-4675` | `push.observed` `:4676` | `test/ledger.spec.ts:1083` |
| block by hand | open, claimed or submitted to blocked; owner and dispatch kept | `block` `:5184`, write `:5194`; rule `assertBlockable` `src/rules.ts:1416` | `item.blocked` `:5195` | `test/ledger.spec.ts:1372` |
| block at the review round cap | submitted to blocked | `holdAtRoundCap` `:5092`, write `:5101`; rule `roundCapHold` `src/rules.ts:3103` | `item.blocked` `:5102`, `review.round_cap` `:5103` | `test/review-convergence.spec.ts:59` |
| block when approved criteria cannot dispatch | open to blocked | `dispatchApprovedCriteria` `:4045`, write `:4071` | `item.blocked` `:4072` | `test/dispatch-on-approval.spec.ts:129` |
| block a plan part | part state to blocked | `blockPart` `:9179`, write `:9182` | `item.blocked` `:9183` | `test/review-requests.spec.ts:199` |
| unblock | blocked to `blocked.from`; owner and dispatch untouched | `unblock` `:5210`, write `:5229` | `item.unblocked` `:5230` | `test/validation-blocked-task.spec.ts:54` |
| unblock for criteria | blocked to `from` | `unblockForCriteria` `:10715`, `clearCriteriaBlocksForFast` `:10727` | `item.unblocked` `:10719`, `:10735` | `test/criteria-review.spec.ts:579` |
| unblock by rerouting a part's reviewer | blocked part to submitted | `rerouteReviewer` `:8501`, write `:8529` | `item.unblocked` `:8530` | `test/model-roles.spec.ts:374` |
| accept | submitted or accepted to accepted; `accepted_head` set | `accept` `:5515`, write `:5575`; rule `gate` `src/rules.ts:2204` | `item.accepted` `:5583` | `test/ledger.spec.ts:135` |
| a review of accepted work | accepted to submitted | `addReview` `:4907`, write `:5024` | `review.approved` or `review.rejected` `:5025` | `test/ledger.spec.ts:135` |
| criteria change on accepted work | accepted to claimed; an open queued build undispatched | `criteriaChanged` `:3040`, writes `:3075`, `:3082` | `item.criteria_changed` `:3084`, `item.undispatched` `:3076` | `test/ledger.spec.ts:1723` |
| task refresh of accepted work | accepted to submitted; `accepted_head` cleared | `taskRefreshed` `:11641`, write `:11676` | `item.refreshed` `:11682` | `test/task-refresh.spec.ts:115` |
| merge | accepted to merged; owner, dispatch and token cleared | `merged` `:6926`, write `:6948`; a plan's parts `:6970` | `item.merged` `:6953`, `:6971` | `test/ledger.spec.ts:135` |
| merge recorded from outside | any live state to merged | `recordMerge` `:7605`, write `:7617` | `item.merge_recorded` `:7626`, `item.merged` `:7629` | `test/record-merge.spec.ts:69` |
| landed fast | any open state to merged | `landedFast` `:7520`, write `:7532`; no CLI caller found | `item.landed_fast` `:7534`, `item.merged` `:7535` | `test/fast-mode.spec.ts:104` |
| plan completed | plan to merged | plan `tick` `:8923`, write `:8942` | `plan.completed` `:8944` | `test/plans.spec.ts:429` |
| abandon | any open state to abandoned; owner, blocked and dispatch null | `abandon` `:7004`, write `:7009` | `item.abandoned` `:7012` | `test/ledger.spec.ts:445` |
| plan stopped | its parts to abandoned | `stopPlan` `:8569`, write `:8578` | `item.abandoned` `:8580`, `plan.stopped` | `test/plans.spec.ts:429` |
| part integrated | submitted part to integrated | `integratePart` `:10833`, write `:10852` | `part.integrated` `:10856` | `test/integration.spec.ts:117` |
| integration failed | submitted part to open; owner null | `integrationFailed` `:10874`, write `:10884` | `integration.failed` `:10885` | `test/integration.spec.ts:148` |
| part rework after a rejection | submitted part to open; owner null | `reworkPart` `:5112`, write `:5115` | `review.rework` `:5116` | `test/review-requests.spec.ts:199` |
| pre-review rework | submitted to claimed; owner kept | `deliverPrereviewRework` `:6690`, write `:6703` | `prereview.rework` `:6704` | `test/prereview.spec.ts:209` |
| plan reopened | plan submitted or accepted to open | `reopenPlan` `:10997`, write `:10999` | `plan.reopened` `:11000` | `test/plan-reopen.spec.ts:206` |
| dispatch | sets `dispatch`; a held claimed, submitted or accepted task is first released to open with `--release` | `dispatch` `:3749`, holder release `:3780-3784`, `setDispatch` `:8833`; rules `assertDispatchable` `src/dispatch/rules.ts:742`, `overlapRefusal` `:479` | `item.released` with the taken-back note `:3784`; `item.dispatched` `:3787` | `test/ledger.spec.ts:766`; held `:832`; refused `:749` |
| overlap hold released | dispatch only | `releaseHold` `:3845`; rule `retainDispatch` `src/dispatch/rules.ts:224` | `item.dispatched` with `retained: true` `:3861` | `test/retain-dispatch.test.ts:151` |
| undispatch by the developer | open; dispatch null | `undispatch` `:3937`, write `:3957` | `item.undispatched` `:3958` | `test/ledger.spec.ts:928` |
| undispatch by the server | dispatch null | `withdrawHeldDispatch` `:2053`, `withdrawForeignDispatches` `:2563`, `approvePlan` `:8369`, plan `tick` `:8933`, `:8957`, `:9023`, `:9031`, `plannerTick` `:11172` | `item.undispatched` at `:2060`, `:2572`, `:8422`, `:8934`, `:8958`, `:9024`, `:9032`, `:11179` | `test/review-requests.spec.ts:1128` |

Every event is written by `log` (`:12230`), which also calls
`dispatchWaiting()` after each `item.*` or `plan.*` event (`:12256`), so a
release re-enters the queue in the same write. The queue itself is
`dispatchWaiting` `:4157`: open, no owner, a dispatch (`:4158`). A blocked
task's job goes back to its holder's runner through `heldJobs` `:4394`
(`:4422-4423`).

### States reached by more than one path

- open: create (`:2898`, `:8876`), release (`:5483`), taken back by a
  dispatch (`:3783`), claim rollback (`:4466`), integration failed
  (`:10884`), part rework (`:5115`), plan reopened (`:10999`), unblock when
  `from` was open (`:5229`, `:10718`, `:10734`).
- claimed: claim (`:3626`), handoff (`:5450`), push on accepted work
  (`:4672`), criteria change on accepted work (`:3082`), pre-review rework
  (`:6703`), unblock (`:5229`, `:10718`, `:10734`), claim rollback to a
  claimed snapshot (`:4466`).
- submitted: submit (`:5136`), review of accepted work (`:5024`), task
  refresh of accepted work (`:11676`), reroute unblock (`:8529`), unblock
  (`:5229`).
- blocked: by hand (`:5194`), validation block (`:5479`), round cap
  (`:5101`), criteria dispatch refused (`:4071`), part block (`:9182`).
- merged: merge (`:6948`), a plan's parts (`:6970`), landed fast (`:7532`),
  recorded merge (`:7617`), plan completion (`:8942`).
- abandoned: abandon (`:7009`), plan stopped (`:8578`).
- accepted and integrated each have one entry.

### Transitions with no test

None found. The first draft of this report listed the task refresh that
returns accepted work to submitted (`:11676`); `test/task-refresh.spec.ts:115`
enters it, asserting the submitted state, the cleared acceptance and the
`item.refreshed` event.

## 2. Review requests and reviews

### States and storage

| State | Stored as | Declared |
| --- | --- | --- |
| open, claimed, answered, withdrawn, lapsed, released, no_verdict | `review_requests.state` (schema `:1203-1206`) | `ReviewRequestView`, `src/review/needed.ts:34` |
| which head, which reviewer, who claimed, when | `review_requests.head`, `.dispatch`, `.claimedBy`, `.claimedAt` (`:9520`; renewed `:10095`) | |
| asked by name | `.wanted` (`:9869`) | |
| withdrawn because the head moved | `.moved` (`:9981`) | |
| made by carrying a moved request | `.carried` (`:3127`, `:10032`) | |
| asked about criteria the task has left | `.superseded` (`:3065`) | |
| the developer withdrew it | `.developerWithdrawnAt` (`:10155`) | |
| stop record and same-exit count | `.stopped`: read at `:7499`, `:7784`, `:9227`, `:9256`, `:9295`, `:9468`, `:9493`; never written. `stopAfter` is imported at `:99` and never called | |
| when it last became open | `.openedAt`: read at `:7852`; never written | |
| the verdict | `reviews` (schema `:1049-1051`, columns `head` and `approve` `:1074-1083`), inserted `:5022` and `:4751` | |

Two columns, `stopped` and `openedAt`, are part of the machine on paper and
not in practice: nothing writes them, so the `review_stopped` refusal at
`:9494` fires only for rows older ledgers hold, and the same-exit count that
`:9259` reads for code reviews is always absent. The header of
`src/review/stopped.ts:1-9` describes a release that opens a successor,
which no code does.

### Transitions

| Transition | Function | Write | Event | Test |
| --- | --- | --- | --- | --- |
| to open, asked by the developer or by land | `askReview` `:9688` via `requestReview` `:9643`, `requestReviews` `:9666`, `askCheckedReview` `:2378`, `askSubmissionReview` `:3701`, `askPostMergeReview` `:6989` | `:9869` | `review.requested` `:9870`, `review.asked_together` `:9678` | `test/review-requests.spec.ts:469` |
| to open, a plan part's tick | `reviewTick` `:9049` | `:9163` | `review.requested` `:9171` | `test/review-requests.spec.ts:97` |
| to open, carried after the head moved | `reaskReview` `:10005` | `:10032` | `review.requested` via `head-moved` `:10034` | `test/review-head-moves.spec.ts:89` |
| to open, carried after criteria changed | `reaskForCriteria` `:3104` | `:3127` | `review.requested` via `criteria-changed` `:3129` | `test/review-head-moves.spec.ts:233` |
| open to claimed | `bindReview` `:9443` from `claimReview` `:9386` | `:9520` | `review.claimed` `:9522` | `test/review-requests.spec.ts:112` |
| claimed or open to answered | `answerReviewRequest` `:9940` from `addReview` `:4907` | `:9942`, `:9950`, `:9954` | `review.approved` or `review.rejected` `:5025` | `test/review-requests.spec.ts:136` |
| claimed tier request to answered | `addReview` | `:5028` | same | no test (tier requests exist only in older ledgers, t518) |
| claimed to released | `releaseReview` `:10103` via `endReviewClaim` `:10045` | `:10046` | `review.released` `:10120` | `test/review-requests.spec.ts:1572` |
| claimed to no_verdict | `unparsableReview` `:10175` via `endReviewClaim` | `:10046` | `review.unparsable` `:10186`, `review.released` with `noVerdict` `:10203` | `test/review-requests.spec.ts:154` |
| claimed to lapsed, after `REVIEW_LEASE_MS` (5 min, `src/rules.ts:2651`) | `expireReviewClaims` `:10054` | `:10059` | `review.expired` `:10060` | `test/production-paths.test.mjs:192` |
| expired claim to withdrawn, owner names another reviewer | `askReview` | `:9743` | `review.expired` `:9744` | reached by `test/land-routes.spec.ts:511`, state not asserted |
| open to withdrawn, redirected | `askReview` | `:9774` | `review.withdrawn` `:9775` | `test/land-routes.spec.ts:586` |
| open to withdrawn, every runner skipped it | `renewSkippedRequest` `:9336` | `:9346` | `review.withdrawn` `:9347` | `test/land-routes.spec.ts:409` |
| open to withdrawn by the developer | `withdrawReviewRequest` `:10133` | `:10155` | `review.withdrawn` `:10156` | `test/land-routes.spec.ts:552` |
| open to withdrawn, model held | `withdrawHeldRequest` `:2066` from `poolChanged` `:2015`, `bindReview` `:9505` | `:2067` | `review.withdrawn` `:2068` | `test/review-requests.spec.ts:1050`, `test/model-set.spec.ts:168` |
| to withdrawn, single-family switch | `withdrawForeignRequests` `:2587` | `:2596` | `review.withdrawn` `:2597` | `test/single-family.spec.ts:71` |
| to withdrawn, admission withdrawn | `withdrawRequestsOf` `:2722` | `:2726` | `review.withdrawn` `:2727` | `test/reviewer-admission.spec.ts:163` |
| to withdrawn and superseded, criteria changed | `criteriaChanged` `:3040` | `:3062`, `:3065` | `review.withdrawn` `:3063` | `test/review-head-moves.spec.ts:233` |
| to withdrawn and moved, head moved | `withdrawStaleRequests` `:9977` from `update` `:11850`, `bindReview` `:9458`, `reviewWaiting` `:9242` | `:9981` | `review.withdrawn` `:9982` | `test/review-head-moves.spec.ts:89` |
| open to withdrawn, part's reviewer rerouted | `rerouteReviewer` `:8501` | `:8521` | `review.withdrawn` `:8522` | `test/review-requests.spec.ts:607` |
| open to withdrawn, part head moved in the tick | `reviewTick` | `:9072` | `review.withdrawn` `:9073` | no test |
| to withdrawn, contributor or family or standing | `reviewTick` | `:9097` | `review.withdrawn` `:9098` | `test/review-requests.spec.ts:451` |
| tier requests to withdrawn | `withdrawTierRequests` `:9960` from `:5038`, `:5576`, `:10853` | `:9964` | `review.withdrawn` `:9965` | no test |
| to withdrawn, task merged or abandoned | `update` `:11793` | `:11823` | `review.withdrawn` `:11824` | `test/ledger.spec.ts:1825` |
| verdict kept across a clean regeneration | `reviews` insert | `:4751` | `review.retained` `:4752`, `review.not_retained` `:4737` | `test/review-retention.spec.ts:63` |

Every `review.*` kind the code writes, one site each: requested `:9870`,
asked_together `:9678`, claimed `:9522`, released `:10120`, unparsable
`:10186`, expired `:10060`, withdrawn `:10156`, approved and rejected
`:5025`, tests_unrun `:5017`, round_cap `:5103`, rework `:5116`, overridden
`:5566`, unasked `:7000`, finding `:7109`, finding_cause `:7137`, skipped
`:9281`, diff `:9413`, retained `:4752`, not_retained `:4737`.

### States reached by more than one path

- open: four inserts.
- answered: four writes.
- withdrawn: fifteen writes, from twelve functions.
- The kind `review.expired` is logged for two different states, lapsed
  (`:10059-10060`) and withdrawn (`:9743-9744`); `review.released` is logged
  for released and for no_verdict.

### Transitions with no test

- The tier answer at `:5028`.
- `withdrawTierRequests` at `:9964`.
- The tick's stale-head withdrawal of a part's request at `:9072`.

Also stale: the comment at `:10141` says a lapsed claim is asked again as an
open request first; `expireReviewClaims` now leaves it lapsed. `reaskReview`
logs `via: "head-moved"` even when it carries a request a criteria change
superseded, and `test/ledger.spec.ts:1806` asserts that.

## 3. Criteria reviews

### States and storage

| State | Stored as | Declared |
| --- | --- | --- |
| open, claimed, approved, rejected, failed, withdrawn | `criteria_reviews.state` (schema `:1253-1256`) | `CriteriaReviewState`, `src/review/criteria.ts:60` |
| the revision reviewed | `criteria_reviews.rev`, from `criteria_revisions` (`:1250-1252`), written by `recordCriteriaRevision` `:10226` | |
| the claim | `.claimedBy`, `.runner`, `.claimedAt` (`:10521`) | |
| the verdict | `.decidedAt`, `.summary`, `.findings`, `.failure`, `.checks` (`:10647`) | |
| the owner's answers | `criteria_resolutions` (`:1262-1265`), insert `:10701` | |
| lapsed | not a state: a lapse is `failed` with the text "the claim lapsed" (`lapseCriteriaReviews` `:10313`); `criteriaStatus` finds it by searching that text, `src/review/criteria.ts:387` | |
| same-exit run | `same_exits` (`:1282`), `noteExit` `:10436`, `clearSameExit` `:10450` | |

### Transitions

| Transition | Function | Write | Event | Test |
| --- | --- | --- | --- | --- |
| to open | `askCriteriaReview` `:10365` via `requestCriteriaReview` `:10343`, `askCriteriaReviewAtFiling` `:4033`, `resumeRevertRecoveries` `:4120` | `:10414` | `criteria_review.requested` `:10417` | `test/criteria-review.spec.ts:118`; at filing `test/dispatch-on-approval.spec.ts:72` |
| open to claimed | `claimCriteriaReview` `:10488` | `:10521` | `criteria_review.claimed` `:10522` | `test/criteria-review.spec.ts:118` |
| claimed to approved or rejected | `addCriteriaReview` `:10592` | `:10647` | `criteria_review.approved` or `.rejected` `:10649` | `:118`, `:170` |
| claimed to failed, by the runner | `failCriteriaReview` `:10664` | `:10675` | `criteria_review.failed` `:10679` | `test/criteria-review.spec.ts:170` |
| claimed to failed, lapsed after 2 h (`src/review/criteria.ts:118`) | `lapseCriteriaReviews` `:10313` | `:10318` | `criteria_review.failed` `:10319` | `test/criteria-review.spec.ts:170` |
| to withdrawn, criteria changed | `withdrawCriteriaReviews` `:10325` from `criteriaChanged` `:3068` | `:10329` | `criteria_review.withdrawn` `:10330` | `test/criteria-review.spec.ts:118` |
| to withdrawn, stale revision found at claim | `claimCriteriaReview` `:10500` | `:10329` | same | no test |
| to withdrawn, stale revision found at verdict | `addCriteriaReview` `:10621` | `:10329` | same | no test |
| open to withdrawn, owner names another reviewer | `askCriteriaReview` | `:10381` | `criteria_review.withdrawn` `:10382` | no test |
| to withdrawn, model held | `withdrawHeldCriteriaReview` `:2074` from `poolChanged` `:2024`, claim `:10514`, verdict `:10635` | `:2075` | `criteria_review.withdrawn` `:2076` | `test/criteria-review.spec.ts:694`, `:713`, `:736` |
| to withdrawn, task closed | `update` | `:11815` | `criteria_review.withdrawn` `:11816` | `test/runner-keeps-server.test.mjs:471` |
| finding resolved (no state change) | `resolveCriteriaFinding` `:10688` | `:10701` | `criteria_review.finding` `:10703` | `test/criteria-review.spec.ts:170` |

Related: `criteria.revised` `:10229`; `criteria_review.needed` `:10765`, a
log with no write.

### States reached by more than one path

- failed: the runner's report and the lapse.
- withdrawn: six call paths.

### Transitions with no test

- The owner naming another reviewer (`:10381`).
- The stale-revision withdrawals at claim (`:10500`) and at verdict
  (`:10621`).

## 4. Pre-reviews

### States and storage

| State | Stored as | Declared |
| --- | --- | --- |
| open, claimed, passed, blocked, conflict, preparation, unavailable, stale, withdrawn | `prereviews.state` (schema `:1273-1277`) | `PrereviewState`, `src/dispatch/prereview.ts:54` |
| binding and its key | `.binding`, `.bindingKey` | |
| the claim | `.claimedBy`, `.runner`, `.claimedAt` (`:6523`; renewed `:6539`) | |
| tries and when to retry | `.attempts`, `.retryAt` | |
| what settled it | `.result`, `.settledAt` (`:6401`) | |
| result no longer controls the landing | `.detached` (`:6422`) | |
| the fence on the landing after a blocking verdict | `meta prereview-fence:ID`, deleted by `unblock` `:5225` | |
| same-exit run | `same_exits`, `noteExit` from `prereviewOutcome` `:6580` | |

### Transitions

Every settled state is written by `settlePrereview` (`:6400`, write
`:6401`, guarded to rows still open or claimed), which logs
`prereview.<state>` at `:6406`.

| Transition | Caller | Event | Test (`test/prereview.spec.ts` unless named) |
| --- | --- | --- | --- |
| to open | `requestPrereview` `:6316`, insert `:6345` | `prereview.requested` `:6348` | `:114` |
| open to claimed | `bindPrereview` `:6485`, write `:6523`, from `claimReview` `:9397` | `prereview.claimed` `:6526` | `:114` |
| claimed to passed | `prereviewVerdict` `:6669` | `prereview.passed` | `:178` |
| claimed to passed or blocked, detached | `prereviewVerdict` `:6661`; `detachPrereviews` `:6415`, `:6422` | `prereview.detached` `:6423` | `:360` |
| claimed to blocked, with the fence | `prereviewVerdict` `:6680` | `prereview.blocked`, `prereview.rework` `:6704` | `:209` |
| claimed to conflict or preparation | `prereviewOutcome` `:6583` | `prereview.conflict`, `prereview.preparation` | `:391` |
| to stale, outcome note | `:6584` | `prereview.stale` | no test |
| to stale, tick drift | `prereviewTick` `:6290` | `prereview.stale` | `:536` |
| to stale, claim drift | `bindPrereview` `:6519` | `prereview.stale` | no test (`test/prereview.spec.ts:536` covers the tick's drift and `:304` the verdict's; no test claims against a drifted binding) |
| to stale, verdict drift | `prereviewVerdict` `:6651` | `prereview.stale` | `:304`, `:507` |
| to stale, left the queue before a result | `:6665` | `prereview.stale` | no test |
| lost claim, state unchanged | `:6617` | `prereview.stale` | `:340` |
| claimed to unavailable, timed out | `expirePrereviewClaims` `:6433` | `prereview.unavailable` | `:340` |
| to unavailable, malformed, skipped, runner, no reviewer | `prereviewOutcome` `:6585` from `releaseReview` `:10109`, `unparsableReview` `:10182`, `recordReviewSkip` `:9276` | `prereview.unavailable` | `:391`, `:437` |
| claimed to unavailable, contradictory verdict | `:6631` | `prereview.unavailable` | `:546` |
| to withdrawn, pool hold | `poolChanged` `:2030` | `prereview.withdrawn` | `:658` |
| to withdrawn, hold at claim or verdict | `:6507`, `:6622` | `prereview.withdrawn` | `:668` |
| to withdrawn, left the queue | `prereviewTick` `:6278` | `prereview.withdrawn` | `:380` |
| to withdrawn, ineligible | `retirePrereview` `:6394` from `:6451`, `:6512` | `prereview.withdrawn` | `:571` |
| open to withdrawn, task took the lease | `detachPrereviews` `:6419` | `prereview.withdrawn` | `:360` |
| to withdrawn, task closed | `update` `:11819` | `prereview.withdrawn` | `test/runner-keeps-server.test.mjs:483` |
| fence lifted, no state change | `unblock` `:5225-5226` | `prereview.retried` `:5226` | `test/prereview.spec.ts:209` |

### States reached by more than one path

- withdrawn: eight; stale: five; unavailable: four; passed and blocked:
  two each.

### Transitions with no test

- The stale outcome note (`:6584`), stale after leaving the queue
  (`:6665`), and the claim-drift stale (`:6519`).

## 5. Land jobs and landing

### States and storage

| State | Stored as |
| --- | --- |
| queued to land | a row of `land_jobs (item, by, at, quote)` (`:1098`, `:1100`). No state column, no head column. |
| the current attempt: step, attempt number, head, failed step, requeued, cancelled | `meta landing-record:ID`; `LandingRecord` `:490`, written `:6913` |
| stopped (failed at the task's current head, not requeued) | derived by `landingStopped` `:6921-6923` |
| waiting for the project's landing lease | `meta landing-queue` (`:5858`, `:5871`) |
| lease held | `meta landing-lease` (`:5742`); 15-minute expiry, `src/landing-lease.ts:10-13` |
| main confirmed under the lease | `meta lease-main:ID` (`:6034`) |
| merge reservation | `meta landing:ID` (`:5654`, `:5724`) |
| checkout lease and the checkout's last head | `meta checkout-lease`, `meta checkout-head` (`:6073`, `:6078`); expiry `src/checkout-lease.ts:39-41` |

### Transitions

| Transition | Function | Event | Test |
| --- | --- | --- | --- |
| to queued, by the developer or by land at the review ask | `requestLand` `:11353`, insert `:11372`; route `src/index.ts:3164-3171`; CLI `cli/commands/land.mjs:41`, `cli/land.mjs:994-997` | `land.requested` `:11373` | `test/land-request.spec.ts:19` |
| stopped to queued again | `requestLand` `:11364-11369` | `land.requested` with `requeued: true` `:11368` | `test/land-node-2.test.mjs:51` |
| to queued, by the stage tick | `queueLandFromTick` `:2397`, insert `:2398`, from `stageTick` `:2306`, `:2370`; decision `decideLandQueue` `src/stage-tick.ts:77` | `stage.land-queued` `:2399` | `test/auto-land.spec.ts:34`; requeues `test/stage-tick.test.ts:168`, `:175` |
| queued to offered to a runner | `landJobs` `:11429`; queue route `src/index.ts:1889` | none | `test/land-job.spec.ts:25` |
| offered to running | `runLandTask` `cli/runner.mjs:5082`, `runLandJob` `cli/land-queue.mjs:264`. The server records no claim of a land job. | none | `test/land-job.test.mjs:33`, `:121` |
| attempt started | `startAttempt` `cli/land.mjs:365`, then `landEvent` `:6839`, `noteLandingStep` `:6886-6889` | `land.start` | `test/land-node.test.mjs:11` |
| join or leave the lease wait | `queueProjectLanding` `:5899` (`:5909`, `:5914`); CLI `cli/land.mjs:620`, `:507` | `landing.queued`, `landing.dequeued` | `test/stage-events.test.mjs:211` |
| lease taken, or a lapsed one taken over | `beginProjectLanding` `:5929`, write `:5973`; route `src/index.ts:2370`; CLI `cli/land.mjs:644-653`, `cli/commands/merge.mjs:442` | `landing.leased` `:5975`, with `replaced` on takeover | `test/land-routes.spec.ts:70`, `:90` |
| lease renewed | `renewProjectLanding` `:5988`; CLI `cli/land.mjs:724`, `:743` | none | `test/land-routes.spec.ts:90` |
| main confirmed under the lease | `confirmLeaseMain` `:6023`; route `src/index.ts:2362-2367` | none | `test/land-routes.spec.ts:300`; no CLI caller found |
| checkout lease taken, renewed, released | `takeCheckoutLease` `:6090`, `renewCheckoutLease` `:6115`, `releaseCheckoutLease` `:6131`; route `src/index.ts:2380-2384`; CLI `cli/checkout-lease.mjs:27`, `cli/checkout-hold.mjs:11`, `cli/commands/merge.mjs:216` | `checkout.leased`, `checkout.moved` `:6109`, `checkout.released` `:6141`; renew logs none | `test/checkout-lease.test.mjs:180`, `:229`, `:363` |
| merge begun (step `merge-main`) | `beginLandMerge` `:11382` (`:11396-11397`); route `src/index.ts:3158-3162`; CLI `cli/commands/merge.mjs:236` | none | `test/land-node.test.mjs:247` |
| merge reservation begun or cancelled | `beginLanding` `:5669` (`:5725`), with `assertLandingChecks` `src/landing-checks.ts:6`; `cancelLanding` `:5659` (`:5665`); route `src/index.ts:3460-3484` | `landing.begun`, `landing.cancelled` | `test/stage-events.test.mjs:243` |
| each step, and a failed step | `landEvent` `:6839` (`LAND_STEPS` `:477`, log `:6866`), `noteLandingStep` `:6883`; CLI `cli/land.mjs:1114`, `cli/commands/merge.mjs:200`, `:414`, `:543`, `:550`, `:601-667` | `land.<step>` | `test/land-routes.spec.ts:643`; failures `test/land-node.test.mjs:53`, `:77` |
| review verdict read | `landingVerdict` `src/landing-verdict.ts:33`, read `cli/land.mjs:982` | `land.review` | `test/land-node-2.test.mjs:138` |
| merged | `merged` `:6926`; `recordMerge` `:7605` | `item.merged` `:6953`, `:7629` | `test/land-node.test.mjs:11` |
| lease released | `cancelProjectLanding` `:6048` (`:6058`); CLI `cli/land.mjs:284`, `:546`, `cli/commands/merge.mjs:575` | `landing.released` | `test/land-routes.spec.ts:195` |
| queued to removed by cancel | `cancelLand` `:11407`, delete `:11418`; refused past the merge `:11413`; CLI `cli/commands/land.mjs:37` | `land.cancelled` `:11420` | `test/land-node-2.test.mjs:75` |
| queued to removed because the task merged or was abandoned | lazily in `landJobs` `:11441`; neither `merged` nor `abandon` deletes the row | none | `test/land-job.spec.ts:42`, `:72`, `:95` |

### States reached by more than one path

- queued: the developer's request or the tick.
- the `land_jobs` row removed: `cancelLand` or the lazy drop in `landJobs`.
- lease taken: `cli/land.mjs` or a manual `atelier merge`.
- merged: `merged` or `recordMerge`.
- `meta landing:ID` deleted: `merged` `:6945`, `recordMerge` `:7618`,
  `cancelLanding` `:5664`.
- `failedStep` set: by `cli/land.mjs` or by `cli/commands/merge.mjs`.

### Transitions with no test

- The kind `land.cancelled` is never asserted in `test/`; the behaviour is
  tested at `test/land-node-2.test.mjs:75`.
- `confirmLeaseMain` has a route test and no CLI caller.

## 5b. The post-merge run

A landing with post-merge steps (checks, a deploy, a publication) carries a
second machine beside the land job: the run that executes those steps after
the merge is recorded. The developer's `atelier land` runs it; the server
holds every transition and refuses the next merge in the project until the
run is complete. The first draft of this report left it out.

### States and storage

| State | Stored as | Declared |
| --- | --- | --- |
| reserved, pending, running, failed, uncertain, complete | `state` inside the run's JSON, `meta post-merge:RUN` (`:6802`) | `PostMergeRun.state`, `src/post-merge.ts:40` |
| which run is a task's | `meta post-merge-item:ID` (`:6803`); deleted at `:5719` when the policy is cleared after a cancelled reservation | |
| the one run that blocks merges | `meta post-merge-active` (`:6804-6805`): set on every save, deleted when the run is complete | |
| the merge the run follows | `before` from the landing row (`:5721`); `after` null until the merge is recorded (`:6942`) | `src/post-merge.ts:38` |
| each step: pending, not_applicable, passed, waived | `steps[].outcome` | `src/post-merge.ts:42` |
| each attempt: running, uncertain, failed, passed, waived, with `commandOutcome`, `deployment`, `publication`, `retry` | `steps[].attempts[]` | `Attempt`, `src/post-merge.ts:28-36` |
| diff prepared | `paths`, null until prepared (`src/post-merge.ts:96`) | |
| every change | event `post-merge.<action>` with the whole run in its data (`:6806`): reserved, merged, prepared, start, command, finish, retry, skip, reconcile, uncertain, cancelled | |

The ledger does not compute the state: every write goes through
`savePostMerge` (`:6800`), which stores the run, points each member task at
it, sets or clears the active key and logs one event. The state itself is
set by the pure functions of `src/post-merge.ts`, which the ledger calls.

### Transitions

| Transition | Function | Event | Test |
| --- | --- | --- | --- |
| none to reserved, at the start of a landing with steps | `beginLanding` `:5720-5722` via `reservePostMerge` `src/post-merge.ts:83`; route `src/index.ts:3484` | `post-merge.reserved` | `test/post-merge.spec.ts:68`, `:148` |
| reserved to complete, landing cancelled before the merge | `cancelLanding` `:5661-5663`; refused once `after` is set `:5662`; route `src/index.ts:3474-3477` | `post-merge.cancelled` | `test/post-merge.spec.ts:204` |
| reserved, the merge recorded (`after` set, state unchanged) | `merged` `:6938-6943`; refused when the run is not reserved `:6941` | `post-merge.merged` | `test/post-merge.spec.ts:68`; the refusal with no reservation `:168` |
| reserved to pending, or to complete when no step applies | `preparePostMerge` `:6810` (`:6814`) via `src/post-merge.ts:92` (`:98`); route `src/index.ts:2406-2413`; CLI `cli/post-merge.mjs:179` | `post-merge.prepared` | `test/post-merge.spec.ts:68`; unit `test/post-merge.test.mjs:41` |
| pending to running | `postMergeAction` `:6822` via `startAttempt` `src/post-merge.ts:100` (`:106`); route `src/index.ts:2437`; CLI `cli/post-merge.mjs:198` | `post-merge.start` | `test/post-merge.spec.ts:68` (two racing starts, one refused) |
| running, the command's outcome recorded (state unchanged) | `:6823` via `recordCommand` `src/post-merge.ts:129`; CLI `cli/post-merge.mjs:204` | `post-merge.command` | `test/post-merge.spec.ts:181` |
| running to pending or complete, step passed | `:6824-6826` via `finishAttempt` `src/post-merge.ts:138` (`:145`); a deploy needs the version the route verified, `src/index.ts:2416-2436`; CLI `cli/post-merge.mjs:209` | `post-merge.finish` | `test/post-merge.spec.ts:68`, `:181` |
| running to failed | same `:145`; a failed check also logs the failing test names `:6827-6829` via `recordCheckFailure` `:7158`; CLI `cli/post-merge.mjs:209`, `:216` | `post-merge.finish`, `check.failed_tests` with `where: "main"` `:7161` | `test/post-merge.spec.ts:68`; the names `test/finding-cause.spec.ts:156` |
| running to uncertain, deadline passed | `expireAttempt` `src/post-merge.ts:88` (`:90`), run on every read by `postMergeRun` `:6782-6783`, and before a start `:101` or a recovery `:148` | `post-merge.uncertain`, from the read only | `test/post-merge.spec.ts:101`; unit `test/post-merge.test.mjs:63` |
| uncertain or running to failed, reconciled as no-effect | `:6832` via `recoverPostMerge` `src/post-merge.ts:152-162` (`:161`); CLI `cli/land.mjs:231` | `post-merge.reconcile` | `test/post-merge.spec.ts:101`; unit `test/post-merge.test.mjs:63` |
| uncertain or running to pending or complete, reconciled as completed | same `:161`; a deploy needs the verified deployment `:154-157`, `src/index.ts:2416` | `post-merge.reconcile` | no test |
| failed to pending, retry | `src/post-merge.ts:169-172`; CLI `cli/land.mjs:231`, then the executor `:236` | `post-merge.retry` | `test/post-merge.spec.ts:101`; unit `test/post-merge.test.mjs:41` |
| failed, or reserved with a recorded merge, to pending, reserved or complete, step waived | `src/post-merge.ts:173-175`; the reserved waiver `:167` | `post-merge.skip` | `test/post-merge.spec.ts:68`, `:127`; unit `test/post-merge.test.mjs:77`; CLI `:96` |
| refusal: a merge of another task while a run is not complete | `assertPostMergeFree` `:6795-6797`, from `beginLanding` `:5670`, `beginProjectLanding` `:5930`, `merged` `:6937`, `landedFast` `:7529`, `recordMerge` `:7587` | none | `test/post-merge.spec.ts:68`, `:127`; the CLI's wait on that refusal, against a fake server, `test/land-4.test.mjs:145` |
| a merged task's land job kept while the run is open, dropped when complete or failed | `landJobs` `:11440-11441` | none | `test/land-job.spec.ts:72`, `:95` |
| the executor runs each pending step in turn, then hands a failed check to the revert | `executePostMerge` `cli/post-merge.mjs:176-216`, from `cli/land.mjs:305` and `:236`; the barrier the land queue reads before starting another landing `cli/land-queue.mjs:131`, `:182` | the events above | `test/post-merge.test.mjs:164`, `:258`, `:381`; `test/land-queue.test.mjs:102`, `:137` |

### States reached by more than one path

- pending: prepared (`src/post-merge.ts:98`), a step passed with more to
  run (`:145`), reconciled as completed (`:161`), retry (`:172`), a waiver
  with more to run (`:175`).
- complete: prepared with no step applying (`:98`), the last step passed
  (`:145`), reconciled as completed (`:161`), the last step waived (`:175`),
  a reservation cancelled before the merge (`:5663`).
- failed: a step failed (`:145`) or reconciled as no-effect (`:161`).
- reserved, running and uncertain each have one entry.
- The kind `post-merge.uncertain` is logged by a read, `postMergeRun`
  (`:6783`), under the owner's name whoever asked; the other kinds are
  logged by the write that made them.

### Transitions with no test

- Reconciling an uncertain attempt as completed (`src/post-merge.ts:161`,
  resolution `completed`). No test in `test/` passes that resolution; the
  no-effect resolution is tested at `test/post-merge.spec.ts:101`.

Also: `post-merge-item:ID` is deleted at `:5719` only when the policy is
cleared and the last run was a cancelled reservation; with the policy kept,
a complete run stays the task's run, and the next landing of the same task
reserves a new one (`:5720`), so one task can have two runs in `meta` and
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
| step ran, passed or failed | event `action.ran` (`src/actions.ts:239`) |
| shipped, or failed at a step, with `warning` and `final` | event `ship.recorded` (`:6163`), read back by `deploys` `:6217` |
| final failure announced | `deploy_notices (ship, at)` (`:6160`, insert `:6164`) and event `deploy.failed_notice` (`:6166`) |
| deploy on landing: running, pending, deployed, waiting | the local file `<gitDir>/atelier-auto-deploy` (`cli/ship.mjs:808-851`, `cli/commands/ship.mjs:110-115`) |
| reverted, and the recovery: filing, recovering, complete | `revert_notices (merge, at)` (`:6196`, `:6206`), event `revert.notice` (`:6207`), `meta revert-recovery:MERGE` (`:12473`) |

### Transitions

| Transition | Function | Event | Test |
| --- | --- | --- | --- |
| refused before running | `ship` `cli/ship.mjs:549`, refusals `:607-608` | none | `test/ship.test.mjs:716`, `:318` |
| checkout lease taken | `holdCheckout` `cli/commands/ship.mjs:28` | `checkout.leased` | `test/checkout-lease.test.mjs:304` |
| begun | `cli/ship.mjs:636` | none | no test |
| approval consumed | `consumeAction` `src/actions.ts:198`; ledger `:7740`; route `src/actions-api.ts:47`; CLI `cli/ship.mjs:647` | `action.consumed` | `test/actions.test.ts:77` |
| step started | `startActionRun` `src/actions.ts:221`; CLI `cli/ship.mjs:620-627` | `action.started` | `test/ship-stuck.test.mjs:61` |
| step ran | `recordActionRun` `src/actions.ts:228`; CLI `cli/ship.mjs:615`, `:697` | `action.ran` | `test/ship.test.mjs:351` |
| step failed, ship failed | `cli/ship.mjs:717` to `deployed` `cli/commands/ship.mjs:49` to `POST /deploys` (`src/index.ts:2389-2392`) to `recordDeploy` `:6157` | `ship.recorded`, result `failed` | `test/checkout-lease.test.mjs:335` |
| delivery unconfirmed, failed at verify-delivery | `cli/ship.mjs:713`, `:728` | `ship.recorded` | `test/ship.test.mjs:414` |
| wrap failed after the deploy passed, shipped with a warning | `cli/ship.mjs:716` | `ship.recorded` with `warning` | `test/ship.test.mjs:1124` |
| shipped | `cli/ship.mjs:733` | `ship.recorded`, result `shipped` | `test/checkout-lease.test.mjs:304` |
| checkout lease lost, failed | `stayHeld` `cli/checkout-hold.mjs:28` via `cli/commands/ship.mjs:89` | `ship.recorded` | `test/checkout-lease.test.mjs:424` |
| process ended before finishing, failed | `onExit` `cli/commands/ship.mjs:45-48` | `ship.recorded` | no test |
| deploy on landing: claim, queued, waiting, deployed, superseded, final failure | `autoDeploy` `cli/ship.mjs:884` (`:886`, `:901`, `:913`, `:919`, `:926`); started by `deployOnLanding` `cli/post-merge.mjs:150` | the final failure writes `ship.recorded` with `final` and `deploy.failed_notice` | `test/auto-deploy.test.mjs:40`, `:137`, `:163`, `:309`, `:365`; `test/deploy-notice.spec.ts:33` |
| merge recorded as shipped | `recordMerge` `:7634-7637` | `action.ran`, step `recorded` | `test/record-merge.spec.ts` |
| revert notice, recovery filing | `recordRevertNotice` `:6185` (`:6203`); route `src/index.ts:2396-2398` | `revert.notice` | `test/auto-revert-ledger.test.mjs:211` |
| recovery filing to recovering to complete, on the tick | `resumeRevertRecoveries` `:4096` (`:4106`, `:4113`) | `item.dispatched` for the fix task | `test/auto-revert-ledger.test.mjs:125`, `:299` |
| revert could not land | `wake` `cli/post-merge.mjs:484` | `ship.recorded`, step `auto-revert` | `test/auto-revert-production.test.mjs:114` |

### States reached by more than one path

- failed: six paths (`cli/ship.mjs:717`, `:728`, lease loss, `onExit`,
  `autoDeploy` `:926`, `cli/post-merge.mjs:484`).
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
| offered | `runner_offers (runner, json)` (`:1040`); live for 2 h, `OFFER_LIVE_MS` `src/dispatch/rules.ts:885` |
| dispatched | `items.dispatch` and `item.dispatched` (machine 1) |
| claimed, running | `items.state = 'claimed'`, `items.runner`; `meta claim-rollback:ID`, `meta runner-job:*` |
| last poll or heartbeat | `meta runner-polls` (`:4221`) |
| idle | `meta runner-idle:R`, valid 90 s (`src/dispatch/rules.ts:567`) |
| orphaned (no poll for `RUNNER_GONE_MS`, `src/dispatch/rules.ts:299`) | derived by `orphanedBy` `src/dispatch/rules.ts:312`; never written |
| ended without a result, gave up | `meta run-skip:ID:R` (`:4261`, `:4292`); derived by `endedRun` `src/dispatch/rules.ts:331` |
| claim refused | `meta claim-refused:ID:R` (`:4328`) |
| run report | `runs (id, json)` (`:1039`); outcomes `src/models/reliability.ts:33-39` |
| live log | `meta runner-log:ID` (`:3281`), `src/runner-log.ts:30` |
| test slot: queued, started, claimed, idle-reserved | the host pool `/tmp/atelier-test-slots-v2/pool.sqlite`, table `pool(id = 1, data)` (`cli/load.mjs:15`, `:114`) |

No `run.*` or `runner.*` event kind exists. A run is visible in the ledger
only through the task's `item.*` events, the `runs` table and meta keys.
`docs/test-slots.md:27` names the pool path as
`/tmp/atelier-test-slots-v1.sqlite`; the code and `docs/runners.md:675` use
the v2 path.

### Transitions

| Transition | Function | Event | Test |
| --- | --- | --- | --- |
| offer recorded | `askQueue` `:2452` to `putRunnerOffer` `:2443`; route `src/index.ts:1816`, `:1836` | none | `test/runner-routes.test.mjs:670` |
| heartbeat | `recordRunnerPolls` `:4221`; route `src/index.ts:1863-1864`; CLI `cli/runner.mjs:5374`, `:5380` | none | `test/orphaned-claim.spec.ts:91` |
| dispatched | `dispatch` `:3749` | `item.dispatched` `:3787` | `test/runner-routes.test.mjs:717` |
| claimed | `claim` `:3539` | `item.claimed` `:3629` | `test/runner-routes.test.mjs:717` |
| claimed again by a new runner | `claim` `:3615-3622` | `item.runner_adopted` `:3622` | `test/ledger.spec.ts:888` |
| claim rolled back | `unclaim` `:4454` | `item.claim_failed` `:4468` | `test/ledger.spec.ts:413` |
| claim refused | `noteClaimRefusal` `:4315` | none | `test/queue-why.spec.ts:30` |
| run ended, report posted | `runOutcome` `cli/runner.mjs:4410`, `reportRun` `:5406` to `POST /runs` `src/index.ts:1773` to `putRun` `:2125` | none | `test/reliability.spec.ts:55` |
| run reported by hand | `cli/commands/run-report.mjs:9` | none | `test/reliability.spec.ts:182` |
| ended without a result, gave up | `recordRunSkip` `:4277`; route `src/index.ts:3039-3051`; CLI `cli/runner.mjs:5484-5495` | `item.gave_up` `:4299`, only when not held | `test/core-hold-ended.spec.ts:25` |
| submitted | `submit` `:5121` | `item.submitted` `:5137` | `test/runner-routes.test.mjs:717` |
| released | `release` `:5455`; CLI `cli/runner.mjs:2404` | `item.released` `:5484` | `test/runner-routes.test.mjs:717` |
| released with the validation_blocked mark | `release` `:5464-5480` | `item.blocked` `:5480` | `test/validation-blocked-task.spec.ts:31` |
| orphaned, restored | derived, no write | none | `test/orphaned-claim.spec.ts:52` |
| held job offered back after a crash | `heldJobs` `:4394` | none | `test/core-hold-ended.spec.ts:98` |
| slot queued to started to claimed | `acquireSlot` `cli/load.mjs:168` (`:200-212`) | none | `test/load.test.mjs:96` |
| slot released or idle-reserved | `releaseSlot` `cli/load.mjs:225` (`:229-232`) | none | `test/load.test.mjs:317`, `:347` |
| idle reservation to claimed | `acquireSlot` `:181-188` | none | `test/load.test.mjs:317` |
| slot reclaimed (process gone or reservation expired) | `poolTransaction` `cli/load.mjs:129` | none | `test/load.test.mjs:75` |
| slot wait cancelled | `acquireSlot` `:218` | none | `test/load.test.mjs:86` |
| capacity set | `setSlotCapacity` `cli/load.mjs:143` | none | `test/load.test.mjs:227` |
| slot trial applied | `applySlotTrial` `src/runners/slot-trial.ts:54` | none | `test/slot-trial.test.mjs:90` |

### States reached by more than one path

- open again: `release` or `unclaim`.
- claimed: a fresh claim or a renewal.
- gave up: `recordRunSkip`, or implied by a release note starting with
  `GAVE_UP` (`:4298`).
- a slot leaves the pool on release or by reclamation.

### Transitions with no test

None found.

## 8. Stuck episodes

### States and storage

| State | Stored as |
| --- | --- |
| open, cleared | `stuck_episodes.kind`, only `opened` or `cleared` (`src/stuck/episodes.ts:10`); schema `:2253` |
| notified | `stuck_notices (project, key)` (`:2255`) and the ledger's `notices` key `stuck:…` (`:4850`) |
| latest observation | `stuck_ticks (project, at)` (`:2256`) |
| cause | `stuck_episodes.cause`, from `causeOf` `src/stuck/episodes.ts:15-18`: `ship`, `task-idle`, `orphan-lease`, `core-hold`, `runner-skip`, `orphaned-claim`, `runner-give-up`, `review-input-size`, `idle-runner`, and `task:`, `review:`, `review-unoffered:`, `review-skipped:` with the reason (`src/stuck/report.ts:86-251`) |

Until t533 (merged 2026-11-09, `b91b451d`) the digest went out as a push notification and left
no event; t518 (2026-11-07) deleted the older stuck-stage events. So the
ledger's events hold stuck episodes only from 2026-11-09, and the table is
the only record before that.

### Transitions

The timer runs every 10 minutes (`src/limits.ts:29`,
`src/runtime/server.mjs:226`) into `recordStuckEpisodes` `src/index.ts:3857`.

| Transition | Function | Event | Test |
| --- | --- | --- | --- |
| none or cleared to opened, with the next episode number | `reconcile` `src/stuck/episodes.ts:26` (`:33`); `recordStuckTick` `:2259` (`:2273`) | none | `test/stuck-episodes.test.ts:23`, `test/stuck-episodes.spec.ts:41` |
| opened to cleared, on a complete read only | `src/stuck/episodes.ts:34`; `:2273` | none | `test/stuck-episodes.spec.ts:59` |
| stale observation ignored | `:2263` | none | `test/stuck-episodes.spec.ts:110` |
| opened to notified, after 60 min or the standing `notice-delay` | `dueNotices` `src/stuck/notices.ts:16`; `stuckDue` `:2281`; `recordStuckDigest` `:4848` (`:4852`); `stuckNotified` `:2288`; `notifyStuck` `src/index.ts:3846` | `stuck.digest_notice` (`src/notify.ts:8`) | `test/stuck-episodes.spec.ts:137`, `:173` |
| read | `GET /stuck/episodes` `src/index.ts:1991-1994`; `openStuck` `src/stuck/view.ts:20`; `atelier status` reads it at `cli/status.mjs:356` | none | `test/stuck-view.test.mjs` |

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

- `block` writes only `state` and `blocked` (`:5194`); a validation block
  does the same (`:5479`). Neither touches `owner`, `runner` or `dispatch`.
- `unblock` writes `state = blocked.from` and clears `blocked` (`:5229`).
  The task comes back claimed, owned by its old builder, with its dispatch
  intact. `test/validation-blocked-task.spec.ts:54` requires exactly this:
  "unblocking it offers it back to its holder's runner".
- `atelier dispatch` on that task hits `refuseLiveHolder` (`:3827`), which
  throws `held` at `:3834` unless `--release` is given or the runner is
  orphaned (`:3832`). While the task is still blocked, `assertDispatchable`
  (`src/dispatch/rules.ts:742-746`) throws `not_open` instead. A claim by
  anyone else is refused by `assertClaimable` (`src/rules.ts:1173-1174`).
- Machine 1, state claimed, reached by unblock. The ledger counts it with
  `item.unblocked` events whose `data.to` is `claimed`.

### Release keeps the dispatch, so a runner claims again within seconds

- `release` writes `owner: null, state: "open"` (`:5483`). `update` nulls
  `runner` (`:11833-11834`) and clears `dispatch` only for merged or
  abandoned (`:11799-11806`). The comment at `:3949-3950` states the rule:
  a released task "waits in the queue again".
- `log` calls `dispatchWaiting()` after every `item.*` event (`:12256`),
  and `dispatchWaiting` (`:4157-4158`) selects open, unowned tasks with a
  dispatch. The next runner poll claims it. `test/validation-blocked-task.spec.ts:76`
  requires released tasks to appear in `waiting()`.
- Machine 1, state open, reached by release with `dispatch` carried over.
  The ledger counts it with an `item.claimed` within 60 s of an
  `item.released` on the same task.

### A queued land job records no head

- `land_jobs` has columns `item, by, at` and `quote` (`:1098`, `:1100`).
  Both inserts record only those: `requestLand` at `:11367` and `:11372`,
  `queueLandFromTick` at `:2398`. The tick puts the head in the
  `stage.land-queued` event's data (`:2399`) and nowhere in the row.
- The head is read back from the item each time: `landJobs` hands the
  runner the item with its own `head` (`:11446`); `cli/land.mjs:789-790`
  starts the attempt from `acceptedHead` or `head`; `noteLandingStep`
  falls back to `item.head` (`:6888`, `:6894`); the stage tick matches
  its queueings by the event's head (`:2360`). So a job queued for one head
  lands whatever head the task has when a runner takes it, and nothing can
  say which head was asked for.
- Machine 5, state queued. Every `land.requested` since 2026-11-01 records
  no head; the count of those events is the count of this case.

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
# land requests, none of which records a head
atelier events --project atelier --from 2026-11-01 --kind land.requested | jq length
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
| 5 | 5 Land jobs and landing | 9 merged repairs, 94 merges of main into branches | land requests with no head, not measurable here | One of the three cases. Seven meta keys and a table with no state or head column. |
| 6 | 8 Stuck episodes | 6 merged repairs | episodes by cause, only since 2026-11-09 | Two states, well tested; its history was lost twice this month (t518, t533). |
| 7 | 3 Criteria reviews | 2 merged repairs | criteria rejections, not measurable here | One hidden state (lapsed as failed with a text search). |
| 8 | 5b The post-merge run | 1 merged repair, 16 commits to its files | failed finishes and recoveries, not measurable here | The best-written of the nine: a closed state list, one save function, one event per change. Its one untested transition is the reconcile-as-completed path; its harm is that an open run blocks every merge in the project. |
| 9 | 4 Pre-reviews | 0 | pre-review outcomes, not measurable here | Nine states and the most write paths per state, but no repair this month traced to it. |

Adding the post-merge run moved no rank above it: it enters at 8 of 9 with
one merged repair, and machine 6 drops from 13 to 12 and stays fourth.
The ledger counts may reorder ranks 1 to 3. The git proxy counts repairs
that merged; it does not count rejections, nor the orchestrator's workaround
moves, which only the ledger holds.

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
