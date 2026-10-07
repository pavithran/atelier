# Orchestrator design

Steps 1 to 14 of the build sequence (section 8) are built. Steps 1 to 4,
8, 11 and 12 are pure functions in `src/plans/` and `src/review/`. Step 5 puts
plans in the project's Ledger: proposals, approval, the parts and the tick
that dispatches them. Step 6 gives them routes and the `atelier plan`
command. Step 7 gives the planner and each part's builder a brief from the
server (`GET items/tN/job-brief`) and the runner a plan job. Steps 9 and 10
add automatic cross-family review: the Ledger's tick asks a review request
for each submitted part, and a reviewer's runner answers it with findings
and the rework transition. Steps 12 to 14 add the integration branch: parts
fork from and are measured against their plan's fork, the integrator merges
each part and reports `integrated` or `integration-failed`, and the plan
submits and merges once every part is integrated. A `refresh` job merges
main's head into the plan's branch: the tick dispatches it before a part when
main has moved, and the owner runs it with `atelier plan refresh` (section
5); a refresh that conflicts adds a merge-main part to the plan, which a
model builds and resolves. The merge receipt that lists the parts is not built.

Where a section describes something not built, it is the design, not a
claim that the routes, storage, commands or runner jobs exist. Where the
built code differs from the first design, the section says what the code
does.
This design assumes t47 is parked; its deployed task text was not available
when the design was written.

## Structure

A plan is an item with `kind = "plan"`. That gives it everything an item already has: one owner at a time, a fork, evidence, the gate, `accept`, and `atelier merge`.

- **The plan item's fork is the integration branch.** Parts are ordinary items that point to a parent plan.
- **Orchestration.** A pure function, `planActions(state)`, returns a list of actions. The project's Ledger runs it at the end of `submit`, `addEvidence`, `addReview`, `release` and `recordPush` (and of `merged` and `abandon`, section 3), and on a Durable Object alarm for timeouts.
- **Serialization.** The project's Durable Object serializes plan transitions. External work must be checked against the current plan revision before its result is recorded.

## 1. Data model

**Item columns.** Add `kind` (`task`, `plan` or `part`), `plan` (the parent's id), `part_key` and `deps` (a JSON list) in the `Ledger` constructor, the same way `dispatch` and `runner` were added. Ids stay `tN`, because the runner checks `^t[0-9]+$` in `runTask`.

**Plan documents.** A new table, `plans(seq, plan_id, hash, json, actor, at)`, keeps every valid proposal, in the order posted, and never changes a row; `actor` is who posted it. An invalid proposal is not a row: it is the event `plan.invalid`, with its errors.

**The plan's record.** The meta key `plan:tP` holds the rest (`PlanRecord` in `src/plans/state.ts`): the goal, scope and planner, the reason the plan is blocked or null, the owner's reroutes of parts, and once approved the approval itself.

**Approval binds to a hash.** The owner calls `POST items/tP/plan/approve {hash}`.
- The Ledger refuses unless `hash` is the newest valid proposal. This is the same idea as `assertRevision`.
- It is refused while the planner still holds the plan item's claim, so a write token never outlives the plan: the planner releases before the owner approves.
- It stores the approval in the plan's record (`hash`, `at`, `allowPaid`, the limits, the deadline, the part items and each part's routing) and logs `plan.approved`.
- It is refused while a part has no builder, or no reviewer of another family, under `routeParts`: approving such a plan would only block it. The owner adds models to the pool, or approves with `allowPaid`, and approves the same hash again.
- A new proposal before approval makes the older hash impossible to approve, just as a push withdraws acceptance.
- After approval, new proposals are refused. Changing the split means stopping the plan (`plan stop`) and starting another.

**Plan states.** A pure `planPhase()` derives them: planning → proposed → building ⇄ blocked → ready (the plan item is submitted) → accepted → merged, or abandoned. Only the reason for `blocked` is stored.

**New item state for parts.** Parts gain the state `integrated`, meaning they are on the plan's branch (t16). Until t16 exists, a dependency counts as landed only when it is `merged`.

## 2. Plan proposals

1. `atelier plan "goal"` creates the plan item and dispatches it as a `plan` job: its `Dispatch` carries `job: "plan"`, and `assign()` offers it only to a runner whose offer lists `jobs: ["plan"]`; the runner's offer is `jobs: ["build","plan"]` (step 7b). The default planner (`pickPlanner` in `src/plans/state.ts`) is the top result of `route({kind:"research"})` over the pool that is not refused, not paid per token (nothing is approved yet; the owner may still name a paid model with `--planner`) and holds the `planner` role. The plan item's claim, before approval, needs the `planner` role under a governed policy, where any other claim needs `executor`.
2. A runner claims the plan item the ordinary way. That claim forks the baseline, and this fork becomes the integration branch.
3. The harness writes JSON to a new `{plan_file}` placeholder (in `cli/runner-config.mjs`) and must not commit.
4. The runner posts the JSON to `POST items/tP/plan` and releases the claim.
5. `postPlan` validates it and clears the dispatch. Otherwise the release would put the plan back in the queue, because `waiting()` lists dispatched open items.

