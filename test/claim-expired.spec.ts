import { execFileSync } from "node:child_process";
import { env, server } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
// @ts-expect-error the grant store is plain JavaScript without declarations
import { hashToken } from "../src/git/grants.mjs";

// t705, seen in ikon-weblog/t112: after a build of about ten hours the
// workspace token had expired, and `atelier claim t112` by the same holder
// answered "internal: The operation could not be completed". A holder asking
// again for the claim it has is renewing its token; an expired token is no
// reason to refuse, and a failure the server cannot name is still said
// plainly, with the command that recovers. Since task 5 the token is the task
// grant of the Node server's Git host. Every credential here is a dummy.

const TOKEN = "claim-expired-owner";
const A = "claude-code/opus-5.5";

type GitHost = { repo(key: string, branch: string): string; grants: { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } } };
const git = (server as unknown as { git: GitHost }).git;

// The Ledger namespace whose stubs fail a named method once armed, the way a
// storage error inside the claim would.
function failingLedger() {
  const state = { method: null as string | null };
  const namespace = {
    idFromName: (n: string) => env.LEDGER.idFromName(n),
    get: (id: DurableObjectId) => new Proxy(env.LEDGER.get(id), {
      get(target, prop) {
        if (typeof prop !== "string" || prop === "then") return Reflect.get(target, prop);
        return (...args: unknown[]) => {
          if (prop === state.method) throw new Error("SQLITE_ERROR: simulated storage failure");
          return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
        };
      },
    }),
  } as unknown as typeof env.LEDGER;
  return { namespace, state };
}

async function setup(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  // A claim branches from main, so main needs a commit.
  const dir = git.repo(name, "main");
  const author = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const sha = execFileSync("git", ["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "first"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...author } }).trim();
  execFileSync("git", ["update-ref", "refs/heads/main", sha], { cwd: dir });
  await L.newItem("T", [], "owner");
  const ledger = failingLedger();
  const bindings = { ...env, ATELIER_TOKEN: TOKEN, LEDGER: ledger.namespace } as typeof env;
  const send = (bearer: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), bindings);
  const made = await send(TOKEN, "/tokens", { actor: A, projects: [name] }, { "x-atelier-actor": "owner", "x-atelier-acting": A });
  const agent = ((await made.json()) as { token: string }).token;
  const claim = () => send(agent, `/projects/${name}/items/t1/claim`);
  expect((await claim()).status).toBe(200);
  return { claim, ledger, L };
}

it("a holder whose task grant expired re-claims and is given a new one", async () => {
  const { claim, L } = await setup("claim-expired-ok");
  const recorded = await L.tokenId("t1");
  // Ten hours on: every grant of the store has run out.
  git.grants.db.prepare("UPDATE grants SET expires_at = ?").run(Date.now() - 1000);
  const res = await claim();
  const body = (await res.json()) as { workspace?: { token: string } };
  expect(res.status).toBe(200);
  expect(body.workspace?.token).toMatch(/^atl_/);
  expect(await L.tokenId("t1")).toBe(`git:${hashToken(body.workspace!.token)}`);
  expect(await L.tokenId("t1")).not.toBe(recorded);
});

it("a holder's re-claim that fails inside the server is answered plainly, never as internal", async () => {
  const { claim, ledger } = await setup("claim-expired-plain");
  ledger.state.method = "recordToken";
  const res = await claim();
  const body = (await res.json()) as { error: string; detail: string };
  expect({ status: res.status, error: body.error }).toEqual({ status: 503, error: "claim_failed" });
  expect(body.detail).toContain("atelier start t1 --as claude-code/opus-5.5");
  expect(body.detail).not.toContain("atl_");
  // The old token may already be revoked, so the message never promises that nothing changed.
  expect(body.detail).not.toContain("nothing was changed");
  expect(body.detail).toContain("may already be revoked");
});
