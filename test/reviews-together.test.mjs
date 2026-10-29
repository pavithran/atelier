// G11 (lessons-to-2.0, S7, HO, CA7; rows 15, 48, 49): the reviews a gate
// needs are asked together at one head and run side by side; a rejection
// stands beside an approval; an override and a merge leave no gate request
// open; a second model's check of blocking findings is recorded on the
// review. Each test starts the real Node server with its Git hook, claims and
// pushes through the real CLI (test/land-node-shared.mjs) and serves the
// reviews through the claim and verdict routes a runner calls. Every
// credential is a dummy.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { landingWorld } from "./land-node-shared.mjs";
import { formatReviews } from "../cli/atelier.mjs";

const OPUS = "claude-code/opus-5.5";
const GLM = "opencode/glm-5.3";

// Both reviewers registered and admitted to the project, as the developer does.
async function reviewers(w) {
  for (const argv of [["models", "add", "opus-5.5", "--harness", "claude-code", "--where", "home"], ["models", "add", "glm-5.3", "--harness", "opencode", "--where", "home"],
    ["models", "admit", OPUS, "--reason", "a gate reviewer"], ["models", "admit", GLM, "--reason", "a gate reviewer"]]) {
    const r = await w.cli(argv);
    assert.equal(r.status, 0, r.output);
  }
}

// A reviewer's runner claims its request and answers it, as cli/runner.mjs does.
const claim = async (w, id, reviewer) => {
  const r = await fetch(`${w.base}/api/projects/demo/items/${id}/review-claim`, { method: "POST", headers: { authorization: "Bearer atl_00112233445566778899aabbccddeeff", "content-type": "application/json", "x-atelier-actor": reviewer, "x-atelier-acting": OPUS, "x-atelier-runner": "home:hand" }, body: "{}" });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  return body;
};
const verdict = (w, id, reviewer, c, approve, extra = {}) => w.api("POST", `/projects/demo/items/${id}/review`, { head: c.head, criteria: c.criteria, request: c.request, approve, note: approve ? "Fine" : "Broken", ...extra }, undefined, reviewer);

test("two reviewers asked together at one head both stand open and are claimed side by side; one rejects, the other approves, and the rejection stands", async (t) => {
  const w = await landingWorld(t);
  await reviewers(w);
  const { id, head } = await w.task({ files: { "shared.txt": "changed\n" }, approve: false });
  const asked = await w.cli(["review-request", id, "--reviewer", OPUS, "--reviewer", GLM, "--hand"]);
  assert.equal(asked.status, 0, asked.output);
  const answer = JSON.parse(asked.stdout);
  assert.deepEqual(answer.asked.map((a) => [a.reviewer, a.head, a.requested]), [[OPUS, head, true], [GLM, head, true]]);
  // Neither request replaced the other: both are open at the head together.
  const open = (await w.L().reviewRequests(id)).filter((r) => r.head === head && r.state === "open");
  assert.equal(open.length, 2, JSON.stringify(open));
  const together = (await w.detail(id)).events.find((e) => e.kind === "review.asked_together");
  assert.deepEqual(together.data.reviewers, [OPUS, GLM]);
  assert.equal(together.data.acting, OPUS, "the developer-token write names the acting model");

  // Both are claimed before either answers: the reviews run at the same time.
  const a = await claim(w, id, OPUS), b = await claim(w, id, GLM);
  assert.notEqual(a.request, b.request);
  assert.deepEqual((await w.L().reviewRequests(id)).filter((r) => r.head === head).map((r) => r.state), ["claimed", "claimed"]);

  // Edge: one rejects with a blocking finding, the other approves; the rejection stands.
  const rejected = await verdict(w, id, OPUS, a, false, { findings: [{ file: "shared.txt", line: 1, severity: "blocking", text: "the line is wrong" }] });
  assert.equal(rejected.status, 200, rejected.text);
  const approved = await verdict(w, id, GLM, b, true);
  assert.equal(approved.status, 200, approved.text);
  const accept = await w.cli(["accept", id]);
  assert.notEqual(accept.status, 0, accept.output);
  assert.match(accept.output, /not_ready/);
  assert.match(accept.output, /next: /);
  assert.equal((await w.detail(id)).item.state, "submitted");
});