**Schema `atelier.plan.v1`.** A document with `schema: "atelier.plan.v1"`, a
`goal` and a list of `parts`. Unknown fields are refused, including fields
inside parts and preferences. Strings are normalized to NFC before validation.
Controls, bidi controls and default ignorable code points are replaced with spaces, then surrounding
whitespace is removed. Text fields and list entries must remain non-empty.
Keys contain only ASCII letters, digits and hyphens.
`PLAN_LIMITS` in `src/plans/schema.ts` defines document caps. String caps
apply after cleaning, measured in UTF-16 code units. The caps retain the design's part, scope and
brief sizes, use the display title size for short labels, and bound the other
lists by the part budget. Object keys are sorted recursively for the SHA-256
content hash; string values are normalized to NFC and array order is preserved.
An over-long list produces one count error. Only entries up to its cap are
inspected, including in `parts`. Parsing and validation each return at most
50 errors. If more are found, the last entry says `and N more errors`, counting
omitted diagnostics from inspected entries. Names quoted in errors are limited
to 80 code units with an ellipsis when cut. Unknown field names with characters
other than ASCII letters, digits, underscores and hyphens use escaped code points.
Each part has:
- `key`, `title`
- `kind`: interface, build, tests or docs
- `taskKind`, from the registry's `TaskKind`
- `scope`: a non-empty list of globs
- `dependsOn`, `provides`, `uses`
- `brief` (at most 2,000 characters), `acceptance[]` (at least one criterion), `tests[]`
- `size`: S or M
- an optional preference: `prefer {actor, reason}`

Every part needs an acceptance criterion that states something observable.
A part with nothing to observe cannot be reviewed. The parser enforces a
non-empty list of non-empty strings; the reviewer judges their content.

**Validation.** Pure functions in `src/plans/validate.ts`:
- keys are unique, and a plan has at least one part and at most 12 parts;
- the dependency graph is acyclic; Kahn's algorithm removes ready parts, then a traversal names cycles in every remaining branch;
- any two parts whose scopes overlap under `scopesOverlap` must be ordered, one reachable from the other;
- every `uses` resolves to a part that `provides` it and that the user reaches through its dependencies; each direct dependency of an interface part must be an interface part;
- sizing: at most 6 scope globs per part. Routing allows size M only for models with a context window of 64K or more, or unknown. Qwen3-Coder is recorded as 32K.

**Routing is computed by Atelier, not taken from the planner.** `routeParts(plan, input)` in `src/plans/route.ts` is a pure function over the pool, the registry and the project's ledger:
- calls `route()` from `src/models/routing.ts` for each part's `taskKind`, with `buildRecord(events)` as the track record, over one registry-shaped profile per pool entry; the registry supplies evidence and the context window when it knows the model by id or alias, and an entry's record counts its aliases, as the Models page does;
- drops pool entries whose status is `refused`, and paid-per-token entries (an API reached with a key; the Studio and a subscription are not) unless the owner approves with `allowPaid`;
- applies the claim's rule, `assertEligible`: under a governed policy only actors with the `executor` role build, otherwise the project's eligible harnesses;
- gives a size M part only to a model whose context window is at least 64K tokens or unknown; the reviewer reads the same scope, so the rule applies to it too;
- honours a part's `prefer {actor, reason}` only when that actor passes every rule, and the builder's reasons say what became of the preference;
- freezes, per part, the top builder, two alternates and the reasons, in `route()`'s order: score, then, when the input carries each model's reliability across every project (`src/models/reliability.ts`), the share of its outcomes in its favour as a tie-breaker that never changes a score, then model id, then actor name;
- picks the first reviewer in that order whose `familyOf` differs from the builder's, both families recognised, as `gate()` counts a cross-family review, and, under a governed policy, who holds the `assessor` role.

A part with no eligible builder, or no reviewer of another family, is returned unrouted with a reason that names each model passed over. Every choice carries human-readable reasons, for the task page's "why this model?".

Two inputs added on 2026-10-05 describe the owner's tools rather than the models. `availability` maps an actor or a harness (an actor's entry wins) to `available`, `reserved` (near its usage limit; `for` lists the task kinds it may still take, and a part of any other kind passes it over) or `paused` (gets nothing). `spend {cap, used}` is the owner's figure for paid models; once `used` reaches `cap`, paid models are excluded as if `allowPaid` were off. The reasons say when a model was passed over for availability or spend. Harnesses report no usage data, so `used` is what the owner reports.

