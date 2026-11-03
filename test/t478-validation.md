# t478 review repairs

This rework builds on 33a38700. The blocking finding was that all three
node-pool tests assumed an ignored `.scratch` directory already existed.
`fixtureFile` now writes directly under `os.tmpdir()` and registers each file
for cleanup with `t.after`, including when an assertion fails. It creates no
temporary folder and needs no pre-existing checkout scratch directory.
The final focused commands set TMPDIR to this workspace's existing .scratch.
No production code changes in this rework.

The follow-up finding asks for the full-suite totals and the cause and
decision for each original failing group. The table below records those
decisions from the existing repairs, rather than treating them as new fixes.
History checked includes `git log 6fec9b6a..HEAD`, t437's 9a987830 and
aa123570, and repair commits 6800df84, 9328aae5, 9abaf611, 489c2470,
866d0545 and 045c1fd9.

| Failing group | Cause | Decision and retained coverage |
| --- | --- | --- |
| Accept and merge setups, including refresh, plans, branch grants, token scope and fixture generation | t437 deliberately requires an independent review for measured code even without a protected glob. Old setups accepted code without one. | Test/fixture changes: provide a review bound to the head and criteria by an eligible independent model. Lifecycle, authorization and state assertions remain. `src/refresh/lifecycle.cases.mjs` also supplies the prerequisite. |
| Coordinated changes and reviewNeeded | t437 deliberately removed the coordinated-code exemption, including projects without an execution policy. | Test changes: expect review for code; keep documentation exempt. Both policy forms remain covered. |
| riskReviews and independentApproval | Code now requires cross-company review; aa123570 preserves project counts above one. Executable tests require review too. | Test changes: retain two-review requirements, use eligible companies, and explicitly refuse the builder's company, same-model aliases and contributors. No reduction of the review count. |
| Override, single-family, Access and accept-route tests | AGENTS.md is exempt documentation, so protected AGENTS.md fixtures stopped exercising the intended review gate. | Test changes: use protected security.ts. Owner-only override, confirmation, expiry, contributor, company and noOverride refusals remain asserted. |
| Secret flags, secretBlockers and text-to-text transitions | Tests expected a clean, cleared or superseded scan to make a code gate ready despite the newly required review being absent. | Test changes: provide the independent approval. Standing flags, unread files and pending scans still refuse acceptance; the transition table still checks scan results. No secret implementation changed. |
| reviewBrief | Its protected-task fixtures also used exempt AGENTS.md and no longer produced a review need. | Test changes: use protected code and retain the brief content and criteria assertions. |
| Decision briefs, inbox and decision fields before a push or measured diff | t437 exposed needsAssessor before review could be requested, making these views recommend review prematurely. | Code fix in src/brief.ts and src/rules.ts: require a head and measured paths before presenting the review action. Gate acceptance remains blocked; existing no-head and unmeasured tests retain the wait behavior. Ordinary ready fixtures use exempt documentation; protected cases use code. |
| Plan integration dispatch | Once setups could pass the new gate, direct landing of a part left a queued integration dispatch behind and prevented completion. | Code fix in src/ledger.ts: clear the queued integration when its part is merged or abandoned and the plan has no owner. Plan completion assertions remain. |
| Legacy fast-mode audits and post-merge review | Old fixtures landed unreviewed code without the now-required pre-merge gate. | Test changes: explicitly confirm and record the developer override when exercising an owed post-merge review; provide eligible approvals in approved cases. Audit and goal-note assertions remain. |
| Acting-model CLI failures | CLI fixtures inherited this task checkout as their current directory, so project inference selected the wrong project and returned no_item before the expected authorization refusal. | Test isolation fix: run in the fixture root, use the absolute CLI path and set a Git ceiling. Expected refusal codes remain. |
| Import guard | t437 added wrangler.toml as literal project-policy test data without updating the exact-literal exception. | Test change: add that data literal to the existing exception. Package-import prohibition and stale-exception checks remain. |
| review-sh ENOENT and run-agent fixtures | Extensionless CommonJS stand-ins ran as ES modules under workspace scratch and failed before writing their record. User zsh startup files could also replace fixture executables. | Test fixes: use an ES-module import, disable user startup files, supply a controlled ZDOTDIR and stub the policy command. Prompt and prose-standard assertions remain. |
| Full-suite reporting | The coordinator's guard registered an empty Node harness that printed misleading zero totals after the real results. Failing names were lost in long output. | Test-runner code fix: avoid that harness in the pool, print leaf totals and failing names after the output stream ends. Regression tests cover failing, successful and interrupted runs; interruption prints no completion footer. |
| Clean-checkout node-pool tests (this review) | New regression fixtures wrote into ignored .scratch without creating it or cleaning their files. | Test fix: use files directly under os.tmpdir() and register cleanup for every generated file. The three tests reproduced red under the missing-directory simulation and pass after the fix. |
| Host-slot isolation after merging main | t480 moved the host pool from its v1 path to the shared v2 directory. The guard's copied scheduler declaration had to match. | Test infrastructure compatibility update in test/guard.mjs. The independent scheduler remains isolated from the host slot. |
| Status mode assertions after merging main | t476 intentionally removed mode fields and mode lines. | Test compatibility updates accept absent mode while retaining status placement assertions. |

