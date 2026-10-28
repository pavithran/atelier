// Atelier 2.0, lessons gap G16. The gate asks an approval from a model of
// another family than every contributor (independentApproval), and a project
// may forbid overrides (noOverride). record-merge, the developer's route that
// records a merge made outside Atelier with its reviews, now applies the
// same: an approval from a contributor's own family is refused with the
// gate's message, and a project that forbids overrides refuses a record that
// would need one. The merge guard no longer compares the retired eligible
// list, so a merge is not refused for contributors "no longer eligible".
// Each test starts the real server and drives the record-merge route and the
// Ledger through the namespace. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { criteriaOf } from "../src/criteria.ts";
import { acceptancePolicy, gate, mergeContext, mergePolicyDecision, overrideForbidden, PROTECTED_NEED, recordedMergeIndependence } from "../src/rules.ts";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "codex/gpt-6";
const SAME = "codex/gpt-6-astra";         // another model of the builder's family (openai)
const OTHER = "claude-code/opus-5.5";      // another family (anthropic)
const root = mkdtempSync(join(tmpdir(), "atelier-record-merge-independence-"));
after(() => rmSync(root, { recursive: true, force: true }));

const sha = (c) => c.repeat(40);
const BASE = sha("0");
// The baseline: each merge recorded here is added on top of main, with BASE
// as its first parent and the task's head as its second.
const commits = [{ hash: BASE, parents: [], treeHash: BASE }];
const artifacts = {
  create: async () => ({}),
  get: async (repo) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    log: async () => commits,
    readCommit: async (hash) => commits.find((c) => c.hash === hash) ?? null,
    createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }),
};

let server;
const ledger = (project) => server.namespace.get(server.namespace.idFromName(`project:${project}`));
function api(method, path, body) {
  return fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let n = 0;
// A task the builder claimed and pushed, with its checks observed at the head
// and, unless `paths` is null, the paths Atelier measured there.
async function builtTask(project, paths = ["src/a.ts"]) {
  const r = await api("POST", `/projects/${project}/items`, { title: `task ${++n}` });
  assert.equal(r.status, 201);
  const made = await r.json();
  const id = (made.item ?? made).id;
  const L = ledger(project);
  const claim = await L.claim(id, BUILDER);
  await L.recordToken(id, BUILDER, claim.generation, null, null);
  const head = n.toString(16).padStart(40, "b");
  await L.observePush(id, head, (await L.item(id)).head ?? null);
  if (paths) await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: BUILDER, at: new Date().toISOString(), changedPaths: paths });
  return { id, head, L };
}
// The merge of `head` into main, made outside Atelier.
function mergeOutside(head) {
  const hash = `${head.slice(0, 8)}`.padEnd(40, "c");
  commits.unshift({ hash, parents: [BASE, head], treeHash: BASE });
  return hash;
}
const recordMerge = (project, id, body) => api("POST", `/projects/${project}/items/${id}/record-merge`, body);
const approvalBy = (by, head) => ({ by, verdict: "approve", head });
// A review the reviewer's own token recorded at the head, as the review routes record one.
const review = async (L, id, by, head, approve = true, proved = true) =>
  L.addReview({ itemId: id, by, head, approve, criteria: criteriaOf(await L.item(id)), note: approve ? "Fine" : "Not yet", at: new Date().toISOString() }, undefined, proved);
const recorded = async (L, id) => (await L.events(id, 500)).filter((e) => e.kind === "item.merge_recorded");

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, bindings: { ARTIFACTS: artifacts } });
  assert.equal((await api("PUT", "/projects/open", { checks: ["npm test"], protected: ["src/**"] })).status, 200);
  assert.equal((await api("PUT", "/projects/strict", { checks: ["npm test"], protected: ["src/**"], noOverride: true })).status, 200);
  assert.equal((await api("PUT", "/projects/fastp", { checks: ["npm test"], protected: ["src/**"] })).status, 200);
  assert.equal((await api("PUT", "/projects/risk", { checks: ["npm test"], protected: ["src/**"], riskReviews: { core: ["src/**"], reviews: { "docs-or-tests": 0, other: 2, core: 2 } } })).status, 200);
});
after(async () => { await server?.close(); });

