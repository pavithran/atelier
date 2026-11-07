// Atelier 2.0, G6 and G17, through the Ledger's production paths (the real
// Ledger under the Node runtime, called as the routes call it): a rejected
// post-merge review leaves a goal note and files no task; a blocking
// pre-review verdict fences the landing, and a verdict whose binding drifted
// fences nothing; no criteria review or plan review is asked by itself, and no
// tier review exists (t518); a dispatch that names a harness alone is refused.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import "../src/runtime/loader.mjs";
import { Namespace } from "../src/runtime/namespace.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const iso = (ms) => new Date(ms).toISOString();
const GPT = "codex/gpt-6-astra", OPUS = "claude-code/opus-5.5", ARGON = "antigravity/gemini-4-argon";
const RUNNER = { runner: "home:a", kind: "home" };
const MAIN = "c".repeat(40), H0 = "0".repeat(40), TREE = "e".repeat(40);
const head = (n) => n.toString(16).padStart(40, "a");
const model = (id, harness, family) => ({ id, harness, where: "home", provider: "subscription", aliases: [], family, note: "", addedBy: "owner", addedAt: iso(Date.now()) });
const POOL = [model("gpt-6-astra", "codex", "openai"), model("opus-5.5", "claude-code", "anthropic"), model("gemini-4-argon", "antigravity", "google")];

async function world(name, policy = {}) {
  const { Ledger } = await import("../src/index.ts");
  const env = {};
  const d = mkdtempSync(join(tmpdir(), "atelier-production-paths-"));
  dirs.push(d);
  const ns = new Namespace({ dir: join(d, "data"), Class: Ledger, env });
  env.LEDGER = ns;
  const L = ns.get(ns.idFromName(`project:${name}`));
  const index = ns.get(ns.idFromName("__index"));
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], ...policy }, createdAt: iso(Date.now()) };
  await L.setProject(record, "owner");
  await index.registerProject(record);
  for (const m of POOL) await index.putModel(m);
  await index.putRunnerOffer({ runner: RUNNER.runner, kind: "home", jobs: ["build", "review", "prereview"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "claude-code", models: ["opus-5.5"] }, { agent: "antigravity", models: ["gemini-4-argon"] }] }, iso(Date.now()));
  // A task built by Opus and submitted at head h, its checks passed.
  const submitted = async (h, paths = ["src/a.ts"], title = `Task ${h.slice(-2)}`) => {
    const id = (await L.newItem(title, ["src/**"], "owner", { accept: ["It works"] })).id;
    await L.dispatch(id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
    await L.claim(id, OPUS, RUNNER);
    await L.setWorkspace(id, `fork-${id}`, H0, OPUS);
    await L.recordPush(id, OPUS, h, h);
    await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: h, passed: true, by: OPUS, at: iso(Date.now()), changedPaths: paths });
    await L.submit(id, OPUS);
    return id;
  };
  return { ns, L, index, submitted, offers: () => index.runnerOffers() };
}
const kinds = async (L, id, kind) => (await L.events(id, 1000)).filter((e) => e.kind === kind);

