# Decisions: what the build leaves out of the canvas

The artboard is `Decisions.dc.html` in the canvas "atelier.zone, re-imagined"
(PAVI's d29). The page (t545, `renderInbox` and `decisionDetail` in
`src/ui.ts`) draws only what the Ledger already records, read as the Decisions
page read it before. These are the canvas elements it omits or changes, and
why.

## Omitted for want of a route

- **"Admit an outside reviewer"**, in the detail's footer ("No reviewer
  available? Admit an outside reviewer, or, as a last resort, record an
  override."). The admission exists only in the API
  (`PUT /api/projects/:name/reviewers/:model`, the owner's token); the web
  app has no form or route for it, so the footer offers only the override,
  linking to the task page's form.

## Left to the task page

The detail draws the task page's own form, posted to the same route, only
for **Accept revision** and **Unblock**; **Ask a reviewer** and the merge are
the same commands the task page shows, and a ship call links to Ship. Every
other owner action stays a form on the task page, reached by **Open the
task** (or, for the override, the footer's link):

- record an override (`/ui/:p/:t/override`, with its typed confirmation),
  and allow or forbid overrides (`allow-override`);
- approve or send back a revision (`approve`, `reject`);
- clear a secret flag (`clear-secret`);
- block, hand off, release or abandon the task (`block`, `handoff`,
  `release`, `abandon`);
- send to a runner or take back (`dispatch`, `undispatch`);
- a plan's approval or decision, settled with the `atelier plan` command the row names.

## Omitted for want of data

- **The runner's name** in an evidence row ("runner mac-mini-2, clean
  clone"). Evidence records only where a check ran (`runner`, or `sandbox` on a
  result recorded before t768), not which runner, so the row says "Runner,
  clean clone" or "Cloudflare container".
- **The count of protected files** in the diff row ("· 1 protected"). The
  gate records the files outside the scope, not which changed files are
  protected; the row counts those outside the scope instead, when any are.
- **The head in the why** ("checks passed … at e41c7a0"). The why is the
  task page's sentence for the state, which names no commit.

## Drawn differently

- **Collapsed rows** ("+4 · t191, t193, t194, t190 · Ready to accept"). Every
  decision has its own row, so each can be selected; folding them would hide
  rows the owner must reach.
- **The shell** (top bar, "Project ▾", "Owner ▾") is t543's, not this page's.
- **At phone width** the canvas has no artboard; the list stands alone at
  `/decisions`, and a decision the owner picks replaces it, with a link back.
