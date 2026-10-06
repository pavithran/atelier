import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

// A project renamed on the server keeps its Ledger and repositories under the
// name it was created with, and answers to every name it has had. These specs
// drive the rename route and the resolution of former names through the
// Worker's fetch handler, with Artifacts stubbed where a route reaches it.

const TOKEN = "rename-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (key: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));

function call(method: string, path: string, actor: string, body?: unknown, e: typeof env = testEnv) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
}

async function project(name: string, title?: string) {
  const record = { name, repo: name, ...(title ? { title } : {}), policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
}

const rename = (from: string, to: unknown, actor = "owner") => call("POST", `/projects/${from}/rename`, actor, { to });

// The Artifacts calls a claim or an init makes, stubbed so the route runs to completion here.
function artifacts(seen: { forks: string[]; created: string[] }) {
  return {
    create: async (repo: string) => { seen.created.push(repo); },
    get: async () => ({
      fork: async (name: string) => { seen.forks.push(name); },
      log: async () => [{ hash: "0".repeat(40), parents: [] }],
      info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
      createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
      revokeToken: async () => {},
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
}

function cookie() {
  return signIn(TOKEN, testEnv);
}

it("the owner renames a project; both names reach the same Ledger, and an answer through the old one names the new", async () => {
  await project("old-a", "Old A");
  await L("old-a").newItem("Keep me", ["src/**"], "owner");
  const res = await rename("old-a", "new-a");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ from: "old-a", to: "new-a", key: "old-a", names: ["old-a", "new-a"], project: { name: "new-a", repo: "old-a", title: "Old A" } });
  // The index lists the project under its new name, with where it is stored and what it was called.
  const listed = await (await call("GET", "/projects", "owner")).json() as { name: string }[];
  expect(listed).toContainEqual(expect.objectContaining({ name: "new-a", key: "old-a", formerly: ["old-a"], repo: "old-a", title: "Old A" }));
  expect(listed.some((p) => p.name === "old-a")).toBe(false);
  // Both names read the same items; through the old one the answer says the new name.
  const viaNew = await call("GET", "/projects/new-a", "owner");
  expect(viaNew.status).toBe(200);
  expect(viaNew.headers.get("x-atelier-project")).toBeNull();
  expect(((await viaNew.json()) as { items: { title: string }[] }).items.map((i) => i.title)).toEqual(["Keep me"]);
  const viaOld = await call("GET", "/projects/old-a", "owner");
  expect(viaOld.status).toBe(200);
  expect(viaOld.headers.get("x-atelier-project")).toBe("new-a");
  const body = await viaOld.json() as { project: { name: string }; items: { title: string }[] };
  expect(body.project.name).toBe("new-a");
  expect(body.items.map((i) => i.title)).toEqual(["Keep me"]);
  // The project's own record follows, with the rename in its history; nothing was copied to a Ledger under the new name.
  expect((await L("old-a").project()).name).toBe("new-a");
  expect((await L("old-a").events() as unknown as { kind: string; data: { from: string; to: string } }[]).find((e) => e.kind === "project.renamed")?.data).toEqual({ from: "old-a", to: "new-a" });
  const empty = await L("new-a").project().then(() => null, (e: unknown) => e as Error);
  expect(String(empty)).toContain("no_project");
  // Where the project stands, and the inbox, name it as it is now.
  expect(((await (await call("GET", "/projects/old-a/standing", "owner")).json()) as { project: { name: string } }).project.name).toBe("new-a");
  await L("old-a").newItem("Waiting", [], "owner");
  await L("old-a").dispatch("t2", "owner", { to: "home" });
  const queue = await (await call("GET", "/queue", "owner")).json() as { project: string; item: { id: string } }[];
  expect(queue.find((q) => q.item.id === "t2" && ["old-a", "new-a"].includes(q.project))?.project).toBe("new-a");
});

it("an agent token limited to the old name writes through either name, and new forks are named after the key", async () => {
  await project("old-b");
  await L("old-b").newItem("Take me", ["src/**"], "owner");
  await L("old-b").newItem("And me", ["docs/**"], "owner");
  const issued = await (await call("POST", "/tokens", "owner", { actor: "codex/gpt-6-astra", projects: ["old-b"] })).json() as { token: string };
  expect((await rename("old-b", "new-b")).status).toBe(200);
  const seen = { forks: [] as string[], created: [] as string[] };
  const agent = (method: string, path: string, token = issued.token, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...testEnv, ARTIFACTS: artifacts(seen) } as typeof env);
  const viaOld = await agent("POST", "/projects/old-b/items/t1/claim", issued.token, {});
  expect(viaOld.status).toBe(200);
  expect(viaOld.headers.get("x-atelier-project")).toBe("new-b");
  expect(((await viaOld.json()) as { item: { owner: string } }).item.owner).toBe("codex/gpt-6-astra");
  expect((await agent("POST", "/projects/new-b/items/t2/claim", issued.token, {})).status).toBe(200);
  expect(seen.forks).toEqual(["old-b--t1", "old-b--t2"]);
  expect((await L("old-b").item("t2")).fork).toBe("old-b--t2");
  // The token's listing shows the project once, under its new name.
  expect(((await (await agent("GET", "/projects")).json()) as { name: string }[]).map((p) => p.name)).toEqual(["new-b"]);
  // A token issued for the new name reaches the project through the old one; one for another project does not.
  const later = await (await call("POST", "/tokens", "owner", { actor: "claude-code/opus-5.5", projects: ["new-b"] })).json() as { token: string };
  expect((await agent("GET", "/projects/old-b/items", later.token)).status).toBe(200);
  const other = await (await call("POST", "/tokens", "owner", { actor: "claude-code/opus-5.5", projects: ["elsewhere"] })).json() as { token: string };
  expect((await agent("GET", "/projects/old-b/items", other.token)).status).toBe(403);
  // Renaming needs the owner token.
  const refused = await agent("POST", "/projects/new-b/rename", issued.token, { to: "mine" });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toBe("owner_token_required");
});

it("a rename is refused onto a registered name, a former name of another project, a retained Ledger, the same name, a bad name, from an unknown project, and by anyone but the owner", async () => {
  await project("clash-a");
  await project("clash-b");
  const refusal = async (res: Response, status: number, error: string, detail?: RegExp) => {
    expect(res.status).toBe(status);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe(error);
    if (detail) expect(body.detail).toMatch(detail);
  };
  await refusal(await rename("clash-a", "clash-b"), 409, "name_taken", /clash-b is the name of clash-b/);
  expect((await rename("clash-b", "clash-c")).status).toBe(200);
  await refusal(await rename("clash-a", "clash-b"), 409, "name_taken", /a former name of clash-c/);
  await refusal(await rename("clash-a", "clash-c"), 409, "name_taken", /clash-c is the name of clash-c/);
  // A removed project keeps its names and its Ledger, so neither its last name nor an earlier one is free.
  await project("clash-gone");
  expect((await rename("clash-gone", "clash-went")).status).toBe(200);
  expect((await call("DELETE", "/projects/clash-went", "owner")).status).toBe(200);
  await refusal(await rename("clash-a", "clash-gone"), 409, "name_taken", /Ledger is kept under that name/);
  await refusal(await rename("clash-a", "clash-went"), 409, "name_taken", /a name of a removed project, stored under clash-gone/);
  await refusal(await rename("clash-a", "clash-a"), 400, "same_name");
  await refusal(await rename("clash-none", "clash-x"), 404, "no_project");
  for (const bad of ["", " x", "x ", "a/b", 7, null, undefined, "..."]) await refusal(await rename("clash-a", bad), 400, "bad_name");
  await refusal(await rename("clash-a", "clash-z", "codex/gpt-6-astra"), 403, "not_project_owner");
  const names = ((await (await call("GET", "/projects", "owner")).json()) as { name: string }[]).map((p) => p.name).filter((n) => n.startsWith("clash-"));
  expect(names).toEqual(["clash-a", "clash-c"]);
  expect((await L("clash-a").project()).name).toBe("clash-a");
});

it("renaming back restores the old name, and after a second rename every earlier name resolves in one step", async () => {
  await project("chain-1");
  await L("chain-1").newItem("Through the chain", [], "owner");
  expect(await I().resolveProject("nobody")).toEqual({ name: "nobody", key: "nobody", names: ["nobody"], registered: false, former: false });
  expect((await rename("chain-1", "chain-2")).status).toBe(200);
  const back = await rename("chain-2", "chain-1");
  expect(back.status).toBe(200);
  expect(await back.json()).toMatchObject({ from: "chain-2", to: "chain-1", key: "chain-1", names: ["chain-1", "chain-2"] });
  expect(await I().resolveProject("chain-1")).toEqual({ name: "chain-1", key: "chain-1", names: ["chain-1", "chain-2"], registered: true, former: false });
  expect(await I().resolveProject("chain-2")).toMatchObject({ name: "chain-1", key: "chain-1", registered: true, former: true });
  const restored = (await I().projects()).find((p) => p.name === "chain-1");
  expect(restored).toMatchObject({ formerly: ["chain-2"] });
  expect(restored?.key).toBeUndefined();
  expect((await L("chain-1").project()).name).toBe("chain-1");
  // Twice forward: each name reaches the project, and the answer names the current one.
  expect((await rename("chain-1", "chain-2")).status).toBe(200);
  expect((await rename("chain-2", "chain-3")).status).toBe(200);
  for (const name of ["chain-1", "chain-2", "chain-3"]) {
    const res = await call("GET", `/projects/${name}`, "owner");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { project: { name: string }; items: unknown[] })).toMatchObject({ project: { name: "chain-3" }, items: [expect.objectContaining({ title: "Through the chain" })] });
    expect(res.headers.get("x-atelier-project")).toBe(name === "chain-3" ? null : "chain-3");
  }
  expect((await I().projects()).find((p) => p.name === "chain-3")).toMatchObject({ key: "chain-1", formerly: ["chain-1", "chain-2"] });
  // A rename addressed by a former name acts on the project it belongs to now.
  const viaFormer = await rename("chain-1", "chain-4");
  expect(viaFormer.status).toBe(200);
  expect(await viaFormer.json()).toMatchObject({ from: "chain-3", to: "chain-4", key: "chain-1", names: ["chain-1", "chain-2", "chain-3", "chain-4"] });
  expect((await rename("chain-2", "chain-4")).status).toBe(400);
});

