# t472 validation

Finding addressed: a ship refreshed the pavi runner checkout but left the
builders' checkout behind. Both now receive the captured shipped commit at
`refs/atelier/ship`, reset to that commit and run `npm ci`, through the same
command construction. The second path is
`/Users/atelier-build/ai-projects/atelier-runner` on ai-studio.

Each of the four operations has a two-minute timeout, leaving time to warn
within production's existing nine-minute refresh step. A failure still warns
and returns normally. Recovery guidance names both paths. The completion
message appears only after all four commands succeed; tests check that source,
push, SSH and thrown process failures leave it absent, including failures in
the builders' push and installation command. No persistent marker is added.

All test commands used the required host wrapper:
`node /Users/pavi/ai-projects/atelier-runner/cli/load.mjs --`.

- Red, before implementation: `node --test test/ship-refresh-runners.test.mjs`
  exited 1, with `tests 9`, `pass 2`, `fail 7`. The command comparison showed
  the missing builders' push and reset/install command. Builder failure cases
  returned `true !== false`; warning assertions showed the missing recovery
  path.
- Green: the same command exited 0, with `tests 9`, `pass 9`, `fail 0`
  in 97 ms. Commands, commit, dependency installs and timeouts are pinned.
- Broader check: `sh -c 'TMPDIR="$PWD/.scratch" node test/run.mjs test/ship-refresh-runners.test.mjs test/ship.test.mjs test/ship-suite-studio.test.mjs test/ship-environments.test.mjs test/ship-scripts.test.mjs'`
  reported `tests 65`, `pass 63`, `fail 2`. One was a quote mismatch introduced
  in the new test expectation; it was corrected before the green run above.
  The unchanged test `ship refuses a dirty checkout, a HEAD the baseline does
  not hold, another actor and another directory` expected
  `atelier: run ship in demo's registered checkout: cd ` but received
  `atelier: only the developer ships: run ship as owner, without --as or ATELIER_ACTOR naming another actor`.
  That failure remains unfixed. The Studio deploy test that simulates a failed
  refresh push and asserts ship exit 0 passed.
- `npm run typecheck` passed after the implementation, exit 0:
  `tsc -p . && tsc -p test`.
- Full required suite: the wrapper ran `python3 .scratch/t472-suite.py`, which
  printed slot acquisition and launched `timeout 3600 npm test` with
  `ATELIER_TEST_TIMEOUT_MS=3600000` and this workspace's `.scratch` as TMPDIR.
  It queued at 2026-11-03 17:40:59 UTC and acquired the slot at
  17:43:37.942 UTC: about 159 seconds waiting. It stopped after 1.85 seconds
  running, exit 143, on the unchanged failure
  `review-bake.sh gives a Codex reviewer the same blind brief and diff on standard input, read-only, and records the reply`.
  This failure is already recorded in `docs/atelier/runner-refresh.md` and
  `test/t451-validation.md`. It remains unfixed. Output is saved in
  `.scratch/t472-full-test.log`. The suite did not time out or pass. No further
  broad testing or unrelated fixes were made after this failure.

The function's arguments and return contract are unchanged. Its production
caller in `docs/atelier/ship.json` and example in `docs/ship.md` need no changes;
composition and documented-configuration checks passed in the broader run.
`test/ship.test.mjs` copies the script into its fixture and its failed-refresh
ship test passed. Direct test callers retain the same injected dependencies.
No generated page consumes this contract. No route, endpoint, visibility rule
or UI changed, so visibility matrices and screenshots do not apply.

Local tests cannot establish Studio SSH access, atelier-dev group write
permissions for the builders' checkout, Git receive configuration, registry
availability or idle-runner reload. The project declares a remote suite
before deployment and live-version verification afterward. Its existing
`docs/atelier/runner-refresh.md` smoke procedure also calls for repository
access checks before deploy and HEAD/reload checks afterward. Apply those
checks to both checkout paths, checking dependency installation as well.
No remote smoke check, deployment, push or atelier command was run here.

The referenced house-style file is unavailable in this workspace and could
not be read. Prose uses plain wording.
