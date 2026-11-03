# t478 continuation: incomplete

This commit preserves seven test-file updates. It does not complete t478 or
establish a green full suite. No production behavior changed. No test was
deleted, skipped, or disabled by this attempt.

## Evidence before further review

The baseline command was:

```text
node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- sh -c 'date +%s; ATELIER_TEST_TIMEOUT_MS=3600000 exec npm test'
1793735419
exit 1
duration_ms 574665.6925
```

The retained output contains 145 distinct failing test names, plus two acting
model failures observed in an earlier output chunk. Output truncation prevents
an exact full-suite pass/fail count. The final custom-pool footer reported zero
tests despite the individual results; those zeros are not valid suite counts.
This was a failing run, not a timeout. The acquisition timestamp above starts
the suite budget; the initial slot wait was not recorded precisely.

```text
node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- npm run typecheck
> tsc -p . && tsc -p test
exit 0
```

An intermediate run selected the changed test files, the design fixture spec,
and orchestrate-stdin through `.scratch/t478-run.mjs`, under the same host
wrapper, with TMPDIR inside this workspace. Its complete output remains in
`.scratch/targeted.log`:

```text
slot acquired 1793736589803
tests 568
pass 543
fail 25
skipped 0
run time 13578 ms; exit 1
```

That run included a larger draft than this commit. It passed the secret-flag,
secret-transition, override-policy, single-family, review, and import-guard
files after their updates. It reproduced three orchestrator fixture failures
under workspace-local scratch, including the reported review-sh ENOENT. The
ES-module fixture correction in this commit has not yet had a green run.
No green result is claimed for the committed tree as a whole.

## Findings and decisions

History inspected: `git log --oneline 6fec9b6a..0da075b4`, particularly t437's
`9a987830` and its follow-up `aa123570`. The latter preserves project review
counts above one. Neither justifies weakening secret or independence gates.

| Group | Cause and decision | Current commit |
| --- | --- | --- |
| Accept/merge setup refusals | t437 requires an independent approval for code even without protected paths. Setups must meet that prerequisite. | Most remain unresolved. The earlier report's lifecycle.cases example is not imported or discovered by the current suite; the active task-refresh spec does reproduce refusals. |
| Coordinated no-review expectations | t437 deliberately removed this exemption for code. | Update reviewNeeded assertions to require review with and without legacy execution policy. |
| riskReviews and independence | t437 requires cross-company approvals for code; aa123570 retains higher project counts. | Keep the two-review test, use two eligible companies, and explicitly refuse the builder's company. Executable tests require review; documentation remains exempt. |
| Override and single-family fixtures | AGENTS.md is now exempt documentation even under a protected glob, so it no longer exercises a missing-review gate. | Use protected security.ts in the pure override and single-family fixtures. Keep owner, contributor, company, expiry, and noOverride refusals. Route fixtures remain unresolved. |
| Secret flags and text transitions | Clean, stale, or cleared scans were expected to clear the entire gate without the new review prerequisite. | Supply an independent approval while retaining the standing-secret, unscanned-file, pending-scan, and transition-table assertions. Ledger secret fixtures outside these two files remain unresolved. |
| reviewBrief | Its protected task fixtures used exempt AGENTS.md, so reviewNeeded returned no need before the brief could be rendered. | Use protected code; retain the brief's existing content assertions. |
| Import guard | t437 added the literal wrangler.toml as project policy data without updating the exact-literal allowlist. | Add that literal to the existing rules-test data exception. The package-import ban and stale-exception check remain. |
| review-sh ENOENT | Workspace-local scratch inherits this package's module type. The extensionless stand-in uses CommonJS require, fails before writing record.json, and the test then gets ENOENT. Two run-agent fixtures fail at the version probe for the same reason. | Change only the generated stand-in to an ES-module import. Red reproduced; green remains pending. |
| Decision briefs and notifications without evidence | t437 makes the gate need an assessor before a push or path measurement exists. Several former wait assertions and notification timing assertions fail; reviewNeeded itself still waits for measurements and passing checks. | Intended-behavior decision requested; no production change made. |
| Plan integration, fast audits, refresh, grants, token scope, and generated fixture states | Many initial failures are missing review prerequisites or documentation fixtures. Once prerequisites were supplied in the intermediate draft, some tests reached further integration-dispatch and state assertions. | Not fully resolved. Do not claim all are fixture-only problems. |
| Acting-model and CLI error tests | Reproduced failures include an expected refused code answered as no_item. | Cause remains unproved; no change retained. |

No contract was changed or tightened. No endpoint authorization, disclosure
level, generated page implementation, UI implementation, or completion marker
changed. Existing refusal assertions in the retained tests remain in place.
No new platform dependency or deploy behavior was introduced.

## Why work stopped

The intended-behavior question is whether a submitted task without a push or
measured diff should retain the prior wait recommendation or immediately
recommend review. Acceptance remains blocked either way. The task asks the
builder to stop when a group needs an intended-behavior decision.

There is also concurrent work in this workspace. After the intermediate run,
the reflog recorded a reset to HEAD at 2026-11-03 20:10:57 UTC, removing this
attempt's tracked draft. Another host wrapper, PID 55578, started a t478 full
suite at 20:11:10 UTC. Neither action came from this turn. The existing
investigation report was subsequently deleted by another writer. This commit
does not stage that deletion. Seven recovered test updates are preserved;
the broader lost draft is not claimed as delivered. A queued verification of
the recovered files was cancelled to avoid competing with that run. The user
was asked which run should own the workspace.

No atelier command was run and nothing was pushed. The referenced house-style
file is unavailable inside this workspace and was not read. This report and
the commit message use plain prose.
