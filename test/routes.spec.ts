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

it("the submit route refuses a blank or non-text summary, and accepts a missing one", async () => {
  await project("routes-summary");
  const A = "claude-code/opus-5.5", H0 = "0".repeat(40), H1 = "a".repeat(40);
  const L = env.LEDGER.get(env.LEDGER.idFromName("project:routes-summary"));
  await L.newItem("Summary refusals", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "routes-summary--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  for (const summary of ["", "   \n", 42, ["x"], null]) {
    const res = await call("POST", "/projects/routes-summary/items/t1/submit", A, { summary });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("a summary must be text with something in it");
  }
  expect(((await L.events("t1")) as unknown as { kind: string }[]).some((e) => e.kind === "item.submitted")).toBe(false);
  expect((await call("POST", "/projects/routes-summary/items/t1/submit", A, {})).status).toBe(200);
});

it("init again changes only what it names, and --reset starts over", async () => {
  const ARTIFACTS = {
    create: async () => ({}),
    get: async () => ({ info: async () => ({ remote: "https://example/r.git", defaultBranch: "main" }), createToken: async () => ({ plaintext: "t", id: "i", expiresAt: "x" }), [Symbol.dispose]() {} }),
  } as unknown as Artifacts;
  const put = (body: unknown) => worker.fetch(new Request("https://atelier.test/api/projects/kept", {
    method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...testEnv, ARTIFACTS } as typeof env);
  const policy = async () => (await (await put({})).json() as { project: { title?: string; policy: Record<string, unknown> } }).project;

  const first = await put({ checks: ["npm test"], protected: ["AGENTS.md", "src/rules.ts"], sandboxOnly: true, title: "Kept" });
  expect(first.status).toBe(200);
  // A second init that names nothing keeps every setting, the title included.
  expect(await policy()).toMatchObject({ title: "Kept", policy: { checks: ["npm test"], protected: ["AGENTS.md", "src/rules.ts"], sandboxOnly: true } });
  // Naming one setting replaces that one only.
  await put({ checks: ["npm run typecheck"] });
  expect((await policy()).policy).toMatchObject({ checks: ["npm run typecheck"], protected: ["AGENTS.md", "src/rules.ts"], sandboxOnly: true });
  // Only reset: true resets; anything else that is not a boolean is refused.
  expect((await put({ reset: "false", title: "X" })).status).toBe(400);
  expect((await put({ reset: 1 })).status).toBe(400);
  await put({ reset: false, title: "Still kept" });
  expect((await policy()).policy).toMatchObject({ checks: ["npm run typecheck"], protected: ["AGENTS.md", "src/rules.ts"], sandboxOnly: true });
  // --reset rebuilds from what it is given and the defaults.
  await put({ reset: true, checks: ["npm test"] });
  expect((await policy()).policy).toMatchObject({ checks: ["npm test"], protected: ["AGENTS.md", "CLAUDE.md", "wrangler.*"], sandboxOnly: false });
  // A first init of a new project with nothing named gets the defaults.
  const fresh = await worker.fetch(new Request("https://atelier.test/api/projects/fresh", {
    method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: "{}",
  }), { ...testEnv, ARTIFACTS } as typeof env);
  expect((await fresh.json() as { project: { policy: unknown } }).project.policy).toMatchObject({ checks: [], protected: ["AGENTS.md", "CLAUDE.md", "wrangler.*"] });
});

it("only the project owner can init, reset or not", async () => {
  const res = await worker.fetch(new Request("https://atelier.test/api/projects/kept", {
    method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "codex/gpt-6-astra", "content-type": "application/json" }, body: JSON.stringify({ reset: true }),
  }), testEnv);
  expect(res.status).toBe(403);
});

