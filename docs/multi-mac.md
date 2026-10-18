# Working from several Macs

A developer who works on one project from several Macs keeps a checkout of it
on each, outside iCloud. Git carries code, history and work in progress
between them, through the project's baseline and its branches repository;
dependencies, data and secrets stay on the Mac that made them. This page says where each lives, how
to set up a new Mac, how to move work from one Mac to another, and what
happens when two Macs disagree. The commands below name the project with
`--project PROJECT`.

## What lives where

| What | Where it lives on each Mac | How it reaches another Mac |
| --- | --- | --- |
| Code and history | The project's checkout, `~/ai-projects/PROJECT` unless `atelier clone` is given another folder | Git, through the baseline: `atelier pull` brings what another Mac carried there |
| Receipts | `refs/notes/atelier` in the checkout, which `git log` shows beside the commits | Fetched by `atelier clone` and merged by `atelier pull` |
| Work in progress | Branches named `wip/NAME` in the checkout | The project's branches repository, through `atelier branch push` and `atelier branch fetch` |
| Project data | `~/Documents/ai-project-data/PROJECT` | No Atelier command carries it |
| Dependencies | `node_modules` in each checkout, which Git ignores | None: each checkout installs its own |
| The Atelier token | The macOS Keychain, item `atelier.API_TOKEN` | None: `atelier login` on each Mac |
| Atelier's configuration | `~/.config/atelier/config.json`: the server and each project's checkout on this Mac | None |

## The baseline as the shared remote

The project's baseline, the Git repository in Cloudflare Artifacts that
Atelier lands work into, is the one remote every Mac shares. `atelier clone`
makes the checkout from it with the baseline's main, its whole history and its
receipts, and keeps it as `origin`.

No checkout keeps a token. Each Atelier command that reaches the baseline
(`clone`, `pull`, `sync`, `wrap`, `merge`) mints its own token, passes it
only to the Git commands that need it and keeps it nowhere; the
`atelier branch` commands do the same for the branches repository. `clone`,
`pull` and `branch` run every Git command with every Git hook off, so no hook
in the checkout sees the token. A plain `git push` or `git pull` against `origin` has no
token and is not how a checkout reaches the baseline.

`atelier clone` also sets the checkout's `user.name` and `user.email` to the
commit identity the project's policy names, so commits look the same from
every Mac. When the policy names none, clone says so and the Mac's global Git
identity is used.

Git LFS files are kept as pointers, as every clone of a baseline keeps them:
Artifacts holds the pointers alone.

## Setting up a new Mac

1. Install the Atelier CLI from a checkout of Atelier and sign in, as the
   README's setup does. The token goes to this Mac's Keychain.

   ```bash
   npm link
   atelier login --server https://atelier.zone
   ```

2. Clone the project. The folder must be missing or empty. Clone registers it
   as this Mac's checkout of the project.

   ```bash
   atelier clone PROJECT
   ```

   A project already registered on this Mac at another path is refused;
   `--replace` registers the new folder in its place and leaves the old one as
   it is.

3. Install the dependencies in the new checkout.

   ```bash
   cd ~/ai-projects/PROJECT && npm ci
   ```

## Moving work between Macs

Work moves one of two ways. Commits on main go to the baseline and come back
down with `atelier pull`. Work that is not ready for main goes on a `wip/`
branch.

### Commits on main

On the Mac where the work was done, the commits reach the baseline through
`atelier wrap` (which ends by updating the baseline) or the next
`atelier merge`; for a baseline built from part of the project's history
(`atelier init --history-since`), `atelier sync` carries them. On the other
Mac:

```bash
atelier pull --project PROJECT
```

`atelier pull` needs a clean checkout with main checked out. It fetches the
baseline's main and receipts, merges the receipts into the checkout's own (a
receipt made here and not yet pushed is kept), then fast-forwards main, or
merges it with the local commits under the project's commit identity, and
names the commits it brought. When main and the baseline each hold commits
the other lacks, the local commits reach the baseline at the next `wrap`,
`merge` or `sync`.

### Work in progress

`atelier branch` needs a server with developer branches; on an older server
the command refuses before it does anything and names the deploy it lacks. On the
Mac where the work is:

```bash
git switch -c wip/idea
git commit -am "Half of the idea"
atelier branch push --project PROJECT
```

`branch push` pushes the current branch, or the one named, to the project's
branches repository beside the baseline, with a token only the developer is
given, and records its last commit and the Mac's name. Only names under
`wip/` are taken: main, the project's branch and a task's id are refused
before a token is minted, and the baseline's main is never reached. On the
other Mac:

