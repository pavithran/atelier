import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { criteriaOf } from "../src/criteria.ts";
import { assign, type SeenOffer } from "../src/dispatch/rules.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { hasRole, independentApproval, parseRuleError, type Gate, type Review, type ProjectPolicy } from "../src/rules.ts";

const BUILDER = "codex/gpt-6-astra", REVIEWER = "opencode/Qwen3-Coder-Next", ALIAS = "opencode/studio-review";
const HEAD = "a".repeat(40), BASE = "0".repeat(40);
const TOKEN = "reviewer-admission-tests";
const entry = (id = "Qwen3-Coder-Next", aliases = ["studio-review"]): ModelEntry => ({
  id, aliases, harness: "opencode", where: "home", endpoint: "http://ai-server:8000/v1", provider: "ai-studio",
  family: familyOf(id), note: "", addedBy: "owner", addedAt: new Date().toISOString(),
});
const POOL = [entry()];
const offers = (): SeenOffer[] => [{ runner: "home:ai", kind: "home", agents: [{ agent: "opencode", models: [POOL[0].id] }], jobs: ["review"], at: new Date().toISOString() }];
const runner = { runner: "home:ai", kind: "home" } as const;
const policy: ProjectPolicy = {
  checks: ["npm test"], protected: ["src/**"], agents: {
    codex: { available: true, eligible_roles: ["executor", "assessor"] },
    claude: { available: true, eligible_roles: ["executor", "assessor"] },
  },
};
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
async function setup(name: string, builder = BUILDER) {
  const L = ledger(name);
  const record = { name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await index().registerProject(record);
  await index().putModel(POOL[0]);
  await L.newItem("Review external model", ["src/**"], "owner", { accept: ["Works"] });
  await L.claim("t1", builder);
  await L.setFork("t1", `${name}--t1`, BASE, builder);
  await L.recordPush("t1", builder, HEAD, HEAD);
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", passed: true, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
  await L.submit("t1", builder);
  return L;
}
type L = ReturnType<typeof ledger>;
async function review(L: L, by = REVIEWER): Promise<Review> {
  return { itemId: "t1", by, head: HEAD, criteria: criteriaOf(await L.item("t1")), approve: true, note: "Reviewed full diff", at: new Date().toISOString() };
}
async function detail(L: L) { return await L.detail("t1") as unknown as { gate: Gate; reviews: Review[] }; }
async function refusal(p: Promise<unknown>, code: string) {
  const error = await p.then(() => null, (e: unknown) => parseRuleError(e));
  expect(error?.code).toBe(code);
}
const admit = (L: L) => L.admitReviewer("studio-review", true, "Qualified on the full diff", "owner", POOL);
const withdraw = (L: L) => L.admitReviewer(POOL[0].id, false, "Retiring this reviewer", "owner", POOL);
function call(name: string, method: string, id: string, actor = "owner", reason = "Qualified") {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/reviewers/${id}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: JSON.stringify({ reason }),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
}

it("owner-only admission, withdrawal and readmission record canonical identity, aliases, actor, reason and time per project", async () => {
  const L = await setup("admission-owner"), other = await setup("admission-other");
  expect((await call("admission-owner", "PUT", "studio-review", BUILDER)).status).toBe(403);
  expect((await call("admission-owner", "PUT", "studio-review", "owner", "")).status).toBe(400);
  const response = await call("admission-owner", "PUT", "studio-review");
  expect(response.status).toBe(200);
  const admitted = await response.json();
  expect(admitted).toMatchObject({ id: POOL[0].id, aliases: ["studio-review"], active: true, by: "owner", reason: "Qualified", at: expect.stringMatching(/^\d{4}-/) });
  expect(hasRole(ALIAS, (await L.project()).policy, "assessor")).toBe(true);
  expect(hasRole(ALIAS, (await other.project()).policy, "assessor")).toBe(false);
  expect((await call("admission-owner", "DELETE", "studio-review", BUILDER)).status).toBe(403);
  expect((await call("admission-owner", "DELETE", "studio-review")).status).toBe(200);
  expect(hasRole(REVIEWER, (await L.project()).policy, "assessor")).toBe(false);
  await admit(L);
  expect((await L.reviewerAdmissions()).length).toBe(1);
  const audit = (await L.events() as unknown as LedgerEvent[]).filter((e) => e.kind.startsWith("reviewer."));
  expect(audit.map((e) => e.kind).sort()).toEqual(["reviewer.admitted", "reviewer.admitted", "reviewer.withdrawn"]);
  expect(audit.every((e) => e.actor === "owner" && e.at && e.data.reason)).toBe(true);
  expect(await other.reviewerAdmissions()).toEqual([]);
});

it("unknown family, unregistered models, ambiguous aliases and non-owner ledger calls are refused", async () => {
  const L = await setup("admission-invalid");
  await refusal(L.admitReviewer("Qwen3-Coder-Next", true, "test", BUILDER, POOL), "not_project_owner");
  await refusal(L.admitReviewer("mystery", true, "test", "owner", [entry("mystery", [])]), "unknown_family");
  await refusal(L.admitReviewer("unknown", true, "test", "owner", POOL), "no_model");
  await refusal(L.admitReviewer(POOL[0].id, true, "test", "owner", [entry(POOL[0].id, ["gpt-6-astra"])]), "ambiguous_model");
  const error = await L.requestReview("t1", "owner", "opencode/unknown", POOL).catch((e: unknown) => parseRuleError(e));
  expect(error).toMatchObject({ code: "ineligible", detail: expect.stringContaining("atelier models admit") });
  // A permitted harness cannot bypass registration by inventing a model.
  await refusal(L.requestReview("t1", "owner", "codex/unregistered", POOL), "ineligible");
});

it("a proved alias approval counts, is not retroactive, and keeps its recorded admission after withdrawal", async () => {
  const L = await setup("admission-binding");
  await L.addReview(await review(L), undefined, true);
  expect((await detail(L)).gate.ready).toBe(false);
  const admission = await admit(L);
  expect((await detail(L)).gate.ready).toBe(false);
  await L.addReview(await review(L, ALIAS), undefined, true);
  expect((await detail(L)).gate.ready).toBe(true);
  const saved = (await detail(L)).reviews.at(-1)!;
  expect(saved).toMatchObject({ by: REVIEWER, proved: true, recordedBy: ALIAS, reviewerAdmission: admission });
  await withdraw(L);
  expect((await detail(L)).gate.ready).toBe(true);
  expect((await detail(L)).reviews.at(-1)).toEqual(saved);
  await refusal(L.addReview(await review(L), undefined, true), "reviewer_withdrawn");
  await admit(L);
  await L.addReview(await review(L), undefined, true);
  expect((await detail(L)).gate.ready).toBe(true);
});

it("admission preserves provenance, head and criteria binding and refuses same-family contributors", async () => {
  const L = await setup("admission-strict");
  await admit(L);
  await L.addReview(await review(L), undefined, false);
  expect((await detail(L)).gate.ready).toBe(false);
  await refusal(L.addReview({ ...await review(L), head: BASE }, undefined, true), "stale_head");
  await refusal(L.addReview({ ...await review(L), criteria: "stale" }, undefined, true), "stale_criteria");
  const gpt = entry("gpt-6-reviewer", ["outside"]);
  await L.admitReviewer(gpt.id, true, "test", "owner", [gpt]);
  await refusal(L.addReview(await review(L, "opencode/outside"), undefined, true), "not_independent");
  await refusal(L.requestReview("t1", "owner", "opencode/outside", [gpt]), "not_independent");
  // An unknown-family contributor cannot be proved independent either.
  const unknown = await setup("admission-unknown-contributor", "codex/mystery");
  await admit(unknown);
  await refusal(unknown.addReview(await review(unknown), undefined, true), "not_independent");
});

it("named aliases dispatch the canonical registered model only to a live runner offering its harness and review job", async () => {
  const L = await setup("admission-routing");
  await admit(L);
  for (const unavailable of [[], [{ ...offers()[0], kind: "cloud" as const }], [{ ...offers()[0], jobs: ["build"] }], [{ ...offers()[0], agents: [{ agent: "codex", models: [POOL[0].id] }] }], [{ ...offers()[0], at: "2000-01-01T00:00:00Z" }]]) {
    const error = await L.requestReview("t1", "owner", ALIAS, POOL, false, false, undefined, unavailable).catch((e: unknown) => parseRuleError(e));
    expect(error).toMatchObject({ code: "no_runner", detail: expect.stringContaining(POOL[0].id) });
  }
  const asked = await L.requestReview("t1", "owner", ALIAS, POOL, false, false, undefined, offers());
  expect(asked).toMatchObject({ requested: true, reviewer: REVIEWER });
  const [queued] = await L.reviewWaiting();
  expect(queued.dispatch).toMatchObject({ to: "home", agent: "opencode", model: POOL[0].id, job: "review" });
  expect(assign(queued.dispatch!, offers()[0])?.actor).toBe(REVIEWER);
  const claim = await L.claimReview("t1", REVIEWER, runner) as unknown as ReviewClaim;
  await L.addReview({ ...await review(L), request: claim.request }, undefined, false);
  expect((await detail(L)).gate.ready).toBe(true);
});

it("withdrawal cancels an outstanding claim and readmission never revives its verdict", async () => {
  const L = await setup("admission-withdraw-claim");
  await admit(L);
  await L.requestReview("t1", "owner", REVIEWER, POOL, false, false, undefined, offers());
  const claim = await L.claimReview("t1", REVIEWER, runner) as unknown as ReviewClaim;
  await withdraw(L);
  expect((await L.reviewRequests("t1")).at(-1)?.state).toBe("withdrawn");
  await refusal(L.addReview({ ...await review(L), request: claim.request }, undefined, true), "reviewer_withdrawn");
  await admit(L);
  await refusal(L.addReview({ ...await review(L), request: claim.request }, undefined, true), "stale_request");
  expect((await detail(L)).gate.ready).toBe(false);
  const fresh = await L.requestReview("t1", "owner", REVIEWER, POOL, false, false, undefined, offers());
  expect(fresh.request).not.toBe(claim.request);
});


it("an admitted model's own actor token records a proved, counting approval through the review API", async () => {
  const name = "admission-actor-token", L = await setup(name);
  await admit(L);
  const api = (method: string, path: string, body: unknown, token = TOKEN, actor = "owner") => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: { get: async () => ({ log: async () => [{ hash: HEAD }], [Symbol.dispose]() {} }) } as unknown as Artifacts } as typeof env);
  const issued = await api("POST", "/tokens", { actor: ALIAS, projects: [name], label: "Outside reviewer" });
  expect(issued.status).toBe(201);
  const { token } = await issued.json() as { token: string };
  expect((await api("PUT", `/projects/${name}/reviewers/studio-review`, { reason: "Self-admit" }, token, ALIAS)).status).toBe(403);
  const response = await api("POST", `/projects/${name}/items/t1/review`, await review(L, ALIAS), token, ALIAS);
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await detail(L)).reviews.at(-1)).toMatchObject({ by: REVIEWER, proved: true, recordedBy: ALIAS, reviewerAdmission: { active: true } });
  expect((await detail(L)).gate.ready).toBe(true);
});

