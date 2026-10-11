import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { blockerChains, holdGraph, coreHold, holdText, makeDispatch, CORE_HOLD_WARNING_MS } from "../src/dispatch/rules.ts";
import { LANDING_LEASE_EXPIRY_MS } from "../src/landing-lease.ts";
import type { Item } from "../src/rules.ts";

const A = "codex/gpt-6-astra", TOKEN = "dispatch-hold-token";
const now = Date.now(), at = new Date(now).toISOString();
const item = (id: string, extra: Partial<Item> = {}): Item => ({ id, title: id, scope: ["src/**"], state: "open", owner: null, fork: null, base: null, head: null, acceptedHead: null, createdAt: at, updatedAt: at, lastPushAt: null, dispatch: makeDispatch({}, "owner", at), ...extra });

it("only claimed work and live landings hold core files, preserving exemptions", () => {
  const queued = item("t1"), live = item("t2", { state: "claimed", owner: A });
  const lease = { item: live.id, holder: "owner", at };
  for (const state of ["submitted", "accepted"] as const) {
    const other = { ...live, state };
    expect(coreHold(queued, [other], ["src/**"], null, now)).toBeNull();
    expect(coreHold(queued, [other], ["src/**"], lease, now)?.id).toBe(live.id);
    expect(coreHold(queued, [other], ["src/**"], lease, now + LANDING_LEASE_EXPIRY_MS)).toBeNull();
  }
  expect(coreHold(queued, [live], ["src/**"], lease, now + LANDING_LEASE_EXPIRY_MS)?.id).toBe(live.id);
  expect(coreHold({ ...queued, dispatch: { ...queued.dispatch!, overlapOk: true } }, [live], ["src/**"])).toBeNull();
  for (const job of ["plan", "review", "integrate", "refresh"] as const) expect(coreHold({ ...queued, dispatch: { ...queued.dispatch!, job } }, [live], ["src/**"])).toBeNull();
  expect(coreHold(queued, [{ ...live, kind: "plan" }], ["src/**"])).toBeNull();
  expect(coreHold({ ...queued, kind: "part", plan: "t9" }, [{ ...live, kind: "part", plan: "t9" }], ["src/**"])).toBeNull();
});

it("traverses every blocker, distinguishing convergent blocked chains from cycles", () => {
  const graph = new Map([["a", ["b", "c"]], ["b", ["d"]], ["c", ["d"]]]);
  expect(blockerChains("a", graph)).toEqual([{ path: ["a", "b", "d"], deadlock: false }, { path: ["a", "c", "d"], deadlock: false }]);
  graph.set("d", ["c"]);
  expect(blockerChains("a", graph)).toEqual([{ path: ["a", "b", "d", "c", "d"], deadlock: true }, { path: ["a", "c", "d", "c"], deadlock: true }]);
  const self = blockerChains("a", new Map([["a", ["a"]]]));
  expect(self).toEqual([{ path: ["a", "a"], deadlock: true }]);
  expect(holdText({ id: "a", owner: null, state: "open", title: "Self dependency", core: "src/**", chains: self })).toContain("deadlock: a -> a");
});

async function setup(name: string, refuseOverlap = false) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const record = { name, repo: name, createdAt: at, policy: { checks: [], protected: [], coreFiles: ["src/**"], refuseOverlap } };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  await L.newItem("First", ["src/**"], "owner");
  await L.newItem("Second", ["src/**"], "owner");
  await L.dispatch("t2", "owner", {});
  await L.claim("t1", A);
  return L;
}

it("persists hold starts, preserves them across blockers, warns at exactly 30 minutes, and resets without a poll", async () => {
  const L = await setup("dispatch-hold-age");
  const initial = (await L.waiting())[0].held!;
  expect(initial.since).toBeDefined();
  await L.newItem("Another blocker", ["src/**"], "owner");
  await L.claim("t3", A);
  await L.release("t1", A, "finished building");
  const changed = (await L.waiting())[0].held!;
  expect(changed.since).toBe(initial.since);
  expect(changed.blockers?.map((b) => b.id)).toEqual(["t3"]);
  await runInDurableObject(L, async (instance, state) => {
    const clock = Date.now;
    const start = Date.parse(initial.since!);
    try {
      Date.now = () => start + CORE_HOLD_WARNING_MS - 1;
      expect(instance.waiting()[0].held?.warning).toBe(false);
      Date.now = () => start + CORE_HOLD_WARNING_MS;
      const held = instance.waiting()[0].held!;
      expect(held.warning).toBe(true);
      expect(holdText(held)).toContain("WARNING");
      expect(holdText(held)).toContain("t3");
      expect(holdText(held)).toContain("30m 0s");
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'core-holds'").one().value).toContain(initial.since!);
    } finally { Date.now = clock; }
  });
  await L.release("t3", A, "clear");
  await L.claim("t1", A);
  expect((await L.waiting())[0].held?.since).not.toBe(initial.since);
});

