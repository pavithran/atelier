# t461 validation

The finding addressed is a ship command that hangs without appearing in stuck
or status. Ship now records a command start before running it. A command still
open after 60 minutes appears with the ship id, step, command and server start
time. A completed run or ship clears it. A later command replaces the prior
start because ship runs commands in sequence. A crash leaves the start visible
and does not claim completion.

The orchestrating guide requires deploys through `atelier ship` and deadlines
for long commands. Deploys outside ship remain out of scope.

## Trust checks and output paths

| Endpoint | Caller and project checks | Write right and disclosure source |
| --- | --- | --- |
| POST projects/P/actions/starts | Authenticated project owner; agent tokens refused by the route allowlist; project scope checked by the existing router | Owner checked in actionsApi and again in the ledger rule; timestamp is the server event time; requested disclosure levels have no effect |
| GET projects/P/stuck | Authenticated project owner; existing project scope checks | Read only; requireOwner determines access |
| GET projects/P/stuck/episodes and stuck/tick | Authenticated project owner; existing project scope checks | Read only; requireOwner determines access |

There is no separate membership or edit grant for these owner operations.
The authenticated owner identity grants access. No caller-supplied visibility
level grants it. Tests refuse an agent token and another actor for starts;
unit tests refuse an invalid revision before writing. Existing stuck route
tests refuse a non-owner.

| Output path | Owner | Agent or other actor |
| --- | --- | --- |
| Stuck response | Overdue step, command and start time | Refused |
| Status text and JSON | Existing stuck reader carries the finding | Existing status code does not request stuck diagnostics |
| Derived stuck episodes | Existing cause and episode machinery accepts ship findings | Owner-only episode route |
| Search snippets | No new indexing or snippet path | No change |
| Exports | Existing ledger event exports can include action.started | Existing export authorization unchanged |
| UI copy and generated pages | No page or template changed; starts are separate from completed action runs | No change |

This is an additive contract. Ship requires the new named capability
`ship.step-start.v1` before its first dependent operation, so an older server
refuses before the ship runs. The frozen route level is unchanged. The only new endpoint caller is cli/ship.mjs;
it records normal commands, request checks, wrap and push before executing.
The mock ship server and checkout-lease fixture accept starts. Existing actions GET, action-run history,
actions-page and project ship page still read action.ran only, so a start
cannot be displayed as a passed run. Existing status, unwrap and inbox use the
shared stuck view and need no schema change. There are no generated-page
callers of the new endpoint. No browser UI changed.

## Red and green evidence

All test commands use the host wrapper:
`node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' --`.

Red: `node test/run.mjs test/ship-stuck.test.mjs` reported 1 test, 0 pass,
1 fail: `0 !== 1` for the missing overdue entry at 61 minutes.

Green: `node test/run.mjs test/ship-stuck.test.mjs test/ship.test.mjs`
reported 43 tests, 43 pass, 0 fail. The expanded targeted run with
`test/actions.test.ts` reported 57 tests, 57 pass, 0 fail. These cover owner
refusal, malformed starts, command matching and a crash before completion.

The final focused run, `node test/run.mjs test/ship-stuck.test.mjs`, reported
4 tests, 4 pass, 0 fail, including authenticated-owner route checks and sequential
command replacement. The first full suite exposed the checkout-lease fixture's
missing starts endpoint: its wait-for-deploy test timed out. That fixture was
updated; the initial suite was stopped and the full suite restarted.
`npm run typecheck` passed (exit 0).

No new platform limit or runtime dependency requires a remote-only check;
the report uses existing ledger timestamps and diagnostic paths. This task
does not deploy. The referenced ../ai-projects-house-style/house-style.md was
unavailable and could not be read within the workspace restriction. Prose was
written plainly.

## Final validation result

The final source passed `npm run typecheck` (exit 0).

The expanded focused command was:

```text
node test/run.mjs test/runner.test.mjs test/runner-2.test.mjs test/runner-refused.test.mjs test/runner-limit.test.mjs test/capabilities.test.mjs test/ship-stuck.test.mjs
```

It reported 223 tests, 223 pass, 0 fail. The capability test's fixed command
list was updated to include ship. The final five ship-stuck tests pass.

The full command was run through the host wrapper with a budget measured
inside the held slot:

```text
sh -c 'date -u +%FT%TZ; ATELIER_TEST_TIMEOUT_MS=3600000 npm test'
```

That completed run acquired its slot at 16:11:13 UTC, ran for 586.8 seconds
and exited 1. It found the capability-list expectation corrected above and
baseline failures. A later full run with the corrected expectation acquired
its slot at 16:22:34 UTC. Its output was saved in .scratch/t461-suite.log.
It reproduced the two acting-model failures below, so it was stopped under
the task's instruction to stop on out-of-scope baseline failures. Neither
full run timed out. The full suite is not green.

A diagnostic `node test/run.mjs test/acting-model.test.mjs`, also through the
host wrapper, reproduced 5 tests, 3 pass, 2 fail:

| Unfixed baseline test | Output |
| --- | --- |
| test/acting-model.test.mjs:48, a write on the developer token with no acting model is refused, naming --as; reads are free | `t1 Nobody named`; actual exit 0, expected 1 |
| test/acting-model.test.mjs:93, every write on the developer token records the acting model, the verbs that need words record them, and show lists both | event actor `codex/gpt-6.1-sol`, expected `owner` |

The completed full run also reported `no_item` where `refused` was expected.
This matches the existing test/situation.test.mjs:223 baseline failure listed
in test/t458-validation.md. The initial status update called this a runner
failure; the existing report identifies it as the situation test. No runner,
situation or acting-model implementation or test was changed. The same two
acting-model failures are documented in test/t450-validation.md,
test/t451-validation.md, test/t453-validation.md and test/t458-validation.md.
They are outside this task's scope and were left unchanged.

No push or atelier command was run directly. The project tests invoke their
own CLI fixtures. The full-suite failures above remain unresolved.
