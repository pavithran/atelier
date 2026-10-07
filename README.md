# Atelier

Atelier lets several coding agents work on one project at the same time
without trampling each other or the person who owns the project. It runs on
Cloudflare Workers, Durable Objects and Artifacts, and is driven by a
dependency-free command, `atelier`, that any agent able to run a shell
command can use.

It rests on three rules.

1. **Every item of work has exactly one owner.** Ownership moves by a
   recorded handoff. The owner holds the only write token for the item's
   workspace, and a handoff revokes it.
2. **Evidence is graded.** A check that Atelier ran itself, in a clean clone
   of exactly the head it reads from Artifacts, is *Observed*. Anything an
   agent says it did is *Reported*. A required check with no observed result
   at the current head is *Pending*. Only Observed passes count.
3. **The project owner decides.** The project owner is the person the
   project belongs to; in the API they act as a reserved actor, `owner`
   unless the deployment names another (see Setup).
   Work reaches the project only when the project owner accepts it and
   merges it. Changes to protected paths also need approval from a model
   of another family than every recorded contributor's. The project owner's
   approval is not that review; without one, the owner can accept only by
   recording an override with its reason.

The web inbox answers one question, *what needs the project owner now?*, and ranks the
things a person must decide above the things an agent must fix.

## Sessions

Start with `atelier unwrap [--project NAME]`. It reads the project standing,
checkout, newest session note, state file and dated handoffs without writing.
State and handoff excerpts show at most 80 lines and name where to read more.

End in the registered checkout with `atelier wrap "summary" --next "what is next"`.
The words after `wrap` that no flag has taken are joined into one summary, quoted
or not. Give the summary first: a flag takes the word after it as its value.
It runs the registered checks, warns about an unchanged state file and records a
`session.wrapped` ledger event. Results are Reported because they ran in the
owner's checkout. A failing check refuses the commit: wrap names each failed
check with how it ended (its exit status, the signal that ended it, or a
timeout), stages nothing, records no note and pushes nothing, so the checkout
is as the checks left it. `--allow-failing` commits anyway, and the note
records which checks it let through beside their Reported results. `--no-check`
skips the registered checks and the note records the skip; it is not combined
with `--allow-failing`, since a skipped check cannot fail. Wrap commits
everything selected by `git add -A`, with the summary as its subject, next text
as its body and an `Atelier-Session`
trailer naming the note's session time. It runs `git diff --cached --check` after
staging, so whitespace errors are checked in what the commit holds, staged
changes and new files included. A clean checkout still gets a note. Wrap refuses
before staging on a detached HEAD, on a merge, cherry-pick, revert, rebase or
landing in progress, on unmerged files in the index (a squash merge or a stash
pop leaves them with nothing else to show), and on a branch other than the
registered branch. Only the project owner records a session: the server
refuses one from any other actor or any agent token.

Wrap then updates the Atelier baseline through `sync` for fresh history or
`publish` for full history. `--push` also pushes the checkout branch to every
configured checkout remote, without force, continuing after a remote fails.
These are the owner's own remotes, so each is a normal push that uploads the
project's Git LFS objects; only pushes to Atelier skip the upload, because
Artifacts holds pointer files. Without `--push`, checkout remotes are not
pushed. Wrap never deploys or publishes a release. The note records the commit
and each remote result. A remote that fails is named in the relay line, and
wrap exits 1 once the note and the baseline are recorded.

When `docs/control-plane/context-budget.v1.json` is committed at HEAD, wrap
counts lines in its named surfaces. Any absolute ceiling exceeded refuses the
commit, even with an advisory policy. Move history into `docs/history/` rather
than raising the ceiling. Wrap reads the policy as committed at HEAD, never the
working tree's copy, so editing or deleting it in the same session does not lift
a ceiling; when the copy differs, wrap says so and applies HEAD's. A policy not
yet committed applies from the session after it is. Baseline drift is advisory.
No policy at HEAD means no ceiling.

Before closing, file defects in Atelier or project tooling as tasks in the
project they belong to with `atelier new "…" --project NAME`. Atelier defects
belong to `--project atelier`. File a lesson worth keeping the same way
with a title starting `Lesson: `. Repeatable `--found TEXT` files tasks in the
current project and records their IDs in the note.

Session notes hold metadata only, never prompts, transcripts, file contents or
check output. Summary, next text and check names are cleaned and capped at
2000 characters each. Remote names are capped at 200 characters; checks,
remote results and filed task IDs are limited to 100 each.
`GET /api/projects/NAME/sessions` reads the newest five notes;
`POST /api/projects/NAME/sessions` records one, for the project owner only.

## For agents

Use two commands for a task:

```sh
atelier start ID --as harness/model
# Work in the printed workspace and commit the changes.
atelier done "What changed and why"
```

`start` claims the task, prepares the same workspace as `claim`, and prints
its title, scope and any dispatch note. Pass `--project NAME` when running
outside a registered checkout. `done` runs inside the task workspace. It
pushes, runs the required checks and submits the summary only after checks
pass and the revision remains unchanged. It stops at the first failed step
and names that step. Its final line says `Ready for the owner` or gives the
gate's remaining blockers. The owner still decides whether to accept and merge.

`atelier inbox` and `atelier show ID` print owner decision briefs with the
recorded evidence, recommendation and task URL. An agent can relay that text
unchanged. Both accept `--json` for scripts. The single-task read API is
`GET /api/projects/NAME/items/ID/brief` and requires sign-in.

The individual commands remain available as reference below.

## How it works

In outline: a project's main branch is copied into an Artifacts repository,
the *baseline*. Each item is a fork of the baseline, its *workspace*. Agents
work in their workspace, push to it, and run checks against it. The project owner merges
accepted work into the real checkout, and the baseline follows.

In detail:

| Step | Who | What happens |
| --- | --- | --- |
| `atelier init [--title TEXT]` | the project owner, in the project checkout | Creates the baseline repository and pushes the current branch to it. Records that branch as the project's branch, the required checks and the protected paths, and an optional display title. Every check must be read-only (see [Check classes](#check-classes)). |
| `atelier new "title" --scope 'src/**'` | the project owner | Creates an item. The scope is what the item intends to touch; overlapping live scopes are flagged in the inbox. `--non-goal`, `--stop-when` and `--next-gate` frame it, and `atelier edit` changes that framing later; the brief, `atelier start` and the item's page show it. |
| `atelier block t3 "reason"` | the item's owner or the project owner | Blocks the item with what it is waiting on. It keeps its owner and workspace, leaves the runner queue and stuck detection, cannot be pushed or submitted, and sits in the inbox with the reason until `atelier unblock t3` returns it to the state it was in. |
| `atelier claim t3 --as claude-code/opus-5.5` | an agent | The project's Durable Object grants ownership atomically, so a second claimant is refused. The Worker forks the baseline and mints an eight-hour write token for the owner alone. The CLI clones the workspace into `~/Library/Caches/ai-projects/cloudflare-git/work/` and records the project's branch as the one it pushes to; a later claim records it again and says when it changed. A claim that reuses a workspace the fork's branch has moved past, as when a task handed off comes back, fast-forwards it to what the fork holds, or stops and names the commits to integrate when the two have diverged. |
| `atelier push` | the item's owner | Runs only in the item's claimed workspace, as `update` and `finish` do: anywhere else, the owner's checkout included, it stops before git is asked to push and says where to run it. Refuses, pushing nothing, when the workspace's branch is not the one its fork's HEAD names, since Atelier reads only that one. Otherwise pushes, then asks the Worker to read the workspace head from Artifacts. The ledger records the head Atelier saw, not the one the agent named, and refuses a head that no longer holds the one it recorded, unless `atelier push --force` declares the rebase `atelier update` made; that push leases against the recorded head and first checks, by patch, that every recorded commit survives. A fork whose history runs deeper than the Worker reads to tell is refused as unverified, not taken for a rewrite. |
| `atelier update` | the item's owner | Rebases the workspace onto the baseline's current head. The fork's own branch comes first: commits another holder pushed there and this workspace lacks are taken before its own commits move, so the `push --force` that follows keeps them. |
| `atelier check` | the item's owner; anyone with `--sandbox` | Clones the workspace afresh at that head (or runs in a Cloudflare container with `--sandbox` or `sandboxOnly` policy), runs each required check, and records the results as Observed. A result run on the caller's machine is recorded only for the item's owner, since the gate counts it on the caller's word; anyone the project's tokens reach may ask for a sandbox run, which records its own results. With each result Atelier records every path on which the workspace's head differs from main's head, which it measures itself from Artifacts; a list the caller sends is ignored. A result for a head that has since moved is refused. A local check runs with the caller's file access; run untrusted code with `--sandbox`. `--merged` runs the checks on the would-be merge instead: the head merged with main as main is now, in a temporary merge commit made in the clean clone and never pushed, or built by the Worker with `--sandbox`. A check that does not apply to the change is not run merged either. The result is recorded against both revisions, shown beside the merge preview on the item page, and marked stale when main moves on; it is never the head's own check. |
| `atelier report [ID] "…"` | anyone | Records a Reported claim on the item named, else on the workspace's item; in a workspace, another item's id needs `--item ID`. It is shown and never counted. |
| `atelier submit` | the item's owner | Marks the item ready. The gate states what still blocks it. |
| `atelier handoff t3 --to codex/gpt-5.5` | the item's owner or the project owner | Moves ownership and revokes the old write token. The workspace and its history carry over; the work is not forked again. |
| `atelier review t3 --approve` | an agent that did not work on the item | Required when the item changes a protected path. Only a model of another family than every recorded contributor counts. The project owner may review too, and the owner's rejection blocks, but the owner's approval is not this review. |
| `atelier accept t3` | the project owner, or the Accept button | Allowed only when the gate is clear. Pins the accepted head. With `--override-review "reason"`, overrides a missing independent review when no reviewer qualifies (see below). |
| `atelier merge t3` | the project owner, in the project checkout | Fetches exactly the accepted head, merges it with `--no-ff`, attaches the item's provenance as a git note on `refs/notes/atelier`, and pushes the new main to the baseline. Pushing the code to GitHub stays a separate, deliberate step; after `atelier notes-remote github`, each merge pushes the provenance notes, and only them, to that remote. |

