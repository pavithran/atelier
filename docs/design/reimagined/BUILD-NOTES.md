# Build notes for the canvas "atelier.zone, re-imagined" (from atelier-design, 2026-10-12)

PAVI asked for a re-imagining, not a build; no order was promised. Order now (d29): shell (t543), Public showcase, Decisions, Project Overview, then Activity Now, Project Activity, the phone page.

ALL owner artboards use MOCK data: titles, holders and times copied from docs/design/mockups; commit hashes and in-thread event order invented. Render live data only.

## Must not change
- d24: Night; gold #ffd166 for links, primary actions and the owner; orange #ffb547 caution; family colours only in charts, lane threads, graph marks and their legends; ids and agent names in text colour.
- House style, no descriptive chrome: no explanatory leads, captions or subtitles beyond what states a figure's window. Labels are the §5 state words (docs/design/plan.md).
- The Activity animation PAVI liked: threads draw in event order, marks fade in at their event, live heads breathe after the draw, Play replays it, reduced motion turns it all off.
- Landing (public showcase) order: Git-versus-Atelier comparison straight after the hero; then the tally with one Observed/Reported/Pending legend; then the portfolio, the story, the steps, the moves, where it runs. Large display headings (30-44 px).
- Repeated moves fold in the feed (t530: "x6 in 10 min").
- Five project tabs (plan.md P10: Overview, Tasks, Code, Activity, Settings); PAVI never chose between three and five.

## Per artboard
- Public showcase (Main): everything exists in renderShowcase today (tally, cards with daily bars, comparison, t433 story, counts per step, moves feed, privacy note); the canvas's figures are a 2026-10-11 snapshot: render from the tally, never type them. New: repeated-move folding (t530), one glyph per event kind in the feed instead of family dots (d9), the window as the tally's subtitle, layout and type. No new routes.
- Decisions: has t504's owner-call rule, grouping by project, evidence rows with where each check ran, the folded orchestrator list (P6). New: "Ask a reviewer" as primary action; "Admit an outside reviewer" (d16) and "record an override" as secondary links: only where the web already has the route (t474 covers owner actions from the page); otherwise link to what exists or omit, and say so. Two-row owner bar is P1 (the shell, t543).
- Project Overview: has stateLabel and §5 words, Waiting on you (t504 inboxFor), running claims, last merges, Ship's pending requests. New: P5 layout and the five tabs. No new data.
- Project Activity: has graph.ts beads, threads, main merge dots and hashes, closure caps, family filter, scrubber narration in live.js. New: "in flight first" with older merges folded behind "N merged earlier · show" (needs a query/parameter on top of P8's 20-story paging); stale dashed thread (P7's 12 h); Previous/Next one event at a time with a role=status line (check against today's scrubber).
- Activity · Now (Studio): has Studio's lanes on a clock axis. New: live.js instead of meta refresh with "Live · Pause" (P12); stale on the lane (P7); holders in text colour, family colour only on the lane (P14); the Now · Flow · Merges switch (P1).
- Task on the phone: has the task page's data. New: P3's header (one state word, one sentence why); Accept revision / Send back fixed at the bottom of a 390 px screen (t474 makes them work); tabs scroll sideways at phone width (P1).
