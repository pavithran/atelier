import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// The queue and claim routes driven through the Worker's own fetch handler,
// so the header parsing and wiring are tested, not only the Ledger beneath.
// Claims that pass every check go on to fork in Artifacts, which this pool
// does not reach; the tests stop at the refusals that come first.

const TOKEN = "routes-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

function call(method: string, path: string, actor: string, body?: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`)).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
}

it("dispatch through the API, then the queue answers the owner and a matching runner", async () => {
  await project("routes-a");
  const created = await (await call("POST", "/projects/routes-a/items", "owner", { title: "Small edit", scope: ["docs/**"] })).json() as { id: string };
  const model = "Qwen3-Coder-Next-4bit:studio-code";
  const sent = await call("POST", `/projects/routes-a/items/${created.id}/dispatch`, "owner", { to: "home", agent: "opencode", model });
  expect(sent.status).toBe(200);
  expect((await call("POST", `/projects/routes-a/items/${created.id}/dispatch`, "codex/gpt-6", {})).status).toBe(403);

  const all = await (await call("GET", "/queue", "owner")).json() as { project: string; item: { id: string } }[];
  expect(all.some((q) => q.project === "routes-a" && q.item.id === created.id)).toBe(true);

  const offer = { runner: "home:studio", agents: [{ agent: "opencode", models: [model] }] };
  const mine = await (await call("POST", "/queue", "owner", offer)).json() as { project: string; actor: string }[];
  expect(mine.find((q) => q.project === "routes-a")?.actor).toBe(`opencode/${model}`);
  const cloud = await (await call("POST", "/queue", "owner", { ...offer, runner: "cloud:atelier" })).json() as unknown[];
  expect(cloud.some((q) => (q as { project: string }).project === "routes-a")).toBe(false);
  expect((await call("POST", "/queue", "owner", { agents: [] })).status).toBe(400);
});

it("a claim on a dispatched task is refused without the right runner header", async () => {
  await project("routes-b");
  const created = await (await call("POST", "/projects/routes-b/items", "owner", { title: "Edit", scope: ["a/**"] })).json() as { id: string };
  await call("POST", `/projects/routes-b/items/${created.id}/dispatch`, "owner", { to: "home", agent: "opencode" });
  const claim = (actor: string, runner?: string) =>
    call("POST", `/projects/routes-b/items/${created.id}/claim`, actor, {}, runner ? { "x-atelier-runner": runner } : {});

  const none = await claim("opencode/glm-5.3-flash");
  expect(none.status).toBe(409);
  expect(((await none.json()) as { error: string }).error).toBe("dispatched");
  const wrong = await claim("opencode/glm-5.3-flash", "cloud:atelier");
  expect(wrong.status).toBe(403);
  expect(((await wrong.json()) as { error: string }).error).toBe("wrong_runner");
  expect((await claim("opencode/glm-5.3-flash", "laptop")).status).toBe(400);
});

it("the model pool: anyone signed in reads it, only the owner changes it, a runner reports status", async () => {
  const api = (method: string, path: string, actor: string, body?: unknown, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://atelier.test/api/models${path}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), testEnv);
  const entry = { harness: "opencode", where: "cloud", provider: "google", keychain: "gemini.API_KEY" };
  expect((await api("PUT", "/gemini-3.1-pro", "codex/gpt-6-astra", entry)).status).toBe(403);
  const added = await api("PUT", "/gemini-3.1-pro", "owner", entry);
  expect(added.status).toBe(200);
  expect(await added.json()).toMatchObject({ id: "gemini-3.1-pro", family: "google", keychain: "gemini.API_KEY" });
  expect((await api("PUT", "/leaky", "owner", { ...entry, key: "AIza-secret" })).status).toBe(400);
  const list = await (await api("GET", "", "codex/gpt-6-astra")).json() as { id: string }[];
  expect(list.map((m) => m.id)).toContain("gemini-3.1-pro");
  expect(JSON.stringify(list)).not.toContain("AIza");
  expect((await api("POST", "/gemini-3.1-pro/status", "opencode/gemini-3.1-pro", { state: "available" })).status).toBe(400);
  // A cloud model is reported by a cloud runner, never a home one.
  expect((await api("POST", "/gemini-3.1-pro/status", "opencode/gemini-3.1-pro", { state: "available" }, { "x-atelier-runner": "home:studio" })).status).toBe(403);
  const reported = await api("POST", "/gemini-3.1-pro/status", "opencode/gemini-3.1-pro", { state: "available", served: "gemini-3.1-pro-002" }, { "x-atelier-runner": "cloud:atelier" });
  expect(await reported.json()).toMatchObject({ status: { state: "available", served: "gemini-3.1-pro-002", by: "cloud:atelier" } });
  // Changing a note keeps the status; changing how the model is reached clears it.
  expect(await (await api("PUT", "/gemini-3.1-pro", "owner", { ...entry, note: "via OpenCode" })).json()).toMatchObject({ note: "via OpenCode", status: { state: "available" } });
  expect(await (await api("PUT", "/gemini-3.1-pro", "owner", { ...entry, keychain: "gemini.OTHER_KEY" })).json()).not.toHaveProperty("status");
  expect((await api("POST", "/missing/status", "x/y", { state: "available" }, { "x-atelier-runner": "home:studio" })).status).toBe(404);
  expect(await (await api("DELETE", "/gemini-3.1-pro", "owner")).json()).toEqual({ removed: true });
});
