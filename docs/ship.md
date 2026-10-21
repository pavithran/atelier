# Protected actions and `atelier ship`

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
| `deploy` | publishing the project to where its users reach it, such as `npx wrangler deploy` |
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
other kind, since nothing would use it. The Worker accepts any kind written in
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
atelier approve deploy --head "$(git rev-parse HEAD)" --note "release 12" --expires 24h
```

run in the registered checkout at the revision to ship, or with the form
under "Protected actions" on the project's page, which binds the approval to
the main line's head as the page read it. For a project set up with
`--history-since`, the revision is the baseline's commit, which `atelier ship
--dry-run` prints.

- **The revision is a commit the baseline holds.** The baseline in Artifacts
  is the main line as Atelier sees it. The Worker refuses a revision that is
  not the baseline's head or in its history, so a commit that exists only in
  a task's fork, or nowhere, cannot be approved. For a project set up with
  `atelier init --history-since`, whose baseline holds rebuilt commits, the
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

A verify step with nothing to run refuses the ship before anything runs,
naming what to declare: a web project needs a `verify-deploy` run, such as a
request to the live site, before `atelier ship` runs for it.

### From `docs/atelier/ship.json`

Atelier's own:

```json
{
  "schema_version": 1,
  "kind": "atelier.ship",
  "class": "web",
  "description": "Atelier's own delivery: deploy the captured source commit, verify its live binding, then push main to the github remote.",
  "deploy": { "run": ["node", "scripts/ship-worker.mjs", "deploy"], "timeout_seconds": 1200 },
  "verify-deploy": { "run": ["node", "scripts/ship-worker.mjs", "verify"], "timeout_seconds": 45 },
  "push": { "remote": "github", "branch": "main" }
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
| `push` | `{"remote": NAME, "branch": NAME}`; left out, the push goes to the branch's tracked upstream |

Each of `install`, `verify-install`, `deploy` and `verify-deploy` is one run
or a list of runs. A run is either

- `{"run": ["word", …]}`: a command and its arguments, run with no shell in
  the checkout, or
- `{"request": URL, "status": 200}`: a GET of an http or https URL that must
  end with that status. Redirects are followed, so `https://atelier.zone`,
  which sends a visitor who is not signed in on to `/home` and its sign-in,
  answers 200 there.

and may add `"timeout_seconds"` (20 minutes for a command and 30 seconds for
a request unless given) and `"approval"`: the kind of approval the run needs.
An install or deploy run needs the approval of its step's kind unless it
names another; a verify run needs none unless it names one. A field the
schema does not list, a run field for a step the class has no place for, or
a class outside the four is refused before anything runs.

Atelier's own helper checks that the checkout is still clean at
`ATELIER_SHIP_HEAD` before and after deployment. It passes
`--keep-vars --var DEPLOYED_MAIN:HEAD` to Wrangler, preserving existing
variables while updating that source binding. Verification refuses redirects
and requires HTTP 200 from `https://atelier.zone/api/version` with `commit`
equal to the captured HEAD. The endpoint's `main` field describes the ledger,
so it cannot establish which source was deployed. Failure stops the ship
before wrap or push. Tests use local process and response fixtures; live
variable preservation and source readback are checked at an authorised release.

## What a ship does, in order

Before anything runs, `atelier ship` refuses, saying what to do next, unless:

- the developer runs it (no `--as` or `ATELIER_ACTOR` naming another actor);
- the current directory is the project's registered checkout, on the
  registered branch, with no merge, rebase, cherry-pick, revert or landing in
  progress;
- the checkout is clean, untracked files included;
- HEAD is the baseline's head, or for a `--history-since` project the commit
  the baseline's head is paired with;
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
- **wrap** is `atelier wrap "Ship SHORT: steps"` run in the checkout. It runs
  the registered checks, commits what the steps changed, records the session
  and updates the baseline; a failing check stops the ship there.
- **push** runs only with `--push`, taking no approval, since ship is
  developer-only and this is their own act at the exact revision being
  shipped: `git push
  --no-force --no-follow-tags REMOTE refs/heads/BRANCH:refs/heads/TARGET`,
  then reads the remote back and fails unless it holds the new HEAD. Without
  `--push` the ship ends after wrap and prints the command that pushes.

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
| `action.approved` | id, kind, commit, note, expiry |
| `action.withdrawn` | id, kind, commit, note |
| `action.consumed` | id, kind, commit |
| `action.ran` | step, kind, approval used, command, commit, exit status, signal, duration, passed, output tail, ship id, note |

There is one `action.ran` for every command, request or step that ran,
passing or failing, and none for a step that did not run. The ship id is the
same on every step of one ship. The output tail is the last 3,500 characters,
cut after redaction: the developer's Atelier token, any Artifacts token in the
checkout's Git settings, and the value of every environment variable whose
name says it holds a token, a key, a secret, a password or a credential are
replaced with `[redacted]`, as `atelier check` redacts check output.

The project page lists the approvals with their status and the latest steps
run; `GET /api/projects/P/actions` returns both.

While a merged revision's declared protected actions have not run, the
developer's inbox carries a reminder. The kinds the order needs unconditionally
(install, deploy and the kinds runs name; push needs one only with `--push`)
are recorded with the project's policy at `atelier init` and `atelier sync`,
and for each merged item the entry stands from its `item.merged` event until
an `action.ran` event of that kind follows it in the ledger, at any revision:
a ship at a later head delivers an older merge, so its runs retire the older
reminders too. `atelier status` names `atelier ship --dry-run` as the entry's
next command.

## What ship runs is protected

`docs/atelier/**` is guarded in every project, and the files the composed
order's commands execute are guarded exactly as the files a check executes
are: `atelier init` and `atelier sync` read the order from the checkout and
record its commands in the project's policy, and the gate derives the same
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
- It does not retry a failed step or roll back one that succeeded, such as
  a deploy before a failing verify.
- It does not merge, accept or review: the revision is already on the main
  line.
- It does not run `paid-run` or `photos-writeback` actions on its own, only
  steps that name those kinds.
- It does not deliver a merged revision by itself: the developer runs it, and the
  inbox's reminder (above) stands until a run of each declared kind is
  recorded.
