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

async function project(name: string, protect: string[] = []) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: protect }, createdAt: new Date().toISOString() };
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

it("project routes refuse a body that is not a JSON object with a 400, not a 500", async () => {
  const name = "remove-bad-body";
  await project(name);
  for (const body of [null, [1], "force", 7, true]) {
    for (const [method, path] of [["DELETE", `/projects/${name}`], ["PUT", `/projects/${name}`]]) {
      const res = await call(method, path, "owner", body);
      expect(res.status, `${method} ${JSON.stringify(body)}`).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_body", detail: "the request body must be a JSON object" });
    }
  }
  expect(await (await call("GET", "/projects", "owner")).json()).toContainEqual(expect.objectContaining({ name }));
  expect((await call("DELETE", `/projects/${name}`, "owner")).status).toBe(200);
});

it("removal counts an open item queued for a runner as live work", async () => {
  const name = "remove-queued";
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Queued for a runner", [], "owner");
  await L.dispatch("t1", "owner", { to: "home" });
  const refused = await call("DELETE", `/projects/${name}`, "owner");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: "live_work", detail: expect.stringContaining("queued for a runner") });
  expect(await (await call("GET", "/projects", "owner")).json()).toContainEqual(expect.objectContaining({ name }));
  expect((await call("DELETE", `/projects/${name}`, "owner", { force: "true" })).status).toBe(409);
  expect((await call("DELETE", `/projects/${name}`, "owner", { force: true })).status).toBe(200);
  // A task that is open but not queued is still removable without force.
  const plain = "remove-open";
  await project(plain);
  await env.LEDGER.get(env.LEDGER.idFromName(`project:${plain}`)).newItem("Just open", [], "owner");
  expect((await call("DELETE", `/projects/${plain}`, "owner")).status).toBe(200);
});

it("a check posted for an item with no workspace records no paths, whatever the caller sends", async () => {
  const name = "missing-paths";
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Paths", [], "owner");
  await L.claim("t1", "owner");
  await L.recordPush("t1", "owner", "a".repeat(40), null);
  for (const changedPaths of [undefined, null, "docs/a.md", {}, [], ["AGENTS.md"]]) {
    const res = await call("POST", `/projects/${name}/items/t1/evidence`, "owner", {
      kind: "check", claim: "npm test", head: "a".repeat(40), passed: true, changedPaths,
    });
    expect(res.status).toBe(200);
    const detail = await (await call("GET", `/projects/${name}/items/t1`, "owner")).json() as { evidence: { changedPaths: unknown }[]; gate: { blockers: string[] } };
    expect(detail.evidence.at(-1)?.changedPaths).toBeNull();
    expect(detail.gate.blockers).toContain("changed paths not yet observed");
  }
});

// Artifacts holding a baseline and one fork as Git objects: first-parent logs,
// newest first, and flat trees, which is what the evidence route reads to
// measure the paths a workspace changes.
function gitStore(logs: Record<string, { hash: string; parents: string[]; treeHash: string }[]>, trees: Record<string, Record<string, string>>): Artifacts {
  const entries = (h: string) => trees[h] ? Object.entries(trees[h]).map(([name, hash]) => ({ name, mode: "100644", hash, type: "blob" })) : null;
  return {
    get: async (name: string) => {
      const log = logs[name] ?? [];
      return {
        log: async (opts: { limit?: number } = {}) => log.slice(0, opts.limit ?? 50),
        readCommit: async (h: string) => log.find((c) => c.hash === h) ?? null,
        readTree: async (h: string) => entries(h),
        readBlob: async () => null,
        info: async () => ({ remote: "https://git.test/r.git", defaultBranch: "main" }),
        [Symbol.dispose]() {},
      };
    },
  } as unknown as Artifacts;
}

