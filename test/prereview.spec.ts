import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { Ledger, LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseRuleError, type Evidence, type InboxEntry, type ProjectPolicy } from "../src/rules.ts";
import { isPrereviewRequest, outcomeNote, PREREVIEW_REQUEST_BASE, type PrereviewFence, type PrereviewView } from "../src/dispatch/prereview.ts";
import { assign, type Dispatch } from "../src/dispatch/rules.ts";
import { renderItem, type Detail } from "../src/ui.ts";

// Pre-review on the Ledger (t524): while a landing holds the project's lease
// the next two live FIFO waiters are pre-reviewed, deduplicated by binding;
// the request reaches a runner through the queue's review list only where a
// runner advertises the job, is claimed through the review claim and
// answered through the review route under its own number, and its result is
// pre-review evidence the gate never reads. A fresh blocking verdict takes
// the waiter out and fences its landing (CLI and Workflow alike) until a
// retry; anything else leaves the queue and the landing as they were.

const H0 = "0".repeat(40), MAIN = "c".repeat(40), TREE = "d".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", SONNET = "claude-code/sonnet-5.5";
const TOKEN = "prereview-token";
const AT = "2026-10-11T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };

const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const ledger = (project: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
type L = ReturnType<typeof ledger>;

// The one runner these tests run: what it advertises is rewritten by each.
async function offer(jobs: string[], agents = [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "claude-code", models: ["opus-5.5", "sonnet-5.5"] }]) {
  await index().putRunnerOffer({ runner: RUNNER.runner, kind: "home", jobs, agents }, new Date().toISOString());
}