No test was deleted, newly skipped or disabled by these repairs. The removed
continuation/investigation Markdown files were superseded reports, not tests.
Existing conditional skips are reported by the full suite; none was added to
make it pass.

## Reproduction and focused checks

Every command below uses the required host wrapper prefix:

```text
node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' --
```

Before the fix, a `node --input-type=module -e` launcher imported
`test/node-pool.test.mjs` after replacing `fs.writeFileSync` with a wrapper
that throws `ENOENT: clean checkout has no .scratch directory` for
`.scratch/pool-*` until `mkdirSync(".scratch")` has been called. It used
`syncBuiltinESMExports` so the tests' named imports used the wrapper. This
reproduces the missing-directory precondition without moving or deleting
shared scratch files. Result: exit 1, tests 3, pass 0, fail 3, all ENOENT.
The identical command after the initial directory-creation fix: exit 0,
tests 3, pass 3, fail 0. The full suite then exposed the project's stricter
scratch-path guard, so the final fix uses os.tmpdir() without creating a folder.

The command after the wrapper prefix was:

```sh
node --input-type=module -e 'import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module"; const write = fs.writeFileSync; const mkdir = fs.mkdirSync; let created = false; fs.mkdirSync = (path, ...args) => { if (path === ".scratch") created = true; return mkdir(path, ...args); }; fs.writeFileSync = (path, ...args) => { if (String(path).startsWith(".scratch/pool-") && !created) throw Object.assign(new Error("ENOENT: clean checkout has no .scratch directory"), {code:"ENOENT"}); return write(path, ...args); }; syncBuiltinESMExports(); await import("./test/node-pool.test.mjs");'
```

The review's named files were then run together on the initial fix:

```text
npm test -- test/node-pool.test.mjs test/orchestrate-stdin.test.mjs test/brief.test.ts test/ledger.spec.ts test/routes.spec.ts
tests 172
pass 172
fail 0
skipped 0
duration_ms 5327.935917
exit 0
```

The route fixtures log expected unavailable-diff diagnostics for deliberately
missing repositories; these do not fail the assertions.

## Full-suite result and remaining main failure

The full command on the initial fix was:

```text
node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- sh -c 'date +%s; ATELIER_TEST_TIMEOUT_MS=3600000 exec npm test'
slot acquired: 1793743134
Full suite: tests 6318, pass 6311, fail 1, cancelled 0, skipped 6, todo 0.
duration_ms 574406.325041
exit 1
```

Slot wait was under one second; suite run time was 574.406 seconds. This was
a test failure, not a timeout. `npm run typecheck` passed with exit 0.
The full suite was not green and is not claimed as validation of the final
revision after the fixture-path adjustment.

The failing test was `test/scratch-paths.test.mjs:50`,
`no test makes a scratch folder inside the checkout; scratch comes from os.tmpdir()`.
It named the initial mkdir in node-pool.test.mjs and an existing
`resolve(".scratch", ...)` in `test/load-sharing.test.mjs:11`.
After changing node-pool fixtures to os.tmpdir(), the command

```text
node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- env TMPDIR="$PWD/.scratch" npm test -- test/node-pool.test.mjs test/scratch-paths.test.mjs
tests 5
pass 4
fail 1
exit 1
```

passes all three node-pool tests and the guard's pattern tests. Its sole
remaining offence is load-sharing.test.mjs:11. `git show
fd73f94d:test/load-sharing.test.mjs` contains that exact line; `git diff
fd73f94d..HEAD -- test/scratch-paths.test.mjs test/load-sharing.test.mjs`
is empty. This is the existing t480 fixture failure on merged main, outside
this review's fixture repair. Per the instruction to stop on an out-of-task
failure already on main, it is left unchanged. No tests are skipped or
guard exceptions added to hide it. The acceptance criterion requiring a
green whole suite remains unmet. Nothing is pushed.

Final focused validation after the os.tmpdir() change used the wrapper with
`env TMPDIR="$PWD/.scratch"` and the same five named files:
`npm test -- test/node-pool.test.mjs test/orchestrate-stdin.test.mjs test/brief.test.ts test/ledger.spec.ts test/routes.spec.ts`.
Result: tests 172, pass 172, fail 0, skipped 0,
duration_ms 5446.233291, exit 0. Final `npm run typecheck` with the same
wrapper and TMPDIR passed, exit 0. `git diff --check` passed.

This rework changes only tests and this report. It changes no endpoint,
authorization or disclosure contract, generated page, UI or deploy behavior.
It introduces no platform dependency requiring a remote smoke check.
The interrupted-run regression verifies that a crash before completion leaves
the completion footer unset.

The referenced `../ai-projects-house-style/house-style.md` is unavailable
inside this workspace and was not read. This report and commit message use
plain prose. No atelier command was run and nothing was pushed.
