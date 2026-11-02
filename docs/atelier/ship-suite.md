# Production ship checks

The production ship file runs `scripts/ship-suite-studio.mjs` as its first
pre-deploy check, then the existing typecheck. Either failure stops delivery.
The staging ship file keeps its existing checks.

The suite script checks `ATELIER_SHIP_HEAD` against the clean checkout,
bundles that commit and sends the bundle over batch-mode SSH to `ai-studio`.
The Studio clones it under `.scratch`, checks out the captured commit,
runs `npm ci` and `npm test`, then removes the snapshot on success or failure.
No suite workers run on the calling Mac. The declared check allows an hour;
the SSH process and remote commands have a 59-minute bound. Nothing retries
a failed suite and no completion marker is written before it passes.

The existing ship engine runs each declared check in order and records its
result before moving to deployment. Its callers keep the same contract;
there is no new Atelier command or generated page. The production composition
and failure tests cover the new declaration. Remote runner tests cover checkout,
installation and suite failures. Setup dry-run comparisons replace directory
service queries in their script copies so they cannot find a real daemon user.

Local tests cannot establish Studio SSH access, its Node/npm installation,
network access to the package registry or the expected roughly nine-minute
suite duration. Before deployment, the declared production ship check must run
against the actual Studio; after deployment the existing `verify-deploy` step
checks the live commit. This workspace run does not deploy or push.

## Validation for t439

Findings addressed: production previously shipped after only typecheck;
setup dry runs depended on the real machine account; the ship test fixture
removed the host slot lease and could queue behind itself.

All test commands used the host wrapper:
`node /Users/pavi/ai-projects/atelier-runner/cli/load.mjs --`.

- Red: `npm test -- test/ship.test.mjs` printed a failure for
  `Atelier's own ship file composes its deploy, the live check and the push to github`
  before the declaration changed. This first run later stalled at the old
  fixture's nested slot request and was stopped.
- Green: `npm test -- test/ship.test.mjs test/ship-suite-studio.test.mjs test/setup-server.test.mjs`
  finished with `tests 78`, `pass 78`, `fail 0`, in 26.8 seconds.
  This covers the declared pre-deploy failure, the exact commit in a real Git
  bundle, remote checkout/install/test failures, and machine-independent setup.
- `npm run typecheck` exited 0 with `tsc -p . && tsc -p test`.
- Full command: `sh -c 'date +%s; exec npm test'` acquired its slot at
  1793656212 after about 132 seconds queued. It reported two unrelated failures
  in the unchanged `test/acting-model.test.mjs`; the run was stopped under the
  instruction to stop on failures outside this task. It did not time out.
- Reproduction: `npm test -- test/acting-model.test.mjs test/ship.test.mjs test/ship-suite-studio.test.mjs test/setup-server.test.mjs`
  reported `pass 80`, `fail 2`. The developer-token refusal test at line 48
  printed `t1  Nobody named` and `0 !== 1`. The acting-model recording test
  at line 93 expected `owner` but received `codex/gpt-6.1-sol`.
  Neither test nor its implementation was changed.

No route, visibility contract, generated page or UI changed. No new status,
version or completion marker was added. The ship regression asserts that
deployment never ran after a failed check.

The referenced house-style file was unavailable in this workspace and was
not read. Prose here uses plain wording. Actual Studio timing and connectivity
remain to be checked by the declared ship step; no SSH session, deployment,
push or Atelier command was run for this workspace change.

## Validation for t444

Findings addressed: the ship example still showed one typecheck command;
`studioSuite()` lacked a stub-runner unit test; library sourcing exited under
`set -e` when `lsof` was absent from PATH.

The example now matches every field in `docs/atelier/ship.json`. The new
unit test pins bundle creation, SSH arguments, transferred bytes, environment,
timeout, and bundle cleanup after success, bundle failure, SSH failure and a
thrown runner error. The installer keeps its system `lsof` path when lookup
fails, so library sourcing can finish without that command on PATH. Root's
tool validation and execution path are unchanged.

All test commands used the host wrapper:
`node /Users/pavi/ai-projects/atelier-runner/cli/load.mjs --`.

- Red: `node --test test/ship-suite-studio.test.mjs test/install-server-lib.test.mjs`
  reported `tests 5`, `pass 3`, `fail 2`. Library sourcing returned `1 !== 0`;
  the docs comparison showed the missing suite command and old description.
- Green: the same command reported `tests 5`, `pass 5`, `fail 0` in 1.86 seconds.
- `npm run typecheck` passed with `tsc -p . && tsc -p test` (exit 0).
- Full suite: `npm test`, launched by a Node timeout harness with a 3600-second
  timeout and `ATELIER_TEST_TIMEOUT_MS=3540000`, acquired its slot at
  `2026-11-02T23:01:49.555Z`, with less than one second queued. Its log is
  `.scratch/t444-full-test.log`. Temporary test files were directed to this
  workspace's `.scratch`. The run was stopped after 49.34 seconds (exit 143)
  on unrelated failures, as requested; it did not time out.
- The full run reported failures in three unchanged review-bake tests:
  `review-bake.sh gives a Codex reviewer the same blind brief and diff on standard input, read-only, and records the reply`,
  `review-bake.sh tries a reply with no verdict again and records a second miss as failed; --skip runs nothing`,
  and `the runner keeps and collects exactly the replies the scorer reads a verdict in`.
  All three passed in the focused reproduction below.
- Reproduction: `node --import ./src/runtime/loader.mjs --test test/acting-model.test.mjs bin/orchestrate/review-bake.test.mjs`
  reported `tests 14`, `pass 12`, `fail 2`. The two unchanged acting-model tests
  also failed in the full run and were already recorded in t439 above:
  `a write on the developer token with no acting model is refused, naming --as; reads are free`
  printed `t1  Nobody named` and `0 !== 1` at line 57;
  `every write on the developer token records the acting model, the verbs that need words record them, and show lists both`
  expected `owner` but received `codex/gpt-6.1-sol` at line 107. No unrelated
  test or implementation was changed.

No callable contract changed. The production ship declaration still calls
the same suite script; deployment still calls the same installer, installed
by `setup-server.sh`. Existing library callers in `test/setup-server.test.mjs`
keep the same arguments and now tolerate absent `lsof`; the new test covers
that case directly. No route, visibility level, UI, generated page, status,
version or completion marker changed. Studio SSH, registry access and daemon
behavior remain subject to the pre-deploy suite and post-deploy live-version
check described above. No SSH, deployment, push or Atelier command was run.

The referenced house-style file was unavailable in this workspace and was
not read. Prose uses plain wording.
