import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
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
  // Decisions selects the project by either name.
  expect((await get("/decisions?project=page-old&task=t1")).status).toBe(200);
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

// t687: the standard reviewer set is found by the name "atelier", so a rename
// out of or into that name would strand or misplace inherited admissions
// (astra's round-3 finding: reviewers stayed active in other projects after
// atelier was renamed, and withdrawing them no longer broadcast).
it("the standard reviewer project cannot be renamed, and no project can be renamed to its name", async () => {
  await project("atelier");
  await project("other-std");
  const out = await rename("atelier", "atelier-2");
  expect(out.status).toBe(409);
  expect(JSON.stringify(await out.json())).toContain("atelier can be renamed only with --release-name");
  const into = await rename("other-std", "atelier");
  expect(into.status).toBe(409);
  expect(((await (await call("GET", "/projects", "owner")).json()) as { name: string }[]).map((p) => p.name)).toContain("atelier");
});

// t687, astra's round-4 finding: removing atelier left its ledger but not its
// registration, so standardReviewers() read an empty set at version 0 and a
// withdrawal never reached the other projects.
it("the standard reviewer project cannot be removed, with or without --force, and stays registered", async () => {
  await project("atelier");
  for (const body of [{}, { force: true }]) {
    const out = await call("DELETE", "/projects/atelier", "owner", body);
    expect(out.status).toBe(409);
    expect(JSON.stringify(await out.json())).toContain("atelier cannot be removed");
  }
  expect(((await (await call("GET", "/projects", "owner")).json()) as { name: string }[]).map((p) => p.name)).toContain("atelier");
});

// Task t774: the old atelier project is renamed and a new one created under
// atelier. A rename with releaseName gives the old name up: it reaches no
// storage of the renamed project, the project created next under it is stored
// apart, and a token limited to it never reaches the new project by that name.
const release = (from: string, to: string) => call("POST", `/projects/${from}/rename`, "owner", { to, releaseName: true });
const withArtifacts = (seen: { forks: string[]; created: string[] }) => ({ ...testEnv, ARTIFACTS: artifacts(seen) }) as typeof env;
const bearer = (token: string, method: string, path: string, e: typeof env = testEnv) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
}), e);

it("releasing a name: the project stops answering to it, the name is free, and the new project there is stored apart", async () => {
  await project("rel-a", "Old A");
  await L("rel-a").newItem("Old work", [], "owner");
  const res = await release("rel-a", "rel-a-old");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ from: "rel-a", to: "rel-a-old", key: "rel-a", names: ["rel-a-old"], released: "rel-a", rescoped: 0, project: { name: "rel-a-old", repo: "rel-a" } });
  // The released name reaches nothing: not the project, not its Ledger.
  const gone = await call("GET", "/projects/rel-a", "owner");
  expect(gone.status).toBe(404);
  expect(((await gone.json()) as { error: string }).error).toBe("no_project");
  // Like any name no project has, it reads an empty Ledger of its own, never the renamed project's.
  expect(await (await call("GET", "/projects/rel-a/items", "owner")).json()).toEqual([]);
  expect(await I().resolveProject("rel-a")).toEqual({ name: "rel-a", key: "rel-a-2", names: ["rel-a-2", "rel-a"], registered: false, former: false });
  const listed = (await I().projects()).find((p) => p.name === "rel-a-old");
  expect(listed).toMatchObject({ key: "rel-a", repo: "rel-a" });
  expect(listed?.formerly).toBeUndefined();
  // The old project, its Ledger and its baseline stay reachable under the new name.
  expect(((await (await call("GET", "/projects/rel-a-old/items", "owner")).json()) as { title: string }[]).map((i) => i.title)).toEqual(["Old work"]);
  // A project created under the released name gets a key and a baseline of its own.
  const seen = { forks: [] as string[], created: [] as string[] };
  const created = await call("PUT", "/projects/rel-a", "owner", { title: "New A" }, withArtifacts(seen));
  expect(created.status).toBe(200);
  expect(((await created.json()) as { project: unknown }).project).toMatchObject({ name: "rel-a", repo: "rel-a-2", title: "New A" });
  expect(seen.created).toEqual(["rel-a-2"]);
  const both = (await I().projects()).filter((p) => p.name.startsWith("rel-a"));
  expect(both.map((p) => [p.name, p.key ?? p.name, p.repo])).toEqual([["rel-a", "rel-a-2", "rel-a-2"], ["rel-a-old", "rel-a", "rel-a"]]);
  expect(await I().resolveProject("rel-a")).toMatchObject({ name: "rel-a", key: "rel-a-2", registered: true, former: false });
  expect(await I().resolveProject("rel-a-old")).toMatchObject({ name: "rel-a-old", key: "rel-a", names: ["rel-a-old"], registered: true });
  expect(await call("GET", "/projects/rel-a/items", "owner").then((r) => r.json())).toEqual([]);
  expect(((await (await call("GET", "/projects/rel-a-old/items", "owner")).json()) as { title: string }[]).map((i) => i.title)).toEqual(["Old work"]);
  expect((await L("rel-a").project()).name).toBe("rel-a-old");
  expect((await L("rel-a-2").project()).name).toBe("rel-a");
  // The old name cannot be taken back by the renamed project while the new one holds it.
  const back = await rename("rel-a-old", "rel-a");
  expect(back.status).toBe(409);
  expect(((await back.json()) as { error: string }).error).toBe("name_taken");
});

