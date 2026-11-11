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
  other (t538). A design note records how many tasks it plans, and `atelier
  status` lists the planned tasks not yet filed (t601).
- A dispatch on criteria names the reviewer PAVI chose, a claimed task's
  criteria review is offered to its reviewer, and a submit that names a
  reviewer asks that review or records why not. Anyone can ask a submitted
  task's review without the orchestrator (t587, t565, t566, t513).
- A dispatch is not held by a task that is itself blocked by it (t583).
  A rework round that adds no commit is not resubmitted at the rejected
  head, and a review that says "too long" is not read as a size refusal
  (t548, t554).
- A criteria review asks how a task behaves on crash, retry, repeat and
  timeout (t535).
- The stuck-stage events, the extra tier review and the media secret flag
  are gone (t518).

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
- A project can require its full visual suite as a landing check, and a
  seconds-long landing check runs the tests that scan the source (t517,
  t512).
- A ship's wrap step fails when the deploy passes but the wrap does not
  (t515).
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
- A builder is not started when the fork already holds the committed result
  (t335). The Tapestries build runner can run a project's browser tests
  (t605). `atelier runner --usage` accepts `--claude-capture` from the real
  CLI (t573).
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
- Today's Running rows show the machine, model and how each run is going;
  the Now view lists every live task, who it waits on and since when (t578,
  t525).
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

### Commands

- `atelier flow --bars` reports the redesign's bars over the last 7 days,
  for one project or all, with how criteria were written (t527).
- `atelier slots trial FILE` reads a slot-capacity trial and reports
  whether a second test slot keeps landings fast; with `--apply` it sets
  the capacity when the trial qualifies (t528).
- `atelier check` and `submit` find declaration problems that land would
  refuse, and warn when a task is over five criteria or 15 files, or a
  deploy gate is not among the required checks (t509, t440, t293).
- `atelier runner --usage` posts its summaries with the acting model
  (t506). `atelier unwrap` names the models a project plans to use and
  leaves out runners no longer live (t433, t430, t508).
- `atelier init` registers a large repository (t417). `atelier land`
  reviews first when a fast-mode project asks for review before merge
  (t455). `atelier ship` warns on unreviewed merges (t431).
- A review's effort setting is honoured (t445), and a review by hand is
  the plain path when no runner serves reviews (t421). Overlap refusals
  name stale unscoped holders (t419). `stuck` shows a deploy or ship
  running far too long and skips work nobody is expected to move (t461,
  t427).

### Smaller changes

- `atelier report`'s help states its length limit (t553).
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
