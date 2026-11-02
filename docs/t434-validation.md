# t434 checkpoint

This work is incomplete. Validation stopped after confirming an unrelated
failure in the original review-guide snapshot, as requested. Nothing was pushed
and no atelier command was run directly. Project tests invoke the CLI themselves.
The referenced house-style file was unavailable and was not read.

## Findings addressed

- A checked and approved ordinary task already lands without a separate accept
  command. The existing recorded-approval landing test covers that path.
- `--next-gate developer` now stops a landing before its lease and is checked
  again before automatic acceptance. An accepted task can resume landing.
- Shared attention output distinguishes Land from Accept, preserving the legacy
  `kind: accept` field. Status, inbox, the waiting lists and documentation use
  that distinction. The brief's sentence says Land for ordinary tasks.

Remaining: the brief's machine recommendation verdict is still `accept`, so
`show` and the brief's UI badge can still print accept on the common path.
Acceptance criterion 3 is therefore not fully met. No completion is claimed.

## Commands and output

Every test command below used this prefix:

`node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' --`

| Command after the prefix | Result |
| --- | --- |
| `node test/run.mjs test/brief.test.ts test/land.test.mjs` before the fix | Red: 39 tests, 37 pass, 2 fail. Expected `Land t21…`, received `Accept t21…`; developer-held landing returned 0 and merged instead of refusing. |
| Same command after the fix | Green: 39 tests, 39 pass, 0 fail; 11.72 seconds. |
| `node test/run.mjs test/attention.test.ts` before the attention change | Red: 10 tests, 9 pass, 1 fail; expected `land`, received `accept`. |
| `node test/run.mjs test/owner-path.test.mjs test/ui.spec.ts test/attention.test.ts` after the change | 111 tests, 110 pass, 1 fail: `built-in review guide snapshot`. All attention and UI tests passed. |
| `node --import ./src/runtime/loader.mjs --test --test-name-pattern='built-in review guide snapshot' .scratch/owner-path-baseline.test.mjs` | Original test and snapshot copied from HEAD: 1 test, 0 pass, 1 fail, snapshot mismatch. `src/usage.ts`, which supplies the role prompt, has no diff from HEAD. |
| `sh -c 'date +%s; ATELIER_TEST_TIMEOUT_MS=3600000 npm test'` | Full suite started, then stopped with SIGTERM under the stop-on-unrelated-failure instruction. Exit 143; this was not a timeout. |
| `npm run typecheck` | Green: `tsc -p . && tsc -p test`, exit 0, including a final run after the source changes. |

The full suite also reported these unfixed failures in
`test/acting-model.test.mjs`; their baseline status was not independently tested:

- `a write on the developer token with no acting model is refused, naming --as; reads are free`
- `every write on the developer token records the acting model, the verbs that need words record them, and show lists both`

The suite was requested at Unix time 1793660897 and acquired its slot at
1793660948: 51 seconds queued. It was stopped about 126 seconds after acquiring
the slot. The held-slot budget was 60 minutes. Detailed output is in
`../.scratch/full-suite.log`, `../.scratch/focused.log`,
`../.scratch/baseline.log` and `../.scratch/typecheck.log`.

The refusal test verifies that the task remains submitted and that no accept,
merged record or lease grant is written before the developer decision. This
change adds no completion or version marker.

## Callers and compatibility

The `OwnerCall` union adds `land`. Its labels and tones are updated in
`src/attention.ts` and `src/ui.ts`; the legacy mapping still emits `kind: accept`.
Consumers checked: `src/standing-read.ts`, the owner portfolio readers in
`src/index.ts`, all four attention readers in `cli/status.mjs`, standing and
inbox JSON, and the Home, Decisions and project Overview generated pages.
Their shared fixture, JSON snapshots and UI expectations were updated and
passed in the focused run.

The brief sentence is also consumed by the task page, selected Decisions
detail, standing brief, `show`, and `src/notify.ts`. The machine verdict remains
compatible but is the outstanding hint problem described above. The land help
source and its generated usage fixture were updated together. Plans retain
their separate acceptance workflow. No route, credential, membership rule or
disclosure policy was changed; this checkpoint does not claim a new security
or visibility-contract audit.

## Visual evidence

The documented `scripts/design/capture.ts` workflow was copied to
`../.scratch/capture.ts`, with output kept in `.scratch`, its temporary render
directory removed, and unrelated contrast, keyboard and reflow audits skipped.
It used the documented production renderer and intercepted page/assets requests;
no additional server was started. Before rendering used HEAD versions of the
three changed presentation sources; after rendering used this workspace's edits.

Both runs captured 92 screenshots across all 46 documented page states at
1440 and 390 pixels, using Chromium 149.0.7827.55. The manifests enumerate every
page, audience and screenshot:

- [Before manifest](../.scratch/before-manifest.json)
- [After manifest](../.scratch/after-manifest.json)
- [Before console and network audit](../.scratch/before-audit.json)
- [After console and network audit](../.scratch/after-audit.json)
- [After capture output](../.scratch/after-capture.log)

Unexpected console/network failures: none in either run. Expected error-page
console messages were 401 for the public owner route, 503 for the unavailable
project, and 404 for missing branches/tasks. These were filtered by the
documented workflow. Sign-in produced its existing username-field accessibility
message.

Affected owner pages are Home, Decisions (including selected detail), project
Overview and task detail. Their before/after images are included in the
manifests. Public and Access audience states were also captured. This fixture
does not exercise every audience against every affected URL; that evidence
remains incomplete. Search snippets and exports were not changed or newly
validated. These are capture limitations, not claims about production access.

No new platform-dependent behavior was introduced. These local fixtures do not
establish a successful production deployment or replace the project's remote
smoke checks. No deployment was attempted.
