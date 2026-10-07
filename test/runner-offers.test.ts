import { test } from "node:test";
import assert from "node:assert/strict";
import { liveOffers, OFFER_LIVE_MS, unoffered, type Dispatch, type SeenOffer } from "../src/dispatch/rules.ts";

// unoffered (src/dispatch/rules.ts): why a dispatch no live runner offers can
// never be claimed, as atelier land, plan show and status say it. The queue
// offers a dispatch only to a runner whose offer can run it, so one naming a
// model no live runner's config lists — or a job none offers — waits forever
// while reading as merely unclaimed (t197's part t210, reviewed 2026-10-07).

const NOW = new Date("2026-10-07T12:00:00.000Z");
const seen = (runner: string, over: Partial<SeenOffer> = {}): SeenOffer => ({
  runner, kind: runner.startsWith("cloud:") ? "cloud" : "home",
  agents: [], at: NOW.toISOString(), ...over,
});
const review = (model: string): Dispatch => ({ to: "home", agent: "claude-code", model, by: "atelier/orchestrator", at: NOW.toISOString(), note: "", job: "review" });

test("a live runner offering the job with the named model takes the dispatch, so nothing is said", () => {
  const offers = [seen("home:studio", { jobs: ["build", "plan", "review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }] }),
    seen("home:mbp", { jobs: ["build", "plan", "review"], agents: [{ agent: "claude-code", models: ["fable-5.1"] }] })];
  assert.equal(unoffered(review("fable-5.1"), offers, NOW), null);
});

test("a dispatch no live runner offers names each live runner and what it offers instead", () => {
  const offers = [
    seen("cloud:far", { jobs: ["build", "review"], agents: [{ agent: "claude-code", models: ["fable-5.1"] }] }),
    seen("home:mbp", { jobs: ["build", "plan"], agents: [{ agent: "claude-code", models: ["fable-5.1"] }] }),
    seen("home:studio", { jobs: ["build", "plan", "review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }] }),
  ];
  // The offers answer in the order the server lists them, by runner name.
  assert.equal(
    unoffered(review("fable-5.1"), offers, NOW),
    "no live runner can take it: cloud:far is a cloud runner, not a home one; home:mbp offers no review job; home:studio offers review as opencode/glm-5.3",
  );
  // A runner that runs the harness but not the model says what it offers for the job.
  assert.equal(
    unoffered(review("opus-5.5"), [seen("home:mbp", { jobs: ["build", "review"], agents: [{ agent: "claude-code", models: ["fable-5.1", "sonnet-5.5"] }] })], NOW),
    "no live runner can take it: home:mbp offers review as claude-code/fable-5.1, claude-code/sonnet-5.5",
  );
  // A runner offering the job under no claimable name says that.
  assert.equal(
    unoffered(review("opus-5.5"), [seen("home:mbp", { jobs: ["build", "review"], agents: [{ agent: "claude-code", models: ["not claimable:but"] }] })], NOW),
    "no live runner can take it: home:mbp offers review as nothing it could claim as",
  );
});

test("a build dispatch naming a model no live runner offers is said the same way", () => {
  const build: Dispatch = { to: "home", agent: "codex", model: "gpt-6-astra", by: "owner", at: NOW.toISOString(), note: "" };
  assert.equal(unoffered(build, [seen("home:studio", { agents: [{ agent: "opencode", models: ["glm-5.3"] }] })], NOW),
    "no live runner can take it: home:studio offers build as opencode/glm-5.3");
  // Any live runner takes a dispatch that names neither agent nor model.
  assert.equal(unoffered({ ...build, agent: null, model: null }, [seen("home:studio", { agents: [{ agent: "opencode", models: ["glm-5.3"] }] })], NOW), null);
});

test("offers older than the live window count for nothing, and none at all is said as that", () => {
  const stale = new Date(NOW.getTime() - OFFER_LIVE_MS - 1000).toISOString();
  assert.equal(
    unoffered(review("fable-5.1"), [seen("home:studio", { at: stale, jobs: ["review"], agents: [{ agent: "claude-code", models: ["fable-5.1"] }] })], NOW),
    "no runner is live; the last to ask for work did so at 2026-10-07 09:59 UTC",
  );
  assert.equal(unoffered(review("fable-5.1"), [], NOW), "no runner has asked the server for work");
  // An offer exactly at the window's edge still counts.
  const edge = new Date(NOW.getTime() - OFFER_LIVE_MS).toISOString();
  assert.equal(unoffered(review("fable-5.1"), [seen("home:studio", { at: edge, jobs: ["review"], agents: [{ agent: "claude-code", models: ["fable-5.1"] }] })], NOW), null);
  assert.deepEqual(liveOffers([{ ...seen("home:studio"), at: "not a time" }], NOW).map((o) => o.runner), [], "an unreadable time is not live");
});
