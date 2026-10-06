import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

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

it("the diff route measures the workspace against main's head, so a crafted merge cannot hide a revert", async () => {
  const name = "routes-diff", A = "claude-code/opus-5.5";
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Crafted merge", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, "old", A);
  // Main moved AGENTS.md from v1 to v2. The head M is a merge whose first
  // parent is old, with AGENTS.md back at v1; the fork holds none of main's
  // newer objects, so main's tree is read from the baseline.
  const old = { "AGENTS.md": "rules v1\n", "a.ts": "a\n" };
  const repos: Record<string, { log: { hash: string; treeHash: string; parents: string[] }[]; trees: Record<string, Record<string, string>> }> = {
    [name]: { log: [{ hash: "new", treeHash: "new", parents: ["old"] }, { hash: "old", treeHash: "old", parents: [] }], trees: { old, new: { "AGENTS.md": "rules v2\n", "a.ts": "a\n" } } },
    [`${name}--t1`]: { log: [{ hash: "M", treeHash: "M", parents: ["old", "W"] }, { hash: "old", treeHash: "old", parents: [] }], trees: { old, M: { "AGENTS.md": "rules v1\n", "a.ts": "a2\n" } } },
  };
  const ARTIFACTS = {
    get: async (repo: string) => {
      const r = repos[repo];
      return {
        log: async (opts?: { limit?: number }) => r.log.slice(0, opts?.limit ?? 50),
        readCommit: async (h: string) => r.log.find((c) => c.hash === h) ?? null,
        readTree: async (h: string) => r.trees[h] ? Object.entries(r.trees[h]).map(([n, text]) => ({ name: n, mode: "100644", hash: `blob:${text}`, type: "blob" })) : null,
        readBlob: async (h: string) => Object.values(r.trees).some((t) => Object.values(t).includes(h.slice(5))) ? new Blob([h.slice(5)]) : null,
        [Symbol.dispose]() {},
      };
    },
  } as unknown as Artifacts;
  const res = await worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t1/diff`, {
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" },
  }), { ...testEnv, ARTIFACTS } as typeof env);
  expect(res.status).toBe(200);
  const diff = await res.json() as { base: string; head: string; files: { path: string; status: string }[] };
  expect(diff.base).toBe("new");
  expect(diff.head).toBe("M");
  expect(diff.files.map((f) => [f.path, f.status])).toEqual([["AGENTS.md", "modified"], ["a.ts", "modified"]]);
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
  const signedIn = await signIn(TOKEN, testEnv);
  const get = (path: string) => worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie: signedIn } }), { ...testEnv, SHOWCASE: name } as typeof env);
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

it("the evidence route measures against main's head, so a crafted merge cannot hide a reverted protected file from the gate", async () => {
  const name = "measured-crafted", A = "claude-code/opus-5.5";
  const OLD = "0".repeat(40), NEW = "1".repeat(40), W = "b".repeat(40), M = "a".repeat(40);
  const T_OLD = "2".repeat(40), T_NEW = "3".repeat(40), T_M = "4".repeat(40);
  const V1 = "5".repeat(40), V2 = "6".repeat(40), A1 = "7".repeat(40), A2 = "8".repeat(40);
  await project(name, ["AGENTS.md"]);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Touch a.ts", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, OLD, A);
  await L.recordPush("t1", A, M, M);
  // Main moved AGENTS.md from V1 to V2. The head M is a merge whose first
  // parent is OLD, with AGENTS.md back at V1 and a.ts edited; its other
  // parent W carries main's newer history. The first-parent fork point is
  // OLD, from which only a.ts changed. Each repository answers only for its
  // own objects: the fork holds none of main's newer ones.
  const repos: Record<string, { log: { hash: string; parents: string[]; treeHash: string }[]; trees: Record<string, Record<string, string>> }> = {
    [name]: {
      log: [{ hash: NEW, parents: [OLD], treeHash: T_NEW }, { hash: OLD, parents: [], treeHash: T_OLD }],
      trees: { [T_OLD]: { "AGENTS.md": V1, "a.ts": A1 }, [T_NEW]: { "AGENTS.md": V2, "a.ts": A1 } },
    },
    [`${name}--t1`]: {
      log: [{ hash: M, parents: [OLD, W], treeHash: T_M }, { hash: OLD, parents: [], treeHash: T_OLD }],
      trees: { [T_OLD]: { "AGENTS.md": V1, "a.ts": A1 }, [T_M]: { "AGENTS.md": V1, "a.ts": A2 } },
    },
  };
  const ARTIFACTS = {
    get: async (repo: string) => {
      const r = repos[repo];
      return {
        log: async (opts: { limit?: number } = {}) => r.log.slice(0, opts.limit ?? 50),
        readCommit: async (h: string) => r.log.find((c) => c.hash === h) ?? null,
        readTree: async (h: string) => r.trees[h] ? Object.entries(r.trees[h]).map(([n, hash]) => ({ name: n, mode: "100644", hash, type: "blob" })) : null,
        readBlob: async () => null,
        [Symbol.dispose]() {},
      };
    },
  } as unknown as Artifacts;
  expect(await (await ARTIFACTS.get(`${name}--t1`)).readTree(T_NEW)).toBeNull();
  const as = (bearer: string, actor: string | null) => (method: string, path: string, body?: unknown) =>
    worker.fetch(new Request(`https://atelier.test/api/projects/${name}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { ...testEnv, ARTIFACTS } as typeof env);
  const owner = as(TOKEN, "owner");
  const agent = as((await (await call("POST", "/tokens", "owner", { actor: A, projects: [name] })).json() as { token: string }).token, null);

  // The agent names only a.ts, as the fork point would; the row records the revert too.
  const res = await agent("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", passed: true, head: M, changedPaths: ["a.ts"] });
  expect(res.status, await res.clone().text()).toBe(200);
  const row = (await (await owner("GET", "/items/t1")).json() as { evidence: Record<string, unknown>[] }).evidence.at(-1);
  expect(row).toMatchObject({ grade: "observed", head: M, by: A, changedPaths: ["AGENTS.md", "a.ts"] });

  // So the gate treats the change as protected: it needs an independent review, and accept is refused.
  expect((await agent("POST", "/items/t1/submit", {})).status).toBe(200);
  const detail = await (await owner("GET", "/items/t1")).json() as { gate: { ready: boolean; needsAssessor: boolean; blockers: string[] } };
  expect(detail.gate).toMatchObject({ ready: false, needsAssessor: true });
  expect(detail.gate.blockers.join(" ")).toMatch(/protected path/);
  const accept = await owner("POST", "/items/t1/accept", { head: M });
  expect(accept.status).toBe(409);
  expect(await accept.json()).toMatchObject({ error: "not_ready" });
});

