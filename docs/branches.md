# Branches and write isolation on the Studio

For developer-token writes, set `export ATELIER_ACTING=H/M` to your
registered harness/model. Owner commands keep the owner actor; use
`ATELIER_ACTING` for `ship`, `wrap`, `branch push|fetch`, `plan show`, `projects` and `import-tasks`.
These commands refuse `--as H/M`, which changes the actor.
Builder and reviewer commands use `--as H/M` to name their actor.

Atelier 2.0 keeps each project in one bare Git repository on the Studio, and each task works on a branch of it, `t/N`. This page says how one holder per task still holds when every task shares a repository, how a landing reaches the project's branch, how a project moves here from 1.x, and what stands outside the Studio. The design is `design-branches-2026-10-28.md`, sections 4.3 to 4.10, in `~/Documents/ai-project-data/atelier/`; what was built, piece by piece, is `docs/2.0-log.md`. Where the two differ, the code and the log are right.

## What enforces it

A builder could write to any branch of a shared repository if nothing stopped it. Two things stop it.

**Every Git credential is a grant the server minted.** The server stores only its SHA-256 (`src/git/grants.mjs`). A grant is bound to one project and one kind:

| Kind | Writes | Lives |
|---|---|---|
| `task` | `refs/heads/t/N` of its task | while the task's Ledger records it, at most 7 days |
| `plan` | `refs/heads/plan/N`, the plan's integration branch, for the plan's holder | as a task grant |
| `read` | nothing; reads every branch | 8 hours |
| `landing` | the project's branch, once, with a merge of its task's accepted head; and `refs/notes/atelier` | 5 minutes, while its holding of the landing lease and the acceptance stand, until the merge is recorded |
| `refresh` | `refs/heads/t/N` of its task, beside the holder's task grant | 8 hours, while the task's refresh lease it was minted under stands and the Ledger records it as that lease's grant |
| owner | the project's branch only to create it in an empty repository; `refs/heads/dev/*` and `refs/notes/atelier` | the server token itself |

A task or plan grant counts only while the task's Ledger records it as the item's write token (`git:HASH` in `items.token_id`). The Ledger already changes that record on every change of holder: release, handoff, abandon, merge and a new claim. So each of those revokes the grant with no extra step, and asking for a new grant replaces the old one. A task has one live write credential at a time. A task or plan grant also expires 7 days after it was minted (`TTL_MS` in `src/git/grants.mjs`); `atelier push` asks for a new one once Git refuses the old.

`POST /api/projects/P/git-token` with `{"kind": "read"}` or `{"kind": "task", "item": "tN"}` gives one. A task grant goes only to the task's holder. A read grant asked with `"item": "tN"` also names the task's branch (null before its first claim), the branch it merges into (`into`: its plan's branch for a part, the project's otherwise), and its recorded head and base; it is the one read credential every caller uses (Atelier 2.0, task 13, removed the `read-token`, `base-token` and `baseline-token` routes).

A task refresh's lease (t462, the job that merges main's new head into a waiting task) carries a `refresh` grant. The `refresh-lease` route mints it to the leaseholder and records it on the lease. It writes the task's branch while that lease stands (`stillRefreshing` in `src/git/host.mjs`), and the lease's settling or lapsing revokes it.

`{"kind": "landing", "item": "tN", "head": H}` gives a landing grant (task 6, design section 4.7; the landing that uses it is under "The landing" below). It goes only to the holder of the project's live landing lease, for that task, while the task is accepted at H; otherwise the route refuses with `no_lease`, `not_accepted` or `acceptance_changed`, each naming the next command. The grant is bound to the project, the task, H and the holding of the lease it was minted under (the lease's `id`, drawn afresh at every take or takeover and kept by a renewal). It counts only while the task is still accepted at H and that holding still stands, so a lease released, taken over or released and retaken, or an acceptance withdrawn, ends it for good. It updates the project's branch once: the hook's last check (rule 7) takes that update in the grant store in one statement, and a second update with the same grant is refused, while its notes stay writable. It lives five minutes and is revoked once the landing's merge is recorded, so a used grant gets 401. Since the grant names its task, the hook's scan of the landing push applies the clearances the owner recorded on that task.

**The pre-receive hook refuses every ref update the grant does not cover** (`hooks/pre-receive`). The server runs `git receive-pack` with the grant's id and binding in the environment, never its token, and the hook applies four rules to each ref update:

1. One ref per push, the one the grant names. Any other ref is refused with `atelier: this credential writes t/N only`. Landing and owner grants also write Atelier's provenance notes, `refs/notes/atelier`, on a push of their own; a task or plan grant never does.
2. No deletes, by any credential. Nothing on the server deletes a task's branch either: a merged or abandoned task's `t/N` is kept in the repository, and the nightly bundle carries it.
3. The project's branch, `plan/*` and `refs/notes/atelier` move by fast-forward only. A task branch may be rewritten (`atelier update` rebases); the Ledger decides whether a rewritten head counts.
4. A landing push to the project's branch must be a merge whose first parent is the branch's tip and whose parents include the accepted head. The owner's credential (the server token, which the orchestrator holds) only creates the project's branch in an empty repository; after that only a landing grant moves it, and an owner push to it is refused naming `atelier land`. So no credential carries an unreviewed change onto the project's branch.

For a push those four allow, the hook then reads the pushed files (`src/git/scan.mjs`):

5. The secret scan. It reads the lines every added commit adds, with the patterns and fingerprints of `src/secret-scan.ts`, and honours `docs/atelier/privacy-allow.json` at the pushed head. A key-shaped line refuses the push, naming file, line and commit, never the value. A line the owner cleared with `atelier clear-secret` (same file, same fingerprint) passes. When the owner creates the project's branch in an empty repository, both guards read every file at the pushed tip instead of its history, with the same rules and file size limits; a tree over 20,000 files, an 8 MiB file inventory or 256 MiB of scanned content is refused. Every other push scans each added commit and is refused above 1,000 commits.
6. The private-file guard. A commit that adds, changes or retypes one of the project's private paths refuses the push (`privateCommits` in `cli/private-guard.mjs`).

The added commits are those the new head reaches and the old tip does not, for the project's branch. For any other branch they are those the new head reaches and the project's branch does not, on every push. So the scan of a task's head always covers the whole task, and a later push cannot drop a finding an earlier one recorded.

The hook runs in its own process and cannot reach the Ledger. For each push the server writes the task's clearances and the project's private paths to a policy file. The hook writes what the scan found to a report file. Both are mode 600, in a directory of the request's own under `data/ENV/hook-scans`, and both go when the request ends. The environment names their paths and holds no token. When the push ends, the server records the report on the task (`hookScanned` in `src/ledger.ts`):

- A refused push's findings are recorded on the item at once, so the owner can clear them.
- A push the hook let through is kept, in a slot of its own for that head (`hook-scan:ITEM:HEAD`), so two pushes to one task do not replace each other. `atelier push` takes the slot for the head it records, and that becomes the scan record. Nothing is left pending. The slots go when the item merges or is abandoned.

What refuses and what is recorded:

- A key-shaped line the owner has not cleared refuses the push, on every branch.
- A private path refuses the push, on every branch.
- A push that adds more than 1000 commits (`TASK_COMMITS`, as `scanCommit`) is refused, naming the cap.
- An unscanned file (a blob over 8 MiB, `SCAN_BYTES`; a non-media binary; a submodule) on `t/N` or `plan/N` is recorded on the item with its reason and does not refuse. On the project's branch or `dev/*`, which have no item to record on, it refuses the push, naming the files, unless the owner cleared it on the grant's task.

The server sweeps leftover policy and report directories from `data/ENV/hook-scans` when it starts. The private paths are set with the Ledger's `setPrivatePaths`.

Allowed lines (`docs/atelier/privacy-allow.json`) are dropped before the report. The owner sees them only in the allowance file's diff.

Last, for every push:

7. The grant is still live. The hook asks the server whether the grant it was let in with still counts and its actor still holds the task (`POST /internal/grant-live` on a loopback listener of its own, with a random per-process secret the server puts in the hook's environment). A grant the server does not confirm, or a server that does not answer, refuses the push.

### The lock table

A grant checked live at rule 7 must stay live until its ref moves. A push on a task, plan or landing grant holds that task's lock in the Git host from authorization until its backend exits (`src/git/locks.mjs`). Every Ledger change that ends or rotates a grant takes the same lock first, in one place no route, page or tick can skip: the Node runtime's Ledger stub, by the table in `src/runtime/ledger-locks.mjs`. That table lists every Ledger method that writes an item's owner, write token or claim generation, or closes it, and, since task 6, every one that writes an item's head or acceptance (with the task's lock, never as "planned") or the landing lease (with the locks of the task it names and of the lease's current holder), and, since task 13, every one that takes, renews, records, settles or releases a task refresh's lease (with the task's lock). `test/claim-branch-ledger-locks.test.mjs` reads `src/ledger.ts` and fails on one missing. So a landing push the hook found live finishes before the lease or the acceptance can change under it. A change to a part, a plan or several tasks (the plan and stage ticks) takes the project's lock, which waits for every push in the project. So a change waits for the pushes in flight on its task, and a push that starts meanwhile waits for it and is then refused. A push whose client goes while it waits gives up its place at once and starts no backend. Revoking an agent or runner token waits for the pushes made with its grants. Each wait is bounded by a push's own limit: a push's backend is ended after 15 minutes (`PUSH_MAX_MS`), and a change that waits longer is refused with `push_running`.