it("withdrawn admissions preserve only the original approval binding, never a later head or revised criteria", async () => {
  for (const change of ["head", "criteria"]) {
    const L = await setup(`admission-stale-${change}`);
    await admit(L);
    await L.addReview(await review(L), undefined, true);
    await withdraw(L);
    expect((await detail(L)).gate.ready).toBe(true);
    if (change === "criteria") {
      await L.editItem("t1", "owner", { accept: ["Works", "Reports errors"] });
    } else {
      const head = "b".repeat(40);
      await L.recordPush("t1", BUILDER, head, head);
      await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", passed: true, head, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
    }
    expect((await detail(L)).gate.ready).toBe(false);
  }
});

it("aliases cannot be reassigned across project admissions and alias claims can be released", async () => {
  const L = await setup("admission-alias-claims");
  await admit(L);
  await refusal(L.admitReviewer("DeepSeek-V4", true, "Another model", "owner", [entry("DeepSeek-V4")]), "ambiguous_model");
  await L.requestReview("t1", "owner", ALIAS, POOL, false, false, undefined, offers());
  await L.claimReview("t1", ALIAS, runner);
  await L.releaseReview("t1", ALIAS, "Retry later");
  expect((await L.reviewRequests("t1")).at(-1)?.state).toBe("open");
  await withdraw(L);
  expect((await L.reviewRequests("t1")).at(-1)?.state).toBe("withdrawn");
  await refusal(L.claimReview("t1", ALIAS, runner), "reviewer_withdrawn");
});

