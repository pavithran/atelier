import { test } from "node:test";
import assert from "node:assert/strict";

const { guidePointer, statesReviewPath, agentsMdOffer, AGENTS_SECTION } = await import("../cli/atelier.mjs");

const without = () => "# ourai\n\nBuild with npm. Run `atelier guide` sometime.\n";
const withPath = () => "# ourai\n\nLand with `atelier land t1 --reviewer codex/gpt-6`.\n";

test("a project whose AGENTS.md lacks the review path gets one line naming the guide", () => {
  const projects = { ourai: { path: "/work/ourai" } };
  for (const read of [without, () => null]) {
    const line = guidePointer(projects, ["ourai"], false, read);
    assert.match(line, /atelier guide --role orchestrate --project ourai/);
    assert.match(line, /atelier land --reviewer/);
    assert.equal(line.includes("\n"), false);
  }
});

test("the pointer is gone once AGENTS.md states the review path", () => {
  const projects = { ourai: { path: "/work/ourai" }, other: { path: "/work/other" } };
  const read = (dir) => (dir === "/work/ourai" ? withPath() : without());
  assert.equal(guidePointer(projects, ["ourai"], false, read), null);
  assert.match(guidePointer(projects, ["ourai", "other"], false, read), /--project other/);
});

test("nothing is remembered between calls: the same state prints the same line", () => {
  const projects = { ourai: { path: "/work/ourai" } };
  const first = guidePointer(projects, ["ourai"], false, without);
  assert.equal(guidePointer(projects, ["ourai"], false, without), first);
  assert.ok(first);
});

test("the pointer is not printed in a task workspace or for an unregistered project", () => {
  const projects = { ourai: { path: "/work/ourai" } };
  assert.equal(guidePointer(projects, ["ourai"], true, without), null);
  assert.match(guidePointer(projects, ["nope"], false, without), /--project nope/);
  assert.match(guidePointer({}, ["demo"], false, () => null), /atelier guide --role orchestrate/);
});

test("several projects without the review path share one line", () => {
  const projects = { a: { path: "/a" }, b: { path: "/b" } };
  const line = guidePointer(projects, ["a", "b"], false, without);
  assert.match(line, /atelier guide --role orchestrate/);
  assert.equal(line.includes("\n"), false);
});

test("statesReviewPath needs atelier land with --reviewer on one line", () => {
  assert.equal(statesReviewPath("atelier land t1 --reviewer a/b"), true);
  assert.equal(statesReviewPath("atelier land t1\n--reviewer a/b"), false);
  assert.equal(statesReviewPath(null), false);
});

test("init offers an AGENTS.md section that points at the guide and states the review path", () => {
  const offer = agentsMdOffer("# ourai\n\nBuild with npm.\n");
  assert.match(offer, /did not edit it/);
  assert.match(AGENTS_SECTION, /atelier guide --role orchestrate/);
  assert.match(AGENTS_SECTION, /atelier land ID --reviewer/);
  assert.ok(offer.includes(AGENTS_SECTION));
  assert.match(agentsMdOffer(null), /no AGENTS\.md/);
});

test("init offers nothing when AGENTS.md points at the guide and states the review path", () => {
  assert.equal(agentsMdOffer("# x\n\nRun `atelier guide --role orchestrate`.\nLand with `atelier land t1 --reviewer a/b`.\n"), null);
});

test("init still offers the section when AGENTS.md mentions the guide but not the review path", () => {
  const offer = agentsMdOffer("# x\n\nRun `atelier guide --role orchestrate`.\n");
  assert.match(offer, /review path/);
  assert.ok(offer.includes(AGENTS_SECTION));
});

test("init offers the section when the review path is stated but the guide is not named", () => {
  const offer = agentsMdOffer("# x\n\nLand with `atelier land t1 --reviewer a/b`.\n");
  assert.match(offer, /atelier guide/);
});
