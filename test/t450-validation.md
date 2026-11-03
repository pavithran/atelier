t450 validation and fix report

The findings addressed are the runner losing the leading work-tree status column before staging a single regenerated fixture, a malformed review being released without one retry, and malformed CRITERION or FINDING lines voiding an explicit verdict. The runner now preserves raw Git output when requested, retries an unreadable review once, and keeps malformed detail lines in the review note. A clear rejection stands; an approval with a malformed finding remains an approval. Other contradictions still refuse an approval.

The regeneration test uses real Git and the runner's subprocess helper. It checks the committed fixture and clean work tree before the regeneration completion record. A separate simulated crash at commit verifies that this completion record remains unset. No routes, visibility levels, UI, or remote-only platform behavior changed.

The house-style file named in the task was unavailable in this workspace and was not read. This report and the commit message use plain prose.

The failing tests were written before the fix. Red command:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- node --import ./src/runtime/loader.mjs --test --test-name-pattern='malformed.*(approval|rejection)|invalid review|raw subprocess' test/review-runner.test.mjs
```

Red output:

```text
tests 7
pass 0
fail 7
malformed criterion approval/rejection: phase 'failed', expected 'reviewed'
malformed finding approval/rejection: phase 'failed', expected 'reviewed'
invalid review retry: phase 'failed', expected 'reviewed'
two invalid reviews: 1 harness run, expected 2
raw subprocess status: [], expected ['test/fixtures/cli/usage.json']
```

The same command after the fix passed all seven tests. The expanded focused command also passed all eight tests, including refusal of contradictory verdicts, valid blocking findings, missing criteria unrelated to malformed lines, unmet criteria, and an invalid criterion number.

Final focused validation after moving the helper into the runner:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- node test/run.mjs test/how.test.ts test/review-runner.test.mjs test/review-oneshot.test.mjs test/land-generated.test.mjs
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- npm run typecheck
```

```text
tests 131
pass 131
fail 0
cancelled 0
duration_ms 14049.581292

> tsc -p . && tsc -p test
exit 0
```

Full required suite command:

```sh
node '/Users/pavi/ai-projects/atelier-runner/cli/load.mjs' -- sh -c 'date -u +%FT%TZ; ATELIER_TEST_TIMEOUT_MS=3600000 npm test'
```

The slot was acquired at 2026-11-03T00:07:05Z, within the first second of the request. The suite completed in 1170.565 seconds (19 minutes 30.565 seconds), within its 60-minute budget. It exited 1: 6176 tests, 6140 passed, 21 failed, 9 cancelled, 6 skipped. Individual test timeouts and a file guard cancellation occurred; the full suite itself did not time out.

One full-suite failure was introduced by initially putting the reply helper in a separate module: test/how.test.ts requires review implementation callers to stay in the runner and Ledger. The helper now lives in cli/runner.mjs, and the final focused run passes that architecture test. The other failing or cancelled cases below were left untouched. A separate baseline suite was not run, so this report does not claim independent baseline confirmation.

Compatibility checks: parseRunnerVerdict is called by runReviewJob, which serves regular, post-merge, and one-shot reviews. The final focused suite covers those callers. runCriteriaReview, runPrereview, settleRejection, and cli/harness/adapter.mjs retain the shared strict parseVerdict contract. src/ledger.ts remains the other production review implementation caller, as test/how.test.ts verifies; generated pages have no new parser caller. execute's new raw option defaults to false: startHarness, prepareWorkspace, prepareReviewDependencies, installEvidenceDependencies, collectRunnerEvidence, readReviewGuide, checked, runnerCheckout, the other runRunner subprocess calls, cli/discover.mjs, and cli/usage.mjs retain their previous trimmed-output behavior. The runRunner Git adapter opts into raw output only when its caller requests it. The final runner and one-shot tests cover compatibility, and the real-Git regeneration regression covers the raw path.

Full-suite failing and cancelled test names and diagnostic excerpts follow. The how.test.ts finding below was fixed and rechecked; the others remain outside this fix.

