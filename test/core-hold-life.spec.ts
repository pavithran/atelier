import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { Evidence } from "../src/rules.ts";

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

// The runner token's claim, the other half of the path: a poll offers both
// tasks before the holder claims; the holder then claims and submits, and the
// waiting task's claim is answered 409 held, naming the holder and its stage.
// With overlapOk the same claim succeeds.
for (const overlapOk of [false, true]) it(`claim: a runner's claim of an overlapping task after the holder submitted is ${overlapOk ? "allowed by overlapOk" : "answered 409 held"}`, async () => {
  const name = `hold-life-claim-${overlapOk}`;
  const L = await project(name);
  const holder = await L.newItem("Holder", ["src/ledger.ts"], "owner");
  const waiting = await L.newItem("Waiting", ["src/ledger.ts"], "owner");
  const agents = [{ agent: "codex", models: ["gpt-6-astra"] }];
  for (const [id, extra] of [[holder.id, {}], [waiting.id, overlapOk ? { overlapOk: true } : {}]] as const) await L.dispatch(id, "owner", { agent: "codex", model: "gpt-6-astra", ...extra });
  const runner = `home:${name}`;
  const issued = await call("POST", "/tokens", { runner, projects: [name] });
  const { token } = await issued.json() as { token: string };
  const asRunner = (path: string, body: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-atelier-actor": A, "content-type": "application/json" }, body: JSON.stringify(body) }), testEnv);
  expect((await asRunner("/queue", { runner, agents, jobs: ["build"] })).status).toBe(200);
  await L.claim(holder.id, A, { runner: "home:other", kind: "home" });
  await submit(L, holder.id);
  const res = await asRunner(`/projects/${name}/items/${waiting.id}/claim`, {});
  const answer = await res.json() as { error?: string; detail?: string };
  // The claim then reaches the repository step, which this pool cannot serve
  // (RepoError, 500); what matters here is that no hold or refusal stops it.
  if (overlapOk) { expect(answer.error).not.toBe("held"); expect(answer.error).not.toBe("runner_forbidden"); return; }
  expect(res.status, JSON.stringify(answer)).toBe(409);
  expect(answer.error).toBe("held");
  expect(answer.detail).toContain(`${holder.id} (submitted by ${A}): both scopes reach core file src/ledger.ts`);
  expect(answer.detail).not.toContain("running on");
});
