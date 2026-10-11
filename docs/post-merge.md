# Post-merge steps

Post-merge policy is owner-only. Each landing reserves a durable Ledger run
**before publishing the merge**. Its member task IDs, policy approval, ordered
steps and before/after default-branch SHAs survive executor death, task closure,
lease expiry and manual lease release. All merge routes check that reservation.
A failed step leaves the task merged and blocks the next landing. There is no
batching grace period; later batching must reuse this reservation contract.

## Configure

Bootstrap by deploying the new server manually, then use its matching CLI.
`/api/version` must advertise `postMergeVersion: 1`; init refuses older servers.
The owner runs init in the registered checkout, not a task workspace:

```sh
atelier init \
  --post-merge 'verify=npm test' \
  --post-merge-options 'verify={"class":"check","when":"always","protect":["package.json","test/**"]}' \
  --post-merge 'deploy=npm run deploy' \
  --post-merge-options 'deploy={"class":"deploy","when":{"paths":["src/**","wrangler.*","package*.json"]},"protect":["package.json","wrangler.*","src/**"],"versionUrl":"https://atelier.example/api/version"}' \
  --post-merge-approval 'Owner: authorize these checks and deployment with my credentials'
```

Quote each whole `NAME=CMD` argument; only the first equals sign separates the
name. Quote each `NAME=JSON` options argument with shell single quotes, using
JSON double quotes inside. Step order is the order of `--post-merge` entries.
Names must be unique identifiers (letter first, then letters/digits/underscore/
hyphen, at most 64 characters). Every name needs exactly one options object.
Classes and conditions are mandatory. Conditions are `"always"` or
`{"paths":["GLOB",...]}`. Patterns use Atelier's existing case/Unicode-folded
path-glob matcher: `*` stays within a directory, `**` crosses directories.
The server measures the **net diff of the recorded before and after trees**,
including deleted paths and both names of a rename. Missing trees/history
block execution. Nonmatching steps are recorded as `not_applicable`.

At most 30 steps are allowed. `timeoutMs` defaults to 1200000 (20 minutes),
with a range of 1000..3600000. `protect` must explicitly name trusted script
and configuration globs. Because scripts can import other code dynamically,
configuring steps conservatively makes the entire repository protected for
review, in addition to recording these declared inputs. The approval is
stamped by the server with the owner's actor and time. This authorization is
separate from ordinary read-only checks; their deployment/install/publication
refusals remain unchanged. A `check` step has those same command refusals.

Omitting all post-merge options preserves policy. `--post-merge ''` alone
clears it. `--reset` clears it unless replacement steps are supplied. Clearing
policy does not clear a reservation or alter its snapshot. Projects without
steps keep their existing merge behavior.

## Execution and recovery

CLI land and Workflow land both use the merge executor and the same Ledger
run. Workflow waits for the run to complete after the task becomes merged.
The owner machine supplies the executor, Git, Node/npm and credentials. Each
attempt starts in a fresh clone checked out detached at the recorded merged
SHA, never a moving branch. Node projects require a committed package-lock.json
and run `npm ci --no-audit --no-fund` before check/deploy commands. Installation
and its lifecycle scripts are part of the approved source. Checks receive the
existing filtered check environment; deploy and publish receive the owner's
environment. This is trusted owner code, not a sandbox: processes can read
files permitted to the owner. Publish supports an owner-provided GIT_ASKPASS;
Git ignores global/system config and hooks and sends the baseline read token
only on the clone request.

Clone, setup, execution, privacy scans and push share the configured deadline.
Each child runs in a process group killed on completion, timeout, output limit
or handled executor signal, including tracked descendant groups. Processes
that deliberately detach with setsid and SIGKILL of the executor cannot be
reliably cleaned up by local user-space code. A lost attempt therefore blocks
and must be reconciled, never automatically replayed. Stop remaining processes
before reconciliation. Attempts are persisted before any command starts and
only their unique token may finish them. Concurrent starts cannot acquire the
same attempt. After its deadline plus ten minutes an unreported attempt reads
as `uncertain`; it blocks both before and after that deadline.

```sh
atelier land t123 --post-merge status
atelier land t123 --post-merge resume
atelier land t123 --post-merge retry --reason 'Fixed the failed dependency setup'
atelier land t123 --post-merge skip --reason 'Owner waives this step because ...'
atelier land t123 --post-merge reconcile --resolution no-effect --reason 'Stopped executor; verified no external effect'
```