**An invalid plan** is recorded as `plan.invalid`. The planner is dispatched once more with the errors in its brief; after that the plan is blocked. The Ledger counts attempts, not documents: an attempt is a claim of the plan item, and it fails when the claim is released without a valid proposal, whether one was posted invalid or none was posted. After two failed attempts since the plan last asked (its creation, a valid proposal, or the owner's revise, reroute or retry), the plan job leaves the queue and the plan is blocked. Before approval the owner may revise, reroute the planner (`plan reroute tP --to a/m`) or retry it.

**Friction with the registry.** The registry's `where` says where a model's inference runs. A dispatch's `to` says which kind of runner takes it. With the cloud runner gone, every dispatch is `to: "home"`, and `where` only feeds the `localOnly` privacy constraint.

## 3. Dispatch after approval

`approvePlan` creates the part items and then runs the tick, in one transaction. The tick runs at the end of `submit`, `addEvidence`, `addReview`, `release`, `recordPush`, `merged` and `abandon` for a part or its plan, after the owner's reroute or retry, and on the alarm; a refused review claim runs it too (the request the claiming agent could not take is re-judged: withdrawn and asked again), the alarm fires not only for the deadline but for the moment a part's claimed review lapses, and a deploy ticks every open plan once, comparing the main commit it was built from (`DEPLOYED_MAIN`) with the last it ticked under, so changed tick logic reaches a plan waiting on nothing else. `merged` is how a dependency lands until t16, and `abandon` can unblock a plan whose stuck part the owner gives up. A tick that throws is undone and logged as `plan.tick_failed`; the change that ran it stands. `planActions` dispatches a part when:
- its dependencies have landed;
- the plan is not blocked;
- fewer than `maxParallel` parts are live (default 2, one per Mac);
- the budget has room.

**Who dispatches.** An internal method, `dispatchPart`, writes the same `Dispatch` record from the frozen routing. It is not the owner-only `dispatch()` route. Its event's actor is `atelier/orchestrator`, with `{approval: hash, reason}`. `assertDispatchedClaim()` is unchanged. The owner's `dispatch` and `undispatch` refuse a plan or a part. A part is claimed only through its dispatch: an open part with none is refused, so no one takes it before its dependencies land. A plan item is claimed only through its plan job's dispatch: once a valid proposal clears it, the plan waits for the owner and nobody claims the item by hand. An approved plan's own item is claimed by nobody until the integrator exists (t16).

**What the tick adds to `planActions`.** `maxJobs` is counted here, as the part dispatches `atelier/orchestrator` has made; `planActions` does not count jobs. The block `planActions` reports is stored as the plan's reason, and cleared when it no longer holds, so a plan stays blocked until the owner's decision changes what the tick reads. While it is blocked, parts waiting in the queue are taken out (`item.undispatched`). A released part's dispatch record is cleared unless the tick dispatches it again, so it never waits in the queue for an actor the tick did not choose. Attempts are counted from the owner's latest reroute or retry of each part, and a reroute keeps the routed alternates behind the actor it names. The spend budget is not passed (`budget: null`), and neither is availability: nothing records them yet.

**Finishing, until t16.** Without the integration branch, a part reaches main by its own acceptance and merge, as any item does. The plan is complete when every part is merged or abandoned and at least one merged: the tick marks the plan item merged and logs `plan.completed`, with no merge commit of its own. When every part is abandoned the plan blocks, since it brings nothing. t16 replaces this with `planGate` and the owner's merge of the plan item.

**Briefs come from the server.** The route `GET items/tN/job-brief`, built over the pure functions in `src/plans/brief.ts`, gives the holder of the plan item's or a part's claim the brief for the work it holds: `plannerBrief`'s planner brief (the goal, the owner's latest revise note, the last `plan.invalid` errors and the schema to write) or `jobBrief`'s part brief (the part's spec, its dependencies' interfaces and landed heads, its scope and the project's required checks, and, for rework, the findings or the failing output). It replaces `briefFor` in `cli/runner.mjs`, which hardcodes "npm test" and is wrong for other projects; `briefFor` still writes the brief of any task that is not a part. Only the item's holder may read the route.

**Failures.** Attempts are counted from the event log by a pure function, in the style of `buildRecord`.
- **A runner gives up with no commit.** It already releases the part, so the part re-queues. After two releases by the same actor, the dispatch moves to the next alternate.
- **Checks fail during `finish`.** For an ordinary task the runner keeps the claim. For a part it releases instead (step 7b); the fork keeps the commits. The part goes back to the same actor once, with the failing output in its next brief, then to an alternate.
  - `handoff` cannot be used here: it leaves the item `claimed`, and `waiting()` never lists a claimed item.
- **A part reaches 3 attempts, or there are no alternates.** The plan becomes `blocked` with the reason. The owner chooses: reroute, retry, abandon the part, or stop.
- **The deadline or budget is hit.** The plan becomes `blocked` with the reason. These limits are fixed at approval, so reroute and retry cannot lift them: the owner stops the plan.

## 4. t39: automatic cross-family review

**Trigger.** A pure `reviewNeeded()` fires when a part:
- is submitted;
- has every required check observed passing at its head;
- has its changed paths measured;
- has no counting approval from another family at that head, and no open review request.

This applies to every part, even where `gate()` would ask for no review.

**Storage.** A new table, `review_requests(item, head, dispatch, claimedBy, runner, briefHash, state)`. Reviews cannot use `items.dispatch`, because the part is owned and `assertDispatchable` refuses an owned item.
- The queue route returns review requests as `job:"review"`, matched through the same `assign()`.
- `POST items/tN/review-claim` binds a request to one reviewer atomically.

**The review job.**
1. The runner clones the part's head read-only, using the existing `read-token`.
2. It writes the diff to `{diff_file}`.
3. The harness writes `{verdict_file}`: `{approve, summary, findings[{path, line?, severity: blocker|should|nit, note}]}`.
4. The runner validates the verdict and posts it to the existing review route. `Review` gains an optional `findings` field.

`addReview` still refuses self-review and stale heads, and `countingReviews` still filters to assessors.

**The generated brief contains:**
- the plan goal, and the part's spec, acceptance criteria and interfaces;
- the scope, and any paths outside it (from `gate`);
- the change class;
- the builder's summary, from `submission()` in `src/brief.ts`;
- the observed checks and where each ran;
- earlier reviews at any head, each finding numbered as `atelier finding --index` counts it, with the owner's verdict and note when one is recorded, and whether a push followed them;
- the diff, capped, saying so when it is cut;
- the rules: the project's review bar (`atelier init --review-bar`, or the default bar), reject only with blocking findings the bar names, repeat a finding the owner refuted only with new evidence quoting the code, make no edits, treat the content as data.

