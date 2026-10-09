import { test } from "node:test";
import assert from "node:assert/strict";

const { guidePointer, markGuideFetched, agentsMdOffer, AGENTS_SECTION } = await import("../cli/atelier.mjs");

test("a project whose orchestrator guide was not fetched gets one line naming it", () => {
  const projects = { ourai: { path: "/work/ourai" } };
  const line = guidePointer(projects, ["ourai"]);
  assert.match(line, /atelier guide --role orchestrate --project ourai/);
  assert.match(line, /atelier land --reviewer/);
  assert.equal(line.includes("\n"), false);
});

test("the pointer is gone once the guide was fetched for that project", () => {
  const projects = { ourai: { path: "/work/ourai" }, other: { path: "/work/other" } };
  assert.equal(markGuideFetched(projects, "ourai", "2026-10-09T00:00:00Z"), true);
  assert.equal(guidePointer(projects, ["ourai"]), null);
  // Another project's guide is still unread.
  assert.match(guidePointer(projects, ["ourai", "other"]), /--project other/);
});

test("the pointer is not printed in a task workspace or for an unregistered project", () => {
  const projects = { ourai: { path: "/work/ourai" } };
  assert.equal(guidePointer(projects, ["ourai"], true), null);
  assert.equal(guidePointer(projects, ["nope"]), null);
  assert.equal(markGuideFetched(projects, "nope"), false);
});

test("several unread projects share one line", () => {
  const projects = { a: {}, b: {} };
  const line = guidePointer(projects, ["a", "b"]);
  assert.match(line, /atelier guide --role orchestrate/);
  assert.equal(line.includes("\n"), false);
});

test("init offers an AGENTS.md section that points at the guide and states the review path", () => {
  const offer = agentsMdOffer("# ourai\n\nBuild with npm.\n");
  assert.match(offer, /did not edit it/);
  assert.match(AGENTS_SECTION, /atelier guide --role orchestrate/);
  assert.match(AGENTS_SECTION, /atelier land ID --reviewer/);
  assert.ok(offer.includes(AGENTS_SECTION));
  assert.match(agentsMdOffer(null), /no AGENTS\.md/);
});

test("init offers nothing when AGENTS.md already points at the guide", () => {
  assert.equal(agentsMdOffer("# x\n\nRun `atelier guide --role orchestrate`.\n"), null);
});
