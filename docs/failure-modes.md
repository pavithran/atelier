# Failure modes A1 to A13: what Atelier does about them

This document restates the agent failure modes ControlPlane recorded, A1 to
A13, and says for each what Atelier now prevents or detects: the exact code
that does it and the test that shows the mechanism working. Where Atelier does
not prevent a mode, the entry says so plainly and names the change that would.
Each entry opens with the failure as ControlPlane recorded it, summarized in
two or three sentences. ControlPlane's original record, with its evidence and
dates, is in ControlPlane's repository at docs/FAILURE-MODES.md.

## A1. Authoring a shipped test against something no target has

ControlPlane recorded tests that shipped and ran inside every adopter, twice
reading templates/ and once importing control_plane.messages, paths that exist
only in canonical. The only catch was the disposable-target clone proof, the
slowest gate in the suite, so the feedback arrived minutes after the mistake
and only during a full run.

Atelier removes the precondition: it ships no test suite into any project. A
project's required checks run from the item's own head. The `check` command in
cli/atelier.mjs clones the fork Artifacts holds into a throwaway directory
(`cleanClone`, `runCheck`) and runs each command there, and `atelier finish`
runs push and then check in one command, so a test authored against a path the
head lacks fails immediately after the push. The sandbox route (src/index.ts,
case "sandbox") runs the same head in a Cloudflare container. A check command
that is not a real string is refused at the boundary (`asStrings` in
src/index.ts). Tests: test/check-env.test.mjs, "a passing local check sees no
credentials and uploads none" and "a check still runs its toolchain: node and
git from PATH, a temporary folder, its own HOME", both of which drive the real
check path in a clean clone; test/lists.spec.ts, "a project's checks,
protected paths and eligible agents must each be a list of non-empty strings".

## A2. Writing a test that encodes a defect instead of catching it

ControlPlane recorded a test written to prove a change had not disturbed the
installable path, which in fact pinned the silence that made installable hide
its composed order, the exact defect the next release had to fix. A test
asserting that nothing changed freezes whatever was there, including what was
wrong.

Atelier does not prevent this. The gate counts only that a required check was
observed passing at the head (`evidenceAt` and `gate` in src/rules.ts);
nothing reads what a test asserts, and a test that pins a defect passes like
any other. The independent review is the only second reader, and the review
brief does not ask a reviewer to run the tests without the change. Suggested
change: `reviewBrief` in src/review/brief.ts, the brief a reviewer receives,
could ask a reviewer of a change to tests to confirm that the new tests fail
on the base tree; `atelier diff` (cli/atelier.mjs) prints the change but
leaves no base tree to run them on, so that confirmation needs a checkout of
the baseline as well.

## A3. Recording a claim without checking the route

ControlPlane recorded telling PostMortem that a feedback shape "is documented",
citing ADOPTION.md, a file that reaches no adopter at all; the delivered file
was inbox.md, and the correction had to come back upstream from the project
being corrected. Checking that a thing exists is not checking that it works by
the path the reader took.

Atelier reads the fact back through the path that matters before using it.
Accept and review verify the revision against the fork as Artifacts reports it
(`verifyRevision` and `headOf` in src/index.ts, `assertRevision` in
src/rules.ts); the review route re-reads the fork's head and refuses when it
moved. The links a reader is handed are built from the origin that actually
reached the Worker (`setNotificationOrigin` in src/ledger.ts,
`notificationRequest` in src/notify.ts), and every former project name still
resolves and redirects (`resolveProject` in src/ledger.ts, `movedTo` in
src/index.ts). Tests: test/ledger.spec.ts, "HTTP approval rejects missing and
stale revisions before reading Artifacts"; test/notify.spec.ts, "cloud results
notify after a waiting submission using the saved origin"; test/notify.test.ts,
"notification uses the existing decision brief, encoded title and absolute task
URL"; test/rename.spec.ts, "pages under a former name redirect to the current
one with their path and query, and a form posted under it acts". Not covered by a test: the comparison against Artifacts in
`verifyRevision` and the review route's re-read of the fork's head; the tests
above stop at `assertRevision`, before Artifacts is read.