test("a record-merge naming an approval from a contributor's own family is refused with the gate's message and a next", async () => {
  const { id, head, L } = await builtTask("open");
  const merge = mergeOutside(head);
  const r = await recordMerge("open", id, { mergeCommit: merge, head, reviews: [approvalBy(SAME, head)] });
  const body = await r.json();
  assert.equal(r.status, 403, body.detail);
  assert.equal(body.error, "not_independent");
  assert.ok(body.detail.includes(PROTECTED_NEED), body.detail);
  assert.match(body.detail, /codex\/gpt-6-astra: same family as contributor codex\/gpt-6 \(openai\)/);
  assert.match(body.next, /atelier record-merge .* --review H\/M=approve@/);
  // Nothing was recorded: the task is still the builder's, and not merged.
  const item = await L.item(id);
  assert.equal(item.state, "claimed");
  assert.equal(item.owner, BUILDER);
  assert.deepEqual(await recorded(L, id), []);

  // The builder's own model, under another harness, is refused as a contributor.
  const own = await (await recordMerge("open", id, { mergeCommit: merge, head, reviews: [approvalBy("opencode/gpt-6", head)] })).json();
  assert.equal(own.error, "not_independent");
  assert.match(own.detail, /opencode\/gpt-6: a contributor, and no model reviews its own work/);
});

test("paths never observed are taken as a protected change's, so the same-family approval is refused there too", async () => {
  const { id, head, L } = await builtTask("open", null);
  const r = await recordMerge("open", id, { mergeCommit: mergeOutside(head), head, reviews: [approvalBy(SAME, head)] });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "not_independent");
  assert.equal((await L.item(id)).state, "claimed");
});

test("a valid record-merge, naming an approval from another family the Ledger holds beside a same-family one, still succeeds, in a project that forbids overrides too", async () => {
  const { id, head, L } = await builtTask("strict");
  await review(L, id, OTHER, head);
  const merge = mergeOutside(head);
  const r = await recordMerge("strict", id, { mergeCommit: merge, head, reviews: [approvalBy(SAME, head), approvalBy(OTHER, head)] });
  const body = await r.json();
  assert.equal(r.status, 200, body.detail);
  assert.equal(body.item.state, "merged");
  assert.equal(body.record.mergeCommit, merge);
  assert.equal(body.record.override, undefined);
  const [event] = await recorded(L, id);
  assert.deepEqual(event.data.reviews.map((v) => v.by), [SAME, OTHER]);
});

test("a change the gate asks no review of keeps record-merge's own rule: one approval at the commit, of any family", async () => {
  const { id, head } = await builtTask("open", ["docs/a.md"]);
  const r = await recordMerge("open", id, { mergeCommit: mergeOutside(head), head, reviews: [approvalBy(SAME, head)] });
  assert.equal(r.status, 200, (await r.clone().json()).detail);
  assert.equal((await r.json()).item.state, "merged");
});

test("a project that forbids overrides refuses a record-merge that needs one, and accepts one that does not", async () => {
  const { id, head, L } = await builtTask("strict");
  const merge = mergeOutside(head);
  const r = await recordMerge("strict", id, { mergeCommit: merge, head, reviews: [approvalBy(SAME, head)] });
  const body = await r.json();
  assert.equal(r.status, 403, body.detail);
  assert.equal(body.error, "override_forbidden");
  assert.ok(body.detail.includes(PROTECTED_NEED), body.detail);
  assert.ok(body.detail.includes(overrideForbidden(null)), body.detail);
  assert.ok(body.next);
  assert.equal((await L.item(id)).state, "claimed");

  await review(L, id, OTHER, head);
  const ok = await recordMerge("strict", id, { mergeCommit: merge, head, reviews: [approvalBy(OTHER, head)] });
  assert.equal(ok.status, 200, (await ok.clone().json()).detail);
  assert.equal((await ok.json()).item.state, "merged");
});