it("a merge's lease cannot be cancelled once the merge is on the baseline", async () => {
  const name = "cancel-landing";
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const H1 = "a".repeat(40), H0 = "0".repeat(40), M = "c".repeat(40);
  await L.newItem("Land", [], "owner"); await L.claim("t1", "claude-code/opus-5.5"); await L.setFork("t1", `${name}--t1`, H0, "claude-code/opus-5.5");
  await L.recordPush("t1", "claude-code/opus-5.5", H1, H1);
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: true, by: "claude-code/opus-5.5", at: new Date().toISOString(), changedPaths: ["README.md"] } as never);
  await L.submit("t1", "claude-code/opus-5.5"); await L.accept("t1", "owner", H1); await L.beginLanding("t1", "owner", H1);
  let published = false;
  const ARTIFACTS = { get: async () => ({ log: async () => (published ? [{ hash: M, parents: [H0, H1] }] : [{ hash: H0, parents: [] }]), [Symbol.dispose]() {} }) } as unknown as Artifacts;
  const cancel = () => worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t1/landing`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify({ cancel: true }),
  }), { ...testEnv, ARTIFACTS } as typeof env);
  published = true;
  const refused = await cancel();
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("landed");
  published = false;
  expect((await cancel()).status).toBe(200);
});

// The Artifacts calls a PUT makes, stubbed so the route runs to completion here.
const artifacts = {
  create: async () => {},
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
    [Symbol.dispose]() {},
  }),
} as unknown as Artifacts;
const artifactsEnv = { ...testEnv, ARTIFACTS: artifacts };

function putTitle(name: string, title: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: JSON.stringify({ checks: ["npm test"], protected: [], ...(title === undefined ? {} : { title }) }),
  }), artifactsEnv);
}

it("the title route keeps the stored title on re-init, clears it on an empty one, and takes only strings", async () => {
  await project("routes-title");
  const titleOf = async (t: unknown) =>
    (((await (await putTitle("routes-title", t)).json()) as { project: { title?: string } }).project.title);
  expect(await titleOf("Atelier")).toBe("Atelier");
  expect(await titleOf(undefined)).toBe("Atelier"); // re-init without a title keeps it
  expect(await titleOf("")).toBeUndefined();
  for (const bad of [false, null, {}, 7]) {
    const res = await putTitle("routes-title", bad);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_title");
  }
});

it("a first init with no title creates the project without one", async () => {
  const res = await putTitle("routes-fresh", undefined);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { project: { title?: string } }).project.title).toBeUndefined();
});

it("init refuses another name for a registered baseline before touching Artifacts", async () => {
  await project("repo-collision");
  const res = await call("PUT", "/projects/Repo-Collision", "owner", { title: "Duplicate" });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: "repo_taken" });
  const I = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  expect((await I.projects()).some((p) => p.name === "Repo-Collision")).toBe(false);
  // Settled here, not through expect().rejects, so a Durable Object refusal is never left unhandled.
  const err = await env.LEDGER.get(env.LEDGER.idFromName("project:Repo-Collision")).project().then(() => null, (e: unknown) => e as Error);
  expect(String(err)).toContain("no_project");
});

it("only the owner removes registered projects, and removal retains the Ledger", async () => {
  const name = "remove-retained";
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("An open item", [], "owner");
  expect((await call("DELETE", `/projects/${name}`, "codex/gpt-6-astra", { force: true })).status).toBe(403);
  expect((await call("DELETE", "/projects/not-registered", "owner")).status).toBe(404);
  expect((await call("DELETE", `/projects/${name}`, "owner", { force: true })).status).toBe(200);
  expect(await (await call("GET", "/projects", "owner")).json()).not.toContainEqual(expect.objectContaining({ name }));
  expect((await L.project()).name).toBe(name);
  expect((await L.items()).length).toBe(1);
  expect((await call("DELETE", `/projects/${name}`, "owner")).status).toBe(404);
});

it("removal refuses claimed, submitted and accepted work unless forced", async () => {
  for (const state of ["claimed", "submitted", "accepted"]) {
    const name = `remove-${state}`, actor = "codex/gpt-6-astra", head = "a".repeat(40);
    await project(name);
    const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
    await L.newItem("Live work", [], "owner");
    await L.claim("t1", actor);
    await L.setFork("t1", `${name}--t1`, "0".repeat(40), actor);
    await L.recordPush("t1", actor, head, head);
    if (state !== "claimed") await L.submit("t1", actor);
    if (state === "accepted") {
      await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: actor, at: new Date().toISOString(), changedPaths: [] } as never);
      await L.accept("t1", "owner", head);
    }
    const refused = await call("DELETE", `/projects/${name}`, "owner", { force: "true" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "live_work" });
    expect(await (await call("GET", "/projects", "owner")).json()).toContainEqual(expect.objectContaining({ name }));
    expect((await call("DELETE", `/projects/${name}`, "owner", { force: true })).status).toBe(200);
    expect((await L.item("t1")).state).toBe(state);
  }
});

it("removed projects disappear from signed-in pages and a cached showcase", async () => {
  const name = "remove-visible";
  await project(name);
  // The showcase draws a project only once an agent has taken a task.
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Visible work", [], "owner");
  await L.claim("t1", "codex/gpt-6-astra");
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const get = (path: string) => worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie: `atelier=${hex}` } }), { ...testEnv, SHOWCASE: name } as typeof env);
  expect(await (await get("/showcase")).text()).toContain(name);
  expect((await call("DELETE", `/projects/${name}`, "owner", { force: true })).status).toBe(200);
  for (const path of ["/projects", "/flow", "/decisions", "/showcase"]) {
    expect(await (await get(path)).text()).not.toContain(name);
  }
});

it("task briefs are readable by the owner and signed-in agents, but not anonymous callers", async () => {
  await project("routes-brief");
  const L = env.LEDGER.get(env.LEDGER.idFromName("project:routes-brief"));
  await L.newItem("Small edit", ["docs/**"], "owner");
  const path = "/projects/routes-brief/items/t1/brief";
  for (const actor of ["owner", "codex/gpt-6-astra"]) {
    const res = await call("GET", path, actor);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      title: "Small edit", decided: "Wait on t1 with nothing pushed: Small edit.",
      evidence: ["Required checks at this revision: 1 waiting."],
      recommendation: { verdict: "wait" },
    });
  }
  const anonymous = await worker.fetch(new Request(`https://atelier.test/api${path}`), testEnv);
  expect(anonymous.status).toBe(401);
  expect((await call("GET", "/projects/routes-brief/items/t99/brief", "owner")).status).toBe(404);
  expect((await call("POST", path, "owner", {})).status).toBe(404);
});
