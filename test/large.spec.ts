import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { Ledger, LedgerEvent } from "../src/ledger.ts";
import type { Evidence, ProjectPolicy } from "../src/rules.ts";
import { getLarge, putLarge } from "../src/large.ts";

// Large payloads by reference (t284): whole check logs and review diffs are
// kept in the R2 bucket behind the LARGE binding, the ledger and the briefs
// name them by key, and the API serves what a reference names. The bucket is
// the local one the Workers test pool provides from wrangler.jsonc.

const TOKEN = "large-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
const H0 = "0".repeat(40);
const H1 = "a".repeat(40);

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

async function setup(project: string) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() });
  return L;
}

function call(method: string, path: string, actor = "owner", body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

it("stores a payload through the R2 binding and reads it back by its key", async () => {
  const log = "not ok 1 - something\n# fail 1\n".repeat(400);
  const ref = await putLarge(env.LARGE, "logs", "large-store", "t1", log);
  expect(ref).not.toBeNull();
  expect(ref!.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(ref!.key).toBe(`logs/large-store/t1/${ref!.sha256}`);
  expect(ref!.bytes).toBe(log.length);
  expect(await getLarge(env.LARGE, ref!.key)).toBe(log);
});

it("evidence keeps a whole log's reference beside its tail, and the event names it", async () => {
  const L = await setup("large-evidence");
  await L.newItem("Keep the whole log", ["src/**"], "owner");
  await L.claim("t1", "claude-code/opus-5.5");
  await L.setFork("t1", "large-evidence--t1", H0, "claude-code/opus-5.5");
  await L.recordPush("t1", "claude-code/opus-5.5", H1, H1);
  const whole = "x".repeat(6000);
  const ref = (await putLarge(env.LARGE, "logs", "large-evidence", "t1", whole))!;
  const e: Evidence = {
    itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: false, by: "atelier/sandbox",
    at: new Date().toISOString(), changedPaths: ["src/a.ts"], outputTail: whole.slice(-4000), where: "sandbox", log: ref,
  };
  await L.addEvidence(e);
  const stored = (await (L as unknown as Ledger).evidenceFor("t1")) as unknown as Evidence[];
  expect(stored.at(-1)?.log).toEqual(ref);
  const events = (await (L as unknown as Ledger).events("t1")) as unknown as LedgerEvent[];
  const event = events.find((ev) => ev.kind === "evidence.observed");
  expect(event?.data).toMatchObject({ log: { key: ref.key, bytes: ref.bytes, sha256: ref.sha256 } });
});

it("a stored review diff is recorded in the ledger by reference, and refused for a stale head", async () => {
  const L = await setup("large-diff");
  await L.newItem("Review it", ["src/**"], "owner");
  await L.claim("t1", "claude-code/opus-5.5");
  await L.setFork("t1", "large-diff--t1", H0, "claude-code/opus-5.5");
  await L.recordPush("t1", "claude-code/opus-5.5", H1, H1);
  const ref = (await putLarge(env.LARGE, "diffs", "large-diff", "t1", "diff --git a/x b/x\n+1\n".repeat(20_000)))!;
  await L.reviewDiffStored("t1", "zcode/glm-5.3", H1, ref);
  const events = (await (L as unknown as Ledger).events("t1")) as unknown as LedgerEvent[];
  expect(events.find((ev) => ev.kind === "review.diff")?.data).toMatchObject({ head: H1, key: ref.key, bytes: ref.bytes, sha256: ref.sha256 });
  const stale = "9".repeat(40);
  const refused = await L.reviewDiffStored("t1", "zcode/glm-5.3", stale, ref).then(
    () => new Error("expected a stale_head refusal"),
    (e: unknown) => e as Error,
  );
  expect(refused.message).toMatch(/stale_head/);
});

it("the API serves a stored log or diff by its sha256, for the item the path names", async () => {
  const L = await setup("large-routes");
  await L.newItem("Serve the stored payloads", ["src/**"], "owner");
  const log = await putLarge(env.LARGE, "logs", "large-routes", "t1", "the whole check log\n");
  const diff = await putLarge(env.LARGE, "diffs", "large-routes", "t1", "the whole review diff\n");
  expect(log).not.toBeNull();
  expect(diff).not.toBeNull();

  const served = await call("GET", `/projects/large-routes/items/t1/logs/${log!.sha256}`);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await served.text()).toBe("the whole check log\n");

  const resolution = await call("GET", `/projects/large-routes/items/t1/diffs/${diff!.sha256}`);
  expect(await resolution.text()).toBe("the whole review diff\n");

  // A sha nothing is stored under, a sha that is not one, and another item: each answers its own refusal.
  expect((await call("GET", `/projects/large-routes/items/t1/logs/${"1".repeat(64)}`)).status).toBe(404);
  const bad = await call("GET", "/projects/large-routes/items/t1/logs/notasha");
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: "bad_ref" });
  expect((await call("GET", `/projects/large-routes/items/t9/logs/${log!.sha256}`)).status).toBe(404);

  // A reference cannot point into another project's payloads: the key is
  // rebuilt from the project the path names.
  await setup("large-other");
  const cross = await call("GET", `/projects/large-other/items/t1/logs/${log!.sha256}`);
  expect(cross.status).toBe(404);

  // A caller acting for an agent reads the stored payload as it reads the item.
  const agent = await call("GET", `/projects/large-routes/items/t1/logs/${log!.sha256}`, "opencode/qwen-3.5-coder");
  expect(agent.status).toBe(200);
  expect(await agent.text()).toBe("the whole check log\n");
});
