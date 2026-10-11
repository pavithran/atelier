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

// An owner item on a project's Overview puts what to do in a paragraph after
// its title (standingSection in src/ui.ts). The list's grid gives its first
// column, 3.2em, to the task id; without its own column the paragraph fell
// into that column and wrapped a word a line (t504). It spans the text
// columns at every width, the phone's two-column grid included.
test("an owner item's action paragraph on the Overview spans the text columns, not the id column", () => {
  assert.match(css, /\.standing-list li \{[^}]*grid-template-columns:\s*3\.2em minmax\(0, 1fr\) auto/);
  assert.match(css, /\.standing-list li > p \{[^}]*grid-column:\s*2 \/ -1/);
  const phone = css.split("\n").find((l) => l.startsWith("@media (max-width: 720px)") && l.includes(".standing-list")) ?? "";
  assert.match(phone, /grid-template-columns:\s*3em minmax\(0, 1fr\)/);
  assert.doesNotMatch(phone, /li > p \{[^}]*grid-column:\s*(1|auto)/);
});