async function setup(project: string, p: ProjectPolicy = policy) {
  await index().putModel(entry("gpt-6-astra", "codex"));
  await index().putModel(entry("opus-5.5", "claude-code"));
  await offer(["build", "review", "prereview"]);
  const L = ledger(project);
  // No live Artifacts service: tests that exercise baseline polling replace
  // this unavailable read with a changing in-memory repository below.
  await runInDurableObject(L as unknown as DurableObjectStub<Ledger>, async (instance: Ledger) => {
    const internal = instance as unknown as { env: typeof env };
    internal.env = { ...internal.env, ARTIFACTS: {
      async get() { throw new Error("baseline unavailable in this test"); },
    } } as unknown as typeof env;
  });
  const record = { name: project, repo: `${project}--baseline`, policy: p, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await index().registerProject(record);
  return L;
}

const head = (n: number) => n.toString(16).padStart(40, "a");

// A task OPUS built on the runner and submitted at `h`.
async function submitted(L: L, h: string): Promise<string> {
  const id = (await L.newItem(`Task ${h.slice(-2)}`, [], "owner", { accept: ["It works"] })).id;
  await L.dispatch(id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
  await L.claim(id, OPUS, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, h, h);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: h, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/a.ts"] } satisfies Evidence);
  await L.submit(id, OPUS);
  return id;
}

// t1 holds the lease; t2, t3 and t4 queue behind it in that order.
async function landing(project: string, p?: ProjectPolicy) {
  const L = await setup(project, p);
  const [t1, t2, t3, t4] = [await submitted(L, head(1)), await submitted(L, head(2)), await submitted(L, head(3)), await submitted(L, head(4))];
  await L.beginProjectLanding(t1, "owner");
  for (const id of [t2, t3, t4]) await L.queueProjectLanding(id, "owner");
  return { L, t1, t2, t3, t4 };
}

async function refusal(p: Promise<unknown>, code: string, detail?: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  if (detail) expect(parsed?.detail).toMatch(detail);
}

const views = async (L: L, id: string) => (await L.prereviewsFor(id)) as unknown as PrereviewView[];
const events = async (L: L, id: string) => (await L.events(id)) as unknown as LedgerEvent[];
// The claim and the verdict carry main's head as the Worker read it from the
// baseline (MAIN unless a test moves it).
const claim = async (L: L, id: string, actor = GPT, main: string | null = MAIN) => (await L.claimReview(id, actor, RUNNER, true, main)) as unknown as ReviewClaim;
const envelope = (findings: unknown[] = [], main = MAIN, tree = TREE) => ({ prereview: { main, tree }, findings });
const BLOCKING = { file: "src/a.ts", line: 3, severity: "blocking", text: "the queue loses a waiter" };

async function verdict(L: L, id: string, c: ReviewClaim, approve: boolean, findings: unknown[] = [], opts: { proved?: boolean; by?: string; main?: string; mainNow?: string | null } = {}) {
  await L.addReview({ itemId: id, by: opts.by ?? GPT, head: c.head, criteria: c.criteria, request: c.request, approve, note: approve ? "Looks right." : "It breaks.", at: new Date().toISOString(), findings: envelope(findings, opts.main) as never, mainNow: opts.mainNow === undefined ? MAIN : opts.mainNow } as never, undefined, opts.proved ?? true, "api");
}

const queueIds = async (L: L) => ((await L.readLandingQueue()) as { item: string }[]).map((w) => w.item);

it("pre-reviews the next two live waiters behind the holder, once per binding, and offers them only to a runner that advertises the job", async () => {
  const { L, t1, t2, t3, t4 } = await landing("pre-next-two");
  expect(await views(L, t1)).toEqual([]);
  expect((await views(L, t2)).map((v) => [v.state, v.reviewer])).toEqual([["open", GPT]]);
  expect((await views(L, t3)).map((v) => v.state)).toEqual(["open"]);
  expect(await views(L, t4)).toEqual([]);
  // Every poll asks again; the binding is the same, so nothing new is asked.
  for (let i = 0; i < 3; i++) { await L.queueProjectLanding(t2, "owner"); await L.renewProjectLanding(t1, "owner"); }
  expect(await views(L, t2)).toHaveLength(1);
  const v = (await views(L, t2))[0];
  expect(v.binding).toMatchObject({ head: head(2), criteria: ((await L.detail(t2)) as unknown as { criteria: string }).criteria, contributors: [OPUS], main: null, tree: null });
  expect(isPrereviewRequest(v.request)).toBe(true);
  // The queue's review list carries the pre-reviews under their own numbers
  // and job, after the gate's, and only an offer naming the job is assigned one.
  const { reviews } = (await L.queued()) as unknown as { reviews: { id: string; request: number; dispatch: Dispatch }[] };
  const pre = reviews.filter((r) => r.dispatch.job === "prereview");
  expect(pre.map((r) => r.id).sort()).toEqual([t2, t3]);
  expect(pre.every((r) => r.request > PREREVIEW_REQUEST_BASE)).toBe(true);
  const agents = [{ agent: "codex", models: ["gpt-6-astra"] }];
  expect(assign(pre[0].dispatch, { runner: "home:a", kind: "home", jobs: ["review", "prereview"], agents })).toMatchObject({ actor: GPT });
  expect(assign(pre[0].dispatch, { runner: "home:b", kind: "home", jobs: ["review"], agents })).toBeNull();
  // The landing status names each waiter's pre-review.
  const status = (await L.readLandingQueue()) as unknown as { item: string; prereview?: PrereviewView }[];
  expect(status.map((w) => [w.item, w.prereview?.state ?? null])).toEqual([[t2, "open"], [t3, "open"], [t4, null]]);
});

it("asks nothing where no live runner advertises pre-review, and records an unavailable result where no reviewer qualifies", async () => {
  const L = await setup("pre-capability");
  await offer(["build", "review"]);
  const [t1, t2] = [await submitted(L, head(1)), await submitted(L, head(2))];
  await L.beginProjectLanding(t1, "owner");
  await L.queueProjectLanding(t2, "owner");
  expect(await views(L, t2)).toEqual([]);
  // Offered, but only of the builder's own family: no reviewer qualifies.
  await offer(["build", "review", "prereview"], [{ agent: "claude-code", models: ["opus-5.5"] }]);
  await L.queueProjectLanding(t2, "owner");
  const [v] = await views(L, t2);
  expect(v).toMatchObject({ state: "unavailable", outcome: "no-reviewer", attempts: 1 });
  expect(v.recovery).toMatch(/asked again while the task waits/);
  // No block: the waiter keeps its place and its landing goes on.
  await L.queueProjectLanding(t2, "owner");
  expect(await views(L, t2)).toHaveLength(1);
  expect(await queueIds(L)).toEqual([t2]);
  await L.cancelProjectLanding(t1, "owner");
  await L.beginProjectLanding(t2, "owner");
  expect((await L.readProjectLanding())?.item).toBe(t2);
});

it("a pass is evidence only: the queue, the gate, the reviews and the review requests are untouched", async () => {
  const { L, t2, t3, t4 } = await landing("pre-pass");
  const before = await L.detail(t2) as unknown as { gate: unknown; reviews: unknown[] };
  const c = await claim(L, t2);
  expect(c.need).toBeNull();
  expect(c.prereview).toMatchObject({ request: c.request, reviewer: GPT, checks: ["npm test"] });
  await verdict(L, t2, c, true, [{ file: "src/a.ts", line: null, severity: "follow-up", text: "rename later" }]);
  const after = await L.detail(t2) as unknown as { gate: unknown; reviews: unknown[]; prereviews: PrereviewView[]; item: { state: string } };
  expect(after.prereviews[0]).toMatchObject({ state: "passed", verdict: "approve", reviewer: GPT, binding: { main: MAIN, tree: TREE } });
  expect(after.prereviews[0].findings).toHaveLength(1);
  expect(after.reviews).toEqual([]);
  expect(after.gate).toEqual(before.gate);
  expect(after.item.state).toBe("submitted");
  expect(await L.reviewRequests(t2)).toEqual([]);
  expect(await queueIds(L)).toEqual([t2, t3, t4]);
  expect((await events(L, t2)).some((e) => e.kind.startsWith("review."))).toBe(false);
  // The same verdict delivered again changes nothing.
  await verdict(L, t2, c, true);
  expect((await events(L, t2)).filter((e) => e.kind === "prereview.passed")).toHaveLength(1);
});

it("a verdict must come under the reviewer's own token, from the claim's holder", async () => {
  const { L, t2 } = await landing("pre-proved");
  const c = await claim(L, t2);
  await refusal(verdict(L, t2, c, false, [BLOCKING], { proved: false }), "not_proved");
  // Another actor's verdict on the claim is stale and changes nothing.
  await verdict(L, t2, c, false, [BLOCKING], { by: "codex/gpt-6-nova" });
  expect((await views(L, t2))[0].state).toBe("claimed");
  expect(await queueIds(L)).toContain(t2);
});

it("a fresh blocking verdict takes the waiter out at once, fences CLI and Workflow re-entry until a retry, and hands the findings to the builder", async () => {
  const { L, t2, t3, t4 } = await landing("pre-block");
  const c = await claim(L, t2);
  await verdict(L, t2, c, false, [BLOCKING]);
  expect(await queueIds(L)).toEqual([t3, t4]);
  const d = await L.detail(t2) as unknown as { item: { state: string; owner: string; head: string }; prereviews: PrereviewView[]; prereviewFence: PrereviewFence; reviews: unknown[] };
  // The builder and the head stand; the runner's claim is the builder's again.
  expect(d.item).toMatchObject({ state: "claimed", owner: OPUS, head: head(2) });
  expect(d.prereviews[0]).toMatchObject({ state: "blocked", verdict: "reject", ownerAction: null });
  expect(d.prereviewFence).toMatchObject({ request: c.request, head: head(2), reviewer: GPT, blocking: 1, builder: OPUS });
  expect(d.reviews).toEqual([]);
  const brief = await L.jobBrief(t2, OPUS);
  expect(brief.job).toBe("rework");
  expect(brief.text).toContain("the queue loses a waiter");
  expect((await L.heldJobs(RUNNER.runner)).map((i) => i.id)).toContain(t2);
  // Polling again, as atelier land --wait and the Workflow do, is refused.
  for (let i = 0; i < 2; i++) await refusal(L.queueProjectLanding(t2, "owner"), "prereview_blocked", /atelier unblock/);
  await refusal(L.beginProjectLanding(t2, "owner"), "prereview_blocked");
  await L.setLandingWorkflow(t2, "wf-1", "owner", "local");
  await refusal(L.queueProjectLanding(t2, "owner", false, "wf-1"), "prereview_blocked");
  // The CLI's route says the same.
  const res = await worker.fetch(new Request("https://atelier.test/api/projects/pre-block/landing-lease", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify({ item: t2, queued: true }),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe("prereview_blocked");
  // Leaving is never refused; the retry lifts the fence.
  await L.queueProjectLanding(t2, "owner", true);
  await L.unblock(t2, OPUS);
  expect((await L.detail(t2) as unknown as { prereviewFence: unknown }).prereviewFence).toBeNull();
  await L.queueProjectLanding(t2, "owner");
  expect(await queueIds(L)).toEqual([t3, t4, t2]);
});

// Gate review of t524 at 247d6987: a gate rejection at the same head took
// the rework brief, and the pre-review findings that fenced the task were
// read only when there was none.
it("the rework brief carries both a gate rejection at the head and the blocking pre-review, each under its reviewer", async () => {
  const { L, t1, t2 } = await landing("pre-both");
  // The gate rejected t2 at its head in an earlier landing.
  await L.addReview({ itemId: t2, by: SONNET, head: head(2), criteria: ((await L.detail(t2)) as unknown as { criteria: string }).criteria, approve: false, note: "The gate's summary.", at: new Date().toISOString(), findings: [{ file: "src/b.ts", line: 9, severity: "blocking", text: "the gate's own defect" }] } as never, undefined, true, "api");
  const queued = await queueIds(L);
  if (!queued.includes(t2)) await L.queueProjectLanding(t2, "owner");
  await L.renewProjectLanding(t1, "owner");
  const open = (await views(L, t2)).find((v) => v.state === "open");
  expect(open, JSON.stringify(await views(L, t2))).toBeTruthy();
  const c = await claim(L, t2);
  await verdict(L, t2, c, false, [BLOCKING]);
  const brief = await L.jobBrief(t2, OPUS);
  expect(brief.job).toBe("rework");
  expect(brief.text).toContain("the queue loses a waiter");
  expect(brief.text).toContain(`Pre-review ${c.request}`);
  expect(brief.text).toContain("the gate's own defect");
  expect(brief.text).toContain(`${GPT} reviewed`);
  expect(brief.text).toContain(`${SONNET} reviewed`);
  expect(brief.text.indexOf("the queue loses a waiter")).toBeLessThan(brief.text.indexOf("the gate's own defect"));
});

// Pre-review findings of t524's own review: the owner's queue listing gave a
// pre-review entry a build's "not taken" reasons (queueWhy took every job
// that was not "review" for a build), and criterion 9's state, binding,
// reviewer, findings and recovery were in JSON alone, not on the task page.
it("a pre-review's queue entry carries no build reasons, and the task page says its state, binding, reviewer, findings and recovery", async () => {
  const { L, t2 } = await landing("pre-words");
  const res = await worker.fetch(new Request("https://atelier.test/api/queue", { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" } }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  expect(res.status).toBe(200);
  const listed = ((await res.json()) as { project: string; item: { id: string; dispatch?: { job?: string }; why?: unknown } }[]).filter((q) => q.project === "pre-words" && q.item.dispatch?.job === "prereview");
  expect(listed.map((q) => q.item.id)).toContain(t2);
  for (const q of listed) expect(q.item.why).toBeUndefined();
  const c = await claim(L, t2);
  await verdict(L, t2, c, false, [BLOCKING]);
  const d = (await L.detail(t2)) as unknown as Detail;
  const page = renderItem({ name: "pre-words", repo: "pre-words--baseline", policy, createdAt: AT }, d, "PAVI", null);
  expect(page).toContain("Pre-review blocked the landing");
  expect(page).toContain(`Pre-review ${c.request}: blocked; reviewer ${GPT}`);
  expect(page).toContain(`Binding: head ${head(2).slice(0, 8)} merged with main ${MAIN.slice(0, 8)}`);
  expect(page).toContain("src/a.ts:3 · blocking · the queue loses a waiter");
  expect(page).toContain(`Recovery: rework: the builder addresses the blocking findings; then atelier unblock ${t2}`);
  expect(page).toContain("it neither satisfies nor rejects the gate");
});

it("a builder no live runner offers is not handed the rework: the owner is told what to do", async () => {
  const { L, t2 } = await landing("pre-owner");
  await offer(["review", "prereview"], [{ agent: "codex", models: ["gpt-6-astra"] }]);
  await L.renewProjectLanding((await L.readProjectLanding())!.item, "owner");
  const c = await claim(L, t2);
  await verdict(L, t2, c, false, [BLOCKING]);
  const d = await L.detail(t2) as unknown as { item: { state: string; owner: string }; prereviews: PrereviewView[] };
  expect(d.item).toMatchObject({ state: "submitted", owner: OPUS });
  expect(d.prereviews[0].ownerAction).toMatch(/no live runner home:studio offers claude-code\/opus-5\.5 for building/);
  expect(d.prereviews[0].recovery).toMatch(/^developer action needed/);
  const inbox = (await L.inbox(new Date().toISOString())) as unknown as InboxEntry[];
  expect(inbox.find((e) => e.itemId === t2 && e.kind === "blocked")?.reason).toMatch(/developer action needed/);
});

it("a result whose head, main, criteria or contributors moved is stale and changes nothing", async () => {
  // Head: the builder pushed again while it was reviewed.
  const a = await landing("pre-drift-head");
  const ca = await claim(a.L, a.t2);
  // The task's recorded head moves, as a push over it would move it.
  await runInDurableObject(a.L as unknown as DurableObjectStub<Ledger>, async (instance: Ledger) => {
    (instance as unknown as { update(id: string, f: Record<string, string>, at: string): void }).update(a.t2, { head: head(9) }, new Date().toISOString());
  });
  await verdict(a.L, a.t2, ca, false, [BLOCKING]);
  expect((await views(a.L, a.t2)).find((v) => v.request === ca.request)).toMatchObject({ state: "stale", detail: expect.stringMatching(/head moved/) });
  expect(await queueIds(a.L)).toContain(a.t2);

  // Main: a landing merged while it was reviewed.
  const b = await landing("pre-drift-main");
  const cb = await claim(b.L, b.t2);
  await runInDurableObject(b.L as unknown as DurableObjectStub<Ledger>, async (instance: Ledger) => {
    (instance as unknown as { log(i: string, a: string, k: string, d: object, at: string): void }).log(b.t1, "owner", "item.merged", {}, new Date().toISOString());
  });
  await verdict(b.L, b.t2, cb, false, [BLOCKING]);
  expect((await views(b.L, b.t2)).find((v) => v.request === cb.request)).toMatchObject({ state: "stale", detail: expect.stringMatching(/main moved/) });
  expect(await queueIds(b.L)).toContain(b.t2);
  // A new pre-review is asked for the new binding.
  await b.L.queueProjectLanding(b.t2, "owner");
  expect((await views(b.L, b.t2))[0].state).toBe("open");

  // Criteria: the owner changed them while it was reviewed.
  const c = await landing("pre-drift-criteria");
  const cc = await claim(c.L, c.t2);
  await c.L.editItem(c.t2, "owner", { accept: ["It works", "It is fast"] });
  await verdict(c.L, c.t2, cc, false, [BLOCKING]);
  expect((await views(c.L, c.t2)).find((v) => v.request === cc.request)?.state).toBe("stale");
  expect(await queueIds(c.L)).toContain(c.t2);
});

it("a lost claim makes the verdict stale; a second claim of the same request is refused", async () => {
  const { L, t2 } = await landing("pre-claims");
  const c = await claim(L, t2);
  await refusal(claim(L, t2), "no_review");
  // The claim lapses: it ends unavailable (timeout) and the late verdict is stale.
  await runInDurableObject(L as unknown as DurableObjectStub<Ledger>, async (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE prereviews SET claimedAt = ? WHERE state = 'claimed'`, "2026-01-01T00:00:00.000Z");
  });
  await verdict(L, t2, c, false, [BLOCKING]);
  const v = (await views(L, t2)).find((x) => x.request === c.request)!;
  expect(v).toMatchObject({ state: "unavailable", outcome: "timeout" });
  expect((await events(L, t2)).some((e) => e.kind === "prereview.stale")).toBe(true);
  expect(await queueIds(L)).toContain(t2);
  // Retries are bounded and asked again after a timeout.
  await L.queueProjectLanding(t2, "owner");
  expect((await views(L, t2))[0]).toMatchObject({ state: "open", attempts: 2 });
});

it("a task that takes the lease before its pre-review ends keeps the result as evidence, detached from the queue", async () => {
  const { L, t1, t2 } = await landing("pre-handoff");
  const c = await claim(L, t2);
  await L.cancelProjectLanding(t1, "owner");
  await L.beginProjectLanding(t2, "owner");
  expect((await views(L, t2))[0]).toMatchObject({ state: "claimed", detached: true });
  await verdict(L, t2, c, false, [BLOCKING]);
  const d = await L.detail(t2) as unknown as { item: { state: string }; prereviews: PrereviewView[]; prereviewFence: unknown };
  expect(d.prereviews[0]).toMatchObject({ state: "blocked", detached: true });
  expect(d.prereviewFence).toBeNull();
  expect(d.item.state).toBe("submitted");
  expect((await L.readProjectLanding())?.item).toBe(t2);
  await L.renewProjectLanding(t2, "owner");
  // An open pre-review of a task that takes the lease is withdrawn.
  const t3 = (await L.readLandingQueue() as { item: string }[])[0].item;
  await L.cancelProjectLanding(t2, "owner");
  await L.beginProjectLanding(t3, "owner");
  expect((await views(L, t3))[0]).toMatchObject({ state: "withdrawn", detail: expect.stringMatching(/took the landing lease/) });
});

it("a waiter that leaves the queue is no longer pre-reviewed", async () => {
  const { L, t1, t3, t4 } = await landing("pre-leave");
  await L.queueProjectLanding(t3, "owner", true);
  await L.renewProjectLanding(t1, "owner");
  expect((await views(L, t3))[0]).toMatchObject({ state: "withdrawn" });
  // t4 moves up into the window.
  expect((await views(L, t4))[0]?.state).toBe("open");
});

it("conflicts, failed preparation, malformed replies, skips and runner failures are recorded apart and never block", async () => {
  const { L, t2, t3 } = await landing("pre-outcomes");
  const c2 = await claim(L, t2);
  await L.releaseReview(t2, GPT, outcomeNote({ outcome: "conflict", detail: "merging main conflicts", files: ["src/x.ts"], main: MAIN }), true, c2.request);
  expect((await views(L, t2))[0]).toMatchObject({ state: "conflict", files: ["src/x.ts"], binding: { main: MAIN } });
  const c3 = await claim(L, t3);
  await L.unparsableReview(t3, GPT, head(3), "no VERDICT line", "I think it is fine", true, c3.request);
  expect((await views(L, t3))[0]).toMatchObject({ state: "unavailable", outcome: "malformed" });
  // Released twice: applied once.
  await L.releaseReview(t3, GPT, "again", true, c3.request);
  expect((await events(L, t3)).filter((e) => e.kind === "prereview.unavailable")).toHaveLength(1);
  // Nothing landed in the gate's unparsable replies, and nobody moved.
  expect((await L.detail(t3) as unknown as { unparsable: unknown[] }).unparsable).toEqual([]);
  expect((await queueIds(L)).slice(0, 2)).toEqual([t2, t3]);

  const p = await landing("pre-outcomes-2");
  const c = await claim(p.L, p.t2);
  await p.L.releaseReview(p.t2, GPT, outcomeNote({ outcome: "preparation", detail: "npm run regenerate failed" }), true, c.request);
  expect((await views(p.L, p.t2))[0]).toMatchObject({ state: "preparation", detail: "npm run regenerate failed" });
  const s = (await views(p.L, p.t3))[0];
  await p.L.recordReviewSkip(p.t3, s.request, head(3), RUNNER.runner, GPT, "capped", true);
  expect((await views(p.L, p.t3))[0]).toMatchObject({ state: "unavailable", outcome: "skipped" });
  // A plain-text release is a runner failure.
  const q = await landing("pre-outcomes-3");
  const cq = await claim(q.L, q.t2);
  await q.L.releaseReview(q.t2, GPT, "harness exited 1", true, cq.request);
  expect((await views(q.L, q.t2))[0]).toMatchObject({ state: "unavailable", outcome: "runner" });
  // A runner failure is asked again at the next poll, not after
  // PREREVIEW_RETRY_MS, which only a no-reviewer result waits out (the
  // comment at PREREVIEW_RETRY_MS once said every retryable result waited).
  await q.L.queueProjectLanding(q.t2, "owner");
  expect((await views(q.L, q.t2)).map((v) => [v.state, v.attempts])).toEqual([["open", 2], ["unavailable", 1]]);
});

// Gate review of t524 at 247d6987: a runner holding the owner's token sends
// its skip as the owner (cli/commands/runner.mjs, reportReviewSkip), and the
// pre-review branch took only the asked reviewer's, so the route said
// skipped while the request stayed open.
it("a runner's skip under the owner's token, before any claim, records the unavailable result through the route", async () => {
  const project = "pre-owner-skip";
  const { L, t2 } = await landing(project);
  const s = (await views(L, t2))[0];
  expect(s.state).toBe("open");
  const res = await worker.fetch(new Request(`https://atelier.test/api/projects/${project}/items/${t2}/review-skip`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-runner": RUNNER.runner, "content-type": "application/json" },
    body: JSON.stringify({ head: head(2), request: s.request, note: "capped" }),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  expect(res.status, await res.clone().text()).toBe(200);
  expect((await views(L, t2))[0]).toMatchObject({ state: "unavailable", outcome: "skipped", detail: expect.stringMatching(/home:studio skipped it: capped/) });
  // The waiter keeps its place, and a second report changes nothing.
  expect((await queueIds(L))[0]).toBe(t2);
  await L.recordReviewSkip(t2, s.request, head(2), RUNNER.runner, "owner", "capped", true);
  expect((await events(L, t2)).filter((e) => e.kind === "prereview.unavailable")).toHaveLength(1);
  // Anyone else's skip of an open request is still not applied.
  const q = await landing(`${project}-2`);
  const o = (await views(q.L, q.t2))[0];
  await q.L.recordReviewSkip(q.t2, o.request, head(2), RUNNER.runner, SONNET, "", true);
  expect((await views(q.L, q.t2))[0].state).toBe("open");
});

it("a gate review is never displaced: none is asked beside it, and the claim binds the gate's first", async () => {
  const { L, t2, t3 } = await landing("pre-gate");
  await L.requestReview(t2, "owner", GPT, [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")]);
  const { reviews } = (await L.queued()) as unknown as { reviews: { id: string; dispatch: Dispatch }[] };
  expect(reviews.filter((r) => r.id === t2).map((r) => r.dispatch.job)).toEqual(["review"]);
  const c = await claim(L, t2);
  expect(c.prereview).toBeUndefined();
  expect(c.request).toBeLessThan(PREREVIEW_REQUEST_BASE);
  // A waiter with a gate request open gets no new pre-review.
  const fresh = await landing("pre-gate-2");
  await fresh.L.queueProjectLanding(fresh.t2, "owner", true);
  await fresh.L.renewProjectLanding(fresh.t1, "owner");
  await fresh.L.requestReview(fresh.t2, "owner", GPT, [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")]);
  await fresh.L.queueProjectLanding(fresh.t2, "owner");
  expect((await views(fresh.L, fresh.t2)).filter((v) => v.state === "open")).toEqual([]);
  expect((await views(L, t3))[0].state).toBe("open");
});

it("under single-family mode the reviewer is another model of the company, chosen from the offers", async () => {
  await index().putModel(entry("sonnet-5.5", "claude-code"));
  try {
    const single = { ...policy, familyMode: { single: "anthropic" as const, by: "owner", at: AT } };
    const { L, t2 } = await landing("pre-single", single);
    expect((await views(L, t2))[0]).toMatchObject({ state: "open", reviewer: SONNET });
    const c = await claim(L, t2, SONNET);
    expect(c.prereview?.reviewer).toBe(SONNET);
    await refusal(claim(L, (await queueIds(L))[1], GPT), "single_family");
  } finally {
    await index().removeModel("sonnet-5.5");
  }
});

it("a runner token polled a pre-review is granted what a review job is, never a build", async () => {
  const { L, t2 } = await landing("pre-grants");
  const token = { id: "tok-pre", runner: RUNNER.runner } as never;
  await L.runnerPoll(token, { runner: RUNNER.runner, kind: "home", jobs: ["review", "prereview"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }] });
  await L.assertRunnerReport(token, t2, GPT, "review");
  await refusal(L.assertRunnerReport(token, t2, GPT, "build"), "runner_forbidden");
});

// Rework of t524's gate review (gpt-6-astra at b25c44f3), three findings.

// (1) Main's freshness: the request is bound to main's head as read at its
// claim, and a verdict is applied only while the baseline's head is still
// the main it merged — whatever moved it, a merge or a push that records
// none (atelier sync).
it("a verdict prepared against a main the baseline has since left is stale and fences nothing, though no merge was recorded", async () => {
  const MOVED = "e".repeat(40);
  const { L, t2, t3 } = await landing("pre-main-sha");
  // A claim where main's head could not be read is refused; the request stays open.
  await refusal(claim(L, t2, GPT, null), "main_unread");
  expect((await views(L, t2))[0].state).toBe("open");
  const c = await claim(L, t2);
  expect(c.prereview?.binding.main).toBe(MAIN);
  expect((await views(L, t2))[0].binding.main).toBe(MAIN);
  const generation = await L.mergeGeneration();
  // The baseline moved to MOVED by a push the ledger recorded no merge for.
  await verdict(L, t2, c, false, [BLOCKING], { mainNow: MOVED });
  expect(await L.mergeGeneration()).toBe(generation);
  expect((await views(L, t2))[0]).toMatchObject({ state: "stale", detail: expect.stringMatching(/main moved to eeeeeeee/) });
  expect((await L.detail(t2) as unknown as { prereviewFence: unknown }).prereviewFence).toBeNull();
  expect(await queueIds(L)).toContain(t2);
  // A tree prepared from another main than the claim was bound to is stale too.
  const c3 = await claim(L, t3, GPT, MOVED);
  await verdict(L, t3, c3, false, [BLOCKING], { main: MAIN, mainNow: MAIN });
  expect((await views(L, t3))[0]).toMatchObject({ state: "stale", detail: expect.stringMatching(/not eeeeeeee/) });
  expect(await queueIds(L)).toContain(t3);
  // So is a verdict for which main's head could not be read.
  const d = await landing("pre-main-unread");
  const cd = await claim(d.L, d.t2);
  await verdict(d.L, d.t2, cd, false, [BLOCKING], { mainNow: null });
  expect((await views(d.L, d.t2))[0]).toMatchObject({ state: "stale", detail: expect.stringMatching(/could not be read/) });
  expect(await queueIds(d.L)).toContain(d.t2);
});

it("a claimed pre-review whose main the ledger has since seen move is stale at the next sweep", async () => {
  const { L, t1, t2 } = await landing("pre-main-sweep");
  await claim(L, t2);
  await L.noteMainHead("e".repeat(40));
  await L.renewProjectLanding(t1, "owner");
  expect((await views(L, t2)).at(-1)).toMatchObject({ state: "stale", detail: expect.stringMatching(/main moved from cccccccc to eeeeeeee since the claim/) });
});

// (2) A verdict whose word and findings disagree is checked by the ledger,
// not only by the runner's text parser: it is malformed and fences nothing.
it("a rejection with no blocking finding, or an approval with one, is malformed: unavailable, and the waiter keeps its place", async () => {
  const { L, t2, t3, t4 } = await landing("pre-contradiction");
  const c2 = await claim(L, t2);
  await verdict(L, t2, c2, false, []);
  expect((await views(L, t2))[0]).toMatchObject({ state: "unavailable", outcome: "malformed", detail: expect.stringMatching(/rejects but names no blocking finding/) });
  const c3 = await claim(L, t3);
  await verdict(L, t3, c3, true, [BLOCKING]);
  expect((await views(L, t3))[0]).toMatchObject({ state: "unavailable", outcome: "malformed", detail: expect.stringMatching(/approves but names a blocking finding/) });
  for (const id of [t2, t3]) expect((await L.detail(id) as unknown as { prereviewFence: unknown; item: { state: string } })).toMatchObject({ prereviewFence: null, item: { state: "submitted" } });
  expect(await queueIds(L)).toEqual([t2, t3, t4]);
  // The API forwards the payload as posted; the ledger refuses it all the same.
  const c = await landing("pre-contradiction-api");
  const cc = await claim(c.L, c.t2);
  await c.L.addReview({ itemId: c.t2, by: GPT, head: cc.head, criteria: cc.criteria, request: cc.request, approve: false, note: "No.", at: new Date().toISOString(), findings: envelope([{ file: "a", line: 1, severity: "follow-up", text: "nit" }]) as never, mainNow: MAIN } as never, undefined, true, "api");
  expect((await views(c.L, c.t2))[0]).toMatchObject({ state: "unavailable", outcome: "malformed" });
  expect(await queueIds(c.L)).toContain(c.t2);
  // A malformed result may clear: it is asked again within the bound.
  await L.queueProjectLanding(t2, "owner");
  expect((await views(L, t2))[0]).toMatchObject({ state: "open", attempts: 2 });
});

// (3) Eligibility is judged when the queue lists a pre-review and when a
// runner claims it, not only when a landing call sweeps.
it("an expired waiter's pre-review is neither offered nor claimable, though no landing call has swept since", async () => {
  const { L, t2, t3 } = await landing("pre-expired");
  expect((await views(L, t3))[0].state).toBe("open");
  // t3's landing stops asking: its row ages past the expiry with no landing call.
  await runInDurableObject(L as unknown as DurableObjectStub<Ledger>, async (_instance: Ledger, state: DurableObjectState) => {
    const row = state.storage.sql.exec(`SELECT value FROM meta WHERE key = 'landing-queue'`).one();
    const rows = (JSON.parse(row.value as string) as { item: string; renewedAt: string }[]).map((w) => w.item === t3 ? { ...w, at: "2026-01-01T00:00:00.000Z", renewedAt: "2026-01-01T00:00:00.000Z" } : w);
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'landing-queue'`, JSON.stringify(rows));
  });
  const listed = async () => ((await L.queued()) as unknown as { reviews: { id: string; dispatch: Dispatch }[] }).reviews.filter((r) => r.dispatch.job === "prereview").map((r) => r.id);
  expect(await listed()).toEqual([t2]);
  expect((await views(L, t3))[0]).toMatchObject({ state: "withdrawn", detail: expect.stringMatching(/left the landing queue/) });
  await refusal(claim(L, t3), "no_review");
  // A claim reached before any listing is refused too, and ends the request.
  const b = await landing("pre-expired-claim");
  await runInDurableObject(b.L as unknown as DurableObjectStub<Ledger>, async (_instance: Ledger, state: DurableObjectState) => {
    const row = state.storage.sql.exec(`SELECT value FROM meta WHERE key = 'landing-queue'`).one();
    const rows = (JSON.parse(row.value as string) as { item: string }[]).map((w) => w.item === b.t2 ? { ...w, at: "2026-01-01T00:00:00.000Z", renewedAt: "2026-01-01T00:00:00.000Z" } : w);
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'landing-queue'`, JSON.stringify(rows));
  });
  await refusal(claim(b.L, b.t2), "not_eligible", /left the landing queue/);
  expect((await views(b.L, b.t2))[0].state).toBe("withdrawn");
});

it("a lapsed lease takes every pre-review out of reach without ending it, until a live lease brings it back", async () => {
  const { L, t1, t2 } = await landing("pre-lapsed");
  // The holder stops renewing; the waiters keep asking (their rows are fresh).
  await runInDurableObject(L as unknown as DurableObjectStub<Ledger>, async (_instance: Ledger, state: DurableObjectState) => {
    const row = state.storage.sql.exec(`SELECT value FROM meta WHERE key = 'landing-lease'`).one();
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'landing-lease'`, JSON.stringify({ ...JSON.parse(row.value as string), at: "2026-01-01T00:00:00.000Z", renewedAt: "2026-01-01T00:00:00.000Z" }));
  });
  expect(((await L.queued()) as unknown as { reviews: { dispatch: Dispatch }[] }).reviews.filter((r) => r.dispatch.job === "prereview")).toEqual([]);
  await refusal(claim(L, t2), "not_eligible", /no landing holds a live lease/);
  expect((await views(L, t2))[0].state).toBe("open");
  await L.renewProjectLanding(t1, "owner");
  expect((await claim(L, t2)).prereview?.binding.main).toBe(MAIN);
});

// Through the Worker's routes: the claim binds main's head as the baseline
// holds it, and the verdict is judged against the baseline's head when it
// arrives, so a baseline pushed without a recorded merge leaves the result
// stale. The baseline here is a stand-in whose head the test moves.
it("the routes bind the claim to the baseline's head and judge the verdict against it as it is when the verdict comes", async () => {
  const project = "pre-main-route";
  const { L, t2 } = await landing(project);
  let baseline = MAIN;
  const heads: Record<string, () => string> = { [`${project}--baseline`]: () => baseline, [`fork-${t2}`]: () => head(2) };
  const artifacts = {
    async get(name: string) {
      return {
        async log() { return heads[name] ? [{ hash: heads[name](), parents: [] }] : []; },
        async info() { return { remote: `https://artifacts.test/${name}.git`, defaultBranch: "main" }; },
        async createToken() { return { plaintext: `tok-${name}`, id: `id-${name}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }; },
        [Symbol.dispose]() {},
      };
    },
  };
  const bindings = { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as unknown as typeof env;
  const call = (token: string, actor: string, path: string, body: unknown, runner?: string) => worker.fetch(new Request(`https://atelier.test/api/projects/${project}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, "content-type": "application/json", ...(runner ? { "x-atelier-runner": runner } : {}) }, body: JSON.stringify(body),
  }), bindings);
  const minted = await worker.fetch(new Request("https://atelier.test/api/tokens", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify({ actor: GPT, projects: [project] }),
  }), bindings);
  expect(minted.status).toBe(201);
  const token = ((await minted.json()) as { token: string }).token;
  const res = await call(token, GPT, `/items/${t2}/review-claim`, {}, RUNNER.runner);
  expect(res.status, await res.clone().text()).toBe(200);
  const c = (await res.json()) as ReviewClaim;
  expect(c.prereview?.binding.main).toBe(MAIN);
  // The baseline moves, as atelier sync pushes it, with no merge recorded.
  baseline = "e".repeat(40);
  const posted = await call(token, GPT, `/items/${t2}/review`, { head: c.head, criteria: c.criteria, request: c.request, approve: false, note: "It breaks.", findings: envelope([BLOCKING]) });
  expect(posted.status, await posted.clone().text()).toBe(200);
  expect((await views(L, t2))[0]).toMatchObject({ state: "stale", detail: expect.stringMatching(/main moved to eeeeeeee since the tree was prepared from cccccccc/) });
  expect(await queueIds(L)).toContain(t2);
  expect((await L.detail(t2) as unknown as { prereviewFence: unknown }).prereviewFence).toBeNull();
});

// Remaining rework at d5b253c8: owner standing and main's actual identity.
for (const [label, change] of [
  ["paused", { state: "paused" }],
  ["reserved", { state: "reserved" }],
  ["build-only", { roles: ["build"] }],
] as [string, Partial<ModelEntry>][]) {
  it(`withdraws open pre-reviews when their reviewer becomes ${label}`, async () => {
    const { L, t2 } = await landing(`pre-standing-${label}`);
    const pool = [entry("opus-5.5", "claude-code"), { ...entry("gpt-6-astra", "codex"), ...change }];
    await L.poolChanged(pool);
    expect((await views(L, t2))[0]).toMatchObject({ state: "withdrawn", detail: expect.stringMatching(/paused|reserved|not a reviewer/) });
    expect((await L.queued()).reviews.filter((r) => r.id === t2)).toEqual([]);
    expect(await queueIds(L)).toContain(t2);
  });

  for (const phase of ["claim", "verdict"]) {
    it(`rechecks ${label} standing at pre-review ${phase} without a pool-change sweep`, async () => {
      const { L, t2 } = await landing(`pre-standing-${label}-${phase}`);
      const c = phase === "verdict" ? await claim(L, t2) : null;
      // Another gate request refreshes standing without poolChanged.
      const other = await L.newItem("Other", [], "owner");
      await L.requestReview(other.id, "owner", OPUS, [
        entry("opus-5.5", "claude-code"),
        { ...entry("gpt-6-astra", "codex"), ...change },
      ]);
      await refusal(c ? verdict(L, t2, c, false, [BLOCKING]) : claim(L, t2), "model_held");
      expect((await views(L, t2))[0].state).toBe("withdrawn");
      expect(await queueIds(L)).toContain(t2);
      expect((await L.detail(t2) as unknown as { prereviewFence: unknown }).prereviewFence).toBeNull();
    });
  }
}

for (const workflow of [false, true]) for (const outcome of ["passed", "conflict"]) {
  it(`asks a new pre-review after main moves following a ${outcome}, without a merge event (${workflow ? "Workflow" : "CLI"})`, async () => {
    const { L, t1, t2 } = await landing(`pre-settled-main-${outcome}-${workflow}`);
    const c = await claim(L, t2);
    if (outcome === "passed") await verdict(L, t2, c, true);
    else await L.releaseReview(t2, GPT, outcomeNote({ outcome: "conflict", detail: "conflict", main: MAIN }), true, c.request);
    const generation = await L.mergeGeneration();
    await L.renewProjectLanding(t1, "owner");
    expect(await views(L, t2)).toHaveLength(1);
    const moved = "e".repeat(40);
    const instanceId = workflow ? "wf-main-moved" : undefined;
    if (instanceId) await L.setLandingWorkflow(t2, instanceId, "owner", "local");
    // Only the baseline moves: no noteMainHead or merge event informs the
    // ledger. Its normal polling path must discover the new identity.
    await runInDurableObject(L as unknown as DurableObjectStub<Ledger>, async (instance: Ledger) => {
      const internal = instance as unknown as { env: typeof env };
      const original = internal.env;
      let reads = 0;
      internal.env = { ...original, ARTIFACTS: {
        async get(name: string) {
          expect(name).toBe((await instance.project()).repo);
          return {
            async log(options: unknown) { expect(options).toEqual({ limit: 1 }); reads++; return [{ hash: moved }]; },
            [Symbol.dispose]() {},
          };
        },
      } } as unknown as typeof env;
      try {
        await instance.queueProjectLanding(t2, "owner", false, instanceId);
        expect(reads).toBe(1);
      } finally { internal.env = original; }
    });
    await L.renewProjectLanding(t1, "owner");
    expect(await L.mergeGeneration()).toBe(generation);
    const rows = await views(L, t2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: "open", attempts: 1, binding: { main: moved } });
    expect(rows[1]).toMatchObject({ state: outcome, binding: { main: MAIN } });
    const next = await claim(L, t2, GPT, moved);
    expect(next.request).not.toBe(c.request);
    await verdict(L, t2, next, true, [], { main: moved, mainNow: moved });
    await L.queueProjectLanding(t2, "owner", false, instanceId);
    expect(await views(L, t2)).toHaveLength(2);
    expect(await queueIds(L)).toContain(t2);
  });
}

// gpt-6-astra's nineteenth review of t622, finding 3: with no model offered
// for the pre-review job, the selection returned before the assignment-aware
// selector, so the unavailable result named no assignment.
it("an unavailable pre-review names the review assignment it could not apply", async () => {
  const L = await setup("pre-assigned");
  await L.assignmentsChanged({ version: 990, assignments: [{ id: "a990", kind: "assigned", scope: "*", role: "review", choices: [{ actor: GPT, model: "gpt-6-astra" }], reason: "By judgement.", quote: "q", evidence: [], by: "owner", at: AT }] });
  // A live runner advertises pre-review, offering no pool model for it.
  await offer(["build", "review", "prereview"], [{ agent: "opencode", models: ["nothing-here"] }]);
  const [t1, t2] = [await submitted(L, head(1)), await submitted(L, head(2))];
  await L.beginProjectLanding(t1, "owner");
  await L.queueProjectLanding(t2, "owner");
  const unavailable = (await events(L, t2)).find((e) => e.kind === "prereview.unavailable");
  expect(String(unavailable?.data.detail)).toMatch(/no model in the pool is offered for the prereview job by a live runner/);
  expect(String(unavailable?.data.detail)).toMatch(/Role assignment a990 skipped/);
});
