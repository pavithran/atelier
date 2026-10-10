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
  const now = Date.parse("2026-10-09T12:00:00Z");
  assert.equal(markGuideFetched(projects, "ourai", "2026-10-09T11:00:00Z"), true);
  assert.equal(guidePointer(projects, ["ourai"], false, now), null);
  // Another project's guide is still unread.
  assert.match(guidePointer(projects, ["ourai", "other"], false, now), /--project other/);
});

test("a fetch from an earlier session does not silence a new one", () => {
  const projects = { ourai: { guideFetched: "2026-10-08T09:00:00Z" } };
  assert.match(guidePointer(projects, ["ourai"], false, Date.parse("2026-10-09T09:00:00Z")), /--project ourai/);
  assert.match(guidePointer({ ourai: { guideFetched: "junk" } }, ["ourai"]), /atelier guide/);
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

test("init offers nothing when AGENTS.md points at the guide and states the review path", () => {
  assert.equal(agentsMdOffer("# x\n\nRun `atelier guide --role orchestrate`.\nLand with `atelier land t1 --reviewer a/b`.\n"), null);
});

test("init still offers the section when AGENTS.md mentions the guide but not the review path", () => {
  const offer = agentsMdOffer("# x\n\nRun `atelier guide --role orchestrate`.\n");
  assert.match(offer, /review path/);
  assert.ok(offer.includes(AGENTS_SECTION));
});
