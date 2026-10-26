// atelier land and the one-shot review (t273): a reviewer no live runner
// offers is run once on this Mac; a missing model stops the landing naming it.
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { landFixture } from "./land-fixture.mjs";

const offer = (jobs) => ({ runner: "home:other", kind: "home", at: new Date().toISOString(), jobs, agents: [{ agent: "codex", models: ["gpt-6-astra"] }] });

test("a landing whose reviewer no live runner offers stops naming the model this Mac lacks, with the request left open", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.approveAfter = null;
  f.box.runners = [offer(["build"])];
  writeFileSync(join(f.p, "config", "runner.json"), JSON.stringify({ agents: [{ agent: "opencode", models: ["glm-5.3"], command: ["opencode", "{model}", "{brief_file}", "{verdict_file}"] }] }));
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /the harness codex is missing/);
  assert.match(r.output, /codex\/gpt-6-astra cannot be run on this Mac/);
  assert.match(r.output, /stays submitted with its review request open/);
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/landing-lease").length, 0);
});

test("a reviewer a live runner offers for the review job is left to that runner: no one-shot, no config read", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.approveAfter = null;
  f.box.runners = [offer(["review"])];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /on this Mac|runs? .* once/);
  assert.match(r.output, /with its review asked and its land request recorded/);
});

test("--no-wait leaves a reviewer no runner offers to the runners and runs nothing here", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.runners = [];
  const r = await f.run(f.checkout, "land", "t1", "--no-wait");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /cannot be run on this Mac/);
});