The hook's secret lives in the environment of processes the server's user runs, so an agent running as that same user could read it while a push is in flight. That is accepted: on the Studio the server runs as `atelierd`, and the user boundary below is the defence.

Every repository names the hook through `core.hooksPath`, and a pushed tree cannot carry a hook into a bare repository.

## The claim, the workspace and the reads

`atelier claim tN` records the claim, then makes `refs/heads/t/N` at the tip of the project's branch unless it exists (`src/git/branches.mjs`, through `git update-ref` with the old value named). A part starts from its plan's branch, `plan/N`. The claim records the branch as the item's workspace (the item field `workspace`, stored in the Ledger's old `fork` column), under the name `PROJECT/t/N`; `src/git/local-repos.mjs` reads that name as the branch, so every read of a task's head, history, scan and diff reads it. The claim records that tip as the base, mints the task grant and records it as the item's write token. It answers with the remote (`ORIGIN/git/PROJECT.git`), the branch, the base, the grant and the project's prose standard with its text. A runner's claim is the same, and its workspace token is the task grant. A branch that holds nothing of its own is moved to the tip its start has reached since, on the next claim.

The remote is given at the address the request came to when that is this machine's or the tailnet's (100.64.0.0/10), and at the public origin otherwise (`gitOrigin` in `src/runtime/server.mjs`). The CLI accepts plain `http://` to a tailnet address, which WireGuard encrypts.