## A4. Committing and pushing a finding that was wrong

ControlPlane recorded a STATE.md entry, written from the reasoning of A3, that
asserted the shipped example "fails the shipped validator". It failed one of
two validators. The entry was replaced rather than amended, because it stated
something false.

Atelier does not prevent a false claim being recorded; nothing verifies
narrative prose. What the record does is stop the wrong statement from doing
gate work and keep the correction visible: evidence filed as a report is
displayed and never counted (`evidenceAt` in src/rules.ts), every event is
appended with its actor and time to a log nothing rewrites, and the events
that concern a revision (push, evidence, review, submit, accept) carry the
head in their data (`Ledger.log` in src/ledger.ts), and a later review by the same reviewer at the same head
supersedes the earlier one (`latestReviews` in src/rules.ts). Tests:
test/rules.test.ts, "a report never satisfies a check" and "decisions reject
stale revisions and retain the latest review from each reviewer". The
prevention this mode asks for is the one A11 names: compute the computable
fact instead of asserting it.

## A5. Breaking a gate during wrap and not noticing

ControlPlane recorded a wrap that repointed START-HERE at a landing record
declaring no release, which broke the seal's current-handoff gate. The break
was missed for a day because only the fast suite ran after the wrap, and the
fast suite cannot see the seal.

In Atelier the gate is not a suite the owner chooses whether to run; it is
derived from the record at the moment of decision. `Ledger.accept` runs `gate`
and refuses with every blocker (src/ledger.ts, src/rules.ts), and the inbox,
briefs and pages recompute it on every request (`inboxFor` in src/rules.ts,
`Ledger.inbox`). Skipping the checks does not skip the gate; the item blocks
with "not yet observed at this head". A session wrap runs its checks in the
owner's checkout at the weaker Reported grade, and a failing one still stops
wrap before anything is staged, unless the owner allows it and the note names
what was allowed (`wrap` and `wrapReady` in cli/atelier.mjs,
`failingChecksRefusal` in src/sessions.ts). Tests: test/ledger.spec.ts, "an
item moves from creation to merge, gated by observed evidence";
test/rules.test.ts, "a required check is pending until observed at the current
head"; test/sessions.test.ts, "wrap refuses an unfinished checkout and says
which kind" and "the refusal and the override line name each failed check with
how it ended".

## A6. Repeating a recorded lesson

ControlPlane recorded the probe battery being added to a work item's evidence,
a format that validates every entry as a receipt, which the probe battery is
not; the sealed tree broke at the record commit. The same shape was already
recorded from an earlier release, where two of three assessment rounds were
spent learning it.

Atelier's evidence cannot be diluted that way. The gate counts only observed
checks whose claim is exactly one of the project's required checks, and only
at the item's current head (`evidenceAt` and `gate` in src/rules.ts). Anything
else an agent files is either a report, which is shown and never counted, or
an observed check that is not one of the required checks, which is stored and
satisfies nothing. Evidence
bound to another head is refused outright (`addEvidence` in src/ledger.ts,
stale_head). Tests: test/rules.test.ts, "a report never satisfies a check" and
"a required check is pending until observed at the current head";
test/ledger.spec.ts, "evidence and reviews are refused at a stale head".

## A7. Generating baggage faster than retiring it

ControlPlane recorded one session adding three handoffs, eleven sealed-release
paragraphs of STATE.md narrative and two duplicated code paths, while the
archive policy that would have absorbed the first two had stood open for
twelve days. The same self-audit found one defect fixed in installable and
missed in web, one branch above it in the same function, and three validators
reported as load-bearing on the count of twenty files that were retired stubs.