test("an override standing at the commit stands in for the review, as in the gate, until the project forbids overrides", async () => {
  // Accepted with the developer's override of the review (their words and the
  // model acting on them), then merged outside Atelier.
  const { id, head, L } = await builtTask("open");
  await L.submit(id, BUILDER, "done");
  await L.accept(id, "owner", head, "no other family was available", undefined, undefined, undefined, undefined, OTHER, "PAVI: override it, nobody else can review today");
  assert.equal((await L.item(id)).reviewOverride.head, head);
  const merge = mergeOutside(head);

  // The project now forbids overrides: the standing override no longer counts.
  assert.equal((await api("PUT", "/projects/open", { noOverride: true })).status, 200);
  const refused = await recordMerge("open", id, { mergeCommit: merge, head, reviews: [approvalBy(SAME, head)] });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, "override_forbidden");
  assert.equal((await L.item(id)).state, "accepted");

  // Allowed again, it does, and the record names its reason.
  assert.equal((await api("PUT", "/projects/open", { noOverride: false })).status, 200);
  const r = await recordMerge("open", id, { mergeCommit: merge, head, reviews: [approvalBy(SAME, head)] });
  const body = await r.json();
  assert.equal(r.status, 200, body.detail);
  assert.equal(body.item.state, "merged");
  assert.equal(body.record.override, "no other family was available");
});

test("the merge guard does not refuse a merge for contributors no longer eligible", async () => {
  assert.equal((await api("PUT", "/projects/guard", { checks: ["npm test"], protected: ["src/**"] })).status, 200);
  const L = ledger("guard");
  const { id, head } = await builtTask("guard");
  await L.addReview({ itemId: id, by: OTHER, head, approve: true, criteria: criteriaOf(await L.item(id)), note: "Fine", at: new Date().toISOString() }, undefined, true);
  await L.submit(id, BUILDER, "done");
  await L.accept(id, "owner", head);
  // The retired eligible list as the project still stores it, leaving the builder's harness out.
  const p = await L.project();
  await L.setProject({ ...p, policy: { ...p.policy, eligible: ["claude"] } }, "owner");

  // What atelier merge reads and compares (cli/commands/merge.mjs), for an
  // acceptance a 1.x server recorded with the list then, which named the
  // builder's harness (new acceptances record none, t152).
  const d = await (await api("GET", `/projects/guard/items/${id}`)).json();
  assert.equal(d.item.state, "accepted");
  d.acceptancePolicy = { ...d.acceptancePolicy, eligible: ["codex"] };
  const nowPolicy = d.policy, acceptedPolicy = acceptancePolicy(d, nowPolicy);
  assert.deepEqual([acceptedPolicy.eligible, nowPolicy.eligible], [["codex"], ["claude"]]);
  const context = mergeContext(d, []);
  assert.equal("contributors" in context, false);
  const decision = mergePolicyDecision(acceptedPolicy, nowPolicy, ["src/a.ts"], false, context);
  // The change is still named, and refuses nothing.
  assert.match(decision.warning, /eligible: \["codex"\] -> \["claude"\]/);
  assert.equal(decision.refusal, null);
});

test("a withdrawn approval does not come back: the reviewer's later rejection at the same head stands, as at the gate", async () => {
  for (const project of ["strict", "open"]) {
    // In the Ledger: the independent reviewer approved, then rejected.
    const { id, head, L } = await builtTask(project);
    await review(L, id, OTHER, head);
    await new Promise((ok) => setTimeout(ok, 5));
    await review(L, id, OTHER, head, false);
    const r = await recordMerge(project, id, { mergeCommit: mergeOutside(head), head, reviews: [approvalBy(OTHER, head)] });
    const body = await r.json();
    assert.equal(r.status, 403, body.detail);
    assert.equal(body.error, project === "strict" ? "override_forbidden" : "not_independent");
    assert.match(body.detail, /claude-code\/opus-5\.5: withdrawn by its later rejection/);
    assert.equal((await L.item(id)).state, "claimed");
  }
  // Named in the record: an approval and then the same reviewer's rejection.
  const { id, head, L } = await builtTask("strict");
  await review(L, id, OTHER, head);
  const r = await recordMerge("strict", id, { mergeCommit: mergeOutside(head), head, reviews: [approvalBy(OTHER, head), { by: OTHER, verdict: "reject", head }] });
  assert.equal(r.status, 403);
  assert.match((await r.json()).detail, /withdrawn by its later rejection/);
  assert.equal((await L.item(id)).state, "claimed");
});