it("without releaseName a rename keeps answering to the old name, as before", async () => {
  await project("keep-a");
  const res = await rename("keep-a", "keep-b");
  expect(await res.json()).toMatchObject({ names: ["keep-a", "keep-b"] });
  expect((await call("GET", "/projects/keep-a", "owner")).status).toBe(200);
  expect(await I().resolveProject("keep-a")).toMatchObject({ key: "keep-a", registered: true, former: true });
  // A released name taken by another project is still refused, as it is today.
  await project("keep-c");
  expect((await rename("keep-c", "keep-a")).status).toBe(409);
});

it("tokens limited to the released name are limited to the new name, and never reach the project that takes the name", async () => {
  await project("tok-a");
  await L("tok-a").newItem("Mine", [], "owner");
  const agentToken = await (await call("POST", "/tokens", "owner", { actor: "codex/gpt-6-astra", projects: ["tok-a", "elsewhere"] })).json() as { token: string; id: string };
  const runnerToken = await (await call("POST", "/tokens", "owner", { runner: "tok-runner", projects: ["tok-a"] })).json() as { token: string; id: string };
  const unrelated = await (await call("POST", "/tokens", "owner", { actor: "codex/gpt-6-astra", projects: ["elsewhere"] })).json() as { token: string };
  const unscoped = await (await call("POST", "/tokens", "owner", { actor: "codex/gpt-6-astra" })).json() as { token: string };
  const revoked = await (await call("POST", "/tokens", "owner", { actor: "codex/gpt-6-astra", projects: ["tok-a"] })).json() as { token: string; id: string };
  expect((await call("DELETE", `/tokens/${revoked.id}`, "owner")).status).toBe(200);
  const res = await release("tok-a", "tok-a-old");
  expect(await res.json()).toMatchObject({ released: "tok-a", rescoped: 3 });
  const scopes = Object.fromEntries(((await (await call("GET", "/tokens", "owner")).json()) as { id: string; projects?: string[] }[]).map((t) => [t.id, t.projects]));
  expect(scopes[agentToken.id]).toEqual(["tok-a-old", "elsewhere"]);
  expect(scopes[runnerToken.id]).toEqual(["tok-a-old"]);
  expect(scopes[revoked.id]).toEqual(["tok-a-old"]);
  // The token made for the old project still works for it, under its new name.
  expect((await bearer(agentToken.token, "GET", "/projects/tok-a-old/items")).status).toBe(200);
  // The name now reaches no project, and later the new one: neither token gets in.
  const seen = { forks: [] as string[], created: [] as string[] };
  expect((await call("PUT", "/projects/tok-a", "owner", {}, withArtifacts(seen))).status).toBe(200);
  for (const token of [agentToken.token, unrelated.token]) {
    const refused = await bearer(token, "GET", "/projects/tok-a/items");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("project_scope");
  }
  expect((await bearer(agentToken.token, "GET", "/projects/tok-a-old/items")).status).toBe(200);
  const listing = ((await (await bearer(agentToken.token, "GET", "/projects")).json()) as { name: string }[]).map((p) => p.name);
  expect(listing).toEqual(["tok-a-old"]);
  // A runner token limited to the old project is refused at the new one too, and an unscoped token or one made after the release reaches it.
  expect((await bearer(runnerToken.token, "GET", "/projects/tok-a")).status).toBe(403);
  expect((await bearer(unscoped.token, "GET", "/projects/tok-a/items")).status).toBe(200);
  const fresh = await (await call("POST", "/tokens", "owner", { actor: "codex/gpt-6-astra", projects: ["tok-a"] })).json() as { token: string };
  expect((await bearer(fresh.token, "GET", "/projects/tok-a/items")).status).toBe(200);
  expect((await bearer(fresh.token, "GET", "/projects/tok-a-old/items")).status).toBe(403);
});

