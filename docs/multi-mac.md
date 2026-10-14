# Working from several Macs

A developer who works on one project from several Macs keeps a checkout of it
on each, outside iCloud. Git carries code, history and work in progress
between them, through the project's baseline and its branches repository;
iCloud carries only the project's private files; dependencies, data and
secrets stay on the Mac that made them. This page says where each lives, how
to set up a new Mac, how to move work from one Mac to another, and what
happens when two Macs disagree. The commands below name the project with
`--project PROJECT`.

## What lives where

| What | Where it lives on each Mac | How it reaches another Mac |
| --- | --- | --- |
| Code and history | The project's checkout, `~/src/PROJECT` unless `atelier clone` is given another folder | Git, through the baseline: `atelier pull` brings what another Mac carried there |
| Receipts | `refs/notes/atelier` in the checkout, which `git log` shows beside the commits | Fetched by `atelier clone` and merged by `atelier pull` |
| Work in progress | Branches named `wip/NAME` in the checkout | The project's branches repository, through `atelier branch push` and `atelier branch fetch` |
| Private files, such as `PROJECT.md` | The project's folder in iCloud, linked into the checkout | iCloud |
| The list of private files | `.atelier-private` in the project's iCloud folder | iCloud; it is never linked into a checkout or pushed |
| Project data | `~/Documents/ai-project-data/PROJECT` | No Atelier command carries it |
| Dependencies | `node_modules` in each checkout, which Git ignores | None: each checkout installs its own |
| The Atelier token | The macOS Keychain, item `atelier.API_TOKEN` | None: `atelier login` on each Mac |
| Atelier's configuration | `~/.config/atelier/config.json`: the server, each project's checkout on this Mac and the private files this Mac names | None, except the private file names, which the list in iCloud carries |

## The baseline as the shared remote

The project's baseline, the Git repository in Cloudflare Artifacts that
Atelier lands work into, is the one remote every Mac shares. `atelier clone`
makes the checkout from it with the baseline's main, its whole history and its
receipts, and keeps it as `origin`.

No checkout keeps a token. Each Atelier command that reaches the baseline
(`clone`, `pull`, `sync`, `publish`, `merge`) mints its own token, passes it
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

2. Let iCloud bring down the project's folder in
   `~/Library/Mobile Documents/com~apple~CloudDocs/ai-projects/`, which holds
   the private files and their list.

3. Clone the project. The folder must be missing or empty. Clone registers it
   as this Mac's checkout of the project, links the private files that
   `.atelier-private` names and makes Git ignore them.

   ```bash
   atelier clone PROJECT
   ```

   A project already registered on this Mac at another path is refused;
   `--replace` registers the new folder in its place and leaves the old one as
   it is. `--private-home DIR` names the folder that keeps the private files
   when it is not the iCloud folder named for the project.

4. Install the dependencies in the new checkout.

   ```bash
   cd ~/src/PROJECT && npm ci
   ```

5. Check the private files. Any that iCloud had not yet downloaded are listed
   as not in the folder; once they are there, `atelier private add PATH`
   links them.

   ```bash
   atelier private ls --project PROJECT
   ```

## Moving work between Macs

Work moves one of two ways. Commits on main go to the baseline and come back
down with `atelier pull`. Work that is not ready for main goes on a `wip/`
branch.

### Commits on main

On the Mac where the work was done, the commits reach the baseline through
`atelier publish`, `atelier wrap` (which ends with a publish) or the next
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
the other lacks, the local commits reach the baseline at the next `publish`,
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
before a token is minted, and the baseline's main is never reached. The push
goes through the private-file guard (see Private files). On the other Mac:

```bash
atelier branch ls --project PROJECT
atelier branch fetch idea --project PROJECT
git switch wip/idea
```

`branch ls` lists the developer's branches, newest push first, each with its
last commit and the Mac it was pushed from. `branch fetch` refuses the branch
that is checked out, so to bring a branch back to a Mac where it is checked
out, switch to main first. Work on a `wip/` branch reaches main as any other
branch does: merged into main in the checkout, then published.

## Conflicts and refusals

**A Mac that is behind.** `sync`, `publish`, `merge` and `fast land` read the
baseline's main first and refuse, with nothing sent, while the checkout's
main does not hold it; each names `atelier pull`. `wrap` commits first and
then refuses at its publish, so the commit stays in the checkout until a pull
and a publish carry it.

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
- the baseline adds a file the checkout holds untracked or ignored, such as a
  private file, which the pull would write over; the file is named, to be
  moved aside.

A pull that is refused, or that stops at a conflict, links no private files.

**Branches.** A `branch push` that would not fast-forward the branch in the
branches repository is refused by Git; `--force` replaces the other side's.
When another Mac has pushed and recorded the branch since, the push says so
and its own push is not recorded over the other. A `branch fetch` that would
not fast-forward the local branch is refused the same way, and `--force`
replaces the local one.

**Private files.** Atelier does not merge them. iCloud keeps the one copy in
the project's folder, and each checkout links to it.

## Private files

`atelier private add PATH` names a file that stays with the developer, such as
`PROJECT.md`. It is kept in the project's iCloud folder: the folder in
`~/Library/Mobile Documents/com~apple~CloudDocs/ai-projects/` whose name
matches the project's ignoring letter case, spaces, `-` and `_`, or the
folder given with `--home DIR`. The name is written to `.atelier-private`
there and to this Mac's configuration; the file is linked into the checkout
and ignored by Git through `.git/info/exclude`, never `.gitignore`, which
would be pushed. A file already in the checkout is never overwritten, and a
file Git tracks is refused until it is untracked.

Because the list is in iCloud, `atelier clone` on any Mac links every file it
names. A name added on another Mac after this Mac's clone is linked by the
next `atelier pull` that succeeds, whether it brought commits or found main
already up to date; pull says what it linked, left alone or could not link,
and brings this Mac's copy of the list up to date. Pull does this only for a
project this Mac already knows has private files: one whose list named a file
when this Mac last read it, or whose names or folder this Mac's configuration
holds. `atelier private ls` reads the list and opts the project in, and
`atelier private add PATH` links a file at any time.

`atelier private remove PATH` is the only way a name stops being private. It
drops the name from this Mac's configuration, its copy of the list and the
list in iCloud, and removes the link Atelier made; the file in iCloud is left
as it is.

Git's ignore rules are not what keeps a private file out of a push. Atelier's
line in `.git/info/exclude` can be outweighed: a tracked `.gitignore` with a
line such as `!PROJECT.md` re-includes the file, and an ordinary `git add`
then stages it, as `git add -f` would. `atelier private ls` warns of each
private file Git does not ignore.

What keeps it out is the push guard, which every Atelier push goes through:
`sync`, `publish`, `merge`, `wrap --push`, `publish REMOTE`, `fast land`, a
task's `push` and `branch push`. Before pushing, the guard reads every commit
the destination does not already hold, and refuses, with nothing pushed, when
one of those commits adds, changes or retypes a private path, or when a
private path is in the tree of the commit pushed or of any commit pushed whose
parent the destination already holds. A symbolic link
counts as the path, since Git commits a link as a link. The guard also
refuses when the list of private files cannot be read and this Mac keeps no
copy of it. The commit it read is the one pushed, so a commit made on the
branch in between is not sent. `wrap` also refuses to stage a private file.

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