test("an approval no review the Ledger holds proves is unproved: refused where overrides are, and only an override where they are allowed", async () => {
  // Named alone, and held only as the developer recorded it in the model's name.
  for (const held of [false, true]) {
    const { id, head, L } = await builtTask("strict");
    if (held) await review(L, id, OTHER, head, true, false);
    const r = await recordMerge("strict", id, { mergeCommit: mergeOutside(head), head, reviews: [approvalBy(OTHER, head)] });
    const body = await r.json();
    assert.equal(r.status, 403, body.detail);
    assert.equal(body.error, "override_forbidden");
    assert.match(body.detail, /the approval by claude-code\/opus-5\.5 was recorded by .* answers no review request/);
    assert.equal((await L.item(id)).state, "claimed");
  }
  const { id, head } = await builtTask("open");
  const r = await recordMerge("open", id, { mergeCommit: mergeOutside(head), head, reviews: [approvalBy(OTHER, head)] });
  const body = await r.json();
  assert.equal(r.status, 200, body.detail);
  assert.match(body.record.override, /developer's record of claude-code\/opus-5\.5's approval, which no review the Ledger holds proves/);
});

test("an independent approval at another head is not the commit's review", async () => {
  const { id, head, L } = await builtTask("strict");
  await review(L, id, OTHER, head);
  // The builder pushes again; the approval stays at the earlier head.
  const later = n.toString(16).padStart(40, "d");
  await L.observePush(id, later, head);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: later, passed: true, by: BUILDER, at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
  const merge = mergeOutside(later);
  const r = await recordMerge("strict", id, { mergeCommit: merge, head: later, reviews: [approvalBy(OTHER, head), approvalBy(OTHER, later)] });
  const body = await r.json();
  assert.equal(r.status, 403, body.detail);
  assert.equal(body.error, "override_forbidden");
  // Named at the earlier head alone, nothing approves the commit merged.
  const none = await recordMerge("strict", id, { mergeCommit: merge, head: later, reviews: [approvalBy(OTHER, head)] });
  assert.equal((await none.json()).error, "no_approval");
  assert.equal((await L.item(id)).state, "claimed");
});

test("one model under two names counts once when the change's class needs several reviews", async () => {
  const { id, head, L } = await builtTask("risk", ["lib/a.ts"]);
  const merge = mergeOutside(head);
  const twice = await recordMerge("risk", id, { mergeCommit: merge, head, reviews: [approvalBy(OTHER, head), approvalBy("codex/claude-opus-5-5", head)] });
  const body = await twice.json();
  assert.equal(twice.status, 403, body.detail);
  assert.equal(body.error, "not_independent");
  assert.match(body.detail, /other change: needs 2 independent reviews, .*; 1 so far/);
  assert.equal((await L.item(id)).state, "claimed");
  const ok = await recordMerge("risk", id, { mergeCommit: merge, head, reviews: [approvalBy(OTHER, head), approvalBy("antigravity/gemini-4-argon", head)] });
  assert.equal(ok.status, 200, (await ok.clone().json()).detail);
});

test("in fast mode record-merge asks no review before the merge, as the gate does", async () => {
  const { id, head, L } = await builtTask("fastp");
  const blockers = async () => (await (await api("GET", `/projects/fastp/items/${id}`)).json()).gate.blockers;
  assert.ok((await blockers()).includes(PROTECTED_NEED));
  await L.setMode("owner", "fast", "reviewers are down", OTHER, "PAVI: go fast today");
  assert.ok(!(await blockers()).includes(PROTECTED_NEED));
  const r = await recordMerge("fastp", id, { mergeCommit: mergeOutside(head), head, reviews: [approvalBy(SAME, head)] });
  const body = await r.json();
  assert.equal(r.status, 200, body.detail);
  assert.equal(body.item.state, "merged");
});

