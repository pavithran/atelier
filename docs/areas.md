# Function areas and the project board

The project overview and Tasks tab group every task by function area. `atelier
board --project NAME` shows the same membership, stage, ledger holder and merged
counts. `board --json` returns the snapshot. Plans and their parts are separate
rows, explicitly labelled, and appear exactly once. Empty areas remain visible.

The project owner manages areas with:

```
atelier area list --project NAME
atelier area create "Review" --purpose "Independent review and landing gates" --project NAME
atelier area rename a1 "Review and landing" --project NAME
atelier area rename a1 "Review and landing" --purpose "Check and land reviewed work" --project NAME
atelier area remove a1 --project NAME
```

Creation returns a stable ID such as `a1`. Names must be unique (case insensitive)
and both names and purposes must be nonempty single lines. A name is at most 80
characters and a purpose at most 300. `Unsorted` is reserved. Renaming keeps the ID
and assignments. Removed IDs are never reused; removal moves all assigned tasks,
including closed tasks, to Unsorted. Existing unassigned tasks are also Unsorted.

```
atelier new "Improve the review gate" --area a1 --accept "The gate rejects failing checks" --project NAME
atelier edit t12 --area a1 --project NAME
atelier edit t12 --clear-area --project NAME
```

Assignments require an existing area ID, not its name. Omission preserves an
assignment; the explicit clear operation sends `area: null`. The API accepts the
same field on task creation and edit. Owners manage areas at
`/api/projects/NAME/areas` (GET/POST) and `/areas/ID` (POST/DELETE).

`taskStage` in `src/board.ts` is pure and exported for other ledger consumers.
Its precedence is terminal state (merged, abandoned, integrated), an explicit
block, active landing, passing readiness gates, submitted/accepted state,
ownership, dispatch, then open. Accepted tasks are rechecked as submitted;
plans use their integration gate. A failed gate never becomes ready merely
because the task was submitted. The ledger holder is the task owner, never a
dispatch target or inferred runner. Groups sort by name then ID; tasks sort by
creation time then ID. Counts are calculated from those exact rows.

The UI uses ordinary task links, visible keyboard focus, wrapping text and a
single-column layout below 700px. No client script is required for the board.