it("pages under a former name redirect to the current one with their path and query, and a form posted under it acts", async () => {
  await project("page-old");
  await L("page-old").newItem("Shown", [], "owner");
  await L("page-old").claim("t1", "codex/gpt-6-astra");
  expect((await rename("page-old", "page-new")).status).toBe(200);
  const signedIn = await cookie();
  const get = (path: string, e: typeof env = testEnv) => worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie: signedIn } }), e);
  for (const [from, to] of [["/p/page-old", "/p/page-new"], ["/p/page-old/t1?x=1", "/p/page-new/t1?x=1"], ["/p/page-old/t1/code/src", "/p/page-new/t1/code/src"], ["/p/page-old/log", "/p/page-new/log"]]) {
    const res = await get(from);
    expect(res.status, from).toBe(301);
    expect(res.headers.get("location")).toBe(to);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
  const page = await get("/p/page-new/tasks");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('href="/p/page-new/t1"');
  const task = await get("/p/page-new/t1");
  expect(task.status).toBe(200);
  expect(await task.text()).toContain('action="/ui/page-new/t1/release"');
  // Decisions selects the project by either name; the showcase setting may still use the old one.
  expect((await get("/decisions?project=page-old&task=t1")).status).toBe(200);
  const show = await worker.fetch(new Request("https://atelier.test/showcase"), { ...testEnv, SHOWCASE: "page-old" } as typeof env);
  expect(show.status).toBe(200);
  expect(await show.text()).toContain("page-new");
  // A form from a page opened before the rename still acts, and lands on the page under the new name.
  const posted = await worker.fetch(new Request("https://atelier.test/ui/page-old/t1/release", {
    method: "POST", headers: { cookie: signedIn, origin: "https://atelier.test", "content-type": "application/x-www-form-urlencoded" }, body: "note=done&head=",
  }), testEnv);
  expect(posted.status).toBe(303);
  expect(posted.headers.get("location")).toBe("https://atelier.test/p/page-new/t1");
  expect((await L("page-old").item("t1")).state).toBe("open");
});