test("a real rejected post-merge review of a fast landing leaves blocking goal notes and files no task; file-fix files one, once", async () => {
  const { ns, L, submitted, offers } = await world("postmerge");
  try {
    await L.setMode("owner", "fast", "product work", OPUS, "go fast");
    const id = await submitted(head(1));
    await L.confirmOverride(id, "owner", head(1), "access");
    await L.accept(id, "owner", head(1), "Exercise the post-merge audit without a pre-merge approval");
    const merge = "d".repeat(40);
    await L.merged(id, "owner", merge, true);
    assert.equal((await L.item(id)).state, "merged");
    assert.deepEqual(await kinds(L, id, "review.requested"), [], "no standing post-merge-reviewer: nothing is asked by itself");
    // The model asks the post-merge review; the reviewer claims it and rejects it.
    const asked = await L.requestReview(id, "owner", GPT, POOL, true, false, undefined, await offers());
    assert.equal(asked.requested, true);
    const claim = await L.claimReview(id, GPT, RUNNER, true);
    const items = (await L.items()).length;
    const finding = { file: "src/a.ts", line: 4, severity: "blocking", text: "null deref on an empty list" };
    await L.addReview({ itemId: id, by: GPT, head: claim.head, criteria: claim.criteria, request: claim.request, approve: false, note: "It breaks.", at: iso(Date.now()), findings: [finding] }, undefined, true, "api");
    assert.equal((await L.items()).length, items, "no task filed by the server");
    assert.deepEqual(await kinds(L, id, "item.fix_filed"), []);
    const notes = await L.goalNotes(id);
    assert.deepEqual(notes.map((n) => [n.file, n.line, n.text, n.blocking, n.fast, n.request]), [["src/a.ts", 4, "null deref on an empty list", true, true, claim.request]]);
    // file-fix files one task, and the same note again files nothing more.
    const filed = await L.fileFix(id, "owner", 1, OPUS);
    assert.equal(filed.already, false);
    assert.deepEqual(filed.item.accept, ["Resolve src/a.ts:4: null deref on an empty list"]);
    const again = await L.fileFix(id, "owner", 1, OPUS);
    assert.deepEqual([again.already, again.item.id], [true, filed.item.id]);
    assert.equal((await L.items()).length, items + 1);
    assert.deepEqual((await kinds(L, id, "item.fix_filed")).map((e) => e.data.foundIn), [filed.item.id], "fast status links the fix the model filed");
  } finally { await ns.close(); }
});

test("a real blocking pre-review verdict fences the landing; a verdict whose binding drifted fences nothing", async () => {
  const { ns, L, submitted, offers } = await world("prereview");
  try {
    const t1 = await submitted(head(1)), t2 = await submitted(head(2));
    await L.beginProjectLanding(t1, "owner");
    await L.queueProjectLanding(t2, "owner");
    assert.deepEqual(await kinds(L, t2, "prereview.requested"), [], "the queue asks no pre-review by itself");
    const asked = await L.requestPrereview(t2, "owner", GPT, POOL, await offers());
    const claim = await L.claimReview(t2, GPT, RUNNER, true, MAIN);
    assert.equal(claim.request, asked.request);
    const envelope = (findings) => ({ prereview: { main: MAIN, tree: TREE }, findings });
    await L.addReview({ itemId: t2, by: GPT, head: claim.head, criteria: claim.criteria, request: claim.request, approve: false, note: "It breaks.", at: iso(Date.now()), findings: envelope([{ file: "src/a.ts", line: 1, severity: "blocking", text: "breaks the parser" }]), mainNow: MAIN }, undefined, true, "api");
    const fence = (await L.detail(t2)).prereviewFence;
    assert.ok(fence, "the blocking verdict fenced the landing");
    await assert.rejects(L.queueProjectLanding(t2, "owner"), /fenc|pre-review/i, "a fenced landing takes no place in the queue");
    await assert.rejects(L.requestPrereview(t2, "owner", GPT, POOL, await offers()), /prereview_fenced/);
    // Binding drift: the fence lifted, a new pre-review asked and claimed,
    // then the criteria change before the verdict: the verdict is stale and
    // fences nothing.
    await L.unblock(t2, "owner", true, { quote: "try again", acting: OPUS });
    await L.queueProjectLanding(t2, "owner");
    const second = await L.requestPrereview(t2, "owner", GPT, POOL, await offers());
    const claim2 = await L.claimReview(t2, GPT, RUNNER, true, MAIN);
    assert.equal(claim2.request, second.request);
    await L.editItem(t2, "owner", { accept: ["It works", "And it is fast"] });
    await L.addReview({ itemId: t2, by: GPT, head: claim2.head, criteria: claim2.criteria, request: claim2.request, approve: false, note: "It breaks.", at: iso(Date.now()), findings: envelope([{ file: "src/a.ts", line: 1, severity: "blocking", text: "breaks the parser" }]), mainNow: MAIN }, undefined, true, "api");
    assert.equal((await L.detail(t2)).prereviewFence ?? null, null, "a drifted binding fences nothing");
    const latest = (await L.detail(t2)).prereviews[0];
    assert.equal(latest.state, "stale");
    assert.match(latest.detail, /criteria changed/);
  } finally { await ns.close(); }
});

