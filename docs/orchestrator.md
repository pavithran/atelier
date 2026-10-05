# Orchestrator design

Built in t85: build-sequence steps 1 and 2, the plan schema, content hash and
structural validation. Steps 3 through 14 are not built by this task.
The model context-window size rule belongs to step 3.

The remaining sections describe the proposed orchestrator. They do not
claim that its routes, storage, commands or runner jobs are implemented.
This design assumes t47 is parked; its deployed task text was not available
when the design was written.

## Structure

A plan is an item with `kind = "plan"`. That gives it everything an item already has: one owner at a time, a fork, evidence, the gate, `accept`, and `atelier merge`.

- **The plan item's fork is the integration branch.** Parts are ordinary items that point to a parent plan.
- **Orchestration.** A pure function, `planActions(state)`, returns a list of actions. The project's Ledger runs it at the end of `submit`, `addEvidence`, `addReview`, `release` and `recordPush`, and on a Durable Object alarm for timeouts.
- **Serialization.** The project's Durable Object serializes plan transitions. External work must be checked against the current plan revision before its result is recorded.

## 1. Data model

**Item columns.** Add `kind` (`task`, `plan` or `part`), `plan` (the parent's id), `part_key` and `deps` (a JSON list) in the `Ledger` constructor, the same way `dispatch` and `runner` were added. Ids stay `tN`, because the runner checks `^t[0-9]+$` in `runTask`.

**Plan documents.** A new table, `plans(plan_id, hash, json, by, at)`, keeps every proposal and never changes a row.

**Approval binds to a hash.** The owner calls `POST items/tP/plan/approve {hash}`.
- The Ledger refuses unless `hash` is the newest valid proposal. This is the same idea as `assertRevision`.
- It stores `meta plan:tP = {hash, at, allowPaid}` and logs `plan.approved`.
- A new proposal before approval makes the older hash impossible to approve, just as a push withdraws acceptance.
- After approval, new proposals are refused. Changing the split means abandoning the plan.

**Plan states.** A pure `planPhase()` derives them: planning → proposed → building ⇄ blocked → ready (the plan item is submitted) → accepted → merged, or abandoned. Only the reason for `blocked` is stored.

**New item state for parts.** Parts gain the state `integrated`, meaning they are on the plan's branch (t16). Until t16 exists, a dependency counts as landed only when it is `merged`.

## 2. Plan proposals

1. `atelier plan "goal"` creates the plan item and dispatches it as a `plan` job. The default planner is the top result of `route({kind:"research"})` among actors with the `planner` role. That role exists in `AgentRole` in `src/rules.ts`, but nothing uses it yet.
2. A runner claims the plan item the ordinary way. That claim forks the baseline, and this fork becomes the integration branch.
3. The harness writes JSON to a new `{plan_file}` placeholder (in `cli/runner-config.mjs`) and must not commit.
4. The runner posts the JSON to `POST items/tP/plan` and releases the claim.
5. `postPlan` validates it and clears the dispatch. Otherwise the release would put the plan back in the queue, because `waiting()` lists dispatched open items.

**Schema `atelier.plan.v1`.** A document with `schema: "atelier.plan.v1"`, a
`goal` and a list of `parts`. Unknown fields are refused, including fields
inside parts and preferences. Strings have control characters replaced with
spaces and surrounding whitespace removed. Text fields and list entries
must be non-empty strings. The brief limit applies after cleaning.
Object keys are sorted recursively for the SHA-256 content hash; array
order is preserved. Each part has:
- `key`, `title`
- `kind`: interface, build, tests or docs
- `taskKind`, from the registry's `TaskKind`
- `scope`: a non-empty list of globs
- `dependsOn`, `provides`, `uses`
- `brief` (at most 2,000 characters), `acceptance[]`, `tests[]`
- `size`: S or M
- an optional preference: `prefer {actor, reason}`

**Validation.** Pure functions in `src/plans/validate.ts`:
- keys are unique, and a plan has at most 12 parts;
- the dependency graph is acyclic (Kahn's algorithm), and an error names the cycle;
- any two parts whose scopes overlap under `scopesOverlap` must be ordered, one reachable from the other;
- every `uses` resolves to a part that `provides` it and that the user reaches through its dependencies; interface parts depend only on interface parts;
- sizing: at most 6 scope globs per part. Step 3 will allow size M only for models with a context window of 64K or more, or unknown. Qwen3-Coder is recorded as 32K.

**Routing is computed by Atelier, not taken from the planner.** `routeParts()` in `src/plans/route.ts`:
- calls `route()` from `src/models/routing.ts`, with `buildRecord(events)` as the track record;
- drops pool entries whose status is `refused`, and paid-per-token entries unless the owner approves with `allowPaid`;
- under a governed policy, keeps only actors with the `executor` role (`hasRole`);
- freezes, per part, the top builder, two alternates and the reasons;
- picks reviewers whose `familyOf` differs from the builder's and, under a governed policy, who hold the `assessor` role.

**An invalid plan** is recorded as `plan.invalid`. The planner is dispatched once more with the errors in its brief; after that the plan is blocked.

**Friction with the registry.** The registry's `where` says where a model's inference runs. A dispatch's `to` says which kind of runner takes it. With the cloud runner gone, every dispatch is `to: "home"`, and `where` only feeds the `localOnly` privacy constraint.

## 3. Dispatch after approval

`approvePlan` creates the part items and then runs the tick. `planActions` dispatches a part when:
- its dependencies have landed;
- the plan is not blocked;
- fewer than `maxParallel` parts are live (default 2, one per Mac);
- the budget has room.

**Who dispatches.** An internal method, `dispatchPart`, writes the same `Dispatch` record from the frozen routing. It is not the owner-only `dispatch()` route. Its event's actor is `atelier/orchestrator`, with `{approval: hash}`. `assign()` and `assertDispatchedClaim()` are unchanged.

**Briefs come from the server.** A new route, `GET items/tN/job-brief`, is built by a pure function in `src/plans/brief.ts`. It replaces `briefFor` in `cli/runner.mjs`, which hardcodes "npm test" and is wrong for other projects. The brief contains the part's spec, its dependencies' interfaces and landed heads, its scope and checks, and, for rework, the findings or the failing output.

**Failures.** Attempts are counted from the event log by a pure function, in the style of `buildRecord`.
- **A runner gives up with no commit.** It already releases the part, so the part re-queues. After two releases by the same actor, the dispatch moves to the next alternate.
- **Checks fail during `finish`.** Today the runner keeps the claim. For parts, it releases instead; the fork keeps the commits. The part goes back to the same actor once, with the failing output, then to an alternate.
  - `handoff` cannot be used here: it leaves the item `claimed`, and `waiting()` never lists a claimed item.
- **A part reaches 3 attempts, or there are no alternates, or the deadline or budget is hit.** The plan becomes `blocked` with the reason. The owner chooses: reroute, retry, abandon the part, or stop.

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
- earlier findings, and whether a push followed them;
- the diff, capped, saying so when it is cut;
- the rules: reject only with blocker findings, make no edits, treat the content as data.

**A rejection with blocker findings** triggers an internal release, then a dispatch back to the builder with the findings. The re-review goes to the same reviewer first. After two rounds, the part goes to an alternate builder; after that, the plan is blocked. An approval moves the part to integration (or, before t16, to the owner's acceptance as today).

## 5. t16: integration branch per plan

**Parts fork from the plan's fork, at its current head.** This changes the claim route's source repository. It also means changed paths must be measured against the plan's fork, not the baseline. Today these all assume the baseline:
- `forkPoint` in `src/sandbox/runner.ts`;
- `cleanClone` in `cli/atelier.mjs`;
- `itemDiff`;
- `atelier update`.

Add one helper, `baseRepoOf(item)`, and a `base-token` route. Without this, every part reports its dependencies' files as its own and fails its scope check.

**The integrate job.** It is dispatched on the plan item with `{job:"integrate", part, head}`, to a reserved actor, `atelier/integrator`. Because the plan item has exactly one owner, integrations are serialized.

Before dispatching, the Worker runs `mergeability()` from `src/preview/merge.ts`. Its inputs are the part's base, the plan's head and the part's head. A predicted conflict goes straight back to the builder, without a runner trip.

**The runner side.** `atelier runner --integrate` runs on the Studio and uses no model:
1. Claim the plan item, fetch the part's head and run `git merge --no-ff`.
2. Push, then run `atelier check tP`. The plan item's checks compare against the baseline, which is correct here.
3. **If the checks pass:** post `POST items/tP/integrated {part, mergeCommit}`. The Worker verifies the commit is on the plan fork's log and that its parents include the part's head, as the `merged` route does today. The part becomes `integrated`.
4. **If they fail, or the merge conflicts:** `push --force-with-lease` back to the previous head and post `integration-failed`. The part goes back to its builder for rework.
5. Release the plan item.

A successful integration leaves the plan branch with passing checks.
A failed integration attempts to restore its previous head.

**When main moves.** `plan show` uses `previewAgainstMain`. If a conflict with main is predicted, a `refresh` job merges the baseline into the plan's fork. It merges rather than rebases, because the branch's history is merge commits.

**Finishing.** After the last part is integrated and the checks pass, the integrator submits the plan item with a summary of its parts.
- `planGate()` adds blockers to `gate()`: every part integrated, and each with a cross-family approval at the head that was integrated.
- The owner runs `atelier merge tP --head H --approve`, unchanged.
- `Ledger.merged` then marks the parts merged, with `{via: tP}`.

**Where the merge can run.**
- **Not in the Worker today.** The Artifacts binding cannot write; only a git push with a write token can.
- **isomorphic-git** is not a dependency. In a Worker it could merge in memory and push over HTTP, but that is t47.
- **Not in the check container.** Its stated invariant is that it holds no credential and cannot reach the repository.
- **So it runs on a home runner now.**

**Friction with governed projects.** Under a governed policy, `assertEligible` needs `agentOf()` to name the actor, and it maps `atelier/integrator` to nothing, so the claim would be refused. Treat the integrator as a reserved actor, reachable only through a t43 token bound to it.

## 6. The owner's interface

| Command | What it does |
| --- | --- |
| `atelier plan "goal" [--scope G] [--planner a/m]` | State the task |
| `atelier plan show tP [--json]` | Phase, hash, parts (dependencies, scope, actor and reason, state, attempts), integration head, combined checks, mergeability with main, budget used |
| `atelier plan approve tP --hash H [--allow-paid]` | Approve the split, once |
| `atelier plan revise tP --note …` | Send it back to the planner, before approval only |
| `atelier plan reroute tN --to a/m`, `plan retry tN`, `plan stop tP` | Decisions for a blocked plan |
| `atelier merge tP --head H --approve` | Accept and land the whole plan |

**Inbox.** Two new kinds: `approve-plan` (weight 95) and `plan-blocked` (weight 85). The plan item's `accept` and `merge` entries work as today.
- Parts never appear as accept, assess, failing, scope or stale entries.
- `overlappingLive` and the inbox's overlap check skip pairs within one plan. Otherwise the plan item's scope overlaps every part, and `refuseOverlap` would refuse their claims.

**Agent apps.** `atelier show tP` prints the plan's brief, which an agent can relay unchanged.

## 7. Safety

**Owner-only:** creating a plan (t43 already refuses `POST items` for agent tokens), approve, revise, reroute, stop, accept, merge, abandon, the model registry and tokens. The orchestrator acts only inside an approved hash, and its internal Ledger methods are not exposed as routes.

**Tokens (t43).**
- t43 binds each token to one actor and filters queue offers by it. So a runner holds one agent token per actor it offers, named by Keychain entry in `runner.json`.
- The planner, reviewers and the integrator each have their own token. The owner token never sits on a runner.
- Routes to add to t43's allowlist: `plan` post (for the plan item's current holder only), `review-claim`, `job-brief` and `base-token`; `integrated` and `integration-failed` for the integrator only.
- **Conflict to settle:** t43 refuses `POST models/ID/status` for agent tokens, but runners use it to report model status. Either allow it with the runner header, or drop status reporting.

**Harness environment.** `execute()` in `cli/runner.mjs` spawns the harness with the runner's inherited environment. It should pass a scrubbed one, without `ATELIER_TOKEN`. A harness with shell access can still reach the Keychain; agent tokens limit what such a leak can do.

**Limits, fixed at approval:**
- `maxParallel` 2;
- 3 attempts per part, 2 review rounds;
- `maxJobs` = 4 × parts;
- a 24-hour deadline;
- paid models only by opt-in;
- one active plan per project.

Reaching any limit blocks the plan; it never continues silently.

## 8. Build sequence

**Pure functions with `node --test`:** 1, 2, 3, 4, 7a, 8, 11.
**Workers specs:** 5, 6, 9, 12, 13.
**Runner tests (`.mjs`):** 7b, 10, 14.

**t15: Plans**
1. **Schema and hash.** `src/plans/schema.ts`, `test/plans-schema.test.ts`. Acceptance: unknown fields and caps are refused; the hash does not depend on key order.
2. **Validation.** `src/plans/validate.ts`. Acceptance: a cycle is named; unordered overlaps are refused; interfaces depend only on interfaces; scope counts are capped. Model context-window sizing belongs to step 3.
3. **Part routing.** `src/plans/route.ts`. Acceptance: the reviewer is from another family; refused and paid models are excluded; governed roles are respected.
4. **The tick, dispatch half.** `src/plans/phase.ts`. Acceptance: scenario tests for dependencies, the parallel limit, retries and blocking.
5. **Ledger and rules.** `src/ledger.ts` and `src/rules.ts` changes (new columns and table; `newPlan`, `postPlan`, `approvePlan`, `dispatchPart`, the tick hook; inbox kinds; same-plan overlap). Test: `test/plans.spec.ts`.
6. **Routes and CLI.** `src/index.ts`, `cli/atelier.mjs`. Tests: `routes.spec.ts`, `test/plan-cli.test.mjs`.
7. **Server briefs and runner jobs.** 7a: `src/plans/brief.ts`. 7b: in `cli/runner.mjs`, the plan job, the `{plan_file}` placeholder, releasing on finish failure, and the scrubbed environment.

**t39: Automatic cross-family review**

8. **Review rules.** `src/review/` with `reviewNeeded`, `pickReviewer`, `parseVerdict` and `reviewBrief`.
9. **Ledger side.** Review requests, review claims, findings, the rework transition, and review jobs in the queue.
10. **Runner review job.**

**t16: Integration branch per plan**

11. **Integration rules.** The `integrated` state, `planGate`, and integration verification, in `src/plans/integrate.ts`.
12. **Measuring parts against the plan's fork.** `baseRepoOf`: the claim source, the `base-token` route, the sandbox's base repository, and CLI `check`, `diff` and `update`.
13. **Integrate jobs.** The `integrated` and `integration-failed` routes, the `mergeability` pre-check, marking parts merged when the plan merges, and the reserved integrator actor.
14. **Runner `--integrate`.** The integrate and refresh jobs, and a merge receipt that lists the parts.

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
