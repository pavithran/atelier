import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { readFileSync } from "node:fs";

// GET /api/version names main's head beside the deployed commit (t556): a
// merge of cli/** alone deploys nothing, so DEPLOYED_MAIN stays put, but the
// ledger of the project the Worker is built from (SOURCE_PROJECT, "atelier"
// when unset) observes every merge, and a runner reloads to that head.

const DEPLOYED = "d".repeat(40), MERGED = "e".repeat(40);
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return ledger(name);
}

async function version(settings: Record<string, string> = {}) {
  const res = await worker.fetch(new Request("https://atelier.test/api/version"), { ...env, DEPLOYED_MAIN: DEPLOYED, ...settings } as typeof env);
  expect(res.status).toBe(200);
  return await res.json() as { commit: string | null; main: string | null; routeLevel: number; version: string };
}

// It also reports the release the package declares (t464), so a reader can
// tell a 2.0 server from an older one without reading commits.
it("reports the package version, 2.0.0 at the 2.0 release", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(pkg.version).toBe("2.0.0");
  expect((await version()).version).toBe("2.0.0");
});

it("names no main while the source project is unregistered or its ledger has seen none", async () => {
  expect(await version()).toMatchObject({ commit: DEPLOYED, main: null });
  await project("atelier");
  expect((await version()).main).toBeNull();
});

it("names the atelier project's main head, which moves with a merge the deploy did not follow", async () => {
  const L = await project("atelier");
  await L.noteMainHead(DEPLOYED);
  expect(await version()).toMatchObject({ commit: DEPLOYED, main: DEPLOYED });
  await L.noteMainHead(MERGED);
  expect(await version()).toMatchObject({ commit: DEPLOYED, main: MERGED });
});

it("reads the project SOURCE_PROJECT names instead", async () => {
  await (await project("atelier")).noteMainHead(DEPLOYED);
  await (await project("forge")).noteMainHead(MERGED);
  expect((await version({ SOURCE_PROJECT: "forge" })).main).toBe(MERGED);
  expect((await version({ SOURCE_PROJECT: "missing" })).main).toBeNull();
});

it("names the main a recorded merge observed, for a project with SOURCE_PROJECT set (t142)", async () => {
  const L = await project("recorded");
  const TIP = "9".repeat(40), BASE = "a".repeat(40), HEAD = "b".repeat(40), MERGE = "c".repeat(40);
  const item = await L.newItem("Merged by hand", [], "owner");
  const artifacts = { get: async () => ({
    readCommit: async (h: string) => [{ hash: TIP, parents: [MERGE] }, { hash: MERGE, parents: [BASE, HEAD] }].find((c) => c.hash === h) ?? null,
    log: async () => [{ hash: TIP, parents: [MERGE], treeHash: "0".repeat(40) }, { hash: MERGE, parents: [BASE, HEAD], treeHash: "0".repeat(40) }, { hash: BASE, parents: [], treeHash: "0".repeat(40) }],
    [Symbol.dispose]() {},
  }) } as unknown as Repos;
  const e = { ...env, ATELIER_TOKEN: "t", REPOS: artifacts, SOURCE_PROJECT: "recorded" } as typeof env;
  const r = await worker.fetch(new Request(`https://atelier.test/api/projects/recorded/items/${item.id}/record-merge`, { method: "POST", headers: { authorization: "Bearer t", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" }, body: JSON.stringify({ mergeCommit: MERGE, head: HEAD, reviews: [{ by: "codex/gpt-6-astra", verdict: "approve", head: HEAD }] }) }), e);
  expect(r.status, await r.clone().text()).toBe(200);
  expect(await (await worker.fetch(new Request("https://atelier.test/api/version"), { ...e, DEPLOYED_MAIN: DEPLOYED } as typeof env)).json()).toMatchObject({ main: TIP });
});
