# Branches and write isolation on the Studio

Atelier 2.0 keeps each project in one bare Git repository on the Studio, and each task works on a branch of it, `t/N`. This page says how one holder per task still holds when every task shares a repository. The design is in `design-branches-2026-10-28.md`, sections 4.3 and 4.4.

## What enforces it

A builder could write to any branch of a shared repository if nothing stopped it. Two things stop it.

**Every Git credential is a grant the server minted.** The server stores only its SHA-256 (`src/git/grants.mjs`). A grant is bound to one project and one kind:

| Kind | Writes | Lives |
|---|---|---|
| `task` | `refs/heads/t/N` of its task | while the task's Ledger records it |
| `read` | nothing; reads every branch | 8 hours |
| `landing` | the project's branch, once, with a merge of its task's accepted head; and `refs/notes/atelier` | 5 minutes, while its holding of the landing lease and the acceptance stand, until the merge is recorded |
| owner | the project's branch only to create it in an empty repository; `refs/heads/dev/*` and `refs/notes/atelier` | the server token itself |

A task grant counts only while the task's Ledger records it as the item's write token (`git:HASH` in `items.token_id`). The Ledger already changes that record on every change of holder: release, handoff, abandon, merge and a new claim. So each of those revokes the grant with no extra step, and asking for a new grant replaces the old one. A task has one live write credential at a time.

`POST /api/projects/P/git-token` with `{"kind": "read"}` or `{"kind": "task", "item": "tN"}` gives one. A task grant goes only to the task's holder.

`{"kind": "landing", "item": "tN", "head": H}` gives a landing grant (task 6, design section 4.7). It goes only to the holder of the project's live landing lease, for that task, while the task is accepted at H; otherwise the route refuses with `no_lease`, `not_accepted` or `acceptance_changed`, each naming the next command. The grant is bound to the project, the task, H and the holding of the lease it was minted under (the lease's `id`, drawn afresh at every take or takeover and kept by a renewal). It counts only while the task is still accepted at H and that holding still stands, so a lease released, taken over or released and retaken, or an acceptance withdrawn, ends it for good. It updates the project's branch once: the hook's last check (rule 7) takes that update in the grant store in one statement, and a second update with the same grant is refused, while its notes stay writable. It lives five minutes and is revoked once the landing's merge is recorded, so a used grant gets 401. Since the grant names its task, the hook's scan of the landing push applies the clearances the owner recorded on that task.

**The pre-receive hook refuses every ref update the grant does not cover** (`hooks/pre-receive`). The server runs `git receive-pack` with the grant's id and binding in the environment, never its token, and the hook applies four rules to the ref update:

1. One ref per push, the one the grant names. Any other ref is refused with `atelier: this credential writes t/N only`. Landing and owner grants also write Atelier's provenance notes, `refs/notes/atelier`, on a push of their own; a task or plan grant never does.
2. No deletes. The server deletes task branches itself after a merge.
3. The project's branch, `plan/*` and `refs/notes/atelier` move by fast-forward only. A task branch may be rewritten (`atelier update` rebases); the Ledger decides whether a rewritten head counts.
4. A landing push to the project's branch must be a merge whose first parent is the branch's tip and whose parents include the accepted head. The owner's credential (the server token, which the orchestrator holds) only creates the project's branch in an empty repository; after that only a landing grant moves it, and an owner push to it is refused naming `atelier land`. So no credential carries an unreviewed change onto the project's branch.

For a push those four allow, the hook then reads the pushed files (`src/git/scan.mjs`):

5. The secret scan. It reads the lines every added commit adds, with the patterns and fingerprints of `src/secret-scan.ts`, and honours `docs/atelier/privacy-allow.json` at the pushed head. A key-shaped line refuses the push, naming file, line and commit, never the value. A line the owner cleared with `atelier clear-secret` (same file, same fingerprint) passes.
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

For later:

- The landing pushes with a landing grant (task 6). `pushMergeToProjectBranch` in `cli/landing.mjs` pushes the merge commit alone to the project's branch, and the hook holds it to rule 4: first parent the branch's tip, the accepted head among the parents. The provenance notes go on a push of their own to `refs/notes/atelier` with the same grant (rule 1); a refused notes push never undoes the merge, and the next landing pushes the notes merged with the baseline's. The merge reads the project's branch with a read grant, so the developer's server token is never a Git credential in a landing. A merge by hand (`atelier merge tN` without `--landing`) takes the landing lease itself for its grant and lets it go when it ends.
- The landing's record of its merge (`POST .../merged`) records what the hook confirmed: the merge commit must be the project branch's tip or in its history, read over the whole history, with the accepted head among its parents. `record-merge`, for a merge made outside a landing, refuses a merge the branch does not hold or whose second parent is not the head it names, and applies the gate's independence (G16).
- Allowed lines (`docs/atelier/privacy-allow.json`) are dropped before the report. The owner sees them only in the allowance file's diff.

