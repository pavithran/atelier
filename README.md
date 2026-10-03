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
3. **PAVI decides.** Work reaches the project only when PAVI accepts it and
   merges it. Changes to protected paths also need approval from a model other
   than the owner's, or from PAVI.

The web inbox answers one question, *what needs PAVI now?*, and ranks the
things a person must decide above the things an agent must fix.

## How it works

In outline: a project's main branch is copied into an Artifacts repository,
the *baseline*. Each item is a fork of the baseline, its *workspace*. Agents
work in their workspace, push to it, and run checks against it. PAVI merges
accepted work into the real checkout, and the baseline follows.

In detail:

| Step | Who | What happens |
| --- | --- | --- |
| `atelier init` | PAVI, in the project checkout | Creates the baseline repository and pushes the current branch to it. Records the required checks and the protected paths. |
| `atelier new "title" --scope 'src/**'` | anyone | Creates an item. The scope is what the item intends to touch; overlapping live scopes are flagged in the inbox. |
| `atelier claim t3 --as claude-code/opus-5.5` | an agent | The project's Durable Object grants ownership atomically, so a second claimant is refused. The Worker forks the baseline and mints an eight-hour write token for the owner alone. The CLI clones the workspace into `~/Library/Caches/ai-projects/cloudflare-git/work/`. |
| `atelier push` | the owner | Pushes, then asks the Worker to read the workspace head from Artifacts. The ledger records the head Atelier saw, not the one the agent named. |
| `atelier check` | anyone | Clones the workspace afresh at that head, runs each required check, measures which paths changed since the baseline, and records the results as Observed. A result for a head that has since moved is refused. |
| `atelier report "…"` | anyone | Records a Reported claim. It is shown and never counted. |
| `atelier submit` | the owner | Marks the item ready. The gate states what still blocks it. |
| `atelier handoff t3 --to codex/gpt-5.5` | the owner or PAVI | Moves ownership and revokes the old write token. The workspace and its history carry over; the work is not forked again. |
| `atelier review t3 --approve` | a different agent, or PAVI | Required when the item changes a protected path. A reviewer of the same model as the owner does not count. |
| `atelier accept t3` | PAVI, or the Accept button | Allowed only when the gate is clear. Pins the accepted head. |
| `atelier merge t3` | PAVI, in the project checkout | Fetches exactly the accepted head, merges it with `--no-ff`, attaches the item's provenance as a git note on `refs/notes/atelier`, and pushes the new main to the baseline. Pushing to GitHub stays a separate, deliberate step. |

The gate for acceptance is a pure function in [`src/rules.ts`](src/rules.ts):
every required check observed passing at the current head; the changed paths
observed; no rejection at that head; and, if a protected path changed, an
approval at that head from a different model or from PAVI. Files named by a
check command (`./check.sh`, `scripts/verify.mjs`) are protected
automatically, so an item cannot weaken the check that grades it.

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

- **Identity is declared.** Every caller shares one API token, and the actor
  name (`harness/model`) is what the caller says it is. The token proves only
  that the caller is one of PAVI's own tools. The write token is what stops
  a non-owner from pushing.
- **Checks run on the caller's machine.** "Observed" means Atelier's own
  runner ran the check in a clean clone at the verified head. That defeats
  the common failures (a dirty tree, a stale head, a check that was never
  run) but not an agent that forges API calls. Running checks inside
  Cloudflare Sandbox or Containers would close that gap and is not built.
- **Merging happens locally.** The Artifacts binding has no merge operation,
  and the iCloud checkout is the source of truth, so `atelier merge` merges
  with the local git.

## Setup

Requirements: Node 24 or later, git, a Cloudflare account on the Workers Paid
plan (Artifacts is in open beta there), and `wrangler` logged in.

```bash
npm install && npm run types && npm test
```

Write the server token into the Keychain once, by hand:

```bash
security add-generic-password -s atelier.API_TOKEN -a pavi -w
```

Deploy, then make the Worker's secret match the Keychain:

```bash
npx wrangler deploy
```

```bash
security find-generic-password -s atelier.API_TOKEN -w | tr -d '\n' | npx wrangler secret put ATELIER_TOKEN
```

Point the CLI at the Worker and register a project:

```bash
npm link
```

```bash
atelier login --server https://atelier.example.workers.dev
```

```bash
atelier init --check "npm test" --protect AGENTS.md --protect "wrangler.*"
```

Run `init` inside the project checkout. `atelier guide` prints the
instructions an agent needs; paste them into the project's `AGENTS.md` or
`CLAUDE.md`.

## Local development

`npm run dev` serves the Worker on localhost. The Artifacts binding always
reaches the real account, even locally, so local runs create real
repositories. Pass a throwaway token with
`npx wrangler dev --var ATELIER_TOKEN:localtest`; do not write `.dev.vars`
into an iCloud project.

## Cost

Artifacts bills operations and storage from 14 October 2026: the first
10,000 operations and 1 GB each month are included in Workers Paid, then
$0.15 per thousand operations and $0.50 per GB-month. One item uses a fork,
a few token mints and a handful of pushes, fetches and clones, so ordinary
use should stay inside the included allowance. That is an estimate from the
operations the CLI performs, not a measurement.

## Licence

MIT. See [LICENSE](LICENSE).
