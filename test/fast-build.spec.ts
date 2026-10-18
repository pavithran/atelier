import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { renderItem } from "../src/ui.ts";

// t589. Evidence: 2026-10-13 10:35 EDT, in fast mode (decision d14), every
// runner build still began with a claim that forks main, and forks of
// cloudflare-git failed (Artifacts INTERNAL_ERROR), so builds were run by
// hand in local clones. In fast mode the queue marks a plain build fast, the
// runner's fast take records the holder with no fork and no write token, and
// its fast-ready report names the commit the owner's batch lands. In full
// mode the claim forks as before, and a fast take is refused.

const OWNER = "fast-build-owner", ACTOR = "codex/gpt-6-astra", MAIN = "a".repeat(40), BUILT = "b".repeat(40);
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
let serial = 0;
type Json = Record<string, unknown>;

async function setup() {
  const name = `fast-build-${++serial}`;
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const p = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(p, "owner");
  await I().registerProject(p);
  await L.newItem("Build it", [], "owner", { accept: ["Works"] });
  await L.dispatch("t1", "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  // Every fork the server asks Artifacts for, and every write token.
  const forks: string[] = [], tokens: string[] = [];
  const artifacts = { get: async (repo: string) => ({
    fork: async (as: string) => { forks.push(as); },
    readTree: async () => [],
    log: async () => [{ hash: MAIN, treeHash: "c".repeat(40), parents: [], message: "Main", author: { name: "Owner" } }],
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope: string, ttl: number) => { tokens.push(`${scope}:${repo}`); return { id: `${scope}-${repo}`, plaintext: "upstream-secret", expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; },
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }) };
  const bindings = { ...env, ATELIER_TOKEN: OWNER, ARTIFACTS: artifacts } as unknown as typeof env;
  const request = (method: string, path: string, token = OWNER, actor: string | null = "owner", body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings);
  const issued = await request("POST", "/tokens", OWNER, "owner", { runner: "home:studio", projects: [name] });
  expect(issued.status).toBe(201);
  const token = await issued.json() as { id: string; token: string };
  const api = (method: string, path: string, body?: unknown, actor: string | null = ACTOR) => request(method, path, token.token, actor, body);
  const offer = { runner: "home:studio", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build", "plan"] };
  const poll = async () => {
    const res = await api("POST", "/queue", offer);
    expect(res.status).toBe(200);
    return await res.json() as Json[];
  };
  return { name, L, api, request, poll, forks, tokens, base: `/projects/${name}/items/t1` };
}

it("in full mode the queue marks nothing fast, a fast take is refused, and the claim forks as before", async () => {
  const t = await setup();
  const [job] = await t.poll();
  expect(job).toMatchObject({ project: t.name, actor: ACTOR });
  expect(job.fast).toBeUndefined();
  const refused = await t.api("POST", `${t.base}/fast-take`, {});
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: "not_fast_mode" });
  // The refusal is no claim refusal noted on the task: the runner claims instead.
  expect((await t.L.item("t1")).state).toBe("open");
  const claimed = await t.api("POST", `${t.base}/claim`, {});
  expect(claimed.status).toBe(200);
  expect(t.forks).toEqual([`${t.name}--t1`]);
  expect(await claimed.json()).toMatchObject({ workspace: { remote: expect.stringContaining(`/git/runner/`) } });
});

it("in fast mode the runner takes the build with no fork and no write token, reports its commit, and the owner lands it", async () => {
  const t = await setup();
  await t.L.confirmFastMode("owner", "access");
  await t.L.setMode("owner", "fast", "Artifacts fails every new fork");
  const [job] = await t.poll();
  expect(job).toMatchObject({ project: t.name, actor: ACTOR, fast: true });

  const taken = await t.api("POST", `${t.base}/fast-take`, {});
  expect(taken.status).toBe(200);
  const answer = await taken.json() as Json;
  expect(answer).toMatchObject({ fast: true, baseline: { remote: `https://git.test/${t.name}.git`, token: "upstream-secret", defaultBranch: "main" } });
  expect(answer.workspace).toBeUndefined();
  // No fork, and the only token made is the baseline's read token.
  expect(t.forks).toEqual([]);
  expect(t.tokens).toEqual([`read:${t.name}`]);
  const item = await t.L.item("t1");
  expect(item).toMatchObject({ state: "claimed", owner: ACTOR, runner: "home:studio", fork: null });
  expect(await t.L.tokenId("t1")).toBeNull();
  const kinds = ((await t.L.events("t1")) as unknown as LedgerEvent[]).map((e) => e.kind);
  expect(kinds).toEqual(expect.arrayContaining(["item.claimed", "item.fast_taken"]));

  // A report from anyone but the holder, or naming another builder, is refused.
  const report = { commit: BUILT, base: MAIN, builder: ACTOR, workspace: "/Users/runner/cache/fast/p/t1" };
  expect((await t.api("POST", `${t.base}/fast-ready`, { ...report, builder: "codex/other" })).status).toBe(400);
  const ready = await t.api("POST", `${t.base}/fast-ready`, report);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toMatchObject({ ready: { ...report, runner: "home:studio" }, item: { state: "claimed", owner: ACTOR } });
  expect((await t.L.item("t1")).dispatch ?? null).toBeNull();
  // The build is not offered again.
  expect((await t.poll()).filter((q) => (q.item as Json).id === "t1")).toEqual([]);

  // atelier fast status reads it from the mode route, and the task page says so.
  const mode = await (await t.request("GET", `/projects/${t.name}/mode`)).json() as { ready: Json[] };
  expect(mode.ready).toEqual([expect.objectContaining({ item: "t1", title: "Build it", commit: BUILT, base: MAIN, builder: ACTOR, runner: "home:studio" })]);
  const html = renderItem(await t.L.project(), await t.L.detail("t1"));
  expect(html).toContain(`Ready to merge at <code>${BUILT.slice(0, 12)}</code>`);
  expect(html).toContain(`atelier record-merge t1 --merge SHA --head ${BUILT} --review H/M=approve@${BUILT}`);

  // The owner's batch lands it; it is no longer listed as ready.
  await t.L.landedFast("t1", "owner", { commit: BUILT, mergeCommit: "d".repeat(40), testedHead: "d".repeat(40), batch: `${"0".repeat(40)}..${"d".repeat(40)}`, builder: ACTOR, tests: { command: "npm test", sha256: "e".repeat(64) } });
  expect(await t.L.fastReadyList()).toEqual([]);
  expect(renderItem(await t.L.project(), await t.L.detail("t1"))).not.toContain("Ready to merge");
});

it("back in full mode a ready report is refused and the queue claims with a fork again", async () => {
  const t = await setup();
  await t.L.confirmFastMode("owner", "access");
  await t.L.setMode("owner", "fast", "forks fail");
  await t.poll();
  expect((await t.api("POST", `${t.base}/fast-take`, {})).status).toBe(200);
  await t.L.setMode("owner", "full", undefined);
  const refused = await t.api("POST", `${t.base}/fast-ready`, { commit: BUILT, base: MAIN, builder: ACTOR });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: "not_fast_mode" });
  const [held] = await t.poll();
  expect(held).toMatchObject({ actor: ACTOR });
  expect(held.fast).toBeUndefined();
});
