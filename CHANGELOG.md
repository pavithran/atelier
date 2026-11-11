# Changelog

## 2.0.0

Covers every merge from the 2026-10-31 cut-over to the release commit
a606360f. `GET /api/version` now reports `version`.

### One flow for every change

- Every code change gets one review before it lands. Approved and checked
  tasks land by themselves, tested on the exact tree, and a landing
  regenerates outputs and merges instead of refusing (t437, t434, t451,
  t520, t429).
- A criteria review runs alongside the build and gates landing; a task is
  dispatched the moment its criteria are approved (t504, t522, t503, t502).
- A later review round reads the fix, and only real defects block. A
  reviewer runs the changed tests and refuses to approve if it can't (t436,
  t523, t571).
- A round-cap block lifts once without PAVI when its revised criteria are
  approved (t623, t441).
- Fast mode's docs and status lines are gone (t476).
- A merge that turns main or a release gate red can be reverted (t524).
- Tasks carry a priority of 1 to 3: `new` and `edit` take `--priority`, and
  `show`, `ls` and `queue` print it (t653, t654).
- Tasks can name a design note, and tasks naming one note wait for each
  other (t538).

### Landing, deploy and ship

- Deploy on landing proves the new commit is live. `queue-landable` and
  deploy-on-landing are recorded and act outside fast mode (t519, t501,
  t668).
- A ship runs the full suite on the Studio before it deploys, redacts
  secrets in live output, keeps a failed step's output, closes a dead
  process as failed and refreshes the runners it deployed to (t439, t620,
  t592, t584, t468, t472, t475, t481).
- A ship waiting at the deploy password records it, so a pulse wakes the
  session (t593).
- A merge-main job is never held by a core-file hold, and a core-file hold
  lasts until the holding task merges (t634, t537).

### Runners and builders

- A builder's brief states its harness time limit, and a project can set it
  (t588). A build that times out keeps its harness output and command trail
  (t589).
- A stopped or ended run takes its whole process tree with it (t617).
- Idle runners log the waiting list only when it changes (t651). Runners
  report their machine's load with each poll (t607).
- A rejected task's next build is claimed before new work, and a rejection
  reaches a builder with no session (t539, t521).
- The test slot pool works across users and survives a reboot (t480). The
  full suite runs once per submission, by the runner, not the builder
  (t336, t479).
- A project's direct commits carry onto 2.0 in one command (t418).

### Models and usage

- Usage is watched for every vendor, and work is routed by what is left.
  Readings expire and say whether a model is available (t487, t469, t564,
  t597).
- GLM usage reads CREDIT_LIMIT windows and attaches to the zai plan
  (t665). The Antigravity adapter serves Gemini 4 Carbon (t663).
- A review is never requested from a model no live runner offers (t591).

### Pages and notices

- Today replaces Home, Now and Decisions at `/`. The top bar reads Today,
  Projects, History, Process, Models. The task page leads with its verdict,
  stage track and evidence (t562, t585, t586).
- A Process tab maps the task flow with time per phase (t558). A Rigs page
  shows each machine as a signal box with its tracks (t608).
- Answer, Override, and Land act from Today and the task page as PAVI
  (t596, t594).
- ntfy is removed; notices stay in the ledger and reach PAVI in chat
  (t533).
- The signed-out refusal page offers a Sign in link, and the owner's Access
  sign-in is honoured on pages Cloudflare does not cover (t625, t626, t559).

### Tests and checks

- Many tests that failed under load now pass: t667, t666, t660, t624,
  t633, t604, t612, t595, t590, t516, t547, t453.
- Test runs no longer dirty a workspace (t652). A new function only tests
  call fails a static check before review (t534).
- Findings and failed checks are tagged with their criterion and cause
  (t536).

### Smaller changes

- Refusals name their next step (t511). `atelier show`, `log`, `flow`,
  `stuck` and `init` say more about the work they report (t482, t460,
  t457, t467, t448, t531, t489).
- The handbook, guides and a short orchestrator guide are kept current
  (t442, t541, t619, t621).

## Known gaps

What 2.0 leaves undone that a reader might expect:

- Evidence installs do not reuse a cached `node_modules` (t661).
- The Models page has no plan cards (t664).
- Landing checks do not run on a build runner (t622).
- Builders do not skip claims when the machine is overloaded (t662).
- A release list cannot be frozen, and approved tasks can land after a
  freeze (t678).
- The lander does not catch its checkout up to the server's main (t682).
- Fast and regular modes both remain; a single mode is not done (t477).
