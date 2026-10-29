import { execFileSync } from "node:child_process";
import { env, server } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";

// A build's runner merges current main before it submits (t435) and reads
// main through the project's baseline token: POST /projects/NAME/baseline-token
// with scope read answers a runner token for any project it serves, where an
// item's base-token answers a runner only for the job it holds (assertRunnerJob
// in src/ledger.ts), so a part's runner cannot read main through its plan
// item's, which is another's job. The write scope stays the owner's. Every
// credential here is a dummy. On the Node server (task 2) the read token is
// a read grant for the project's repository, and the write scope answers the
// remote with no token: the developer writes with the server token itself.

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

it("a runner token reads the project's baseline token for reading, which names the repository and its branch", async () => {
  const t = await setup();
  const baseline = await t.api("POST", `/projects/${t.name}/baseline-token`, { scope: "read" });
  expect(baseline.status, await baseline.clone().text()).toBe(200);
  const body = await baseline.json() as { remote: string; defaultBranch: string; token: string; repository: string };
  expect(body).toMatchObject({ remote: expect.stringContaining(`/git/${t.name}.git`), defaultBranch: "main", repository: "server" });
  expect(body.token).toMatch(/^atl_[0-9a-f]{64}$/);
});

it("the write scope stays the owner's, and a project the token does not serve is refused", async () => {
  const t = await setup();
  const write = await t.api("POST", `/projects/${t.name}/baseline-token`, { scope: "write" });
  expect(write.status).toBe(403);
  expect(await write.text()).not.toContain("atl_");
  expect((await t.api("POST", "/projects/other/baseline-token", { scope: "read" })).status).toBe(403);
  // The owner reads either scope; on the Node server the write scope names the remote and holds no token.
  const owner = await t.request("POST", `/projects/${t.name}/baseline-token`, OWNER, "owner", { scope: "write" });
  expect(owner.status).toBe(200);
  expect(await owner.json()).toMatchObject({ token: null, repository: "server" });
});

it("an item's base token answers the runner only for the job it holds, so another item's is refused where the baseline is not", async () => {
  const t = await setup();
  expect((await t.api("POST", `/projects/${t.name}/items/t1/base-token`, { scope: "read" })).status).toBe(200);
  expect((await t.api("POST", `/projects/${t.name}/items/t2/base-token`, { scope: "read" })).status).toBe(403);
  expect((await t.api("POST", `/projects/${t.name}/baseline-token`, { scope: "read" })).status).toBe(200);
});