Partly prevented. The surfaces a reader must consume are bounded by a policy
committed in the tree: `wrapReady` in cli/atelier.mjs reads the context budget
at HEAD (docs/control-plane/context-budget.v1.json, `evaluateCeilings` in
src/context-budget.ts) and refuses wrap when a surface passes its ceiling, and
a working copy of the policy that differs from HEAD's is named. Accumulated
workspaces are retired only against proof: `gcWorkspaceReason` in src/rules.ts
refuses removal unless the item is merged, the head is the merged head, the
tree is clean and no extra commits exist. Tests: test/context-budget.test.ts,
the generated case "ceiling at 5 lines" (refused) and "a working copy that
differs from HEAD's policy is named, and HEAD's is the one applied";
test/rules.test.ts, "gc removes only clean workspaces at their confirmed
merged head"; test/gc.test.mjs, "gc previews, then removes only clean merged
clones; preserves all local work". The remaining halves, fixing a shape rather
than an instance and counting facts rather than files, have no mechanism; the
second is A11's question.

## A8. Handing over a command without running it

ControlPlane recorded a go token computed by hand instead of through
release-token, the command whose purpose is to derive the authority declaration
from the diff and refuse a disagreement before anyone signs; PAVI signed a
statement that was wrong at the time, and only the seal caught it, nearly the
third release caught that way. A repair paste then told another project to
run a subcommand that does not exist, found only because the verification was
later run from the same side.

Partly prevented. The CLI's usage text is data in src/usage.ts that the CLI
imports, so help and parser share one source. The handoff routes return the exact next command
for the new owner ("${to} runs: atelier claim ${id} --project ${project}", the
handoff cases in src/index.ts), built in the Worker apart from the CLI that
parses it, and the real binary is tested to print its usage, so a command
named in help is a command that exists and prints its usage without contacting a
server. Tests: test/cli-text.test.mjs, "every command the CLI defines is in
the help, and every help entry is a command" and "each command's usage line
prints exactly as pinned"; test/cli-help.test.mjs, "models --help prints the
usage and exits 0 without contacting the server". Not covered: the handoff
route's generated line is not itself pinned by a test, and a command an agent
types into its own message to another agent is outside Atelier entirely.
Suggested change: pin the handoff `next` line in test/cli-text.test.mjs the
way the help text is pinned.

## A9. Reporting success from an absence of errors

ControlPlane recorded a shell loop over rollout targets that printed nothing
and was read as success though it had landed nothing, because zsh does not
word-split unquoted parameters and a grep filter hid the error. It was caught
only by checking state afterwards. Verify state, not output.

Atelier's recording path verifies state, with one stated exception: outside a
project registered as sandbox only, a check's pass or fail is the caller's
word, recorded as observed (the evidence route in src/index.ts says so). The
push route reads the head from
Artifacts itself (`headOf` in src/index.ts), and `recordPush` in src/ledger.ts
records what the Worker saw, logging a mismatch flag when the caller's claim
differs; the CLI dies rather than accept a silent disagreement, with a message
naming both heads (`push` in cli/atelier.mjs), and `finish` re-reads the item
after the checks and refuses if the remote revision moved. A rewrite of the
fork's history is detected, not assumed: `pushLineage` and `holdsCommit` in
src/index.ts walk the fork's history, and `recordPush` refuses an undeclared
rewrite. Tests: test/agent-commands.test.mjs, "push refuses a branch the fork
does not read, and a claim refresh corrects the workspace", which asserts the
recorded head is the one Artifacts reports; test/push-lineage.spec.ts, "the
Ledger refuses a head that does not hold the recorded one unless the push
declares the rebase from it"; test/update-force-push.test.mjs, "push --force
refuses to drop commits Atelier recorded, whatever the lease would allow".

## A10. Shipping code with no test

ControlPlane recorded two functions reaching a release candidate unexecuted by
any test. The changed-function coverage gate caught it and refused the
release.

Atelier does not prevent this. The test script in package.json runs the whole
suite, and the gate counts only the project's required checks passing at the
head (`gate` in src/rules.ts); nothing computes which functions a change
touched or whether any test executed them. Suggested change: a changed-function
coverage script as one of policy.checks, failing when a function changed
between an item's base and head is executed by no test, so it is observed at
the head and blocks the gate like any other check.

## A11. Stating a count nobody measured

