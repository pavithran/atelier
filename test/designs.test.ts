import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanPlanned, designViews, plansOf, repeats, unfiled, unfiledLine } from "../src/designs.ts";
import { unfiledPlans } from "../src/stuck/rules.ts";

// t601: the rules for a design's planned count, pure.

const event = (seq: number, name: string, planned: number, quote = "words") => ({ seq, at: `2026-11-09T10:0${seq}:00.000Z`, kind: "design.planned", data: { name, planned, quote, by: "owner", acting: null } });

test("cleanPlanned takes a whole number from 1 to 50, a one-line name and words", () => {
  assert.deepEqual(cleanPlanned({ name: "slate", planned: 5, quote: "  yes,\n both " }), { name: "slate", planned: 5, quote: "yes, both" });
  for (const planned of [0, 51, 1.5, "5", null, undefined, NaN]) assert.throws(() => cleanPlanned({ name: "slate", planned, quote: "q" }), /whole number/);
  for (const name of ["", " ", "a\nb", " padded", "x".repeat(81), 3]) assert.throws(() => cleanPlanned({ name, planned: 2, quote: "q" }), /design is a short name/);
  assert.throws(() => cleanPlanned({ name: "slate", planned: 2 }), /developer's words/);
  assert.throws(() => cleanPlanned({ name: "slate", planned: 2, quote: " " }), /developer's words/);
});

test("the latest record for a name wins, and an equal one is a repeat", () => {
  const plans = plansOf([event(1, "a", 5), event(3, "a", 2, "fewer"), event(2, "b", 4)]);
  assert.deepEqual(plans.map((p) => [p.name, p.planned, p.quote]), [["b", 4, "words"], ["a", 2, "fewer"]]);
  assert.ok(repeats(plans[1], { name: "a", planned: 2, quote: "fewer" }));
  assert.ok(!repeats(plans[1], { name: "a", planned: 2, quote: "other words" }));
  assert.ok(!repeats(plans[1], { name: "a", planned: 3, quote: "fewer" }));
  assert.ok(!repeats(undefined, { name: "a", planned: 2, quote: "fewer" }));
});

test("K counts every task naming the design, in any state; a design no record names is not listed", () => {
  const items = [{ design: "a" }, { design: "a" }, { design: "other" }, { design: null }, {}];
  const views = designViews(plansOf([event(1, "a", 3), event(2, "b", 1)]), items);
  assert.deepEqual(views.map((v) => [v.name, v.planned, v.filed]), [["a", 3, 2], ["b", 1, 0]]);
  assert.deepEqual(unfiled(views).map(unfiledLine), ["Design a: 2 of 3 tasks filed", "Design b: 0 of 1 tasks filed"]);
  assert.deepEqual(unfiled(designViews(plansOf([event(1, "a", 2)]), items)), []);
});

test("unfiled-plan findings carry the record's time and what is missing", () => {
  const found = unfiledPlans(designViews(plansOf([event(1, "a", 4)]), [{ design: "a" }]));
  assert.deepEqual(found, [{ name: "a", reason: "Design a: 1 of 4 tasks filed", since: "2026-11-09T10:01:00.000Z", missing: 3 }]);
});

test("src/designs.ts imports no ledger or fetch code", () => {
  const source = readFileSync("src/designs.ts", "utf8");
  const imports = [...source.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./rules.ts", "./text.ts"]);
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ""), /\bfetch\(|ledger/i);
});
