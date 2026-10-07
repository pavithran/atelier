import { test } from "node:test";
import assert from "node:assert/strict";
import type { SeenOffer } from "../src/dispatch/rules.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { paidPerToken, routeParts, SIZE_M_CONTEXT, type PartRoute, type RouteInput } from "../src/plans/route.ts";
import type { Plan, PlanPart } from "../src/plans/schema.ts";
import type { ProjectPolicy } from "../src/rules.ts";

const AT = "2026-10-04T12:00:00.000Z";
const entry = (id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, ...change,
});
const opus = entry("opus-5.5");
const sonnet = entry("sonnet-5.5");
const gpt = entry("gpt-6-astra", { harness: "codex" });
const glm = entry("glm-5.3", { harness: "zcode" });
const gemini = entry("gemini-3.1-pro", { harness: "opencode", provider: "google", keychain: "gemini.API_KEY" });
const studioGlm = entry("GLM-5.3-Flash-4_8bit", { harness: "opencode", where: "home", provider: "ai-studio" });
const coder = entry("Qwen3-Coder-Next-4bit:studio-code", { harness: "opencode", where: "home", provider: "ai-studio" });
const deepseek = entry("DeepSeek-V4-Flash", { harness: "opencode", where: "home", provider: "ai-studio" });
const refused = { state: "refused", at: AT, by: "cloud:runner", detail: "model not found" } as const;

const part = (key: string, change: Partial<PlanPart> = {}): PlanPart => ({
  key, title: key, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Implement the part", acceptance: ["Works"], tests: [], size: "S", ...change,
});
const plan = (...parts: PlanPart[]): Plan => ({ schema: "atelier.plan.v1", goal: "A feature", parts });
const policy: ProjectPolicy = { checks: [], protected: [] };
const input = (change: Partial<RouteInput> = {}): RouteInput => ({ pool: [], events: [], policy, allowPaid: false, ...change });
const event = (seq: number, actor: string, kind: string, data: Record<string, unknown> = {}, itemId: string | null = "t1"): LedgerEvent =>
  ({ seq, itemId, at: AT, actor, kind, data });
const one = (pool: ModelEntry[], change: Partial<RouteInput> = {}, p: PlanPart = part("a")): PartRoute => routeParts(plan(p), input({ pool, ...change }))[0];
const actors = (choices: { actor: string }[]) => choices.map((c) => c.actor);
const has = (choice: { reasons: string[] } | null, re: RegExp) => assert.match(choice!.reasons.join("\n"), re);

