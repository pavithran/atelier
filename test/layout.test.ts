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