**A rejection with blocker findings** triggers an internal release, then a dispatch back to the builder with the findings. The re-review goes to the same reviewer first. After two rounds, the part goes to an alternate builder; after that, the plan is blocked. An approval moves the part to integration (or, before t16, to the owner's acceptance as today).

## 5. t16: integration branch per plan

**Parts fork from the plan's fork, at its current head.** This changes the claim route's source repository. It also means changed paths must be measured against the plan's fork, not the baseline. Today these all assume the baseline:
- `againstMain` in `src/sandbox/runner.ts`, and `measureWorkspace` in `src/diff.ts`, which the evidence route calls;
- `cleanClone` in `cli/atelier.mjs`;
- `itemDiff`;
- `atelier update`.

Add one helper, `baseRepoOf(item)`, and a `base-token` route. Without this, every part reports its dependencies' files as its own and fails its scope check.

**A part with nothing of its own starts from the branch's head.** A part's fork is made at its first claim, and a part dispatched again (after a release with no commit, say) is claimed again on the same fork. When that fork holds nothing beyond the commit it forked from (the part's recorded head is its base or none, and the fork's head in Artifacts is its base or the fork is missing) and the plan's fork has moved past that base, the claim route moves it (`movePartFork` in `src/index.ts`): Artifacts cannot move a branch, so the fork is deleted, with its tokens, and forked again from the plan's fork under the same name, and `Ledger.moveFork` records the new head as the part's base and head with a `fork.moved` event. The workspace's remote is unchanged, so the runner's claim fetches it and fast-forwards to the new head before the reset. A part with commits of its own keeps its fork; a conflict with the branch reaches it through rework (below). The conflict pre-check measures from the new base: a part moves only while it has no head of its own, so no rework's `planHead` predates it. A move that fails gives up a claim the call took, and the next claim finishes it: a missing fork is forked again, and a fork forked again whose new base the Ledger failed to record has a head that is a later commit of the plan's branch, holding the recorded base (a bounded search of the plan's fork), so the next claim records it when it is the branch's head and forks again otherwise. A head the search cannot place on the branch is the builder's and is kept, and the fork's head is read again just before the delete, so a push that lands during the move keeps the fork.

**The integrate job.** It is dispatched on the plan item with `{job:"integrate", part, head}`, to a reserved actor, `atelier/integrator`. Because the plan item has exactly one owner, integrations are serialized.

Before dispatching, the Worker runs `mergeability()` from `src/preview/merge.ts`. Its inputs are a merge base, the plan's head and the part's head. A part head that already holds the plan's head merges cleanly and is not checked. Otherwise the base is the plan head the part's last rework after a conflict merged (the `planHead` its dispatch named), when the part's head holds it, else the part's base; the history search is bounded, and one that stops at its bound uses the part's base. A predicted conflict goes straight back to the builder, without a runner trip.

**The runner side.** `atelier runner --integrate` runs on the Studio and uses no model:
1. Claim the plan item, fetch the part's head and run `git merge --no-ff`.
2. Push with `atelier push tP`, so the head the ledger records for the plan item is the merge, then run `atelier check tP` on it. The plan item's checks compare against the baseline, which is correct here.
3. **If the checks pass:** post `POST items/tP/integrated {part, mergeCommit}`. The Worker verifies the commit is on the plan fork's log and that its parents include the part's head, as the `merged` route does today. The part becomes `integrated`.
4. **If they fail (`atelier check` exits 2), or the merge conflicts:** log the reason, reset to the previous head and record it with `atelier push tP --rollback`, then post `integration-failed` with `kind` `checks` or `conflict`. The part goes back to its builder for rework, and only these two kinds charge the builder an attempt.
5. **Any other error** (the checks could not run, a refused post) is the integrator's: the pushed merge is rolled back the same way and nothing is posted against the part.
6. Release the plan item.

A part's rework, after a failed integration or a rejection, never goes to a model that reviewed the part, approving or rejecting: those are left out of the builder and alternates the tick walks.

**Rework after a conflict.** A part's builder cannot reach the plan's branch from its workspace, so a part sent back for a conflict with it is given the branch. When the tick dispatches a part whose latest integration failure since its last submission is of kind `conflict` (`conflictedParts` in `src/plans/phase.ts`; the integrator's report and the claim's predicted conflict record the same `integration.failed`), the dispatch carries `planHead`: the plan branch's head as the Ledger records it, its integration head (the latest integration or refresh merge), else the plan fork's base. A later submission, or a failure of another kind, ends it. Only a runner that offers the `merge-plan` job takes such a dispatch (`assign` in `src/dispatch/rules.ts`; `offerFrom` offers it). `runTask` claims the part and resets the workspace as for any part; then `startMergePlan` reads a read token with `atelier base-token tN` for the part itself, whose base is the plan's fork, fetches the head and runs `git merge --no-ff` of it with the message "Merge the plan's branch at H into part tN" ending in the builder's `Agent:` line, leaving any conflict in place with its markers and the merge in progress. Nothing after it resets the workspace. With conflicts, the harness gets the server's brief, which for this dispatch has a "Merging the plan's branch" section (`mergePlan` in `src/plans/brief.ts`: the branch at H has been merged and conflicts remain, to resolve each keeping both sides' behaviour and claims, remove every marker, run the checks and commit the merge with its message as it stands), and the runner's list of the conflicting files after it. A clean merge is committed by git and the job finishes with that commit, with no harness, so the part goes back for review. A workspace that already holds H is reworked by the harness as usual. A merge-main part sent back the same way keeps its `merge-main` job and carries `planHead` too: the runner merges main first, then the plan's branch, and lists both in the brief; when the merge of main leaves conflicts, the plan's head is fetched but not merged, and the brief says to merge it after committing that one. Other parts' briefs and their hashes are unchanged.

