// The one-shot review (t273): a landing with no live runner for its reviewer
// runs the review once on this Mac, under the reviewer's own token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewerHere, reviewerOffered, runOneShotReview } from "../cli/review-oneshot.mjs";
import { runReview, runRunner } from "../cli/runner.mjs";

const H0 = "0".repeat(40), H1 = "a".repeat(40);
const FAKE = "atl_" + "f".repeat(64);
const model = "glm-5.3", reviewer = `opencode/${model}`;
const command = ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "--diff", "{diff_file}", "--verdict", "{verdict_file}"];
const claimed = {
  request: 7,
  item: { id: "t21", title: "Review rules", base: H0, scope: ["src/review/**"], fork: "p--t21", head: H1 },
  head: H1,
  need: { needed: true, reason: "every part is reviewed", head: H1, kind: "review", basis: "part", changeClass: "coordinated", changedPaths: ["src/review/needed.ts"], outOfScope: [], checks: [], round: 1, previous: [], previousReviewer: null, lapsed: [] },
  plan: null, events: [], owner: "owner",
  readToken: { remote: "https://artifacts.example/p--t21", token: "read-token", defaultBranch: "main" },
  target: { remote: "https://artifacts.example/p", token: "base-token", branch: "main" },
};

function setup(t, config) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-oneshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "runner.json");
  if (config) writeFileSync(configPath, JSON.stringify(config));
  return { dir, configPath };
}
const goodConfig = { agents: [{ agent: "opencode", models: [model], command }], jobs: ["review"], tokens: { [model]: "agent.glm" } };

function taskIO(calls, { claim = claimed, reject = null } = {}) {
  return {
    log: () => {}, stopped: () => false, env: {}, ownerTokens: () => ["atl_owner"],
    readSecret: () => FAKE,
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv, cwd, opts) {
      calls.push({ argv, opts });
      if (reject && argv[0] === "review-claim") throw new Error(reject);
      if (argv[0] === "review-claim") return JSON.stringify(claim);
      return "{}";
    },
    async clone() {}, async fetch() {}, async revParse() { return H0; }, async mergeBase() { return H0; }, async parents() { return `${H1} ${H0}`; },
    async diff() { return "diff --git a/src/review/needed.ts b/src/review/needed.ts\n+export const x = 1;\n"; },
    async brief() { return { file: "/cache/brief.txt" }; }, async writeDiff() { return { file: "/cache/diff.txt" }; },
    verdictPath: () => "/cache/verdict.txt",
    readVerdict: () => "VERDICT: APPROVE\nSUMMARY: Checked the diff.\nBLOCKING: 0",
    async harness() { return { code: 0, timedOut: false }; },
    async removeBrief() {}, removeDiff: () => {}, async dataHome() { return { dir: "/cache/data" }; }, async removeDataHome() {},
  };
}

test("a reviewer a live runner offers for the review job is left to that runner", () => {
  const now = new Date();
  const offer = (jobs, models) => ({ runner: "home:a", kind: "home", at: now.toISOString(), jobs, agents: [{ agent: "opencode", models }] });
  assert.equal(reviewerOffered(null, reviewer), null, "offers that could not be read are no answer");
  assert.equal(reviewerOffered([], reviewer, now), false);
  assert.equal(reviewerOffered([offer(["review"], [model])], reviewer, now), true);
  assert.equal(reviewerOffered([offer(["review"], [model])], "OpenCode/GLM-5.3", now), true);
  assert.equal(reviewerOffered([offer(["build"], [model])], reviewer, now), false, "a build runner does not review");
  assert.equal(reviewerOffered([offer(["review"], ["other"])], reviewer, now), false);
  assert.equal(reviewerOffered([{ ...offer(["review"], [model]), at: new Date(now - 3 * 3600_000).toISOString() }], reviewer, now), false, "a stale offer is no live runner");
});

test("a reviewer missing from this Mac is named: the config, the harness or the model", (t) => {
  const none = setup(t);
  assert.match(reviewerHere(reviewer, none.configPath).missing, /no runner config at .*runner\.json/);
  const some = setup(t, goodConfig);
  assert.match(reviewerHere("codex/gpt-6-astra", some.configPath).missing, /^the harness codex is missing: .* lists opencode, so codex\/gpt-6-astra cannot be run on this Mac/);
  assert.match(reviewerHere("opencode/kimi-2", some.configPath).missing, /^the model kimi-2 is missing: .* lists glm-5\.3 for opencode, so opencode\/kimi-2 cannot be run on this Mac/);
  const found = reviewerHere("OpenCode/GLM-5.3", some.configPath);
  assert.equal(found.missing, undefined);
  assert.deepEqual([found.agent, found.model], ["opencode", model]);
});