it("admitted aliases renew and release only their current claim generation", async () => {
  const L = await setup("admission-lease-generation");
  await admit(L);
  await L.requestReview("t1", "owner", ALIAS, POOL, false, false, undefined, offers());
  const first = await L.claimReview("t1", ALIAS, runner) as unknown as ReviewClaim;
  await L.renewReview("t1", ALIAS, first.request);
  await L.releaseReview("t1", ALIAS, "Restart", true, first.request);
  const next = await L.claimReview("t1", ALIAS, runner) as unknown as ReviewClaim;
  expect(next.request).not.toBe(first.request);
  await refusal(L.renewReview("t1", ALIAS, first.request), "stale_request");
  await refusal(L.releaseReview("t1", ALIAS, "Late cleanup", true, first.request), "stale_request");
  expect(await L.unparsableReview("t1", ALIAS, HEAD, "Late reply", "unusable", true, first.request)).toEqual({ released: false });
  await refusal(L.addReview({ ...await review(L, ALIAS), request: first.request }, undefined, true), "stale_request");
  await L.addReview({ ...await review(L, ALIAS), request: next.request }, undefined, true);
  expect((await detail(L)).reviews.at(-1)).toMatchObject({ by: REVIEWER, recordedBy: ALIAS, claimed: true, request: next.request });
  expect((await detail(L)).gate.ready).toBe(true);
  await refusal(L.addReview({ ...await review(L, ALIAS), request: next.request }, undefined, true), "stale_request");
});