test("the reviewer is from another family than the builder, the first such in rank order", () => {
  // Equal scores order by model id, so gpt-6-astra builds and the next
  // non-openai model reviews; sonnet is not chosen over opus.
  const r = one([opus, sonnet, gpt]);
  assert.equal(r.unrouted, null);
  assert.equal(r.builder!.actor, "codex/gpt-6-astra");
  assert.deepEqual(actors(r.alternates), ["claude-code/opus-5.5", "claude-code/sonnet-5.5"]);
  assert.equal(r.reviewer!.actor, "claude-code/opus-5.5");
  has(r.reviewer, /Another family \(anthropic\) than the builder's \(openai\)/);
  has(r.builder, /Rank 1 of 3 eligible for feature work, score 1; equal scores spread across the plan's parts, then go by model id, then actor name/);
  // A one-part plan has nothing to spread over, so the tie still says who shared it.
  assert.equal(r.builder!.reasons[0], "Spread across the 3 models tied at score 1: builds 0 parts of this plan so far and its family openai 0 (claude-code/opus-5.5 0, claude-code/sonnet-5.5 0)");
  has(r.builder, /model-card from Task t14/);
  // A track record moves opus ahead; the reviewer then has to leave the anthropic family.
  const events = [event(1, "claude-code/opus-5.5", "item.claimed"), event(2, "atelier/sandbox", "evidence.observed", { passed: true })];
  const led = one([opus, sonnet, gpt], { events });
  assert.equal(led.builder!.actor, "claude-code/opus-5.5");
  assert.equal(led.reviewer!.actor, "codex/gpt-6-astra");
  assert.deepEqual(actors(led.alternates), ["codex/gpt-6-astra", "claude-code/sonnet-5.5"]);
  has(led.builder, /Atelier ledger for claude-code\/opus-5.5: 1 observed check passes/);
  assert.deepEqual(r.excluded, []);
});

test("refused and paid-per-token models are excluded; allowPaid and the spend cap admit them", () => {
  const pool = [{ ...opus, status: refused }, gemini, gpt];
  const r = one(pool);
  assert.equal(r.builder!.actor, "codex/gpt-6-astra");
  // gemini-3.1-pro is not in the registry, so it has no evidence and ranks below opus.
  assert.deepEqual(r.excluded.map((e) => [e.actor, e.reasons]), [
    ["claude-code/opus-5.5", ["status refused, reported by cloud:runner at 2026-10-04T12:00:00.000Z: model not found"]],
    ["opencode/gemini-3.1-pro", ["paid per token (google); the plan was not approved with allowPaid"]],
  ]);
  assert.equal(r.reviewer, null);
  assert.match(r.unrouted!, /^no reviewer of another family than openai \(codex\/gpt-6-astra\): claude-code\/opus-5.5 \(status refused/);
  assert.match(r.unrouted!, /opencode\/gemini-3.1-pro \(paid per token/);
  const paid = one(pool, { allowPaid: true });
  assert.equal(paid.reviewer!.actor, "opencode/gemini-3.1-pro");
  has(paid.reviewer, /Paid per token \(google\), allowed by allowPaid; no spend cap/);
  assert.deepEqual(actors(paid.excluded), ["claude-code/opus-5.5"]);
  const under = one(pool, { allowPaid: true, spend: { cap: 10, used: 3 } });
  has(under.reviewer, /allowed by allowPaid; spend 3 of cap 10/);
  const capped = one(pool, { allowPaid: true, spend: { cap: 10, used: 10 } });
  assert.equal(capped.reviewer, null);
  assert.deepEqual(capped.excluded.find((e) => e.actor === "opencode/gemini-3.1-pro"), { actor: "opencode/gemini-3.1-pro", reasons: ["paid per token (google); spend 10 has reached the cap 10"] });
  // A subscription and the Studio cost nothing per call; an OpenAI-compatible server is paid only in the cloud.
  assert.equal(paidPerToken(gpt), false);
  assert.equal(paidPerToken(studioGlm), false);
  assert.equal(paidPerToken({ provider: "openai-compatible", where: "home" }), false);
  assert.equal(paidPerToken({ provider: "openai-compatible", where: "cloud" }), true);
  for (const provider of ["anthropic", "openai", "deepseek", "openrouter", "google"] as const) assert.equal(paidPerToken({ provider, where: "cloud" }), true, provider);
  has(one([gpt, opus]).builder, /No per-token cost \(subscription\)/);
});

test("a profile suffix never makes a reviewer look like another family than the builder", () => {
  const r = one([coder, entry("Qwen3.8-27B-6bit:google-eval", { harness: "opencode", where: "home", provider: "ai-studio" })]);
  assert.equal(r.builder!.actor, "opencode/Qwen3-Coder-Next-4bit:studio-code");
  assert.equal(r.reviewer, null);
  assert.equal(r.unrouted, "no reviewer of another family than qwen (opencode/Qwen3-Coder-Next-4bit:studio-code): opencode/Qwen3.8-27B-6bit:google-eval (same family, qwen)");
});

test("a governed policy keeps executors as builders and assessors as reviewers", () => {
  const governed: ProjectPolicy = { ...policy, agents: {
    claude: { available: true, eligible_roles: ["executor"] },
    codex: { available: true, eligible_roles: ["assessor"] },
    glm: { available: true, eligible_roles: ["executor", "assessor"] },
  } };
  const r = one([opus, gpt, glm], { policy: governed });
  assert.equal(r.unrouted, null);
  assert.equal(r.builder!.actor, "zcode/glm-5.3");
  assert.deepEqual(actors(r.alternates), ["claude-code/opus-5.5"]);
  assert.deepEqual(r.excluded, [{ actor: "codex/gpt-6-astra", reasons: ["codex/gpt-6-astra needs an available agent with the executor role"] }]);
  has(r.builder, /Governed policy: holds the executor role/);
  // opus is of another family but not an assessor; gpt is.
  assert.equal(r.reviewer!.actor, "codex/gpt-6-astra");
  has(r.reviewer, /Governed policy: holds the assessor role/);
  const noAssessor = one([opus, gpt], { policy: { ...governed, agents: { ...governed.agents, codex: { available: true, eligible_roles: ["executor"] } } } });
  assert.equal(noAssessor.builder!.actor, "codex/gpt-6-astra");
  assert.equal(noAssessor.unrouted, "no reviewer of another family than openai (codex/gpt-6-astra): claude-code/opus-5.5 (claude-code/opus-5.5 needs an available agent with the assessor role)");
  // An unavailable agent holds no role.
  const paused = one([opus, gpt, glm], { policy: { ...governed, agents: { ...governed.agents, glm: { available: false, eligible_roles: ["executor", "assessor"] } } } });
  assert.equal(paused.builder!.actor, "claude-code/opus-5.5");
  assert.deepEqual(actors(paused.excluded), ["zcode/glm-5.3", "codex/gpt-6-astra"]);
  // Without agents, the project's eligible harnesses are the claim's rule, and any model may review.
  const legacy = one([opus, gpt], { policy: { ...policy, eligible: ["claude"] } });
  assert.equal(legacy.builder!.actor, "claude-code/opus-5.5");
  assert.deepEqual(legacy.excluded, [{ actor: "codex/gpt-6-astra", reasons: ["codex is not an eligible agent here (eligible: claude)"] }]);
  assert.equal(legacy.reviewer!.actor, "codex/gpt-6-astra");
  assert.ok(!legacy.builder!.reasons.some((reason) => reason.startsWith("Governed policy")));
});

test("a preference is honoured when the actor passes every rule, and refused with the reason otherwise", () => {
  const prefer = { actor: "claude-code/opus-5.5", reason: "knows the module" };
  const r = one([opus, gpt], {}, part("a", { prefer }));
  assert.equal(r.builder!.actor, "claude-code/opus-5.5");
  assert.equal(r.builder!.reasons[0], "Preferred by the plan (knows the module); passes every rule");
  assert.match(r.builder!.reasons[1], /^Rank 2 of 2 eligible/);
  assert.deepEqual(actors(r.alternates), ["codex/gpt-6-astra"]);
  assert.equal(r.reviewer!.actor, "codex/gpt-6-astra");
  // Refused by a rule: the top-ranked model builds and says what became of the preference.
  const refusedPick = one([{ ...opus, status: refused }, gpt], {}, part("a", { prefer }));
  assert.equal(refusedPick.builder!.actor, "codex/gpt-6-astra");
  assert.equal(refusedPick.builder!.reasons[0], "The plan preferred claude-code/opus-5.5 (knows the module); not chosen: status refused, reported by cloud:runner at 2026-10-04T12:00:00.000Z: model not found");
  const paidPick = one([gemini, gpt], {}, part("a", { prefer: { actor: "opencode/gemini-3.1-pro", reason: "long context" } }));
  assert.match(paidPick.builder!.reasons[0], /^The plan preferred opencode\/gemini-3.1-pro \(long context\); not chosen: paid per token/);
  // Not in the pool, by alias, and by a differently cased name.
  const missing = one([opus, gpt], {}, part("a", { prefer: { actor: "codex/gpt-7", reason: "newer" } }));
  assert.equal(missing.builder!.reasons[0], "The plan preferred codex/gpt-7 (newer); it is not in the pool");
  const alias = one([{ ...opus, aliases: ["claude-opus-5-5"] }, gpt], {}, part("a", { prefer: { actor: "Claude-Code/Claude-Opus-5-5", reason: "alias" } }));
  assert.equal(alias.builder!.actor, "claude-code/opus-5.5");
  assert.equal(alias.builder!.reasons[0], "Preferred by the plan (alias); passes every rule");
});

test("a size M part goes only to a model with a 64K context window or an unknown one", () => {
  assert.equal(SIZE_M_CONTEXT, 65536);
  const unknown = entry("mystery-9", { harness: "codex" });
  const pool = [coder, studioGlm, deepseek, opus, unknown];
  const m = one(pool, {}, part("a", { size: "M" }));
  assert.deepEqual(m.excluded, [{ actor: "opencode/Qwen3-Coder-Next-4bit:studio-code", reasons: ["context window 32768 tokens; a size M part needs 65536 or an unknown window"] }]);
  const reasons = Object.fromEntries([m.builder!, ...m.alternates].map((c) => [c.actor, c.reasons.join("\n")]));
  assert.match(reasons["opencode/GLM-5.3-Flash-4_8bit"], /Context window 65536 tokens, enough for size M/);
  assert.match(reasons["opencode/DeepSeek-V4-Flash"], /Context window unknown; size M allowed/);
  // The rule applies to the reviewer too: coder is the only qwen model, and it cannot review an M part.
  const qwenOnly = one([coder, opus], {}, part("a", { size: "M" }));
  assert.equal(qwenOnly.builder!.actor, "claude-code/opus-5.5");
  assert.match(qwenOnly.unrouted!, /no reviewer of another family than anthropic .*context window 32768 tokens/);
  // Size S has no window rule, and a model the registry does not know has an unknown window.
  const s = one(pool, {}, part("a", { size: "S" }));
  assert.deepEqual(s.excluded, []);
  assert.ok(!s.builder!.reasons.some((reason) => /Context window/.test(reason)));
  assert.equal(one([coder, gpt]).builder!.actor, "opencode/Qwen3-Coder-Next-4bit:studio-code");
  has(one([unknown, coder], {}, part("a", { size: "M" })).builder, /Context window unknown; size M allowed/);
});

test("a paused actor gets nothing and a reserved one only the kinds of work named for it", () => {
  const availability = { "claude-code": { state: "paused" }, "codex/gpt-6-astra": { state: "reserved", for: ["docs", "tests"] } } as const;
  const feature = one([opus, gpt, glm], { availability });
  assert.equal(feature.builder!.actor, "zcode/glm-5.3");
  assert.deepEqual(feature.excluded, [
    { actor: "codex/gpt-6-astra", reasons: ["reserved for docs, tests (availability of codex/gpt-6-astra); this part is feature work"] },
    { actor: "claude-code/opus-5.5", reasons: ["paused (availability of claude-code)"] },
  ]);
  assert.equal(feature.unrouted, "no reviewer of another family than zai (zcode/glm-5.3): codex/gpt-6-astra (reserved for docs, tests (availability of codex/gpt-6-astra); this part is feature work), claude-code/opus-5.5 (paused (availability of claude-code))");
  const docs = one([opus, gpt, glm], { availability }, part("a", { taskKind: "docs" }));
  assert.equal(docs.builder!.actor, "zcode/glm-5.3");
  assert.deepEqual(actors(docs.alternates), ["codex/gpt-6-astra"]);
  assert.equal(docs.reviewer!.actor, "codex/gpt-6-astra");
  has(docs.reviewer, /Reserved for docs, tests \(availability of codex\/gpt-6-astra\); this part is docs work/);
  has(docs.builder, /Availability not set; treated as available/);
  // An actor's entry wins over its harness's, whatever the case of the key; reserved for nothing is as paused.
  const own = one([opus, gpt], { availability: { codex: { state: "paused" }, "Codex/GPT-6-Astra": { state: "available" }, "claude-code/opus-5.5": { state: "reserved", for: [] } } });
  assert.equal(own.builder!.actor, "codex/gpt-6-astra");
  has(own.builder, /Available \(availability of Codex\/GPT-6-Astra\)/);
  assert.deepEqual(own.excluded, [{ actor: "claude-code/opus-5.5", reasons: ["reserved for nothing (availability of claude-code/opus-5.5); this part is feature work"] }]);
});

// A reviewer is routed only to a model a live runner offers for the review
// job (offering in src/dispatch/rules.ts), because the queue offers a
// review to such a runner alone: a model only a build runner offers would
// sit unclaimed however long the review waited (t197's part t210, the t250
// case of 2026-10-07). When no runner is live the pool stands and the
// reviewer's reasons say so with a warning; builders are not bound by the
// review job's offer.
test("a reviewer is routed only to a model a live runner offers for the review job", () => {
  // routing asks the offers as of now, so a live offer carries a fresh ask.
  const seen = (runner: string, over: Partial<SeenOffer> = {}): SeenOffer => ({ runner, kind: "home", agents: [], at: new Date().toISOString(), ...over });
  // A live build runner names opus but offers no review job: the review
  // would wait forever on it, so the part is unrouted and says why.
  const buildOnly = one([opus, gpt], { offers: [seen("home:mbp", { jobs: ["build", "plan"], agents: [{ agent: "claude-code", models: ["opus-5.5"] }] })] });
  assert.equal(buildOnly.builder!.actor, "codex/gpt-6-astra");
  assert.equal(buildOnly.reviewer, null);
  assert.equal(buildOnly.unrouted, "no reviewer of another family than openai (codex/gpt-6-astra): claude-code/opus-5.5 (no live runner offers claude-code/opus-5.5 for the review job: home:mbp offers no review job)");
  // A cloud runner offering the model is not a home review runner either.
  const cloud = one([opus, gpt], { offers: [seen("cloud:far", { kind: "cloud", jobs: ["build", "review"], agents: [{ agent: "claude-code", models: ["opus-5.5"] }] })] });
  assert.equal(cloud.reviewer, null);
  assert.match(cloud.unrouted!, /no live runner offers claude-code\/opus-5\.5 for the review job: cloud:far is a cloud runner, not a home one/);
  // A live runner offering review under another cross-family model routes
  // the reviewer to it alone, its reasons naming the runner, and the build
  // side is untouched by the review job's offer.
  const offered = one([opus, sonnet, gpt], { offers: [seen("home:studio", { jobs: ["build", "review"], agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }] })] });
  assert.equal(offered.builder!.actor, "codex/gpt-6-astra");
  assert.deepEqual(actors(offered.alternates), ["claude-code/opus-5.5", "claude-code/sonnet-5.5"]);
  assert.equal(offered.reviewer!.actor, "claude-code/sonnet-5.5");
  has(offered.reviewer, /Offered for the review job by home:studio/);
  assert.ok(!offered.reviewer!.reasons.some((reason) => reason.startsWith("No runner is live")));
  // Offers read but no runner live: the pool stands, with the warning that
  // the review waits for a runner that offers the reviewer.
  const noneLive = one([opus, gpt], { offers: [] });
  assert.equal(noneLive.unrouted, null);
  assert.equal(noneLive.reviewer!.actor, "claude-code/opus-5.5");
  has(noneLive.reviewer, /No runner is live; routed from the pool, and the review waits until a runner that offers claude-code\/opus-5\.5 for the review job asks for work/);
  // Offers not read at all: routing is as it was, with nothing said of runners.
  const unread = one([opus, gpt], { offers: null });
  assert.equal(unread.reviewer!.actor, "claude-code/opus-5.5");
  assert.ok(!unread.reviewer!.reasons.some((reason) => /runner/i.test(reason)));
});

test("a part no model can take is unrouted with the reason, never silently", () => {
  const empty = routeParts(plan(part("a"), part("b")), input());
  assert.deepEqual(empty, [
    { key: "a", builder: null, alternates: [], reviewer: null, excluded: [], unrouted: "no models in the pool" },
    { key: "b", builder: null, alternates: [], reviewer: null, excluded: [], unrouted: "no models in the pool" },
  ]);
  const allRefused = one([{ ...opus, status: refused }, gemini]);
  assert.equal(allRefused.builder, null);
  assert.equal(allRefused.unrouted, "no eligible builder: claude-code/opus-5.5 (status refused, reported by cloud:runner at 2026-10-04T12:00:00.000Z: model not found), opencode/gemini-3.1-pro (paid per token (google); the plan was not approved with allowPaid)");
  assert.equal(allRefused.excluded.length, 2);
  const oneFamily = one([opus, sonnet]);
  assert.equal(oneFamily.builder!.actor, "claude-code/opus-5.5");
  assert.deepEqual(actors(oneFamily.alternates), ["claude-code/sonnet-5.5"]);
  assert.equal(oneFamily.unrouted, "no reviewer of another family than anthropic (claude-code/opus-5.5): claude-code/sonnet-5.5 (same family, anthropic)");
  assert.equal(one([opus]).unrouted, "no reviewer of another family than anthropic (claude-code/opus-5.5): no other model in the pool");
  // The gate counts a cross-family review only between recognised families, so an unrecognised name cannot pair.
  const mystery = entry("mystery-1", { harness: "opencode", where: "home", provider: "ai-studio" });
  const led = [event(1, "opencode/mystery-1", "item.claimed"), event(2, "atelier/sandbox", "evidence.observed", { passed: true })];
  assert.equal(one([mystery, opus], { events: led }).unrouted, "no reviewer can be of another family than opencode/mystery-1, whose family is not recognised from its name");
  assert.equal(one([mystery, opus]).unrouted, "no reviewer of another family than anthropic (claude-code/opus-5.5): opencode/mystery-1 (family not recognised from its name)");
});

test("a plan's parts spread across the models tied at the top score, and across families, so one model is not the whole plan", () => {
  // Three models tied at score 1 (a model card each) and seven parts, as t197
  // had: in plan order each part goes to the tied model with the fewest parts
  // so far, then the fewest in its family, then the first by model id.
  const keys = ["a", "b", "c", "d", "e", "f", "g"];
  const routes = routeParts(plan(...keys.map((k) => part(k))), input({ pool: [opus, sonnet, gpt] }));
  assert.deepEqual(routes.map((r) => r.builder!.actor), [
    "codex/gpt-6-astra", "claude-code/opus-5.5", "claude-code/sonnet-5.5",
    "codex/gpt-6-astra", "claude-code/opus-5.5", "claude-code/sonnet-5.5", "codex/gpt-6-astra",
  ]);
  assert.deepEqual(routes.map((r) => r.unrouted), keys.map(() => null));
  // The builder's first reason says what the tie was and why this model took the part.
  assert.equal(routes[1].builder!.reasons[0], "Spread across the 3 models tied at score 1: builds 0 parts of this plan so far and its family anthropic 0 (codex/gpt-6-astra 1, claude-code/sonnet-5.5 0)");
  assert.equal(routes[3].builder!.reasons[0], "Spread across the 3 models tied at score 1: builds 1 part of this plan so far and its family openai 1 (claude-code/opus-5.5 1, claude-code/sonnet-5.5 1)");
  assert.match(routes[3].builder!.reasons[1], /^Rank 1 of 3 eligible for feature work, score 1; equal scores spread across the plan's parts, then go by model id, then actor name$/);
  // Alternates stay in rank order behind the builder, so the tick's fallback is unchanged.
  assert.deepEqual(actors(routes[1].alternates), ["codex/gpt-6-astra", "claude-code/sonnet-5.5"]);
  // Reviewers spread the same way among the tied models of another family than each builder.
  assert.deepEqual(routes.map((r) => r.reviewer!.actor), [
    "claude-code/opus-5.5", "codex/gpt-6-astra", "codex/gpt-6-astra",
    "claude-code/sonnet-5.5", "codex/gpt-6-astra", "codex/gpt-6-astra", "claude-code/opus-5.5",
  ]);
  assert.equal(routes[0].reviewer!.reasons[0], "Another family (anthropic) than the builder's (openai); spread across the 2 models tied at score 1: reviews 0 parts of this plan so far and its family anthropic 0 (claude-code/sonnet-5.5 0)");
  assert.equal(routes[1].reviewer!.reasons[0], "Another family (openai) than the builder's (anthropic); the first such model in rank order");
  assert.equal(routes[3].reviewer!.reasons[0], "Another family (anthropic) than the builder's (openai); spread across the 2 models tied at score 1: reviews 0 parts of this plan so far and its family anthropic 1 (claude-code/opus-5.5 1)");

  // A better score wins every part outright: spreading never overrides the ranking.
  const events = [event(1, "claude-code/opus-5.5", "item.claimed"), event(2, "atelier/sandbox", "evidence.observed", { passed: true })];
  const led = routeParts(plan(...keys.map((k) => part(k))), input({ pool: [opus, sonnet, gpt], events }));
  assert.deepEqual(led.map((r) => r.builder!.actor), keys.map(() => "claude-code/opus-5.5"));
  assert.deepEqual(led.map((r) => r.reviewer!.actor), keys.map(() => "codex/gpt-6-astra"));
  for (const r of led) assert.match(r.builder!.reasons[0], /^Rank 1 of 3 eligible/);

  // A preference still wins its part, and counts as that model's share of the plan.
  const prefer = { actor: "claude-code/opus-5.5", reason: "knows the module" };
  const preferred = routeParts(plan(part("a", { prefer }), part("b"), part("c")), input({ pool: [opus, sonnet, gpt] }));
  assert.deepEqual(preferred.map((r) => r.builder!.actor), ["claude-code/opus-5.5", "codex/gpt-6-astra", "claude-code/sonnet-5.5"]);
  assert.equal(preferred[0].builder!.reasons[0], "Preferred by the plan (knows the module); passes every rule");
  assert.equal(preferred[1].builder!.reasons[0], "Spread across the 3 models tied at score 1: builds 0 parts of this plan so far and its family openai 0 (claude-code/opus-5.5 1, claude-code/sonnet-5.5 0)");

  // The spread is the same whatever order the pool is given in.
  const again = routeParts(plan(...keys.map((k) => part(k))), input({ pool: [gpt, sonnet, opus] }));
  assert.deepEqual(again, routes);
});

test("routing is deterministic, breaks ties by model id then actor name, and leaves its inputs alone", () => {
  const shared = entry("shared-7", { harness: "opencode", where: "home", provider: "ai-studio" });
  const twin = { ...shared, harness: "zcode" as const };
  const pool = [twin, gpt, shared, opus];
  const events = [event(1, "claude-code/opus-5.5", "item.claimed"), event(2, "atelier/sandbox", "evidence.observed", { passed: true })];
  const availability = { codex: { state: "reserved", for: ["feature"] } } as const;
  const change = { availability, policy: { ...policy, eligible: ["claude", "codex", "opencode", "zcode"] } };
  const before = structuredClone({ pool, events, plan: plan(part("a"), part("b", { size: "M", taskKind: "docs" })) });
  const first = routeParts(before.plan, input({ pool, events, ...change }));
  const again = routeParts(before.plan, input({ pool: pool.toReversed(), events: events.toReversed(), ...change }));
  assert.deepEqual(first, again);
  assert.deepEqual({ pool, events, plan: before.plan }, before);
  assert.deepEqual(first.map((r) => r.key), ["a", "b"]);
  assert.equal(first[0].builder!.actor, "claude-code/opus-5.5");
  // Equal scores: gpt-6-astra before shared-7 by id, then opencode before zcode by actor.
  assert.deepEqual(actors(first[0].alternates), ["codex/gpt-6-astra", "opencode/shared-7"]);
  assert.equal(first[0].reviewer!.actor, "codex/gpt-6-astra");
  assert.deepEqual(actors(first[1].excluded), ["codex/gpt-6-astra"]);
  // The track record counts an entry's aliases, as the Models page does.
  const alias = one([{ ...gpt, aliases: ["gpt-6"] }, opus], { events: [event(1, "codex/gpt-6", "item.claimed"), event(2, "atelier/sandbox", "evidence.observed", { passed: true })] });
  assert.equal(alias.builder!.actor, "codex/gpt-6-astra");
  has(alias.builder, /score 101/);
});