it("the item's own agent cannot name the paths its check changed: the Worker measures them, so a protected change needs its independent review", async () => {
  const name = "measured-paths", A = "claude-code/opus-5.5", B = "codex/gpt-6-astra";
  const H0 = "0".repeat(40), H1 = "a".repeat(40), T0 = "1".repeat(40), T1 = "2".repeat(40);
  await project(name, ["AGENTS.md"]);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Rewrite the agent instructions", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  await L.recordPush("t1", A, H1, H1);
  // The fork's one commit edits AGENTS.md; README.md is untouched.
  const ARTIFACTS = gitStore({
    [name]: [{ hash: H0, parents: [], treeHash: T0 }],
    [`${name}--t1`]: [{ hash: H1, parents: [H0], treeHash: T1 }, { hash: H0, parents: [], treeHash: T0 }],
  }, {
    [T0]: { "AGENTS.md": "b".repeat(40), "README.md": "c".repeat(40) },
    [T1]: { "AGENTS.md": "d".repeat(40), "README.md": "c".repeat(40) },
  });
  const as = (bearer: string, actor: string | null) => (method: string, path: string, body?: unknown) =>
    worker.fetch(new Request(`https://atelier.test/api/projects/${name}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { ...testEnv, ARTIFACTS } as typeof env);
  const owner = as(TOKEN, "owner");
  const issue = async (actor: string) => (await (await call("POST", "/tokens", "owner", { actor, projects: [name] })).json() as { token: string }).token;
  const agent = as(await issue(A), null), reviewer = as(await issue(B), null);
  const latest = async () => (await (await owner("GET", "/items/t1")).json() as { evidence: Record<string, unknown>[] }).evidence.at(-1);

  // Whatever list the agent sends, or none, the row carries the measured one.
  for (const changedPaths of [["README.md"], [], undefined, "README.md"]) {
    const res = await agent("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", passed: true, head: H1, changedPaths });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await latest()).toMatchObject({ grade: "observed", where: "runner", by: A, passed: true, changedPaths: ["AGENTS.md"] });
  }
  // A check for a head the fork is not at is refused, as before.
  const stale = await agent("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", passed: true, head: H0, changedPaths: [] });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "stale_head" });

  expect((await agent("POST", "/items/t1/submit", {})).status).toBe(200);
  const detail = await (await owner("GET", "/items/t1")).json() as { gate: { ready: boolean; needsAssessor: boolean; blockers: string[] } };
  expect(detail.gate).toMatchObject({ ready: false, needsAssessor: true });
  expect(detail.gate.blockers.join(" ")).toMatch(/protected path/);
  const early = await owner("POST", "/items/t1/accept", { head: H1 });
  expect(early.status).toBe(409);
  expect(await early.json()).toMatchObject({ error: "not_ready" });
  // The agent cannot supply the review itself; another model can.
  const own = await agent("POST", "/items/t1/review", { head: H1, approve: true, note: "mine" });
  expect(own.status).toBe(403);
  expect(await own.json()).toMatchObject({ error: "self_review" });
  expect((await reviewer("POST", "/items/t1/review", { head: H1, approve: true, note: "read the instructions" })).status).toBe(200);
  const accepted = await owner("POST", "/items/t1/accept", { head: H1 });
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  expect(await accepted.json()).toMatchObject({ state: "accepted", acceptedHead: H1 });
});

it("the standing route is readable by any signed-in actor, and by no one else", async () => {
  const name = "standing-route", agent = "codex/gpt-6-astra", head = "a".repeat(40);
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Ready for the owner", ["src/**"], "owner");
  await L.claim("t1", agent);
  await L.setFork("t1", `${name}--t1`, "0".repeat(40), agent);
  await L.recordPush("t1", agent, head, head);
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: agent, at: new Date().toISOString(), changedPaths: ["src/a.ts"], where: "sandbox" } as never);
  await L.submit("t1", agent, "Did the work");
  await L.newItem("Queued", [], "owner");
  await L.dispatch("t2", "owner", { to: "home" });
  for (const actor of ["owner", agent]) {
    const res = await call("GET", `/projects/${name}/standing`, actor);
    expect(res.status).toBe(200);
    const s = await res.json() as { project: { name: string }; live: { id: string }[]; waiting: { id: string; brief: { verdict: string } | null }[]; queued: { id: string }[] };
    expect(s.project.name).toBe(name);
    expect(s.live.map((x) => x.id)).toEqual(["t1"]);
    expect(s.waiting).toEqual([expect.objectContaining({ id: "t1", kind: "accept", brief: expect.objectContaining({ verdict: "accept" }) })]);
    expect(s.queued.map((x) => x.id)).toEqual(["t2"]);
  }
  const anonymous = await worker.fetch(new Request(`https://atelier.test/api/projects/${name}/standing`, { headers: { "x-atelier-actor": "owner" } }), testEnv);
  expect(anonymous.status).toBe(401);
  const unknown = await call("GET", "/projects/not-registered-here/standing", "owner");
  expect(unknown.status).toBe(404);
});

it("the project page carries the same standing as the route", async () => {
  const name = "standing-page";
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("A queued <task>", [], "owner");
  await L.dispatch("t1", "owner", { to: "cloud" });
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const page = await worker.fetch(new Request(`https://atelier.test/p/${name}`, { headers: { cookie: `atelier=${hex}` } }), testEnv);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('id="standing"');
  expect(html).toContain("Queued for a runner");
  expect(html).toContain("A queued &lt;task&gt;");
});

it("the standing route reads each section from its own source, not a window over the whole record", async () => {
  const name = "standing-window", agent = "codex/gpt-6-astra", H0 = "0".repeat(40), head = "a".repeat(40);
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  // t1 is merged, with a summary, and t2 is taken and handed off with a note: both older than any window of 1,000 events.
  await L.newItem("Merged long ago", ["src/**"], "owner");
  await L.claim("t1", agent);
  await L.setFork("t1", `${name}--t1`, H0, agent);
  await L.recordPush("t1", agent, head, head);
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: agent, at: new Date().toISOString(), changedPaths: ["src/a.ts"] } as never);
  await L.submit("t1", agent, "Merged summary");
  await L.accept("t1", "owner", head);
  await L.beginLanding("t1", "owner", head);
  await L.merged("t1", "owner", "c".repeat(40), true, head);
  await L.newItem("Handed off long ago", [], "owner");
  await L.claim("t2", agent);
  await L.handoff("t2", "owner", "claude-code/opus-5.5", "Start from the notes in docs/");
  const before = (await L.item("t2")).updatedAt;
  // A third task fills the project's recent record with pushes.
  await L.newItem("Noisy", [], "owner");
  await L.claim("t3", agent);
  await L.setFork("t3", `${name}--t3`, H0, agent);
  for (let n = 1; n <= 1010; n++) await L.recordPush("t3", agent, n.toString(16).padStart(40, "0"), null);
  const res = await call("GET", `/projects/${name}/standing`, agent);
  expect(res.status).toBe(200);
  const s = await res.json() as { live: { id: string; since: string | null }[]; merged: { id: string; commit: string | null; line: string | null }[]; handoffs: { id: string; note: string }[]; partial: string[] };
  expect(s.merged).toEqual([expect.objectContaining({ id: "t1", commit: "c".repeat(40), line: "Merged summary" })]);
  expect(s.handoffs).toEqual([expect.objectContaining({ id: "t2", note: "Start from the notes in docs/" })]);
  const t2 = s.live.find((x) => x.id === "t2")!;
  expect(t2.since).not.toBeNull();
  expect(t2.since! < before || t2.since === before).toBe(true);
  // The noisy task's own record is longer than what is read of it: that is said, not guessed.
  expect(s.live.find((x) => x.id === "t3")!.since).toBeNull();
  expect(s.partial).toContain("t3: when it was taken is not shown, because its record is longer than the last 300 events read.");
  expect(s.partial.filter((x) => x.startsWith("t1:") || x.startsWith("t2:"))).toEqual([]);
});

