import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { mergeProject } from "../src/ledger.ts";
import type { Evidence } from "../src/rules.ts";
import { GAVE_UP } from "../src/dispatch/rules.ts";

// The project's core files (policy.coreFiles) and the queue's hold on a
// dispatch whose scope overlaps a live item's within one (coreHold in
// src/dispatch/rules.ts), driven through the Worker's routes and the Ledger.

const TOKEN = "core-files-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const A = "codex/gpt-6-astra";
const H0 = "0".repeat(40);
const H1 = "a".repeat(40);

// PUT creates the baseline in Artifacts before the Ledger write; this pool
// does not reach Artifacts, so a stand-in answers those calls.
const artifacts = {
  create: async () => ({}),
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
    [Symbol.dispose]() {},
  }),
} as unknown as Artifacts;

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...testEnv, ARTIFACTS: artifacts } as typeof env);
}

async function project(name: string, coreFiles: string[]) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], coreFiles }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}

type Queued = { project: string; item: { id: string; held?: { id: string; owner: string; state: string; core: string } } };

it("init records the core files, keeps them on a re-init, clears them with an empty list or a reset, and sets none by default", async () => {
  const policyOf = async (body: unknown) => {
    const res = await call("PUT", "/projects/core-init", body);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { project: { policy: { coreFiles?: string[] } } }).project.policy;
  };
  expect(await policyOf({ checks: ["npm test"] })).not.toHaveProperty("coreFiles");
  expect((await policyOf({ coreFiles: [" src/ledger.ts ", "cli/runner.mjs"] })).coreFiles).toEqual(["src/ledger.ts", "cli/runner.mjs"]);
  expect((await policyOf({ title: "Core" })).coreFiles).toEqual(["src/ledger.ts", "cli/runner.mjs"]);
  expect(await policyOf({ coreFiles: [] })).not.toHaveProperty("coreFiles");
  await policyOf({ coreFiles: ["src/ledger.ts"] });
  expect(await policyOf({ reset: true, checks: ["npm test"] })).not.toHaveProperty("coreFiles");
  const bad = await call("PUT", "/projects/core-init", { coreFiles: [""] });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("bad_list");

  const base = { name: "m", repo: "m", reset: false };
  const first = mergeProject(null, base, "now");
  expect(first.policy).not.toHaveProperty("coreFiles");
  const set = mergeProject(first, { ...base, coreFiles: ["src/**"] }, "later");
  expect(mergeProject(set, base, "later").policy.coreFiles).toEqual(["src/**"]);
  expect(mergeProject(set, { ...base, reset: true }, "later").policy).not.toHaveProperty("coreFiles");
});

