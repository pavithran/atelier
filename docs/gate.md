# The task lifecycle and the gate

This is the full reference for how a task moves from creation to merge, what
the gate requires before the project owner may accept it, which checks are
allowed, and which checks apply to a change. The README's "Concepts" section
gives the outline.

## How it works

In outline: a project's main branch is copied into an Artifacts repository,
the *baseline*. Each item is a fork of the baseline, its *workspace*. Agents
work in their workspace, push to it, and run checks against it. The project owner merges
accepted work into the real checkout, and the baseline follows.

In detail:

| Step | Who | What happens |
| --- | --- | --- |
| `atelier init [--title TEXT]` | the project owner, in the project checkout | Creates the baseline repository and pushes the current branch to it. Records that branch as the project's branch, the required checks and the protected paths, and an optional display title. Every check must be read-only (see [Check classes](#check-classes)). |
| `atelier new "title" --scope 'src/**'` | the project owner | Creates an item with a short title (at most 80 characters). The scope is what the item intends to touch; overlapping live scopes are flagged in the inbox. `--brief` holds the whole task and `--accept` its acceptance criteria, which the review brief numbers and a reviewer blocks on. `--non-goal`, `--stop-when` and `--next-gate` frame it, and `atelier edit` changes all of these later; the brief, `atelier start` and the item's page show them. |
| `atelier block t3 "reason"` | the item's owner or the project owner | Blocks the item with what it is waiting on. It keeps its owner and workspace, leaves the runner queue and stuck detection, cannot be pushed or submitted, and sits in the inbox with the reason until `atelier unblock t3` returns it to the state it was in. |
| `atelier claim t3 --as claude-code/opus-5.5` | an agent | The project's Durable Object grants ownership atomically, so a second claimant is refused. The Worker forks the baseline and mints an eight-hour write token for the owner alone. The CLI clones the workspace into `~/Library/Caches/ai-projects/cloudflare-git/work/` and records the project's branch as the one it pushes to; a later claim records it again and says when it changed. A claim that reuses a workspace the fork's branch has moved past, as when a task handed off comes back, fast-forwards it to what the fork holds, or stops and names the commits to integrate when the two have diverged. |
| `atelier push` | the item's owner | Runs only in the item's claimed workspace, as `update` and `finish` do: anywhere else, the owner's checkout included, it stops before git is asked to push and says where to run it. Refuses, pushing nothing, when the workspace's branch is not the one its fork's HEAD names, since Atelier reads only that one. Otherwise pushes, then asks the Worker to read the workspace head from Artifacts. The ledger records the head Atelier saw, not the one the agent named, and refuses a head that no longer holds the one it recorded, unless `atelier push --force` declares the rebase `atelier update` made; that push leases against the recorded head and first checks, by patch, that every recorded commit survives. A fork whose history runs deeper than the Worker reads to tell is refused as unverified, not taken for a rewrite. |
| `atelier update` | the item's owner | Rebases the workspace onto the baseline's current head. The fork's own branch comes first: commits another holder pushed there and this workspace lacks are taken before its own commits move, so the `push --force` that follows keeps them. |
| `atelier check` | the item's owner; anyone with `--sandbox` | Clones the workspace afresh at that head (or runs in a Cloudflare container with `--sandbox` or `sandboxOnly` policy), runs each required check, and records the results as Observed. A result run on the caller's machine is recorded only for the item's owner, since the gate counts it on the caller's word; anyone the project's tokens reach may ask for a sandbox run, which records its own results. With each result Atelier records every path on which the workspace's head differs from main's head, which it measures itself from Artifacts; a list the caller sends is ignored. A result for a head that has since moved is refused. A local check runs with the caller's file access; run untrusted code with `--sandbox`. `--merged` runs the checks on the would-be merge instead: the head merged with main as main is now, in a temporary merge commit made in the clean clone and never pushed, or built by the Worker with `--sandbox`. A check that does not apply to the change is not run merged either. The result is recorded against both revisions, shown beside the merge preview on the item page, and marked stale when main moves on; it is never the head's own check. |
| `atelier report [ID] "…"` | anyone | Records a Reported claim on the item named, else on the workspace's item; in a workspace, another item's id needs `--item ID`. It is shown and never counted. |
| `atelier submit` | the item's owner | Marks the item ready. The gate states what still blocks it. |
| `atelier handoff t3 --to codex/gpt-5.5` | the item's owner or the project owner | Moves ownership and revokes the old write token. The workspace and its history carry over; the work is not forked again. |
| `atelier review t3 --approve --criteria BINDING` | an agent that did not work on the item | Required when the item changes a protected path. Only a model of another family than every recorded contributor counts. The project owner may review too, and the owner's rejection blocks, but the owner's approval is not this review. A review names the binding of the acceptance criteria it judged (`atelier show` prints it; a review claim gives it), and counts only while the item's head and criteria are still the ones it judged; changing the criteria withdraws it for good. |
| `atelier accept t3` | the project owner, or the Accept button | Allowed only when the gate is clear. Pins the accepted head. With `--override-review "reason"`, overrides a missing independent review when no reviewer qualifies (see below). |
| `atelier merge t3` | the project owner, in the project checkout | Fetches exactly the accepted head, merges it with `--no-ff`, attaches the item's provenance as a git note on `refs/notes/atelier`, and pushes the new main to the baseline. Pushing the code to GitHub stays a separate, deliberate step; after `atelier notes-remote github`, each merge pushes the provenance notes, and only them, to that remote. |

