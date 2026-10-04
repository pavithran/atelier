---
name: Atelier
description: Decisions with evidence for Git-backed work.
colors:
  paper: "#f5f2eb"
  sheet: "#fcfaf6"
  selection: "#ebe2d5"
  text: "#22241f"
  text-bright: "#0f110d"
  text-muted: "#56594e"
  inset: "#e0dbcc"
  line: "#c3bcaa"
  line-bright: "#9d9584"
  signal: "#9a561f"
  signal-hot: "#7d4211"
  on-accent: "#fdf6ee"
  observed: "#376327"
  caution: "#6d5a0c"
  fault: "#a3302a"
  dark-paper: "#151713"
  dark-sheet: "#1b1e18"
  dark-selection: "#302a21"
  dark-text: "#eee8da"
  dark-text-bright: "#fdfaf3"
  dark-text-muted: "#a8a597"
  dark-inset: "#232521"
  dark-line: "#373a34"
  dark-line-bright: "#4c5048"
  dark-signal: "#c47a45"
  dark-signal-hot: "#e09a62"
  dark-on-accent: "#1e1208"
  dark-observed: "#8eba74"
  dark-caution: "#e9b45b"
  dark-fault: "#d56d63"
typography:
  display:
    fontFamily: '"Iowan Old Style", "Palatino Linotype", Georgia, serif'
    fontSize: "56px"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-.035em"
  review-title:
    fontFamily: '"Iowan Old Style", "Palatino Linotype", Georgia, serif'
    fontSize: "38px"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "-.025em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "16px"
    lineHeight: 1.55
  metadata:
    fontSize: "13px"
  code:
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace'
    fontSize: "13px"
    lineHeight: 1.65
  diff:
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace'
    fontSize: "14px"
    lineHeight: 1.65
rounded:
  tag: "4px"
  control: "5px"
  row: "6px"
  sheet-mobile: "8px"
  sheet: "10px"
spacing:
  row-gap: "14px"
  desk-gap: "28px"
  sheet-padding: "34px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "11px 18px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "11px 18px"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  review-sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.text}"
    rounded: "{rounded.sheet}"
    padding: "34px"
---

# Design System: Atelier

## Overview

**Creative North Star: "Decisions with evidence"**

Atelier puts the next human decision beside its evidence. Warm ivory, charcoal, and copper support a narrow navigation rail, readable decision rows, and a generous review sheet. Technical detail remains available beneath the task explanation and appropriate action.

This describes the implemented Operate-mode candidate. PAVI approved the broad direction and rebuild; the generated composition is a working reference without separate image approval. Native serif typography is a deliberate adaptation, with platform-dependent rendering and no external font request.

**Key Characteristics:**

- Serif titles with system sans-serif controls.
- Flat paper surfaces, precise separators, and restrained copper actions.
- Revision context and evidence remain visible during review.

## Colors

Copper identifies action; ivory and charcoal carry the interface. Green, ochre, and red communicate evidence states with accompanying text.

The frontmatter records the active light palette and its `dark-` equivalents. `paper`, `sheet`, and `selection` are local layout properties; the remaining colors come from the default generated theme. The generated stylesheet includes other theme definitions, but the current UI has no theme picker or `data-theme` selection. System appearance selects light or dark.

Use `signal` for the primary action, `signal-hot` for links and focus, `observed` for passed evidence, `caution` for waiting or attention, and `fault` for failures. Status fills use their matching RGB source at 12% opacity; failure tags use 10%. Diff additions and deletions both use 12%. The sidecar's tonal ramps are synthesized previews, not additional implemented tokens.

## Typography

The display stack is Iowan Old Style, Palatino Linotype, Georgia, serif. The interface uses the system sans-serif stack. Monospace identifies revisions, commands, and code.

Main headings are 56px at weight 600; review titles are 38px at weight 600. At 1180px and below these become 48px and 32px, then 43px and 31px at 600px. Body text is 16px with 1.55 line height. Lead copy is 19px, falling to 17px on mobile; descriptions and lead copy are limited to 65ch. Metadata and ordinary code use 13px; diff code uses 14px with 1.65 line height. Row labels and controls use weight 550. The brand remains 38px at normal weight, falling to 32px on mobile.

## Layout

A fixed 208px rail contains Decisions, Projects, and History. Main content has 48px 32px 72px padding and a 1920px maximum width. The decision desk uses `minmax(280px,.8fr) minmax(0,1.3fr)` with a 28px gap. The review sheet has 34px padding.

At 1600px and above, main padding is 56px 48px, the desk gap is 38px, and sheet padding is 40px. At 1180px and below, the rail narrows to 176px, main padding becomes 32px 22px, the desk gap is 18px, and sheet padding is 24px. At 900px the desk becomes one column. At 600px the rail becomes a static header with horizontal navigation; main padding is 26px 18px 50px and sheet padding is 23px 18px. Long titles wrap; code blocks scroll horizontally.

## Elevation & Depth

There are no implemented shadows. Background changes and one-pixel borders distinguish the review sheet, selected decision, notices, and code. The selected row uses `selection`; hover feedback uses `selection` or `inset` according to the component.

The only implemented movement is smooth anchor scrolling, disabled under reduced-motion preference. Generated motion tokens exist but are not applied to these components.

## Shapes

The sheet uses a 10px radius, reduced to 8px on mobile. Rows, navigation links, notices, and file disclosures use 6px. Controls and ordinary code blocks use 5px; status tags use 4px. The avatar and check-status background are circular. These local dimensions differ from the unused generic radius scale in the generated theme.

## Components

- **Actions:** copper primary buttons and outlined secondary controls; 11px 18px padding and 44px minimum height. Primary hover brightens by 8%; secondary hover uses `inset`. Disabled buttons have 45% opacity and a not-allowed cursor. The current server-rendered forms have no client-side pending animation.
- **Fields:** sheet background, one-pixel bright border, 11px 12px padding, and 44px minimum height. Textareas resize vertically.
- **Focus:** links, buttons, summaries, fields, and focusable code blocks use a 2px `signal-hot` outline with 4px offset. A skip link appears on focus.
- **Navigation:** the main rail marks the current destination with `aria-current="page"`. Changes, Checks, and History inside a review are section links separated by horizontal rules, without a selected-tab state.
- **Decision rows:** icon, task title and metadata, optional status tag, and arrow. Selected and hovered rows receive a quiet tinted fill. Status tags move beneath the title at narrower widths.
- **Review sheet:** task title, project and task context, explanation, check summary, available actions, and revision precede the detail sections. Approval and acceptance are withheld when the diff is unavailable or its head differs from the recorded revision; a recovery notice explains the next action.
- **Evidence:** passing output is collapsed and failing output is open. Agent reports are labeled separately from required checks. Diff lines retain their plus and minus characters so meaning survives without color. Each file is a disclosure; code blocks are focusable for keyboard scrolling.

## Do's and Don'ts

- Do preserve the exact revision beside review actions.
- Do use the native serif stack and weight 600 for primary headings.
- Do keep failure output and recovery instructions visible.
- Do provide a 2px focus outline and at least 44px button and input height.
- Don't present unavailable or mismatched changes as sufficient evidence for approval or acceptance.
- Don't style review section links as selected tabs.
- Don't edit generated src/theme.css; use bin/sync-theme.
- Don't describe the generated composition or this candidate as separately approved.
