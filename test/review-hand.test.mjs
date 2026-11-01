import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker, { Ledger } from "../src/index.ts";
import { Namespace } from "../src/runtime/namespace.mjs";
import { cleanEntry } from "../src/models/pool.ts";
import { OFFER_LIVE_MS } from "../src/dispatch/rules.ts";
import { handLines } from "../cli/commands/review-claim.mjs";

const HEAD = "a".repeat(40), BUILDER = "claude-code/opus-5.5", REVIEWER = "codex/gpt-6-astra";
const RUNNER = { runner: "home:studio", kind: "home" };
async function world(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-hand-"));
  const env = {
    PUBLIC_ORIGIN: "http://localhost",
    ATELIER_TOKEN: "atl_00112233445566778899aabbccddeeff00112233",
    REPOS: { get: async () => ({
      log: async () => [{ hash: HEAD }],
      readCommit: async (hash) => ({ hash, parents: [HEAD] }),
      diff: async () => "",
      [Symbol.dispose]() {},
    }) },
    GIT: { mint: () => ({ id: "read", token: "read-token", expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
  };
  const ns = new Namespace({ dir, Class: Ledger, env });
  env.LEDGER = ns;
  t.after(async () => { await ns.close(); rmSync(dir, { recursive: true, force: true }); });
  const L = ns.get(ns.idFromName("project:demo")), I = ns.get(ns.idFromName("__index"));
  const pool = [cleanEntry({ id: "opus-5.5", harness: "claude-code", where: "home" }, "owner", new Date().toISOString()), cleanEntry({ id: "gpt-6-astra", harness: "codex", where: "home" }, "owner", new Date().toISOString())];
  const record = { name: "demo", repo: "demo", branch: "main", policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner"); await I.registerProject(record);
  for (const m of pool) await I.putModel(m);
  const { id } = await L.newItem("Review me", ["src/**"], "owner", { accept: ["Works"] });
  await L.claim(id, BUILDER, RUNNER);
  await L.setWorkspace(id, "fork", "0".repeat(40), BUILDER);
  await L.recordPush(id, BUILDER, HEAD, HEAD);
  await L.submit(id, BUILDER);
  await L.addEvidence({ itemId: id, head: HEAD, by: "owner", at: new Date().toISOString(), claim: "paths", grade: "observed", passed: true, changedPaths: ["src/a.ts"] });
  const asked = await L.requestReview(id, "owner", REVIEWER, pool, true, false, undefined, [], true);
  const api = async (verb, actor = REVIEWER, body = {}, runner) => worker.fetch(new Request(`http://localhost/api/projects/demo/items/${id}/${verb}`, {
    method: "POST", headers: { authorization: `Bearer ${env.ATELIER_TOKEN}`, "content-type": "application/json", "x-atelier-actor": actor, "x-atelier-acting": BUILDER, ...(runner ? { "x-atelier-runner": runner } : {}) }, body: JSON.stringify(body),
  }), env);
  const offer = (change = {}, age = 0) => I.putRunnerOffer({ ...RUNNER, agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["review"], ...change }, new Date(Date.now() - age).toISOString());
  return { L, I, id, asked, pool, api, offer };
}

test("criterion 1: with no live review runner a direct claim binds the request and prints the verdict command", async (t) => {
  const { L, id, asked, api } = await world(t);
  const res = await api("review-claim");
  assert.equal(res.status, 200, await res.clone().text());
  const claim = await res.json();
  assert.equal(claim.request, asked.request);
  assert.equal(claim.head, HEAD);
  assert.equal(claim.criteria, await L.criteria(id));
  assert.ok(handLines(id, claim, REVIEWER).includes(`Record the verdict with: atelier review ${id} --head ${HEAD} --request ${asked.request} --criteria ${claim.criteria} --approve|--reject --note "…" --as ${REVIEWER}`));
  assert.equal((await L.reviewRequests(id))[0].claimedBy, REVIEWER);
  assert.equal((await api("review", REVIEWER, { head: HEAD, request: claim.request, criteria: claim.criteria, approve: true, note: "Checked" })).status, 200);
});

test("criterion 2: a live-runner refusal names a working claim command", async (t) => {
  const { api, offer, id } = await world(t);
  await offer();
  const res = await api("review-claim");
  assert.equal(res.status, 409);
  const error = await res.json();
  assert.match(error.next, new RegExp(`atelier review-claim ${id} --as ${REVIEWER} --runner home:studio`));
  assert.equal((await api("review-claim", REVIEWER, {}, "home:studio")).status, 200);
});

test("criterion 2: undispatch identifies the review request and names its working withdrawal command", async (t) => {
  const { api, id, asked } = await world(t);
  const res = await api("undispatch", "owner");
  assert.equal(res.status, 409);
  const error = await res.json();
  assert.match(error.next, new RegExp(`atelier review-withdraw ${id} --request ${asked.request} --reason`));
  assert.equal((await api("review-withdraw", "owner", { request: asked.request, reason: "Serve a different review" })).status, 200);
});

test("criterion 2: a verdict missing its live request names a complete verdict command", async (t) => {
  const { api, id } = await world(t);
  const res = await api("review-claim", REVIEWER, {}, "home:studio");
  assert.equal(res.status, 200, await res.clone().text());
  const claim = await res.json();
  const verdict = { head: HEAD, criteria: claim.criteria, approve: true, note: "Checked" };
  const rejected = await api("review", REVIEWER, verdict);
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).next, new RegExp(`atelier review ${id} --head ${HEAD} --request ${claim.request} --criteria ${claim.criteria}`));
  assert.equal((await api("review", REVIEWER, { ...verdict, request: claim.request })).status, 200);
});

for (const [name, change, age] of [
  ["expired review offer", {}, OFFER_LIVE_MS + 1_000],
  ["live build-only runner", { jobs: ["build"] }, 0],
  ["live runner serving another project", { projects: ["elsewhere"] }, 0],
]) test(`direct claim ignores: ${name}`, async (t) => {
  const { api, offer } = await world(t);
  await offer(change, age);
  const res = await api("review-claim");
  assert.equal(res.status, 200, await res.clone().text());
});

test("an offer inside the existing liveness window still requires --runner", async (t) => {
  const { api, offer } = await world(t);
  await offer({}, OFFER_LIVE_MS - 60_000);
  assert.equal((await api("review-claim")).status, 409);
});

test("direct claims preserve contributor and requested-reviewer restrictions", async (t) => {
  const { api, L, id } = await world(t);
  const self = await api("review-claim", BUILDER);
  assert.equal((await self.json()).error, "self_review");
  const other = await api("review-claim", "codex/gpt-6-sol");
  const error = await other.json();
  assert.equal(error.error, "wrong_model");
  assert.match(error.next, new RegExp(`atelier review-claim ${id} --as ${REVIEWER}`));
  assert.equal((await L.reviewRequests(id))[0].state, "open");
  assert.equal((await api("review-claim")).status, 200);
  assert.equal((await api("review-claim")).status, 404, "a request is claimed only once");
});

test("a no-runner request refusal names --hand, which opens a directly claimable request", async (t) => {
  const { L, id, pool, api } = await world(t);
  await L.admitReviewer("gpt-6-astra", true, "Independent reviewer", "owner", pool);
  const res = await api("review-request", "owner", { reviewer: REVIEWER, wanted: true });
  assert.equal(res.status, 409);
  const error = await res.json();
  assert.equal(error.error, "no_runner");
  assert.match(error.next, new RegExp(`atelier review-request ${id} --reviewer ${REVIEWER} --hand`));
  assert.equal((await api("review-request", "owner", { reviewer: REVIEWER, wanted: true, hand: true })).status, 200);
  assert.equal((await api("review-claim")).status, 200);
});

test("a stale verdict names a working claim of the replacement request", async (t) => {
  const { api, L, id, pool } = await world(t);
  const first = await (await api("review-claim")).json();
  await L.releaseReview(id, REVIEWER, "Retry", false, first.request);
  await L.requestReview(id, "owner", REVIEWER, pool, true, false, undefined, [], true);
  const verdict = { head: HEAD, criteria: first.criteria, request: first.request, approve: true, note: "Checked" };
  const refused = await api("review", REVIEWER, verdict);
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).next, new RegExp(`atelier review-claim ${id} --as ${REVIEWER}`));
  const second = await (await api("review-claim")).json();
  assert.notEqual(second.request, first.request);
  assert.equal((await api("review", REVIEWER, { ...verdict, request: second.request })).status, 200);
});

