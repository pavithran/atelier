# Studio runner refresh

Production's `verify-deploy` commands first check the live commit, then run
`scripts/ship-refresh-runners.mjs`. The refresh pushes `ATELIER_SHIP_HEAD`
to `refs/atelier/ship` in `ai-studio:ai-projects/atelier-runner`, resets that
checkout to the captured commit, and runs `npm ci`. Existing idle runners
reload themselves; this step does not interrupt or restart a runner.

The script checks the clean source checkout using `sourceHead`. Refresh
failures warn and return successfully to ship because delivery has already
completed. Each remote operation has a four-minute timeout; the ship command
allows nine minutes so those failures can warn before its outer timeout.
Success is printed only after dependency installation succeeds. No completion
file is written.

Production deploys on every ship, including runner-only changes. Its former
`deploy.if_changed` rule also skipped all verification commands, including the
refresh. Removing that rule keeps refresh after verified delivery without
changing the ship schema. This also means documentation-only ships deploy.

The production ship file is the only new caller. `composeShip` and the ship
executor already support ordered commands in `verify-deploy`; their interfaces
are unchanged. Staging, the installer, live-version verification and generated
pages keep their contracts. The example in `docs/ship.md` matches the entire production configuration.
`test/ship.test.mjs` checks both verification commands and copies both scripts
into its Studio fixture; its failed refresh push is simulated and ship still
succeeds. `test/ship-environments.test.mjs` checks unconditional production
deployment. `test/ship-suite-studio.test.mjs` compares the full documented
configuration. `test/ship-scripts.test.mjs` still checks the deploy script;
`test/ship-refresh-runners.test.mjs` pins refresh commands and failures.
No generated page consumes this configuration.

Local tests pin commands and failure handling. They cannot reproduce Studio
SSH permissions, Git receive configuration, registry availability or a live
runner's reload. The production ship declares its remote suite before deploy
and live-version check after deploy. Before deployment, the operator should
also check Studio runner repository access; after deployment, check that its
HEAD equals the shipped commit and that an idle runner reports reloading.
No deployment, SSH connection or push is needed for local tests.

The referenced house-style file was unavailable in this workspace and was
not read. This document uses plain prose.

## Validation for t468

Finding addressed: a successful ship could leave Studio runners on an older
checkout. The refresh now follows successful live verification. Failure
coverage includes source validation, push, SSH, thrown process errors and a
real CLI invocation that warns and exits 0. Failed operations never print
the completion message; no status or version marker is added.

Every test command used the host wrapper
`node /Users/pavi/ai-projects/atelier-runner/cli/load.mjs --`.

- Red: `node --test test/ship-refresh-runners.test.mjs` reported
  `ERR_MODULE_NOT_FOUND` for `scripts/ship-refresh-runners.mjs`, `pass 0`,
  `fail 1`, exit 1, before implementation.
- Green: `node --test test/ship-refresh-runners.test.mjs test/ship-suite-studio.test.mjs`
  reported `tests 11`, `pass 11`, `fail 0`, exit 0, in 1.76 seconds.
- `npm run typecheck` printed `tsc -p . && tsc -p test` and exited 0.
- Full suite: `npm test` queued at `2026-11-03T15:50:29Z`, acquired its slot
  at `2026-11-03T15:54:19.534Z` (230.5 seconds waiting), and was stopped at
  `2026-11-03T15:54:47.920Z` (28.4 seconds running, exit 143) after unrelated
  failures. Its timeout was set inside the acquired slot to 3600 seconds,
  with `ATELIER_TEST_TIMEOUT_MS=3540000`; it did not time out.
  Output included:
  `✖ review-bake.sh gives a Codex reviewer the same blind brief and diff on standard input, read-only, and records the reply`.
  The same unchanged review-bake failure is recorded in
  `docs/atelier/ship-suite.md` under t444. No unrelated test or implementation
  was changed. The suite was stopped as requested, so full validation did
  not pass.

No route, visibility rule, UI or generated page changed. No screenshots are
needed. No Atelier command, deployment or push was run. The unrelated suite failure remains unfixed.

## Rework after review

All three blocking findings are addressed: the composition assertion and Studio
fixture accept both verification commands; production no longer skips deploy
and its refresh for runner-only changes; and the ship example matches the
complete production file. The tradeoff is that every production ship deploys.

Commands below used the host slot wrapper shown above.

- Red: `node --test --test-name-pattern="production verifies|documented ship configuration" test/ship-refresh-runners.test.mjs test/ship-suite-studio.test.mjs`
  against the previous configuration printed `tests 2`, `pass 0`, `fail 2`,
  exit 1. Failures named the deploy skip rule and the incomplete example.
  The reviewer also recorded five failing ship tests before this rework.
- Green: `node test/run.mjs test/ship-refresh-runners.test.mjs test/ship-suite-studio.test.mjs test/ship.test.mjs test/ship-environments.test.mjs test/ship-scripts.test.mjs`
  printed `tests 63`, `pass 63`, `fail 0`, exit 0 (27.22 seconds).
  This includes the five tests the reviewer named and a ship that succeeds
  after the refresh push fails. Refresh failure tests check that no success
  message appears before completion.
- `npm run typecheck` printed `tsc -p . && tsc -p test`, exit 0.
- Full suite: `sh -c 'date -u; ATELIER_TEST_TIMEOUT_MS=3600000 TMPDIR="$PWD/.scratch" npm test'`
  was queued at 16:27:58 UTC and acquired its slot at 16:28:57 UTC on
  2026-11-03 (59 seconds waiting). It was stopped at 16:29:12 UTC
  (15 seconds running, exit 130) after the previously recorded unrelated
  review-bake failures. Output included:
  `✖ review-bake.sh gives a Codex reviewer the same blind brief and diff on standard input, read-only, and records the reply`
  and `✖ review-bake.sh tries a reply with no verdict again and records a second miss as failed; --skip runs nothing`.
  These failures are also recorded in `test/t451-validation.md`. They remain
  unfixed; the full suite did not pass and did not time out.

The house-style source could not be read because it is unavailable in this
workspace. No route, visibility contract, UI or generated page changed.
The Studio permissions and idle reload limitations and remote smoke checks
listed above still apply. No Atelier command, deployment or push was run.
