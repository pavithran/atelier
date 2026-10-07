# The project owner's reference

What only the project owner does, or sees: sessions of direct work in the
registered checkout, the signed-in pages, projects that need special care
when they join (Git LFS, a history too large for Artifacts), removing and
renaming projects, the operations toolkit, and cleaning the local cache.

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

## The Studio

`/studio` shows the floor: one lane per live task on a shared time axis,
banded by who has held it, each band and the thread along it in the
holder's family colour as the Flow graph draws a thread, with a mark for
every claim, push, check, handoff, submission and review. A handoff is a
visible change of band and colour, and every check mark says whether it ran
in a Cloudflare container or on the agent's machine. The page refreshes every fifteen seconds. The Decisions page
shows the same agents in brief before anything is opened. `DESIGN.md`
describes the marks.

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