it("a later init through either name keeps the baseline and the key, and a removed project is found again under its new name", async () => {
  await project("init-old");
  await L("init-old").newItem("Kept item", [], "owner");
  expect((await rename("init-old", "init-new")).status).toBe(200);
  const seen = { forks: [] as string[], created: [] as string[] };
  const put = (name: string, body: unknown) => call("PUT", `/projects/${name}`, "owner", body, { ...testEnv, ARTIFACTS: artifacts(seen) } as typeof env);
  const viaOld = await put("init-old", { title: "Renamed" });
  expect(viaOld.status).toBe(200);
  expect(viaOld.headers.get("x-atelier-project")).toBe("init-new");
  expect(((await viaOld.json()) as { project: unknown }).project).toMatchObject({ name: "init-new", repo: "init-old", title: "Renamed" });
  expect(seen.created).toEqual(["init-old"]);
  const listed = await (await call("GET", "/projects", "owner")).json() as { name: string }[];
  expect(listed.filter((p) => p.name.startsWith("init-")).map((p) => p.name)).toEqual(["init-new"]);
  expect(listed.find((p) => p.name === "init-new")).toMatchObject({ key: "init-old", formerly: ["init-old"], title: "Renamed" });
  // Removal retains the Ledger and the names: an init under the new name registers the same project again.
  expect((await call("DELETE", "/projects/init-new", "owner")).status).toBe(200);
  expect(((await (await call("GET", "/projects", "owner")).json()) as { name: string }[]).some((p) => p.name.startsWith("init-"))).toBe(false);
  const again = await put("init-new", {});
  expect(again.status).toBe(200);
  expect(((await again.json()) as { project: unknown }).project).toMatchObject({ name: "init-new", repo: "init-old", title: "Renamed" });
  expect(seen.created).toEqual(["init-old", "init-old"]);
  expect(((await (await call("GET", "/projects/init-new/items", "owner")).json()) as { title: string }[]).map((i) => i.title)).toEqual(["Kept item"]);
  expect(((await (await call("GET", "/projects", "owner")).json()) as { name: string }[]).find((p) => p.name === "init-new")).toMatchObject({ key: "init-old", formerly: ["init-old"] });
});

