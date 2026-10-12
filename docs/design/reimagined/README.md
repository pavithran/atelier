# atelier.zone, re-imagined (the canvas, 2026-10-12)

The artboards of the canvas PAVI expects built, copied as drawn: `*.dc.html`,
`canvas.json` and the canvas's own `BUILD-NOTES.md`. They are the spec; their
figures are mock data, and the pages render live data only.

The shell every owner page shares (t543) is drawn from Decisions.dc.html and
Overview.dc.html, and Phone.dc.html at 390 px; `src/ui.ts` `page` and
`projectTabs`, `src/layout.css` "The owner's bar":

| Bar item | Route |
|---|---|
| Atelier, Decisions (n) | `/decisions`; n is the Decisions list's count |
| Projects | `/home`, and every `/p/NAME` page |
| Activity | `/studio`, also current on `/flow` and `/history` |
| Project ▾ | All projects (`/home`) and each `/p/NAME` |
| Owner ▾ | `/models`, `/usage`, Sign out |
| Overview | `/p/NAME` |
| Tasks (n) | `/p/NAME/tasks`, also current on `/plans` and a task's page |
| Code | `/p/NAME/code`, also current on log, commit and path history |
| Activity | `/p/NAME/flow` |
| Settings | `/p/NAME/settings`, also current on `/ship` |

The public pages (showcase, how, sign-in) keep their own bar; Main.dc.html's
is a separate task.