it("single-family admits a different model of the selected company on every review path, including aliases", async () => {
  for (const path of ["direct", "claimed"]) {
    const name = `admission-single-${path}`, L = await setup(name);
    const model = entry("gpt-6-reviewer", ["outside"]), actor = "opencode/outside";
    const admission = await L.admitReviewer(model.id, true, "Qualified", "owner", [model]);
    await L.initProject({ name, repo: `${name}--baseline`, reset: false, familyMode: { single: "openai", by: "owner" } }, "owner");
    for (const kind of ["protected", "coordinated"] as const) {
      expect(independentApproval({ ...await review(L, actor), reviewerAdmission: admission }, kind, [BUILDER], "owner", "openai")).toBe(true);
      expect(independentApproval({ ...await review(L, actor), reviewerAdmission: admission }, kind, [actor], "owner", "openai")).toBe(false);
      expect(independentApproval({ ...await review(L, actor), reviewerAdmission: admission }, kind, [BUILDER], "owner", "anthropic")).toBe(false);
    }
    let request: number | undefined;
    if (path === "claimed") {
      const live = [{ ...offers()[0], agents: [{ agent: "opencode", models: [model.id] }] }];
      await L.requestReview("t1", "owner", actor, [model], false, false, undefined, live);
      request = (await L.claimReview("t1", actor, runner) as unknown as ReviewClaim).request;
    }
    await L.addReview({ ...await review(L, actor), ...(request ? { request } : {}) }, undefined, path === "direct");
    expect((await detail(L)).gate.ready).toBe(true);
  }
});

