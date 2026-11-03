# Protected actions and `atelier ship`

For developer-token examples, set the acting model for the session:

```sh
export ATELIER_ACTING=claude-code/opus-5.5
```

Use your own registered harness/model. Owner commands such as `ship`,
`wrap`, `branch push|fetch`, `plan show`, `projects` and `import-tasks` keep
the owner actor and use `ATELIER_ACTING`; do not add `--as` to them.
Commands that act as a builder or reviewer use `--as H/M` to name that actor. Agent and runner tokens
name their own actors; leave `ATELIER_ACTING` unset with those tokens.

A protected action runs only with the developer's approval for one exact
revision of the project's main line, and each approval is used by one run.
`atelier ship`, run by the developer in the registered checkout, composes the
project's ship order from its ship file, refuses before running anything when
a protected step has no approval at the revision being shipped, runs the steps
in order, stops at the first failure, and records every step on the ledger.
This follows PAVI's decision of 2026-10-05, recorded in atelier-ops'
`docs/controlplane-inventory-2026-10-05.md`.

The code is `src/actions.ts` (the rules and storage), `src/actions-api.ts`
(the routes and the project page's forms), `src/actions-page.ts` (the
project page's section) and `cli/ship.mjs` (composing and running a ship).

## What a protected action is

An action whose effect reaches beyond the project's repository and cannot be
taken back by a revert:

| Kind | What it is |
|---|---|
| `deploy` | publishing the project to where its users reach it, such as `npm run deploy` |
| `install` | installing a build on a device |
| `paid-run` | a model or service run that is paid for |
| `photos-writeback` | writing to a Photos library |

Pushing the project's branch to its own remotes, such as GitHub, is not a
protected action. `atelier ship` is run by the developer alone, at one exact
revision of the main line, and `--push` is the developer's own act there, so it
needs no approval (PAVI's decision of 2026-10-06); `deploy`, `install`,
`paid-run` and `photos-writeback` keep their revision-bound approvals.

A project's ship file may name further kinds: an approval kind given in
`docs/atelier/ship.json`. `atelier approve` refuses any
other kind, since nothing would use it. The server accepts any kind written in
lower-case letters, digits and dashes, because it does not read the
project's files.

`atelier ship` uses `install` and `deploy` approvals, and any kind a
step in `docs/atelier/ship.json` names. Approvals for `paid-run` and
`photos-writeback` can be given, listed and withdrawn, and are used through
the same route by whatever runs those actions; no Atelier command runs them
yet.

## How an approval binds to a revision

The developer approves one kind at one revision:

```bash
ATELIER_ACTING=claude-code/opus-5.5 atelier approve deploy --head "$(git rev-parse HEAD)" --note "release 12" --quote "Deploy release 12" --expires 24h
```

When the developer approves in chat, the model records their words with
`--quote` and names itself with `--as`:

```bash
atelier approve deploy --head "$(git rev-parse HEAD)" --quote "yes, deploy it" --as claude-code/opus-5.5
```

The approval then holds the words as its `quote` field and the model as its
`acting` field, apart from its `note`, which stays whatever `--note` gave.
`atelier approvals`, the ship output and the project's actions page show them,
and a run that used the approval carries them on its `action.ran` event and in
the record the runs route returns. Those are the places to read them:
`atelier status` and `atelier receipt` list no action approvals or runs.
`--quote` needs an acting model, from `--as` or `ATELIER_ACTING`.

Run in the registered checkout at the revision to ship, or with the form
under "Protected actions" on the project's page, which binds the approval to
the main line's head as the page read it. For a project with a rebuilt
baseline (1.x's `--history-since`), the revision is the baseline's commit,
which `atelier ship --dry-run` prints.

- **The revision is a commit the baseline holds.** The baseline, the project's
  repository on the server, is the main line as Atelier sees it. The server
  refuses a revision that is not the baseline's head or in its history, so a
  commit that exists only on a task's branch, or nowhere, cannot be approved.
  For a project with a rebuilt baseline (1.x's `--history-since`), whose
  baseline holds rebuilt commits, the
  revision is the baseline's commit, and `atelier ship` finds the checkout
  commit it stands for through the checkout's pairs.
- **The full revision is required**, 40 or 64 hex digits. `atelier ship
  --dry-run` prints the exact `atelier approve` command for each approval
  that is missing.
- **One approval, one run.** A ship marks the approval used (`consumed`)
  before the step runs, so two ships never share one, and a step that fails
  has still spent it. A second approval for the same kind and revision is
  refused while the first stands.
- **Any other revision is refused.** When the main line moves, the approval
  stays bound to the old revision and a ship at the new one needs its own.
- **It expires.** An approval stands for 24 hours unless `--expires` says
  otherwise, from `1m` to `30d`.
- **The developer can withdraw it** while it is unused: `atelier approvals
  withdraw ID`, or the Withdraw button on the project page.
- **Only the developer** approves, withdraws, uses or records. The routes
  are developer-only: an agent token is refused before the route is reached, and
  the developer token naming any other actor is refused by the route, as accept
  is.

`atelier approvals` lists the approvals that stand; `--all` adds the used,
withdrawn and expired ones.

## The composed order

`atelier ship` reads the project's ship order from one file, the project's
`docs/atelier/ship.json`, described below. A checkout with only ControlPlane's
files (`docs/control-plane/`) has no ship order: ship refuses before it runs a
command, takes an approval or records a run, and names the file to add.
ControlPlane's ship policy, adapter and device set are not read, valid or
not (ControlPlane is retired).

The class gives the order:

| Class | Order |
|---|---|
| web | commit, deploy, verify-delivery, wrap, push |
| installable | install, verify-delivery, commit, wrap, push |
| hybrid | install, verify-delivery, commit, deploy, verify-delivery, wrap, push |
| other | commit, wrap, push |

The optional steps in the ship file are added to that order: `typecheck`
goes just before the first of install, deploy or wrap, `scan` just before
push, and `baseline` then `studio` just after it. Atelier's own web order is
therefore commit, typecheck, deploy, verify-delivery, wrap, scan, push. The `scan` and `baseline` steps are Atelier's own commands
and run with the developer's whole environment, `ATELIER_TOKEN`,
`ATELIER_CONFIG_DIR` and `ATELIER_SERVER` included, as wrap does; the other
command steps run without the `ATELIER_` variables.

A verify step with nothing to run refuses the ship before anything runs,
naming what to declare: a web project needs a `verify-deploy` run, such as a
request to the live site, before `atelier ship` runs for it.

Local request tests cannot establish DNS propagation or the live Access policy.
Before and after deployment, run the declared delivery check from the deployment
host: check the current live revision before deploying and the captured revision
afterwards. For an Access-protected site, check the expected redirect status
without following redirects. Repeat an unconfirmed check from the calling Mac
once its DNS has caught up. These checks do not require deploying again.

### From `docs/atelier/ship.json`

Atelier's own, as main holds it. Since the 2026-10-31 cut-over, main deploys
and verifies production at `atelier.zone` on the Studio (`docs/studio.md`).
Staging at `next.atelier.zone` ships from the separate `atelier-trial` project.

```json
{
  "schema_version": 1,
  "kind": "atelier.ship",
  "class": "web",
  "description": "Atelier delivery: run the full suite from the shipped commit on ai-studio, typecheck, deploy, verify the live commit, scan and push.",
  "typecheck": [
    {
      "run": [
        "node",
        "scripts/ship-suite-studio.mjs"
      ],
      "timeout_seconds": 3600
    },
    {
      "run": [
        "npm",
        "run",
        "typecheck"
      ],
      "timeout_seconds": 600
    }
  ],
  "deploy": {
    "run": [
      "node",
      "scripts/ship-studio.mjs",
      "deploy",
      "--env",
      "production",
      "--version-url",
      "https://atelier.zone/api/version",
      "--host",
      "ai-studio"
    ],
    "terminal": true,
    "timeout_seconds": 1200
  },
  "verify-deploy": [
    {
      "run": [
        "node",
        "scripts/ship-studio.mjs",
        "verify",
        "--version-url",
        "https://atelier.zone/api/version"
      ],
      "timeout_seconds": 90
    },
    {
      "run": [
        "node",
        "scripts/ship-refresh-runners.mjs"
      ],
      "timeout_seconds": 540
    }
  ],
  "scan": {
    "run": [
      "node",
      "scripts/privacy-scan.mjs",
      "--remote",
      "github",
      "--branch",
      "main",
      "--project",
      "atelier"
    ],
    "timeout_seconds": 300
  },
  "push": {
    "remote": "github",
    "branch": "main"
  }
}
```

| Field | Meaning |
|---|---|
| `schema_version` | `1` |
| `kind` | `"atelier.ship"` |
| `class` | `web`, `installable`, `hybrid` or `other`, which gives the order |
| `description` | text for people; not read |
| `install` | what the install step runs: installable and hybrid |
| `verify-install` | what verify-delivery runs after install: installable and hybrid |
| `deploy` | what the deploy step runs: web and hybrid |
| `verify-deploy` | what verify-delivery runs after deploy: web and hybrid |
| `push` | `{"remote": NAME, "branch": NAME}`; left out, the push goes to the branch's tracked upstream; `false`, the order has no push step, `scan`, `baseline` and `studio` are refused, and `--push` is refused |
| `typecheck` | optional: runs before the first delivery step (or before wrap, with none) |
| `scan` | optional: runs just before the push, with `--push`; a failure stops the ship before anything is pushed |
| `baseline` | optional: runs just after the push, with `--push`; skipped on the Node server, where the project's repository is the baseline |
| `studio` | optional: runs after `baseline`, with `--push` |

Each of `install`, `verify-install`, `deploy`, `verify-deploy`, `typecheck`,
`scan`, `baseline` and `studio` is one run or a list of runs. Naming one of the
last four adds its step to the class's order; leaving it out leaves the step out. A run is either

- `{"run": ["word", …]}`: a command and its arguments, run with no shell in
  the checkout, or
- `{"request": URL, "status": 200}`: a GET of an http or https URL that must
  end with that status. Redirects are followed, so `https://atelier.zone`,
  which sends a visitor who is not signed in on to `/home` and its sign-in,
  answers 200 there. Add `"redirect": "manual"` to check the first response
  without following redirects. For example, `{"request": "https://private.example",
  "status": 302, "redirect": "manual"}` expects an Access sign-in redirect;
  a public HTTP 200 fails that check. The default is `"redirect": "follow"`.
  A status check confirms the response code, not which service issued it.

and may add `"retries"` (0 to 3: the run is tried again that many times if it
fails, under the approval already taken, and every try is recorded),
`"if_changed"` (`{"paths": [GLOB, …], "since": URL}`: the run happens only
when a file matching a glob changed between the `commit` the URL's JSON gives,
the revision last delivered, and the revision being shipped; when the URL or
that commit cannot be read the run happens, and its record says why; a run
skipped this way takes no approval, is recorded as passed with the reason, and
a verify step whose delivery was skipped throughout is skipped with it),
`"terminal": true` (a command only: it gets ship's terminal and runs in
ship's own process group, so a password prompt such as sudo's reads the
password from the terminal itself; its output is shown, not kept, and its
record says so),
and `"timeout_seconds"` (20 minutes for a command and 30 seconds for
a request unless given) and `"approval"`: the kind of approval the run needs.
An install or deploy run needs the approval of its step's kind unless it
names another; a verify run needs none unless it names one. A field the
schema does not list, a run field for a step the class has no place for, or
a class outside the four is refused before anything runs.

Atelier's own deploy, `scripts/ship-studio.mjs deploy --env ENV --version-url
URL --host HOST`, checks that the checkout is still clean at
`ATELIER_SHIP_HEAD` before and after, and that the branch head the live
server reports (`main` at the version URL) holds that commit. It then runs
root's installer, `/Library/Atelier/install-server.sh --env ENV COMMIT`,
under `sudo` with `ssh -t`, passing nothing else. The developer types the
administrator password at sudo's own prompt. The installer builds the release
itself from the Studio's repository, checks the commit is on the project's
branch, installs it, restarts the environment's LaunchDaemon and waits for
`/api/version` to report the commit; when it does not, it puts the previous
release back and says so, and the deploy fails. `verify --version-url URL`
refuses redirects and requires HTTP 200 with `commit` equal to the captured
HEAD. `docs/studio.md` says more. Failure stops the ship before wrap or push.

## Production and staging

Since the 2026-10-31 cut-over, Atelier 2.0 runs as two servers on the Studio
that share no state: production at `atelier.zone` (port 4100) and staging at
`next.atelier.zone` (port 4101). `docs/studio.md` describes both.

- **Main ships to production.** Main's `docs/atelier/ship.json` deploys with
  `node scripts/ship-studio.mjs deploy --env production --version-url
  https://atelier.zone/api/version --host ai-studio`, checks
  for server changes against `https://atelier.zone/api/version` and
  verifies there; with `--push` it then scans and pushes main to GitHub.
- **Staging ships from `atelier-trial`.** The separate project ships to
  `next.atelier.zone`.
- **`docs/atelier/ship-staging.json`** is the staging order without the
  push steps (`"push": false`, no scan), for shipping staging from a
  checkout that must not push.

When a release exists only in staging's `atelier-trial` or on another branch,
carry its commits on a task branch in production's `atelier` project. Have
that production task checked, reviewed at its exact head and landed, then
run `atelier ship --project atelier` from production's clean registered
checkout at the landed main revision, with its deploy approval. A review
recorded only in staging does not satisfy production's review gate. The
[production release procedure](studio.md#shipping-a-release) gives the steps.

This release path requires production's `atelier` project to protect every
release path and run in normal mode, without a review override. Production
protects `**` (every path, as configured by `atelier init --protect "**"`)
and runs in normal, non-`fast` mode. Under that policy, landing refuses a
head without the required review approval, including the first reviewed
release after setup. Default protection after setup and init alone does not
cover every server release path, and fast mode defers review until after
merge.

Ship refuses a head that production's main does not hold, before SSH or sudo;
root's installer checks ancestry again in the Studio's production repository
and builds the release there. Ship neither carries commits nor lands them.
`setup-server.sh` is for initial setup and repair only, including replacing
the root-owned installer; releases use the reviewed task, landing and ship
path, without hand-built tars.

## What a ship does, in order

Before anything runs, `atelier ship` refuses, saying what to do next, unless:

- the developer runs it (no `--as` or `ATELIER_ACTOR` naming another actor);
- the current directory is the project's registered checkout, on the
  registered branch, with no merge, rebase, cherry-pick, revert or landing in
  progress;
- the checkout is clean, untracked files included;
- HEAD is the baseline's head, or for a project with a rebuilt baseline the
  commit the baseline's head is paired with;
- the order composes with nothing missing, and the push target, when
  `--push` is given, is a remote the checkout already has;
- every approval the steps need is present and active at the baseline's
  head: install and deploy always, and any kind a run names.

It then prints the steps and runs them:

- **commit** runs nothing. The checkout was clean at the revision shipped, so
  there is nothing to commit; what later steps change, such as a delivery
  receipt an install writes, is committed by wrap.
- **install, deploy and verify-delivery** take their approvals, then run each
  command or request in turn. A command runs with the developer's environment,
  which a deploy needs for its own credentials, less every variable whose
  name starts with `ATELIER_`. The runner then sets the non-secret
  `ATELIER_SHIP_HEAD` to the local source HEAD it validated, replacing any
  caller-supplied value. It is the source commit, not a rebuilt baseline
  commit. Its output is shown as it comes.
  After a successful deploy, a failed verify-delivery is recorded as failed,
  but wrap still runs. Ship then exits unsuccessfully with delivery unconfirmed,
  the commands to recheck from the checkout, and push still blocked. A request
  recheck prints its HTTP status and the expected status; command checks reuse
  their declared command with `ATELIER_SHIP_HEAD` set to the captured source
  commit. Install verification and a failed deploy still stop immediately. No successful ship record is written before wrap completes.
- **wrap** is `atelier wrap "Ship SHORT: steps"` run in the checkout. It runs
  the registered checks, commits what the steps changed, records the session
  and reports how the checkout stands against the server's branch; a failing
  check stops the ship there.
- **typecheck** runs Atelier's `npm run typecheck` before the deploy, so a
  failing type-check stops the ship before an approval is spent.
- **deploy** runs only when the server's code changed since the commit the
  `if_changed.since` URL reports as live (`src/**`, `cli/serve.mjs` and what
  the server loads from `cli/`, the hooks, `package.json` and the lock
  file). The live server says what was last deployed.
  It is not retried: a second try would ask for the password again.
- **scan** (`scripts/privacy-scan.mjs`), with `--push`, reads the commits the
  GitHub remote lacks and refuses on a hit: an author or committer that is
  not a GitHub no-reply address, an added line that looks like a key
  (`src/secret-scan.ts`), or a private file in a commit or tree
  (`cli/private-guard.mjs`). It prints each hit without the value and stops
  the ship before the push. A remote it cannot read also stops it.
- **push** runs only with `--push`, taking no approval, since ship is
  developer-only and this is their own act at the exact revision being
  shipped: `git push
  --no-force --no-follow-tags REMOTE refs/heads/BRANCH:refs/heads/TARGET`,
  then reads the remote back and fails unless it holds the new HEAD. Without
  `--push` the ship ends after wrap and prints the command that pushes.
- **baseline** and **studio**, when a ship file names them, run after the
  push, with `--push`. Atelier's own names neither: on the Node server the
  project's repository is the baseline, which only a landing moves, so ship
  skips a baseline step; and the Studio runs the release `deploy` installs,
  not a checkout.

The first step that fails stops the ship. The message names the step, what
ran before it and what did not run, and, when the step had spent an
approval, the command that approves it again.

`atelier ship --dry-run` does the checks and prints the steps, with each
approval present (its id and expiry) or missing, and the `atelier approve`
command for each missing one. It runs, approves and records nothing.

## What is recorded

Each is an event in the project's ledger, with no task id:

| Event | Data |
|---|---|
| `action.approved` | id, kind, commit, note, expiry, and, when given on the developer's direction, quote and acting |
| `action.withdrawn` | id, kind, commit, note |
| `action.consumed` | id, kind, commit |
| `action.ran` | step, kind, approval used, command, commit, exit status, signal, duration, passed, output tail, ship id, note, and, when the approval it used had them, quote and acting |
| `ship.recorded` | ship id, head, by, result (shipped or failed), the step it stopped at, the steps that ran, note |

There is one `action.ran` for every command, request or step that ran,
passing or failing, and none for a step that did not run. The ship id is the
same on every step of one ship. The output tail is the last 3,500 characters,
cut after redaction: the developer's Atelier token, any Git token in the
checkout's Git settings, and the value of every environment variable whose
name says it holds a token, a key, a secret, a password or a credential are
replaced with `[redacted]`, as `atelier check` redacts check output.

The project page lists the approvals with their status and the latest steps
run; `GET /api/projects/P/actions` returns both.

Once a ship has begun running its steps, it records the deploy as one
`ship.recorded` event, whether it shipped or failed (G9): at the step that
failed, or, for a ship that ended some other way (a refused request), on its
way out. A ship killed outright records nothing. `GET /api/projects/P/deploys`
lists them, newest first, and `atelier show` prints the newest as `Last
deploy:`. A ship refused before running anything records no deploy.

## The checkout lease

Ship runs in the registered checkout, as a landing's merge step does
(docs/landing.md). The two never use it at the same time: each takes the
project's checkout lease before it reads or changes the checkout, and frees
it when done. A ship started while a merge holds it waits, saying who holds
it (`ship waits for P's registered checkout: it is held by t3's landing (its
merge step), owner on studio (pid 4242), since ...`), and goes on once it is
free; a merge started during a ship waits the same way. The holder renews the
lease every minute; one that stopped renewing for 15 minutes (it died) is
taken over, and the taker says whose lease lapsed. A ship whose lease was
taken over that way stops before its next step, as a fact with a `next`, and
records the deploy as failed. `--dry-run` takes no lease.

While a merged revision's declared protected actions have not run, the
developer's inbox carries a reminder. The kinds the order needs unconditionally
(install, deploy and the kinds runs name) are recorded with the project's
policy at `atelier init`,
and for each merged item the entry stands from its `item.merged` event until
an `action.ran` event of that kind follows it in the ledger, at any revision:
a ship at a later head delivers an older merge, so its runs retire the older
reminders too. `atelier status` names `atelier ship --dry-run` as the entry's
next command.

`atelier sync` is `not_supported` in 2.0. Use `atelier init` to record a
changed ship order, `atelier pull` to update the checkout, and a landing to
publish task commits.

## What ship runs is protected

`docs/atelier/**` is guarded in every project, and the files the composed
order's commands execute are guarded exactly as the files a check executes
are: `atelier init` reads the order from the checkout and
records its commands in the project's policy, and the gate derives the same
files from them it derives from a check's line (`checkFiles` in
`src/rules.ts`): a script run directly, the recipe files `make` and `just`
read, the manifest a package manager runs scripts from, the local binary
`npx` and its kin would run. A change to the ship file, to a script it runs
or to such a manifest therefore needs an independent review in every
project, with no `--protect` entry. The acceptance records the commands with
the policy it was made under, so a merge refuses an accepted change that
touches a script a newer order runs, as it refuses one a newly protected
path catches.

## What ship does not do

- It never forces a push, and never creates, chooses or repairs a remote or
  an upstream.
- It never runs a protected step without an active approval at the revision
  shipped, and never reuses an approval.
- It does not discover devices, deliver to optional targets, or waive a
  target that fails: a device that is not reachable fails the step.
- It does not retry a failed step, except a run whose `retries` says so
  (Atelier's deploy, once), or roll back one that succeeded, such as
  a deploy before a failing verify.
- It does not merge, accept or review: the revision is already on the main
  line.
- It does not run `paid-run` or `photos-writeback` actions on its own, only
  steps that name those kinds.
- It does not deliver a merged revision by itself: the developer runs it, and the
  inbox's reminder (above) stands until a run of each declared kind is
  recorded.
