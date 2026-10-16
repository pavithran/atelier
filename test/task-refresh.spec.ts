import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent, RefreshView } from "../src/ledger.ts";
import type { SeenOffer } from "../src/dispatch/rules.ts";
import { parseRuleError, type ProjectPolicy } from "../src/rules.ts";

// Every open task stays merged with main (t462): the Ledger's refresh queue
// against its real storage. Main advancing queues every unfinished task
// with a branch of its own and says why a busy or blocked one waits;
// repeated events change nothing and newer heads coalesce; only the
// integrator leases a refresh, and a report is taken only under its lease
// at the head it found; an accepted task's acceptance does not carry to the
// refreshed head; a builder's push or a landing is never raced; a mechanical
// conflict goes to a resolver independent of the reviews it would retain,
// recorded among the contributors, or waits saying why; any other conflict
// goes back to the builder with its report; failed checks send it back
// too. The routes verify the pushed merge on a stand-in Artifacts. Workerd
// logs each refusal under test as an "uncaught exception"; those lines are
// the refusals, not failures.

const TOKEN = "task-refresh-token";
const H0 = "0".repeat(40), H1 = "1".repeat(40), H2 = "2".repeat(40), M1 = "a".repeat(40), M2 = "b".repeat(40), R1 = "c".repeat(40), R2 = "d".repeat(40);
const OPUS = "claude-code/opus-5.5", FABLE = "claude-code/fable-5.1", GPT = "codex/gpt-6-astra";
const INTEGRATOR = "atelier/integrator";

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
type L = ReturnType<typeof ledger>;

async function setup(name: string, policy: Partial<ProjectPolicy> = {}) {
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [], ...policy }, createdAt: new Date().toISOString() };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}

async function refusal(p: Promise<unknown>, code: string, detail?: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  if (detail) expect(parsed?.detail).toMatch(detail);
}

