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