test("a missing model is named and nothing is claimed or run", async (t) => {
  const { configPath } = setup(t, goodConfig);
  let ran = false;
  const result = await runOneShotReview({ project: "atelier", id: "t21", reviewer: "opencode/kimi-2", deps: { configPath, runRunner: async () => { ran = true; } } });
  assert.match(result.missing, /the model kimi-2 is missing/);
  assert.equal(ran, false);
});

test("the one-shot runner claims the request and records the verdict under the reviewer's own token", async (t) => {
  const { configPath } = setup(t, goodConfig);
  const calls = [], lines = [];
  const result = await runOneShotReview({
    project: "atelier", id: "t21", reviewer, log: (l) => lines.push(l),
    deps: { configPath, runRunner, runReview, api: { server: () => "http://unused.invalid" }, workspacePath: (p, id) => `/cache/work/${p}/${id}`, checkoutOf: () => null, taskIO: taskIO(calls) },
  });
  assert.equal(result.phase, "reviewed", JSON.stringify(result));
  assert.equal(result.verdict, "approve");
  assert.deepEqual(calls.map((c) => c.argv[0]), ["review-claim", "review"], "it claims, then records; nothing is left to release");
  for (const c of calls) {
    assert.deepEqual(c.opts, { token: FAKE }, `${c.argv[0]} carries the reviewer's token and no other`);
    assert.equal(c.argv[c.argv.indexOf("--as") + 1], reviewer);
  }
  const verdict = calls[1].argv;
  assert.ok(verdict.includes("--approve") && verdict.includes("--request") && verdict[verdict.indexOf("--request") + 1] === "7");
  assert.match(lines.join("\n"), /no live runner offers opencode\/glm-5\.3/);
});

test("a one-shot review that fails leaves no claim held, and a refused claim is reported", async (t) => {
  const { configPath } = setup(t, goodConfig);
  const run = (io) => runOneShotReview({ project: "atelier", id: "t21", reviewer, deps: { configPath, runRunner, runReview, api: { server: () => "http://unused.invalid" }, workspacePath: () => "/cache/w", checkoutOf: () => null, taskIO: io } });
  // The harness writes no verdict: the job keeps the reply and releases the request in the same call.
  const calls = [];
  const io = taskIO(calls);
  io.readVerdict = () => "Looks fine.";
  const failed = await run(io);
  assert.equal(failed.phase, "failed");
  assert.ok(calls.some((c) => ["review-unparsable", "review-release"].includes(c.argv[0])), "the claim is given back");
  assert.ok(calls.every((c) => c.opts?.token === FAKE));
  // A claim the server refuses (a same-family reviewer on a protected change, say) holds nothing.
  const refusedCalls = [];
  const refused = await run(taskIO(refusedCalls, { reject: "same_family: opencode/glm-5.3 shares a family with a contributor" }));
  assert.equal(refused.phase, "failed");
  assert.match(refused.reason, /same_family/);
  assert.ok(!refusedCalls.some((c) => c.argv[0] === "review"), "no verdict was recorded");
});

test("the owner's token is not the reviewer's: a model with no token of its own is refused before any claim", async (t) => {
  const { configPath } = setup(t, { ...goodConfig, tokens: undefined });
  const calls = [];
  const result = await runOneShotReview({ project: "atelier", id: "t21", reviewer, deps: { configPath, runRunner, runReview, api: { server: () => "http://unused.invalid" }, workspacePath: () => "/cache/w", checkoutOf: () => null, taskIO: taskIO(calls) } });
  assert.equal(result.phase, "failed");
  assert.match(result.reason, /no agent token for opencode\/glm-5\.3/);
  assert.equal(calls.length, 0, "nothing was claimed");
});

test("atelier guide --role orchestrate states the one-shot review", async () => {
  const { rolePrompt } = await import("../cli/help.mjs");
  const text = rolePrompt("orchestrate").replace(/\s+/g, " ");
  assert.match(text, /no live runner offers that reviewer, the landing runs a one-shot review on this Mac/);
  assert.match(text, /its own verdict under its own token/);
  assert.match(text, /missing from the config is named and the landing stops/);
  assert.match(text, /same-family reviewer is refused as before/);
  assert.match(text, /exits after one verdict and holds no claim/);
});
