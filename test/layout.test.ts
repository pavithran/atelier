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

// t560: a board row's link is a `.task-list a`, whose phone rule is a two-column
// grid (content, arrow). With two spans inside, the title fell into the 20px
// arrow column and wrapped a letter per line. The board link keeps one full-width
// column, so the id line and the title stack and the title wraps by word.
test("the tasks board title link is one full-width column that wraps by word", () => {
  const rule = css.match(/\.area-board \.task-list a\.area-task-title \{([^}]*)\}/);
  assert.ok(rule, "a rule scoped above `.task-list a` exists");
  assert.match(rule[1], /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  assert.match(rule[1], /overflow-wrap:\s*break-word/);
  assert.doesNotMatch(rule[1], /overflow-wrap:\s*anywhere|word-break:\s*break-all/);
});