it("real authenticated queue routes offer submitted/accepted work unless landing, and report claim refusal separately", async () => {
  const name = "dispatch-hold-route", L = await setup(name);
  const api = (path: string, method = "GET", body?: unknown, token = TOKEN) => worker.fetch(new Request(`https://atelier.test/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": token === TOKEN ? "owner" : A, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  const minted = await api("/tokens", "POST", { actor: A, projects: [name] });
  expect(minted.status, await minted.clone().text()).toBe(201);
  const { token } = await minted.json() as { token: string };
  const offered = async () => {
    const res = await api("/queue", "POST", { runner: "home:hold", agents: [{ agent: "codex", models: ["gpt-6-astra"] }] }, token);
    expect(res.status).toBe(200);
    return (await res.json() as { project: string; item: Item }[]).filter((q) => q.project === name).map((q) => q.item.id);
  };
  expect(await offered()).not.toContain("t2");
  await L.recordPush("t1", A, "a".repeat(40), "a".repeat(40));
  await L.addEvidence({ itemId: "t1", claim: "paths", grade: "observed", head: "a".repeat(40), passed: true, by: "owner", at, changedPaths: ["src/a.ts"] });
  await L.submit("t1", A);
  expect(await offered()).toContain("t2");
  await L.accept("t1", "owner");
  expect(await offered()).toContain("t2");
  await L.beginProjectLanding("t1", "owner");
  expect(await offered()).not.toContain("t2");
  await runInDurableObject(L, async (_instance, state) => {
    state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'landing-lease'", JSON.stringify({ item: "t1", holder: "owner", at: new Date(Date.now() - LANDING_LEASE_EXPIRY_MS).toISOString() }));
  });
  expect(await offered()).toContain("t2");
  const record = await L.project();
  await L.setProject({ ...record, policy: { ...record.policy, refuseOverlap: true } }, "owner");
  const queued = (await L.waiting())[0];
  expect(queued.held).toBeUndefined();
  expect(queued.claimRefusal).toContain("t1");
  const queueResponse = await api("/queue");
  expect(queueResponse.status).toBe(200);
  const queue = await queueResponse.json() as { project: string; item: Item & { held?: unknown; claimRefusal?: string } }[];
  const listed = queue.find((q) => q.project === name && q.item.id === "t2")!.item;
  expect(listed.held).toBeUndefined();
  expect(listed.claimRefusal).toContain("t1");
  const otherActor = "opencode/glm-5.3";
  const issued = await api("/tokens", "POST", { actor: otherActor, projects: [name] });
  expect(issued.status).toBe(201);
  const other = await issued.json() as { token: string };
  const refused = await worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t2/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${other.token}`, "x-atelier-actor": otherActor, "x-atelier-runner": "home:hold", "content-type": "application/json" },
    body: JSON.stringify({}),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: "overlap", detail: expect.stringContaining("t1") });
  expect((await L.item("t1")).state).toBe("accepted");
  expect((await L.item("t2")).state).toBe("open");
});

it("real dependency paths through all blockers report blocked chains and only actual cycles", () => {
  const queued = item("t1");
  const builder = item("t2", { kind: "part", plan: "t9", partKey: "b", deps: ["c", "d"], state: "claimed", owner: A });
  const c = item("t3", { kind: "part", plan: "t9", partKey: "c", scope: ["docs/**"] });
  const d = item("t4", { kind: "part", plan: "t9", partKey: "d", scope: ["docs/**"] });
  expect(blockerChains("t1", holdGraph([queued, builder, c, d], ["src/**"], null))).toEqual([
    { path: ["t1", "t2", "t3"], deadlock: false }, { path: ["t1", "t2", "t4"], deadlock: false },
  ]);
  expect(blockerChains("t1", holdGraph([queued, builder, { ...c, deps: ["b"] }, d], ["src/**"], null))).toEqual([
    { path: ["t1", "t2", "t3", "t2"], deadlock: true }, { path: ["t1", "t2", "t4"], deadlock: false },
  ]);
});

