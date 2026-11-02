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
