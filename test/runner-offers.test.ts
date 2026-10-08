import { test } from "node:test";
import assert from "node:assert/strict";
import { liveOffers, offering, OFFER_LIVE_MS, unoffered, type Dispatch, type SeenOffer } from "../src/dispatch/rules.ts";

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

// t252's incident: the only live runner was kept for reviews, and the build
// the server kept handing it held every review behind it while unoffered
// said nothing, because assign() treated build as always offered. A plain
// build now needs "build" in offer.jobs like any other job.
test("the only live runner being reviews-only, a plain build is said to be one no live runner can take", () => {
  const build: Dispatch = { to: "home", agent: null, model: null, by: "owner", at: NOW.toISOString(), note: "" };
  const rev = seen("home:mbp-rev", { jobs: ["review"], agents: [{ agent: "antigravity", models: ["gemini-3.1-pro"] }] });
  assert.equal(unoffered(build, [rev], NOW), "no live runner can take it: home:mbp-rev offers no build job");
  // The same holds when the build names the very model the runner serves:
  // the jobs it lacks, not the names it offers, are what stops it.
  assert.equal(unoffered({ ...build, agent: "antigravity", model: "gemini-3.1-pro" }, [rev], NOW),
    "no live runner can take it: home:mbp-rev offers no build job");
  // An older runner's ask, which named no job, still takes the build.
  assert.equal(unoffered(build, [rev, seen("home:mbp", { agents: [{ agent: "antigravity", models: ["gemini-3.1-pro"] }] })], NOW), null);
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

// offering (src/dispatch/rules.ts): what the live runners offer for a
// dispatch's job, as plan routing reads it to route a reviewer. The job is
// part of the question: a model counts only when a live runner that offers
// the job lists it, never because some other runner names the model for
// other work, which is how a review came to wait hours on a model only a
// build runner offered (t197's part t210, the t250 case of 2026-10-07).
test("offering counts a model only when a live runner that offers the job lists it", () => {
  const offers = [
    seen("home:mbp", { jobs: ["build", "plan"], agents: [{ agent: "claude-code", models: ["fable-5.1"] }] }),
    seen("home:studio", { jobs: ["build", "review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }] }),
    seen("cloud:far", { jobs: ["build", "review"], agents: [{ agent: "claude-code", models: ["fable-5.1"] }] }),
  ];
  const what = offering({ to: "home", job: "review" }, offers, NOW)!;
  // claude-code/fable-5.1 is named only by runners that cannot take a home
  // review: the build runner offers no review job, the cloud one is the
  // wrong kind, so it is not offered for the review job.
  assert.equal(what.actors.has("claude-code/fable-5.1"), false);
  assert.deepEqual(what.actors.get("opencode/glm-5.3"), ["home:studio"]);
  // Each live runner says what it offers for the job instead, as unoffered says it.
  assert.deepEqual(what.instead, [
    "home:mbp offers no review job",
    "home:studio offers review as opencode/glm-5.3",
    "cloud:far is a cloud runner, not a home one",
  ]);
  // A build dispatch asks no special job of the runner, so a model any live
  // runner of the kind lists is offered for it.
  const build = offering({ to: "home" }, offers, NOW)!;
  assert.deepEqual(build.actors.get("claude-code/fable-5.1"), ["home:mbp"]);
  assert.deepEqual(build.actors.get("opencode/glm-5.3"), ["home:studio"]);
  // Two runners offering the same actor both name it, whatever the case of
  // the names, and the key is the actor in lower case.
  const both = offering({ to: "home", job: "review" }, [
    ...offers,
    seen("home:desk", { jobs: ["review"], agents: [{ agent: "OpenCode", models: ["GLM-5.3"] }] }),
  ], NOW)!;
  assert.deepEqual(both.actors.get("opencode/glm-5.3"), ["home:studio", "home:desk"]);
  // A name no runner could claim as is not offered.
  assert.equal(offering({ to: "home", job: "review" }, [seen("home:mbp", { jobs: ["review"], agents: [{ agent: "claude-code", models: ["not claimable:but"] }] })], NOW)!.actors.size, 0);
  // With no runner live there is nothing to ask of, and the caller falls back.
  const stale = new Date(NOW.getTime() - OFFER_LIVE_MS - 1000).toISOString();
  assert.equal(offering({ to: "home", job: "review" }, [seen("home:studio", { at: stale })], NOW), null);
  assert.equal(offering({ to: "home", job: "review" }, [], NOW), null);
});
