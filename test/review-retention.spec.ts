import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { world } from "./helpers/retention-world.ts";
import { gate, parseRuleError, type Evidence, type Item, type ProjectPolicy, type Review, type RetentionFacts, type RetentionRead } from "../src/rules.ts";

// An approval kept across a merge of main (t56): the Ledger's side of the
// rule, against its real storage. The finding it would have caught is the one
// src/refresh/review.ts named: every merge of main, by a push, a landing or a
// refresh, asked a second review of a head whose task files main never
// touched. What the Worker reads of a merge (src/retention.ts) is judged by
// retentionVerdict and tested in test/retention.test.ts and test/rules.test.ts;
// here the facts are given, and the tests pin what the Ledger does with the
// verdict: where it carries, what it records, and what it never carries.

const H0 = "0".repeat(40), H1 = "1".repeat(40), H2 = "2".repeat(40), M1 = "a".repeat(40), M2 = "b".repeat(40), R1 = "c".repeat(40), R2 = "d".repeat(40);
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GEMINI = "agy/gemini-4-argon";
const INTEGRATOR = "atelier/integrator";
const PROTECTED: Partial<ProjectPolicy> = { protected: ["src/**"] };

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
type L = ReturnType<typeof ledger>;

async function setup(name: string, policy: Partial<ProjectPolicy> = PROTECTED) {
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [], ...policy }, createdAt: new Date().toISOString() };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}