test("no tier review exists: an old policy's reviewTier inserts no tier request and records no tier_needed", async () => {
  const { ns, L, submitted, offers } = await world("tier", { protected: ["src/**"], reviewTier: [ARGON], exactNames: ["reviewTier"] });
  try {
    const id = await submitted(head(1));
    const gate = await L.requestReview(id, "owner", GPT, POOL, false, false, undefined, await offers());
    assert.equal(gate.requested, true);
    assert.deepEqual((await L.reviewRequests(id)).filter((r) => r.tier), [], "no tier request was inserted");
    assert.deepEqual(await kinds(L, id, "review.tier_needed"), []);
    assert.equal((await L.detail(id)).tierReview, undefined);
  } finally { await ns.close(); }
});

test("a criteria review naming no reviewer refuses with the candidates; a dispatch naming a harness alone is refused", async () => {
  const { ns, L } = await world("criteria");
  try {
    const id = (await L.newItem("Has criteria", ["src/**"], "owner", { accept: ["It works"] })).id;
    await assert.rejects(L.requestCriteriaReview(id, "owner", null, POOL), (e) => {
      assert.match(e.message, /reviewer_needed/);
      assert.match(e.message, /criteria review names no reviewer, and Atelier picks none/);
      assert.match(e.message, /codex\/gpt-6-astra/);
      return true;
    });
    assert.deepEqual((await L.criteriaReviewsFor(id)), [], "nothing was asked");
    await assert.rejects(L.dispatch(id, "owner", { to: "home", agent: "codex" }), /builder_needed\|.*names the agent codex but no model/);
    await assert.rejects(L.dispatch(id, "owner", { to: "home" }), /builder_needed\|.*no agent and no model/);
    assert.equal((await L.item(id)).dispatch ?? null, null);
  } finally { await ns.close(); }
});