The CLI clones the branch alone (`git clone --single-branch --branch t/N`) and fetches the project's branch from the same remote as the baseline: one remote, `origin`. `atelier push` pushes `HEAD:refs/heads/t/N`. A check's clean clone, `atelier diff` and a review job clone `t/N` alone with a read grant (`git-token` with the item, or `review-claim`'s answer), and fetch the branch the task merges into from the same remote.

`atelier init` makes the project's repository, its HEAD on the project's branch, and mints nothing: the owner's first push of the project's branch, into the empty repository, goes with the server token. Later commits reach it only through a landing. The four commands that pushed the project's branch with the server token on 1.x no longer push on this server (task 11), since the repository is the baseline and the server answers `repository: "server"` from a read grant and `baseline-head`:

- `atelier init` run again records the policy and pushes nothing. It says how the checkout's branch stands against the server's, and names a landing for commits the server lacks, or `atelier pull` for a checkout behind. The first init pushes the whole history in one push; `--history-since` is gone (task 13).
- `atelier sync` goes away. There is no separate baseline to carry commits to; it refuses, naming `atelier pull` for one direction and a landing for the other.
- `atelier wrap` keeps its session note, commit and checkout remotes, and in place of publishing the baseline it reports the server's branch and what the checkout holds beyond it.
- `atelier ship` skips its baseline step, which ran `atelier sync`, and records it as skipped. It already ships only the revision the server's branch holds. Init sends the prose standard's text with its path, so a claim can hand it to a builder with no checkout.

Before Git reads a byte, the server checks the credential. A request with no live grant for this project gets 401 at `info/refs`. A read grant asking to push gets 403.

## The landing

`atelier land tN` runs in two halves (G1 and G2 in `docs/2.0-log.md`; `docs/landing.md` has the steps in full).

1. Without any lease: the preflight and the moved-code comparison; a claimed task is checked and submitted at its recorded head; then triage, the review and the gate.
2. Under the project's landing lease and the registered checkout's lease: accept, then `atelier merge tN --landing` in the registered checkout. It merges, folds the project's regenerate step into the merge commit, runs the checks once on the merged tree, pushes the merge to the project's branch, pushes the provenance notes and records the merge.

Nothing is pushed to `t/N` in either half, so the approvals recorded for the reviewed head stand.

The push to the project's branch goes with a landing grant (`pushMergeToProjectBranch` in `cli/landing.mjs`), and the hook holds it to rule 4: first parent the branch's tip, the accepted head among the parents. The notes go on a push of their own to `refs/notes/atelier` with the same grant. A refused notes push never undoes the merge; the next landing pushes the notes merged with the server's. The merge reads the project's branch with a read grant, so the developer's server token is never a Git credential in a landing. A merge by hand (`atelier merge tN` without `--landing`) takes the landing lease itself for its grant and lets it go when it ends.

The landing's record of its merge (`POST .../merged`) records what the hook confirmed: the merge commit must be the project branch's tip or in its history, read over the whole history, with the accepted head among its parents. `record-merge`, for a merge made outside a landing, refuses a merge the branch does not hold or whose second parent is not the head it names, and applies the gate's independence (G16).

The registered checkout's lease (G9, `src/checkout-lease.ts`) is taken by `atelier merge`, which `land` runs, by `merge --cancel` and by `atelier ship`, before each touches the checkout. A second caller waits, naming the holder. A holder silent for 15 minutes is taken over, and the one taken over stops at its next step boundary with a fact and a `next` command.

## The developer's branches

The developer's branches (`atelier branch push|fetch|ls`, t641) are `dev/NAME` in the project's repository. A push goes with the server token, which alone writes `dev/*`; a fetch goes with a read grant. The server records each push's commit and Mac once the repository holds it. The hook lets `dev/*` be rewritten (`atelier branch push --force`), never deleted, and scans it as it scans a task's branch; an unscanned file there refuses the push, since a developer branch has no item to record it on.

## Moving a project here

A 1.x project comes to the Studio in three steps (design section 5; tasks 10 and 11). Each is the developer's, and none is an owner push.

1. `atelier ledger import --file F --project P` loads the project's Ledger from a dump of the 1.0 server. A dump from older code is migrated to this code's schema, as a start of this code would migrate it, and the rows stored are checked against the dump's counts and checksums before the import finishes. `--abort ID` takes back an import that stopped. A dump made by this code also carries, from the index, the agent and runner tokens that reach the project (limited to any name it has had, or to none), as their hashes, with every name the project has had; the import puts them in this server's index, each limited to the project's name here, so they work with no reissue (G14). A token this server holds under another hash refuses the import. A dump from the 1.0 server carries no tokens: 1.0 has no way to read the index's hashes, so its tokens are reissued at the cut-over.
2. `atelier projects move-host P --from REMOTE [--token-env VAR] [--way-back]` has the server fetch the project's branch, `refs/notes/atelier` and the tags from the Artifacts baseline (or any remote) and set them in the project's repository with `git update-ref`, naming the old value, under the project's lock (`src/git/move.mjs`). The branch must equal the remote's. Run again at the cut-over, it moves the branch on; a branch this server has moved past is left, and one that diverged is refused. The project's prose standard is read from the branch when the 1.x Ledger never stored its text.
3. `atelier migrate tN --from REMOTE` carries a task still on its Artifacts fork: the server fetches the fork and makes `t/N` at the head the Ledger records, under the task's lock, and records the branch as the task's workspace. The holder, claim and head stand. Until then a claim of the task and a task grant for it are refused (`fork_elsewhere`), so no push can make `t/N` apart from that work; afterwards the holder's next claim mints the grant.

A project kept off Atelier brings its own task and decision files with `atelier import-tasks docs/TASKS.md docs/DECISIONS.md`: `- [ ] TITLE` files an open task (indented lines under it are its brief), `- TEXT` records a standing decision, `- [x]` lines are not filed, and any other line refuses the file, naming it. Importing the same file again changes nothing.

What a move adds meets the checks a push would: the server runs the hook's secret scan and private-file guard over it (`src/git/scan-run.mjs`, in batches of at most 400 commits across the full graph, including merge parents, so each stays under the 1,000-commit cap) before any ref moves.

Binary and oversized files in the old baseline are carried and recorded as unscanned on the project's `project.host_moved` event, with file, commit and reason named in the answer. Other scan failures and private files still refuse the move.

The CLI waits up to one hour for this route, so a move can finish past the normal 60-second request limit; `ATELIER_SERVER_TIMEOUT_MS` still overrides it. A key-shaped line refuses the move, naming file and line; the developer clears it with `--clear-secret REASON --quote WORDS`, and the next move lets that line (same file, same fingerprint) through. `move-host` belongs to the migration alone: after `--end-bake`, or once a landing has moved the branch here with no way back kept, it is refused (`bake_over`) and only a landing moves the branch.

## The way back

During the bake that follows the cut-over (design section 5), production can return to the 1.x server. For that the old Artifacts baselines must stay current. With `--way-back` the server keeps the old baseline's remote and its token in `DATA/way-back/P.json`, mode 600, and after each recorded merge pushes the project's branch (and the notes) back to it, never forced. A push that fails is recorded as a `project.way_back` event and named in the merge's answer; the merge stands. `--push-back` retries, and `--end-bake` forgets the old baseline once the bake has passed.

The rest of the way back is the design's plan, not code on this server: point atelier.zone back at the 1.x Worker, restore its Ledger to the bookmark taken before the final dump (`atelier ledger bookmark` and `atelier ledger restore --bookmark ID`, run against the 1.x server), and refile by hand the tasks filed during the bake. Their commits are already on the old baselines through `--way-back`.

## The Studio

The server, the repositories and the record live on the Studio under the macOS service user `atelierd`, in `/Users/atelierd`:

- `data/ENV`: the Ledgers, one SQLite file each (`ledgers/*.sqlite`, the index `ledgers/__index.sqlite`), the grant store, `large/`, and the per-request hook files under `hook-scans/`.
- `repos/ENV`: one bare repository per project, `KEY.git`, every one naming the hook through `core.hooksPath`.
- `secrets/ENV`: the server's settings, one file each.
- `server` and `bin`: the server's code, the hook among it, and `node`, owned by root and read-only to the daemon.

ENV is `staging` or `production`. Each environment is one `node cli/serve.mjs --env ENV` process under a LaunchDaemon (`zone.atelier.server.staging` for staging, on port 4101), and `cloudflared` runs the tunnel as `atelierd` under `zone.atelier.tunnel`. Builders on the tailnet reach the server at the Studio's tailnet address; others reach it through the tunnel, whose hostnames Cloudflare Access guards for the developer's pages (`/api/*` and `/git/*` stay outside Access, and the server checks every credential itself). `docs/studio.md` owns the layout, the setup scripts in `scripts/studio/` and their order.

## Backups and restore

Every night a LaunchDaemon runs `cli/backup.mjs` as `atelierd` (03:00 for production, 03:30 for staging). It copies every Ledger with SQLite's `VACUUM INTO`, the index first, takes a full `git bundle --all` of each repository (notes and `t/*` included) and the `large/` folder, writes a manifest of sizes and SHA-256 sums, encrypts the archive in the age v1 format to a public key, uploads it to R2 and keeps 30 days. The private key never reaches the Studio: `cli/restore.mjs` decrypts on PAVI's Mac, checks the manifest, restores into fresh directories and, with `--check`, starts a server on them; `scripts/studio/setup-restore.sh` installs a checked restore on the Studio. A restore loses at most the day of Ledger records since the backup; commits pushed since are still in the workspaces. `docs/studio.md` gives the setup and the monthly rehearsal.

`atelier ledger bookmark` and `atelier ledger restore` belong to 1.x, whose Durable Objects kept a point-in-time history. The Node server keeps none and refuses both with `not_supported`; on 2.0 the nightly backups, `cli/restore.mjs` and `scripts/studio/setup-restore.sh` take their place.

## What the isolation rests on

All of this holds only if agents cannot reach the server's files. Builders run as `pavi` with permission checks off, so anything `pavi` can write, an agent can write. The repositories, the grant store and the Ledgers therefore belong to a separate macOS user, `atelierd`, and the server's code with the hook belongs to root, read-only to that user. `/Users/atelierd` is root's, group `atelierd`, mode 750, and `pavi` is not in the group, so `pavi` can neither list it nor read or replace anything under it. Crossing that boundary takes the administrator password, which no agent holds.

That makes the macOS user boundary the whole of the isolation. An agent with the administrator password, or a kernel exploit, could rewrite anything on the Studio, record included. Two copies stand outside the Studio: the nightly encrypted backup to R2, and the public mirror on GitHub that `atelier ship` pushes.

## Where things are

- `src/git/grants.mjs`: the grant store.
- `src/git/http.mjs`: Git over HTTP through `git http-backend`.
- `src/git/repos.mjs`: the bare repositories; `src/git/branches.mjs`: a task's branch.
- `src/git/host.mjs`: checks each request against the Ledgers.
- `hooks/pre-receive`: the hook.
- `src/git/scan.mjs`: rules 5 and 6; `src/git/policy.mjs`: the policy and report files; `src/git/reader.mjs`: reads objects through `git cat-file --batch`.
- `test/git-hook.test.mjs` and `test/git-scan.test.mjs`: push with the real client against the real hook.
- `test/claim-branch.test.mjs` and `test/claim-branch-runner.test.mjs`: the claim, the CLI and the runner against the real server.
