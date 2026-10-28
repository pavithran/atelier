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

**The pre-receive hook refuses every ref update the grant does not cover** (`hooks/pre-receive`). The server runs `git receive-pack` with the grant's id and binding in the environment, never its token, and the hook applies four rules:

1. One ref per push, the one the grant names. Any other ref is refused with `atelier: this credential writes t/N only`.
2. No deletes. The server deletes task branches itself after a merge.
3. The project's branch and `plan/*` move by fast-forward only. A task branch may be rewritten (`atelier update` rebases); the Ledger decides whether a rewritten head counts.
4. A landing push must be a merge whose first parent is the branch's tip and whose parents include the accepted head.

The hook reads only ref commands and commit parents, never a pushed file. Every repository names the hook through `core.hooksPath`, and a pushed tree cannot carry a hook into a bare repository.

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
- `test/git-hook.test.mjs`: pushes with the real client against the real hook.