test("asking together is refused whole: an ineligible second reviewer asks neither", async (t) => {
  const w = await landingWorld(t);
  await reviewers(w);
  const { id } = await w.task({ files: { "shared.txt": "changed\n" }, approve: false });
  const r = await w.cli(["review-request", id, "--reviewer", OPUS, "--reviewer", "codex/gpt-6", "--hand"]);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /self_review: codex\/gpt-6 contributed/);
  assert.match(r.output, /next: /);
  assert.deepEqual((await w.L().reviewRequests(id)).filter((q) => q.state === "open"), [], "the first reviewer's request rolled back with the refusal");
});

test("CA7: two reviewers requested, accepted by override and merged: no gate request is left open", async (t) => {
  const w = await landingWorld(t);
  await reviewers(w);
  const { id, head } = await w.task({ files: { "shared.txt": "changed\n" }, approve: false });
  const asked = await w.cli(["review-request", id, "--reviewer", OPUS, "--reviewer", GLM, "--hand"]);
  assert.equal(asked.status, 0, asked.output);
  await claim(w, id, GLM); // one claimed, one still open
  const accepted = await w.cli(["accept", id, "--override-review", "the reviewers are down for the day", "--quote", "override it and merge"]);
  assert.equal(accepted.status, 0, accepted.output);
  const landed = await w.cli(["land", id]);
  assert.equal(landed.status, 0, landed.output);
  assert.equal((await w.detail(id)).item.state, "merged");
  const live = (await w.L().reviewRequests(id)).filter((r) => r.head === head && (r.state === "open" || r.state === "claimed"));
  assert.deepEqual(live, [], `no gate request may be taken for the post-merge review: ${JSON.stringify(live)}`);
});

test("a second model's check of the blocking findings is recorded on the review: who, its answer and the findings it demoted", async (t) => {
  const w = await landingWorld(t);
  await reviewers(w);
  const { id, head } = await w.task({ files: { "shared.txt": "changed\n" }, approve: false });
  const asked = await w.cli(["review-request", id, "--reviewer", OPUS, "--hand"]);
  assert.equal(asked.status, 0, asked.output);
  const c = await claim(w, id, OPUS);
  // What cli/runner.mjs posts after the check demoted finding 1: an approval with a follow-up.
  const verification = { by: GLM, answer: "FINDING 1: NOT CONFIRMED because the line is as the brief asks.", demoted: [{ index: 1, label: "unverified", text: "the line is wrong" }] };
  const r = await w.cli(["review", id, "--as", OPUS, "--approve", "--head", head, "--criteria", c.criteria, "--request", String(c.request), "--note", "no blocking finding stood",
    "--findings", JSON.stringify([{ file: "shared.txt", line: 1, severity: "follow-up", label: "unverified", text: "the line is wrong" }]), "--verification", JSON.stringify(verification)]);
  assert.equal(r.status, 0, r.output);
  const review = (await w.detail(id)).reviews.find((v) => v.by === OPUS && v.head === head);
  assert.deepEqual(review.verification, verification);
  const shown = formatReviews([review], "owner");
  assert.match(shown, /Checked by opencode\/glm-5\.3: demoted finding 1 \(unverified\) to a follow-up\./);
  assert.match(shown, /Whether a demotion stands is the orchestrator's call: .*atelier finding ID --head \w+ --reviewer claude-code\/opus-5\.5 --index N --verdict confirmed/);
  assert.match(shown, /Its answer: FINDING 1: NOT CONFIRMED/);
  // A malformed check is refused, with nothing recorded.
  const bad = await w.api("POST", `/projects/demo/items/${id}/review`, { head, criteria: c.criteria, approve: true, note: "x", verification: { by: "nobody", answer: 1, demoted: [] } }, undefined, OPUS);
  assert.equal(bad.status, 400, bad.text);
});