`resume` runs pending work, `retry` authorizes the failed unresolved step and
then resumes, and `skip` records a waiver and continues. Passed and nonmatching
steps never replay. Retry/skip of a running or uncertain attempt is refused.
After stopping its executor, the owner reconciles it as `no-effect` (leaving a
failed step for retry/skip) or `completed` (recording a confirmed external
effect). Reconciling deploy as completed independently checks its version again: the
observation must pass, or the owner must explicitly waive it. Reconciliation records the explanation
and invalidates stale outcome reports. Status and task/project history include
run, SHAs, policy snapshot, step, attempt and outcomes. Raw command output is
bounded to 1 MiB during execution and withheld in the durable record because
arbitrary owner tools may print credentials; error values are never logged.

Deploy commands are exactly `npm run deploy`. A command exit of zero is not
proof of deployment: the Worker independently fetches the configured HTTPS
`versionUrl` without credentials or redirects, and requires the pinned commit
and a route level at least its own and the constant in the pinned src/route-level.ts when present. Command outcomes are persisted before this observation. A mismatched version records failure;
an interrupted outcome report remains blocked for reconciliation. Keep the
owner's Cloudflare credentials available in the executor environment. Recovery
may require a manual bootstrap deployment if the currently deployed server
cannot serve the new routes. Init and production deploy are owner rollout
steps, not something tests perform.

## Controlled publication privacy

A `publish` step's command must be exactly `git push`. Its options additionally
require an explicit credential-free HTTPS `destination`, a single explicit
`refs/heads/...` ref, and `privacy`:

```json
{
  "authors": [{"name":"Owner","email":"owner@example.org"}],
  "committers": [{"name":"Owner","email":"owner@example.org"}],
  "patterns": ["literal confidential marker"],
  "forbiddenPaths": ["private/**", ".env", "secrets/**"]
}
```

Author and committer pairs are separate exact, case-sensitive allowlists.
`patterns` are case-sensitive literal substrings, not regular expressions,
globs or secret-detector heuristics. They scan every outgoing commit's full
message, every tree path and every blob's UTF-8 text (including symlink blobs).
`forbiddenPaths` use the same path-glob matcher as conditions. Dates and Git
signatures are not identity allowlist fields. Policies must name the private
markers they intend to exclude; an empty pattern list detects none.

The executor fetches the destination's exact tip and enumerates every commit
newly reachable from the pinned source, traversing **all parents**. It scans
each commit's full tree, so an added-then-removed secret is rejected even when
the final tree is clean. Shallow, missing or unreadable history, submodule
content and scan output over 16 MiB fail closed. After scanning it re-reads the
remote tip; a change requires a fresh scan. Push uses the exact source SHA,
explicit URL/ref, fast-forward ancestry, no hooks/tags/submodule pushes, and an explicit
`--force-with-lease=REF:TIP` (empty TIP for a new ref). A change after the final
read is rejected atomically by Git. This publishes no other ref or notes. A configured publish step also suppresses the legacy automatic notesRemote push, so it cannot publish an unscanned ref.
Privacy failures identify the commit/path locally without including the
matching secret value; raw output is withheld from the ledger.

## Required owner rollout smoke

Local tests cover Git history and SQLite/Workflow state transitions. They do
not reproduce production Artifacts history availability, Cloudflare deployment
propagation, credential access, Workflow retention or remote Git lease behavior.
Before and after deployment, run this smoke in an owner-controlled project:

1. Configure a harmless always check, a path-conditioned check and an approved
   deployment with its real version URL. Confirm init preserves/clears policy.
2. Land through CLI and then Workflow; queue a second landing and confirm it
   cannot merge until the first run's deployment commit and route level match.
3. Kill the executor during an external step, release/expire its lease, and
   confirm the next merge remains blocked. Stop children, reconcile, retry or
   waive; confirm passed steps never replay.
4. Use a disposable publication destination with a second-parent and an
   add-then-remove private marker. Confirm rejection before any push. Move the
   destination during scanning and confirm rescan or lease rejection.
5. Confirm status/history contain outcomes and waivers without credentials.