it("a family switch withdraws admitted foreign requests and refuses foreign aliases on all new paths", async () => {
  for (const claimed of [false, true]) {
    const name = `admission-switch-${claimed}`, L = await setup(name);
    await admit(L);
    await L.requestReview("t1", "owner", ALIAS, POOL, false, false, undefined, offers());
    if (claimed) await L.claimReview("t1", ALIAS, runner);
    await L.initProject({ name, repo: `${name}--baseline`, reset: false, familyMode: { single: "openai", by: "owner" } }, "owner");
    expect((await L.reviewRequests("t1")).at(-1)?.state).toBe("withdrawn");
    await refusal(L.addReview(await review(L, ALIAS), undefined, true), "single_family");
    await refusal(L.requestReview("t1", "owner", ALIAS, POOL, false, false, undefined, offers()), "single_family");
    await refusal(L.claimReview("t1", ALIAS, runner), "not_independent");
    expect((await detail(L)).gate.ready).toBe(false);
  }
});

it("binding an admitted request enforces a changed company even before request withdrawal", async () => {
  const L = await setup("admission-bind-family");
  await admit(L);
  await L.requestReview("t1", "owner", ALIAS, POOL, false, false, undefined, offers());
  const project = await L.project();
  await L.setProject({ ...project, policy: { ...project.policy, familyMode: { single: "openai", by: "owner", at: new Date().toISOString() } } }, "owner");
  await refusal(L.claimReview("t1", ALIAS, runner), "not_independent");
  expect((await L.reviewRequests("t1")).at(-1)?.state).toBe("open");
});

// t687: ikon-weblog never admitted gemini-4-argon, so asking antigravity/gemini-4-argon
// for a review there was refused as ineligible; admit and withdraw refused the form
// atelier models prints with "not registered".
it("a model admitted in atelier reviews in every project until a project withdraws it; admit takes harness/model", async () => {
  const home = await setup("atelier"), other = await setup("standard-other"), late = await setup("standard-late");
  const sendStandard = async () => {
    const standard = (await home.reviewerAdmissions()).filter((a) => a.active);
    for (const L of [other, late]) await L.setStandardReviewers(standard);
  };
  const asked = () => other.requestReview("t1", "owner", REVIEWER, POOL, false, false, undefined, offers());
  await refusal(asked(), "ineligible");
  const admitted = await home.admitReviewer(`opencode/${POOL[0].id}`, true, "Qualified", "owner", POOL);
  expect(admitted).toMatchObject({ id: POOL[0].id, active: true });
  await sendStandard();
  expect(await asked()).toMatchObject({ requested: true, reviewer: REVIEWER });
  expect((await other.reviewerListing())[0]).toMatchObject({ id: POOL[0].id, inherited: "atelier" });
  expect((await other.reviewerAdmissions())).toEqual([]);
  // A project withdraws it for itself alone; the request open there is withdrawn.
  await other.admitReviewer(`opencode/${POOL[0].id}`, false, "Not for this project", "owner", POOL);
  expect(hasRole(REVIEWER, (await other.project()).policy, "assessor")).toBe(false);
  expect(await other.reviewWaiting()).toEqual([]);
  expect(hasRole(REVIEWER, (await late.project()).policy, "assessor")).toBe(true);
  await sendStandard();
  expect(hasRole(REVIEWER, (await other.project()).policy, "assessor")).toBe(false);
  // The harness must be the entry's own.
  await refusal(home.admitReviewer(`codex/${POOL[0].id}`, true, "wrong harness", "owner", POOL), "no_model");
  // Atelier withdrawing ends the sharing for projects with no record of their own.
  await home.admitReviewer(POOL[0].id, false, "Retired", "owner", POOL);
  await sendStandard();
  expect(hasRole(REVIEWER, (await late.project()).policy, "assessor")).toBe(false);
});