test("a plan names its planner and every part's route; the plan tick asks only a named reviewer, and records the need when none is usable", async () => {
  const { ns, L, offers } = await world("plan");
  try {
    await assert.rejects(L.newPlan("Ship the feature", ["src/**"], "owner", null, POOL), (e) => { assert.match(e.message, /planner_needed\|The plan names no planner, and Atelier picks none\./); return true; });
    const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", OPUS, POOL);
    await L.claim(item.id, OPUS, RUNNER);
    await L.setWorkspace(item.id, `fork-${item.id}`, H0, OPUS);
    const part = (key) => ({ key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" });
    const post = await L.postPlan(item.id, OPUS, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [part("a")] });
    assert.ok(post.valid, JSON.stringify(post.errors));
    await L.release(item.id, OPUS, "proposed");
    // No routes named: refused with the routing's candidates; nothing approved.
    await assert.rejects(L.approvePlan(item.id, "owner", post.hash, false, POOL, await offers()), (e) => {
      assert.match(e.message, /routes_needed\|.*names no routes, and Atelier picks none\. The routing's candidates:\n {2}part a: builders /);
      return true;
    });
    assert.equal((await L.planParts(item.id)).length, 0);
    // A reviewer of the builder's own family is refused at approval.
    await assert.rejects(L.approvePlan(item.id, "owner", post.hash, false, POOL, await offers(), { a: { builder: GPT, reviewer: GPT } }), /not_independent/);
    const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL, await offers(), { a: { builder: GPT, reviewer: OPUS } });
    const pid = parts[0].id;
    assert.deepEqual([(await L.item(pid)).dispatch.agent, (await L.item(pid)).dispatch.model], ["codex", "gpt-6-astra"], "the part goes to the builder named");
    // The named reviewer, Opus, has since become a contributor (it claims the
    // part by handoff here): the tick asks nobody else in its place.
    await L.claim(pid, GPT, RUNNER);
    await L.setWorkspace(pid, `fork-${pid}`, H0, GPT);
    await L.recordPush(pid, GPT, head(5), head(5));
    await L.addEvidence({ itemId: pid, claim: "npm test", grade: "observed", head: head(5), passed: true, by: GPT, at: iso(Date.now()), changedPaths: ["src/a/x.ts"] });
    await L.handoff(pid, GPT, OPUS, "take it");
    await L.submit(pid, OPUS);
    const asked = (await L.events(pid, 1000)).filter((e) => e.kind === "review.requested");
    assert.deepEqual(asked, [], "no reviewer was picked in the named one's place");
    const needed = (await L.events(pid, 1000)).filter((e) => e.kind === "plan.review_needed");
    assert.equal(needed.length, 1);
    assert.ok(needed[0].data.candidates.some((c) => c.actor === ARGON && c.refusal === null), JSON.stringify(needed[0].data.candidates));
    assert.ok(needed[0].data.candidates.some((c) => c.actor === OPUS && /contribut|famil/.test(c.refusal ?? "")));
    assert.match(needed[0].data.next, /atelier plan reroute t\d+ --to H\/M/);
    // The model names one; the tick asks it.
    await L.reroutePlan(pid, "owner", ARGON);
    assert.deepEqual((await L.events(pid, 1000)).filter((e) => e.kind === "review.requested").map((e) => e.data.reviewer), [ARGON]);
  } finally { await ns.close(); }
});

test("a lapsed review claim is a fact: polling the queue asks no successor, and review-request reopens it", async () => {
  const { ns, L, submitted, offers } = await world("lapse");
  try {
    const id = await submitted(head(1));
    const asked = await L.requestReview(id, "owner", GPT, POOL, true, false, undefined, await offers());
    const claim = await L.claimReview(id, GPT, RUNNER, true);
    assert.equal(claim.request, asked.request);
    // The lease runs out: the claim was last renewed ten minutes ago.
    ns.object("project:lapse").live.sql.exec(`UPDATE review_requests SET claimedAt = ? WHERE id = ?`, iso(Date.now() - 10 * 60_000), claim.request);
    for (let i = 0; i < 3; i++) { await L.queued(); await L.reviewWaiting(); }
    const rows = await L.reviewRequests(id);
    assert.deepEqual(rows.map((r) => r.state), ["lapsed"], "nothing was withdrawn and no successor asked");
    const expired = (await L.events(id, 1000)).filter((e) => e.kind === "review.expired");
    assert.equal(expired.length, 1);
    assert.equal(expired[0].data.claimedBy, GPT);
    assert.match(expired[0].data.next, new RegExp(`atelier review-request ${id} --reviewer ${GPT}`));
    const lapsed = (await L.detail(id)).lapsedRequests;
    assert.deepEqual(lapsed.map((r) => [r.request, r.claimedBy]), [[claim.request, GPT]]);
    // A late verdict from the lapsed claim answers nothing.
    await assert.rejects(L.renewReview(id, GPT, claim.request), /stale_request/);
    // The model reopens it by command.
    const again = await L.requestReview(id, "owner", GPT, POOL, true, false, undefined, await offers());
    assert.equal(again.requested, true);
    assert.notEqual(again.request, claim.request);
    assert.deepEqual((await L.reviewRequests(id)).map((r) => r.state), ["lapsed", "open"]);
  } finally { await ns.close(); }
});

test("a released request and one answered with no readable verdict stay on record; nothing reopens them, and review-request does", async () => {
  const { ns, L, submitted, offers } = await world("ended");
  try {
    for (const [n, end] of [[1, "released"], [2, "no_verdict"]]) {
      const id = await submitted(head(n));
      await L.requestReview(id, "owner", GPT, POOL, true, false, undefined, await offers());
      const claim = await L.claimReview(id, GPT, RUNNER, true);
      if (end === "released") await L.releaseReview(id, GPT, "harness exited 2", true, claim.request);
      else assert.deepEqual(await L.unparsableReview(id, GPT, claim.head, "the reply had no VERDICT line", "Some text and no verdict.", true, claim.request), { released: true });
      for (let i = 0; i < 3; i++) await L.queued();
      assert.deepEqual((await L.reviewRequests(id)).map((r) => r.state), [end], `${end}: no successor request appears by itself`);
      const ended = (await L.detail(id)).lapsedRequests;
      assert.deepEqual(ended.map((r) => [r.request, r.state, r.claimedBy]), [[claim.request, end, GPT]]);
      if (end === "released") assert.equal(ended[0].note, "harness exited 2");
      else assert.equal((await L.detail(id)).unparsable.length, 1, "the unparsable reply is kept");
      const again = await L.requestReview(id, "owner", GPT, POOL, true, false, undefined, await offers());
      assert.equal(again.requested, true);
      assert.deepEqual((await L.reviewRequests(id)).map((r) => r.state), [end, "open"], `${end}: the command reopens it`);
    }
  } finally { await ns.close(); }
});

test("a plan part's routed review that lapses, is released or gets no verdict is not asked again at that head by itself; the command reopens it, and a new head asks again", async () => {
  const { ns, L, offers } = await world("planended");
  try {
    const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", OPUS, POOL);
    await L.claim(item.id, OPUS, RUNNER);
    await L.setWorkspace(item.id, `fork-${item.id}`, H0, OPUS);
    const post = await L.postPlan(item.id, OPUS, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [{ key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" }] });
    await L.release(item.id, OPUS, "proposed");
    const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL, await offers(), { a: { builder: GPT, reviewer: ARGON } });
    const pid = parts[0].id;
    await L.claim(pid, GPT, RUNNER);
    await L.setWorkspace(pid, `fork-${pid}`, H0, GPT);
    await L.recordPush(pid, GPT, head(5), head(5));
    await L.addEvidence({ itemId: pid, claim: "npm test", grade: "observed", head: head(5), passed: true, by: GPT, at: iso(Date.now()), changedPaths: ["src/a/x.ts"] });
    await L.submit(pid, GPT);
    const states = async () => (await L.reviewRequests(pid)).filter((r) => !r.tier).map((r) => `${r.head.slice(-1)}:${r.state}`);
    assert.deepEqual(await states(), ["5:open"], "the route's named reviewer is asked");
    const end = {
      lapsed: async (c) => { ns.object("project:planended").live.sql.exec(`UPDATE review_requests SET claimedAt = ? WHERE id = ?`, iso(Date.now() - 10 * 60_000), c.request); },
      released: async (c) => { await L.releaseReview(pid, ARGON, "harness exited 2", true, c.request); },
      no_verdict: async (c) => { await L.unparsableReview(pid, ARGON, c.head, "no VERDICT line", "Text without a verdict.", true, c.request); },
    };
    const seen = ["5:open"];
    for (const outcome of ["lapsed", "released", "no_verdict"]) {
      const claim = await L.claimReview(pid, ARGON, RUNNER, true);
      await end[outcome](claim);
      // The alarm runs the expiry and the plan's tick; queue reads too.
      for (let i = 0; i < 2; i++) { await L.alarm(); await L.queued(); }
      seen[seen.length - 1] = `5:${outcome}`;
      assert.deepEqual(await states(), seen, `${outcome}: no successor at this head by itself`);
      // The model asks again by command.
      const again = await L.requestReview(pid, "owner", ARGON, POOL, true, false, undefined, await offers());
      assert.equal(again.requested, true, `${outcome}: ${again.reason}`);
      seen.push("5:open");
      assert.deepEqual(await states(), seen, `${outcome}: the command reopens it`);
    }
    // A new head is a new review: the route asks again by itself.
    const claim = await L.claimReview(pid, ARGON, RUNNER, true);
    await L.releaseReview(pid, ARGON, "harness exited 2", true, claim.request);
    await L.recordPush(pid, GPT, head(6), head(6));
    await L.addEvidence({ itemId: pid, claim: "npm test", grade: "observed", head: head(6), passed: true, by: GPT, at: iso(Date.now()), changedPaths: ["src/a/x.ts"] });
    await L.alarm();
    const latest = (await L.reviewRequests(pid)).filter((r) => !r.tier).at(-1);
    assert.deepEqual([latest.head, latest.state, latest.reviewer], [head(6), "open", ARGON]);
  } finally { await ns.close(); }
});
