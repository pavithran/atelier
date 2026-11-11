# t598 evidence: each criterion's command, red, green

Run from the workspace root, each through the host slot wrapper:

    node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- node test/run.mjs test/slate.test.ts test/slate-store.spec.ts

Typecheck: `npm run typecheck` (`tsc -p . && tsc -p test`), clean at this head.

## Red on main

The brief says nothing on main builds a slate: `src/models/slate.ts`,
`src/models/slate-store.ts` and the two tables are new, so every test file
below imports a module main does not have and fails to load there. I could
not query `main` from this workspace (the sandbox refused git commands that
name it), so that red is from the brief and the file list, not a run on main.

## Red on 47438548 for the fix round (observed)

The two tests added in this round, run before the fixes:

    ✖ global pick: a runner scoped to one project still serves the global slate, and pausing its harness writes the held record in the same call
      AssertionError: expected null to be 'codex/gpt-6-astra'
    ✖ buildSlate judges each model by the job's role: a review-only model serves review jobs, a build-only one does not
      AssertionError: review-claude
      + actual: 'zcode/glm-5'   - expected: 'codex/gpt-6-astra'
    ℹ tests 21  ℹ pass 19  ℹ fail 2

## Green at the head

    ℹ tests 21
    ℹ pass 21
    ℹ fail 0

Also green, since `eligibilityRefusal` and `availabilityOf` changed:
`node test/run.mjs test/usage-readings.test.ts test/suggest.test.mjs test/suggest.spec.ts test/suggest-summary.test.mjs` gives 32 pass, 0 fail.

## Criterion to test

| # | Test | File |
|---|------|------|
| 1 | `jobOf: two distinct heads…`, `…one to five file paths…`, `…hard-round wins…` | test/slate.test.ts |
| 2 | `buildSlate: each of the six jobs…`, `…an unavailable approved model is skipped…` | test/slate.test.ts |
| 3 | `buildSlate review rows…` | test/slate.test.ts |
| 4 | `…pool models outside the order…`, `…unknown usage keeps its place…`, `…argon…` | test/slate.test.ts |
| 5 | `buildSlate vendor limits…`; `criterion 5…` (one slate stored either way) | test/slate.test.ts, test/slate-store.spec.ts |
| 6 | `criterion 6…` | test/slate-store.spec.ts |
| 7 | `criterion 7…` | test/slate-store.spec.ts |
| 8 | `criterion 8…` | test/slate-store.spec.ts |
| 9 | `criterion 9…` | test/slate-store.spec.ts |
| 10 | `criterion 10…` | test/slate-store.spec.ts |
| 11 | `criterion 11…` | test/slate-store.spec.ts |
| 12 | `slate.ts imports no ledger, fetch or clock` | test/slate.test.ts |
| review finding 1 | `buildSlate judges each model by the job's role…` | test/slate.test.ts |
| review finding 2 | `global pick: a runner scoped to one project…` | test/slate-store.spec.ts |

## Fix round

1. `eligibilityRefusal` takes an optional `role` (default `"build"`, so every
   existing caller is unchanged); `availabilityOf` passes `ask.role` through;
   `buildSlate` passes the job's role.
2. The global slate passes a null project instead of `"*"`; `availabilityOf`
   then reads the offers as they are, so a project-scoped runner serves it.
