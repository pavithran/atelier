t453 validation and fix report

The four task failures are addressed. The 98 focused tests pass. The full suite still has five failures in unchanged tests; they are listed below and were left untouched. Typecheck passes. Nothing was pushed and no atelier command was run directly.

The named house-style file was unavailable within this workspace and was not read. This report, comments and commit message use plain prose.

Findings addressed:

- capabilities.test.mjs:631: the unavailable-version test now expects the three bounded GET retries, while still requiring exit 4, the diagnostic and no write requests.
- owner-path.test.mjs:10: the review snapshot includes the added review-bar sentence. The prompt itself is unchanged.
- scratch-paths.test.mjs:50: five offending paths in install-server-lib, retention-regeneration and ship-suite-studio now use unique os.tmpdir() folders and register cleanup. The scratch guard remains unchanged.
- land-node-2.test.mjs:95: checks no longer queue on the host pool. The test still proves cancellation is refused after merge begins, the landing continues, the task merges and main moves. It also reports an early landing exit instead of waiting out the marker deadline.
- Check-test scheduling: guard.mjs loads the real scheduler with a private SQLite pool and a private wrapper for each test process. NODE_OPTIONS carries the hook to ordinary CLI descendants; the copied wrapper itself retains isolation when checkEnv drops NODE_OPTIONS and the outer lease. The guard drops the host lease before using the private pool. Production cli/load.mjs is unchanged.

The new slot-isolation test first checks that HOST_POOL differs from the machine store. With the host wrapper holding a real slot, it then reads the private pool and runs a wrapped command with only PATH and HOME. The command prints 123 and exits successfully instead of waiting for the outer host slot. Where process inspection is denied, it uses the project's existing inspection skip check; the isolated-path assertion still runs.

Red evidence, before the scheduler change:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- node test/run.mjs test/slot-isolation.test.mjs
```

```text
tests 1
pass 0
fail 1
Expected "actual" to be strictly unequal to:
'/tmp/atelier-test-slots-v1.sqlite'
```

The initial existing-test command was:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- node test/run.mjs test/capabilities.test.mjs test/owner-path.test.mjs test/scratch-paths.test.mjs test/land-node-2.test.mjs
```

It printed the three-versus-one /api/version mismatch, the missing review-bar snapshot sentence and all five scratch offences. The landing diagnostic process was stopped after about 62 seconds while investigating the missing check marker; that diagnostic is not claimed as an ordinary completed test failure. The separate failing slot-isolation test above is the red regression for the scheduler change.

The first full run also exposed four compatibility failures caused by the initial preload: the planner brief expected cli/load.mjs, the generated wrapper fixture expected unmodified source, the slots fixture expected unmodified source, and direct execution of cli/load.mjs needed to retain its entry-point identity. The final preload preserves the cli/load.mjs suffix and direct entry point. The two fixtures copy original disk source before applying their own isolation. All four tests pass in final validation.

Green command:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- env TMPDIR="$PWD/.scratch" GIT_CEILING_DIRECTORIES="$PWD/.scratch" node test/run.mjs test/capabilities.test.mjs test/owner-path.test.mjs test/scratch-paths.test.mjs test/land-node-2.test.mjs test/slot-isolation.test.mjs test/load-cli.test.mjs test/test-slot-brief.test.mjs test/runner-plan.test.mjs test/install-server-lib.test.mjs test/retention-regeneration.test.mjs test/ship-suite-studio.test.mjs
```

```text
✔ an unavailable or malformed version answer refuses with its own message and code
✔ built-in review guide snapshot
✔ no test makes a scratch folder inside the checkout; scratch comes from os.tmpdir()
✔ a cancel while the landing merges is refused, naming the step, and the landing is not interrupted
✔ real slots CLI changes an isolated occupied pool and reports draining without credentials
✔ a refused ps runs the command without accounting and preserves its exit status
✔ a plan job claims as the planner, fetches the brief, posts the plan file and releases
✔ test checks use an isolated scheduler even with a scrubbed environment
✔ the generated command runs from another workspace: slot held, nested reuse, priority, cwd and exit status
tests 98
pass 98
fail 0
skipped 0
duration_ms 40980.668625
```

Full required command, with the clock printed inside the held slot:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- sh -c 'date +%s; TMPDIR="$PWD/.scratch" GIT_CEILING_DIRECTORIES="$PWD/.scratch" ATELIER_TEST_TIMEOUT_MS=3600000 npm test > .scratch/full-suite-final-isolated.log 2>&1; result=$?; date +%s; tail -n 100 .scratch/full-suite-final-isolated.log; exit "$result"'
```