it("the queue holds core overlaps during building and landing, but offers them while awaiting landing", async () => {
  const name = "core-queue";
  const L = await project(name, ["src/ledger.ts"]);
  const live = await L.newItem("Live work", ["src/**"], "owner");
  await L.claim(live.id, A);
  await L.setFork(live.id, `${name}--${live.id}`, H0, A);
  const create = async (title: string, scope: string[]) => ((await (await call("POST", `/projects/${name}/items`, { title, scope })).json()) as { id: string }).id;
  const core = await create("Core edit", ["src/ledger.ts"]);
  const elsewhere = await create("Non-core overlap", ["src/index.ts"]);
  const allowed = await create("Core edit, owner allows", ["src/ledger.ts"]);
  for (const [id, body] of [[core, {}], [elsewhere, {}], [allowed, { overlapOk: true }]] as const) {
    const sent = await call("POST", `/projects/${name}/items/${id}/dispatch`, { to: "home", agent: "opencode", ...body });
    expect(sent.status, await sent.clone().text()).toBe(200);
  }
  const offer = { runner: "home:studio", agents: [{ agent: "opencode", models: ["glm-5.3-flash"] }] };
  const offered = async () => ((await (await call("POST", "/queue", offer)).json()) as Queued[]).filter((q) => q.project === name).map((q) => q.item.id).sort();
  const listed = async () => ((await (await call("GET", "/queue")).json()) as Queued[]).filter((q) => q.project === name);

  // The runner is offered the non-core overlap and the overridden dispatch, not the held one.
  expect(await offered()).toEqual([allowed, elsewhere].sort());
  const owner = await listed();
  expect(owner.find((q) => q.item.id === core)?.item.held).toMatchObject({ id: live.id, owner: A, state: "claimed", core: "src/ledger.ts" });
  expect(owner.filter((q) => q.item.held).map((q) => q.item.id)).toEqual([core]);

  // Submission and acceptance release the hold until a landing lease is acquired.
  await L.recordPush(live.id, A, H1, H1);
  const evidence: Evidence = { itemId: live.id, claim: "npm test", grade: "observed", head: H1, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a.ts"] };
  await L.addEvidence(evidence);
  await L.submit(live.id, A);
  expect(await offered()).toContain(core);
  await L.accept(live.id, "owner");
  expect(await offered()).toContain(core);
  expect((await listed()).some((q) => q.item.held)).toBe(false);
  await L.beginProjectLanding(live.id, "owner");
  expect(await offered()).not.toContain(core);
  expect((await listed()).find((q) => q.item.id === core)?.item.held).toMatchObject({ id: live.id, state: "accepted" });
  await L.merged(live.id, "owner", "f".repeat(40), true);
  expect(await offered()).toContain(core);
  expect((await listed()).some((q) => q.item.held)).toBe(false);
});

// 2026-10-12: a runner gave up on t396 and kept its claim, so its core-file
// hold stopped fifteen dispatches for three hours with nobody working (t584).
// Its release now carries the runner's word, and the hold lifts with it.
it("a claim a runner gives up lifts the core-file hold at once and reaches the inbox until the task is taken again", async () => {
  const name = "core-gave-up";
  const L = await project(name, ["src/ledger.ts"]);
  const live = await L.newItem("Merge main", ["src/**"], "owner");
  await L.claim(live.id, A);
  const waiting = await L.newItem("Core edit", ["src/ledger.ts"], "owner");
  await L.dispatch(waiting.id, "owner", { to: "home", agent: "opencode" });
  expect((await L.waiting()).find((i) => i.id === waiting.id)?.held).toMatchObject({ id: live.id, state: "claimed" });
  const gone = await L.dispatch(live.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra", overlapOk: true });
  expect(gone.state).toBe("open");
  await L.claim(live.id, A, { runner: "home:studio", kind: "home" });
  expect((await L.waiting()).find((i) => i.id === waiting.id)?.held).toBeDefined();

  await L.release(live.id, A, `${GAVE_UP}the merge failed twice (its commits are pushed)`);
  expect((await L.waiting()).find((i) => i.id === waiting.id)?.held).toBeUndefined();
  const entry = (await L.inbox(new Date().toISOString())).find((e) => e.itemId === live.id);
  expect(entry).toMatchObject({ kind: "gave-up" });
  expect(entry?.reason).toBe(`the merge failed twice (its commits are pushed); run \`atelier dispatch ${live.id}\` to send it out again`);
  // A release that does not start with the runner's word is no give-up, and a new claim ends one.
  await L.claim(live.id, A, { runner: "home:studio", kind: "home" });
  expect((await L.inbox(new Date().toISOString())).some((e) => e.kind === "gave-up")).toBe(false);
  await L.release(live.id, A, "handing back");
  expect((await L.inbox(new Date().toISOString())).some((e) => e.kind === "gave-up")).toBe(false);
});

// Review of t584, round 2: a stall releases the task with an ordinary note, and
// only the second stall makes the runner give up, so the give-up has no release
// of its own to carry the reason.
it("a give-up reported for a task the runner already released reaches the inbox once, with its reason", async () => {
  const name = "core-gave-up-late";
  const L = await project(name, ["src/ledger.ts"]);
  const item = await L.newItem("Stalls", ["docs/**"], "owner");
  await L.dispatch(item.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await L.claim(item.id, A, { runner: "home:studio", kind: "home" });
  await L.release(item.id, A, "harness made no new commit");
  expect((await L.inbox(new Date().toISOString())).some((e) => e.kind === "gave-up")).toBe(false);
  expect(await L.recordRunSkip(item.id, "home:studio", A, "failures", 2, "harness made no new commit")).toBe(true);
  await L.recordRunSkip(item.id, "home:studio", A, "failures", 2, "harness made no new commit");
  const entries = (await L.inbox(new Date().toISOString())).filter((e) => e.kind === "gave-up");
  expect(entries.map((e) => e.reason)).toEqual([`harness made no new commit; run \`atelier dispatch ${item.id}\` to send it out again`]);
  const events = (await L.events(item.id)) as unknown as { kind: string }[];
  expect(events.filter((e) => e.kind === "item.gave_up")).toHaveLength(1);
});
