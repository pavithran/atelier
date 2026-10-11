# Design Brief

## Routes & States
- `/` (Showcase)
- `/home` (Owner Home)
- `/decisions` (Decisions)
- `/studio` (Studio)
- `/p/:project` (Project Home)
- `/p/:project/tasks` (Project Tasks)
- `/p/:project/:task` (Task Detail)

## Audiences & Questions
- **Owner**: "What needs my attention right now?"
- **Public/Guest**: "What is this project and how can I see its progress?"

## Constraints
- **t367 vocabulary/palette B**: One vocabulary and palette B.
- **Server rendering**: No client-side JS frameworks.
- **No production build step**: CSS inlined via esbuild.
- **WCAG 2.2 AA**: Contrast, focus, and reflow must pass.