Requested at epoch 1793675156; held at 1793675157; ended at 1793675751. Slot wait: 1 second. Held run: 594 seconds; Node reports 593141.534458 ms. The budget was 60 minutes from acquisition. No suite timeout occurred.

```text
tests 6209
pass 6198
fail 5
skipped 6
exit 1
```

Unfixed failures in unchanged tests:

| Test | Output | Baseline evidence |
| --- | --- | --- |
| acting-model.test.mjs:48, a write on the developer token with no acting model is refused, naming --as; reads are free | t1 Nobody named; actual exit 0, expected 1 | Reproduced with HEAD's unchanged guard; also in t450 and t451 reports. |
| acting-model.test.mjs:93, every write on the developer token records the acting model, the verbs that need words record them, and show lists both | event actor codex/gpt-6.1-sol, expected owner | Reproduced with HEAD's unchanged guard; also in t450 and t451 reports. |
| runner-readiness.test.mjs:41, the credential check reports each reviewer token and the Claude token file, and withdraws nothing | recovery says the token is readable by other user; expected /chmod 600/ | Reproduced with HEAD's unchanged guard and workspace TMPDIR; also in t451. The long workspace path leaves the expected repair text outside the bounded message. |
| situation.test.mjs:223, every error under --json is {code, detail, next}: a server refusal and an error of the CLI's own | actual no_item, expected refused | Reproduced with HEAD's unchanged guard; also in t450 and t451. |
| land.test.mjs:48, a clean landing is reviewed without the lease, then takes it to merge the reviewed head, check the merge and push it alone (t550, G2) | spawnSync git ENOENT at line 55 when reading the task workspace after landing | The same test and error are recorded in test/t451-validation.md:294. It passed in this task's first full run using the system temporary directory. No unrelated fix was made. |

For the baseline checks, .scratch/guard-baseline.mjs was copied from git show HEAD:test/guard.mjs. Commands through the host wrapper were:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- node --import ./src/runtime/loader.mjs --import ./.scratch/guard-baseline.mjs --test test/acting-model.test.mjs
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- env TMPDIR="$PWD/.scratch" node --import ./src/runtime/loader.mjs --import ./.scratch/guard-baseline.mjs --test --test-name-pattern='every error under --json' test/situation.test.mjs
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- env TMPDIR="$PWD/.scratch" GIT_CEILING_DIRECTORIES="$PWD/.scratch" node --import ./src/runtime/loader.mjs --import ./.scratch/guard-baseline.mjs --test --test-name-pattern='credential check reports each' test/runner-readiness.test.mjs
```

Their results were respectively 3 passed / 2 failed, 0 passed / 1 failed, and 0 passed / 1 failed, with the same assertions listed above.

Final typecheck:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- env TMPDIR="$PWD/.scratch" GIT_CEILING_DIRECTORIES="$PWD/.scratch" npm run typecheck
```

```text
> tsc -p . && tsc -p test
exit 0
```

The first complete full run used system TMPDIR: 6209 tests, 6196 passed, seven failed, six skipped, about 584 seconds held after a six-second slot wait. Its four preload compatibility failures were fixed as described above; the other three were the acting-model and situation baseline failures. A later workspace-TMPDIR run was deliberately stopped and restarted after scratch package/Git inheritance caused unrelated fixture failures. Final validation used an ignored .scratch/package.json containing {} and GIT_CEILING_DIRECTORIES to separate fixtures from the parent package and checkout. No timeout is claimed for the deliberately stopped diagnostic runs.

Compatibility checks: no production API or exported scheduler contract changed. Direct scheduler test callers are load.test.mjs, load-process.test.mjs, load-cli.test.mjs, check-load.test.mjs, check-limit.test.mjs, cli-sessions-shared.mjs, cli-sessions-isolation.test.mjs, fixtures/slot-inspection.mjs, test-slot-brief.test.mjs, suites.test.mjs and run.mjs, plus the new guard and regression. The final full run covers each. Explicit options.path pools remain intact. The two source-copy fixtures were updated; session fixture resolution and its database guard remain intact. runner-plan.test.mjs verifies the generated planner brief's wrapper path. No generated page uses this test-only preload.

No routes, disclosure levels, UI pages or production status/version/completion markers changed. Visibility tables, endpoint trust changes and UI screenshots do not apply. Existing failure/crash and SIGTERM tests still pass in focused/full validation.

Local verification covers macOS process inspection. It does not reproduce Linux/container PID and filesystem namespaces or a deployed service account's process visibility. The existing docs/test-slots.md runtime smoke workflow requires load-process.test.mjs on the runner and deployed container image before and after rollout, plus host/container pool separation. No deployment was performed.