A successful integration leaves the plan branch with passing checks.
A failed integration attempts to restore its previous head.

**When main moves.** A `refresh` job merges main's head into the plan's fork, so later parts fork from a branch that holds main's later work (a file merged to main after the plan forked, say) and later integrations build on it. It merges rather than rebases, because the branch's history is merge commits.
- **What main's head is.** The Ledger cannot read Artifacts, so it keeps main's head as last observed: the merge commit of every task it records as merged — a plan's own merge among them, recorded once its merge has closed the plan, so the plans in flight read the move at their next tick while the merged plan itself, closed by its merge, is never refreshed against it — but not a part's, whose landing is the plan's own work arriving while it still builds; the commit a plan forks from; and main's head as the Worker reads it from the baseline when it records an integration and when the owner runs `plan refresh`. The latest observation stands. The branch's own main head is the one its latest recorded refresh took, or else the commit the plan forked from.
- **The tick.** Before it dispatches a part, the tick compares the two (`refreshDecision` in `src/plans/state.ts`). When main has moved and no refresh has been tried for main's head, it dispatches the plan item's refresh job to the integrator, `{job:"refresh", head}` naming that head, and dispatches no part; parts wait while the refresh is in flight, or while an integration holds the plan item. One refresh per main head: a failed refresh is not dispatched again for the same head. After failing checks the parts are then dispatched without it; after a conflict the merge-main part below goes first. A later main head is tried afresh. Conflict prediction with `previewAgainstMain` is not wired in; any move of main triggers the refresh.
- **The owner.** `atelier plan refresh tP` (`POST items/tP/plan/refresh`) reads main's head from the baseline and dispatches the refresh. It is refused before approval, once the plan is closed, while the plan item's integrate or refresh job is queued or held, and when the plan's branch already holds main's head. It is how a failed refresh is run again. `atelier plan refresh tP --resolve [--to H/M]` (`{resolve: true, to}`) adds the merge-main part for main's head without trying a clean refresh first, with the named model preferred as its builder (and set as the part's reroute when routing cannot choose it). It is refused before approval, once the plan is closed, while a refresh is in flight (a conflict there adds the part itself), when the branch already holds main's head, when the part for that head exists, and while another merge-main part is not integrated. On a plan submitted or accepted, either one first puts the plan back to building (`reopenPlan` in `src/ledger.ts`): once the refusals are checked, the Worker revokes the integrator's write token, and the Ledger ends the integrator's hold, the submission and any acceptance, logged as `plan.reopened` with the state it left and the acceptance it withdrew; the route answers with `reopened`, and the command says so. It is refused while the plan's landing lease is held, since that merge may be on the baseline; `atelier merge tP --cancel` ends it first.
- **The runner side** runs as the integrate job does: claim the plan item, fetch the dispatched main head, `git merge --no-ff`, `atelier push tP`, `atelier check tP`, then `POST items/tP/refreshed {mainHead, mergeCommit}`. The Worker checks the merge with `verifyRefresh`: on the branch's first-parent line, first parent the integration head, second parent the dispatched main head, exactly two parents. The Ledger records it as the integration head, which later integrations must sit on and later parts fork from. A branch that already holds main's head is reported without a merge commit, which the Worker checks against the branch's history, and the integration head stays. The route answers `{item, allIntegrated, parts}` as `integrated` does; the runner releases the plan item, or, when every part is integrated (a plan put back to building to take main), submits it for the owner again.
- **A failed refresh.** A conflict or failing checks roll the branch back with `atelier push tP --rollback`, log the reason, and post `refresh-failed {mainHead, reason, kind}`; the Worker checks the rollback as for a failed integration. It is the plan's failure, not a part's, so no builder is charged an attempt. Any other error is the integrator's: the merge is rolled back if pushed and the plan item released, with nothing posted, so the job runs again.
- **A conflict becomes a part.** Neither the owner nor a part can resolve a conflict with main by hand: an approved plan's item is claimed only by the integrator, and a part's workspace forks from the plan's branch, which does not hold main. So when `refresh-failed` is recorded with kind `conflict` for main head M, the Ledger adds a **merge-main part** (`addMergeMain` in `src/ledger.ts`, the spec from `mergeMainPart` in `src/plans/state.ts`): key `merge-main-` and the first 8 characters of M, title "Merge main at M into the plan's branch", refactor work, size M, depending on nothing; its scope is the conflicting paths git's `CONFLICT` lines in the failure reason name (`conflictPaths`), or the plan's scope when they name none or more than a part's scope holds. It is routed as approval routes a part (`routeParts`), from the pool fixed at approval and the plan's allowPaid, so it has a builder, two alternates and a reviewer of another family; a part no model can build or review is added unrouted and blocks the plan as any unrouted part does, until the owner reroutes it. Only one is added per main head. While it is not integrated, merged or abandoned, `planActions` dispatches no other part (`holds`; parts already live go on), and the tick dispatches no refresh. It counts toward the plan's limits as a part: attempts, review rounds and the parallel limit apply to it, and it adds `jobsPerPart` to the plan's part dispatches.
  - **The approved hash.** The approved plan document and its hash do not change. Parts the Ledger adds are kept apart, in the plan record's `added` list (`AddedPart`: spec, item, routing, main head, who added it, when, why), and logged as `plan.part_added`. The tick, the briefs and the reviews read the approved document with the added parts after it (`planWithAdded`, `routesOf`, `maxJobsOf`); `plan show` prints the approved hash as approved and marks each added part. The hash stays what the owner approved, and an added part is never mistaken for one the planner proposed.
  - **Its build.** The tick dispatches it as `{job:"merge-main", head: M}` to its builder; only a runner that offers the `merge-main` job takes it (`offerFrom` in `cli/runner.mjs` offers it). `runTask` claims the part and resets the workspace as for any part, so it starts from the part's fork of the plan's branch; then `startMergeMain` reads a read token with `atelier base-token tP` for the plan item, whose base is the baseline (the token the refresh job reads main with), fetches M and runs `git merge --no-ff` of M with the message "Merge main at M into the plan's branch" ending in the builder's `Agent:` line, leaving any conflict in place with its markers and the merge in progress. Nothing after it resets the workspace. With conflicts, the harness gets the server's brief (`GET items/tN/job-brief`, which for this part says main at M has been merged and conflicts remain, to resolve each keeping both sides' behaviour and claims, merging the meaning of prose rather than picking a side, to remove every marker, run the checks and commit the merge with its message as it stands) and the runner's list of the conflicting files after it. A clean merge is committed by git and the job finishes with that commit, with no harness. A workspace that already holds M (an earlier attempt committed the merge) runs the harness on what came back, as rework does.
  - **Its integration.** It is reviewed and integrated as any part. The `integrated` route asks the Ledger for the part's main head (`integrationTarget`) and reads the plan's branch for it under the merge commit; when it is there, `integratePart` records it as the main head the branch took (`mainTaken`), as `refreshed` does, so the tick dispatches no refresh for M and the held parts go.
- **A task outside a plan goes back the same way** (t243). A landing that conflicts with main leaves the merge in the task's workspace for the owner's session, and a plain rework dispatch resets the workspace to the task's head, where the builder cannot reach main — the deadlock a merge-main part resolves for a plan. So the owner may dispatch the merge-main job by hand: `atelier dispatch ID --job merge-main [--head H]` releases the holder as any rework dispatch does and queues the job naming main's head (H, or the head the Worker reads from the baseline), marked as a task's (`task` on the dispatch). Only a runner that offers the `merge-main-task` job takes it (`assign` in `src/dispatch/rules.ts`; `offerFrom` offers it), since a runner from before t243 offers `merge-main` but cannot serve a task's. The runner treats it as a part's merge-main build (`startMergeMain`), reading main through the task's own base token (the baseline), and the brief is the local one with the job's instructions (`mergeMainSection` in `cli/runner.mjs`) and the conflicting files. With the merge committed, `atelier land ID` again finds main already merged and picks up from the push.
- **`plan show`** says which main head the branch last took and where main is now (read from the baseline), the refresh in flight, and a failed one with its reason and the command that runs it again, or the merge-main part that resolves it. A merge-main part is listed as any part, with a line saying it was added by Atelier for main at M, after the refresh conflicted or at the owner's request, outside the approved plan.

**Finishing.** After the last part is integrated and the checks pass, the integrator submits the plan item with a summary of its parts.
- `planGate()` adds blockers to `gate()`: every part integrated, and each with a cross-family approval at the head that was integrated, and the plan's head at its integration head.
- The parts' reviews are the plan's review. When the plan's head is its integration head, every commit on its branch is an integration of a reviewed part or a refresh that merged main's head, each recorded as the integration head, and the integrator's merges are not contributions. So `planGate` asks no independent review of the plan item, however its changes are classed, and does not compare `atelier/integrator`, whose family is not recognised, with any reviewer (`reviewHeld` in `gate()`). The rest of `gate()` still applies to the plan item: it must be submitted with a verified head, its required checks observed passing there (and on main where main has moved), its changed paths observed, its change class allowed by an execution policy, and no rejection recorded on it at that head.
- A plan whose head is not its integration head is refused for that, and is gated as any item: where its changes need an independent review, no reviewer qualifies, because `atelier/integrator` is among its contributors and `familyRefusal` fails every reviewer, so only the owner's override recorded on the plan item lifts that blocker.
- The owner accepts and lands the plan with `atelier merge tP --head H`, H being the integration head `plan show` prints. `atelier land tP` refuses a plan before it takes the landing lease: its merge of main would put a commit beside the recorded integrations. A plan branch behind main takes main through `atelier plan refresh tP`.
- A plan is accepted only where its branch would merge with main. The accept route, and the page's accept and override forms, preview the plan's fork against main's head as the merge preview reads a task (`assertPlanMergeable` in `src/index.ts`, `previewAgainstMain`), and refuse a conflict with `conflicts_with_main`, naming the paths and saying to take main first with `atelier plan refresh tP`, which puts the plan back to building and merges main, adding the merge-main part when that conflicts. A preview that cannot be read holds nothing back.
- When main moves between the acceptance and the merge, `atelier merge tP` still stops on the conflict, aborts the merge and clears its journal. For a plan it then runs the refresh itself (`POST items/tP/plan/refresh`), so the acceptance is withdrawn and the plan is building again rather than accepted with no one able to update it; it says so, or, when the server refuses that, that the plan stays accepted and why. The integrator submits the plan again once every part is integrated on a branch that holds main, and the owner merges it then at the new integration head.
- `Ledger.merged` then marks the parts merged, with `{via: tP}`.

**Where the merge can run.**
- **Not in the Worker today.** The Artifacts binding cannot write; only a git push with a write token can.
- **isomorphic-git** is not a dependency. In a Worker it could merge in memory and push over HTTP, but that is t47.
- **Not in the check container.** Its stated invariant is that it holds no credential and cannot reach the repository.
- **So it runs on a home runner now.**

**Friction with governed projects.** Under a governed policy, `assertEligible` needs `agentOf()` to name the actor, and it maps `atelier/integrator` to nothing, so the claim would be refused. Treat the integrator as a reserved actor, reachable only through a t43 token bound to it.

**What is built, and where it differs from this design.** Steps 12 to 14 are built (section 8), with these deviations:

- The mergeability pre-check runs when the integrator claims the plan item's integrate job, not when the tick writes the dispatch. The tick lives in the Ledger, which has no Artifacts access, so the Worker's claim route reads the part's base, the plan's head and the part's head and refuses a predicted conflict by sending the part back. A failure to read the branch only costs a runner trip, never a blocked integration.
- The `refresh` job is dispatched by the tick when main has moved, and by the owner's `plan refresh`, as "When main moves" describes; it does not wait for `previewAgainstMain` to predict a conflict. `plan show` shows the integration head, each part's integration, and how far the branch is behind main; the combined checks and mergeability with main are not shown.
- `planGate` is read by `Ledger.accept` for the plan item, and `Ledger.merged` marks the parts merged with `{via: tP}` as described.


## 6. The owner's interface

| Command | What it does |
| --- | --- |
| `atelier plan "goal" [--scope G] [--planner a/m]` | State the task |
| `atelier plan show tP [--json]` | Phase, hash, parts (dependencies, scope, actor and reason, state, attempts), integration head, combined checks, mergeability with main, budget used |
| `atelier plan approve tP --hash H [--allow-paid]` | Approve the split, once |
| `atelier plan revise tP --note …` | Send it back to the planner, before approval only |
| `atelier plan reroute tN --to a/m`, `plan retry tN`, `plan stop tP [--note …]` | Decisions for a blocked plan |
| `atelier plan refresh tP` | Merge main's head into the plan's branch now, through the integrator's refresh job; section 5 |
| `atelier plan refresh tP --resolve [--to H/M]` | Add a merge-main part for main's head, whose builder resolves the conflict; section 5 |
| `atelier plan post tP FILE` | The planner, holding the plan item's claim, posts its plan document |
| `atelier merge tP --head H` | Accept and land the whole plan at its integration head; section 5 says why it needs no review of its own |

**What is built.** `src/index.ts` and `cli/atelier.mjs` (step 6):
- A plan starts through `POST items` with `{kind: "plan", goal, scope, planner}`, so t43 refuses it to agent tokens as it refuses any new item.
- `GET items/tN/plan` is `plan show`: the Ledger's `planView`, for a plan or any of its parts. Before approval it carries the routing an approval would fix now, without paid models. The integration head, combined checks and mergeability with main are not built (t16), and the command says so; the budget used is the part dispatches against `maxJobs`, since spend is not recorded.
- `POST items/tP/plan` takes the plan document as its body. A refused document answers 422 `invalid_plan`, with every error and which of the planner's two attempts it was.
- `POST items/tN/plan/approve`, `revise`, `reroute`, `retry`, `refresh` and `stop` are the owner's. `reroute` and `retry` also take the plan item before approval, for its planner. `stop` revokes the write token of every item it closes before closing them, as `abandon` does for one, and closes them in one transaction.
- `GET items/tP/brief` gives a plan item's own brief (`planBrief` in `src/plans/show.ts`), which `atelier show tP` and `atelier inbox` print. `plan show` prints from the same view (`planText`).
- A runner's queue offer lists the jobs it runs; the runner offers `jobs: ["build","plan"]` (step 7b).

**Inbox.** Two new kinds: `approve-plan` (weight 95) and `plan-blocked` (weight 85). The plan item's `accept` and `merge` entries work as today. `approve-plan` appears once the newest proposal answers the owner's latest revise, reroute or retry; `plan-blocked` gives the reason and the decisions open.
- Parts never appear as accept, assess, failing, scope or stale entries. An accepted part still appears as a `merge` entry. Until t16 the owner accepts and merges each part, and learns which are ready from the plan's view (`planView`, read by `atelier plan show`), not from the inbox.
- `overlappingLive` and the inbox's overlap check skip pairs within one plan. Otherwise the plan item's scope overlaps every part, and `refuseOverlap` would refuse their claims.

**Agent apps.** `atelier show tP` prints the plan's brief, which an agent can relay unchanged.

## 7. Safety

**Owner-only:** creating a plan (t43 already refuses `POST items` for agent tokens), approve, revise, reroute, stop, accept, merge, abandon, the model registry and tokens. The orchestrator acts only inside an approved hash, and its internal Ledger methods are not exposed as routes.

**Tokens (t43).**
- t43 binds each token to one actor and filters queue offers by it. So a runner holds one agent token per actor it offers, named by Keychain entry in `runner.json`.
- The planner, reviewers and the integrator each have their own token. The owner token never sits on a runner.
- Routes to add to t43's allowlist: `plan` post and `job-brief` (each for the item's current holder only), `review-claim` and `base-token`; `integrated` and `integration-failed` for the integrator only. `plan` post and `job-brief` are added (`agentRoute` in `src/tokens.ts`), and the Ledger takes each only from the holder; every other plan route, `GET items/tN/plan` included, stays owner-only. The others are added with the steps that build their routes (9, 12 and 13).
- **Conflict to settle:** t43 refuses `POST models/ID/status` for agent tokens, but runners use it to report model status. Either allow it with the runner header, or drop status reporting.

