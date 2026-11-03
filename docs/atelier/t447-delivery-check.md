# t447 delivery check

Findings addressed: a failed live check stopped ship before wrap despite a
successful deploy; following redirects could treat an Access sign-in page as
a public site's HTTP 200 response.

A failed post-deploy verification now records its failed action, runs wrap,
and exits unsuccessfully with delivery unconfirmed and commands to recheck.
Push stays blocked. The successful deploy action remains recorded. A failed
deploy or install verification still stops immediately. A failed wrap reports
both failures. A crash during wrap cannot record wrap as passed or ship as
shipped. Recheck commands retain the captured ATELIER_SHIP_HEAD; request
commands print the HTTP code and name the expected code.

Request checks accept redirect: manual or follow. Follow remains the default.
Manual checks inspect the first response and never request the redirect target.
A 302 check rejects a public 200; a 200 check rejects an Access 302 in manual
mode. This checks status only, not the identity of the redirect issuer.

## Compatibility

The ship file adds an optional field; no existing field changes meaning.

- cli/commands/ship.mjs calls ship: its callbacks and record schema stay the
  same. Its exit handler still records an interrupted ship as failed.
- composeShip, buildSteps and parseRuns feed ship, knownKinds and shipPolicy:
  request runs carry redirect; command runs and approval kinds stay the same.
- cli/commands/approve.mjs calls knownKinds: existing approval tests pass.
- cli/commands/init.mjs calls shipPolicy: policy run strings and approval
  kinds stay the same; redirect does not add a protected action.
- cli/land.mjs calls runCommand: that function is unchanged.
- cli/commands/approvals.mjs calls formatApprovals: unchanged.
- test/ship.test.mjs and test/ship-environments.test.mjs cover the changed
  failure path and the existing production and staging ship files. Both use
  command-based verification and need no ship.json update.
- The generated Ship page uses renderProjectShip and renderActions; action
  status, command and note fields keep their schema. The failed verification
  and completed wrap are ordinary action rows. No template or layout changes.
- show and events consume existing failed ship records and action records;
  the result remains failed, with verify-delivery as the stopping step after
  wrap. No new result value or event kind is introduced.

This change adds no endpoint or disclosure level. Existing owner, checkout,
revision and approval checks still guard ship. It changes outbound delivery
checks, not Access authorization or project membership. No response, search
snippet, derived field, export, UI copy or generated page gains a new
visibility rule. No visual files changed.

## Validation

All test commands use the supplied host slot wrapper. TMPDIR points to this
workspace's .scratch so fixture files stay here. GIT_CEILING_DIRECTORIES points
to .scratch so fixtures do not inherit this workspace's agent identity.

Red command:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- env TMPDIR="$PWD/.scratch" node test/run.mjs test/ship.test.mjs
```

Before the fix, the failed-delivery test expected a passed wrap action but got
only commit passed, deploy passed and verify-delivery failed. The redirect test
got: `docs/atelier/ship.json verify-deploy has a field atelier ship does not
read: redirect`. The Studio mismatch regression also failed because wrap did
not run. The checkout-refusal test had a separate fixture isolation failure:
it expected a registered-checkout refusal and got the owner-only refusal.
Setting the Git discovery ceiling fixed that environment issue without
changing the existing test.

Green focused command:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- env TMPDIR="$PWD/.scratch" GIT_CEILING_DIRECTORIES="$PWD/.scratch" node test/run.mjs test/ship.test.mjs test/ship-environments.test.mjs
```

Output: tests 47, pass 47, fail 0. Coverage includes HTTP mismatch, manual and
default redirects, invalid redirect values, unreachable delivery, a failed
wrap and a simulated crash during wrap. Successful ship and failed deploy
regressions also pass.

Typecheck command:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- npm run typecheck
```

Output: `tsc -p . && tsc -p test`, exit 0.

Full suite command:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- sh -c 'date +%s; exec env TMPDIR="$PWD/.scratch" GIT_CEILING_DIRECTORIES="$PWD/.scratch" ATELIER_TEST_TIMEOUT_MS=3600000 npm test'
```

The request was made at epoch 1793666709 and the held slot printed
1793666728: 19 seconds waiting. The suite did not pass. Its unchanged
`test/affected-tests.test.mjs:61` integration case, “atelier check on a task
runs only the affected tests, falls back to the full suite for an unmapped
path and says so, and a task whose affected tests fail does not land”, timed
out after 180025 ms. The suite was stopped after this out-of-scope failure;
its 60-minute ceiling and 10-minute silence limit were not reached.

A baseline comparison temporarily loaded the original HEAD cli/ship.mjs and
ran the unchanged test file through the host wrapper, using the same scratch
and Git ceiling settings. It reproduced `test timed out after 180000ms`:
4 tests, 3 passed, 1 cancelled, exit 1, duration 180098 ms. The changed ship
module was restored in finally. No change was made to the failing test.
The baseline helper remains an ignored scratch file, .scratch/check-baseline.mjs.

## Runtime checks

Local tests cannot reproduce the Mac's DNS propagation delay, the live Access
policy or Studio connectivity. docs/ship.md declares delivery smoke checks
from the deployment host before and after deployment, then a recheck from the
calling Mac after DNS settles. No deployment or push was performed here.

The requested ../ai-projects-house-style/house-style.md was not available in
this workspace. It could not be read; this report, docs and commit prose use
plain language without guessing its rules.
