# Design pass (t499)

- [brief.md](brief.md): routes, aliases, page states, audiences, constraints.
- [critique.md](critique.md): findings F1–F22, page by page, and the separate
  contrast, keyboard, reflow and public-data checks.
- [plan.md](plan.md): one navigation, proposals P1–P17, the map to t367,
  t456, t474 and t496–t498, and the order to land them.
- [mockups/](mockups/index.html): every page, desktop and phone, annotated.
- [contrast.md](contrast.md): the palette's ratios, generated from the tokens.
- `screens/` and `audit.json`: written by the capture.

## Capturing

```
npm run design:capture
```

Needs the Chromium build playwright-core 1.61.1 caches
(`~/Library/Caches/ms-playwright/chromium-1228` on macOS), or a cached
Chromium named by `ATELIER_CAPTURE_CHROMIUM`; it never downloads one and
fails at once without it. It seeds the fixture in the Workers test pool
(`test/fixtures/design/seed.ts`: 310 tasks, three projects with work, one
empty, one unreadable, fixed time 2026-10-10 12:00 UTC), draws every state
in the brief with the production renderers and CSS under test-only Access
sign-in and stubbed Artifacts, screenshots each at 1440 and 390 px, measures
it (`scripts/design/audit.ts`), and writes `screens/manifest.json` and
`audit.json`. A missing capture, a page at the wrong status, or a local
script or asset that did not load fails the run; `test/fixtures/design/screens.test.ts`
fails `npm test` while any state in the brief lacks either screenshot.

`node scripts/design/contrast.ts` rewrites `contrast.md` after a token change.

`screens/sketch-d6db01d/` keeps the earlier attempt's 20 screenshots and
manifest, from its own smaller fixture, as it captured them.