const events = async (L: L, id: string) => (await L.events(id)) as unknown as LedgerEvent[];
const queue = async (L: L) => (await L.refreshQueue()) as unknown as RefreshView[];
const passed = (id: string, head: string) => ({ itemId: id, claim: "npm test", grade: "observed" as const, head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/a.ts"] });

// A task built to `head` by OPUS, then left in `to`.
async function task(L: L, title: string, to: "claimed" | "submitted" | "accepted" | "released" | "blocked" | "new", head = H1) {
  const { id } = await L.newItem(title, ["src/**"], "owner");
  if (to === "new") return id;
  await L.claim(id, OPUS);
  await L.setFork(id, `fork-${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, head, head);
  if (to === "claimed") return id;
  if (to === "released") { await L.release(id, OPUS, "stepping away"); return id; }
  await L.addEvidence(passed(id, head));
  await L.submit(id, OPUS);
  if (to === "blocked") { await L.block(id, OPUS, "waiting on the owner"); return id; }
  if (to === "accepted") await L.accept(id, "owner");
  return id;
}

const lease = async (L: L, id: string, actor = INTEGRATOR, job: "refresh" | "resolve" = "refresh") => (await L.leaseRefresh(id, actor, "home:studio", job)).lease;
const report = (l: { id: string; mainHead: string; expectedHead: string }) => ({ lease: l.id, mainHead: l.mainHead, expectedHead: l.expectedHead });
const offer = (agent: string, model: string, jobs = ["task-resolve"]): SeenOffer => ({ runner: `home:${model}`, kind: "home", agents: [{ agent, models: [model] }], jobs, at: new Date().toISOString() });

it("main advancing queues every unfinished task with a branch of its own, and a busy or blocked one says why it waits", async () => {
  const L = await setup("tr-standing");
  const submitted = await task(L, "Submitted", "submitted");
  const accepted = await task(L, "Accepted", "accepted");
  const claimed = await task(L, "Claimed", "claimed");
  const released = await task(L, "Released", "released");
  const blocked = await task(L, "Blocked", "blocked");
  const fresh = await task(L, "Never claimed", "new");
  await L.noteMainHead(M1);
  const rows = await queue(L);
  expect(rows.map((r) => r.item).sort()).toEqual([submitted, accepted, claimed, released, blocked].sort());
  expect(rows.find((r) => r.item === fresh)).toBeUndefined();
  const of = (id: string) => rows.find((r) => r.item === id)!;
  for (const id of [submitted, accepted, released]) expect(of(id).standing.kind).toBe("eligible");
  expect(of(claimed).standing).toMatchObject({ kind: "deferred", busy: "claimed" });
  expect(of(claimed).standing.reason).toMatch(/claude-code\/opus-5.5 holds .* works in its workspace/);
  expect(of(blocked).standing).toMatchObject({ kind: "deferred", busy: "blocked" });
  expect(of(blocked).standing.reason).toMatch(/waiting on the owner/);
  for (const r of rows) expect(r.target).toMatchObject({ mainHead: M1, state: "queued" });
  // Only eligible ones are offered to the integrator.
  const jobs = await L.refreshJobs({ runner: "home:i", kind: "home", agents: [], jobs: ["task-refresh"] });
  expect(jobs.map((j) => j.id).sort()).toEqual([submitted, accepted, released].sort());
  expect(jobs[0].dispatch).toMatchObject({ job: "task-refresh", head: M1, agent: "atelier", model: "integrator" });
  await refusal(L.leaseRefresh(claimed, INTEGRATOR, null, "refresh"), "refresh_deferred", /works in its workspace/);
});

it("a merge recorded queues the others; repeated events change nothing and a newer main head coalesces", async () => {
  const L = await setup("tr-coalesce");
  const waiting = await task(L, "Waits", "submitted");
  const landed = await task(L, "Lands", "accepted", H2);
  await L.beginProjectLanding(landed, "owner");
  await L.merged(landed, "owner", M1, true);
  expect((await queue(L)).map((r) => r.item)).toEqual([waiting]);
  await L.noteMainHead(M1);
  await L.noteMainHead(M1);
  expect((await events(L, waiting)).filter((e) => e.kind === "refresh.queued")).toHaveLength(1);
  await L.noteMainHead(M2);
  const [row] = await queue(L);
  expect(row.target).toMatchObject({ mainHead: M2, coalesced: 1, state: "queued" });
  expect((await events(L, waiting)).find((e) => e.kind === "refresh.queued" && e.data.mainHead === M2)?.data).toMatchObject({ replaced: M1 });
});

it("a clean refresh moves the head under the integrator's lease, drops the acceptance, keeps the owner and needs checks again", async () => {
  const L = await setup("tr-clean");
  const id = await task(L, "Accepted", "accepted");
  await L.noteMainHead(M1);
  await refusal(L.leaseRefresh(id, OPUS, null, "refresh"), "not_integrator");
  const l = await lease(L, id);
  expect(l).toMatchObject({ job: "refresh", by: INTEGRATOR, mainHead: M1, expectedHead: H1 });
  await refusal(L.leaseRefresh(id, INTEGRATOR, null, "refresh"), "refresh_leased");
  await L.refreshPushing(id, INTEGRATOR, { ...report(l), head: R1 });
  await refusal(L.taskRefreshed(id, INTEGRATOR, { ...report(l), head: R1, agent: OPUS }, true), "bad_agent");
  const done = await L.taskRefreshed(id, INTEGRATOR, { ...report(l), head: R1, agent: INTEGRATOR, diffBefore: "e".repeat(40), diffAfter: "e".repeat(40) }, true);
  expect(done.item).toMatchObject({ head: R1, state: "submitted", acceptedHead: null, owner: OPUS });
  expect(done.result).toMatchObject({ outcome: "refreshed", head: R1, reason: "checks pending" });
  const refreshed = (await events(L, id)).find((e) => e.kind === "item.refreshed")!;
  expect(refreshed.data).toMatchObject({ mainHead: M1, from: H1, head: R1, agent: INTEGRATOR, diffChanged: false, approvalInvalidated: true });
  expect(String(refreshed.data.review)).toMatch(/does not authorize this one/);
  // A clean merge adds no contributor.
  expect((await L.item(id)).pushActors).toEqual([OPUS]);
  // The previous acceptance does not authorize the new head, whose checks are pending.
  await refusal(L.accept(id, "owner", H1), "stale_head");
  await refusal(L.accept(id, "owner"), "not_ready", /not yet observed/);
  // The same report again answers the recorded outcome.
  expect(await L.taskRefreshed(id, INTEGRATOR, { ...report(l), head: R1, agent: INTEGRATOR }, true)).toMatchObject({ replay: true });
  expect(await L.refreshChecker(id, INTEGRATOR, R1)).toBe(true);
  expect(await L.refreshChecker(id, GPT, R1)).toBe(false);
  await L.addEvidence({ ...passed(id, R1), by: INTEGRATOR });
  expect((await L.refreshChecked(id, INTEGRATOR, { ...report(l), passed: true, reason: "" })).result.outcome).toBe("refreshed");
  expect(await queue(L)).toEqual([]);
  expect(await L.refreshChecker(id, INTEGRATOR, R1)).toBe(false);
  await L.accept(id, "owner");
  expect((await L.item(id)).acceptedHead).toBe(R1);
});

it("a builder's push under the lease is never overwritten: the report is refused and the task is refreshed again from its new head", async () => {
  const L = await setup("tr-builder");
  const id = await task(L, "Submitted", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  await L.recordPush(id, OPUS, H2, H2);
  await refusal(L.refreshPushing(id, INTEGRATOR, { ...report(l), head: R1 }), "head_moved");
  await refusal(L.taskRefreshed(id, INTEGRATOR, { ...report(l), head: R1, agent: INTEGRATOR }, true), "head_moved");
  await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "superseded", reason: "the fork moved" });
  expect((await L.item(id)).head).toBe(H2);
  await refusal(L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "superseded", reason: "again" }), "lease_lost");
  expect((await lease(L, id)).expectedHead).toBe(H2);
});

it("a refresh never races a landing: neither starts while the other holds the task", async () => {
  const L = await setup("tr-landing");
  const id = await task(L, "Accepted", "accepted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  await L.refreshPushing(id, INTEGRATOR, { ...report(l), head: R1 });
  await refusal(L.beginProjectLanding(id, "owner"), "refresh_pushing");
  const other = await task(L, "Lands first", "accepted", H2);
  await L.noteMainHead(M2);
  await L.beginProjectLanding(other, "owner");
  expect((await queue(L)).find((r) => r.item === other)?.standing).toMatchObject({ kind: "deferred", busy: "landing" });
  await refusal(L.leaseRefresh(other, INTEGRATOR, null, "refresh"), "refresh_deferred", /landing now/);
});

it("a mechanical conflict goes to a resolver independent of the review it would retain, who joins the contributors", async () => {
  const L = await setup("tr-resolver", { resolvers: [OPUS, GPT] });
  const id = await task(L, "Reviewed", "submitted");
  await L.addReview({ itemId: id, by: FABLE, head: H1, criteria: await L.criteria(id), approve: true, note: "fine", at: new Date().toISOString() });
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  const found = await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "mechanical", reason: "imports" }, [offer("claude-code", "opus-5.5"), offer("codex", "gpt-6-astra")]);
  // Opus shares Fable's family, so the approval would no longer be independent of it.
  expect(found.result).toMatchObject({ outcome: "mechanical", resolver: GPT });
  expect((await events(L, id)).find((e) => e.kind === "refresh.resolver")?.data).toMatchObject({ resolver: GPT, provider: "openai" });
  expect(await L.refreshJobs({ runner: "home:i", kind: "home", agents: [], jobs: ["task-refresh"] })).toEqual([]);
  const [job] = await L.refreshJobs({ runner: "home:g", kind: "home", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["task-resolve"] });
  expect(job.dispatch).toMatchObject({ job: "task-resolve", agent: "codex", model: "gpt-6-astra", head: M1, expectedHead: H1 });
  await refusal(L.leaseRefresh(id, OPUS, null, "resolve"), "not_resolver");
  const r = await lease(L, id, GPT, "resolve");
  await L.refreshPushing(id, GPT, { ...report(r), head: R2 });
  await refusal(L.taskRefreshed(id, GPT, { ...report(r), head: R2, agent: INTEGRATOR }, true), "bad_agent");
  await L.taskRefreshed(id, GPT, { ...report(r), head: R2, agent: GPT, transformations: ["import-union"] }, true);
  expect((await L.item(id)).pushActors).toEqual([OPUS, GPT]);
  expect((await events(L, id)).find((e) => e.kind === "item.refreshed")?.data).toMatchObject({ resolver: GPT, agent: GPT, transformations: ["import-union"] });
});

it("with no eligible resolver a mechanical conflict waits, saying why, until one is offered", async () => {
  const L = await setup("tr-wait", { resolvers: [OPUS] });
  const id = await task(L, "Reviewed", "submitted");
  await L.addReview({ itemId: id, by: FABLE, head: H1, criteria: await L.criteria(id), approve: true, note: "fine", at: new Date().toISOString() });
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  const waited = await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "mechanical", reason: "imports" }, [offer("claude-code", "opus-5.5")]);
  expect(waited.result.outcome).toBe("waiting");
  const [row] = await queue(L);
  expect(row.target.state).toBe("waiting");
  expect(row.target.wait).toMatch(/claude-code\/opus-5.5, the review by claude-code\/fable-5.1 would no longer be independent/);
  expect((await events(L, id)).find((e) => e.kind === "refresh.waiting")).toBeTruthy();
  // An offer of a model outside the configured set ends no wait.
  expect(await L.refreshJobs({ runner: "home:g", kind: "home", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["task-resolve"] })).toEqual([]);
  expect((await queue(L))[0].target.state).toBe("waiting");
  await refusal(L.leaseRefresh(id, INTEGRATOR, null, "refresh"), "not_queued", /waiting/);
});

// t652, codex/gpt-6-astra's review of 7f6f0077: the resolver pick read
// every runner's offer (offerActors), so a mechanical refresh could choose a
// resolver only another project's runner offers, and the task waited in
// resolve for a runner that never polls this project.
it("a resolver offered only by a runner scoped to another project is not picked; the refresh waits until one serving it is offered", async () => {
  const L = await setup("tr-scoped-resolver", { resolvers: [OPUS, GPT] });
  const id = await task(L, "Reviewed", "submitted");
  await L.addReview({ itemId: id, by: FABLE, head: H1, criteria: await L.criteria(id), approve: true, note: "fine", at: new Date().toISOString() });
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  const elsewhere = { ...offer("codex", "gpt-6-astra"), projects: ["tr-elsewhere"] };
  const waited = await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "mechanical", reason: "imports" }, [offer("claude-code", "opus-5.5"), elsewhere]);
  expect(waited.result).toMatchObject({ outcome: "waiting", resolver: null });
  expect((await queue(L))[0].target.state).toBe("waiting");
  // A runner whose token serves this project, offering the same model, ends the wait.
  const [job] = await L.refreshJobs({ runner: "home:g", kind: "home", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["task-resolve"], projects: ["tr-scoped-resolver"] });
  expect(job.dispatch).toMatchObject({ job: "task-resolve", agent: "codex", model: "gpt-6-astra" });
});

it("a behavioural conflict goes back to the builder with the heads, paths and hunks; the builder's push queues it again", async () => {
  const L = await setup("tr-returned");
  const id = await task(L, "Conflicts", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  const conflict = { base: H0, head: H1, main: M1, kind: "behavioural", files: [{ path: "src/limit.ts", kind: "behavioural", why: "both sides changed these lines differently", hunks: [{ line: 2, kind: "behavioural", why: "both changed", ours: ["20"], base: ["10"], theirs: ["30"] }] }] };
  await refusal(L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "returned", reason: "conflict" }), "bad_report", /needs its report/);
  await refusal(L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "returned", reason: "conflict", report: { ...conflict, head: H2 } }), "bad_report", /lease's heads/);
  await refusal(L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "returned", reason: "", report: { ...conflict, kind: "mechanical" } }), "bad_report", /resolver/);
  await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "returned", reason: "", report: conflict });
  expect((await events(L, id)).find((e) => e.kind === "refresh.returned")?.data).toMatchObject({ builder: OPUS, base: H0, head: H1, mainHead: M1, kind: "behavioural", paths: ["src/limit.ts"] });
  const [row] = await queue(L);
  expect(row.target).toMatchObject({ state: "returned", report: conflict });
  expect(row.last).toMatchObject({ outcome: "returned", reason: "behavioural conflict in src/limit.ts" });
  // The same report again answers the recorded outcome.
  expect(await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "returned", reason: "", report: conflict })).toMatchObject({ replay: true });
  // The builder takes main and pushes: the task is refreshed again from there.
  await L.recordPush(id, OPUS, H2, H2);
  expect((await queue(L))[0].target.state).toBe("queued");
});

it("checks that fail at the refreshed head send the task back to its builder", async () => {
  const L = await setup("tr-checks");
  const id = await task(L, "Checks", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  await L.taskRefreshed(id, INTEGRATOR, { ...report(l), head: R1, agent: INTEGRATOR }, true);
  await L.addEvidence({ ...passed(id, R1), passed: false, by: INTEGRATOR });
  const failed = await L.refreshChecked(id, INTEGRATOR, { ...report(l), passed: false, reason: "FAIL npm test" });
  expect(failed.result).toMatchObject({ outcome: "checks", reason: "FAIL npm test" });
  expect((await events(L, id)).find((e) => e.kind === "refresh.checks_failed")?.data).toMatchObject({ head: R1, builder: OPUS });
  expect(await queue(L)).toEqual([]);
  expect((await L.item(id))).toMatchObject({ head: R1, state: "submitted", owner: OPUS });
});

it("a newer main while a refresh runs is refreshed next, from the head the refresh left", async () => {
  const L = await setup("tr-newer");
  const id = await task(L, "Moves", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  await L.noteMainHead(M2);
  expect((await queue(L))[0].target).toMatchObject({ state: "leased", mainHead: M2 });
  await L.taskRefreshed(id, INTEGRATOR, { ...report(l), head: R1, agent: INTEGRATOR }, true);
  await L.refreshChecked(id, INTEGRATOR, { ...report(l), passed: true, reason: "" });
  const next = await lease(L, id);
  expect(next).toMatchObject({ mainHead: M2, expectedHead: R1 });
});

// ── the routes, through the Worker ───────────────────────────────────────

// A stand-in Artifacts: each repository a log, newest first, with messages.
function artifacts(repos: Record<string, { hash: string; parents: string[]; message?: string }[]>): Artifacts {
  return {
    get: async (name: string) => ({
      log: async ({ ref, limit = 50 }: { ref?: string; limit?: number } = {}) => {
        const chain = repos[name] ?? [];
        const from = ref === undefined ? 0 : chain.findIndex((c) => c.hash === ref);
        return from < 0 ? [] : chain.slice(from, from + Math.min(limit, 1000)).map((c) => ({ ...c, treeHash: c.hash }));
      },
      revokeToken: async () => {},
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
}

function call(name: string, path: string, actor: string, body: unknown, ARTIFACTS: Artifacts, method = "POST") {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS } as typeof env);
}
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

it("the refreshed route verifies the merge on the fork — its head, its parents and its Agent line — before the Ledger records it", async () => {
  const name = "tr-route";
  const L = await setup(name);
  const id = await task(L, "Routed", "submitted");
  const repo = (merge: { hash: string; parents: string[]; message?: string }) => artifacts({ [`fork-${id}`]: [merge, { hash: H1, parents: [H0] }, { hash: H0, parents: [] }], [`${name}--baseline`]: [{ hash: M1, parents: [H0] }, { hash: H0, parents: [] }] });
  const enqueued = await call(name, "refreshes", "owner", {}, repo({ hash: H1, parents: [H0] }));
  expect(enqueued.status, await enqueued.clone().text()).toBe(200);
  expect(await enqueued.json()).toMatchObject({ queued: 1, mainHead: M1 });
  const listed = await call(name, "refreshes", "owner", undefined, repo({ hash: H1, parents: [H0] }), "GET");
  expect(((await listed.json()) as RefreshView[]).map((r) => r.item)).toEqual([id]);
  const l = await lease(L, id);
  const body = { ...report(l), head: R1 };
  const merged = (parents: string[], message = `Merge main\n\nAgent: ${INTEGRATOR}`) => repo({ hash: R1, parents, message });
  let res = await call(name, `items/${id}/refreshed`, INTEGRATOR, body, merged([M1, H1]));
  expect(res.status).toBe(409);
  expect(await errorOf(res)).toBe("unverified_merge");
  res = await call(name, `items/${id}/refreshed`, INTEGRATOR, body, merged([H1, M1], `Merge main\n\nAgent: ${OPUS}`));
  expect(await errorOf(res)).toBe("bad_agent");
  res = await call(name, `items/${id}/refreshed`, INTEGRATOR, body, merged([H1, M1]));
  expect(res.status, await res.clone().text()).toBe(200);
  expect((await L.item(id)).head).toBe(R1);
  // The leaseholder may record the checks at the refreshed head; nobody else who does not hold the task may.
  const evidence = { kind: "check", claim: "npm test", head: R1, passed: true };
  res = await call(name, `items/${id}/evidence`, GPT, evidence, merged([H1, M1]));
  expect(await errorOf(res)).toBe("not_owner");
});

it("the leaseholder renews its lease through a long run, and gives it back with no outcome: a refresh is queued again, a resolver's goes back to it", async () => {
  const L = await setup("tr-release", { resolvers: [GPT] });
  const id = await task(L, "Released lease", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  // Renewed: the term starts again from now, only by its holder and under its id.
  const renewed = await L.renewRefreshLease(id, INTEGRATOR, l.id);
  expect(Date.parse(renewed.until)).toBeGreaterThanOrEqual(Date.parse(l.until));
  expect(renewed.id).toBe(l.id);
  await refusal(L.renewRefreshLease(id, GPT, l.id), "not_leaseholder");
  await refusal(L.renewRefreshLease(id, INTEGRATOR, "other"), "lease_lost");
  // Given back (a detector's failure, say): the reason is logged, the target queued, and a retry does nothing.
  await refusal(L.releaseRefreshLease(id, GPT, l.id, "x"), "not_leaseholder");
  expect((await L.releaseRefreshLease(id, INTEGRATOR, l.id, "comparing moved code failed")).released).toBe(true);
  expect((await queue(L))[0].target).toMatchObject({ state: "queued", lease: null });
  expect((await events(L, id)).find((e) => e.kind === "refresh.released")?.data).toMatchObject({ job: "refresh", lease: l.id, reason: "comparing moved code failed" });
  expect((await L.releaseRefreshLease(id, INTEGRATOR, l.id, "again")).released).toBe(false);
  await refusal(L.renewRefreshLease(id, INTEGRATOR, l.id), "lease_lost");
  // A resolver's lease given back for a provider's limit leaves the conflict waiting for the same resolver at the same head.
  const again = await lease(L, id);
  expect((await L.taskRefreshFailed(id, INTEGRATOR, { ...report(again), outcome: "mechanical", reason: "imports" }, [offer("codex", "gpt-6-astra")])).result.resolver).toBe(GPT);
  const r = await lease(L, id, GPT, "resolve");
  const back = await L.releaseRefreshLease(id, GPT, r.id, "codex usage limit: usage limit reached", true);
  expect(back.released).toBe(true);
  expect((await queue(L))[0].target).toMatchObject({ state: "resolve", resolver: GPT, expectedHead: H1, lease: null });
  expect((await events(L, id)).find((e) => e.kind === "refresh.released" && (e.data as { lease?: string }).lease === r.id)?.data).toMatchObject({ job: "resolve", providerLimit: true });
  const resumed = await lease(L, id, GPT, "resolve");
  expect(resumed.id).not.toBe(r.id);
  // A lease checking its recorded head is not given back: its checks are reported instead.
  await L.refreshPushing(id, GPT, { ...report(resumed), head: R2 });
  await L.taskRefreshed(id, GPT, { ...report(resumed), head: R2, agent: GPT, transformations: ["import-union"] }, true);
  await refusal(L.releaseRefreshLease(id, GPT, resumed.id, "check crashed"), "refresh_recorded");
});

it("a resolver's lease given back while main moved on queues the newer main head", async () => {
  const L = await setup("tr-release-newer", { resolvers: [GPT] });
  const id = await task(L, "Newer main", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "mechanical", reason: "imports" }, [offer("codex", "gpt-6-astra")]);
  const r = await lease(L, id, GPT, "resolve");
  await L.noteMainHead(M2);
  await L.releaseRefreshLease(id, GPT, r.id, "limit", true);
  expect((await queue(L))[0].target).toMatchObject({ state: "queued", mainHead: M2, resolver: null });
});

// A lease whose runner died: its term ended a moment ago.
async function lapse(L: L, id: string): Promise<void> {
  await runInDurableObject(L, async (_instance, state) => {
    const row = state.storage.sql.exec("SELECT json FROM refresh_targets WHERE item = ?", id).toArray()[0];
    const target = JSON.parse(row.json as string);
    target.lease.until = new Date(Date.now() - 1000).toISOString();
    state.storage.sql.exec("UPDATE refresh_targets SET json = ? WHERE item = ?", JSON.stringify(target), id);
  });
}

it("a clean refresh whose lease lapses while its checks run resumes them at the recorded head, rather than finding main already held", async () => {
  const L = await setup("tr-resume-clean");
  const id = await task(L, "Resumes", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  await L.taskRefreshed(id, INTEGRATOR, { ...report(l), head: R1, agent: INTEGRATOR }, true);
  // The head as recorded, which a leaseholder whose answers were lost reads.
  expect(await L.refreshLeaseStatus(id, INTEGRATOR, l.id)).toEqual({ head: R1, lease: true, checking: R1 });
  expect(await L.refreshLeaseStatus(id, INTEGRATOR, "other")).toEqual({ head: R1, lease: false, checking: null });
  await lapse(L, id);
  const [job] = await L.refreshJobs();
  expect(job.dispatch).toMatchObject({ job: "task-refresh", head: M1, expectedHead: R1 });
  const resumed = await lease(L, id);
  expect(resumed).toMatchObject({ job: "refresh", mainHead: M1, expectedHead: H1, checking: R1 });
  expect(resumed.id).not.toBe(l.id);
  await refusal(L.refreshChecked(id, INTEGRATOR, { ...report(l), passed: true, reason: "" }), "lease_lost");
  expect((await L.refreshChecked(id, INTEGRATOR, { ...report(resumed), passed: true, reason: "" })).result).toMatchObject({ outcome: "refreshed", head: R1, reason: null });
  expect(await queue(L)).toEqual([]);
  expect(await L.item(id)).toMatchObject({ head: R1 });
});

it("a resolver's lease that lapses while its checks run is taken again by the resolver at the recorded head", async () => {
  const L = await setup("tr-resume-resolve", { resolvers: [GPT] });
  const id = await task(L, "Resolved", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "mechanical", reason: "imports" }, [offer("codex", "gpt-6-astra")]);
  const r = await lease(L, id, GPT, "resolve");
  await L.taskRefreshed(id, GPT, { ...report(r), head: R2, agent: GPT, transformations: ["import-union"] }, true);
  await lapse(L, id);
  const [job] = await L.refreshJobs();
  expect(job.dispatch).toMatchObject({ job: "task-resolve", agent: "codex", model: "gpt-6-astra" });
  await refusal(L.leaseRefresh(id, INTEGRATOR, null, "refresh"), "not_queued");
  const resumed = await lease(L, id, GPT, "resolve");
  expect(resumed).toMatchObject({ job: "resolve", mainHead: M1, expectedHead: H1, checking: R2 });
  expect((await L.refreshChecked(id, GPT, { ...report(resumed), passed: false, reason: "FAIL npm test" })).result).toMatchObject({ outcome: "checks", head: R2 });
  expect(await queue(L)).toEqual([]);
});

it("a resolver's lapsed lease on a task its builder has since moved queues a refresh from the new head", async () => {
  const L = await setup("tr-lapsed-moved", { resolvers: [GPT] });
  const id = await task(L, "Moved", "released");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "mechanical", reason: "imports" }, [offer("codex", "gpt-6-astra")]);
  await lease(L, id, GPT, "resolve");
  await lapse(L, id);
  await L.claim(id, OPUS);
  await L.recordPush(id, OPUS, H2, H2);
  await L.release(id, OPUS, "pushed a fix");
  expect((await queue(L))[0].target).toMatchObject({ state: "queued", resolver: null, expectedHead: null });
  expect((await lease(L, id)).expectedHead).toBe(H2);
});

it("a resolver no longer eligible when it takes its lease is refused, and the conflict waits for another, saying why", async () => {
  const L = await setup("tr-recheck", { resolvers: [GPT, OPUS] });
  const id = await task(L, "Rechecked", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  expect((await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "mechanical", reason: "imports" }, [offer("codex", "gpt-6-astra")])).result.resolver).toBe(GPT);
  // An approval from GPT's family arrives while the conflict waits for it.
  await L.addReview({ itemId: id, by: "codex/gpt-6", head: H1, criteria: await L.criteria(id), approve: true, note: "fine", at: new Date().toISOString() });
  await refusal(L.leaseRefresh(id, GPT, null, "resolve"), "not_resolver", /no longer resolve it: the review by codex\/gpt-6/);
  const [row] = await queue(L);
  expect(row.target).toMatchObject({ state: "waiting", resolver: null, lease: null, expectedHead: H1 });
  expect((await events(L, id)).filter((e) => e.kind === "refresh.waiting").at(-1)?.data).toMatchObject({ refusals: [{ actor: GPT }] });
  // Another eligible resolver offered ends the wait.
  const [job] = await L.refreshJobs({ runner: "home:o", kind: "home", agents: [{ agent: "claude-code", models: ["opus-5.5"] }], jobs: ["task-resolve"] });
  expect(job.dispatch).toMatchObject({ job: "task-resolve", agent: "claude-code", model: "opus-5.5" });
});

it("a resolver the policy dropped while the conflict waited for it is refused its lease", async () => {
  const L = await setup("tr-recheck-policy", { resolvers: [GPT] });
  const record = (policy: Partial<ProjectPolicy>) => ({ name: "tr-recheck-policy", repo: "tr-recheck-policy--baseline", policy: { checks: ["npm test"], protected: [], ...policy }, createdAt: new Date().toISOString() });
  const id = await task(L, "Policy", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "mechanical", reason: "imports" }, [offer("codex", "gpt-6-astra")]);
  await L.setProject(record({ resolvers: [] }), "owner");
  await refusal(L.leaseRefresh(id, GPT, null, "resolve"), "not_resolver", /configured resolver set/);
  expect((await queue(L))[0].target.state).toBe("waiting");
});

it("a resolver's lease that lapses after main moved on queues the newer main for the integrator, which the resolver may not take", async () => {
  const L = await setup("tr-lapsed-main", { resolvers: [GPT] });
  const id = await task(L, "Main moved", "submitted");
  await L.noteMainHead(M1);
  const l = await lease(L, id);
  await L.taskRefreshFailed(id, INTEGRATOR, { ...report(l), outcome: "mechanical", reason: "imports" }, [offer("codex", "gpt-6-astra")]);
  await lease(L, id, GPT, "resolve");
  await L.noteMainHead(M2);
  await lapse(L, id);
  const [job] = await L.refreshJobs();
  expect(job.dispatch).toMatchObject({ job: "task-refresh", agent: "atelier", model: "integrator", head: M2 });
  await refusal(L.leaseRefresh(id, GPT, null, "resolve"), "not_resolving");
  expect(await lease(L, id)).toMatchObject({ job: "refresh", mainHead: M2, expectedHead: H1 });
});
