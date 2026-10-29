import { execFileSync } from "node:child_process";
import { env, server } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";

// A build's runner merges current main before it submits (t435), and a
// check or review reads the task's branch and the branch it merges into: each
// through a read grant, POST /projects/NAME/git-token { kind: "read" }, which
// a runner token may ask for in any project it serves. With an item named,
// the answer also names the item's branch (null before its first claim), the
// branch it merges into, and its recorded head and base; the grant reads
// every branch of the project's repository either way. The old baseline-token,
// read-token and base-token routes are gone (Atelier 2.0, task 13). Every
// credential here is a dummy.

const OWNER = "baseline-token-owner", ACTOR = "codex/gpt-6-astra";
let serial = 0;

async function setup() {
  const name = `baseline-token-${++serial}`;
  const index: any = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  const L: any = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const project = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(project, "owner");
  await index.registerProject(project);
  await L.newItem("Build", [], "owner");
  await L.newItem("Unrelated", [], "owner");
  // A runner's claim branches t1 from main, so main needs a commit.
  const dir = (server as unknown as { git: { repo(key: string, branch: string): string } }).git.repo(name, "main");
  const author = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const first = execFileSync("git", ["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "first"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...author } }).trim();
  execFileSync("git", ["update-ref", "refs/heads/main", first], { cwd: dir });
  await L.dispatch("t1", "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  const bindings = { ...env, ATELIER_TOKEN: OWNER } as typeof env;
  const request = (method: string, path: string, token: string, actor: string | null, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}), ...(token === OWNER ? { "x-atelier-acting": "claude-code/opus-5.5" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings);
  const issued = await request("POST", "/tokens", OWNER, "owner", { runner: "HOME:Studio", projects: [name] });
  expect(issued.status).toBe(201);
  const token = await issued.json() as { token: string; id: string };
  const api = (method: string, path: string, body?: unknown) => request(method, path, token.token, ACTOR, body);
  const offer = { runner: "home:studio", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build", "plan", "review"] };
  expect((await api("POST", "/queue", offer)).status).toBe(200);
  const claim = await api("POST", `/projects/${name}/items/t1/claim`, {});
  expect(claim.status, await claim.clone().text()).toBe(200);
  return { name, api, request };
}

it("a runner token reads a read grant for the project, which names the repository and its branch", async () => {
  const t = await setup();
  const read = await t.api("POST", `/projects/${t.name}/git-token`, { kind: "read" });
  expect(read.status, await read.clone().text()).toBe(200);
  const body = await read.json() as { remote: string; defaultBranch: string; token: string; repository: string; branch?: unknown };
  expect(body).toMatchObject({ kind: "read", remote: expect.stringContaining(`/git/${t.name}.git`), defaultBranch: "main", repository: "server" });
  expect(body.token).toMatch(/^atl_[0-9a-f]{64}$/);
  expect(body.branch).toBeUndefined();
});

it("with an item named, the read grant names its branch, the branch it merges into, and its head and base", async () => {
  const t = await setup();
  const claimed = await (await t.api("POST", `/projects/${t.name}/git-token`, { kind: "read", item: "t1" })).json() as Record<string, unknown>;
  expect(claimed).toMatchObject({ kind: "read", defaultBranch: "main", branch: "t/1", into: "main" });
  expect(claimed.head).toMatch(/^[0-9a-f]{40}$/);
  expect(claimed.base).toBe(claimed.head);
  // A task never claimed has no branch yet; it still merges into main.
  const open = await (await t.api("POST", `/projects/${t.name}/git-token`, { kind: "read", item: "t2" })).json() as Record<string, unknown>;
  expect(open).toMatchObject({ branch: null, into: "main", head: null, base: null });
  expect((await t.api("POST", `/projects/${t.name}/git-token`, { kind: "read", item: "x1" })).status).toBe(400);
});

it("a project the token does not serve is refused, and the old token routes are gone", async () => {
  const t = await setup();
  expect((await t.api("POST", "/projects/other/git-token", { kind: "read" })).status).toBe(403);
  for (const path of [`/projects/${t.name}/baseline-token`, `/projects/${t.name}/items/t1/read-token`, `/projects/${t.name}/items/t1/base-token`]) {
    const owner = await t.request("POST", path, OWNER, "owner", { scope: "read" });
    expect(owner.status, path).toBe(404);
  }
});