**Harness environment.** `runTask` in `cli/runner.mjs` gives the harness what a check gets (`checkEnv`) and the variables its runner config entry names in `env`; never a variable named `ATELIER_*`, and never one that holds the owner's token. A harness with shell access can still reach the Keychain; agent tokens limit what such a leak can do.

**Limits, fixed at approval:**
- `maxParallel` 2;
- 3 attempts per part, 2 review rounds;
- `maxJobs` = 4 × parts;
- a 24-hour deadline;
- paid models only by opt-in;
- one active plan per project.

Reaching any limit blocks the plan; it never continues silently. The approval records the limits (`limitsFor` in `src/plans/state.ts`) and sets the Durable Object's alarm for the deadline, whose tick blocks a plan still unfinished. One active plan per project is checked when a plan is created.

## 8. Build sequence

**Pure functions with `node --test`:** 1, 2, 3, 4, 7a, 8, 11.
**Workers specs:** 5, 6, 9, 12, 13.
**Runner tests (`.mjs`):** 7b, 10, 14.

**t15: Plans**
1. **Schema and hash.** `src/plans/schema.ts`, `test/plans-schema.test.ts`. Built. Acceptance: unknown fields and caps are refused; the hash does not depend on key order.
2. **Validation.** `src/plans/validate.ts`. Built. Acceptance: a cycle is named; unordered overlaps are refused; interfaces depend only on interfaces; scope counts are capped. Model context-window sizing belongs to step 3.
3. **Part routing.** `src/plans/route.ts`, `test/plans-route.test.ts`. Built. Acceptance: the reviewer is from another family; refused and paid models are excluded; governed roles are respected.
4. **The tick, dispatch half.** `src/plans/phase.ts`. Built. Acceptance: scenario tests for dependencies, the parallel limit, retries and blocking.
5. **Ledger and rules.** `src/ledger.ts` and `src/rules.ts` changes (new columns and table; `newPlan`, `postPlan`, `approvePlan`, `dispatchPart`, the tick hook; inbox kinds; same-plan overlap). Test: `test/plans.spec.ts`. Built, with the pure parts in `src/plans/state.ts` and `test/plans-state.test.ts`, and the owner's decisions (`revisePlan`, `reroutePlan`, `retryPlan`, `stopPlan`) and `planView` that step 6's routes call.
6. **Routes and CLI.** `src/index.ts`, `cli/atelier.mjs`. Tests: `routes.spec.ts`, `test/plan-cli.test.mjs`. Built, with the routes tested in `test/plan-routes.spec.ts` and the plan's text and brief in `test/plans-show.test.ts`.
  7. **Server briefs and runner jobs.** 7a: `src/plans/brief.ts`, `test/plans-brief.test.ts`. Built. Acceptance: each section appears only with its input; findings and failing output are capped and say when they are cut; the hash of the inputs does not depend on key order; rework carries the findings. 7b: in `cli/runner.mjs`, the plan job, the `{plan_file}` placeholder, releasing on finish failure, and the scrubbed environment. Built, with the `job-brief` route tested in `test/plan-routes.spec.ts`, the planner brief in `src/plans/brief.ts`, and the runner's plan job, part brief and release on a failed finish in `test/runner-plan.test.mjs`.

