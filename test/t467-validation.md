t467 validation

Addressed: claimed and submitted tasks could remain held with no ledger event for over an hour without a finding. The report now adds task-idle only past 60 minutes, using the newest task event, and names the holder, elapsed minutes and last event. Blocked tasks are omitted. With no event the task's updatedAt is the available bound. No setting was added. Existing independent core-hold and no-push checks remain.

Addressed: claimed reviews used a two-hour default. The default is now one hour; the existing override remains compatible. The original claim event still starts the clock, renewals do not reset it, and a re-claim starts a new clock. The ledger snapshot includes only claimed, unsuperseded requests, so a verdict removes the request from this check. Old heads and blocked or closed tasks remain excluded. Review detail preserves the prior episode key, so elapsed minutes and later task events do not reopen the same review episode.

All test commands used the required host slot wrapper, abbreviated below as W:

```text
W = node /Users/pavi/ai-projects/atelier-runner/cli/load.mjs --
```

Tests were written before the behavior change. Red:

```text
W node --test --test-name-pattern='without movement|without a verdict is reported' cli/stuck.test.mjs
2 tests, 0 passed, 2 failed; each reported actual 0, expected 1.

W node test/run.mjs test/stuck-episodes.test.ts
5 tests, 4 passed, 1 failed.
Actual review cause included '; no verdict for 60 minutes; last event ...';
expected the existing 'review:review request 1 claimed by reviewer/model' key.
```

Green:

```text
W node test/run.mjs cli/stuck.test.mjs test/stuck-episodes.test.ts
35 tests, 35 passed, 0 failed.

W node test/run.mjs test/cli-text.test.mjs cli/stuck.worker.spec.mjs test/stuck-view.test.mjs test/stuck-notices.test.ts
24 tests, 24 passed, 0 failed.

W node test/run.mjs test/review-requests.spec.ts test/stuck-episodes.spec.ts test/stage-tick.spec.ts
76 tests, 76 passed, 0 failed.

W npm run typecheck
> tsc -p . && tsc -p test
exit 0
```

The full required suite ran with a 60-minute held-slot budget:

```text
W sh -c 'date +%s; ATELIER_TEST_TIMEOUT_MS=3600000 npm test'
Held-slot timestamp: 1793724352
6277 tests, 6259 passed, 12 failed, 6 skipped; exit 1.
Run duration: 594.4 seconds. No timeout.
```

The full run's production sources were the final sources. Its seven change-related failures were stale expectations: the pinned help, the review re-claim boundary, the stage tick's episode count, and four episode lifecycle/rename assertions. Those fixtures and assertions were updated and all seven passed in the focused reruns above. The full suite was not repeated after these test-only corrections. The local full output is .scratch/t467-suite.log.

Five failures outside this change remain untouched:

| Test | Output |
| --- | --- |
| test/acting-model.test.mjs:48, a write on the developer token with no acting model is refused, naming --as; reads are free | 't1 Nobody named'; actual exit 0, expected 1 |
| test/acting-model.test.mjs:93, every write on the developer token records the acting model, the verbs that need words record them, and show lists both | actual actor codex/gpt-6.1-sol, expected owner |
| test/situation.test.mjs:223, every error under --json is {code, detail, next}: a server refusal and an error of the CLI's own | actual no_item, expected refused |
| test/orchestrate-stdin.test.mjs:92, review.sh passes its prompt to agy on standard input, not as an argument | ENOENT opening the fixture's record.json |
| test/orchestrate-stdin.test.mjs:125, review.sh names the prose standard the policy records, says when the lookup failed, and lets PROSE_STANDARD override | assertion 'the recorded standard is named': actual false, expected true |

The first three also appear in earlier workspace validation reports, including test/t453-validation.md. No unrelated test or production behavior was changed to address them.

The response shape is unchanged; the task-idle entry kind is additive. Callers and compatibility checks:

| Caller | Update or check |
| --- | --- |
| GET /api/projects/:project/stuck, readStuckReport | Existing report shape; real snapshot and read-only checks passed in cli/stuck.worker.spec.mjs. |
| cli/commands/stuck.mjs, text and JSON | Generic entry rendering accepts task-idle. Project and task remain in the existing envelope/subject; reasons now include holder, minutes and last event. cli/stuck.test.mjs passed. |
| cli/status.mjs readStuck/stuckLines; status, unwrap, inbox | Generic entries flow through openStuck. View ordering, partial reads and unavailable diagnostics passed in test/stuck-view.test.mjs. |
| recordStuckEpisodes, ledger episode reconciliation | Updated full-result assertions for both old task and new task-idle causes. Lifecycle, recurrence, rename, incomplete reads and stale observations passed. |
| dueNotices, notifyStuck, stuckBatchRequests | Generic episode reasons remain compatible; batching, delayed sends, failed sends and ambiguous failures passed. |
| Review snapshot callers and direct report test callers | Full suite exercised these callers; the changed one-hour renewal/re-claim contract passed in test/review-requests.spec.ts. |
| Generated CLI help and shared command reference | src/usage/commands/stuck.ts describes the fixed task threshold and one-hour review default; test/fixtures/cli/usage.json updated. Pinned text and shared web-reference description checks passed. No generated page consumes stuckReport directly. |

Trust checks remain unchanged. GET /api/projects/:project/stuck, /stuck/episodes and /stuck/tick require the authenticated owner identity. They are reads: no task membership or edit grant is consulted. Agent/runner identities cannot opt into owner disclosure with a requested level; there is no disclosure-level parameter. cli/stuck.worker.spec.mjs tested the non-owner 403 and invalid-limit 400; cli/stuck.test.mjs checked agentRoute refuses the report route. The owner snapshot read is tested not to change events or renew a lease.

| Output path | Authenticated owner | Non-owner |
| --- | --- | --- |
| Report response, CLI JSON/text and derived ages/reasons | Full diagnostic report | Owner-only route refused (403 for a non-owner actor) |
| Episode response and status/unwrap/inbox copy | Existing owner diagnostics, including the new generic entry | Owner-only diagnostics; no new access path |
| Search snippets | No stuck-report output | No stuck-report output |
| Exports | No new export; existing owner CLI JSON uses the report response | No new export |
| UI copy and generated pages | Command reference describes thresholds without task data | Same command documentation, no task data |
| Notifications | Existing configured developer channel receives due episode reasons | No new audience or channel |

This is a diagnostic and command-help change with no browser layout or page implementation change. No browser screenshots were taken. No new status, version or completion marker is written. Existing failed-send tests verify that a failed notification records nothing before success; episode tests preserve incomplete-read behavior. There is no new platform limit or runtime dependency requiring a remote smoke check, and no deployment was performed.

The referenced ../ai-projects-house-style/house-style.md was unavailable in this workspace, as the task warned. It was not read or guessed. Prose is plain.