it("sessions record, clean, cap and read newest first, and only the project owner records one", async () => {
  await project("sessions");
  const path = "/projects/sessions/sessions";
  const input = { summary: "First\u202e\n note", next: "n".repeat(3000), head: "a".repeat(40), dirty: true, checks: [{ command: "npm test", passed: false, grade: "observed" }] };
  const first = await call("POST", path, "owner", input);
  expect(first.status).toBe(201);
  const note = await first.json() as { data: { summary: string; next: string; checks: { grade: string }[] } };
  expect(note.data.summary).toBe("First note");
  expect(note.data.next.length).toBe(2000);
  expect(note.data.checks[0].grade).toBe("reported");
  // Any token can send any actor until task t43 limits an agent's token to its own, so an agent's name on a note proves nothing.
  const refused = await call("POST", path, "codex/gpt-6-astra", { ...input, summary: "Not the owner" });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toBe("not_project_owner");
  expect((await call("POST", path, "someone-else", input)).status).toBe(403);
  expect((await call("POST", path, "owner", { ...input, summary: "s".repeat(3000) })).status).toBe(201);
  // Reading stays open to any signed-in actor.
  const notes = await (await call("GET", path, "codex/gpt-6-astra")).json() as { actor: string; data: { summary: string } }[];
  expect(notes).toHaveLength(2);
  expect(notes[0].actor).toBe("owner");
  expect(notes[0].data.summary.length).toBe(2000);
  expect(notes[1].data.summary).toBe("First note");
  expect((await call("POST", path, "owner", { ...input, summary: "\u200b" })).status).toBe(400);
  expect((await call("POST", path, "owner", { ...input, checks: Array(101).fill(input.checks[0]) })).status).toBe(400);
  const L = env.LEDGER.get(env.LEDGER.idFromName("project:sessions"));
  expect((await L.events() as unknown as { kind: string }[])[0].kind).toBe("session.wrapped");
  for (let n = 0; n < 6; n++) await call("POST", path, "owner", { ...input, summary: `Note ${n}` });
  const recent = await (await call("GET", path, "owner")).json() as { data: { summary: string } }[];
  expect(recent).toHaveLength(5);
  expect(recent[0].data.summary).toBe("Note 5");
  expect((await L.events() as unknown as { kind: string }[]).filter((e) => e.kind === "session.wrapped")).toHaveLength(8);
  const standing = await (await call("GET", "/projects/sessions/standing", "owner")).json() as { session: { data: { summary: string } } };
  expect(standing.session.data.summary).toBe("Note 5");
});

