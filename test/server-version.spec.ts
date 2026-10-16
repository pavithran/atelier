import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

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
  return await res.json() as { commit: string | null; main: string | null; routeLevel: number };
}

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
