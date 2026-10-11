import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { current, ratio } from "../../../scripts/design/contrast.ts";

// docs/design/contrast.md is measured from the tokens (t499): when the theme
// or the layout's own colours change, the file must be written again, so the
// critique never cites ratios the palette no longer has.

test("the contrast ratios are the WCAG formula's", () => {
  assert.equal(ratio("#000000", "#ffffff"), 21);
  assert.equal(ratio("#777777", "#ffffff"), 4.48);
  assert.equal(ratio("#ffffff", "#ffffff"), 1);
});

test("docs/design/contrast.md matches src/theme.css and src/layout.css", () => {
  const committed = readFileSync(resolve("docs/design/contrast.md"), "utf8");
  assert.equal(committed, current(), "run node scripts/design/contrast.ts and commit docs/design/contrast.md");
});