The gate for acceptance is a pure function in [`src/rules.ts`](../src/rules.ts):
every required check that applies to the change observed passing at the
current head (see [Checks that apply to some paths](#checks-that-apply-to-some-paths));
the changed paths observed; no required check failing on the merge with a main
that moved after the head's own checks passed, until a merged run passes or the
head moves (see the merge preview below);
no rejection at that head; and, if a protected path changed, an
approval at that head from a model of another family than every recorded
contributor's, or the project owner's override of that review. A model's
family is read from its name ([`src/models/pool.ts`](../src/models/pool.ts)), and
a family no name pattern recognises never qualifies, whether it is the
reviewer's or a contributor's. This holds in every project, with or without
ControlPlane policy files. Models are compared without letter case or a
`:profile` suffix, and a name the model registry
([`src/models/registry.ts`](../src/models/registry.ts)) lists for a model, such as
`claude-opus-5-5` for `opus-5.5`, is that model. What a check executes is protected automatically: a script it runs (`./check.sh`,
`bin/check`, `node scripts/verify.mjs`); the recipe files `make` and `just`
run (`Makefile`, `makefile`, `GNUmakefile` and every `*.mk`; `justfile`,
`Justfile`, `.justfile` and every `*.just`; or the file and directory the
command's `-f` and `-C` options name); the manifest a package manager runs
scripts from, whose scripts an item could otherwise rewrite, with the
configuration that changes what it runs (`package.json` with `.npmrc` for
npm, `.pnpmfile.cjs` for pnpm, `.yarnrc.yml` and `.yarn/releases/**` for
yarn, `bunfig.toml` for bun); the manifests build tools run code from
(`Cargo.toml` and `build.rs` for cargo, `Package.swift` for swift, the
project and workspace for xcodebuild, `deno.json` for `deno task`); and the
local binary `npx`, `bunx`, `pnpm dlx` or `yarn exec` would run, under
`node_modules/.bin/`. A runner's name counts wherever it stands in the
check's line: behind `env`, `time`, `timeout`, `sudo`, `nice`, `cross-env`
or `xvfb-run`, inside a shell's `-c` string, after `if` or `!`, or on a
later line; and a manager given `--prefix`, `-C`, `--dir` or `--cwd` reads
its files under that directory too. An item therefore
cannot quietly weaken the check that grades it. Files a check only reads, such
as the code under test, are not protected, and nor is test configuration such
as `vitest.config.ts` unless the project protects it. Protected paths match
whatever the letter case or Unicode form, because the owner's Mac stores
`claude.md` and `CLAUDE.md`, or `AGENTſ.md` (with a long s) and `AGENTS.md`, as
one file; item scopes and `direct.allowed_path_patterns` match as written, so a
variant falls outside them. `atelier merge` refuses, before it changes the
checkout, a merge whose tree would hold two such paths, on any platform.

The ship files and what they run are protected the same way: `docs/atelier/**`
in every project, and every file the ship order's commands execute, derived
from the commands `atelier init` and `atelier sync` record from
`docs/atelier/ship.json` or the ControlPlane adapter exactly as a check's
files are derived from its line. An item therefore cannot quietly change what
the owner's `atelier ship` runs with the owner's environment; see
[docs/ship.md](ship.md).

A merge lands agent code in the owner's checkout, where Git's own
configuration can run files from the tree: a hooks folder that
`core.hooksPath` names, a filter, merge driver or textconv script, a hook
defined in configuration, or a configuration file the checkout includes.
`atelier merge` lists those paths from the checkout's configuration and
refuses, before it changes the checkout, an accepted change that touches one,
naming each; the owner reviews those files and lands the change by hand. It
also refuses a symlink where the landing reads or writes its ControlPlane
files (the policy files, the receipt template, the receipts folder), which
would take the read or the write outside the checkout. Every Git command of
`merge`, `merge --cancel` and `sync` runs with hooks off:
`core.hooksPath=/dev/null` for a hooks folder, and `hook.NAME.enabled=false`
for each hook defined in configuration, which Git 2.54 still runs under
`core.hooksPath=/dev/null` alone.

The changed paths are measured against main as it is now: every path whose
content at the item's head differs from main's head. That is the set a merge
could change on main whatever base git picks, since git keeps a path both
sides agree on, and no history an agent pushes can shrink it; a merge commit
that makes an older main commit the fork point hides nothing. A workspace
behind main lists main's newer changes too, until `atelier update` brings them
in. The item page's diff is measured the same way. The merge preview beneath
it works from the fork's own first-parent history, says how far main has moved
and whether the item would merge, and is advisory.

Beside the preview stand the checks run on that merge. `atelier check
--merged` makes a temporary merge commit of the head with main's head in the
clean clone, runs the required checks there and records each result bound to
both revisions; `--merged --sandbox` has the Worker build the merged tree, as
the preview reads the merge, and run the checks in a Cloudflare container. A
merge the preview finds conflicts in has no tree to check, and the command
says so. Each result names the main head it merged with; the page marks it
stale once main moves past that commit, and a new head retires it. A merged
check is shown, not required, with one exception: when main moved after the
head's own checks passed and the merged checks fail, the failure blocks
acceptance until a later merged run passes or the head moves. Running the
head's own checks again does not clear it, since they pass on the head's tree
and say nothing about the merge. Every observed
check also records main's head as Atelier read it when the check was
recorded, which is how the gate knows main moved.

The project owner's approval is never the independent review: the owner
decides by accepting, and that decision is not also the second opinion. When
no reviewer qualifies, because no model of another family is available or a
contributor's family is not recognised, the owner can accept with
`atelier accept t3 --override-review "reason"`, with
`atelier merge t3 --head SHA --override-review "reason"`, or with "Accept
without an independent review" on the task's page. The reason is required.
The override is recorded as an event of its own, `review.overridden`, never as
a review. It counts only at the head it names, so a later push needs a review
or another override, and it waives that review and nothing else: a failing
check or a rejection still refuses acceptance. Atelier refuses an override
where no review is missing. The task page, the inbox and the decision brief
show it with its reason, and the landing receipt records it. The merge's
provenance note, which can be pushed to a public remote, names the override and
who made it but not its reason; it names each review's reviewer, verdict, head
and recorder in the same way, without the review's note. Both stay in the
ledger.

## The review bar

Every review brief states the review bar, which says what a finding may block
for. When the project sets none, the brief states the default bar, which blocks
only for a correctness, security or data-loss defect that the change
introduces, or fails to fix while claiming to; a behaviour change without a
test that covers it; docs or help that now contradict the code; a breaking
change to a command, route or API field without a migration; or a visible
regression on a user-facing page. A blocking finding names the file and line
and what breaks, and is never style or naming; anything else is a follow-up
and never holds the change back.

A project sets its own bar with `atelier init --review-bar TEXT`, which records
it in the project's policy (`policy.reviewBar` in `src/rules.ts`); every review
brief then states that bar in place of the default. `atelier init --review-bar
""` clears it and restores the default, and an init that does not name the bar
leaves the recorded one as it is.

## Check classes

Atelier runs a check in a clean clone of an item's head whenever anyone asks,
on an agent's machine or in a Cloudflare container, so a check must be
read-only: it reads the project and writes only in its clone, the caller's
caches and temporary files. A command that deploys, installs onto a device or
the machine, publishes, pushes, reaches another machine or spends money is
never read-only. `atelier init` refuses to register it, whatever is declared,
and the sandbox route, the container runner, `atelier check`, `wrap` and the
evidence route refuse to run or count it. The list, in
[`src/checks.ts`](../src/checks.ts), covers `wrangler deploy` and `publish`
(and other Cloudflare writes), `npm publish` and package scripts named for a
deploy or release (`npm run deploy`, `db:push`), `git push`, `xcrun altool`
and `notarytool`, `fastlane`, `devicectl install` and other device installs,
`ssh`, `scp` and remote `rsync`, `curl` or `wget` with a write method or a
body, global package installs, `brew install`, `launchctl load`, the GitHub
CLI's writes, cloud and cluster deploys, paid model CLIs such as `claude`
and `codex`, and `atelier` itself. A `--dry-run` of a deploy or publish is
allowed. Atelier reads the command as a shell would: each command joined by
`&&`, `|` or `;`, inside `$( )`, `sh -c '…'`, `trap '…'` or `eval`, and
behind `env`, `timeout`, `xargs`, `npx` or `sudo`, is classed.

A check is read-only in one of three ways, recorded with the project:

- its command is a known build or test form, such as `npm ci && npm test`,
  `npm run typecheck`, `xcodebuild build-for-testing …`, `swift test`,
  `python3 -m unittest …` or `git diff --exit-code`;
- the project's ControlPlane adapter lists the same command, word for word,
  as a capability of class `local-read-only` or `local-write` (a build's
  writes stay in the clone); a capability of any other class (`deploy`,
  `device`, `network` and the rest) is refused;
- the project owner declares it, with the reason, as init records its
  approval: `atelier init --check "./check.sh" --declare-read-only "PAVI,
  2026-10-06: check.sh runs the unit tests and builds nothing it ships"`.
  Without `--check`, `--declare-read-only` declares the registered checks
  that are still undeclared.

An init that names its checks with `--check` must show each one read-only,
or it is refused before anything is created. A check registered before
checks had classes carries none: Atelier treats it as read-only when its
command is a known form and as undeclared otherwise. An undeclared check
still runs, so a project's existing checks keep working, and the next init
that names it must declare it. Each check's class, and how it is known, is
shown in init's summary, under "Checks" in `atelier status --project NAME`
and the standing JSON, and in the project page's policy.

The class is of the command as registered. What a script it runs does is
the item's code: an item could rewrite `package.json`'s `test` script, which
is why the files a check executes are protected (see How it works, above) and why
untrusted code belongs in the sandbox, which has no credentials and reaches
only the npm registry.

## Checks that apply to some paths

A required check may apply only when an item changes a path its globs match,
as ControlPlane's `change_rules` said which checks a change needs. The gate
requires such a check exactly when one of the item's changed paths, measured
by the Worker against main's head, matches its globs, whatever the letter
case or Unicode form, so a variant spelling of a path still needs the check.
Otherwise the check is not applicable: the task page lists it as such, the
decision brief counts it, and it never blocks. Until the changed paths are
measured, a check with globs may apply, so it waits like any other.

`atelier check` measures the changed paths in its clean clone against
main's head and does not run a check whose globs none of them match. It
records the check as not applicable instead, and the Worker accepts that
record only when the paths it measures itself from Artifacts show the same;
otherwise it refuses, saying which changed path the check applies to, and
the check must be run. The record carries no result and measures the
changed paths, so a change that no check applies to can still be accepted.
A check run in a Cloudflare container is handled the same way, and when no
check applies no container is started. A command given after
`atelier check --` always runs.

`atelier init` takes the globs from a ControlPlane project's
`project-adapter.v1.json`. A change rule requires capabilities when a
changed path matches its patterns. A registered check runs a capability when
every command the capability runs is one of the check's, word for word, so
`npm ci && npm run check && npm test` runs the capabilities `npm run check`
and `npm test`. Such a check applies where any rule requiring a capability
it runs applies; a check that runs none applies to every change. ControlPlane
matched patterns as Python's `fnmatch` does, where `*` crosses directories,
so each `*` is recorded as `**`. Init's summary prints each check's globs
and names any capability a rule requires that no registered check runs, and
`atelier status --project NAME` and the project page show the globs. An
adapter without change rules leaves every check applying to every change.
A re-init that names no check takes none of the rules (PAVI's decision of
2026-10-06): conditioning a check to some paths can drop coverage outright,
since a change to none of the checks' paths then runs no check (on that day
Omniscope's rules would have left a change to `family/**` or `package.json`
running no check). Such an init keeps the paths recorded for the checks and
names each narrowing the rules would make; the first init, and any init that
names the checks with `--check` or starts over with `--reset`, takes the
rules as the adapter holds them.
