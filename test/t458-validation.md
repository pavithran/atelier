t458 fix and validation report

Findings addressed:

- Review and evidence setup selected npm for pnpm projects. Both now select `pnpm install --frozen-lockfile` when `pnpm-lock.yaml` exists. npm lockfiles retain `npm ci` and the existing flags. Review setup without a lockfile retains `npm install`; evidence setup without one retains its existing `npm ci` behavior.
- Dependency install errors did not clearly identify runner setup or its command. Failed exits, timeouts and spawn errors now name the runner's review or evidence dependency setup and the full command. Failed exits retain a bounded stderr diagnostic.

The named house-style file was unavailable within this workspace and was not read. This report, comments and commit message use plain prose.

Red test command, run before changing cli/runner.mjs:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- npm test -- test/runner-dependency-install.test.mjs
```

```text
tests 32
pass 6
fail 26
review installs with pnpm-lock.yaml: expected pnpm install --frozen-lockfile; actual npm install --no-audit --no-fund
evidence installs with pnpm-lock.yaml: actual npm ci --prefer-offline --no-audit --no-fund
setup diagnostic assertion: expected /runner.s .*dependency setup/; actual ERESOLVE
```

The tests cover both installers with pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json and no lockfile. Each command also has failed-exit, timeout and spawn-error coverage.

Green compatibility command:

```sh
TMPDIR="$PWD/.scratch" node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- npm test -- test/runner-dependency-install.test.mjs test/runner-evidence.test.mjs test/review-runner.test.mjs
```

```text
tests 149
pass 149
fail 0
duration_ms 14540.249708
```

The full suite caught a scratch-path violation in the new test fixture. The fixture now uses os.tmpdir() and registers cleanup, matching the project's test convention. TMPDIR keeps the fixtures inside this workspace. The regression and guard check then passed:

```sh
TMPDIR="$PWD/.scratch" GIT_CEILING_DIRECTORIES="$PWD/.scratch" node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- npm test -- test/runner-dependency-install.test.mjs test/scratch-paths.test.mjs
```

```text
tests 34
pass 34
fail 0
duration_ms 103.14675
```

Final full required command:

```sh
TMPDIR="$PWD/.scratch" GIT_CEILING_DIRECTORIES="$PWD/.scratch" ATELIER_TEST_TIMEOUT_MS=3600000 node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- sh -c 'date -u "+slot held %Y-%m-%dT%H:%M:%SZ"; timeout 3600 npm test > .scratch/full-suite-verified.log 2>&1; suite_result=$?; tail -100 .scratch/full-suite-verified.log; date -u "+ended %Y-%m-%dT%H:%M:%SZ"; exit "$suite_result"'
```

Requested at 2026-11-03T15:06:54Z; slot held at 15:07:59Z; ended at 15:18:05Z. Slot wait: 65 seconds. Held run: 606 seconds. The 60-minute budget started inside the held slot. Output and fixture activity continued; no timeout occurred.

```text
tests 6268
pass 6257
fail 5
skipped 6
duration_ms 606493.74075
exit 1
```

The final suite includes passing regression tests and the scratch guard. Its five unfixed failures match the unchanged failures documented in test/t453-validation.md. No unrelated fix was made:

| Test | Output |
| --- | --- |
| test/acting-model.test.mjs:48, a write on the developer token with no acting model is refused, naming --as; reads are free | `t1 Nobody named`; actual exit 0, expected 1 |
| test/acting-model.test.mjs:93, every write on the developer token records the acting model, the verbs that need words record them, and show lists both | event actor `codex/gpt-6.1-sol`, expected `owner` |
| test/runner-readiness.test.mjs:41, the credential check reports each reviewer token and the Claude token file, and withdraws nothing | recovery ends with `is readable by other user`; expected `/chmod 600/` |
| test/situation.test.mjs:223, every error under --json is {code, detail, next}: a server refusal and an error of the CLI's own | actual `no_item`, expected `refused` |
| test/land.test.mjs:48, a clean landing is reviewed without the lease, then takes it to merge the reviewed head, check the merge and push it alone (t550, G2) | `spawnSync git ENOENT` at line 55, reading the task workspace after landing |

Earlier diagnostic full runs were superseded after correcting workspace fixture setup: an empty .scratch/package.json prevents inheritance of the repository's module setting while retaining Node's module detection; GIT_CEILING_DIRECTORIES prevents fixture commands from discovering this checkout. Two diagnostic runs were deliberately stopped. Another completed run used an explicit CommonJS setting that broke TypeScript fixtures. These setup mistakes were corrected without changing those tests. The final command above used the empty package boundary and the final test files.

Final typecheck:

```sh
TMPDIR="$PWD/.scratch" GIT_CEILING_DIRECTORIES="$PWD/.scratch" node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- npm run typecheck
```

```text
> tsc -p . && tsc -p test
exit 0
```

Caller compatibility checks:

- runReview calls prepareReviewDependencies directly or through the runner's prepareReview IO wrapper. Signatures, nested traversal, existing node_modules links and npm arguments remain compatible; review-runner.test.mjs passes.
- collectRunnerEvidence defaults to installEvidenceDependencies; the production runnerEvidence IO wrapper calls that collector. Install failures still produce not-run evidence and run no checks. runner-evidence.test.mjs passes with its diagnostic expectation updated.
- reviewBrief renders evidence preparation errors as text. Existing not-run rendering tests pass. No generated page calls either installer.

No routes, endpoints, disclosure levels, UI pages or status/version/completion markers changed. Visibility tables, screenshots and new crash-marker tests do not apply.

The command-selection tests inject child processes; they do not download packages. A missing pnpm executable is covered as a setup spawn error. No new platform limit or deployment behavior is introduced, and no deployment was performed. No push or atelier command was run directly.
