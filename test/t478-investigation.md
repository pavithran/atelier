# t478 investigation, incomplete

## Retry from 9571f432 on 2026-11-03

Preserved the earlier attempts and retried the required commands:

```text
node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- sh -c 'date +%s; ATELIER_TEST_TIMEOUT_MS=3600000 exec npm test'
test slots: unable to open database file
exit 1

node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- npm run typecheck
test slots: unable to open database file
exit 1
```

Both commands failed before launching their children. No acquisition timestamp
was printed; neither a slot wait nor a suite run time is available. Pass and
fail counts are unavailable. This is an admission failure, not a suite timeout
or an observed test failure.

No behavior changed, so no red or green result is claimed. No tests were deleted,
skipped, or weakened. The group analysis below remains preliminary; the task
and its acceptance criteria remain unmet. Continuing requires working host
slot admission. No files outside the workspace were inspected or repaired,
and tests were not run outside the wrapper. No atelier command was run and
nothing was pushed. The referenced house-style file remains unavailable inside
the workspace and was not read.

## Further continuation on 2026-11-03

Preserved both earlier commits and retried admission at `4ec3f507`:

```text
node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- sh -c 'date +%s; exec npm test'
test slots: unable to open database file
exit 1

node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- npm run typecheck
test slots: unable to open database file
exit 1
```

Neither child started. The suite's acquisition timestamp was never printed;
there is no acquired-slot wait measurement, suite run time, or pass/fail count.
This is an admission failure, not a suite timeout or a failing test. The
workspace-only restriction prevents repairing the host database. No bypass
was attempted.

No behavior changed, so there is no red or green test result. No tests were
deleted, skipped, or weakened. The group findings and unresolved decisions
below remain preliminary; the acceptance criteria are unmet. No routes,
contracts, visibility rules, UI, generated pages, or completion markers changed.
No atelier command was run and nothing was pushed. The referenced house-style
file is unavailable within this workspace and was not read.

## Continuation on 2026-11-03

Retried validation from the workspace at `3cd311b5`, preserving the earlier
attempt. The host wrapper again refused both commands before starting a child:

```text
node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- node -e '<suite launcher>'
test slots: unable to open database file
exit 1

node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- npm run typecheck
test slots: unable to open database file
exit 1
```

The suite launcher prints an acquisition timestamp, then starts `npm test`
with `ATELIER_TEST_TIMEOUT_MS=3600000` and a 60-minute termination timer.
Neither the timestamp nor test output appeared. Slot wait and suite run time
cannot be measured because admission failed; pass/fail counts are unavailable.
This is neither a suite timeout nor an observed test failure.

No behavior was changed: the required failing-test-first step cannot run.
No tests were deleted, skipped, or weakened. The findings below remain
preliminary and unresolved; the acceptance criteria are not met. No routes,
contracts, visibility rules, UI, generated pages, or completion markers changed.
No new platform dependency was introduced. Nothing was pushed and no atelier
command was run. Continuing requires working host slot admission; this attempt
did not access or repair files outside the workspace. The referenced house-style
file remains unavailable and was not read.

No implementation or test behavior changed. No test was deleted or skipped.
The acceptance criteria remain unmet: the suite has not run and there are no
pass/fail counts for this workspace. Nothing was pushed.

## Validation obstacle

The required host slot wrapper refused both commands before launching their
children:

```text
node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- node -e '<suite launcher>'
test slots: unable to open database file
exit 1

node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- npm run typecheck
test slots: unable to open database file
exit 1
```

The suite launcher would print the slot acquisition time, spawn `npm test`
with output in `.scratch/baseline.log`, and terminate it after 60 minutes.
It never started. Neither command acquired a slot; suite run time and test
counts are unavailable. This was not a suite timeout or a failing test.
There is no red or green test output. Tests were not run outside the wrapper.

Local `cli/load.mjs` documents the host database as
`/tmp/atelier-test-slots-v1.sqlite` and explicitly provides no production path
override. Repairing that host resource would require access outside the
workspace, which this task forbids. Restore host slot admission before
continuing; do not replace it with a private pool or pretend to hold a slot.

## History and preliminary findings

Inspected `git log --oneline 6fec9b6a..HEAD` at `0da075b4`, including the
rules changes in `9a987830` and `aa123570`. These are source-inspection findings,
not a reproduced inventory of all suite failures.

| Reported group | Evidence and cause | Decision and remaining work |
| --- | --- | --- |
| Accept/merge fixture refusals | t437's `9a987830` makes measured code require an independent review even with no protected paths. `src/refresh/lifecycle.cases.mjs` setup submits `src/a.ts` and immediately accepts without a review. | That fixture needs a valid independent approval, retaining all lifecycle assertions. No edit made without a red run. Other fixtures still need individual inspection. |
| Coordinated changes needing no review | The same commit removes the no-review exemption for coordinated code changes. | Tests of that removed exemption should assert the new review requirement. The exact failing cases still need reproduction. |
| riskReviews | `9a987830` initially forced one review; `aa123570` restored project counts with `Math.max(1, r.reviews[risk])`. Documentation remains exempt; executable tests no longer qualify as documentation. | Preserve multi-review gates. Classify each failing assertion against the final policy, rather than reducing all expectations to one. No test or code changed. |
| Secret flags | `test/secret-flag.test.ts` has stale-head and cleared-flag cases expecting `gate(..., passing, []).ready === true` for `src/keys.ts`. The independent review is missing, although the secret blocker is correctly absent. | Supply the review prerequisite while retaining standing-secret and pending-scan refusals. Text-to-text scan cases still need inspection; no conclusion about their implementation yet. |
| reviewNeeded and independentApproval | `approvalsNeeded` now counts code approvals as protected, including coordinated paths; existing single-family rules still apply. | Reproduce each failure and check contributor, model alias, family and policy refusals. No blanket expectation change is justified. |
| Accept override tests | New review prerequisites may affect setups, but no failing run was obtained. | Cause and test-versus-code decision unresolved. Preserve override refusals. |
| reviewBrief tests | No failing run was obtained. | Cause and test-versus-code decision unresolved. |
| atelier-review-sh ENOENT | No failing run was obtained. A prior report in `test/t451-validation.md` records extensionless CommonJS fixtures being treated as ES modules when scratch lives inside this ESM package. This is a lead, not proof of this failure's cause. | Reproduce and inspect fixture stderr before deciding. |

No contracts, routes, disclosure levels, UI, generated pages, or completion
markers were changed. There is no new platform dependency or deployment.
The existing host process-inspection smoke workflow is documented in
`docs/test-slots.md`; it does not establish that this host's database is usable.

The referenced house-style file is unavailable inside this workspace and
was not read. This report and the commit message use plain prose.