const events = async (L: L, id: string) => (await L.events(id)) as unknown as LedgerEvent[];
const reviewsOf = async (L: L, id: string) => (await L.reviewsFor(id)) as unknown as Review[];
const passed = (id: string, head: string): Evidence => ({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
const at = () => new Date().toISOString();

// A merge of main (M1) into the approved head (H1) that leaves the task's files alone.
const merge = (over: Partial<RetentionFacts> = {}, head = R1, from = H1, main = M1): RetentionFacts => ({
  oldHead: from, newHead: head, parents: [from, main], main, base: H0,
  task: ["src/a.ts"], incoming: ["docs/b.md"], moved: ["docs/b.md"], offMain: ["src/a.ts"], outputs: [], ...over,
});

// A task built to H1 by OPUS, checked, submitted and approved by `by` unless nobody is named.
async function approved(L: L, title: string, by: string | null = GPT, to: "submitted" | "accepted" = "submitted", head = H1, holder = OPUS) {
  const { id } = await L.newItem(title, ["src/**"], "owner");
  await L.claim(id, holder);
  await L.setFork(id, `fork-${crypto.randomUUID().slice(0, 8)}-${id}`, H0, holder);
  await L.recordPush(id, holder, head, head);
  await L.addEvidence(passed(id, head));
  await L.submit(id, holder);
  if (by) await L.addReview({ itemId: id, by, head, criteria: await L.criteria(id), approve: true, note: "Judged against the criteria.", at: at() }, undefined, true);
  if (to === "accepted") await L.accept(id, "owner");
  return id;
}
const push = (L: L, id: string, head: string, read: RetentionRead | null, authors: { commit: string; actor: string }[] = []) =>
  L.recordPush(id, OPUS, head, head, true, { holdsRecorded: true, rebasedFrom: null }, authors, false, read);
const gateOf = async (L: L, id: string) => ((await L.detail(id)) as unknown as { gate: { ready: boolean; blockers: string[] } }).gate;
const retainedAt = async (L: L, id: string, head: string) => (await reviewsOf(L, id)).filter((r) => r.head === head && r.retained);

it("a push of a merge that leaves the task's files alone carries the approval, with the original kept and the checks asked again", async () => {
  const L = await setup("rr-push");
  const id = await approved(L, "Pushed");
  expect((await gateOf(L, id)).ready).toBe(true);
  await push(L, id, R1, merge());
  const reviews = await reviewsOf(L, id);
  const original = reviews.find((r) => r.head === H1)!;
  expect(original).toMatchObject({ by: GPT, approve: true });
  expect(original.retained).toBeUndefined();
  const carried = reviews.filter((r) => r.head === R1);
  expect(carried).toHaveLength(1);
  expect(carried[0]).toMatchObject({ by: GPT, approve: true, criteria: original.criteria, proved: true, retained: { from: { by: GPT, head: H1, at: original.at }, oldHead: H1, newHead: R1, main: M1, base: H0, taskPaths: ["src/a.ts"], incomingPaths: ["docs/b.md"], exempt: [] } });
  expect(carried[0].retained!.reason).toMatch(/only main's changes to files the task does not change/);
  const event = (await events(L, id)).find((e) => e.kind === "review.retained")!;
  expect(event.data).toMatchObject({ by: GPT, from: H1, head: R1, main: M1, base: H0, taskPaths: ["src/a.ts"] });
  // The required checks are the new head's own: the approval stands, the gate waits for them.
  expect((await gateOf(L, id)).blockers.join(" ")).toMatch(/`npm test` not yet observed at this head/);
  await L.addEvidence(passed(id, R1));
  expect((await gateOf(L, id)).ready).toBe(true);
  expect((await events(L, id)).filter((e) => e.kind === "review.requested")).toEqual([]);
});

it("a push seen on the fork carries it the same way", async () => {
  const L = await setup("rr-observe");
  const id = await approved(L, "Observed");
  await L.observePush(id, R1, H1, true, [], false, merge());
  expect(await retainedAt(L, id, R1)).toHaveLength(1);
  await L.addEvidence(passed(id, R1));
  expect((await gateOf(L, id)).ready).toBe(true);
});

it("an accepted task's acceptance never carries, while its approval does; a refresh reports it", async () => {
  const L = await setup("rr-refresh");
  const id = await approved(L, "Refreshed", GPT, "accepted");
  await L.noteMainHead(M1);
  const lease = (await L.leaseRefresh(id, INTEGRATOR, "home:studio", "refresh")).lease;
  const report = { lease: lease.id, mainHead: lease.mainHead, expectedHead: lease.expectedHead };
  await L.refreshPushing(id, INTEGRATOR, { ...report, head: R1 });
  const done = await L.taskRefreshed(id, INTEGRATOR, { ...report, head: R1, agent: INTEGRATOR, retention: merge({}, R1, H1, M1) }, true);
  expect(done.item).toMatchObject({ head: R1, state: "submitted", acceptedHead: null });
  expect(await retainedAt(L, id, R1)).toHaveLength(1);
  const refreshed = (await events(L, id)).find((e) => e.kind === "item.refreshed")!;
  expect(refreshed.data).toMatchObject({ approvalInvalidated: true });
  expect(String(refreshed.data.review)).toMatch(/does not authorize this one.*only main's changes.*approvals given before it stand at the refreshed head and the required checks run again/);
  await L.addEvidence({ ...passed(id, R1), by: INTEGRATOR });
  await L.refreshChecked(id, INTEGRATOR, { ...report, passed: true, reason: "" });
  expect((await gateOf(L, id)).ready).toBe(true);
  expect((await events(L, id)).filter((e) => e.kind === "review.requested")).toEqual([]);
});

const asksReview = async (L: L, id: string, head: string, why: RegExp) => {
  expect(await retainedAt(L, id, head)).toEqual([]);
  expect((await events(L, id)).find((e) => e.kind === "review.not_retained")?.data).toMatchObject({ head, from: H1, approvals: [GPT], reason: expect.stringMatching(why) });
  await L.addEvidence(passed(id, head));
  expect((await gateOf(L, id)).ready).toBe(false);
};

it("an overlap, a rename, a deletion, an unreadable merge, a resolver's edit and another actor's commits each ask for review", async () => {
  const cases: [string, RetentionRead | null, RegExp, { commit: string; actor: string }[]?][] = [
    ["overlap", merge({ incoming: ["src/a.ts"], moved: ["src/a.ts"] }), /main changed src\/a\.ts, which the task also changes/],
    ["rename", merge({ task: ["src/old.ts", "src/new.ts"], incoming: ["src/old.ts"], moved: ["src/old.ts"] }), /main changed src\/old\.ts/],
    ["deletion", merge({ task: ["src/a.ts"], incoming: ["src/a.ts"], moved: [] }), /main changed src\/a\.ts/],
    ["extra edit", merge({ moved: ["docs/b.md", "src/sneaked.ts"] }), /the merge changed src\/sneaked\.ts, which main did not/],
    ["unreadable", { unread: "Artifacts is down" }, /could not be read \(Artifacts is down\)/],
    ["fixtures alone", merge({ task: ["test/fixtures/x.txt"], incoming: ["test/fixtures/x.txt"], moved: ["test/fixtures/x.txt"], outputs: [] }), /main changed test\/fixtures\/x\.txt/],
    ["new contributor", merge(), /another actor than the task's holder/, [{ commit: R1, actor: GPT }]],
  ];
  for (const [name, read, why, authors] of cases) {
    const L = await setup(`rr-no-${name.replaceAll(" ", "-")}`);
    const id = await approved(L, name);
    await push(L, id, R1, read, authors);
    await asksReview(L, id, R1, why);
  }
});

it("a resolver's merge asks for review, the resolver among the contributors", async () => {
  const L = await setup("rr-resolver", { resolvers: [GPT], protected: [] });
  const id = await approved(L, "Resolved", "agy/gemini-4-argon");
  await L.noteMainHead(M1);
  const first = (await L.leaseRefresh(id, INTEGRATOR, null, "refresh")).lease;
  await L.taskRefreshFailed(id, INTEGRATOR, { lease: first.id, mainHead: first.mainHead, expectedHead: first.expectedHead, outcome: "mechanical", reason: "imports" }, [{ runner: "home:gpt", kind: "home", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["task-resolve"], at: at() }]);
  const lease = (await L.leaseRefresh(id, GPT, "home:gpt", "resolve")).lease;
  const report = { lease: lease.id, mainHead: lease.mainHead, expectedHead: lease.expectedHead };
  await L.refreshPushing(id, GPT, { ...report, head: R1 });
  await L.taskRefreshed(id, GPT, { ...report, head: R1, agent: GPT, transformations: ["import-union"], retention: merge() }, true);
  expect(await retainedAt(L, id, R1)).toEqual([]);
  const reason = String((await events(L, id)).find((e) => e.kind === "review.not_retained")?.data.reason);
  expect(reason).toMatch(/codex\/gpt-6-astra resolved conflicts in the merge/);
  expect(String((await events(L, id)).find((e) => e.kind === "item.refreshed")?.data.review)).toMatch(/codex\/gpt-6-astra resolved conflicts/);
  expect((await L.item(id)).pushActors).toContain(GPT);
});

it("criteria that changed, an approval withdrawn, a rejection beside it and an approval already carried each carry nothing", async () => {
  // Changed criteria withdraw the approval for good, even if the criteria return to what it judged.
  const changed = await setup("rr-criteria");
  const a = await approved(changed, "Criteria");
  await changed.editItem(a, "owner", { accept: ["A different criterion"] });
  await push(changed, a, R1, merge());
  expect(await retainedAt(changed, a, R1)).toEqual([]);
  expect((await events(changed, a)).filter((e) => e.kind === "review.not_retained")).toEqual([]);
  expect(await changed.retainable(a)).toBe(0);
  // A rejection standing at the head keeps every approval from being carried past it.
  const rejected = await setup("rr-rejected");
  const r = await approved(rejected, "Rejected");
  await rejected.addReview({ itemId: r, by: GEMINI, head: H1, criteria: await rejected.criteria(r), approve: false, note: "No.", at: at() }, undefined, true);
  await push(rejected, r, R1, merge());
  expect(await retainedAt(rejected, r, R1)).toEqual([]);
  // A second merge of main asks for review: an approval is carried once.
  const repeated = await setup("rr-repeated");
  const p = await approved(repeated, "Repeated");
  await push(repeated, p, R1, merge());
  expect(await retainedAt(repeated, p, R1)).toHaveLength(1);
  await push(repeated, p, R2, merge({}, R2, R1, M2));
  expect(await retainedAt(repeated, p, R2)).toEqual([]);
  await repeated.addEvidence(passed(p, R2));
  expect((await gateOf(repeated, p)).ready).toBe(false);
  expect(await repeated.retainable(p)).toBe(0);
});

it("an ordinary push, or a push read with nothing, carries nothing and says nothing", async () => {
  const L = await setup("rr-ordinary");
  const id = await approved(L, "Ordinary");
  await push(L, id, H2, null);
  expect(await retainedAt(L, id, H2)).toEqual([]);
  await push(L, id, R1, { ...merge({}, R1, H2), parents: [H2] });
  expect(await retainedAt(L, id, R1)).toEqual([]);
  expect((await events(L, id)).filter((e) => e.kind === "review.not_retained" || e.kind === "review.retained")).toEqual([]);
});

it("a carried approval counts only while its reviewer is authorized and independent of the contributors at the new head", async () => {
  const L = await setup("rr-count");
  const id = await approved(L, "Counted");
  await push(L, id, R1, merge());
  await L.addEvidence(passed(id, R1));
  const item = await L.item(id) as Item;
  const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };
  const evidence = (await L.evidenceFor(id)) as unknown as Evidence[];
  const reviews = await reviewsOf(L, id);
  expect(gate(item, policy, evidence, reviews).ready).toBe(true);
  // The reviewer's family joined the contributors: the carried approval no longer counts.
  const joined = gate({ ...item, pushActors: [OPUS, "codex/gpt-6"] }, policy, evidence, reviews);
  expect(joined.ready).toBe(false);
  expect(joined.blockers.join(" ")).toMatch(/needs approval from a model of another family than every contributor/);
  // One approval per model: a second carried row of the same model is one approval.
  const doubled = gate(item, { ...policy, riskReviews: { core: ["src/**"], reviews: { "docs-or-tests": 0, other: 1, core: 2 } } }, evidence, [...reviews, ...reviews.filter((r) => r.retained)]);
  expect(doubled.ready).toBe(false);
});

// ── through the routes, on a stand-in for the two repositories ──────────────
// The Worker reads the merge itself (retentionOf in src/index.ts) before the
// Ledger records the head, so these run a push, a push seen on the fork and a
// refresh through their routes over trees that can overlap or not.

const TOKEN = "review-retention-token";

// The approved head O, main's commit M and the merge N of the two, in the
// two repositories; with `overlap`, main and the task both change src/a.ts.
function repos(name: string, overlap: boolean, agent = INTEGRATOR) {
  const w = world();
  const base = { "src/a.ts": "a\n", "docs/b.md": "b\n" };
  const b0 = w.commit("b0", base);
  const m = w.commit("m", overlap ? { ...base, "src/a.ts": "a\nmain's line\n" } : { ...base, "docs/b.md": "b changed\n" }, [b0]);
  const o = w.commit("o", { ...base, "src/a.ts": overlap ? "task's line\na\n" : "a changed\n" }, [b0]);
  const n = w.commit("n", overlap ? { ...base, "src/a.ts": "task's line\na\nmain's line\n" } : { "src/a.ts": "a changed\n", "docs/b.md": "b changed\n" }, [o, m], `Merge main\n\nAgent: ${agent}`);
  const ARTIFACTS = { get: async (repo: string) => Object.assign(repo === `${name}--baseline` ? w.repo(m) : w.repo(n), { [Symbol.dispose]() {} }) } as unknown as Artifacts;
  return { o, m, n, ARTIFACTS };
}
const call = (name: string, path: string, actor: string, body: unknown, ARTIFACTS: Artifacts) =>
  worker.fetch(new Request(`https://atelier.test/api/projects/${name}/${path}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS } as typeof env);

for (const overlap of [false, true]) {
  it(`the push route reads the merge and ${overlap ? "asks for review when main changed the task's file" : "carries the approval when main left the task's files alone"}`, async () => {
    const name = `rr-route-push-${overlap}`;
    const L = await setup(name);
    const { o, m, n, ARTIFACTS } = repos(name, overlap);
    const id = await approved(L, "Pushed through the route", GPT, "submitted", o);
    const res = await call(name, `items/${id}/push`, OPUS, { head: n }, ARTIFACTS);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await L.item(id)).head).toBe(n);
    const carried = await retainedAt(L, id, n);
    if (overlap) {
      expect(carried).toEqual([]);
      expect((await events(L, id)).find((e) => e.kind === "review.not_retained")?.data.reason).toMatch(/main changed src\/a\.ts, which the task also changes/);
    } else {
      expect(carried).toHaveLength(1);
      expect(carried[0].retained).toMatchObject({ oldHead: o, newHead: n, main: m, taskPaths: ["src/a.ts"], incomingPaths: ["docs/b.md"] });
    }
  });

  it(`a push seen on the fork is read the same way (${overlap ? "overlap" : "disjoint"})`, async () => {
    const name = `rr-route-queue-${overlap}`;
    const record = { name, repo: `${name}--baseline`, branch: "main", policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: at() };
    const L = ledger(name);
    await L.setProject(record, "owner");
    await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
    const { o, n, ARTIFACTS } = repos(name, overlap);
    const id = await approved(L, "Seen on the fork", GPT, "submitted", o);
    let acked = 0;
    const notice = { type: "cf.artifacts.repo.pushed", source: { namespace: "atelier", repoName: (await L.item(id)).fork }, payload: { ref: "refs/heads/main", after: n } };
    await worker.queue({ messages: [{ body: notice, ack: () => { acked++; }, retry: () => { throw new Error("retried"); } }] } as unknown as MessageBatch<unknown>, { ...env, ARTIFACTS } as typeof env);
    expect(acked).toBe(1);
    expect((await L.item(id)).head).toBe(n);
    expect(await retainedAt(L, id, n)).toHaveLength(overlap ? 0 : 1);
  });

  it(`the refreshed route reads the merge the leaseholder pushed (${overlap ? "overlap" : "disjoint"})`, async () => {
    const name = `rr-route-refresh-${overlap}`;
    const L = await setup(name);
    const { o, m, n, ARTIFACTS } = repos(name, overlap);
    const id = await approved(L, "Refreshed through the route", GPT, "submitted", o);
    await L.noteMainHead(m);
    const lease = (await L.leaseRefresh(id, INTEGRATOR, "home:studio", "refresh")).lease;
    const res = await call(name, `items/${id}/refreshed`, INTEGRATOR, { lease: lease.id, mainHead: lease.mainHead, expectedHead: lease.expectedHead, head: n }, ARTIFACTS);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await retainedAt(L, id, n)).toHaveLength(overlap ? 0 : 1);
    expect(String((await events(L, id)).find((e) => e.kind === "item.refreshed")?.data.review)).toMatch(overlap ? /main changed src\/a\.ts/ : /approvals given before it stand/);
  });
}

it("a repository that cannot be opened for the read carries nothing, and the refresh is still recorded", async () => {
  const name = "rr-route-down";
  const L = await setup(name);
  const { o, m, n, ARTIFACTS: ok } = repos(name, false);
  const id = await approved(L, "Down", GPT, "submitted", o);
  // The route's own read of the fork opens the first repository; the retention read opens the next two.
  let opened = 0;
  const ARTIFACTS = { get: async (repo: string) => { if (++opened > 2) throw new Error("Artifacts is down"); return ok.get(repo); } } as unknown as Artifacts;
  await L.noteMainHead(m);
  const lease = (await L.leaseRefresh(id, INTEGRATOR, "home:studio", "refresh")).lease;
  const res = await call(name, `items/${id}/refreshed`, INTEGRATOR, { lease: lease.id, mainHead: lease.mainHead, expectedHead: lease.expectedHead, head: n }, ARTIFACTS);
  expect(res.status, await res.clone().text()).toBe(200);
  expect((await L.item(id)).head).toBe(n);
  expect(await retainedAt(L, id, n)).toEqual([]);
  expect((await events(L, id)).find((e) => e.kind === "review.not_retained")?.data.reason).toMatch(/the merge could not be read \(the repositories could not be read\)/);
});

it("a push event that recorded the head before the refresh report leaves the refresh to say what was carried", async () => {
  const name = "rr-route-first";
  const record = { name, repo: `${name}--baseline`, branch: "main", policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: at() };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const { o, m, n, ARTIFACTS } = repos(name, false);
  const id = await approved(L, "Event first", GPT, "submitted", o);
  await L.noteMainHead(m);
  const lease = (await L.leaseRefresh(id, INTEGRATOR, "home:studio", "refresh")).lease;
  await L.refreshPushing(id, INTEGRATOR, { lease: lease.id, mainHead: lease.mainHead, expectedHead: lease.expectedHead, head: n });
  const notice = { type: "cf.artifacts.repo.pushed", source: { namespace: "atelier", repoName: (await L.item(id)).fork }, payload: { ref: "refs/heads/main", after: n } };
  await worker.queue({ messages: [{ body: notice, ack: () => {}, retry: () => { throw new Error("retried"); } }] } as unknown as MessageBatch<unknown>, { ...env, ARTIFACTS } as typeof env);
  // The head is recorded by the event, but a refresh lease is held, so the report decides.
  expect((await L.item(id)).head).toBe(n);
  expect(await retainedAt(L, id, n)).toEqual([]);
  const res = await call(name, `items/${id}/refreshed`, INTEGRATOR, { lease: lease.id, mainHead: lease.mainHead, expectedHead: lease.expectedHead, head: n }, ARTIFACTS);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await retainedAt(L, id, n)).toHaveLength(1);
  expect(String((await events(L, id)).find((e) => e.kind === "item.refreshed")?.data.review)).toMatch(/approvals given before it stand/);
});

it("nothing is carried from a task with no approval, no head, or a closed state", async () => {
  const L = await setup("rr-none");
  const fresh = (await L.newItem("Fresh", ["src/**"], "owner")).id;
  expect(await L.retainable(fresh)).toBe(0);
  const unreviewed = await approved(L, "Unreviewed", null);
  expect(await L.retainable(unreviewed)).toBe(0);
  const done = await approved(L, "Abandoned");
  expect(await L.retainable(done)).toBe(1);
  await L.abandon(done, "owner", "no longer wanted");
  expect(await L.retainable(done)).toBe(0);
});

// Finding of gpt-6-astra's review of 82b94f7a: the saved review cut the
// compared paths to fifty, so a larger merge had no complete record.
it("the carried approval records every compared path of a large merge; the event keeps a capped summary and the count", async () => {
  const L = await setup("rr-large");
  const id = await approved(L, "Large");
  const task = Array.from({ length: 70 }, (_, i) => `src/t${String(i).padStart(3, "0")}.ts`);
  const incoming = Array.from({ length: 80 }, (_, i) => `docs/m${String(i).padStart(3, "0")}.md`);
  await push(L, id, R1, merge({ task, incoming, moved: incoming, offMain: task }));
  const [carried] = await retainedAt(L, id, R1);
  expect(carried.retained!.taskPaths).toEqual(task);
  expect(carried.retained!.incomingPaths).toEqual(incoming);
  expect(carried.retained!.paths).toEqual({ task: 70, incoming: 80 });
  const data = (await events(L, id)).find((e) => e.kind === "review.retained")!.data as { taskPaths: string[]; incomingPaths: string[]; paths: unknown };
  expect(data.taskPaths).toHaveLength(50);
  expect(data.incomingPaths).toHaveLength(50);
  expect(data.paths).toEqual({ task: 70, incoming: 80 });
});

// Finding of gpt-6-astra's review of 61e1b098: a push event that arrived before
// the refresh report carried the approval with no resolver known, and when the
// resolver was also the task's holder nothing else marked the merge as theirs.
it("a merge a resolver made, who is also the task's holder, carries nothing when the push event comes before the report", async () => {
  const name = "rr-holder-resolver";
  const record = { name, repo: `${name}--baseline`, branch: "main", policy: { checks: ["npm test"], protected: [], resolvers: [GPT] }, createdAt: at() };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const { o, m, n, ARTIFACTS } = repos(name, false, GPT);
  const id = await approved(L, "Holder resolves", GEMINI, "submitted", o, GPT);
  await L.noteMainHead(m);
  const first = (await L.leaseRefresh(id, INTEGRATOR, null, "refresh")).lease;
  await L.taskRefreshFailed(id, INTEGRATOR, { lease: first.id, mainHead: first.mainHead, expectedHead: first.expectedHead, outcome: "mechanical", reason: "imports" }, [{ runner: "home:gpt", kind: "home", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["task-resolve"], at: at() }]);
  const lease = (await L.leaseRefresh(id, GPT, "home:gpt", "resolve")).lease;
  const body = { lease: lease.id, mainHead: lease.mainHead, expectedHead: lease.expectedHead, head: n };
  await L.refreshPushing(id, GPT, body);
  const notice = { type: "cf.artifacts.repo.pushed", source: { namespace: "atelier", repoName: (await L.item(id)).fork }, payload: { ref: "refs/heads/main", after: n } };
  await worker.queue({ messages: [{ body: notice, ack: () => {}, retry: () => { throw new Error("retried"); } }] } as unknown as MessageBatch<unknown>, { ...env, ARTIFACTS } as typeof env);
  expect((await L.item(id)).head).toBe(n);
  expect(await retainedAt(L, id, n)).toEqual([]);
  const res = await call(name, `items/${id}/refreshed`, GPT, body, ARTIFACTS);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await retainedAt(L, id, n)).toEqual([]);
  expect((await events(L, id)).find((e) => e.kind === "review.not_retained")?.data.reason).toMatch(/codex\/gpt-6-astra resolved conflicts in the merge/);
});