// Task t108: a rename whose index write succeeded and whose record write
// failed, run again under the old name, answered from=<new name>, so the
// CLI found no local entry under that name to move and kept the old one.
it("a rename run again after only the index took it finishes it, and answers with the name the request used", async () => {
  await project("half-old");
  await L("half-old").newItem("Still here", [], "owner");
  // The index's write: the project's own record still has the old name.
  await I().renameProject("half-old", "half-new");
  expect((await L("half-old").project()).name).toBe("half-old");
  const res = await rename("half-old", "half-new");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ from: "half-old", to: "half-new", key: "half-old", names: ["half-old", "half-new"], project: { name: "half-new", repo: "half-old" } });
  expect((await L("half-old").project()).name).toBe("half-new");
  // Once finished, the same request is refused as a rename to the name it has.
  const again = await rename("half-old", "half-new");
  expect(again.status).toBe(400);
  expect(((await again.json()) as { error: string }).error).toBe("same_name");
});

// Task t108: resolveProject ran one names query per registered project on
// every request that named a project.
it("resolving a name reads the names table once, however many projects are registered", async () => {
  for (let n = 0; n < 30; n++) await project(`many-${n}`);
  expect((await rename("many-7", "many-seven")).status).toBe(200);
  await runInDurableObject(I(), async (instance) => {
    const held = instance as unknown as { sql: SqlStorage };
    const sql = held.sql;
    const reads: string[] = [];
    held.sql = { exec: (query: string, ...bindings: unknown[]) => { if (/\bnames\b/.test(query)) reads.push(query); return sql.exec(query, ...bindings); } } as unknown as SqlStorage;
    try {
      const resolve = (name: string) => { reads.length = 0; const ref = instance.resolveProject(name); return { ref, reads: reads.length }; };
      expect(resolve("nobody-at-all")).toEqual({ ref: { name: "nobody-at-all", key: "nobody-at-all", names: ["nobody-at-all"], registered: false, former: false }, reads: 1 });
      expect(resolve("many-7")).toEqual({ ref: { name: "many-seven", key: "many-7", names: ["many-7", "many-seven"], registered: true, former: true }, reads: 1 });
      expect(resolve("many-seven")).toEqual({ ref: { name: "many-seven", key: "many-7", names: ["many-7", "many-seven"], registered: true, former: false }, reads: 1 });
      expect(resolve("many-29")).toEqual({ ref: { name: "many-29", key: "many-29", names: ["many-29"], registered: true, former: false }, reads: 1 });
    } finally {
      held.sql = sql;
    }
  });
});

// Task t167: projects() read the names table twice per project (the key and
// the former names of each listed record), so a list of N projects ran 2N
// queries on it.
it("listing the projects reads the names table once, however many are registered", async () => {
  for (let n = 0; n < 30; n++) await project(`many-list-${n}`);
  expect((await rename("many-list-7", "many-list-seven")).status).toBe(200);
  await runInDurableObject(I(), async (instance) => {
    const held = instance as unknown as { sql: SqlStorage };
    const sql = held.sql;
    const reads: string[] = [];
    held.sql = { exec: (query: string, ...bindings: unknown[]) => { if (/\bnames\b/.test(query)) reads.push(query); return sql.exec(query, ...bindings); } } as unknown as SqlStorage;
    try {
      const listed = instance.projects() as { name: string; key?: string; formerly?: string[] }[];
      expect(reads.length).toBe(1);
      expect(listed.filter((p) => p.name.startsWith("many-list-"))).toHaveLength(30);
      const renamed = listed.find((p) => p.name === "many-list-seven")!;
      expect(renamed.key).toBe("many-list-7");
      expect(renamed.formerly).toEqual(["many-list-7"]);
      const plain = listed.find((p) => p.name === "many-list-0")!;
      expect(plain.key).toBeUndefined();
      expect(plain.formerly).toBeUndefined();
    } finally {
      held.sql = sql;
    }
  });
});
