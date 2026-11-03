# Carry direct commits into Atelier

When a registered checkout has commits made while Atelier was paused, run:

```
atelier catch-up --project demo --builder codex/gpt-6.1-sol --reviewer claude-code/opus-5.5 --accept "Describe what these commits must accomplish"
```

Give the developer's criteria once per `--accept`. Optional `--title` and
`--brief` describe the task. The checkout must be clean, on its registered
branch, and strictly ahead of the project's baseline by fast-forward. Partial
history projects are refused. The command records the exact checkout head,
creates and claims a task, fetches that head into its workspace, and advances
the workspace by fast-forward. It then runs `done`, which pushes, checks in a
clean clone and submits. A submitted head waiting for review continues even
when `done` reports `checked_but_blocked` (exit 3). Landing asks for the
independent review, waits for approval and lands. A rejection or failed
command stops the catch-up.

The task number is printed after creation. Failure preserves the task and
checkout. Resolve the reported failure in that task rather than starting a
second catch-up. After submission, resume with `land ID --reviewer H/M`.
Stopping the process before landing never prints the completion line.

Landing permits a checkout ahead of the baseline only when it exactly equals
the accepted task head. It checks that tree and publishes a commit with the
baseline tip and accepted head as parents, as the landing grant requires.
The checkout stays at the accepted head; no reset is needed. Extra commits
remain refused. An interrupted landing can resume from its journal at that
same accepted head.
The existing checkout lease, acceptance binding, regeneration, merged-tree
checks and guarded push still apply.

This command uses existing API contracts. Task creation and landing run as
the developer; claiming and task publication name the builder. The server
still checks token project access, task ownership, independent review,
acceptance and landing leases. Git uses the existing task and landing grants.
No route, membership rule, disclosure level or response shape changes.

The changed landing contract is shared by direct `land`, queued runner land
jobs, multi-task landing children and the new catch-up command. They all use
the same `merge --landing` handler. Ordinary `merge` keeps its existing rules.
The command registry supplies CLI help, command usage and the web command
reference (`src/how.ts`); the registry indexes and CLI help fixtures include
the new command. No task page or generated project page consumes a new API.

Local tests use the real Node server, repository and pre-receive hook. Live
reviewer availability and remote service outages remain deployment checks
covered by the project's existing smoke workflow; this change adds no new
platform dependency.
