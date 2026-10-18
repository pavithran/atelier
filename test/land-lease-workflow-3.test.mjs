// Part 3 of 6 of the tests that were in land-lease-workflow.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { landFixture } from "./land-fixture.mjs";

test("while the review request is unclaimed, the landing names the runner's job and what is queued ahead", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.approveAfter = 4;
  f.box.items = [
    { id: "t2", title: "Fixture t2", state: "claimed", owner: "opencode/glm-5.3", runner: "home:mbp", dispatch: { job: "build", at: "2026-10-06T08:00:00.000Z" }, updatedAt: "2026-10-06T08:05:00.000Z" },
    { id: "t3", title: "Fixture t3", state: "open", owner: null, runner: null, dispatch: { job: "build", at: "2026-10-06T08:10:00.000Z" } },
  ];
  f.box.queue = [
    { project: "proj", item: { id: "t3", title: "Fixture t3", dispatch: { job: "build", at: "2026-10-06T08:10:00.000Z" } } },
    { project: "other", item: { id: "t9", title: "Elsewhere", dispatch: { job: "review", at: "2026-10-06T08:20:00.000Z" } } },
  ];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /The review request is not claimed yet\. home:mbp is busy with t2 \(build, opencode\/glm-5\.3\) since 2026-10-06 08:05 UTC; 2 jobs queued ahead of it: proj\/t3 \(build\), other\/t9 \(review\)\./);
  // Said once, not on every poll.
  assert.equal(r.output.split("The review request is not claimed yet").length - 1, 1);
  assert.equal(f.box.states.t1, "merged");
  // A claimed request is waited for without the explanation.
  const g = await landFixture(t);
  g.box.review.approveAfter = 3; g.box.review.claimed = true;
  const claimed = await g.run(g.checkout, "land", "t1");
  assert.equal(claimed.status, 0, claimed.output);
  assert.doesNotMatch(claimed.output, /not claimed yet/);
  assert.equal(g.box.states.t1, "merged");
});


test("while the review request is unclaimed and no live runner offers the reviewer, the landing says it can never be claimed", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.approveAfter = 4;
  // No runner offers the review job for the routed reviewer: one offers the
  // job under another model, one offers no review job, one is the wrong kind.
  f.box.runners = [
    { runner: "cloud:far", kind: "cloud", jobs: ["build", "review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
    { runner: "home:mbp", kind: "home", jobs: ["build", "plan"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
    { runner: "home:studio", kind: "home", jobs: ["build", "plan", "review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }], at: new Date().toISOString() },
  ];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /The review request is not claimed yet, and no live runner can take it: cloud:far is a cloud runner, not a home one; home:mbp offers no review job; home:studio offers review as opencode\/glm-5\.3\. It will not be claimed until a runner that offers codex\/gpt-6-astra for the review job asks the server for work\. Review it by hand \(atelier review t1 --approve --as codex\/gpt-6-astra --note "…"\), then atelier accept t1 and atelier merge t1, or run atelier land t1 again with --reviewer H\/M to ask a model a live runner offers\./);
  // Said once, not on every poll, and the landing still lands on approval.
  assert.equal(r.output.split("The review request is not claimed yet").length - 1, 1);
  assert.equal(f.box.states.t1, "merged");
  // A runner that offers the reviewer reads as an ordinary wait again.
  const g = await landFixture(t);
  g.box.review.approveAfter = 3;
  g.box.runners = [{ runner: "home:studio", kind: "home", jobs: ["build", "plan", "review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() }];
  const offered = await g.run(g.checkout, "land", "t1");
  assert.equal(offered.status, 0, offered.output);
  assert.doesNotMatch(offered.output, /no live runner/);
  assert.equal(g.box.states.t1, "merged");
  // No runner has ever asked: said as that, not as a mismatch.
  const h = await landFixture(t);
  h.box.review.approveAfter = 3;
  h.box.runners = [];
  const none = await h.run(h.checkout, "land", "t1");
  assert.equal(none.status, 0, none.output);
  assert.match(none.output, /The review request is not claimed yet, and no runner has asked the server for work\. It will not be claimed until a runner that offers codex\/gpt-6-astra for the review job asks the server for work\./);
  assert.equal(h.box.states.t1, "merged");
});


test("a landing whose sole review runner has skipped says so by runner name and stops, instead of waiting out the hour", async (t) => {
  const f = await landFixture(t);
  // No verdict will ever arrive: the landing must say the skip, not time out.
  f.box.review.approveAfter = null;
  f.box.runners = [{ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() }];
  f.box.review.skips = [{ runner: "home:studio" }];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /every runner that offers codex\/gpt-6-astra for the review of t1 at \w+ has skipped it: home:studio\./);
  assert.equal(f.posts("/land").find((x) => x.body.step === "review")?.body.verdict, "skipped");
  assert.equal(f.posts("/land").find((x) => x.body.step === "review")?.body.reviewer, "codex/gpt-6-astra");
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.box.states.t1, "submitted");
  // A second runner offering the reviewer, still live, leaves one that has not
  // skipped: the landing keeps waiting instead of naming a partial skip.
  const g = await landFixture(t);
  g.box.review.approveAfter = 3;
  g.box.runners = [
    { runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
    { runner: "home:desk", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
  ];
  g.box.review.skips = [{ runner: "home:studio" }];
  const offered = await g.run(g.checkout, "land", "t1");
  assert.equal(offered.status, 0, offered.output);
  assert.doesNotMatch(offered.output, /has skipped it/);
  assert.equal(g.box.states.t1, "merged");
  // A skip of an earlier review request at the same head — an earlier
  // landing's — does not count against the request this landing made: the
  // landing waits for the verdict as before.
  const h = await landFixture(t);
  h.box.review.approveAfter = 3;
  h.box.review.request = 2;
  h.box.runners = [{ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() }];
  h.box.review.skips = [{ runner: "home:studio", request: 1 }];
  const earlier = await h.run(h.checkout, "land", "t1");
  assert.equal(earlier.status, 0, earlier.output);
  assert.doesNotMatch(earlier.output, /has skipped it/);
  assert.equal(h.box.states.t1, "merged");
});
