# ControlPlane, retired

ControlPlane was the policy system PAVI's projects used before Atelier. On
2026-10-20 PAVI retired it, and Atelier now neither reads, writes nor acts on
its files. This page says what that means for a project that still holds them
and what Atelier keeps of them as history. A project without those files needs
none of it; the README's "Concepts" section and [the gate](gate.md) describe the
rules that apply everywhere, including the explicit `init --single-family
COMPANY` exception.

## What Atelier no longer does

- `atelier init`, `sync` and `merge` read nothing in `docs/control-plane/`: not
  `agent-policy.v1.json`, `execution-policy.v1.json`, `project-adapter.v1.json`
  or the context budget, whether valid, malformed or absent. Protected paths,
  overlap, checks and ship settings are Atelier's own: `init` flags, and
  `docs/atelier/ship.json` for a ship order ([ship](ship.md)).
- `atelier merge` writes no landing receipt. The provenance note on the merge
  carries what the receipt carried, including the checked tree.
- `atelier ship` composes its order from `docs/atelier/ship.json` alone; a
  checkout with only ControlPlane's ship files refuses, naming that file.
- `atelier wrap` reads no context budget, so no ceiling refuses it. Its
  branch, conflict and unfinished-operation refusals stand ([owner](owner.md)).
- A project's stored agents, execution rules and eligible list decide no claim,
  routing, review or change class. Models are admitted and reviewed under
  Atelier's own rules: the model pool, reviewer admission, single-family mode,
  independence and standing ([gate](gate.md)). A new acceptance records none of
  them.
- The settings page, `atelier status` and `atelier init` draw no ControlPlane
  policy and no eligible-agents line.

## What Atelier keeps

- The ledger is not rewritten. A project's stored policy keeps `agents`,
  `execution` and `eligible` as raw data, its events and acceptance snapshots
  are as they were, and a legacy ledger loads, shows and decides as any other.
- Imported protected paths, overlap settings, registered checks and check
  coverage stay as the project's own settings. There is no record of which
  entry came from ControlPlane, so none is removed.
- A check declaration with `by: "adapter"` is still read and shown as "read-only,
  from ControlPlane". Nothing records a new one.
- `GET /api/projects/NAME/standing` still answers `controlPlane` in its old
  shape, and the project routes still answer `policy`, `acceptanceProtected` and
  `acceptancePolicy`, because an older CLI reads them. Removing a field is a
  separate change from this retirement.
- Merge compares the project's policy now with the snapshot an acceptance
  recorded and warns of a newly protected path, a newly required check, a new
  ship command or newly refused overlap, as [the gate](gate.md) describes. A
  snapshot that recorded an eligible list is still compared on it.
- Committed receipts in `docs/control-plane/landing-receipts/` stay where they
  are.

## Old CLIs

A CLI that predates this change still reads ControlPlane's files, writes a
receipt on merge and composes ControlPlane ship orders, and the server cannot
stop it. The retirement is complete when the CLI and the runners on every Mac
are updated.

## `atelier owners`

`atelier owners` prints one line per live item for a wrap to copy into the
project's state record; `atelier owners --json` and
`GET /api/projects/NAME/owners` give the same view without titles, scopes or
paths.
