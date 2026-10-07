# Projects governed by ControlPlane

ControlPlane is the policy system PAVI's projects used before Atelier. This
document says how Atelier reads a project's ControlPlane policy files and how
a project moves from ControlPlane to Atelier. A project without those files
needs none of it; the README's "Concepts" section describes the gate that
applies everywhere.

## Policy files and what Atelier does with them

Atelier and ControlPlane each own different facts. ControlPlane owns policy:
who may act and what is protected. Atelier owns live state: who holds which
item now, the evidence at its head and its handoff chain. Git owns what
merged.

- `atelier init` reads `docs/control-plane/agent-policy.v1.json`,
  `execution-policy.v1.json` and `project-adapter.v1.json` when they exist.
  `sync` refreshes the policy from those files too. Overlapping claims are
  refused when the policy says `overlapping_claims: refuse`. Protected paths
  include execution policy patterns, adapter surfaces, maintenance paths,
  agent instructions, ControlPlane files and the files that run checks.
  The adapter's capability classes declare checks read-only (see
  [Check classes](gate.md#check-classes)), and its `change_rules` set the paths
  each check applies to (see
  [Checks that apply to some paths](gate.md#checks-that-apply-to-some-paths)); init
  sets both, and `sync` and `merge` leave them as init set them.
  Atelier never writes these policy files.
- `claude-code/*` maps to `claude`, `codex/*` to `codex`, and `zcode/*`
  and `opencode/glm*` to `glm`. `antigravity/*` maps to `antigravity` for a
  Gemini model; Antigravity also serves other vendors' models, which map by
  their own family. Other actors map by model family name,
  such as `claude`, `gpt`, `gemini` or `qwen`, when that name is listed in
  the agent policy. An unmapped actor has no role. Claiming or receiving a
  handoff requires an available agent with `executor` in `eligible_roles`.
  Agent reviews count toward the gate only when the agent is available with
  `assessor`. The project owner's rejection always counts; the owner's
  approval is never the required review.
  `preferred_roles` records a preference and does not grant a role. The
  other roles do not grant execution or review authority.
- Changed paths determine the class. Any protected path makes the change
  `protected`. Otherwise it is `direct` only when direct execution is enabled
  and every changed path matches `direct.allowed_path_patterns`; all other
  changes are `coordinated`. A class absent from `allowed_classes` is refused.
  Protected changes need approval from a model family different from every
  recorded contributor, as in every project; coordinated changes need
  approval from an agent who did not contribute; direct changes need no
  review. Required reviews must come from assessors. The project owner's
  approval is neither review; where no reviewer qualifies, the owner's
  override stands in for it, as [the gate](gate.md) describes. Project owner acceptance is
  always required. A measured empty change has nothing to merge.
  Projects without these policy files have no change classes: a protected
  change needs its review from another family, and any other change needs
  none.
- `atelier sync` and normal `atelier merge` re-read these files and refresh
  the stored protected paths, eligible agents and overlap rule. The refresh
  preserves paths recorded locally by `init --protect`. Approval, checks and
  other project settings are kept. For a baseline with full history, `sync`
  only refreshes this policy. A malformed or empty policy file makes `sync`
  warn and skip the refresh, and stops `init` and `merge` until it is fixed:
  a merge never skips the comparison below.
- Acceptance records the project's protected paths, eligible agents, overlap
  rule and required checks on the server. Every merge attempt compares the
  policy as it is now with that snapshot and warns of any difference. It
  refuses, until the task is accepted again or `--policy-changed-ok` is
  passed after reviewing the change, when the accepted revision touches a
  newly protected path, a contributor is no longer eligible, a check required
  now was not observed passing at the accepted revision, or overlapping
  claims are now refused and the task's scope overlaps a live one. The paths
  compared are the accepted revision's own: those since the newest baseline
  commit it holds, so a workspace brought up to date with `atelier update`
  is not charged with the baseline's changes. An acceptance made before the
  snapshot recorded every field is compared on the protected paths it
  recorded (none, for the oldest) and on the other fields as the server held
  them before the refresh. The task page offers the re-acceptance, which
  checks the current gate and records a new snapshot; so does
  `atelier accept ID`. `merge --cancel` does not read or refresh ControlPlane
  policy.
- Copying a project into Artifacts is an off-machine copy, so `init` refuses
  a ControlPlane project until the project owner's approval is recorded with
  `--approval "…"`. The approval is kept in the project's policy and quoted in
  every merge receipt. Once recorded it stands: a later `init` that changes
  the checks, the title or the policy keeps it, and it is asked for again
  only when `--reset` starts the policy over or `--history-since` replaces
  the baseline.
- `atelier merge` writes a `control-plane.landing-receipt` into
  `docs/control-plane/landing-receipts/` as part of the merge commit, so the
  merge and its record are one change.
- `atelier owners` prints one line per live item for a wrap to copy into the
  project's state record; `atelier owners --json` and
  `GET /api/projects/NAME/owners` give the same view without titles, scopes
  or paths. Publishing it to Observatory is ControlPlane's to do, because
  Observatory reads only what ControlPlane publishes.

## Moving a project from ControlPlane

A project moves to Atelier one at a time, and the move is itself an Atelier
task, reviewed by a model from another family and accepted by the project
owner. `atelier adopt` runs in the project's registered checkout:

```sh
atelier adopt --project NAME --as HARNESS/MODEL
```

It refuses unless the project is registered in Atelier and the checkout is
clean. Every check that can refuse the move runs before the task is created,
so a refusal leaves nothing behind — no task, no claim: the checkout's files
are readable, the AGENTS.md edit is computable, it stays under the ceiling
the project's `docs/control-plane/context-budget.v1.json` sets (the one
`atelier wrap` refuses to commit over; the refusal says how many lines over
and which file), no symbolic link stands where the move writes, and the
agent is one the project's policy admits (the same rule a claim applies). The
move writes into the task's workspace and nothing
outside it: a file it writes that is a symlink is replaced with a regular
file, never written through, and a symlinked directory above one refuses the
move (an AGENTS.md that is a symlink is refused too, because the section is
built from its text). It creates the task "Move NAME from ControlPlane to
Atelier", claims it as `--as` (without it, as the current actor), and in the
task's workspace it writes `bin/control-plane`, replaces
`bin/control-plane-paste`, when the project has one, with a script that says
no command renders a paste any more, that the agent writes the relay
envelope itself as the relay rule says (one fenced block with a language
tag, a copy saved under `~/Documents/ai-project-data/<project>/`) and that
`atelier handoff` transfers ownership and is not a relay, and exits 2; and
it inserts the text `atelier guide` prints
into `AGENTS.md`: right after its first heading, at the top when the file has
no heading, and in place of the section it already carries, so adopting a
project again cannot stack a second one. It commits those changes in the
workspace and does not push them; the agent finishing the task pushes, checks
and submits as usual.

The new `bin/control-plane` is a POSIX sh script that knows the project's
Atelier name. It prints the Atelier command it runs to stderr, runs it, and
never contacts ControlPlane's central checkout:

| ControlPlane | Atelier |
| --- | --- |
| `pickup-card`, `unwrap` (no arguments) | `atelier unwrap --project NAME` |
| `wrap`, `session-receipt` | `atelier wrap`, with the arguments passed on |
| `report TEXT` | `atelier new TEXT --project NAME`, so a report becomes a task |
| `audit`, `context-budget`, `ship-check`, `observe`, `observatory-bundle`, `observatory-run`, `backup-status`, `validate-backup` | `atelier ops COMMAND [ARGUMENTS]` |
| `help`, or no command | a short text saying the project works through Atelier, and this list of mappings |
| anything else | a line saying the command moved into Atelier, naming `atelier help` and `atelier ops help`, and exit 2 |

Adopt then reads the checkout, without changing it, and prints the leftovers
the agent finishing the task must settle: a
`docs/control-plane/work-item.v1.json` whose state is `active`,
`completed-unreconciled` or `blocked`, with its plan id, state and owner; a
capability in `docs/control-plane/project-adapter.v1.json` whose command names
a file the project does not have — the command is read as shell words, so a
quoted path with spaces stays one word; a script run through an
interpreter or `env` (`python3 tools/ship.py`, `bash bin/sweep.sh`) is judged
by the script, not the interpreter; each command in a chain or a pipeline
(`&&`, `||`, `|`, `;`) is judged on its own program, a shell's `-c` command
line the same way, and a glob, a redirection or any argument after the
program is never judged; a vendored `tools/control-plane/`
directory; and each line in `AGENTS.md`, `CLAUDE.md` and `GLM.md` that still
names `pickup-card`, `control-plane-paste`, `session-receipt` or
`audit record`, with its file and line number. The same list is recorded on
the task as reported notes, so the reviewer and the owner see it there.