test("a rejection-only override and one recorded at another head do not stand in for the review, as at the gate", () => {
  const head = "1".repeat(40), older = "2".repeat(40), at = "2026-10-28T12:00:00.000Z";
  const policy = { checks: ["npm test"], protected: ["src/**"] };
  const evidence = [{ itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: BUILDER, at, changedPaths: ["src/a.ts"] }];
  const item = { id: "t1", kind: "task", title: "t", state: "submitted", owner: BUILDER, head, base: "0".repeat(40), scope: [], pushActors: [BUILDER] };
  const record = { commit: head, reviews: [approvalBy(SAME, head)], at };
  const cases = {
    rejectionsOnly: { head, by: "owner", reason: "waive the rejection", at, rejectionsOnly: true, rejections: [] },
    stale: { head: older, by: "owner", reason: "an older revision", at },
  };
  for (const [name, reviewOverride] of Object.entries(cases)) {
    const withOverride = { ...item, reviewOverride };
    const got = recordedMergeIndependence(record, withOverride, policy, evidence, [], "owner");
    assert.equal(got.override, null, name);
    assert.equal(got.refusal?.code, "not_independent", name);
    assert.ok(gate(withOverride, policy, evidence, [], "owner").blockers.includes(PROTECTED_NEED), name);
  }
  // A current override at the commit stands in, at both.
  const current = { ...item, reviewOverride: { head, by: "owner", reason: "no reviewer", at } };
  assert.equal(recordedMergeIndependence(record, current, policy, evidence, [], "owner").override?.reason, "no reviewer");
  assert.equal(gate(current, policy, evidence, [], "owner").ready, true);
});

test("where two reviews are needed a tier approval counts as any other, as the gate counts it", () => {
  const head = "3".repeat(40), at = "2026-10-28T12:00:00.000Z";
  const policy = { checks: ["npm test"], protected: ["src/**"], riskReviews: { core: ["src/**"], reviews: { "docs-or-tests": 0, other: 2, core: 2 } } };
  const evidence = [{ itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: BUILDER, at, changedPaths: ["src/a.ts"] }];
  const item = { id: "t1", kind: "task", title: "t", state: "submitted", owner: BUILDER, head, base: "0".repeat(40), scope: [], pushActors: [BUILDER] };
  const criteria = criteriaOf(item);
  const reviews = [
    { itemId: "t1", by: OTHER, head, approve: true, note: "", at, criteria, proved: true },
    { itemId: "t1", by: "antigravity/gemini-4-argon", head, approve: true, note: "", at, criteria, proved: true, tier: true },
  ];
  assert.equal(gate(item, policy, evidence, reviews, "owner").ready, true);
  const record = { commit: head, reviews: reviews.map((r) => approvalBy(r.by, head)), at };
  assert.deepEqual(recordedMergeIndependence(record, item, { ...policy, noOverride: true }, evidence, reviews, "owner"), { refusal: null, override: null });
  // With one review needed, a tier approval is still never the independent one, at either.
  const one = { ...policy, riskReviews: undefined, noOverride: true };
  const tierOnly = [reviews[1]];
  assert.equal(gate(item, one, evidence, tierOnly, "owner").ready, false);
  const refused = recordedMergeIndependence({ ...record, reviews: [approvalBy(reviews[1].by, head)] }, item, one, evidence, tierOnly, "owner").refusal;
  assert.match(refused?.detail ?? "", /antigravity\/gemini-4-argon: a tier review, which is never the independent review/);
});

test("a developer-recorded review answering a request the reviewer claimed is proved, as at the gate", async () => {
  const { id, head, L } = await builtTask("strict");
  await L.submit(id, BUILDER, "done");
  const opus = { id: "opus-5.5", harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: "anthropic", note: "", addedBy: "owner", addedAt: new Date().toISOString() };
  await L.requestReview(id, "owner", OTHER, [opus]);
  const claim = await L.claimReview(id, OTHER, { runner: "home:a", kind: "home" }, true);
  // The verdict comes through the developer's token, answering the claimed request.
  await L.addReview({ itemId: id, by: OTHER, head, approve: true, criteria: criteriaOf(await L.item(id)), note: "Fine", at: new Date().toISOString(), request: claim.request }, undefined, false);
  const held = (await (await api("GET", `/projects/strict/items/${id}`)).json()).reviews.find((r) => r.by === OTHER);
  assert.deepEqual([held.proved, held.claimed], [false, true]);
  const r = await recordMerge("strict", id, { mergeCommit: mergeOutside(head), head, reviews: [approvalBy(OTHER, head)] });
  const body = await r.json();
  assert.equal(r.status, 200, body.detail);
  assert.equal(body.item.state, "merged");
  assert.equal(body.record.override, undefined);
});