it("a runner offer limited by a rescoped token serves the old project under its new name only", async () => {
  await project("off-a");
  const runnerToken = await (await call("POST", "/tokens", "owner", { runner: "off-runner", projects: ["off-a"] })).json() as { token: string };
  expect((await release("off-a", "off-a-old")).status).toBe(200);
  expect((await call("PUT", "/projects/off-a", "owner", {}, withArtifacts({ forks: [], created: [] }))).status).toBe(200);
  await I().askQueue({ runner: "home:off-runner", agents: [], projects: ["off-a-old"] } as never, new Date().toISOString());
  const names = (await I().askQueue(null, new Date().toISOString())).filter((p) => p.name.startsWith("off-a")).map((p) => [p.name, p.formerly ?? null]);
  expect(names).toEqual([["off-a", ["off-a-2"]], ["off-a-old", null]]);
  expect(await (await bearer(runnerToken.token, "GET", "/projects/off-a-old")).status).toBe(200);
  expect(await (await bearer(runnerToken.token, "GET", "/projects/off-a")).status).toBe(403);
});

it("a released name keeps off every key and Ledger already in use, and a former name releases the current one", async () => {
  // rel-b-2 is taken as a project name, rel-b-3 is a key another project's name maps to, rel-b-4 holds a retained Ledger.
  await project("rel-b");
  await project("rel-b-2");
  await project("rel-b-3x");
  expect((await rename("rel-b-3x", "rel-b-3y")).status).toBe(200);
  await I().renameProject("rel-b-3y", "rel-b-4");
  await project("rel-b-5");
  expect((await call("DELETE", "/projects/rel-b-5", "owner")).status).toBe(200);
  await L("rel-b-6").setProject({ name: "rel-b-6", repo: "rel-b-6", policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() } as never, "owner");
  const res = await release("rel-b", "rel-b-old");
  expect(res.status).toBe(200);
  expect((await I().resolveProject("rel-b")).key).toBe("rel-b-3");
  // rel-b-3 was free, so it is taken; check the ones that were not skipped by releasing again where they are the only candidates.
  await project("rel-c");
  await project("rel-c-2");
  await L("rel-c-3").setProject({ name: "rel-c-3", repo: "rel-c-3", policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() } as never, "owner");
  expect((await release("rel-c", "rel-c-old")).status).toBe(200);
  expect((await I().resolveProject("rel-c")).key).toBe("rel-c-4");
  // A former name cannot be released: the current one is.
  await project("rel-d");
  expect((await rename("rel-d", "rel-d2")).status).toBe(200);
  await runInDurableObject(I(), async (instance) => {
    expect(() => instance.renameProject("rel-d", "rel-d3", "rel-d-2")).toThrow(/former name of rel-d2/);
  });
  expect((await I().projects()).find((p) => p.name === "rel-d2")).toMatchObject({ key: "rel-d", formerly: ["rel-d"] });
  // The route resolves the name it is given, so a former name releases the project's current one.
  const viaFormer = await release("rel-d", "rel-d3");
  expect(await viaFormer.json()).toMatchObject({ from: "rel-d2", to: "rel-d3", released: "rel-d2" });
  expect((await I().resolveProject("rel-d2")).registered).toBe(false);
  expect((await I().resolveProject("rel-d")).registered).toBe(true);
  // A malformed flag is refused before anything changes.
  const bad = await call("POST", "/projects/rel-d3/rename", "owner", { to: "rel-d4", releaseName: "yes" });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("bad_release");
  expect((await I().resolveProject("rel-d3")).name).toBe("rel-d3");
});

it("releasing the current name of a project already renamed keeps its original key as a name, and the released name goes to a fresh key", async () => {
  await project("chn-1");
  expect((await rename("chn-1", "chn-2")).status).toBe(200);
  const res = await release("chn-2", "chn-3");
  expect(await res.json()).toMatchObject({ from: "chn-2", to: "chn-3", key: "chn-1", names: ["chn-1", "chn-3"], released: "chn-2" });
  expect(await I().resolveProject("chn-2")).toMatchObject({ key: "chn-2-2", registered: false });
  expect(await I().resolveProject("chn-1")).toMatchObject({ name: "chn-3", key: "chn-1", registered: true, former: true });
  expect((await call("GET", "/projects/chn-1", "owner")).status).toBe(200);
  expect((await call("GET", "/projects/chn-2", "owner")).status).toBe(404);
  // A project created under chn-2 is stored under chn-2-2, with a baseline of that name.
  const seen = { forks: [] as string[], created: [] as string[] };
  const made = await call("PUT", "/projects/chn-2", "owner", {}, withArtifacts(seen));
  expect(((await made.json()) as { project: unknown }).project).toMatchObject({ name: "chn-2", repo: "chn-2-2" });
  expect(seen.created).toEqual(["chn-2-2"]);
  expect((await I().projects()).find((p) => p.name === "chn-3")).toMatchObject({ key: "chn-1", formerly: ["chn-1"], repo: "chn-1" });
});