test("a by-hand post-merge review claims and judges the recorded landing", async (t) => {
  const { api, L, id, pool } = await world(t);
  const project = await L.project();
  await L.setProject({ ...project, policy: { ...project.policy, protected: ["src/**"] } }, "owner");
  await L.confirmOverride(id, "owner", HEAD, "access");
  await L.accept(id, "owner", HEAD, "No independent runner available");
  const merge = "e".repeat(40);
  await L.merged(id, "owner", merge, true);
  const asked = await L.requestReview(id, "owner", REVIEWER, pool, true, false, undefined, [], true);
  const claimRes = await api("review-claim");
  assert.equal(claimRes.status, 200, await claimRes.clone().text());
  const claim = await claimRes.json();
  assert.equal(claim.head, merge);
  assert.equal(claim.request, asked.request);
  const missing = await api("review", REVIEWER, { head: merge, criteria: claim.criteria, approve: true, note: "Audited landing" });
  assert.equal(missing.status, 409);
  const error = await missing.json();
  assert.equal(error.error, "stale_request");
  assert.match(error.next, new RegExp(`atelier review ${id} --head ${merge} --request ${claim.request} --criteria ${claim.criteria}`));
  const res = await api("review", REVIEWER, { head: merge, criteria: claim.criteria, request: claim.request, approve: true, note: "Audited landing" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await L.item(id)).state, "merged");
  assert.equal((await L.reviewsFor(id))[0].postMerge, true);
});

test("a withdrawn review's stale verdict names a request command that recreates it", async (t) => {
  const { api, L, id, pool } = await world(t);
  const first = await (await api("review-claim")).json();
  await L.releaseReview(id, REVIEWER, "Retry", false, first.request);
  const res = await api("review", REVIEWER, { head: HEAD, criteria: first.criteria, request: first.request, approve: true, note: "Late verdict" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).next, new RegExp(`atelier review-request ${id} --reviewer ${REVIEWER} --hand`));
  await L.requestReview(id, "owner", REVIEWER, pool, true, false, undefined, [], true);
  assert.equal((await api("review-claim")).status, 200);
});

test("a direct claim cannot use a withdrawn reviewer admission", async (t) => {
  const { L, id, pool, api } = await world(t);
  await L.admitReviewer("gpt-6-astra", true, "Independent reviewer", "owner", pool);
  await L.admitReviewer("gpt-6-astra", false, "Withdrawn", "owner", pool);
  const res = await api("review-claim");
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "reviewer_withdrawn");
  assert.notEqual((await L.reviewRequests(id))[0].state, "claimed");
});
