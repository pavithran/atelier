# t418 work report

Unfinished. No push or submission was made. The referenced
`../ai-projects-house-style/house-style.md` was unavailable and was not read.

The change adds the catch-up command, its declaration and help fixtures,
orchestration tests and real-server landing tests. The merge handler now permits
a registered checkout exactly at the accepted head; extra unreviewed commits
remain refused. The shared landing test fixture preserves the inherited slot
lease so nested checks reuse the host slot.

## Findings still open

The real-server tests found two problems that must be fixed before review:

1. The Git pre-receive hook refuses publication of the accepted head itself:
   `a landing merges the accepted head …, which this commit's parents do not include`.
   The server's merge-record route also requires the accepted head as a parent.
   These contracts need a narrowly bound exception for publishing the exact
   accepted head, with refusal tests. The CLI exception alone is insufficient.
2. `done` exits 3 for a submitted task awaiting independent approval. Catch-up
   currently treats that as a failed command and stops before asking for review.
   The completion path needs to distinguish this outcome from a failed check.

No historical finding listed in the task was changed; those findings concern
other behavior. The findings addressed so far are the checkout-ahead refusal
and the missing command, but neither acceptance criterion is fully validated.

## Validation

Every test command used this prefix:

```
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' --
```

Scratch output and test temporary paths were directed into this workspace's
`.scratch` using `TMPDIR="$PWD/.scratch"` for the project runs.

Before implementation, `node --test test/catch-up.test.mjs` failed with
`ERR_MODULE_NOT_FOUND`. With unimplemented functions in place, the same command
reported 13 tests, 7 pass, 6 fail, including `catch-up is not implemented` and
`false !== true` for accepting the exact head. After implementation it reported
13 tests, 13 pass, 0 fail. Crash tests at carry, finish and landing confirm
that the completion line is absent on failure.

The final focused command was:

```
node test/run.mjs test/catch-up.test.mjs test/catch-up-landing.test.mjs
```

It reported 16 tests, 14 pass, 2 fail. The two failures are the open findings
above. The refusal of extra commits passed against the real server and hook.

`npm run typecheck` passed, exit 0:

```
> tsc -p . && tsc -p test
```

The full command was launched as:

```
ATELIER_TEST_TIMEOUT_MS=3600000 node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- sh -c 'date +%s; exec npm test'
```

It was queued at epoch 1793661919 and acquired its slot at 1793661980
(61 seconds waiting). It was stopped after unrelated failures appeared,
following the instruction to stop rather than change failing tests outside
the task. This was not a suite timeout and the full suite did not pass.

An isolated run of the unchanged `bin/orchestrate/review-bake.test.mjs` reproduced
6 pass and 3 fail:

- Line 132, the Codex blind brief test: `ENOENT` opening
  `.scratch/atelier-review-bake-…/codex.jsonl`.
- Line 157, retry without a verdict: actual `[2, false]`, expected `[2, true]`.
- Line 246, collecting scorer replies: actual `[2, false]`, expected `[1, true]`.

Those files were left unchanged. The full run also reported failures in
`test/claim-branch-runner.test.mjs` and the check-clone test in
`test/claim-branch.test.mjs`; these were not investigated or changed.

## Contracts and remaining review

No route or disclosure-level contract was changed in this revision. The new
command reuses owner task creation and landing, builder claim and publication,
and independent review. Existing token, ownership, acceptance and lease checks
remain server responsibilities. Before the required hook and merge-record
exceptions are built, their callers and refusal cases must be enumerated and
tested. CLI help, usage fixtures, the shared command registry and the web
command reference receive the new command declaration. No screenshots were
taken; no page layout or styling was changed.

Live reviewer availability and remote service behavior were not validated.
The implementation needs further work and passing validation before submission.