it("renaming back to the project's own key while releasing names it again, and a retry after only the index took the rename finishes it", async () => {
  await project("bk-1");
  expect((await release("bk-1", "bk-2")).status).toBe(200);
  // bk-1 now belongs to a fresh key, so the project cannot take it back until that is a project of its own: refused, not silently shared.
  const refused = await rename("bk-2", "bk-1");
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("name_taken");
  // The retry of an interrupted rename-and-release addresses the new name and ignores the flag.
  await project("bk-3");
  await I().renameProject("bk-3", "bk-4", "bk-3-2");
  const again = await call("POST", "/projects/bk-4/rename", "owner", { to: "bk-4", releaseName: true });
  expect(again.status).toBe(200);
  expect((await L("bk-3").project()).name).toBe("bk-4");
});

// Task t774, criterion 4: the standard project (atelier, t687) may be renamed
// only by releasing its name, and the project that takes the name inherits its
// reviewer admissions, so no project loses the reviewers it inherits.
it("the standard project is renamed only with releaseName, and other projects keep the same inherited reviewers before the release, while no project holds the name, and once the new project exists", async () => {
  const entry = (id: string) => ({ id, aliases: [], harness: "opencode", where: "home", endpoint: "http://x/v1", provider: "ai-studio", family: familyOf(id), note: "", addedBy: "owner", addedAt: new Date().toISOString() }) as ModelEntry;
  const pool = [entry("Qwen3-Coder-Next"), entry("gemini-4-argon")];
  await project("atelier");
  await project("std-other");
  const refusal = async (res: Response) => {
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe("standard_project");
    expect(body.detail).toMatch(/only with --release-name/);
  };
  await refusal(await rename("atelier", "atelier-x"));
  await refusal(await rename("std-other", "atelier"));
  await refusal(await release("std-other", "atelier"));
  expect((await I().resolveProject("atelier")).registered).toBe(true);
  expect(await I().standardOrigin()).toBeNull();
  const home = L("atelier");
  await home.admitReviewer("Qwen3-Coder-Next", true, "Qualified", "owner", pool);
  await home.admitReviewer("gemini-4-argon", true, "Qualified", "owner", pool);
  await home.admitReviewer("gemini-4-argon", false, "Retired", "owner", pool);
  const homeBefore = await home.standardReviewersSnapshot();
  const sendFromHome = async () => { const s = await home.standardReviewersSnapshot(); await L("std-other").setStandardReviewers(s.admissions.filter((a) => a.active), s.version); };
  await sendFromHome();
  const inherited = async (name: string) => (await L(name).reviewerListing()).map(({ id, active, inherited }) => ({ id, active, inherited }));
  const before = await inherited("std-other");
  expect(before).toEqual([{ id: "Qwen3-Coder-Next", active: true, inherited: "atelier" }]);

  expect((await release("atelier", "atelier-former")).status).toBe(200);
  expect(await I().standardOrigin()).toBe("atelier");
  // No project holds the name: a project made now still gets the old standard set, not an empty one.
  const seen = { forks: [] as string[], created: [] as string[] };
  expect((await call("PUT", "/projects/std-between", "owner", {}, withArtifacts(seen))).status).toBe(200);
  expect(await inherited("std-between")).toEqual(before);
  expect(await inherited("std-other")).toEqual(before);

  // The new project under the name starts with the old project's records, withdrawals included, and says where they came from.
  expect((await call("PUT", "/projects/atelier", "owner", {}, withArtifacts(seen))).status).toBe(200);
  const fresh = L("atelier-2");
  expect((await fresh.project()).name).toBe("atelier");
  const copied = await fresh.standardReviewersSnapshot();
  expect(copied.admissions).toEqual(homeBefore.admissions);
  expect(copied.version).toBeGreaterThan(homeBefore.version);
  expect(copied.inherited).toBe("atelier");
  const events = (await fresh.events() as unknown as { kind: string; data: { from: string; admissions: { id: string; active: boolean }[] } }[]).filter((e) => e.kind === "reviewers.inherited");
  expect(events).toHaveLength(1);
  expect(events[0].data.from).toBe("atelier");
  expect(events[0].data.admissions.map((a) => [a.id, a.active])).toEqual([["Qwen3-Coder-Next", true], ["gemini-4-argon", false]]);
  // A project made after it reads the new project's set, which is the same; running init again copies nothing twice.
  expect((await call("PUT", "/projects/std-after", "owner", {}, withArtifacts(seen))).status).toBe(200);
  expect((await call("PUT", "/projects/atelier", "owner", {}, withArtifacts(seen))).status).toBe(200);
  expect(await inherited("std-after")).toEqual(before);
  expect(await inherited("std-other")).toEqual(before);
  expect((await fresh.events() as unknown as { kind: string }[]).filter((e) => e.kind === "reviewers.inherited")).toHaveLength(1);
  // An admission made in the new project reaches the others as it did in the old.
  await fresh.admitReviewer("gemini-4-argon", true, "Back", "owner", pool);
  expect((await fresh.standardReviewersSnapshot()).version).toBeGreaterThan(copied.version);
});

