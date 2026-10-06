# Harness confinement design

Status: design, recorded 2026-10-06 (t168, following t161's ship work).
Nothing described here is built; this document is the decision the building
would follow.

**Recommendation.** Run each home-runner task as a launchd job whose program
wraps the harness in a `sandbox-exec` profile that allows the workspace, the
toolchain caches and nothing else of the owner's home, and denies the
Keychain, the owner's Atelier and git credentials, and the execution of
`/usr/bin/security`. Keep the Cloudflare sandbox (`atelier check --sandbox`)
for checking untrusted code, and keep every protected action with the owner:
`atelier ship` already runs as the owner in the registered checkout and no
part of it should move inside a task's confinement. Escalate to a dedicated
macOS user per task, started by the same launchd mechanism, when a project's
policy demands more than a profile gives. The phases and their costs are
below.

## What confines a task today

The home runner (`cli/runner.mjs`) starts each harness in the task's
workspace, a clone under `~/Library/Caches/ai-projects/cloudflare-git/work/`:

- **No Atelier credentials reach the harness.** The runner claims, pushes and
  finishes as itself; the brief tells the holder to run no atelier command.
  The environment the harness receives is `harnessEnv`: the variables
  toolchains need, nothing named `ATELIER_*`, nothing whose name says it
  holds a secret, and the owner's Atelier token withheld whatever its name.
- **One process group per run**, ended with SIGTERM then SIGKILL on exit,
  deadline or interrupt, so nothing the harness started outlives the run.
  A process that leaves the group (`setsid`) is beyond this, and the comment
  in `cli/runner.mjs` says so.
- **Checks run in a clean clone**, or in a Cloudflare container with
  `--sandbox`, which is the strongest confinement Atelier has: no owner
  files, no owner network, no owner identity.

## What is not confined

The harness, and every command the model it runs writes, executes as the
owner's user. It can therefore read every file the owner can read: other
projects' workspaces, the CLI's configuration under `~/.config/atelier/`,
git credentials in `~/.git-credentials` or the keychain, and the Keychain
itself. The `-T` fix of t168 narrows the CLI's own Keychain item to
`/usr/bin/security`, which stops applications reading the item directly, but
any process the owner runs can spawn `/usr/bin/security` and read it through
it; only a different user closes that. Provider keys the runner names in its
config entries reach the harness through its environment and are readable
the same way. Nothing limits CPU, memory or network, and nothing prevents
persistence, such as a LaunchAgent the harness writes.

The server's rules govern Git, the ledger and approvals; they cannot govern
a local process. That gap is what this design closes.

## The options

### A separate macOS user per task

A task user (`dscl . -create /Users/atelier-TASK`), its home holding the
workspace; the owner's runner starts the harness as that user over
`ssh atelier@localhost` (a clean session, no Fast User Switching) or through
a root launchd daemon's `UserName`. File exchange happens through the
workspace clone, which the owner can read.

What it confines: everything identity can reach. The task user has its own
Keychain (empty unless provisioned), no credentials, no iCloud Drive, no
access to the owner's home. This is the only option macOS enforces without
the harness's cooperation, and the only one that closes the
`/usr/bin/security` path above.

Costs: the heaviest to operate. Users accumulate unless reaped; each needs a
home, a shell policy and cleanup on abandonment. Provisioning is inverted:
what the task needs (a provider key, a device) must be handed to the task
user deliberately, which is the point but is also work per project. Toolchains
that read `~/Library` (Xcode, device tools) fail inside the task user, and
device delivery stays with the owner's ship, so that failure is acceptable.
Debugging crosses a user boundary: the owner inspects a workspace they can
read but cannot write. Tests for the runner itself need a second local
account, which CI does not have.

### A sandbox-exec profile per task

`/usr/bin/sandbox-exec -f PROFILE CMD` wraps the harness. The profile allows
the workspace, the caches toolchains need (`~/Library/Caches/node`, the
runner's brief and data-home siblings), reading system paths, and denies
file reads of the owner's Keychains, `.config`, `.git-credentials` and the
other projects' workspaces; denies `process-exec*` of `/usr/bin/security`;
and may deny `machine` and `network*` for a project that needs no network.
It applies per process, needs no setup, and composes with the existing
process-group lifecycle.

Costs: Apple calls the Seatbelt interfaces legacy and gives no stability
promise; the design accepts that risk because nothing else on macOS does
this job per process. Profiles are allow lists, and every gap is a runtime
failure with an opaque EPERM: each toolchain the projects use must be walked
through once (node, python, swift, git with a key it can read). Denying
`securityd`'s Mach service or the Keychain directory both work, and both are
needed, since a Keychain read goes through either. The profile confines
paths and executables, not identity: whatever it allows, the harness shares
with the owner, and CPU and memory stay unlimited. A profile is also
cooperative at the edges: the wrapper must deny writing outside the
workspace, or the harness persists through an allowed path.

### A launchd job per task

The runner writes a LaunchAgent plist per claim and `launchctl kickstart`s
it, instead of spawning the harness itself. The job's program is the
`sandbox-exec` wrapper above.

What it adds over the runner's own `execute()`: lifecycle the system can
see. `launchctl print` shows every running task; a job that outlives the
runner is still named, still killable, and its exit status, stdout and
stderr are collected in one place; the owner's logout does not orphan it
silently. The job's environment is exactly the plist's, not the owner's
shell's, which removes a class of accidental inheritance the environment
filter cannot see. The same mechanism is the path to option 1: a root
LaunchDaemon can start the job under a `UserName` the owner's runner cannot
`sudo` to.

Costs: machine-global state. Agents live in `~/Library/LaunchAgents`, must
be namespaced by label, and must be reaped on every exit path the runner
has, including the second-interrupt `process.exit` that runs no `finally`
block; a crashed runner leaves agents behind, so the runner must also reap
orphans at startup. Logging moves from inherited stdio to files or the
unified log, which the runner must rotate. It is macOS-only, so the runner
grows a platform split, and it confines nothing by itself: without the
profile it is supervision, not confinement.

## Costs compared

| | Separate user | sandbox-exec profile | launchd job |
|---|---|---|---|
| Confines | identity: files, Keychain, credentials | paths and executables | nothing by itself; carries the other two |
| Setup | per task or per project | one profile, per-project variants | plist per task, reaping |
| Owner's effort | high: provisioning, reaping, debugging across users | medium: walk each toolchain once | medium: lifecycle plumbing |
| Where it fails | toolchains needing the owner's home | runtime EPERM on an unallowed path | orphaned agents after a crash |
| Closes the `security` Keychain path | yes | yes, by denying its execution | with the profile |

## Phases

1. The runner wraps each harness command in the Seatbelt profile
   (`cli/runner.mjs` `execute()`), one profile shipped in the CLI and a
   per-project addition in the runner config. The Cloudflare sandbox remains
   the answer for checking code already written.
2. The runner moves from spawning processes to launchd jobs, reaping orphans
   at startup, and collects each job's output where its logs already go.
3. A policy field (as `sandboxOnly` is for checks) lets a project demand the
   task user; the launchd daemon starts those jobs under it, and provisioning
   becomes per project, once.

Phase 1 alone removes the file and credential exposure of every task the
home runner takes; phases 2 and 3 turn it into something the machine
accounts for, and that a project can demand.

## What this design does not cover

Network filtering beyond a profile's all-or-nothing deny: a per-project
allow list (registries, the Atelier server) is future work. Resource limits
(CPU, memory) are not addressed by any option as stated; cgroups do not
exist on macOS, and `launchd` offers only niceness. The Cloudflare sandbox
already covers checks; this design covers the harness that writes the code,
and leaves the owner's own commands, `ship` above all, where they are.