it("lease renewal preserves a continuous hold; expiration and policy clearing reset it", async () => {
  const L = await setup("dispatch-hold-renew");
  await runInDurableObject(L, (instance, state) => {
    state.storage.sql.exec("UPDATE items SET state = 'submitted' WHERE id = 't1'");
    instance.waiting();
    instance.beginProjectLanding("t1", "owner");
    const since = instance.waiting()[0].held!.since;
    instance.renewProjectLanding("t1", "owner");
    expect(instance.waiting()[0].held!.since).toBe(since);
    const expired = new Date(Date.now() - LANDING_LEASE_EXPIRY_MS).toISOString();
    state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'landing-lease'", JSON.stringify({ item: "t1", holder: "owner", at: expired }));
    expect(instance.waiting()[0].held).toBeUndefined();
    expect(JSON.parse(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'core-holds'").one().value as string)).toEqual({});
    instance.beginProjectLanding("t1", "owner");
    expect(instance.waiting()[0].held).toBeDefined();
    const record = instance.project();
    instance.setProject({ ...record, policy: { ...record.policy, coreFiles: [] } }, "owner");
    expect(instance.waiting()[0].held).toBeUndefined();
    expect(JSON.parse(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'core-holds'").one().value as string)).toEqual({});
    instance.setProject(record, "owner");
    expect(instance.waiting()[0].held).toBeDefined();
  });
});

it("loads queued dependencies even when the core blocker has no dependencies", async () => {
  const L = await setup("dispatch-hold-queued-deps");
  await L.newItem("Dependency", ["docs/**"], "owner");
  await L.newItem("Transitive dependency", ["docs/**"], "owner");
  await runInDurableObject(L, (instance, state) => {
    state.storage.sql.exec("UPDATE items SET kind = 'part', plan = 't9', part_key = 'queued', deps = ? WHERE id = 't2'", JSON.stringify(["dependency"]));
    state.storage.sql.exec("UPDATE items SET kind = 'part', plan = 't9', part_key = 'dependency', deps = ? WHERE id = 't3'", JSON.stringify(["transitive"]));
    state.storage.sql.exec("UPDATE items SET kind = 'part', plan = 't9', part_key = 'transitive' WHERE id = 't4'");
    const held = instance.waiting()[0].held!;
    expect(held.chains).toEqual([
      { path: ["t2", "t1"], deadlock: false },
      { path: ["t2", "t3", "t4"], deadlock: false },
    ]);
    expect(holdText(held)).toContain("blocked chain: t2 -> t3 -> t4");
    expect(holdText(held)).not.toContain("deadlock");
    state.storage.sql.exec("UPDATE items SET deps = ? WHERE id = 't4'", JSON.stringify(["queued"]));
    const cyclic = instance.waiting()[0].held!;
    expect(cyclic.chains).toEqual([
      { path: ["t2", "t1"], deadlock: false },
      { path: ["t2", "t3", "t4", "t2"], deadlock: true },
    ]);
    expect(holdText(cyclic)).toContain("deadlock: t2 -> t3 -> t4 -> t2");
    expect(instance.item("t1").state).toBe("claimed");
    expect(instance.item("t2").dispatch).toBeDefined();
  });
});

it("an expired lease followed by a new blocker between polls starts a fresh hold", async () => {
  const L = await setup("dispatch-hold-expiry-gap");
  await runInDurableObject(L, (instance, state) => {
    state.storage.sql.exec("UPDATE items SET state = 'submitted' WHERE id = 't1'");
    instance.waiting();
    instance.beginProjectLanding("t1", "owner");
    const original = instance.waiting()[0].held!.since!;
    const clock = Date.now;
    try {
      Date.now = () => Date.parse(original) + LANDING_LEASE_EXPIRY_MS + 1;
      // No waiting() poll observes the gap before claimed work takes over.
      state.storage.sql.exec("UPDATE items SET state = 'claimed' WHERE id = 't1'");
      const held = instance.waiting()[0].held!;
      expect(Date.parse(held.since!)).toBe(Date.now());
      expect(held.elapsedMs).toBe(0);
      expect(held.warning).toBe(false);
    } finally { Date.now = clock; }
  });
});

it("releasing a core hold retains its builder and queue position and clears its persisted age", async () => {
  const L = await setup("dispatch-hold-retained");
  await L.dispatch("t2", "owner", { to: "home", agent: "codex", model: "gpt-6-astra", note: "Keep this builder" });
  const original = (await L.item("t2")).dispatch!;
  expect((await L.waiting())[0].held).toBeDefined();
  const released = await L.releaseHold("t2", "owner", { retainAt: original.at });
  expect(released.dispatch).toEqual({ ...original, overlapOk: true });
  expect((await L.waiting())[0].held).toBeUndefined();
  await runInDurableObject(L, (_instance, state) => {
    expect(JSON.parse(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'core-holds'").one().value as string)).toEqual({});
  });
  expect((await L.item("t1")).state).toBe("claimed");
});

it("releasing a retained dispatch clears only the core hold, preserving the separate overlap refusal", async () => {
  const L = await setup("dispatch-hold-retained-refusal");
  const builder = "opencode/glm-5.3";
  await L.dispatch("t2", "owner", { to: "home", agent: "opencode", model: "glm-5.3", note: "Keep this builder" });
  const original = (await L.item("t2")).dispatch!;
  const record = await L.project();
  await L.setProject({ ...record, policy: { ...record.policy, refuseOverlap: true } }, "owner");
  const before = (await L.waiting())[0];
  expect(before.held?.blockers?.map((b) => b.id)).toEqual(["t1"]);
  expect(before.claimRefusal).toContain("t1");
  expect(holdText(before.held!)).toContain(`separate claim refusal: ${before.claimRefusal}`);

  await L.releaseHold("t2", "owner", { retainAt: original.at });
  const after = (await L.waiting())[0];
  expect(after.dispatch).toEqual({ ...original, overlapOk: true });
  expect(after.held).toBeUndefined();
  expect(after.claimRefusal).toBe(before.claimRefusal);
  await runInDurableObject(L, (instance, state) => {
    expect(() => instance.claim("t2", builder, { runner: "home:hold", kind: "home" })).toThrow("t1");
    expect(JSON.parse(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'core-holds'").one().value as string)).toEqual({});
  });
  expect((await L.item("t1")).state).toBe("claimed");
  expect((await L.item("t2")).state).toBe("open");
});