// Task t774, round 3. keyFree compared names exactly, but a baseline is
// named after repoName(key), which lowercases, sanitises and caps at 63.
it("a released key is checked as the repository init would name it: Demo skips demo-2, and a name too long for a suffix refuses the release", async () => {
  const record = (name: string, repo: string) => ({ name, repo, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() });
  for (const [name, repo] of [["demo-2", "demo-2"], ["Demo", "demo"]]) { await L(name).setProject(record(name, repo) as never, "owner"); await I().registerProject(record(name, repo) as never); }
  const res = await release("Demo", "demo-old");
  expect(res.status).toBe(200);
  expect(await I().resolveProject("Demo")).toMatchObject({ key: "Demo-3", registered: false });
  const made = await call("PUT", "/projects/Demo", "owner", {}, withArtifacts({ forks: [], created: [] }));
  expect(made.status).toBe(200);
  expect(((await made.json()) as { project: unknown }).project).toMatchObject({ name: "Demo", repo: "demo-3" });
  // 62 characters plus "-2" is 64, more than a repository can be named.
  const long = "l".repeat(62);
  await project(long);
  const refused = await release(long, "short-new-name");
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("release_name_too_long");
  expect(await I().resolveProject(long)).toMatchObject({ name: long, key: long, registered: true });
  expect((await I().projects()).some((p) => p.name === "short-new-name")).toBe(false);
  // 61 characters plus "-2" is 63, which fits.
  const edge = "e".repeat(61);
  await project(edge);
  expect((await release(edge, "edge-old")).status).toBe(200);
  expect((await I().resolveProject(edge)).key).toBe(`${edge}-2`);
});

it("after a release and reuse, an old page link and an owner-token runner config naming the name reach the replacement project", async () => {
  await project("reuse-a");
  await L("reuse-a").newItem("Old task", [], "owner");
  expect((await release("reuse-a", "reuse-a-old")).status).toBe(200);
  expect((await call("PUT", "/projects/reuse-a", "owner", {}, withArtifacts({ forks: [], created: [] }))).status).toBe(200);
  await L("reuse-a-2").newItem("Replacement task", [], "owner");
  const signedIn = await cookie();
  const get = (path: string) => worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie: signedIn } }), testEnv);
  // The link is not a redirect to the renamed project: it is the replacement's own page.
  const page = await get("/p/reuse-a/tasks");
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Replacement task");
  expect(html).not.toContain("Old task");
  expect(html).toContain('href="/p/reuse-a/t1"');
  const old = await get("/p/reuse-a-old/tasks");
  expect(old.status).toBe(200);
  expect(await old.text()).toContain("Old task");
  // A runner polling with the owner token and no scope is offered every project's queue, each entry under the name it answers to now:
  // the name a config lists is the replacement's, and the renamed project's work is under its new name.
  await L("reuse-a").dispatch("t1", "owner", { to: "home" });
  await L("reuse-a-2").dispatch("t1", "owner", { to: "home" });
  const polled = await call("POST", "/queue", "owner", { runner: "home:reuse-runner", agents: [{ agent: "opencode", models: ["glm-5.3"] }], projects: ["reuse-a"] });
  expect(polled.status, await polled.clone().text()).toBe(200);
  const queue = await polled.json() as { project: string; item: { title: string } }[];
  expect(queue.filter((q) => q.project === "reuse-a").map((q) => q.item.title)).toEqual(["Replacement task"]);
  expect(queue.filter((q) => q.project === "reuse-a-old").map((q) => q.item.title)).toEqual(["Old task"]);
});
