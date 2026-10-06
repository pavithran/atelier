# Demo walkthrough

A script for the competition video: eight to ten minutes, recorded against
the live server at `https://atelier.zone` with real agents. The entry needs
a 5–10 minute video of what was built, what it lets agents and developers
do, and how it works; this script covers the three in that order.

Every command below exists in the CLI as of this document. Spoken lines are
suggestions; the facts in them are the ones to keep.

## Before recording

1. **Sandbox-only for the demo project.** In the `cloudflare-git` checkout:

   ```text
   atelier init --title "Atelier" --check "npm ci --prefer-offline --no-audit --no-fund && npm test" --check "npm run types && npm run typecheck" --protect src/rules.ts --protect src/ledger.ts --protect src/index.ts --sandbox-only
   ```

   Re-running `init` keeps every item. `--title` gives the project a display
   title on the pages; commands still use its name. From then on only checks
   Atelier runs in a Cloudflare container count.

2. **Three small items with separate scopes**, created by the owner:

   ```text
   atelier new "Show the time each check took on its row" --scope src/ui.ts
   atelier new "Explain overlap refusal in the guide" --scope cli/atelier.mjs
   atelier new "Name the sandbox actor in the rules" --scope src/rules.ts
   ```

   The third touches a protected file, so it will need a review from a model
   other than its owner's. Note the ids the commands print; the script calls
   them A, B and C.

3. **Three agent sessions**, each opened in the `cloudflare-git` folder:
   Claude Code, Codex and GLM. Do not start them yet.

4. **Screens.** Browser at `https://atelier.zone/studio`, signed in, in a
   window wide enough for the lanes and the flow graph (about 1440 px). One
   terminal for the owner. The pages use the Night theme and follow the
   device's light or dark setting; pick one and keep it.

5. **A dry run** of sections 3 to 5 the day before, and a look at the Flow
   page once the items have merged, so the replay has something to draw. Agents take minutes, not
   seconds; record their work at normal speed and cut or speed it up in the
   edit, never by restaging.

## Script

| Time | Screen | What happens |
| --- | --- | --- |
| 0:00–0:30 | Studio | The floor with three lanes moving. |
| 0:30–1:15 | Studio, then Decisions | The problem and the three rules. |
| 1:15–2:30 | Terminals | Three agents take three items at once. |
| 2:30–3:30 | Terminal, Studio | A refused claim and a handoff. |
| 3:30–5:00 | Terminal, item page | Evidence: a check in a Cloudflare container. |
| 5:00–6:30 | Decisions, item page | A cross-model review, then the owner decides. |
| 6:30–7:15 | Owner terminal | Merge, provenance and the receipt. |
| 7:15–8:00 | Flow | The whole story as a graph, replayed. |
| 8:00–9:15 | Diagram | How it is built. |
| 9:15–9:35 | README | Where to try it. |

### 0:00–0:30 · The floor

Open on the Studio with all three agents working. Let a mark appear.

> Three coding agents, three different models, working on one codebase at the
> same time. Each lane is one task. The bands show who has held it; the marks
> are every claim, push, check and review, as they happen. This is Atelier.

### 0:30–1:15 · The problem and the rules

> Git was built for people who take turns. Agents don't. Run several at once
> and they collide in the same checkout, they say tests passed when nobody
> checked, and every change still needs a person to decide. Atelier rests on
> three rules. Every task has exactly one owner. Evidence is graded: a check
> Atelier ran itself counts; a claim an agent makes is only reported. And the
> project owner decides what reaches the project.

Click to Decisions. Point at "On the floor" and the empty queue. With
nothing waiting, the page shows the latest project's graph instead.

> Decisions shows only what needs a person, and who is at work right now.
> When nothing is waiting, it says so and draws the latest work.

### 1:15–2:30 · Three agents, three items

In each agent session, say "Take A", "Take B", "Take C" (one per agent).
Show the claim output in one terminal: the workspace path, and the line
"Commits here are authored as … as in the project checkout".

> Each claim gives the agent its own fork of the project in Cloudflare
> Artifacts, and a write token for that fork alone. The project checkout on my
> Mac is never touched. Three agents, three forks, one baseline.

Cut to the Studio: three lanes, each with a square for its claim.

### 2:30–3:30 · One owner, enforced

In the owner terminal, try to claim an item an agent already holds:

```text
atelier claim A --project cloudflare-git --as codex/gpt-6
```

It is refused: the item is owned. Then hand an item over, as the owner:

```text
atelier handoff B --project cloudflare-git --to claude-code/opus-5.5 --as pavi --note "Reassigning"
```

> A handoff moves ownership and revokes the old owner's token. The work is not
> copied; the new owner picks up the same fork. On the Studio, that is the
> change of band.

Cut to the Studio: lane B now has two bands and a double chevron.

### 3:30–5:00 · Evidence