// Artifacts as it behaved for llm-basics: a fork's repository info names a
// branch (main) its HEAD does not (master). `info` gives each repository's
// reported default branch by name; forks are named with "--". Creating a
// repository a second time fails as the binding does.
function branchArtifacts(info: { baseline: string; fork: string }) {
  const created = new Set<string>(), calls: { create: string[]; forks: string[] } = { create: [], forks: [] };
  const artifacts = {
    create: async (name: string, opts: { setDefaultBranch?: string }) => {
      calls.create.push(`${name}:${opts.setDefaultBranch}`);
      if (created.has(name)) throw new Error(`repo already exists: ${name}`);
      created.add(name);
      return {};
    },
    get: async (name: string) => ({
      info: async () => ({ remote: `https://git.test/${name}.git`, defaultBranch: name.includes("--") ? info.fork : info.baseline }),
      createToken: async () => ({ plaintext: "token", id: `id-${name}`, expiresAt: "soon" }),
      revokeToken: async () => true,
      fork: async (fork: string) => { calls.forks.push(fork); return {}; },
      log: async () => [{ hash: "0".repeat(40) }],
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  const send = (method: string, path: string, actor: string, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...testEnv, ARTIFACTS: artifacts } as typeof env);
  return { artifacts, calls, send };
}

type Claimed = { workspace: { defaultBranch: string }; baseline: { defaultBranch: string } };

it("init records the branch it names, and every token route gives that branch, whatever any repository's info reports", async () => {
  const name = "branch-master", A = "opencode/glm-5.3";
  // Both report main: only the registration says master.
  const { calls, send } = branchArtifacts({ baseline: "main", fork: "main" });
  const init = await send("PUT", `/projects/${name}`, "owner", { checks: ["npm test"], defaultBranch: "master" });
  expect(init.status).toBe(200);
  expect(await init.json()).toMatchObject({ project: { branch: "master" }, baseline: { defaultBranch: "master" } });
  expect(calls.create).toEqual([`${name}:master`]);
  // Init again without a branch keeps it; the baseline exists, so nothing is created.
  expect(await (await send("PUT", `/projects/${name}`, "owner", { title: "Kept" })).json()).toMatchObject({ project: { branch: "master" } });

  const item = await (await send("POST", `/projects/${name}/items`, "owner", { title: "Edit", scope: [] })).json() as { id: string };
  const claimed = await send("POST", `/projects/${name}/items/${item.id}/claim`, A, {});
  expect(claimed.status).toBe(200);
  const c = await claimed.json() as Claimed;
  expect([c.workspace.defaultBranch, c.baseline.defaultBranch]).toEqual(["master", "master"]);
  expect(calls.forks).toEqual([`${name}--${item.id}`]);
  // A second claim refreshes the workspace with the same branch.
  expect(((await (await send("POST", `/projects/${name}/items/${item.id}/claim`, A, {})).json()) as Claimed).workspace.defaultBranch).toBe("master");
  const read = await (await send("POST", `/projects/${name}/items/${item.id}/read-token`, A, {})).json() as { defaultBranch: string };
  const base = await (await send("POST", `/projects/${name}/baseline-token`, A, {})).json() as { defaultBranch: string };
  expect([read.defaultBranch, base.defaultBranch]).toEqual(["master", "master"]);
});

it("a project registered before init recorded its branch takes the baseline's branch, never the fork's", async () => {
  const name = "branch-unrecorded";
  await project(name);
  const { send } = branchArtifacts({ baseline: "master", fork: "main" });
  const item = await (await send("POST", `/projects/${name}/items`, "owner", { title: "Edit", scope: [] })).json() as { id: string };
  const c = await (await send("POST", `/projects/${name}/items/${item.id}/claim`, "opencode/glm-5.3", {})).json() as Claimed;
  expect([c.workspace.defaultBranch, c.baseline.defaultBranch]).toEqual(["master", "master"]);
});

it("init records main for a baseline it creates without a branch, and refuses a branch Git would not take", async () => {
  const { calls, send } = branchArtifacts({ baseline: "main", fork: "main" });
  expect(await (await send("PUT", "/projects/branch-default", "owner", {})).json()).toMatchObject({ project: { branch: "main" } });
  // Any name Git takes for a branch is taken, slashes and letters beyond ASCII included.
  expect(await (await send("PUT", "/projects/branch-slash", "owner", { defaultBranch: "release/übersetzung-2" })).json()).toMatchObject({ project: { branch: "release/übersetzung-2" } });
  for (const bad of ["-delete", ".hidden", "a..b", "feature/", "x.lock", "a.lock/b", "has space", "a:b", "a@{1}", "@", "", 7]) {
    const res = await send("PUT", "/projects/branch-bad", "owner", { defaultBranch: bad });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_branch" });
  }
  // Refused before Artifacts is asked to create anything.
  expect(calls.create).toEqual(["branch-default:main", "branch-slash:release/übersetzung-2"]);
});

it("push events are read on the project's branch, not the one the fork's info reports", async () => {
  const name = "branch-events", A = "opencode/glm-5.3", H0 = "0".repeat(40), H1 = "1".repeat(40), H2 = "2".repeat(40);
  const record = { name, repo: name, branch: "master", policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  await L.newItem("Observe", [], "owner"); await L.claim("t1", A); await L.setFork("t1", `${name}--t1`, H0, A);
  const artifacts = { get: async () => ({ info: async () => ({ defaultBranch: "main" }), log: async () => [{ hash: H2 }], [Symbol.dispose]() {} }) } as unknown as Artifacts;
  const notice = (ref: string) => ({ type: "cf.artifacts.repo.pushed", source: { namespace: "atelier", repoName: `${name}--t1` }, payload: { ref, after: H1 } });
  const send = (body: unknown) => worker.queue({ messages: [{ body, ack() {}, retry() {} }] } as unknown as MessageBatch<unknown>, { ...env, ARTIFACTS: artifacts });
  await send(notice("refs/heads/main"));
  expect((await L.item("t1")).head).toBe(H0);
  await send(notice("refs/heads/master"));
  expect((await L.item("t1")).head).toBe(H2);
});