**t39: Automatic cross-family review**

8. **Review rules.** `src/review/` with `reviewNeeded`, `pickReviewer`, `parseVerdict` and `reviewBrief`. Built.
9. **Ledger side.** Review requests, review claims, findings, the rework transition, and review jobs in the queue. Built: the `review_requests` table, `reviewTick`, `claimReview` and `releaseReview` in `src/ledger.ts`, the `review-claim` and `review-release` routes, `findings` on `Review`, and the `review.rework` event `phase.ts` reads as a failed finish. Test: `test/review-requests.spec.ts`.
10. **Runner review job.** Built: `runReview` in `cli/runner.mjs`, the `{diff_file}` and `{verdict_file}` placeholders, and the `review` job in the runner's queue offer. Test: `test/review-runner.test.mjs`.

**t16: Integration branch per plan**

11. **Integration rules.** The `integrated` state, `planGate`, and integration verification, in `src/plans/integrate.ts`. Built.
12. **Measuring parts against the plan's fork.** `baseRepoOf`: the claim source, the `base-token` route, the sandbox's base repository, and CLI `check`, `diff` and `update`. Built.
13. **Integrate jobs.** The `integrated` and `integration-failed` routes, the `mergeability` pre-check at the integrator's claim, marking parts merged when the plan merges, and the reserved integrator actor. Built.
14. **Runner `--integrate`.** The integrate and refresh jobs; the merge receipt that lists the parts is not built. Built. The refresh is dispatched by the tick when main has moved and by `atelier plan refresh`, and recorded through the `refreshed` and `refresh-failed` routes. A conflicted refresh, or `atelier plan refresh --resolve`, adds a merge-main part that the runner sets up by merging main into the part's workspace. A part sent back for a conflict with the plan's branch is dispatched with the branch's head, which the runner merges into its workspace the same way. Tests: `test/plan-refresh.spec.ts`, `test/plan-merge-main.spec.ts`, `test/plan-merge-plan.spec.ts`, `test/integrate-runner.test.mjs`, `test/runner-merge-main.test.mjs`, `test/runner-merge-plan.test.mjs`.

## Deferred work

- A web page for plans.
- Merging in Cloudflare (t47).
- A second model reviewing the plan before the owner sees it.
- More than one active plan per project.
- Re-planning after approval.
- A cloud runner.
- Metering spend per token: the harnesses report no usage data.

### Implementation files
- `src/ledger.ts`
- `src/rules.ts`
- `src/index.ts`
- `cli/runner.mjs`
- `src/models/routing.ts`
