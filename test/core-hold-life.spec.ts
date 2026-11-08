import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { Evidence } from "../src/rules.ts";
import { reportLimits, stuckReport } from "../src/stuck/report.ts";

// The core-file hold lasts the holder's whole life (src/dispatch/core-hold.ts):
// from its first claim until it merges or is abandoned. Every test enters
// through the Ledger's dispatch and claim, and the queue the runner polls.

const TOKEN = "core-hold-life-token";
const A = "codex/gpt-6-astra";
const R = "zcode/glm-5.3";
const H1 = "a".repeat(40);
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], coreFiles: ["src/ledger.ts"] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}

type Ledger = Awaited<ReturnType<typeof project>>;
const offer = { runner: "home:studio", agents: [{ agent: "opencode", models: ["glm-5.3-flash"] }] };
type Queued = { project: string; item: { id: string; held?: { id: string; state: string } } };

// A holder of src/ledger.ts, claimed once, and a task waiting behind it.
async function pair(name: string, extra: { overlapOk?: boolean } = {}) {
  const L = await project(name);
  const holder = await L.newItem("Holder", ["src/ledger.ts"], "owner");
  await L.claim(holder.id, A);
  const waiting = await L.newItem("Waiting", ["src/ledger.ts"], "owner");
  await L.dispatch(waiting.id, "owner", { to: "home", agent: "opencode", model: "glm-5.3-flash", ...extra });
  return { L, holder: holder.id, waiting: waiting.id };
}
const heldOf = async (L: Ledger, id: string) => (await L.waiting()).find((i) => i.id === id)?.held;
const offered = async (name: string) => ((await (await call("POST", "/queue", offer)).json()) as Queued[]).filter((q) => q.project === name).map((q) => q.item.id);
const submit = async (L: Ledger, id: string) => {
  await L.recordPush(id, A, H1, H1);
  const evidence: Evidence = { itemId: id, claim: "npm test", grade: "observed", head: H1, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a.ts"] };
  await L.addEvidence(evidence);
  await L.submit(id, A);
};
const review = async (L: Ledger, id: string, approve: boolean) => L.addReview({ itemId: id, head: H1, criteria: await L.criteria(id), by: R, approve, note: "Fixture", at: new Date().toISOString(), ...(approve ? {} : { findings: [{ file: "src/a.ts", line: 1, severity: "blocking" as const, text: "wrong" }] }) }, undefined, true);

it("criterion 1: a holder that submitted still holds, and its core overlap is neither offered nor claimable", async () => {
  const name = "hold-life-submitted";
  const { L, holder, waiting } = await pair(name);
  await submit(L, holder);
  expect((await L.item(holder)).state).toBe("submitted");
  expect(await heldOf(L, waiting)).toMatchObject({ id: holder, state: "submitted", core: "src/ledger.ts" });
  expect(await offered(name)).not.toContain(waiting);
  const queued = await L.waiting();
  expect(queued.find((i) => i.id === waiting)?.held).toBeDefined();
});

it("criterion 2: the hold stands while the holder is open again after a rejection, accepted, or blocked at the round cap", async () => {
  for (const [label, move, state] of [
    ["rejected", async (L: Ledger, id: string) => { await review(L, id, false); }, "submitted"],
    ["open again", async (L: Ledger, id: string) => { await L.release(id, A, "handing back after a rejection"); }, "open"],
    ["accepted", async (L: Ledger, id: string) => { await review(L, id, true); await L.accept(id, "owner"); }, "accepted"],
    ["blocked", async (L: Ledger, id: string) => { await L.block(id, "owner", "waiting on a decision"); }, "blocked"],
  ] as const) {
    const name = `hold-life-${label.replace(" ", "-")}`;
    const { L, holder, waiting } = await pair(name);
    await submit(L, holder);
    await move(L, holder);
    expect((await L.item(holder)).state, label).toBe(state);
    expect(await heldOf(L, waiting), label).toMatchObject({ id: holder, state });
    expect(await offered(name), label).not.toContain(waiting);
  }
});

it("criterion 2: the hold stands at the round cap", async () => {
  const name = "hold-life-round-cap";
  const { L, holder, waiting } = await pair(name);
  await submit(L, holder);
  for (let n = 0; n < 3; n++) {
    const head = String(n + 1).repeat(40);
    if (n > 0) { await L.recordPush(holder, A, head, head); await L.submit(holder, A); }
    await L.addReview({ itemId: holder, head: n === 0 ? H1 : head, criteria: await L.criteria(holder), by: R, approve: false, note: "no", at: new Date().toISOString(), findings: [{ file: "src/a.ts", line: 1, severity: "blocking", text: "wrong" }] }, undefined, true);
  }
  expect((await L.item(holder)).state).toBe("blocked");
  expect(await heldOf(L, waiting)).toMatchObject({ id: holder, state: "blocked" });
});

it("criterion 3: the hold lifts when the holder merges, or is abandoned, and the next poll offers the task", async () => {
  for (const end of ["merged", "abandoned"] as const) {
    const name = `hold-life-${end}`;
    const { L, holder, waiting } = await pair(name);
    await submit(L, holder);
    expect(await offered(name)).not.toContain(waiting);
    if (end === "merged") { await review(L, holder, true); await L.accept(holder, "owner"); await L.merged(holder, "owner", "f".repeat(40), true); }
    else await L.abandon(holder, "owner", "not needed");
    expect(await heldOf(L, waiting), end).toBeUndefined();
    expect(await offered(name), end).toContain(waiting);
  }
});

it("criterion 3: an open task never claimed holds nothing, so two overlapping dispatches both go out", async () => {
  const name = "hold-life-never-claimed";
  const L = await project(name);
  const ids: string[] = [];
  for (const title of ["First", "Second"]) {
    const item = await L.newItem(title, ["src/ledger.ts"], "owner");
    await L.dispatch(item.id, "owner", { to: "home", agent: "opencode", model: "glm-5.3-flash" });
    ids.push(item.id);
  }
  expect((await L.waiting()).filter((i) => i.held)).toEqual([]);
  expect((await offered(name)).sort()).toEqual(ids.sort());
});

it("criterion 4: a dispatch with overlapOk goes out while a submitted holder overlaps it", async () => {
  const name = "hold-life-overlap-ok";
  const { L, holder, waiting } = await pair(name, { overlapOk: true });
  await submit(L, holder);
  expect(await heldOf(L, waiting)).toBeUndefined();
  expect(await offered(name)).toContain(waiting);
});

// The runner token's claim, the other half of the path. A runner token
// claims the waiting task after the holder reached `state`; a hold answers
// 409 {error: "held"} naming the holder and its stage. Past the hold the claim
// reaches the repository step, which this test pool cannot serve: it fails
// with the git reader's RepoError (code NOT_FOUND, logged; the body is a bare
// 500 "internal"), never 409 held. A hold cannot pass as that: it is a 409.
// The runner polls while both tasks are offered, as the real runner does; the
// holder then claims, and `claim()` is the waiting task's claim by that runner.
async function claimPair(name: string, extra: { overlapOk?: boolean } = {}) {
  const L = await project(name);
  const holder = await L.newItem("Holder", ["src/ledger.ts"], "owner");
  const waiting = await L.newItem("Waiting", ["src/ledger.ts"], "owner");
  await L.dispatch(holder.id, "owner", { agent: "codex", model: "gpt-6-astra" });
  await L.dispatch(waiting.id, "owner", { agent: "codex", model: "gpt-6-astra", ...extra });
  const runner = `home:${name}`;
  const { token } = await (await call("POST", "/tokens", { runner, projects: [name] })).json() as { token: string };
  const asRunner = (path: string, body: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-atelier-actor": A, "content-type": "application/json" }, body: JSON.stringify(body) }), testEnv);
  expect((await asRunner("/queue", { runner, agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build"] })).status).toBe(200);
  await L.claim(holder.id, A, { runner: "home:other", kind: "home" });
  // The worker logs a failed claim's cause (RepoError) and answers a bare 500.
  const claim = async () => {
    const logged: string[] = [], was = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try { const res = await asRunner(`/projects/${name}/items/${waiting.id}/claim`, {}); return { res, answer: await res.json() as { error?: string; detail?: string }, logged: logged.join("\n") }; }
    finally { console.error = was; }
  };
  return { L, holder: holder.id, waiting: waiting.id, claim };
}
type Claimed = Awaited<ReturnType<Awaited<ReturnType<typeof claimPair>>["claim"]>>;
function expectHeld({ res, answer }: Claimed, holder: string, stage: string, label: string) {
  expect(res.status, `${label}: ${JSON.stringify(answer)}`).toBe(409);
  expect(answer.error, label).toBe("held");
  expect(answer.detail, label).toContain(`${holder} (${stage}`);
  expect(answer.detail, label).toContain("src/ledger.ts");
}
function expectPastHold({ res, answer, logged }: Claimed, label: string) {
  const text = JSON.stringify(answer);
  expect(res.status, `${label}: ${text}`).not.toBe(409);
  expect(answer.error, label).not.toBe("held");
  expect(answer.error, label).not.toBe("runner_forbidden");
  // The pool's repository step failed: the claim got there, past every check.
  expect(res.status, `${label}: ${text}`).toBe(500);
  expect(logged, label).toMatch(/RepoError code=NOT_FOUND message="repository not found/);
}
const cap = async (L: Ledger, holder: string) => {
  for (let n = 0; n < 3; n++) {
    const head = n === 0 ? H1 : String(n + 1).repeat(40);
    if (n > 0) { await L.recordPush(holder, A, head, head); await L.submit(holder, A); }
    await L.addReview({ itemId: holder, head, criteria: await L.criteria(holder), by: R, approve: false, note: "no", at: new Date().toISOString(), findings: [{ file: "src/a.ts", line: 1, severity: "blocking", text: "wrong" }] }, undefined, true);
  }
};

it("claim: a holder open again after a real rejection, accepted, or round-capped still answers 409 held", async () => {
  for (const [label, state, move] of [
    ["open again", "open", async (L: Ledger, id: string) => { await review(L, id, false); expect((await L.item(id)).state).toBe("submitted"); await L.release(id, A, "handing back after a rejection"); }],
    ["accepted", "accepted", async (L: Ledger, id: string) => { await review(L, id, true); await L.accept(id, "owner"); }],
    ["blocked", "blocked", async (L: Ledger, id: string) => { await cap(L, id); }],
  ] as const) {
    const name = `hold-life-claim-${label.replace(" ", "-")}`;
    const { L, holder, claim } = await claimPair(name);
    await submit(L, holder);
    await move(L, holder);
    expect((await L.item(holder)).state, label).toBe(state);
    expectHeld(await claim(), holder, state, label);
  }
});

it("claim: once the holder merges or is abandoned, the waiting task's claim is past the hold", async () => {
  for (const end of ["merged", "abandoned"] as const) {
    const name = `hold-life-claim-${end}`;
    const { L, holder, claim } = await claimPair(name);
    await submit(L, holder);
    expectHeld(await claim(), holder, "submitted", `${end} before`);
    if (end === "merged") { await review(L, holder, true); await L.accept(holder, "owner"); await L.merged(holder, "owner", "f".repeat(40), true); }
    else await L.abandon(holder, "owner", "not needed");
    expectPastHold(await claim(), end);
  }
});

it("claim: overlapOk lets the claim past a submitted holder", async () => {
  const name = "hold-life-claim-overlap-ok";
  const { L, holder, claim } = await claimPair(name, { overlapOk: true });
  await submit(L, holder);
  expectPastHold(await claim(), "overlapOk");
});

it("claim: a claim of a held task is answered 409 held naming the holder and its stage", async () => {
  const name = "hold-life-claim-submitted";
  const { L, holder, claim } = await claimPair(name);
  await submit(L, holder);
  const answer = await claim();
  expectHeld(answer, holder, "submitted", "submitted");
  expect(answer.answer.detail).not.toContain("running on");
});

it("stuck report: a task held by a round-capped holder gets a core-hold entry", async () => {
  const name = "hold-life-stuck-blocked";
  const { L, holder, waiting } = await pair(name);
  await submit(L, holder);
  await cap(L, holder);
  expect((await L.item(holder)).state).toBe("blocked");
  const snapshot = await runInDurableObject(L, async (instance: { stuckSnapshot(): never }) => instance.stuckSnapshot());
  const later = new Date(Date.now() + 24 * 3_600_000);
  const report = stuckReport(name, "https://atelier.test", later, reportLimits(), snapshot, [], [], []);
  const entry = report.entries.find((e: { subject: string; kind: string }) => e.subject === waiting && e.kind === "core-hold");
  expect(entry, JSON.stringify(report.entries)).toBeDefined();
  expect(entry!.reason).toContain(holder);
});
