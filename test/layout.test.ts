import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The Decisions page keeps the list and the selected decision as separate
// views on a phone (t317): renderInbox marks the desk with `has-selection`
// and a back link, and these rules turn that marker into the two views, so
// the Accept panel is not buried thousands of pixels below the list and the
// page does not overflow a 390px screen. Read from the stylesheet as it ships,
// since a browser applies it, not the tests.

const css = readFileSync(resolve("src/layout.css"), "utf8");

test("a phone shows the Decisions list and the selected decision as separate views", () => {
  assert.match(css, /@media \(max-width:\s*700px\)/);
  assert.match(css, /\.desk\.has-selection \.queue \{\s*display:\s*none\s*;\s*\}/);
  assert.match(css, /\.desk:not\(\.has-selection\) \.review-sheet \{\s*display:\s*none\s*;\s*\}/);
});

test("the back link is hidden on the desktop and shown only with a selection", () => {
  assert.match(css, /\.review-back \{\s*display:\s*none/);
  assert.match(css, /\.desk\.has-selection \.review-back \{\s*display:\s*inline-flex/);
});

test("the review navigation wraps instead of widening the page", () => {
  assert.match(css, /\.review-nav \{\s*display:\s*flex;\s*flex-wrap:\s*wrap/);
});

// t457: the override's disclosure looked like a button that did nothing. It
// is drawn as a disclosure on its own row: no button border, Safari's own
// marker hidden in favour of one that turns when it opens, and a hint whose
// words change from "show" to "hide".
test("the override disclosure is drawn as a disclosure, not a button, and shows when it is open", () => {
  const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.[\]()>:]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
  assert.match(rule(".override-disclosure > summary"), /border:\s*0/);
  assert.match(rule(".override-disclosure > summary"), /list-style:\s*none/);
  // No selector list styles it together with the buttons.
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").split("{").map((s) => s.slice(s.lastIndexOf("}") + 1));
  assert.deepEqual(selectors.filter((s) => /\bbutton\b/.test(s) && s.includes("override-disclosure")), []);
  assert.match(rule(".override-disclosure"), /flex-basis:\s*100%/);
  assert.match(rule(".override-disclosure > summary::-webkit-details-marker"), /display:\s*none/);
  assert.match(rule(".disclosure-marker"), /transform:\s*rotate\(-45deg\)/);
  assert.match(rule(".override-disclosure[open] > summary .disclosure-marker"), /transform:\s*rotate\(45deg\)/);
  assert.match(css, /\.override-disclosure \.when-open, \.override-disclosure\[open\] \.when-closed \{ display: none; \}/);
  assert.match(rule(".override-disclosure[open] .when-open"), /display:\s*inline/);
});