// PAVI's decision, 2026-10-06, through the Worker: the owner's approval is
// not the independent review, and only the owner, with the owner token and a
// reason, can override a missing one while accepting.
it("decision 2026-10-06: the accept route takes an override only from the owner, with a reason", async () => {
  const name = "override-route", A = "claude-code/opus-5.5", H0 = "0".repeat(40), H1 = "a".repeat(40), T0 = "1".repeat(40), T1 = "2".repeat(40);
  await project(name, ["AGENTS.md"]);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Rewrite the agent instructions", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: true, by: A, at: new Date().toISOString(), changedPaths: ["AGENTS.md"] });
  await L.submit("t1", A);
  const ARTIFACTS = gitStore({ [`${name}--t1`]: [{ hash: H1, parents: [H0], treeHash: T1 }, { hash: H0, parents: [], treeHash: T0 }] }, {});
  const as = (bearer: string, actor: string | null) => (method: string, path: string, body?: unknown) =>
    worker.fetch(new Request(`https://atelier.test/api/projects/${name}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { ...testEnv, ARTIFACTS } as typeof env);
  const owner = as(TOKEN, "owner");
  const reason = "No model of another family is available";

  expect((await owner("POST", "/items/t1/review", { head: H1, approve: true, note: "looks right" })).status).toBe(200);
  const plain = await owner("POST", "/items/t1/accept", { head: H1 });
  expect(plain.status).toBe(409);
  expect(await plain.json()).toMatchObject({ error: "not_ready" });
  // An agent token cannot reach the route; the owner token cannot accept as another actor.
  const agentToken = (await (await call("POST", "/tokens", "owner", { actor: "codex/gpt-6-astra", projects: [name] })).json() as { token: string }).token;
  const byAgent = await as(agentToken, null)("POST", "/items/t1/accept", { head: H1, overrideReview: reason });
  expect([byAgent.status, (await byAgent.json() as { error: string }).error]).toEqual([403, "owner_token_required"]);
  const asOther = await as(TOKEN, "codex/gpt-6-astra")("POST", "/items/t1/accept", { head: H1, overrideReview: reason });
  expect([asOther.status, (await asOther.json() as { error: string }).error]).toEqual([403, "not_project_owner"]);
  // A reason that is blank or not text is refused.
  for (const overrideReview of ["", "  ", true, 5, null]) {
    const res = await owner("POST", "/items/t1/accept", { head: H1, overrideReview });
    expect([overrideReview, res.status, (await res.json() as { error: string }).error]).toEqual([overrideReview, 400, "override_reason"]);
  }
  expect((await L.item("t1")).state).toBe("submitted");
  const accepted = await owner("POST", "/items/t1/accept", { head: H1, overrideReview: reason });
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  expect(await accepted.json()).toMatchObject({ state: "accepted", acceptedHead: H1, reviewOverride: { head: H1, by: "owner", reason } });
  const detail = await (await owner("GET", "/items/t1")).json() as { events: { kind: string; data: Record<string, unknown> }[]; reviews: unknown[] };
  expect(detail.events.find((e) => e.kind === "review.overridden")?.data).toMatchObject({ head: H1, reason });
  expect(detail.reviews).toHaveLength(1);
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
  const signedIn = await signIn(TOKEN, testEnv);
  const page = await worker.fetch(new Request(`https://atelier.test/p/${name}`, { headers: { cookie: signedIn } }), testEnv);
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
  // The fork's history as the consumer reads it: H2 on top of H0, the base.
  const artifacts = { get: async () => ({ info: async () => ({ defaultBranch: "main" }), log: async () => [{ hash: H2, parents: [H0] }, { hash: H0, parents: [] }], [Symbol.dispose]() {} }) } as unknown as Artifacts;
  const notice = (ref: string) => ({ type: "cf.artifacts.repo.pushed", source: { namespace: "atelier", repoName: `${name}--t1` }, payload: { ref, after: H1 } });
  const send = (body: unknown) => worker.queue({ messages: [{ body, ack() {}, retry() {} }] } as unknown as MessageBatch<unknown>, { ...env, ARTIFACTS: artifacts });
  await send(notice("refs/heads/main"));
  expect((await L.item("t1")).head).toBe(H0);
  await send(notice("refs/heads/master"));
  expect((await L.item("t1")).head).toBe(H2);
});

// The checks on the would-be merge through the Worker: each check names
// main's head as Atelier reads it, a merged check is bound to the main head
// it merged with, which must be on main's line, and it never stands in for
// the head's own run.
it("a merged check is recorded against both revisions, needs a main head on main's line, and blocks only after main moved past the head's own passing check", async () => {
  const name = "merged-check", A = "claude-code/opus-5.5";
  const H0 = "0".repeat(40), H1 = "a".repeat(40), H2 = "9".repeat(40), T0 = "1".repeat(40), T1 = "2".repeat(40);
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Edit the readme", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  await L.recordPush("t1", A, H1, H1);
  const store = (mainLog: { hash: string; parents: string[]; treeHash: string }[]) => gitStore({
    [name]: mainLog,
    [`${name}--t1`]: [{ hash: H1, parents: [H0], treeHash: T1 }, { hash: H0, parents: [], treeHash: T0 }],
  }, { [T0]: { "README.md": "b".repeat(40) }, [T1]: { "README.md": "c".repeat(40) } });
  const as = (ARTIFACTS: Artifacts, actor = A) => (method: string, path: string, body?: unknown) =>
    worker.fetch(new Request(`https://atelier.test/api/projects/${name}${path}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { ...testEnv, ARTIFACTS } as typeof env);
  const rows = async () => (await (await call("GET", `/projects/${name}/items/t1`, "owner")).json()) as { evidence: Record<string, unknown>[]; gate: { ready: boolean; blockers: string[] } };

  // Main at H0: the head's own check names it, and a merged check against it is shown, not counted.
  const atH0 = as(store([{ hash: H0, parents: [], treeHash: T0 }]));
  const own = await atH0("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", passed: true, head: H1 });
  expect(own.status, await own.clone().text()).toBe(200);
  expect((await rows()).evidence.at(-1)).toMatchObject({ grade: "observed", mainHead: H0, changedPaths: ["README.md"] });
  expect((await rows()).evidence.at(-1)).not.toHaveProperty("merged");
  const same = await atH0("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", passed: false, head: H1, merged: true, mainHead: H0 });
  expect(same.status, await same.clone().text()).toBe(200);
  expect((await rows()).evidence.at(-1)).toMatchObject({ grade: "observed", merged: true, mainHead: H0, passed: false, changedPaths: null, where: "runner" });
  expect((await atH0("POST", "/items/t1/submit", {})).status).toBe(200);
  expect((await rows()).gate).toMatchObject({ ready: true });
  // A main head that is not a commit on main is refused.
  const unknown = await atH0("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", passed: true, head: H1, merged: true, mainHead: "f".repeat(40) });
  expect(unknown.status, await unknown.clone().text()).toBe(409);
  expect(await unknown.json()).toMatchObject({ error: "unknown_main" });
  expect((await rows()).evidence).toHaveLength(2);

  // Main moves to H2. A merged check against the older H0 is still a commit on main and is kept, bound to H0; it merged with the main the head's own check saw, so it does not block.
  const moved = store([{ hash: H2, parents: [H0], treeHash: T0 }, { hash: H0, parents: [], treeHash: T0 }]);
  const atH2 = as(moved), ownerAtH2 = as(moved, "owner");
  const older = await atH2("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", passed: false, head: H1, merged: true, mainHead: H0 });
  expect(older.status, await older.clone().text()).toBe(200);
  expect((await rows()).evidence.at(-1)).toMatchObject({ merged: true, mainHead: H0 });
  expect((await rows()).gate).toMatchObject({ ready: true });
  // A merged check that fails against main's head now, after the head's own check passed against H0, blocks acceptance.
  expect((await atH2("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", passed: false, head: H1, merged: true, mainHead: H2 })).status).toBe(200);
  const blocked = (await rows()).gate;
  expect(blocked.ready).toBe(false);
  expect(blocked.blockers.join(" ")).toMatch(/failed on the merge with main at 99999999/);
  const refused = await ownerAtH2("POST", "/items/t1/accept", { head: H1 });
  expect(refused.status, await refused.clone().text()).toBe(409);
  expect(await refused.json()).toMatchObject({ error: "not_ready" });
  // A later merged run that passes clears it, and the head's own check rerun now names H2.
  expect((await atH2("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", passed: true, head: H1, merged: true, mainHead: H2 })).status).toBe(200);
  expect((await rows()).gate).toMatchObject({ ready: true });
  expect((await atH2("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", passed: true, head: H1 })).status).toBe(200);
  expect((await rows()).evidence.at(-1)).toMatchObject({ mainHead: H2, changedPaths: ["README.md"] });
  expect((await rows()).gate).toMatchObject({ ready: true });
  // A merged check for an item with no workspace has nothing to merge.
  await L.newItem("No workspace", [], "owner");
  await L.claim("t2", A);
  await L.recordPush("t2", A, H1, null);
  const noFork = await atH2("POST", "/items/t2/evidence", { kind: "check", claim: "npm test", passed: true, head: H1, merged: true, mainHead: H2 });
  expect(await noFork.json()).toMatchObject({ error: "no_fork" });
});

it("the sandbox route passes a merged run on to the runner, and a plain one as before", async () => {
  const name = "sandbox-merged", A = "claude-code/opus-5.5", H1 = "a".repeat(40);
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Run in the cloud", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, "0".repeat(40), A);
  await L.recordPush("t1", A, H1, H1);
  const started = async (body: unknown) => {
    const res = await call("POST", `/projects/${name}/items/t1/sandbox`, "owner", body);
    expect(res.status, await res.clone().text()).toBe(202);
    return (await res.json() as { state: { request: Record<string, unknown> } }).state.request;
  };
  expect(await started({ merged: true })).toMatchObject({ itemId: "t1", head: H1, merged: true });
  expect(await started({})).not.toHaveProperty("merged");
  expect(await started({ merged: "yes" })).not.toHaveProperty("merged");
});
