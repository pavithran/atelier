# Protected actions and `atelier ship`

A protected action runs only with the project owner's approval for one exact
revision of the project's main line, and each approval is used by one run.
`atelier ship`, run by the owner in the registered checkout, composes the
project's ship order from its own files, refuses before running anything when
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
protected action. `atelier ship` is run by the owner alone, at one exact
revision of the main line, and `--push` is the owner's own act there, so it
needs no approval (PAVI's decision of 2026-10-06); `deploy`, `install`,
`paid-run` and `photos-writeback` keep their revision-bound approvals.

A project's own files may name further kinds: an approval kind given in
`docs/atelier/ship.json`, or a capability name or action class in
`docs/control-plane/project-adapter.v1.json`. `atelier approve` refuses any
other kind, since nothing would use it. The Worker accepts any kind written in
lower-case letters, digits and dashes, because it does not read the
project's files.

`atelier ship` uses `install` and `deploy` approvals, and any kind a
step in `docs/atelier/ship.json` names. Approvals for `paid-run` and
`photos-writeback` can be given, listed and withdrawn, and are used through
the same route by whatever runs those actions; no Atelier command runs them
yet.

## How an approval binds to a revision

The owner approves one kind at one revision:

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
- **The owner can withdraw it** while it is unused: `atelier approvals
  withdraw ID`, or the Withdraw button on the project page.
- **Only the project owner** approves, withdraws, uses or records. The routes
  are owner-only: an agent token is refused before the route is reached, and
  the owner token naming any other actor is refused by the route, as accept
  is.

`atelier approvals` lists the approvals that stand; `--all` adds the used,
withdrawn and expired ones.

## The composed order

`atelier ship` reads the project's ship order from the first of these the
checkout holds:

1. **ControlPlane's ship policy**, `docs/control-plane/ship-policy.v1.json`,
   with `docs/control-plane/project-adapter.v1.json` for the commands and the
   newest of `docs/control-plane/canonical-device-set.v3.json`, `v2` and
   `v1` for the device targets.
2. **Atelier's ship file**, `docs/atelier/ship.json`, described below.

The orders are ControlPlane's:

| Class | Order |
|---|---|
| web | commit, deploy, verify-delivery, wrap, push |
| installable | install, verify-delivery, commit, wrap, push |
| hybrid | install, verify-delivery, commit, deploy, verify-delivery, wrap, push |
| other | commit, wrap, push |

### From a ControlPlane policy

A policy whose `effect_order` has the rule `compose-from-declared-capabilities`
composes the order from the delivery classes the adapter declares, as
ControlPlane does: a capability with `action_class` `device` puts install and
verify-delivery before commit, and one with `deploy` puts deploy and
verify-delivery after it. A project that declares both is hybrid, and one
that declares neither closes on commit, wrap and push. A policy without the
rule takes its `application_classes` row for the class the canonical device
set names.

Each step runs adapter capabilities, each command as its list of words with
no shell, in the checkout:

- **install** runs, for each required target of the canonical device set,
  the capability the target names as `install_capability`. A command that
  ends with an option takes the target's `selector` as its value, as
  MicahApp's `ios/bin/to-phone-adhoc.sh --device` takes the device's UDID.
  A target marked `"requirement": "optional"` is left out and named in a
  note. Without a device set, every `device` capability whose name starts
  with `install` runs.
- **verify-delivery after install** runs each required target's
  `verify_capability` the same way, or every `device` capability whose name
  starts with `verify`.
- **deploy** runs every capability with `action_class` `deploy`.
- **verify-delivery after deploy** runs every capability whose name starts
  with `verify` and whose `action_class` is not `device`.

A step with nothing to run refuses the ship before anything runs, naming what
to declare. On 2026-10-06 none of the adapters read for this design (ikon
weblog, list, Photograph, ControlPlane) declares a verify capability for its
deploy, so each needs one, such as a `verify-deploy` capability running
`curl -fsS` against the live site, before `atelier ship` runs for it.

A capability's `timeout_seconds` is its timeout; without one it is 20
minutes. The push goes to the branch's tracked upstream; a policy asking for
a forced push is refused.

### From `docs/atelier/ship.json`

For a project without ControlPlane files. Atelier's own:

```json
{
  "schema_version": 1,
  "kind": "atelier.ship",
  "class": "web",
  "description": "Atelier's own delivery: the Worker deployed to atelier.zone, the live site checked, then main pushed to the github remote.",
  "deploy": { "run": ["npx", "wrangler", "deploy"], "timeout_seconds": 1200 },
  "verify-deploy": { "request": "https://atelier.zone", "status": 200 },
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
  which sends a visitor who is not signed in to `/login` or `/showcase`,
  answers 200 there.

and may add `"timeout_seconds"` (20 minutes for a command and 30 seconds for
a request unless given) and `"approval"`: the kind of approval the run needs.
An install or deploy run needs the approval of its step's kind unless it
names another; a verify run needs none unless it names one. A field the
schema does not list, a run field for a step the class has no place for, or
a class outside the four is refused before anything runs.

## What a ship does, in order

Before anything runs, `atelier ship` refuses, saying what to do next, unless:

- the owner runs it (no `--as` or `ATELIER_ACTOR` naming another actor);
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
  command or request in turn. A command runs with the owner's environment,
  which a deploy needs for its own credentials, less every variable whose
  name starts with `ATELIER_`. Its output is shown as it comes.
- **wrap** is `atelier wrap "Ship SHORT: steps"` run in the checkout. It runs
  the registered checks, commits what the steps changed, records the session
  and updates the baseline; a failing check stops the ship there.
- **push** runs only with `--push`, taking no approval, since ship is
  owner-only and this is the owner's own act at the exact revision being
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
cut after redaction: the owner's Atelier token, any Artifacts token in the
checkout's Git settings, and the value of every environment variable whose
name says it holds a token, a key, a secret, a password or a credential are
replaced with `[redacted]`, as `atelier check` redacts check output.

The project page lists the approvals with their status and the latest steps
run; `GET /api/projects/P/actions` returns both.

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
- It does not put a reminder in the inbox when a merged revision has a
  protected action declared and not yet run.
- It does not protect the ship files themselves. `docs/atelier/ship.json`
  and the scripts its commands run are code the owner runs with the owner's
  environment; protect them with `atelier init --protect docs/atelier/**`,
  and protect the scripts the same way, so a change to them needs an
  independent review.
