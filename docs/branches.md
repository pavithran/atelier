# Branches and write isolation on the Studio

Atelier 2.0 keeps each project in one bare Git repository on the Studio, and each task works on a branch of it, `t/N`. This page says how one holder per task still holds when every task shares a repository. The design is in `design-branches-2026-10-28.md`, sections 4.3 and 4.4.

## What enforces it

A builder could write to any branch of a shared repository if nothing stopped it. Two things stop it.

**Every Git credential is a grant the server minted.** The server stores only its SHA-256 (`src/git/grants.mjs`). A grant is bound to one project and one kind:

| Kind | Writes | Lives |
|---|---|---|
| `task` | `refs/heads/t/N` of its task | while the task's Ledger records it |
| `read` | nothing; reads every branch | 8 hours |
| `landing` | the project's branch, once, with a merge of the accepted head | 5 minutes |
| owner | the project's branch and `refs/heads/dev/*` | the server token itself |

A task grant counts only while the task's Ledger records it as the item's write token (`git:HASH` in `items.token_id`). The Ledger already changes that record on every change of holder: release, handoff, abandon, merge and a new claim. So each of those revokes the grant with no extra step, and asking for a new grant replaces the old one. A task has one live write credential at a time.

`POST /api/projects/P/git-token` with `{"kind": "read"}` or `{"kind": "task", "item": "tN"}` gives one. A task grant goes only to the task's holder.

**The pre-receive hook refuses every ref update the grant does not cover** (`hooks/pre-receive`). The server runs `git receive-pack` with the grant's id and binding in the environment, never its token, and the hook applies four rules to the ref update:

1. One ref per push, the one the grant names. Any other ref is refused with `atelier: this credential writes t/N only`.
2. No deletes. The server deletes task branches itself after a merge.
3. The project's branch and `plan/*` move by fast-forward only. A task branch may be rewritten (`atelier update` rebases); the Ledger decides whether a rewritten head counts.
4. A landing push must be a merge whose first parent is the branch's tip and whose parents include the accepted head.

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

- A landing grant must carry its task id, so the task's clearances apply to the landing push. The route that mints landing grants is a later task (task 6).
- Until then the landing's push carries the developer's credential. Since G2 it is one function, `pushMergeToProjectBranch` in `cli/landing.mjs`, which pushes the merge commit alone to the project's branch (rule 4's shape: first parent the branch's tip, the accepted head among the parents); task 6 swaps that credential for a landing grant minted to the holder of the landing lease. The provenance notes go on a push of their own, which the hook refuses (one ref per push, and no grant writes `refs/notes/atelier`), so on this server they stay in the developer's checkout.
- Allowed lines (`docs/atelier/privacy-allow.json`) are dropped before the report. The owner sees them only in the allowance file's diff.

Every repository names the hook through `core.hooksPath`, and a pushed tree cannot carry a hook into a bare repository.

Before Git reads a byte, the server checks the credential. A request with no live grant for this project gets 401 at `info/refs`. A read grant asking to push gets 403.

## What the isolation rests on

All of this holds only if agents cannot reach the server's files. Builders run as `pavi` with permission checks off, so anything `pavi` can write, an agent can write. The repositories, the hooks, the grant store and the ledger therefore belong to a separate macOS user, `atelierd`. `pavi` cannot read or replace them (mode 700 at the top of `/Users/atelierd`). Crossing that boundary takes the administrator password, which no agent holds.

That makes the macOS user boundary the whole of the isolation. An agent with the administrator password, or a kernel exploit, could rewrite anything on the Studio, record included. Two copies stand outside the Studio: the nightly encrypted backup to R2, and the public mirror on GitHub that `atelier ship` pushes.

## Where things are

- `src/git/grants.mjs`: the grant store.
- `src/git/http.mjs`: Git over HTTP through `git http-backend`.
- `src/git/repos.mjs`: the bare repositories.
- `src/git/host.mjs`: checks each request against the Ledgers.
- `hooks/pre-receive`: the hook.
- `src/git/scan.mjs`: rules 5 and 6; `src/git/policy.mjs`: the policy and report files; `src/git/reader.mjs`: reads objects through `git cat-file --batch`.
- `test/git-hook.test.mjs` and `test/git-scan.test.mjs`: push with the real client against the real hook.