7. The grant is still live. Last, the hook asks the server whether the grant it was let in with still counts and its actor still holds the task (`POST /internal/grant-live` on a loopback listener of its own, with a random per-process secret the server puts in the hook's environment). A grant the server does not confirm, or a server that does not answer, refuses the push.

A push on a task, plan or landing grant holds that task's lock in the Git host from authorization until its backend exits (`src/git/locks.mjs`). Every Ledger change that ends or rotates a grant takes the same lock first, in one place no route, page or tick can skip: the Node runtime's Ledger stub, by the table in `src/runtime/ledger-locks.mjs`. That table lists every Ledger method that writes an item's owner, write token or claim generation, or closes it, and, since task 6, every one that writes an item's head or acceptance (with the task's lock, never as "planned") or the landing lease (with the locks of the task it names and of the lease's current holder). `test/claim-branch-ledger-locks.test.mjs` reads `src/ledger.ts` and fails on one missing. So a landing push the hook found live finishes before the lease or the acceptance can change under it. A change to a part, a plan or several tasks (the plan and stage ticks) takes the project's lock, which waits for every push in the project. So a change waits for the pushes in flight on its task, and a push that starts meanwhile waits for it and is then refused. A push whose client goes while it waits gives up its place at once and starts no backend. Revoking an agent or runner token waits for the pushes made with its grants. Each wait is bounded by a push's own limit: a push's backend is ended after 15 minutes (`PUSH_MAX_MS`), and a change that waits longer is refused with `push_running`.

The hook's secret lives in the environment of processes the server's user runs, so an agent running as that same user could read it while a push is in flight. That is accepted: on the Studio the server runs as `atelierd`, and the user boundary below is the defence.

Every repository names the hook through `core.hooksPath`, and a pushed tree cannot carry a hook into a bare repository.

## The claim, the workspace and the reads

`atelier claim tN` records the claim, then makes `refs/heads/t/N` at the tip of the project's branch unless it exists (`src/git/branches.mjs`, through `git update-ref` with the old value named). A part starts from its plan's branch, `plan/N`. The claim records the branch as the item's fork, under the name `PROJECT/t/N`; `src/git/artifacts.mjs` reads that name as the branch, so every read of a task's head, history, scan and diff reads it. The claim records that tip as the base, mints the task grant and records it as the item's write token. It answers with the remote (`ORIGIN/git/PROJECT.git`), the branch, the base, the grant and the project's prose standard with its text. A runner's claim is the same, and its workspace token is the task grant. A branch that holds nothing of its own is moved to the tip its start has reached since, on the next claim.

The remote is given at the address the request came to when that is this machine's or the tailnet's (100.64.0.0/10), and at the public origin otherwise (`gitOrigin` in `src/runtime/server.mjs`). The CLI accepts plain `http://` to a tailnet address, which WireGuard encrypts.

The CLI clones the branch alone (`git clone --single-branch --branch t/N`) and fetches the project's branch from the same remote as the baseline: one remote, `origin`. `atelier push` pushes `HEAD:refs/heads/t/N`. A check's clean clone, `atelier diff` and a review job clone `t/N` alone with a read grant, which `read-token`, `base-token` and `review-claim` answer on this server.

`atelier init` makes the project's repository, its HEAD on the project's branch, and mints nothing: the owner's first push of the project's branch, into the empty repository, goes with the server token. Later commits reach it only through a landing, so `atelier init` run again with new commits, `atelier sync`, `atelier wrap`'s baseline step and `atelier ship`'s baseline step, which push the project's branch with the server token, are refused by the hook on this server. Init sends the prose standard's text with its path, so a claim can hand it to a builder with no checkout.

Before Git reads a byte, the server checks the credential. A request with no live grant for this project gets 401 at `info/refs`. A read grant asking to push gets 403.

## What the isolation rests on

All of this holds only if agents cannot reach the server's files. Builders run as `pavi` with permission checks off, so anything `pavi` can write, an agent can write. The repositories, the hooks, the grant store and the ledger therefore belong to a separate macOS user, `atelierd`. `pavi` cannot read or replace them (mode 700 at the top of `/Users/atelierd`). Crossing that boundary takes the administrator password, which no agent holds.

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
