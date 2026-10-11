# Plan

## Shared Navigation
One shared navigation bar separating owner and public boundaries.

## Traceability to Findings
- Addressed vertical space with pagination and filters (t497).
- Consolidated task state (t498).
- Better owner actions (t474).

## New Tasks Proposed
### Task: t500 Unified Navigation
- **Scope**: src/ui.ts, src/layout.css
- **Dependencies**: t456
- **Criteria**: One shared navigation bar; desktop/mobile responsive; highlights current route.

### Task: t501 Pagination
- **Scope**: src/ui.ts, src/index.ts
- **Dependencies**: t497
- **Criteria**: Limit lists to 50 items; provide next/prev links.

## Existing Coverage
- **t367**: Styling/Palette. (Coverage: Complete)
- **t456**: Project Areas/Stages. (Coverage: Partial, wait)
- **t474**: Owner actions. (Coverage: Ready)
- **t496-t498**: Workflow UI updates. (Coverage: In progress)

## Dependency Order
1. t456 (Stages)
2. t496 (Waiting on you)
3. t474 (Owner actions)
4. t497 (Scannable pages)
5. t498 (Task state)
6. t500 (Unified Nav)
7. t501 (Pagination)

Captures need refreshing after: t456, t496, t497, t498.