The gate for acceptance is a pure function in [`src/rules.ts`](src/rules.ts):
every required check that applies to the change observed passing at the
current head (see [Checks that apply to some paths](#checks-that-apply-to-some-paths));
the changed paths observed; no required check failing on the merge with a main
that moved after the head's own checks passed, until a merged run passes or the
head moves (see the merge preview below);
no rejection at that head; and, if a protected path changed, an
approval at that head from a model of another family than every recorded
contributor's, or the project owner's override of that review. A model's
family is read from its name ([`src/models/pool.ts`](src/models/pool.ts)), and
a family no name pattern recognises never qualifies, whether it is the
reviewer's or a contributor's. This holds in every project, with or without
ControlPlane policy files. Models are compared without letter case or a
`:profile` suffix, and a name the model registry
([`src/models/registry.ts`](src/models/registry.ts)) lists for a model, such as
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
[Ship and protected actions](#ship-and-protected-actions).

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

## Projects governed by ControlPlane

Atelier and ControlPlane each own different facts. ControlPlane owns policy:
who may act and what is protected. Atelier owns live state: who holds which
item now, the evidence at its head and its handoff chain. Git owns what
merged.

- `atelier init` reads `docs/control-plane/agent-policy.v1.json`,
  `execution-policy.v1.json` and `project-adapter.v1.json` when they exist.
  `sync` refreshes the policy from those files too. Overlapping claims are
  refused when the policy says `overlapping_claims: refuse`. Protected paths
  include execution policy patterns, adapter surfaces, maintenance paths,
  agent instructions, ControlPlane files and the files that run checks.
  The adapter's capability classes declare checks read-only (see
  [Check classes](#check-classes)), and its `change_rules` set the paths
  each check applies to (see
  [Checks that apply to some paths](#checks-that-apply-to-some-paths)); init
  sets both, and `sync` and `merge` leave them as init set them.
  Atelier never writes these policy files.
- `claude-code/*` maps to `claude`, `codex/*` to `codex`, and `zcode/*`
  and `opencode/glm*` to `glm`. `antigravity/*` maps to `antigravity` for a
  Gemini model; Antigravity also serves other vendors' models, which map by
  their own family. Other actors map by model family name,
  such as `claude`, `gpt`, `gemini` or `qwen`, when that name is listed in
  the agent policy. An unmapped actor has no role. Claiming or receiving a
  handoff requires an available agent with `executor` in `eligible_roles`.
  Agent reviews count toward the gate only when the agent is available with
  `assessor`. The project owner's rejection always counts; the owner's
  approval is never the required review.
  `preferred_roles` records a preference and does not grant a role. The
  other roles do not grant execution or review authority.
- Changed paths determine the class. Any protected path makes the change
  `protected`. Otherwise it is `direct` only when direct execution is enabled
  and every changed path matches `direct.allowed_path_patterns`; all other
  changes are `coordinated`. A class absent from `allowed_classes` is refused.
  Protected changes need approval from a model family different from every
  recorded contributor, as in every project; coordinated changes need
  approval from an agent who did not contribute; direct changes need no
  review. Required reviews must come from assessors. The project owner's
  approval is neither review; where no reviewer qualifies, the owner's
  override stands in for it, as described above. Project owner acceptance is
  always required. A measured empty change has nothing to merge.
  Projects without these policy files have no change classes: a protected
  change needs its review from another family, and any other change needs
  none.
- `atelier sync` and normal `atelier merge` re-read these files and refresh
  the stored protected paths, eligible agents and overlap rule. The refresh
  preserves paths recorded locally by `init --protect`. Approval, checks and
  other project settings are kept. For a baseline with full history, `sync`
  only refreshes this policy. A malformed or empty policy file makes `sync`
  warn and skip the refresh, and stops `init` and `merge` until it is fixed:
  a merge never skips the comparison below.
- Acceptance records the project's protected paths, eligible agents, overlap
  rule and required checks on the server. Every merge attempt compares the
  policy as it is now with that snapshot and warns of any difference. It
  refuses, until the task is accepted again or `--policy-changed-ok` is
  passed after reviewing the change, when the accepted revision touches a
  newly protected path, a contributor is no longer eligible, a check required
  now was not observed passing at the accepted revision, or overlapping
  claims are now refused and the task's scope overlaps a live one. The paths
  compared are the accepted revision's own: those since the newest baseline
  commit it holds, so a workspace brought up to date with `atelier update`
  is not charged with the baseline's changes. An acceptance made before the
  snapshot recorded every field is compared on the protected paths it
  recorded (none, for the oldest) and on the other fields as the server held
  them before the refresh. The task page offers the re-acceptance, which
  checks the current gate and records a new snapshot; so does
  `atelier accept ID`. `merge --cancel` does not read or refresh ControlPlane
  policy.
- Copying a project into Artifacts is an off-machine copy, so `init` refuses
  a ControlPlane project until the project owner's approval is recorded with
  `--approval "…"`. The approval is kept in the project's policy and quoted in
  every merge receipt. Once recorded it stands: a later `init` that changes
  the checks, the title or the policy keeps it, and it is asked for again
  only when `--reset` starts the policy over or `--history-since` replaces
  the baseline.
- `atelier merge` writes a `control-plane.landing-receipt` into
  `docs/control-plane/landing-receipts/` as part of the merge commit, so the
  merge and its record are one change.
- `atelier owners` prints one line per live item for a wrap to copy into the
  project's state record; `atelier owners --json` and
  `GET /api/projects/NAME/owners` give the same view without titles, scopes
  or paths. Publishing it to Observatory is ControlPlane's to do, because
  Observatory reads only what ControlPlane publishes.

## Moving a project from ControlPlane

A project moves to Atelier one at a time, and the move is itself an Atelier
task, reviewed by a model from another family and accepted by the project
owner. `atelier adopt` runs in the project's registered checkout:

```sh
atelier adopt --project NAME --as HARNESS/MODEL
```

It refuses unless the project is registered in Atelier and the checkout is
clean. Every check that can refuse the move runs before the task is created,
so a refusal leaves nothing behind — no task, no claim: the checkout's files
are readable, the AGENTS.md edit is computable, it stays under the ceiling
the project's `docs/control-plane/context-budget.v1.json` sets (the one
`atelier wrap` refuses to commit over; the refusal says how many lines over
and which file), no symbolic link stands where the move writes, and the
agent is one the project's policy admits (the same rule a claim applies). The
move writes into the task's workspace and nothing
outside it: a file it writes that is a symlink is replaced with a regular
file, never written through, and a symlinked directory above one refuses the
move (an AGENTS.md that is a symlink is refused too, because the section is
built from its text). It creates the task "Move NAME from ControlPlane to
Atelier", claims it as `--as` (without it, as the current actor), and in the
task's workspace it writes `bin/control-plane`, replaces
`bin/control-plane-paste`, when the project has one, with a script that says
no command renders a paste any more, that the agent writes the relay
envelope itself as the relay rule says (one fenced block with a language
tag, a copy saved under `~/Documents/ai-project-data/<project>/`) and that
`atelier handoff` transfers ownership and is not a relay, and exits 2; and
it inserts the text `atelier guide` prints
into `AGENTS.md`: right after its first heading, at the top when the file has
no heading, and in place of the section it already carries, so adopting a
project again cannot stack a second one. It commits those changes in the
workspace and does not push them; the agent finishing the task pushes, checks
and submits as usual.

The new `bin/control-plane` is a POSIX sh script that knows the project's
Atelier name. It prints the Atelier command it runs to stderr, runs it, and
never contacts ControlPlane's central checkout:

| ControlPlane | Atelier |
| --- | --- |
| `pickup-card`, `unwrap` (no arguments) | `atelier unwrap --project NAME` |
| `wrap`, `session-receipt` | `atelier wrap`, with the arguments passed on |
| `report TEXT` | `atelier new TEXT --project NAME`, so a report becomes a task |
| `audit`, `context-budget`, `ship-check`, `observe`, `observatory-bundle`, `observatory-run`, `backup-status`, `validate-backup` | `atelier ops COMMAND [ARGUMENTS]` |
| `help`, or no command | a short text saying the project works through Atelier, and this list of mappings |
| anything else | a line saying the command moved into Atelier, naming `atelier help` and `atelier ops help`, and exit 2 |

Adopt then reads the checkout, without changing it, and prints the leftovers
the agent finishing the task must settle: a
`docs/control-plane/work-item.v1.json` whose state is `active`,
`completed-unreconciled` or `blocked`, with its plan id, state and owner; a
capability in `docs/control-plane/project-adapter.v1.json` whose command names
a file the project does not have — the command is read as shell words, so a
quoted path with spaces stays one word; a script run through an
interpreter or `env` (`python3 tools/ship.py`, `bash bin/sweep.sh`) is judged
by the script, not the interpreter; each command in a chain or a pipeline
(`&&`, `||`, `|`, `;`) is judged on its own program, a shell's `-c` command
line the same way, and a glob, a redirection or any argument after the
program is never judged; a vendored `tools/control-plane/`
directory; and each line in `AGENTS.md`, `CLAUDE.md` and `GLM.md` that still
names `pickup-card`, `control-plane-paste`, `session-receipt` or
`audit record`, with its file and line number. The same list is recorded on
the task as reported notes, so the reviewer and the owner see it there.

## Check classes

Atelier runs a check in a clean clone of an item's head whenever anyone asks,
on an agent's machine or in a Cloudflare container, so a check must be
read-only: it reads the project and writes only in its clone, the caller's
caches and temporary files. A command that deploys, installs onto a device or
the machine, publishes, pushes, reaches another machine or spends money is
never read-only. `atelier init` refuses to register it, whatever is declared,
and the sandbox route, the container runner, `atelier check`, `wrap` and the
evidence route refuse to run or count it. The list, in
[`src/checks.ts`](src/checks.ts), covers `wrangler deploy` and `publish`
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
is why the files a check executes are protected (see How it works) and why
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

## What is enforced and what is trusted

Enforced by construction:

- one owner per item, because the project's Durable Object handles one
  request at a time;
- one live write token per workspace, minted for the owner and revoked on
  handoff, release or abandonment;
- observed evidence tied to the head Atelier reads from Artifacts, not the
  head an agent reports;
- acceptance only through the gate, and merging only of the accepted head.

Trusted, and stated here so nobody assumes otherwise:

- **Agent tokens prove identity.** An agent token binds requests to one actor
  and optionally to projects. The owner token still permits declared actors
  for orchestration. Keep it with the owner's tools. A workspace write token
  controls Git pushes and is separate from an API token.
- **Git credentials stay off the command line.** The CLI hands every
  Artifacts token to git through git's environment (`GIT_CONFIG_COUNT`,
  `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`), never as an argument, because
  any local user can read a process's arguments with `ps`. A workspace keeps
  its write token in `.git/atelier-credentials`, readable only by its user
  (mode 0600), which `.git/config` includes; anything running as that user
  can still read it.
- **Check execution is explicit.** Local checks run in a clean clone at
  the verified head, but a caller authorised to record checks, the item's own
  agent included, can forge a local result. It cannot forge what the change
  touches: the changed paths are measured by the Worker from Artifacts for
  every check, so a protected change always needs its independent review,
  whatever a local result says. Cloudflare container checks execute on the
  server and are available with `--sandbox`; `sandboxOnly` policy requires
  that evidence.
  The container integration still needs deployment and a live runtime check.
- **A local check runs with the caller's file access.** `atelier check`,
  `finish` and `done` run the item's check code on the caller's machine as
  the caller, so it can read their files and Keychain and reach the network.
  It is given only the environment variables toolchains need: `PATH`,
  `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TMPDIR`, `CI`,
  `DEVELOPER_DIR`, `TOOLCHAINS`, the Node and OpenSSL certificate settings
  and `npm_config_*`. It never gets `ATELIER_*`, `SSH_AUTH_SOCK` or a
  variable whose name says it holds a token, key, secret, password or
  credential; a check that needs another variable sets it in its own
  command. Before the output is printed or uploaded as evidence, the CLI
  redacts the API token, the read tokens for the fork and the baseline, and
  the workspace's write token. Redaction matches each token exactly as
  written, so a check that prints one encoded, reversed or in pieces is not
  caught. Run untrusted code in the sandbox: `atelier check --sandbox`,
  `atelier finish --sandbox`, or a project registered with
  `atelier init --sandbox-only`.
- **Merging happens locally.** The Artifacts binding and REST API can read
  repositories (commits, trees, blobs, files, a first-parent log) but cannot
  write. The only way to write is a git push with a write token, so Atelier
  merges in git on the owner's machine and pushes. The iCloud checkout is the
  source of truth.

## Setup

Requirements: Node 24 or later, git, a Cloudflare account on the Workers Paid
plan (Artifacts is in open beta there), and `wrangler` logged in.

```bash
npm install && npm run types && npm test
```

Choose a server token and keep it somewhere you can paste it from; a random
one is fine:

```bash
openssl rand -hex 32
```

Deploy, then give the Worker the token as its secret. Wrangler reads it from
the prompt, so it is not written on a command line:

```bash
npx wrangler deploy
```

```bash
npx wrangler secret put ATELIER_TOKEN
```

Then sign in once. `atelier login --server URL` asks for the token (typed
without echo at a terminal, or piped in on stdin), checks it against the
server, and only then stores it and records the server, saying where. The
stored token and the recorded server are a pair: the token is sent to that
server alone, and `ATELIER_SERVER` naming another server needs
`ATELIER_TOKEN` for it. `login --server` sends the named server only a token
already given for it, `ATELIER_TOKEN` when `ATELIER_SERVER` (or else the
recorded server) names it and the stored token when the recorded server is
the one named, and otherwise asks for one; it changes nothing until that
server accepts the token, and when the server changes, the token it accepted,
`ATELIER_TOKEN` included, replaces the stored one, so the pair is never half
rewritten. `atelier login --store` names the store in use and whether it
holds a token, without showing it. The server is an `https://` address:
the token goes with every request, so a plain `http://` server, named by
`login --server`, `ATELIER_SERVER` or `config.json`, is refused before any
request is made, except on this machine (`localhost`, `127.0.0.1` or
`[::1]`), which a request never leaves.

```bash
atelier login --server https://atelier.example.com
```

The token is kept in the first of these that applies:

| System | Store |
| --- | --- |
| macOS | The Keychain, item `atelier.API_TOKEN`, through `security`. |
| Linux | The Secret Service, through `secret-tool` (service `atelier`, account `API_TOKEN`), when it is installed and a session bus is available. |
| Windows, and Linux without those | A file, `secrets.json` in `XDG_CONFIG_HOME/atelier` or `~/.config/atelier` (`%APPDATA%\atelier` on Windows), created with mode 0600. Atelier refuses to read or write it if its mode lets other users read it. |

Windows has no Credential Manager backend: reaching it from PowerShell means
compiling a wrapper with `Add-Type`, which is not tested here, so Windows
uses the file. On Windows the file's mode is not checked, because the system
reports no meaningful mode; the file sits in your own profile. Setting
`ATELIER_SECRET_STORE` to `file`, `keychain` or `secret-service` picks a
store outright. The `ATELIER_TOKEN` environment variable overrides every
store. A value is handed to a store on its standard input and never as a
command line argument, and login prints no token.

Give each agent its own token from an owner session:

```sh
atelier token issue --as codex/gpt-6-astra --project my-project --days 30 --label "Task runner"
atelier token ls
atelier token revoke ID
```

Issuing prints the token once. Set `ATELIER_TOKEN` to that value in the
agent's session. The issue command never writes it to a file. The CLI
obtains the bound actor from the server, so `--as` is optional and must
match when supplied. Tokens expire after 30 days by default; `--days`
accepts 1 through 365. Repeat `--project` to grant several projects; omitting
it grants all projects. Revocation prevents later API requests. Existing
Artifacts Git credentials have their own lifetime and are not revoked by
revoking an API token.

Only the SHA-256 hash and token metadata are stored on the server. Lists
never contain the token or its hash. Agent tokens can read their projects,
claim, push, record checks and reports, submit, hand off, release, and review
as themselves. Handoff targets must be harness/model identities other than
the project owner. Every actor who held an item counts as a contributor for
review independence, even if a Git push was first observed after handoff or
release. Recorded push contributors also remain; a push first observed while
nobody holds the item adds no one, since it was made with an earlier holder's
token. Agent tokens cannot reopen accepted work by reviewing it.
What an agent writes has a stated limit, and text over it is refused whole,
never cut: a review, handoff or release note 2,000 characters, a submit
summary 600, a report or a check's command 500, a check's output 4,000. The
head a push reports must be a commit hash.
Creating tasks, owner decisions, project settings, model
registry access, dispatch configuration and token management require the
owner token. Agent tokens cannot sign in to the browser. Signing in to the
browser with the owner token starts a session: a random id, sent only in the
cookie, whose hash the Worker stores with a thirty day expiry it enforces.
Sign out, in the rail of every page, ends the session at once. The token
itself is never a cookie. Events from agent
requests show `token proved` beside the actor; this proves identity, not the
truth of a reported result.

The project owner acts as the actor `owner`, and the inbox asks "What needs
you now?". To use your own actor and name, set `OWNER_ACTOR` and
`OWNER_NAME`, either as `vars` in `wrangler.jsonc` or as secrets, which keeps
them out of the configuration:

```bash
printf jo | npx wrangler secret put OWNER_ACTOR
```

```bash
printf Jo | npx wrangler secret put OWNER_NAME
```

Pages show times in UTC until `TIMEZONE` names the owner's zone, as an IANA
name; an unknown name falls back to UTC:

```bash
printf America/New_York | npx wrangler secret put TIMEZONE
```

`atelier login` asks the server for the owner's actor, so the CLI follows
whatever the Worker is set to.

Point the CLI at the Worker and register a project:

```bash
npm link
```

```bash
atelier login --server https://atelier.example.workers.dev
```

```bash
atelier init --title "My project" --check "npm test" --protect AGENTS.md --protect "wrangler.*"
```

Run `init` inside the project checkout. `atelier guide` prints the
instructions an agent needs; paste them into the project's `AGENTS.md` or
`CLAUDE.md`.

Running `atelier init` again changes only what it names: `--title` changes the
title, `--check` replaces the required checks, `--protect` replaces the
protected paths (with the defaults), and everything not named keeps its value.
`atelier init --reset` rebuilds the policy from the options given and the
defaults, as a first init does; the project's title and creation date are kept.

`atelier init --review-bar TEXT` records what may block a review, at most
1,000 characters, with line breaks and control characters read as spaces.
Every review brief a runner serves, for a task or a plan's part, states it
before the reply format. Unset, or after `--review-bar ""`, the brief states
the default bar: block only for a correctness, security or data-loss defect
that the change introduces, or fails to fix while claiming to; a claim in a
commit message that the code does not support is a correctness defect;
decisions the project owner made are not defects; everything else is a
follow-up.

When the checkout is already registered locally, `init` reuses its registered
name, even if the folder has a different name. A different `--name NAME` is
refused. `atelier init --name NAME --rename-local` changes only that local
config entry and then returns. It does not rename a server project (see
[Renaming a project](#renaming-a-project)), update its title or policy, or
push a baseline. The server refuses a new project when its baseline
repository belongs to another registered project.

## Projects that use Git LFS

Artifacts has no Git LFS. The `atelier` command pushes to Atelier with LFS uploads
turned off, so the baseline and every workspace hold LFS pointer files, and
clones a workspace or a check run without downloading what they point to. A
merge into the owner's checkout writes real LFS files, as git-lfs would. A project whose required
checks need those files must fetch them itself; a build that only compiles
around them, as many do, works as it is. The owner's own remotes do hold the
objects: `atelier wrap --push` pushes to them with LFS uploads on, even when
`GIT_LFS_SKIP_PUSH` is set in the environment, and a remote whose upload fails
is reported as failed, never as pushed.

## Projects too large for Artifacts

Artifacts can refuse a long history as one push, for its size or the time it
takes. `atelier init` then pushes the branch's first-parent history in steps of
about 700 commits, oldest first, and prints a line for each step. If a step
fails, init says which commit the baseline holds, and running the same
`atelier init` again carries on from there: what is left is pushed whole, and
if that is refused too, the steps begin after the commit the baseline holds.
Each step runs the checkout's pre-push hook, as the whole push does. The
baseline's branch holds only part of the history until the last step has
pushed.

Artifacts holds at most 1 GB per repository and 32 MB per file. A project
whose history is larger can join with its recent history only:

```bash
atelier init --history-since 2026-09-05 --check "…"
```

The baseline then starts with one commit holding the project as it was at
the start of that day, followed by each commit on the branch's first-parent
line since, rebuilt with the same files, authors, dates and messages. The
project's own history is not pushed and not changed. The checkout keeps the
pairs of baseline and project commits in `.git/atelier-baseline-map.json`.

`atelier merge` carries an accepted task's commits onto the paired project
commit, so each has exactly the files the agent committed, then merges them
as usual, and publishes to the baseline a twin of the merge commit with the
same files. It refuses when the branch has moved since the baseline last
matched it; `atelier sync` carries commits made in the checkout outside
Atelier to the baseline first. Merging and syncing need this checkout, which
holds the pairs.



Set `NTFY_TOPIC` to receive an ntfy notification when submission, review or
check results put a submitted task in the owner's inbox:

```sh
printf 'TOPIC' | npx wrangler secret put NTFY_TOPIC
```

Topics on ntfy.sh are readable by anyone who knows the name. Use a long,
random topic. The notification carries the task title and the task page's
one-line decision brief, capped at 500 characters, with a link to that page.
See [ntfy publishing](https://docs.ntfy.sh/publish/) for topic and header details.

Without the setting, nothing is sent. The Ledger records at most one attempt
per task and head, including failed attempts, across restarts. Delivery runs
in the background; failures do not fail the action and are logged without
the topic. A push that withdraws acceptance does not send a notification.

## Where a project stands

For a project on Atelier, this replaces ControlPlane's pickup card and a
hand-written `STATE.md`. Atelier already records who holds each task, what is
waiting, what merged and what each handoff said, so the summary is generated
from that record and cannot go stale or be written wrongly by hand.

- The project page leads with "Where it stands": the tasks held (claimed,
  submitted or accepted) and since when, what waits on the owner with each
  task's one-line brief, the tasks queued for a runner, the last five merges
  with the agent's summary and the date, the latest handoff note on each live
  task, and, for a project with ControlPlane policy, its protected areas,
  eligible agents and overlap rule on one line. The record holds no ControlPlane
  change classes, so none are shown.
  Each part reads its own source, not a window over the project's record:
  holders from the items, since when and handoff notes from each live task's
  own events, merges from the merged items. A waiting task keeps the inbox's
  own reason, with the brief after it. Where a task's record is longer than
  what is read of it, the page and the text say what is not shown rather than
  guess.
- `GET /api/projects/NAME/standing` returns the same as JSON to any signed-in
  caller, the owner or an agent.
- `atelier status --project NAME` prints it as plain text, one line per item,
  ready to paste into a chat. Text a person or agent wrote is flattened to one
  line. It ends by saying whether this machine's checkout is in step with
  Atelier: for a project set up with `--history-since`, whether the checkout's
  head is the commit the baseline's head is paired with; otherwise whether the
  baseline's head is in the checkout. `atelier status` with no project keeps
  its owner's queue output.

## Removing a project

The owner can run `atelier projects remove NAME` to remove a project from
the index and from the local config. It disappears from Projects, Flow,
Decisions and the public showcase. Claimed, submitted or accepted items, and
open items queued for a runner, block removal unless the owner adds `--force`.
The local config entry is deleted whole, and the command lists what it held,
such as the checkout path, branch and `notesRemote`, so a setting made by hand
can be restored.

Removal retains the Artifacts repository and all project Ledger data,
including items, evidence and history. Deleting a repository requires a
separate, deliberate action by the owner. Reinitialising the same project,
under any name it has had, registers its retained Ledger again.

## Renaming a project

`atelier projects rename OLD NEW` gives a project a new name on the server
and moves the local config entry to it. Task references become `NEW/t43`
and pages `/p/NEW/...`. The project's Ledger, its baseline repository and
every task fork stay where they are, under the name the project was created
with, its key; new forks are named from that key too. Nothing is copied.

The old name keeps working. `/api/projects/OLD/...` serves the project as
before, in place rather than by redirect, so an agent whose token is limited
to the old name, a workspace clone that records it, and a command run with
`--project OLD` all carry on; the answer carries an `X-Atelier-Project`
header naming the project as it is called now. Pages under `/p/OLD/...`
redirect to `/p/NEW/...`, and a form posted from a page opened before the
rename still acts. The `SHOWCASE` setting may keep the old name.

A name is refused when another project is registered under it or was called
it before, or when a removed project's Ledger is kept under it. Renaming
back restores the old name by the same operation, and after any number of
renames every name the project has had resolves to it in one step. A former
name cannot be given to a new project while it still belongs to the renamed
one.

## Operations

`atelier ops COMMAND [ARGS...]` runs an operations toolkit kept outside this
repository: work on the machines and services around the projects, such as
surveys of every project, devices, backups and archives, which belongs to
one owner's setup rather than to the Git platform. `ops` comes first:
Atelier hands everything after it, unchanged and before reading anything
itself, to the executable `ATELIER_OPS` names or to `atelier-ops` on `PATH`,
and exits as it exits. Without one, `atelier ops` says so and exits 2.

## Local cache cleanup

`atelier gc --project NAME` previews local directories eligible for removal.
Add `--apply` to remove them. `--dry-run` explicitly requests the preview.
The command uses the configured cache (`ATELIER_CACHE` when set) and never
deletes Artifacts repositories or changes the project's checkout.

A workspace is eligible only when the server confirms that its item merged or
was abandoned, its HEAD equals the accepted head of the merge or, for an
abandoned item, the last head Atelier recorded, and it has no changed or
untracked files (files git ignores do not count as unpublished work), extra
commits in refs or reflogs, linked worktrees, initialized
submodules, or a Git operation in progress. Cleanup checks
its recorded project and item identity and refreshes the item's state before
removal. The current directory and its ancestors are preserved. Symlinked
directories are not followed. Stop editing a candidate before applying cleanup.

Check and diff clones carry a local record of their project, creation time,
and process. A recorded clone is eligible after 24 hours only when its process
and any recorded check child have exited. Runs for other projects, records
that cannot be verified, and older clones without records are preserved.
Normal completion removes both the clone and its record.

## Local development

`npm run dev` serves the Worker on localhost. The Artifacts binding always
reaches the real account, even locally, so local runs create real
repositories. Pass a throwaway token with
`npx wrangler dev --var ATELIER_TOKEN:localtest`; do not write `.dev.vars`
into an iCloud project.

`npm test` runs two pools. The pure functions in `src/rules.ts` and
`src/diff.ts` are tested by `node --test` (`test/*.test.ts`). The
`test/*.spec.ts` files run inside the Workers runtime through the Workers
test pool, against the Ledger Durable Object with its real SQLite storage
and no network access; `tsc -p test` typechecks them against the types
`wrangler types` generates. Workerd logs each refusal those tests assert as
an uncaught promise rejection (`uncaught exception … 409|owned|…`); those
lines are the refusals under test, not failures.

## Cost

Artifacts bills operations and storage from 14 October 2026: the first
10,000 operations and 1 GB each month are included in Workers Paid, then
$0.15 per thousand operations and $0.50 per GB-month. One item uses a fork,
a few token mints and a handful of pushes, fetches and clones, so ordinary
use should stay inside the included allowance. That is an estimate from the
operations the CLI performs, not a measurement.

## Licence

MIT. See [LICENSE](LICENSE).

## Decisions, projects, and history

The Decisions page puts reviews and blockers across projects beside the
selected task. Passing output stays collapsed; failed checks show their
output. Projects contains active work and task creation. History retains
merged and closed tasks with their evidence. Ownership and Git details
remain available inside each task.

Approval, acceptance and override forms carry the revision displayed on the page.
The server checks both the ledger and Artifacts before accepting that
revision. A stale page must be refreshed. Each reviewer's latest verdict
at a revision replaces their earlier verdict; another reviewer's rejection
still blocks acceptance.

## Dispatch

The project owner can send an open task to a kind of runner instead of
waiting for an agent to choose it: `atelier dispatch t11 --to home --agent
opencode --model glm-5.3-flash`, or "Send to an agent" on the task's page.
`--to` is `home` (a runner on one of your machines), `cloud` (a Cloudflare
container) or `any`; the agent and model are optional. Model names may carry a
`:profile` suffix, as the AI Studio's do. `atelier runner` is the home runner
(see Home runner). No cloud runner ships: a task sent to `cloud` waits for a
runner named `cloud:NAME`, which can be any program that speaks the two
requests below.

Runners are not sent work. A runner asks for it, describing what it can run,
with `POST /api/queue` and a body such as
`{"runner": "home:studio", "agents": [{"agent": "opencode", "models": ["glm-5.3-flash"]}]}`.
Atelier answers with the waiting tasks it may take, across every project,
oldest first, each with the name to claim under. The runner then claims
through the ordinary atomic claim with the header `X-Atelier-Runner`; a
dispatched task refuses any claim from a different kind of runner, agent or
model, and refuses a claim with no runner at all until the owner withdraws
the dispatch. A runner that gives up releases the task, and it waits in the
queue again. `atelier queue` lists everything waiting. If a project cannot be read, the
response names it in the `X-Atelier-Incomplete` header and `atelier queue` says so.
`atelier undispatch` withdraws a dispatch while the task is open; a claimed
or submitted task keeps its dispatch, which applies again if it is released.

A runner's name is declared independently of its actor token; what a dispatch guarantees
is that the task goes to the first matching runner that asks, and to no one
else, while it waits. Names are matched and stored in lower case, so
`home:Studio` and `home:studio` are one runner. A claim belongs to the runner
that made it; after a handoff, the first runner to claim as the new owner
takes it, and the task's history records which runner that was.

## Plans

A plan turns one goal into several items. The project owner states the goal
with `atelier plan "goal" [--scope GLOB]... [--planner harness/model]`.
Atelier creates the plan item and queues it as a plan job for the planner
named, or else for the first model in the pool for research work that is not
refused, not paid per token and may plan. A project has one active plan at a
time. The planner, holding the plan item's claim, posts a plan document
(`atelier.plan.v1`: the goal and its parts, each with a scope, dependencies,
a brief and acceptance criteria) with `atelier plan post tP FILE`. An
invalid one is refused with every error, and the planner gets one more
attempt before the plan blocks.

`atelier plan show tP` prints the newest proposal with its hash. `atelier
plan approve tP --hash HASH [--allow-paid]` approves that exact split, once;
an older hash is refused, and `atelier plan revise tP --note TEXT` sends a
proposal back instead. Approval fixes the limits (two parts live at once,
three attempts a part, four dispatches a part, 24 hours) and each part's
routing: a builder, two alternates and a reviewer of another family, chosen
from the model pool and the ledger's record. The parts become items, and
Atelier dispatches each one, as `atelier/orchestrator`, once the parts it
depends on have merged. A part its builder releases twice goes to an
alternate. A plan that reaches a limit blocks and appears in the inbox; the
owner decides with `atelier plan retry tN`, `atelier plan reroute tN --to
harness/model`, `atelier abandon tN` or `atelier plan stop tP`, which closes
the plan and its open parts and revokes their write tokens. `atelier show
tP` prints the plan's brief.

Not built yet: no runner takes a plan job, so a planner claims the plan item
with `atelier claim tP --as harness/model --runner home:NAME` and posts its
plan by hand; a part's runner gets the brief any task gets; nothing reviews
a part automatically; and parts do not merge into a branch of the plan's
own. Until then each part reaches main as any item does, through the owner's
acceptance and merge. The inbox lists a part only once it is accepted, so
`atelier plan show tP` gives the command for each part waiting on the owner,
and the plan is complete once every part has merged.
[docs/orchestrator.md](docs/orchestrator.md) holds the design and says which
of its steps are built.

A session that runs Atelier for a project, filing tasks, briefing agents,
landing their work and judging reviews, should read
[docs/orchestrating.md](docs/orchestrating.md) first.

## Home runner

`atelier runner` polls the queue every 30 seconds, claims one eligible task,
and runs its configured harness in the claimed workspace. The brief is kept
outside that workspace. Each opencode run also gets a data folder of its own
(`XDG_DATA_HOME`) beside the workspace, removed as the harness ends, however
it ends: opencode processes sharing `~/.local/share/opencode/opencode.db`
deadlock on it. Such a run finds its provider keys in the variables its
config entry names and in opencode's config; a key saved with
`opencode auth login` lives in the shared data folder and is not seen.
A harness does not inherit the runner's environment. It gets what a local
check gets (the toolchain's variables, such as `PATH`, `HOME`, `LANG` and
`TMPDIR`; nothing named `ATELIER_*` and nothing whose name says it holds a
token, key or secret) and the variables its config entry names in `env`. A
named variable that holds the owner's Atelier token is withheld, and the
runner says so. After a successful harness exit with a new commit,
the runner calls `finish` to push, run required checks, and submit. Failure
releases a claim only when no new commit was made. Otherwise the claim stays
in place for inspection. Two counters are kept for each project and task id,
across revision changes. The task counter never resets. Two task failures,
including harness failures and finish failures other than exit 4, skip the
task for the rest of the process. A separate counter skips it after three consecutive infrastructure failures,
including claim errors other than refusals, workspace preparation errors,
HEAD read errors after successful harness exits, and finish exit 4. This
counter resets on a task failure, success, claim refusal or validation skip. Claim refusals and validation skips do not
increase either counter. Interruptions stop the runner without updating either
counter. An infrastructure failure moves on to the next offered task in the
same poll; `--once` still handles at most one task.
Reaching either cap logs that the task needs the owner's attention; the
infrastructure message includes the reason. Project names rejected by runner
validation are skipped and remembered so other tasks
can run.
The harness, and every command the runner starts, leads a process group of
its own, and the group ends with it: when the harness exits, whether it
succeeded or failed, when its deadline passes and when the runner is
interrupted, every process left in the group gets SIGTERM, then SIGKILL after
five seconds, before the runner goes on. A process that starts a session of
its own (`setsid`) leaves the group and is not ended. SIGINT stops polling and
interrupts the active child process. A second interrupt kills every group at
once and exits.

Save a config at `~/.config/atelier/runner.json`, or select one with `--config PATH`:

```json
{
  "agents": [
    {
      "agent": "opencode",
      "models": ["GLM-5.3-Flash-4_8bit"],
      "command": ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "Read the attached task brief and complete it in {workspace}."],
      "env": ["ZAI_API_KEY"]
    },
    {
      "agent": "antigravity",
      "models": ["gemini-3.1-pro", "gpt-oss-120b"],
      "command": ["node", "/ABSOLUTE/PATH/TO/atelier/cli/agy-review.mjs", "--model", "{model}", "--brief", "{brief_file}", "--diff", "{diff_file}", "--verdict", "{verdict_file}", "--workspace", "{workspace}"]
    }
  ],
  "jobs": ["review"]
}
```

The antigravity entry names `cli/agy-review.mjs`, an adapter that runs
Antigravity's `agy` for a review: it builds one prompt from the brief and the
diff, maps Atelier's model ids to Antigravity's, writes the reply to the
verdict file, and runs `agy` sandboxed in the runner's review clone (the
owner's decision of 2026-10-06). Name the adapter by its absolute path: the
runner starts the command inside the review clone, which need not hold it.

Agent ids are `opencode`, `claude-code`, `codex`, `zcode`, `gemini-cli` or `antigravity`. Set model ids
and command arguments to match the installed harness. Commands are argv
arrays with `{model}`, `{brief_file}`, and optional `{workspace}` placeholders;
the runner invokes them directly without a shell. The example requires that
model to be configured in opencode. `env` is optional: the names of the
runner's variables this harness also gets, such as a provider key it reads or
`XDG_CONFIG_HOME`; a name starting with `ATELIER_` is refused. A runner started
from a LaunchAgent has only the variables the LaunchAgent sets, so a key named
here must be set there too. Atelier login and credentials are shared
with the ordinary CLI. Set `taskTimeoutMs` in the config to change the harness
deadline from 45 minutes, and `finishTimeoutMs` to change the whole finish
deadline from 60 minutes. Expiry ends the process group as above. A finish
timeout leaves the claim held.

```sh
atelier runner --name home:studio
```

Add `--once` to handle at most one task and exit, including when the queue
is empty.

`atelier runner --discover` reports what each home model's harness actually
serves, which can differ from the model the pool registers. It reads the pool
from Atelier and, for each home model, the record its harness keeps (Codex's
session logs, zcode's `model_usage` table, opencode's `message` table), which
it only reads and which needs no request. It prints a table and reports each
model through the status route under the runner's name (`--name home:NAME`,
which defaults to this machine's). `--probe` also sends one short prompt per
model that can be probed (a Claude Code, zcode or Gemini API model; never a
Codex or an AI Studio model). `--dry-run` prints the table and reports
nothing. A harness that answers with a different model from the one
registered is reported as refused, with the model it served, and listed under
Mismatch. For zcode and Codex, whose records name the model the harness
chose, any other model answering after the registered one last did counts,
whether or not the pool registers it too; opencode's record names the model
each call asked for, so it is not judged this way. The runner's own opencode
runs keep their record in their own data folders, which are removed, so the
opencode record shows only opencode used outside the runner. A model with no recent
record is shown as "no recent record" and nothing is reported for it, so its
earlier status stands.

A probe of a model that needs an API key finds it by a `keychain` map in the
runner config, from the model's id to the name of its Keychain entry:

```json
"keychain": { "gemini-3.1-pro": "gemini.API_KEY" }
```

A name is looked up as `atelier.NAME` in the macOS Keychain, so this one is
the item `atelier.gemini.API_KEY` (other systems use the store `atelier login
--store` names). The map holds a name, never a key: a config that carries
something shaped like a key is refused. A key is read only by that exact name,
only for a model that is probed, and goes only into the environment of the
process that needs it. It is never printed, reported or put in a URL, and no
other Keychain entry is listed or read.

`atelier runner --usage` reports how much of each tool's allowance this
machine has used: Codex's 5-hour and weekly windows from its session logs
(percent used and when each resets), the requests and tokens zcode's
`model_usage` table records by served model, the requests, tokens and cost
opencode's `message` table records by served model, each over the last 5
hours, 24 hours and 7 days, and the DeepSeek account's balance. Each tool
goes to `POST /api/usage/TOOL` under the runner's name, the Usage page
shows them, and the Worker alerts at the owner's thresholds (see Usage,
limits and balances). It is a one-shot command, not a step in the runner
loop: the loop polls every 30 seconds and must stay cheap, while this reads
logs that can be gigabytes and asks DeepSeek for a balance, and it is just
as useful on a machine that runs the tools but no runner. Schedule it
hourly, for example from a LaunchAgent, with `--dry-run` to see what it
would report first. Claude's plan limits and Gemini's spend have no record
on the machine, so neither is reported, and the command says so.

The DeepSeek balance needs its API key. The runner config names the
Keychain entry that holds it, as `keychain` names a model's:

```json
"balances": { "deepseek": "deepseek.API_KEY" }
```

Without the entry no balance is asked for. The key is read by that name
only and goes only into the environment of the child process that makes
the one balance call; the child prints currencies and amounts, and any key
a tool echoes back is removed from what the command prints. The report
carries counts, windows, model names, costs and balances, never a prompt,
a file name, a session id, a key or a header. Each window, model and
provider name a tool's record gives is cleaned before it is printed or
reported, as the server cleans it: that key, control characters and
anything shaped like a key are removed, and it is cut to the server's
length.

The CLI's exit codes let the runner tell a task's own failure from the
server's: 0 success, 1 a refusal or failure of the command, 2 a required
check that failed, 3 a claim the server refused, 4 the server unavailable or
a request that failed in transit (retry later). `atelier ops` has exit codes
of its own (see Operations).

## The public showcase

`/showcase` is the one page that shows project data, and anyone can read it
without signing in. It shows the projects the owner names, as the Flow page
draws them: each task's thread,
who held it, its checks, reviews and decisions, and the tally. It leaves out
what anyone wrote (review notes, reports, check commands and closing notes),
the diffs, every form and every link into the signed-in pages. Every email
address goes too: from task and project titles, and from the agent names read
from commit trailers in the history before Atelier, where a name that is only
an address is not taken. Nothing is shown until the owner names a project:

```text
printf 'atelier' | npx wrangler secret put SHOWCASE
```

`SHOWCASE` takes project names separated by commas; deleting it hides the
page again. The page is cached for a minute, so a change to `SHOWCASE` shows
within a minute. With a showcased project still registered, a visitor who is not signed in opens
`atelier.zone` on it; signed in, `/` opens Decisions while something is
waiting and Flow when nothing is, and `/decisions` is always Decisions.

`/how` is the other public page. It explains what Atelier is, draws the loop
from task to merge, states the rules the code enforces, marks which parts of
the orchestrator are built, and lists every command. It reads no project and
no setting, so every visitor gets the same text. Its command reference is drawn
from `src/usage.ts`, the table `atelier help` prints from, and
`test/how.test.ts` checks that the rules it names and its built and not built
labels still match the code.

## The model pool

The Models page (`/models`) and `atelier models` hold the models Atelier
can dispatch to. Each entry names the model as its harness does, the
harness (OpenCode, Claude Code, Codex, ZCode, the Gemini CLI or
Antigravity), where it runs, its provider and, for an API, the name of the
Keychain entry on the runner's machine that holds its key. Atelier stores
that name and never a key; a form or request that carries one is refused.

```text
atelier models add GLM-5.3-Flash-4_8bit --harness opencode --where home --endpoint http://studio.local:8000/v1
atelier models add gemini-3.1-pro --harness opencode --where cloud --provider google --keychain gemini.API_KEY
atelier models
```

A model's family (Claude, GPT, GLM, Gemini, DeepSeek, Qwen and others) is
recognised from its name, so a new release is coloured correctly on the
graph the day it appears; a name no family claims is shown as not
recognised. A runner reports what it finds for each model through
`POST /api/models/ID/status`, naming itself in `X-Atelier-Runner`: a home
model is reported only by a home runner and a cloud model only by a cloud
runner, and the Models page shows each report with the runner that made it.
Changing how a model is reached (its harness, where it runs, provider,
endpoint or Keychain entry) clears its status until it is checked again.
An endpoint carrying a query string, or a Keychain entry name that looks
like a key, is refused.

## Each model's reliability

The Models page and the Usage page show each model's record across every
project, and `GET /api/reliability` returns it. A model is named as review
independence names it, so the same model under two harnesses or a
registered alias is one record. Its work is what it held: how much was
approved at its first review by another model, how many review rounds a
merged item went through, every rejection with the note that gave its
cause, and every defect the owner traced to its accepted work. Its verdicts
are its own reviews: an approval of a revision a defect was later traced to
is contradicted, and so is a review run that never reached a verdict. Its
runs are those that failed, as the runners and the owner reported them. The
owner's approvals of its work are counted apart and are never a model's
verdict: those made on the task page, which only the signed-in owner
reaches, apart from those recorded through the API with the owner token, as
the orchestrator records them. An approval recorded before Atelier kept the
two apart is counted as unrecorded.

The record also holds the measures a comparison of models needs. The owner
adjudicates each finding of a review and records a verdict on it, which
counts the reviewer's precision: a finding confirmed or marked fixed is
kept, a refuted one was wrong, and the record shows how many of each a
reviewer has. Each task's wall-clock time is read from its events: claim to
first push, to submission, to the first verdict, to the merge, and the
rework turnaround from a rejection to the next submission, shown per model
as medians. Builder honesty counts a reported check an observed check
contradicted at the same head, and a submission whose changed paths ran
outside the task's scope. Integration cost counts the pushes that folded a
moved main into the task's fork. The Models page and the JSON route show
these measures by model and by the kind of work each item asked for, from
its plan part when there is one, else unknown.

```text
atelier defect t12 --note "pagination drops the last page" --found-in t19
atelier finding t12 --head SHA --index 1 --verdict confirmed --note "fixed in t19"
atelier run-report --actor opencode/glm-5.3 --role build --outcome early_stop --item t12 --project atelier
```

`atelier defect` traces a defect to the revision an item was accepted at;
the item itself does not change. `atelier finding` records a verdict on one
finding of a review, at the head the review was made at and the finding's
position in its findings, one based. A later review of the task shows the
reviewer each earlier finding, numbered as `--index` counts it, with the
owner's verdict and note, and says that a refuted finding is repeated only
with new evidence that the owner's answer is wrong, quoting the code. A run ends without a result the ledger
saw when it stalls, times out or is refused, or when the harness stops
early, stops at a permission, designs something a task already had, or
leaves a merge incomplete. The runner reports a run through `POST /api/runs`
with the owner token and its name in `X-Atelier-Runner`, as it reports
usage: the agent it ran, the role (`build` or `review`), the outcome, the
project and task when there is one, and a detail. `atelier run-report` lets
the owner record a run by hand for a run outside the runner. `bin/seed-2026-10-06`
prints the `atelier finding` and `atelier run-report` commands that record
the 2026-10-06 adjudications in `docs/data/adjudications-2026-10-06.json`;
it records the run reports only with `--apply`, since a finding's head and
position are read from its review, not from the file.

Routing reads the record only to order candidates of equal score: the share
of outcomes in a model's favour (work approved at first review, merges)
against those that are not (rejections, defects, contradicted approvals,
and every run that failed), with one of each added so a model with no
record sits at one half. The project's own track record and the registry's
evidence still decide the score.

A harness can serve another model than the one its events name: zcode
follows its app's provider settings, and served deepseek-flash while its
events said glm-5.3. The owner records what served them:

```text
atelier served deepseek-flash --recorded zcode/glm-5.3 --from 2026-10-04T16:00Z --to 2026-10-05T20:17Z --item t2 --project atelier
```

It lists the events recorded under `--recorded` from `--from` up to `--to`
on the tasks `--item` names, or on every task, and records nothing; with
`--apply` it adds an annotation of its own, an `event.served` event, for
each one not already annotated as served by that model. The annotated
event never changes, and the latest annotation of an event is the one that
counts, so a mistaken one is corrected by another. The track record, the
reliability record, the Models page and the graph count an annotated event
under the served model in the recorded harness, here `zcode/deepseek-flash`.
`bin/annotate-t95` holds the commands that correct the record for task t95;
the owner runs it, first without `--apply`.

## Usage, limits and balances

The Usage page (`/usage`) shows where each tool stands, as the home runners
last reported it with `atelier runner --usage`: one table per tool, with
its rate-limit windows (percent used, when each resets), the models it
served with requests, tokens and cost over the last 5 hours, 24 hours and
7 days, and any pay-per-use balance. Each row says which runner reported it
and when; a report older than three hours is marked stale, and a figure
past a threshold is tagged. `GET /api/usage` returns the same reports with
the thresholds and the alerts in force. A report is a status like a
model's: `POST /api/usage/TOOL` takes the owner token and the runner's
name in `X-Atelier-Runner`, and keeps one report per tool and runner.

Alerts go through the `NTFY_TOPIC` notification already used for decisions,
once per crossing: when a report first shows a figure past its threshold
the Worker sends one message and records the crossing; later reports
showing the same figure still past it send nothing, and a report showing it
back under clears the crossing, so the next time it is passed alerts
again. The thresholds are settings with defaults, each a number or `off`:

```sh
printf 80 | npx wrangler secret put USAGE_WEEKLY_PERCENT    # a weekly window past this percent
printf 90 | npx wrangler secret put USAGE_WINDOW_PERCENT    # a 5-hour window past this percent
printf 10 | npx wrangler secret put USAGE_DAILY_SPEND       # a tool's spend over 24 hours above this, in dollars
printf 10 | npx wrangler secret put USAGE_BALANCE_FLOOR     # a balance below this, in its own currency
```

A window that has already reset does not alert, whatever its last reading
was. Spend is summed over a tool's models from the cost its record carries,
so zcode, which records none, has no spend alert. Each alert and each
clearing is recorded as an event on the index Ledger.

## The Studio

`/studio` shows the floor: one lane per live task on a shared time axis,
banded by who has held it, each band and the thread along it in the
holder's family colour as the Flow graph draws a thread, with a mark for
every claim, push, check, handoff, submission and review. A handoff is a
visible change of band and colour, and every check mark says whether it ran
in a Cloudflare container or on the agent's machine. The page refreshes every fifteen seconds. The Decisions page
shows the same agents in brief before anything is opened. `DESIGN.md`
describes the marks.

## Finish and merge

After committing, an agent runs `atelier finish` in its claimed workspace.
It pushes, runs required checks, and submits only if those checks pass and
the workspace remains unchanged. A project with `sandboxOnly` enabled uses
the cloud runner automatically. `--sandbox` selects it explicitly.

The project owner can complete an exact revision with:

```sh
atelier merge t9 --head FULL_COMMIT_SHA --approve --note 'Reviewed changes'
```

`--approve` records the owner's own review, which is not the independent
review a protected change needs: that review must already exist, or
`--override-review "reason"` records the owner's override of it while
accepting. Acceptance still goes through the gate. Already accepted work
needs only `atelier merge t9 --head FULL_COMMIT_SHA`.

Merging records a journal for the registered checkout under the CLI's cache,
`~/Library/Caches/ai-projects/cloudflare-git/landing/KEY/journal.json`, with
the lock that keeps merges one at a time beside it. KEY is derived from the
checkout's Git directory; neither file lives in that directory, which iCloud
Drive syncs and where it renames a file it finds in conflict to a copy. If
publishing the baseline or recording the merge fails, rerun the same command.
It resumes from the local merge commit. It refuses a different revision, a
dirty checkout, or concurrent merge. If a process stops during the
uncommitted Git merge, abort that merge with `git merge --abort` before
retrying, or cancel the landing. The journal preserves the original revision
and starting commit. Never remove it to bypass a mismatch: cancel the landing.

`atelier merge t9 --cancel` ends a landing. It takes the landing lock, as
merge does, so it refuses while a merge of the same checkout is running, which
may be publishing. It keeps what the landing left in the checkout, an
unpublished merge commit or an unfinished Git merge, unless `--discard-local`
is given. Then it aborts the unfinished Git merge, or puts the branch back on
the commit where the merge began, the latter only while the branch is still on
the merge commit with nothing uncommitted; otherwise it changes nothing and
says what to move first. The journal is matched by task, not by revision: a
push or review can withdraw an acceptance after the merge commit is made and
before the landing lease is taken, and a new revision can then be accepted.
Such a landing can no longer be finished, so `atelier merge t9` refuses it and
names the cancel, which ends it in the checkout and leaves the server alone.
With a journal, the landing lease is cancelled on the server only while the
task is still accepted at the journal's revision. With a journal or without,
the lease is left alone when the baseline already holds the accepted revision
through a merge made elsewhere, whose lease it is; without a journal the
cancel then refuses. Wherever the cancel asks what the baseline holds, it
fetches the baseline and Git reads its whole history. The server also refuses
to cancel a lease once the baseline holds the accepted revision, reading its
history page by page.

Once the merge is on the baseline the cancel refuses, with or without
`--discard-local`, and the checkout keeps the merge: the journal says so once
the push has returned, and for a push that reached the baseline just before
the process stopped, the baseline's history says so. Rerun `atelier merge t9`
to record it. A merge the server has already recorded, or can no longer
record because the task is not accepted at that revision, leaves only the
journal, which the cancel removes.

While a merge holds the landing lease, the task cannot be abandoned, since the
merge may already be on the baseline: finish it with `atelier merge t9`, or
end it with `atelier merge t9 --cancel` while it is not on the baseline, then
abandon.

An earlier CLI kept the journal in the Git directory as `atelier-landing.json`,
with its lock, `atelier-landing.lock`, beside it. A landing interrupted under
it is picked up where it was left: the next `atelier merge`, `merge --cancel`
or `sync` moves the journal under the cache unchanged and goes on from it, and
removes the lock once the process its owner record names (`pid`, or the `pid 2`
copy iCloud makes) is gone. A live owner still blocks, a lock with no owner
record waits for a human, and a journal found in both places is refused with
both paths named. `atelier wrap` names such a journal as a landing in progress
and moves nothing.

The browser provides this local command after acceptance. It does not run a
network-accessible local executor. Deployment and pushing the project branch
to its own remotes remain separate decisions.

## Landing a task whole

`atelier land t9` runs the whole second half in one command, for the project
owner in the registered checkout: it merges main into the task's workspace,
regenerates the project's fixtures when its policy declares how, pushes, runs
the required checks, submits, waits for the independent review the gate
needs, then accepts and merges. It replaces the queueing a project owner did
by hand, one landing at a time, and it takes a lease on the server to keep
that order: while one landing runs, another landing in the same project is
refused with who holds the lease and since when. The lease is released when
the landing ends, on success or failure alike; a landing stopped partway can
be resumed by running `atelier land t9` again, which takes its own lease
back, and a lease whose task has merged or was abandoned no longer guards
anything.

A landing that loses the lease stops rather than merge beside its successor:
a Mac can sleep through a landing, pausing the timers that renew the lease,
so it lapses and a landing queued with `--wait` takes it over, and the first
landing wakes to find the lease gone. It then ends at once, having accepted
and merged nothing, and says whose landing holds the lease now; before the
accepting and merging steps it also asks for the lease again, so a loss it
slept through cannot slip between renewals, and the server itself refuses a
merge while another task's landing holds the lease. Whatever is left of the
stopped landing (a merged main, a pushed head, a review already approved)
stands, and `atelier land t9` again, or `atelier merge t9` once the task is
accepted, finishes it after the other landing ends.

The steps in between:

1. The server must be at this CLI's route level or newer. `GET /api/version`
   reports the commit the server was deployed from (`npm run deploy` records
   it) and its route level, and a landing whose server is older refuses
   before it starts, naming both levels and saying to deploy, since the
   server may lack the routes the landing needs. The route level
   (`src/route-level.ts`) rises by one only when a change makes the CLI
   start calling a route the server did not have.
2. Main is fetched into the task's workspace and merged with `--no-ff`. On
   conflicts the landing stops, leaves the merge in the workspace for the
   owner to resolve, and names the files. After resolving and committing,
   `atelier land t9` again picks up from the push.
3. When the project's policy declares a `regenerate` command
   (`atelier init --regenerate "CMD"`), it runs in the workspace like a check
   runs, and what it changes is committed before the push, so generated
   fixtures are current with both lines before the checks see them. The
   landing adds no typecheck of its own: the project's required checks are
   the whole gate, and they run through `atelier check` in a clean clone of
   the pushed head.
4. If the gate needs an independent review, the landing asks the server for
   one through the review-request routes: the reviewer is the one named with
   `--reviewer H/M`, or a model of another family than every contributor
   picked from the pool, and the landing polls for the verdict, refusing to
   go on after a rejection or a timeout (the request stays open and the task
   stays submitted). `--no-review` skips the waiting and leaves the task
   submitted for the owner to settle by hand.
5. The landing accepts and merges through the CLI's own `accept` and `merge`
   commands, each run as this CLI's child, so their checks and their
   journals behave exactly as when the owner runs them.

Each step, its duration and what it settled are recorded on the task as
`land.*` events (the commits that came from main, the files a conflict
stopped on and who resolved it, the reviewer and the verdict), so the cost
of integrating a task can be read from the ledger. `--dry-run` prints the
steps and the refusals without changing anything.

## Ship and protected actions

Merging lands accepted work in the owner's checkout and on the baseline. An
action whose effect reaches beyond the repository, and cannot be taken back
by a revert, is a protected action: a deploy, a device install, a push of the
project's branch to its own remotes, a paid model run, a Photos writeback, or
a further kind the project's own ship files name. It runs only with the
project owner's approval for one exact revision of the main line, and each
approval is used by one run. The full design is in
[docs/ship.md](docs/ship.md).

```sh
atelier approve deploy --head "$(git rev-parse HEAD)" --note "release 12"
atelier ship --dry-run
atelier ship
```

- **The owner alone** approves, withdraws, uses and records, with
  `atelier approve`, `atelier approvals`, `atelier approvals withdraw ID`, or
  the forms under "Protected actions" on the project's page. An agent token
  is refused before the route is reached.
- **The approval is bound to one full revision** of the main line. It stands
  for 24 hours unless `--expires` gives from `1m` to `30d`; a second approval
  for the same kind and revision is refused while the first stands; when the
  main line moves, the old approval stays behind and the new revision needs
  its own.
- **One approval, one run.** `atelier ship`, run by the owner in the
  registered checkout, composes the project's ship order from its own files
  (ControlPlane's ship policy and adapter, or `docs/atelier/ship.json`),
  refuses before running anything when a protected step has no approval at
  the revision being shipped, takes each approval before its step runs (a
  failed step has still spent it), stops at the first failure, pushes only
  with `--push` and never forces a push, and records every step on the
  ledger as `action.ran` with its redacted output tail.
- **The ship files and what they run are protected** like check scripts, in
  every project: `docs/atelier/**`, and every file the order's commands
  execute, recorded at `atelier init` and `atelier sync`. A change to them
  needs an independent review, and a merge refuses an accepted change that
  touches a script a newer order runs.
- **The inbox reminds the owner to ship.** While a merged revision's declared
  protected actions have not run, the Decisions page and `atelier status`
  carry the entry, with `atelier ship --dry-run` as its next command, until a
  run of each declared kind is recorded; a ship at a later head delivers an
  older merge and retires its reminder too.

The local harness that runs a task is the owner's own user, which no server
rule confines; the design for confining it is in
[docs/harness-confinement.md](docs/harness-confinement.md).

## Push event setup

The Worker has a Queues consumer for `cf.artifacts.repo.pushed` notices in
the `atelier` namespace. It acts on pushes to the project's branch, the one
init registered, ignores other branches and duplicate events, and retries
failed reads.
A new push invalidates acceptance and evidence for the previous revision.
The CLI's push observation remains available when event delivery is delayed.

`bin/setup-push-events` prints what provisioning needs and nothing else. With
`--apply` it creates two queues, `atelier-push-events` and its dead-letter
queue `atelier-push-events-dead-letter`, and runs nothing more: it never
deploys the Worker and never edits `wrangler.jsonc`.

The consumer belongs in the release configuration. Add this to
`wrangler.jsonc`, alongside the other top-level keys, then deploy:

```json
"queues": { "consumers": [{ "queue": "atelier-push-events", "max_batch_size": 10, "max_retries": 5, "dead_letter_queue": "atelier-push-events-dead-letter" }] }
```

Events reach the queue only through a subscription, and a repository-level
subscription selects one repository. Every item's workspace is a separate fork
repository, so each fork needs its own subscription under the `atelier`
namespace; a fork without one has no event delivery, and only the CLI's push
observation covers it. The installed wrangler (4.147.0) has no flag for a
subscription's namespace or repository, so create those subscriptions in the
Cloudflare dashboard or through the API. `bin/setup-push-events` prints this
as a TODO rather than guessing at a command.

Queue provisioning, subscription creation, and deployment are release actions;
adding the consumer handler alone does not activate event delivery. See
[Artifacts event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/).

## Local visual review

Run `node test/preview.mjs` for a local, read-only preview with illustrative
content. It prints its URL. The preview cannot approve, merge, or create live
tasks. Use `?state=empty`, `/p/atelier/t1?state=failed`, `state=ready`,
`state=accepted`, `state=merged`, `state=unavailable`, or `state=long` to inspect
important states. The pages follow the device's light or dark setting;
change that setting to inspect the other palette.

The visual composition is saved in `.impeccable/mocks/decisions.png` with its
prompt. Product intent lives in `PRODUCT.md`; the implemented visual system
is recorded in `DESIGN.md`.

## Integration basis

The decision workspace integrates t1 at `5ebb64e9` (cloud checks), t4 at
`8c44da71` (real Ledger runtime tests), and the merged t5 cleanup work.
Their commits remain in the integration history. Combined test discovery
runs TypeScript and JavaScript unit tests and the Workers runtime suite.
Cloud checks now bound retained output and mark interrupted runs failed
instead of leaving them indefinitely running. Local verification does not
establish a successful production container run.