```bash
atelier branch ls --project PROJECT
atelier branch fetch idea --project PROJECT
git switch wip/idea
```

`branch ls` lists the developer's branches, newest push first, each with its
last commit and the Mac it was pushed from. `branch fetch` refuses the branch
that is checked out, so to bring a branch back to a Mac where it is checked
out, switch to main first. Work on a `wip/` branch reaches main as any other
branch does: merged into main in the checkout, then carried to the baseline.

## Conflicts and refusals

**A Mac that is behind.** `sync` and `merge` read the baseline's main first
and refuse, with nothing sent, while the checkout's main does not hold it;
each names `atelier pull`. `wrap` commits first and then refuses when it
updates the baseline, so the commit stays in the checkout until a pull and a
later `wrap` carry it.

**A merge that conflicts.** `atelier pull` makes its merge with
`git merge-tree`, which writes no file. When the two sides conflict, main, the
index and the work tree are left as they were, the paths are named, and the
message gives the commands to merge by hand and the commit it fetched. By then
the pull has already fetched the baseline's objects and merged its receipts
into `refs/notes/atelier`; those stay.

**What `atelier pull` refuses.** A refused pull says why and leaves main, the
index and the work tree as they were. How far it got before the refusal
decides what else it has done. It refuses before fetching anything when:

- the checkout has uncommitted changes, or main is not checked out;
- the checkout has a grafts file or a shallow history, which change the
  history Git shows;
- a merge is in progress.

It refuses after fetching the baseline's main and receipts, with the fetched
objects kept in the checkout's object store but the receipts not yet merged,
when a merge commit is needed and the project's policy names no commit
identity.

It refuses after fetching and after merging the baseline's receipts into
`refs/notes/atelier`, which keeps them, when:

- the result would hold two paths that differ only by letter case or Unicode
  form, which a Mac stores as one file;
- the baseline changes a file the checkout's Git configuration runs (a hook,
  a filter or merge driver command, an included configuration file); the
  message names the files and the commit to review before merging by hand;
- the baseline adds a file the checkout holds untracked or ignored, such as
  local notes, which the pull would write over; the file is named, to be moved
  aside.

**Branches.** A `branch push` that would not fast-forward the branch in the
branches repository is refused by Git; `--force` replaces the other side's.
When another Mac has pushed and recorded the branch since, the push says so
and its own push is not recorded over the other. A `branch fetch` that would
not fast-forward the local branch is refused the same way, and `--force`
replaces the local one.

## Private files

A file that stays with the developer, such as `PROJECT.md`, is kept in the
project's iCloud folder, the folder in
`~/Library/Mobile Documents/com~apple~CloudDocs/ai-projects/` whose name
matches the project's ignoring letter case, spaces, `-` and `_`. The folder's
`.atelier-private` lists the files, one path a line, relative to the checkout;
this Mac's `config.json` may name more in the project's entry (`private`) and
the folder (`privateHome`). No Atelier command names, links or ignores them
any more (`atelier private` was removed in t770); what the developer links into
a checkout and ignores through `.git/info/exclude` is the developer's own.

What Atelier does is refuse to push them. `atelier clone` and a successful
`atelier pull` keep a copy of the list in this Mac's configuration, and every
Atelier push goes through the push guard: `sync`, `merge`, `wrap --push` and
its baseline update, `ship --push`, `init`, a task's `push`, `branch push` and
the task refresh. Before pushing, the guard reads every commit the destination
does not already hold, and refuses, with nothing pushed, when one of those
commits adds, changes or retypes a private path, or when a private path is in
the tree of the commit pushed or of any commit pushed whose parent the
destination already holds. A symbolic link counts as the path, since Git
commits a link as a link. The guard also refuses when the list cannot be read
and this Mac keeps no copy of it. The commit it read is the one pushed, so a
commit made on the branch in between is not sent. `wrap` also refuses to stage
a private file. A project with no private file named on this Mac is not
guarded and its iCloud folder is never read.

## Data, dependencies and secrets

**Data.** A project's data, such as saved relay envelopes and review
captures, is kept in `~/Documents/ai-project-data/PROJECT`, never in the
portfolio folder or the repository. No Atelier command reads or carries it.

**Dependencies.** Each checkout installs its own: `npm ci` after
`atelier clone`, and again after a pull that changes `package-lock.json`.
Clone does not run it.

**Secrets.** The developer's Atelier token is in each Mac's Keychain, put
there by `atelier login`; the `ATELIER_TOKEN` environment variable overrides
it. `~/.config/atelier/config.json` holds the server and this Mac's
registrations, not the token. The tokens Atelier mints for the baseline and
the branches repository are kept nowhere. No secret belongs in the
repository.