ControlPlane recorded one exclusion written up as three trains in a commit
message and five in a relay, an hour apart, with neither number measured; then
a blast radius of "9 of 17" and "all seventeen" standing against a real 11 of
19, because the roster command sees only registered installations; then an
authority declaration typed as empty where the deriving function answers in
one call and fails closed to the whole set. The pattern is asserting a
computable fact instead of computing it.

Atelier prevents it wherever the fact gates something. The paths a change
touched are measured by the Worker from Artifacts (`measureWorkspace` in
src/diff.ts, called by the evidence route in src/index.ts, which never reads
the caller's changedPaths), and the change class is derived from those paths
(`changeClass` in src/rules.ts), so an agent cannot assert its own class or
its own radius; the same measurement runs against the baseline head, so a
crafted merge cannot hide a reverted file. Revision facts cannot be typed:
acceptance and review are refused unless the revision matches what Artifacts
holds (`assertRevision`, `verifyRevision`). Tests: test/routes.spec.ts, "the
item's own agent cannot name the paths its check changed: the Worker measures
them, so a protected change needs its independent review" and "the evidence
route measures against main's head, so a crafted merge cannot hide a reverted
protected file from the gate"; test/rules.test.ts, "changed paths take the
strictest class and retain implicit check protection"; test/ledger.spec.ts,
"HTTP approval rejects missing and stale revisions before reading Artifacts".
Not prevented: counts inside narratives, summaries, notes and reports remain
what their author typed (`cleanSummary` in src/brief.ts cleans and caps text,
it does not measure it). Nothing derives a narrative count, and a count in a
narrative is a claim like any other.

## A12. Editing a claimed file after the evidence was measured

ControlPlane recorded the seal's evidence-covers-head check refusing twice for
docs/FAILURE-MODES.md itself, written during the close after the gates had
measured, with each refusal costing a full re-finalize. The remedy was to
write every claimed file before release-finalize, then a close-order check to
catch the edit at the edit.

Atelier prevents this by construction, because every fact the gate reads is
bound to a commit. Evidence is refused at any head other than the item's
(`addEvidence` in src/ledger.ts), the gate counts only evidence at the current
head (`evidenceAt` in src/rules.ts), and a later push moves the head and
withdraws the acceptance: `recordPush` in src/ledger.ts returns an accepted
item to claimed, and `observePush`, for pushes that arrive outside the CLI,
returns it to submitted. An edit
after measurement therefore leaves the gate saying "not yet observed at this
head" instead of letting old evidence cover new bytes, and re-measuring costs
one `atelier check` in a fresh clean clone rather than a release ceremony.
Tests: test/rules.test.ts, "a required check is pending until observed at the
current head"; test/ledger.spec.ts, "evidence and reviews are refused at a
stale head" and "a push to an accepted task withdraws the acceptance, and only
its owner can push".

## A13. Shipping a test that reaches outside the shipped module set

ControlPlane recorded a canonical test reading docs/control-plane/, which sits
at a project root in an adopter rather than under the vendored module, breaking
24 modules inside a materialized target snapshot; it was recorded three times, and a fifth instance
landed in the commit that claimed to avoid the fourth. The suite ships and
runs in seventeen other repositories where the layout differs. What finally
prevented it was a boundary test naming the module, the import and the remedy,
a mechanism rather than a rule.

Atelier removes the boundary itself: it ships no suite into other
repositories. Each project keeps its own repository and its own checks, which
run in a clean clone of that repository's exact head (`cleanClone` in
cli/atelier.mjs, a full clone of the fork detached at the head Artifacts
holds), so there is no second layout for a test to reach outside of. Atelier's
own suite runs in this repository: `node --test` for the pure functions and
vitest inside workerd for the Durable Object (package.json, vitest.config.ts).
Tests: test/check-env.test.mjs, "a passing local check sees no credentials and
uploads none" and "a check still runs its toolchain: node and git from PATH, a
temporary folder, its own HOME", which execute the real check path in a clean
clone. If Atelier's own tests were ever vendored into another tree,
ControlPlane's remedy, a boundary test that names the path and the skip, would
be the change to make.
