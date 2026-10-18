# Projects governed by ControlPlane

ControlPlane is the policy system PAVI's projects used before Atelier. This
document says how Atelier reads a project's ControlPlane policy files. A project without those files
needs none of it; the README's "Concepts" section describes the gate that
applies everywhere, including the explicit `init --single-family COMPANY`
exception: reviews must come from a different model of that company from every
contributor. `init --cross-family` restores the default.

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
  `assessor`. The developer's rejection always counts; their
  approval is never the required review.
  `preferred_roles` records a preference and does not grant a role. The
  other roles do not grant execution or review authority.
- Changed paths determine the class. Any protected path makes the change
  `protected`. Otherwise it is `direct` only when direct execution is enabled
  and every changed path matches `direct.allowed_path_patterns`; all other
  changes are `coordinated`. A class absent from `allowed_classes` is refused.
  Protected changes need approval from a model family different from every
  recorded contributor by default; in single-family mode they need a different
  model of the selected company from every contributor. Coordinated changes
  need a different model from every contributor, also of the selected company
  in single-family mode; direct changes need no
  review. Required reviews must come from assessors. The developer's
  approval is neither review; where no reviewer qualifies, their
  override stands in for it, as [the gate](gate.md) describes. Developer acceptance is
  always required. A measured empty change has nothing to merge.
  Projects without these policy files have no change classes: a protected
  change needs its review from another family (or a different model of the
  selected company in single-family mode), and any other change needs
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
  a ControlPlane project until the developer's approval is recorded with
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