```text
test at test/acting-model.test.mjs:48:1
✖ a write on the developer token with no acting model is refused, naming --as; reads are free (299.55925ms)
  AssertionError [ERR_ASSERTION]: t1  Nobody named
  
  
  0 !== 1
  
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/acting-model.test.mjs:57:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)

test at test/acting-model.test.mjs:93:1
✖ every write on the developer token records the acting model, the verbs that need words record them, and show lists both (481.932083ms)
  AssertionError [ERR_ASSERTION]: the event stays the developer's, the model beside it
  + actual - expected
  
  + 'codex/gpt-6.1-sol'
  - 'owner'
  
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/acting-model.test.mjs:107:10)

test at test/affected-tests.test.mjs:61:1
✖ atelier check on a task runs only the affected tests, falls back to the full suite for an unmapped path and says so, and a task whose affected tests fail does not land (180028.476958ms)
  'test timed out after 180000ms'


test at test/claim-branch-runner.test.mjs:63:1
✖ a runner claims t/N, clones it alone, builds with a stub harness and pushes to t/N through the hook (120795.528292ms)
  AssertionError [ERR_ASSERTION]: 2026-11-03T00:07:51.665Z runner: jobs: build, plan, merge-main, merge-main-task, merge-plan (not review)
  t1 is yours, opencode/glm-5.3. Work here:
    cd "/var/folders/bl/h6j_hrc55fd1zjq77hxqg25h0000gn/T/atelier-claim-runner-XrdeGg/cache/work/demo/t1"
  Commits here are authored as t <t@example.test>, as the project's policy names.
  Write token expires 2026-11-10T00:07:51.834Z; run `atelier claim t1` again to refresh it.
  - Use no path outside this workspace: read and write files only inside it.
  - Put scratch files only under .scratch/ in this workspace.

test at test/claim-branch-runner.test.mjs:101:1
✖ a review runner clones t/N alone with a read grant, fetches the project's branch beside it, and its evidence clone reads that clone (552.793458ms)
  AssertionError [ERR_ASSERTION]: 
  atelier: review_blocked: t1 cannot be reviewed now: t1 is claimed, not submitted
  next: run atelier show t1
  
  
  1 !== 0
  

test at test/claim-branch.test.mjs:144:1
✖ a check's clean clone and atelier diff read t/N alone and the project's branch with a read grant (61085.888833ms)
  AssertionError [ERR_ASSERTION]: 
  atelier: running `git status` in a clean clone…
  
  
  143 !== 0
  
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/claim-branch.test.mjs:166:10)

test at test/how.test.ts:80:1
✖ the review code is called by the ledger and the runner, and the page says so (16.589084ms)
  AssertionError [ERR_ASSERTION]: the review code should be called by the ledger and the runner alone
  + actual - expected
  
    [
  +   'cli/review-reply.mjs',
      'cli/runner.mjs',
      'src/ledger.ts'

test at test/land-grant.test.mjs:66:1
✖ atelier land pushes the merge and the notes with a landing grant, never the server token, and the grant is spent once the merge is recorded (180028.442459ms)
  'test timed out after 180000ms'


test at test/land-grant.test.mjs:238:1
✖ the landing push is scanned with the task's clearances: a line the owner cleared on the task lands in the merged history (180024.064292ms)
  'test timed out after 180000ms'


test at test/land-node-2.test.mjs:95:1
✖ a cancel while the landing merges is refused, naming the step, and the landing is not interrupted (63151.360083ms)
  AssertionError [ERR_ASSERTION]: the check on the merged tree started
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/land-node-2.test.mjs:106:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,

test at test/land-node-2.test.mjs:137:1
✖ in fast mode the landing's review step records without a warning (180021.620417ms)
  'test timed out after 180000ms'


test at test/land-node-2.test.mjs:185:1
✖ SIGTERM during the merged-tree checks is recorded as the step the landing was at, in its attempt (62846.695417ms)
  AssertionError [ERR_ASSERTION]: the check on the merged tree started
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/land-node-2.test.mjs:195:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,

test at test/land-node-2.test.mjs:207:1
✖ a merge that fails after another landing started a new attempt fails nothing of the new one (62880.703875ms)
  AssertionError [ERR_ASSERTION]: the check on the merged tree started
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/land-node-2.test.mjs:217:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,

test at test/land-node-2.test.mjs:263:1
✖ a merge child's retry after main moved keeps its own attempt, so a new attempt is never written by it (180021.763625ms)
  'test timed out after 180000ms'


test at test/land-node.test.mjs:11:1
✖ a task approved at H lands after main moved, with no new review and no push to its branch (180033.104792ms)
  'test timed out after 180000ms'


test at test/land-node.test.mjs:77:1
✖ checks that fail on the merged tree push nothing and do not reject the task; the tail is the failing check's own, and a flaky pass is not counted (180027.699791ms)
  'test timed out after 180000ms'


test at test/land-node.test.mjs:120:1
✖ main moving between the checks and the push is refused; the merge and checks are made again, and the push happens once (180019.677334ms)
  'test timed out after 180000ms'


test at test/owner-path.test.mjs:10:3
✖ built-in review guide snapshot (0.6505ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
    '\n' +
  +   '"## Reviewing\\\\n\\\\nReview one Atelier change as a model of another family than every contributor;\\\\nin single-family mode, a different model of the selected company from every contributor.\\\\nNever review your own work. Read \\`atelier diff ID\\`; apply the\\\\nproject\'s review bar and the brief\'s blocking rules. Record your verdict:\\\\n\\`atelier review ID --approve|--reject --note \\\\"…\\\\"\\`. Protected paths require\\\\nindependent approval under that family policy. Edit nothing; do not commit or push.\\\\n\\\\n- Only correctness, security, data loss and actively misleading docs block. Other findings are follow-ups.\\\\n- Treat the builder\'s claims as unverified; check them against the diff and cite file and line. A stated reason does not reduce a defect\'s severity.\\\\n- Check the behaviour test\'s commands and red and green output in the builder\'s report; name missing evidence.\\\\n- For changes touching routes, endpoints or data with visibility levels, list each endpoint\'s trust checks from the code: who may call, membership, edit right and where the disclosure level comes from. Check that caller identity, not a requested level, determines disclosure, and that each refusal is tested.\\\\n- For changes touching routes, endpoints or data with visibility levels, independently enumerate output paths and compare the builder\'s table of visibility level by output path with the code and tests. Include responses, search snippets, derived fields, exports, UI copy and generated pages.\\\\n- When a contract changes or tightens, search for every caller and generated page that uses it; verify the builder\'s list and compatibility claims, citing file and line.\\\\n- For UI changes, check before and after screenshots, console output and network failures for every affected page and visibility level; name missing evidence.\\\\n- For each status, version or completion marker, check that it is written after the work it marks and that a crash before completion leaves it unset.\\\\n- Verify each blocking finding before you report it, by reading the code it names or by running a test, and say in the finding how you verified it: the lines you read, or the test you ran and what it printed.\\\\n- Inability to run a command in the reviewer’s environment is never blocking. Report sandbox permissions, missing dependencies and unavailable services as verification limits, not code defects; use Atelier’s Observed results at the head under review. A demonstrated defect in the project remains blocking. If environment limits prevent a verdict, explain the limitation without a VERDICT line so the run is recorded as failed, rather than rejecting the change.\\\\n- Give at most 12 findings, the most serious first.\\\\n- Edit nothing: change, create and delete no file, and do not commit or push.\\\\n\\\\nFor developer-token writes below, set \\`export ATELIER_ACTING=H/M\\` to the\\\\nregistered model acting for you. Owner commands such as \\`ship\\`, \\`wrap\\`,\\\\n\\`branch push|fetch\\`, \\`plan show\\`, \\`projects\\` and \\`import-tasks\\` keep\\\\nthe owner actor; do not give them\\\\n\\`--as\\`. Builder and reviewer commands name their actor with \\`--as H/M\\`.\\\\nLeave ATELIER_ACTING unset with agent and runner tokens.\\\\n\\\\nThe developer runs \\`atelier land ID --reviewer H/M\\` in the registered\\\\ncheckout to land a submitted task at its recorded head. It asks the named\\\\nreviewer and records a land request. If approval is missing, it stops without\\\\nwaiting; run it again after approval. Under the lease it accepts, merges\\\\ninto the checkout, regenerates when declared, checks the merged tree and\\\\npushes only the merge. It never writes the task branch. A raced task stays\\\\naccepted with its approvals after the retries end. Choose an independent\\\\nreviewer. Manual fallback: the reviewer runs\\\\n\\`atelier diff ID\\` and \\`atelier review ID --approve|--reject --as H/M --note \\\\"…\\\\"\\`;\\\\nafter approval and passing checks, the developer runs \\`atelier accept ID --as H/M\\`,\\\\nthen \\`atelier merge ID --as H/M\\`. An accepted task can use either merge or land.\\\\nBuilders and reviewers do not accept or merge their own work.\\\\n"\n'
  -   '"## Reviewing\\\\n\\\\nReview one Atelier change as a model of another family than every contributor;\\\\nin single-family mode, a different model of the selected company from every contributor.\\\\nNever review your own work. Read \\`atelier diff ID\\`; apply the\\\\nproject\'s review bar and the brief\'s blocking rules. Record your verdict:\\\\n\\`atelier review ID --approve|--reject --note \\\\"…\\\\"\\`. Protected paths require\\\\nindependent approval under that family policy. Edit nothing; do not commit or push.\\\\n\\\\n- Treat the builder\'s claims as unverified; check them against the diff and cite file and line. A stated reason does not reduce a defect\'s severity.\\\\n- Check the behaviour test\'s commands and red and green output in the builder\'s report; name missing evidence.\\\\n- For changes touching routes, endpoints or data with visibility levels, list each endpoint\'s trust checks from the code: who may call, membership, edit right and where the disclosure level comes from. Check that caller identity, not a requested level, determines disclosure, and that each refusal is tested.\\\\n- For changes touching routes, endpoints or data with visibility levels, independently enumerate output paths and compare the builder\'s table of visibility level by output path with the code and tests. Include responses, search snippets, derived fields, exports, UI copy and generated pages.\\\\n- When a contract changes or tightens, search for every caller and generated page that uses it; verify the builder\'s list and compatibility claims, citing file and line.\\\\n- For UI changes, check before and after screenshots, console output and network failures for every affected page and visibility level; name missing evidence.\\\\n- For each status, version or completion marker, check that it is written after the work it marks and that a crash before completion leaves it unset.\\\\n- Verify each blocking finding before you report it, by reading the code it names or by running a test, and say in the finding how you verified it: the lines you read, or the test you ran and what it printed.\\\\n- Inability to run a command in the reviewer’s environment is never blocking. Report sandbox permissions, missing dependencies and unavailable services as verification limits, not code defects; use Atelier’s Observed results at the head under review. A demonstrated defect in the project remains blocking. If environment limits prevent a verdict, explain the limitation without a VERDICT line so the run is recorded as failed, rather than rejecting the change.\\\\n- Give at most 12 findings, the most serious first.\\\\n- Edit nothing: change, create and delete no file, and do not commit or push.\\\\n\\\\nFor developer-token writes below, set \\`export ATELIER_ACTING=H/M\\` to the\\\\nregistered model acting for you. Owner commands such as \\`ship\\`, \\`wrap\\`,\\\\n\\`branch push|fetch\\`, \\`plan show\\`, \\`projects\\` and \\`import-tasks\\` keep\\\\nthe owner actor; do not give them\\\\n\\`--as\\`. Builder and reviewer commands name their actor with \\`--as H/M\\`.\\\\nLeave ATELIER_ACTING unset with agent and runner tokens.\\\\n\\\\nThe developer runs \\`atelier land ID --reviewer H/M\\` in the registered\\\\ncheckout to land a submitted task at its recorded head. It asks the named\\\\nreviewer and records a land request. If approval is missing, it stops without\\\\nwaiting; run it again after approval. Under the lease it accepts, merges\\\\ninto the checkout, regenerates when declared, checks the merged tree and\\\\npushes only the merge. It never writes the task branch. A raced task stays\\\\naccepted with its approvals after the retries end. Choose an independent\\\\nreviewer. Manual fallback: the reviewer runs\\\\n\\`atelier diff ID\\` and \\`atelier review ID --approve|--reject --as H/M --note \\\\"…\\\\"\\`;\\\\nafter approval and passing checks, the developer runs \\`atelier accept ID --as H/M\\`,\\\\nthen \\`atelier merge ID --as H/M\\`. An accepted task can use either merge or land.\\\\nBuilders and reviewers do not accept or merge their own work.\\\\n"\n'
  

test at test/picks-facts.test.mjs:103:1
✖ criteria 2 and 3: review-request with no reviewer says why no review is needed while none is, and otherwise refuses with the candidates, naming the contributor and the family match it refuses (120188.755167ms)
  AssertionError [ERR_ASSERTION]: 2026-11-03T00:13:21.960Z runner: jobs: build, plan, merge-main, merge-main-task, merge-plan (not review)
  t2 is yours, opencode/glm-5.3. Work here:
    cd "/var/folders/bl/h6j_hrc55fd1zjq77hxqg25h0000gn/T/atelier-picks-facts-UhgjTR/cache/work/demo/t2"
  Commits here are authored as t <t@example.test>, as the project's policy names.
  Write token expires 2026-11-10T00:13:22.105Z; run `atelier claim t2` again to refresh it.
  - Use no path outside this workspace: read and write files only inside it.
  - Put scratch files only under .scratch/ in this workspace.

test at test/picks-facts.test.mjs:150:1
✖ criterion 4: prereview runs once per call, of the reviewer named; nothing queues one by itself (120714.587708ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /undefined is not waiting in the landing queue/. Input:
  
  '\n' +
    'atelier: no_item: no item undefined\n' +
    'next: run atelier ls --project P, or atelier ls --all\n'
  
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/picks-facts.test.mjs:195:10)

test at test/progress.test.mjs:165:1
✖ a real runner's build reports its progress line with each heartbeat; situation and show read it, and its cost (120213.479125ms)
  AssertionError [ERR_ASSERTION]: the build went on to submit as before
  + actual - expected
  
  + 'claimed'
  - 'submitted'
  
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/progress.test.mjs:263:10)

test at test/progress.test.mjs:269:1
✖ a build that ends in a failure, in work left uncommitted or at a provider limit still records its last line and cost (1519.233458ms)
  AssertionError [ERR_ASSERTION]: fail: no progress kept
  2026-11-03T00:18:08.600Z runner: jobs: build, plan, merge-main, merge-main-task, merge-plan (not review)
  t1 is yours, claude-code/sonnet-5.5. Work here:
    cd "/var/folders/bl/h6j_hrc55fd1zjq77hxqg25h0000gn/T/atelier-progress-9omfHj/cache/work/demo/t1"
  Commits here are authored as t <t@example.test>, as the project's policy names.
  Write token expires 2026-11-10T00:18:09.129Z; run `atelier claim t1` again to refresh it.
  - Use no path outside this workspace: read and write files only inside it.

test at test/progress.test.mjs:288:1
✖ the progress line keeps only program names: no command text in any form reaches the Ledger, show or situation (0.403291ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  0 !== 1
  
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/progress.test.mjs:307:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1409:7)

test at test/progress.test.mjs:415:1
✖ round 10: a run whose output holds every secret form so far stores none of it; the facts and the local log's host and path reach show and situation (1637.638792ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  
    assert.ok(first.lastRun?.log && first.lastRun.host, JSON.stringify(first.lastRun))
  
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/progress.test.mjs:425:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1409:7)

test at test/reviews-together.test.mjs:98:1
✖ CA7: two reviewers requested, accepted by override and merged: no gate request is left open (180023.394291ms)
  'test timed out after 180000ms'


test at test/scratch-paths.test.mjs:50:1
✖ no test makes a scratch folder inside the checkout; scratch comes from os.tmpdir() (58.405083ms)
  AssertionError [ERR_ASSERTION]: make these under os.tmpdir() and remove them after the test:
  test/install-server-lib.test.mjs:8: a .cache or .scratch path in the working directory: const bin = resolve(".scratch/install-server-lib-bin");
  test/retention-regeneration.test.mjs:11: a .cache or .scratch path in the working directory: const dir = resolve(".scratch", `retention-${process.pid}`);
  test/ship-suite-studio.test.mjs:16: a .cache or .scratch path in the working directory: const cwd = resolve(".scratch/studio-suite-unit");
  test/ship-suite-studio.test.mjs:58: a .cache or .scratch path in the working directory: const root = resolve(".scratch/ship-suite-test");
  test/ship-suite-studio.test.mjs:83: a .cache or .scratch path in the working directory: const root = resolve(".scratch/ship-bundle-test");
  + actual - expected

test at test/situation.test.mjs:223:1
✖ every error under --json is {code, detail, next}: a server refusal and an error of the CLI's own (246.671167ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'no_item'
  - 'refused'
  
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/situation.test.mjs:232:10)

test at test/tick-facts.test.mjs:66:1
✖ criterion 1: a dispatch no live runner offers stays queued on its model without an alert; a runner that comes up later takes it (120849.37975ms)
  AssertionError [ERR_ASSERTION]: 2026-11-03T00:19:47.492Z runner: jobs: build, plan, merge-main, merge-main-task, merge-plan (not review)
  t1 is yours, opencode/glm-5.3. Work here:
    cd "/var/folders/bl/h6j_hrc55fd1zjq77hxqg25h0000gn/T/atelier-tick-facts-Hlr5ke/cache/work/demo/t1"
  Commits here are authored as t <t@example.test>, as the project's policy names.
  Write token expires 2026-11-10T00:19:47.636Z; run `atelier claim t1` again to refresh it.
  - Use no path outside this workspace: read and write files only inside it.
  - Put scratch files only under .scratch/ in this workspace.

test at test/tick-facts.test.mjs:111:1
✖ criterion 2: a review request unclaimed past 10 minutes stays as asked, with its age; the model withdraws it and asks again by command (0.435792ms)
  AssertionError [ERR_ASSERTION]: the runner built a task above
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/tick-facts.test.mjs:112:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,

test at test/tick-facts.test.mjs:138:1
✖ criterion 3: a review's finding is a goal note, which show numbers; file-fix files a task from it, once however often it is asked; the server files none (the post-merge path: test/production-paths.test.mjs) (0.119375ms)
  AssertionError [ERR_ASSERTION]: the runner built a task above
      at TestContext.<anonymous> (file:///Users/pavi/Library/Caches/ai-projects/cloudflare-git/work/atelier/t450/test/tick-facts.test.mjs:139:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
```

