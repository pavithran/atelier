# Critique

## /home
- **Strengths**: Shows active tasks.
- **Failures**: Too much vertical space (71,514px at 390px). 
- **Severity**: High.
- **Proposed**: Filter and collapse stale items (t497, t498).
- **WCAG Checks**:
  - Contrast: Passes palette B (t367).
  - Keyboard/Focus: Needs review on tabs.
  - Reflow: Fails on 390px due to long titles.
  - Public-data exposure: None.

## /p/:project
- **Strengths**: Detailed history.
- **Failures**: Overlapping navigations.
- **Severity**: Medium.
- **Proposed**: Single unified navigation (t456).