When an agent finishes, it runs `atelier finish`. Under sandbox-only that
pushes, runs the required checks in a Cloudflare container, and submits.
Show the output lines ending "(…s, in Cloudflare)".

> The checks ran in a fresh Cloudflare container started from the
> Worker. The container never holds a token: the Worker streams the item's
> exact files from Artifacts into it. Its Internet is off; the only host it can
> reach is the npm registry, and only to download. The result is recorded by
> the Worker itself, marked as observed in a container. Nothing an agent sends
> to the API can claim that.

Open the item page. Point at "Checks passed in a Cloudflare container" and at
a check row's "Cloudflare" label. If an agent also ran a check on its own
machine, point at the row that says it does not count here.

### 5:00–6:30 · Review and decision

Item C changes `src/rules.ts`, a protected file. In a session of a model of
another family than C's owner, say "Review C". It runs `atelier diff` and
`atelier review … --approve`.

> Changes to protected files need approval from a model of another family
> than the one that wrote them. An agent cannot approve its own work, and my
> approval doesn't count either: I accept. If no such reviewer exists, I can
> override the review, and the reason goes on the record.

On Decisions, select item A. Show the diff, the evidence, and "Approve
revision" or "Accept revision".

> Every action is bound to the revision on screen. If the agent pushes again
> while I'm reading, the button refuses and asks me to look again.

Accept the item.

### 6:30–7:15 · Merge and provenance

Once accepted, the item page shows the exact command; copy it:

```text
atelier merge A --project cloudflare-git --head FULL_REVISION
```

Then:

```text
git log -1 --notes=atelier
```

> The merge goes into my real checkout, and the item's whole history, with
> who held it, what was observed and who approved, is attached to the merge
> commit as a git note. Nothing was deployed and nothing was pushed to GitHub;
> those stay my decisions.

For a ControlPlane project such as ikon weblog, the merge also writes a
landing receipt in the project's own format. Mention it; there is no need to
show it.

### 7:15–8:00 · The flow

Click to Flow. Press "Replay" on the project and let the graph draw in. Then
hover a few marks: a push, a check, a review, a decision. Each shows a card
saying what happened.

> This is the same work as one picture. The line along the top is main. Each
> coloured thread is a task an agent took off it, coloured by the agent's
> family. The beads are its pushes, its checks, the reviews from other models
> and my decision; the thread returns to main only when I accept and merge it.
> The tally says how many moves the agents made and how many decisions were
> mine. The agents did the work; I decided what reached the project.

Point at the tally and, if it applies, the count of times a model sent work
back. Everything on the page is drawn from the ledger; none of it is staged.

### 8:00–9:15 · How it is built

Show this diagram, or draw it.

```text
 agents (any harness)          owner
   │ atelier CLI                │ browser · CLI
   ▼                            ▼
 ┌──────────────── Cloudflare Worker (atelier.zone) ────────────────┐
 │  Ledger: one Durable Object per project — items, owners,          │
 │          graded evidence, reviews, every event                    │
 │  CheckRunner: one Durable Object + container per check run        │
 │ Pages: Decisions · Flow · Studio · Projects · History (no script) │
 └───────────────┬──────────────────────────────────┬────────────────┘
                 │ Artifacts binding                 │ egress gateway
                 ▼                                   ▼
   baseline repo + one fork per item          registry.npmjs.org (GET only)
```

> A Durable Object per project makes "exactly one owner" a matter of
> construction: it handles one request at a time, so two agents claiming the
> same task are serialised and the second is refused. Artifacts gives every
> task its own fork and every owner its own short-lived token. The check
> runner is a container started from a Durable Object with Cloudflare's
> managed image: no Dockerfile, no image to build. And the CLI has no
> dependencies; any agent that can run a shell command can use it.

### 9:15–9:35 · Close

Show the README at `https://github.com/pavithran/atelier`.

> Atelier is open source under MIT. The README has everything needed to run
> your own.

## What the video must not claim

- **Identity is declared, not authenticated.** Every caller shares one API
  token, and an actor's name is what it says it is. What enforces ownership
  is the per-fork write token. Do not say agents are authenticated.
- **Push events are not provisioned.** The handler for Artifacts push events
  exists, but no queue or subscription is set up on the live server, so
  pushes are recorded when an agent runs `atelier push`. Do not show or claim
  automatic push detection.
- **Merging happens on the owner's machine**, in local git, because the
  Artifacts binding and REST API can read repositories but cannot write; the
  only way to write is a git push with a write token. The checkout is the
  source of truth.
- **"Observed" from an agent's machine is weaker than from a container.**
  Under sandbox-only it does not count, and the pages say so. Do not describe
  local checks as verified.

## Trying it

The README's Setup section is the run instructions for the entry: deploy the
Worker, set its token, link the CLI, and run `atelier init` in a project.
