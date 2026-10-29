import { execFileSync } from "node:child_process";
import { env, server } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { parseRuleError } from "../src/rules.ts";
// @ts-expect-error the grant store is plain JavaScript without declarations
import { hashToken } from "../src/git/grants.mjs";

// A claim mints its task grant on the Node server's Git host after the Ledger
// has allowed it, and records it as the item's write token afterwards. These
// tests hold that recording open (Ledger.recordToken), change the item
// meanwhile through the Worker's own routes, and then count the task grants
// still live: only the one the Ledger records may be live, and only its owner
// may have been given it. Before task 5 the held step was the Artifacts
// token's mint; the race and its answer (claim_superseded) are the same.
// Every credential here is a dummy.

const TOKEN = "claim-token-owner";
const A = "claude-code/opus-5.5", B = "codex/gpt-6";

type GitHost = { repo(key: string, branch: string): string; live(id: string): Promise<boolean>; grants: { db: { prepare(sql: string): { all(...args: unknown[]): { id: string; hash: string }[] } } } };
const git = (server as unknown as { git: GitHost }).git;
// The credentials the Ledger would record (git:HASH) for the task grants that
// still write: in the store, and the Ledger records them for a task still held
// (a change of holder ends a grant by changing the record, not the store).
async function liveGrants(project: string): Promise<string[]> {
  const rows = git.grants.db.prepare("SELECT id, hash FROM grants WHERE project = ? AND kind = 'task' AND task = 't1' AND revoked_at IS NULL").all(project);
  const live: string[] = [];
  for (const r of rows) if (await git.live(r.id)) live.push(`git:${r.hash}`);
  return live.sort();
}
const recordedFor = (token: string) => `git:${hashToken(token)}`;

// The Ledger namespace, with stubs that can hold the next recordToken call
// open before it records anything, so a test can change the item between the
// grant's mint and its recording.
function holdingLedger() {
  let held: { entered: () => void; gate: Promise<void> } | null = null;
  const namespace = {
    idFromName: (n: string) => env.LEDGER.idFromName(n),
    get: (id: DurableObjectId) => {
      const stub = env.LEDGER.get(id);
      return new Proxy(stub, {
        get(target, prop) {
          if (typeof prop !== "string" || prop === "then") return Reflect.get(target, prop);
          const call = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop];
          if (prop === "recordToken" && held) {
            const h = held;
            held = null;
            return async (...args: unknown[]) => { h.entered(); await h.gate; return call(...args); };
          }
          return (...args: unknown[]) => call(...args);
        },
      });
    },
  } as unknown as typeof env.LEDGER;
  // Holds the next recordToken until release() is called.
  function holdNextWrite() {
    let open!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const reached = new Promise<void>((r) => (entered = r));
    held = { entered, gate };
    return { reached, release: () => open() };
  }
  return { namespace, holdNextWrite };
}

function caller(bearer: string, ledger: typeof env.LEDGER, actor?: string) {
  const bindings = { ...env, ATELIER_TOKEN: TOKEN, LEDGER: ledger } as typeof env;
  // A write with the developer token names the acting model (G18).
  const acting = bearer === TOKEN ? { "x-atelier-acting": "claude-code/opus-5.5" } : {};
  return (method: string, path: string, body: unknown = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...acting, ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: JSON.stringify(body),
  }), bindings);
}

const tokenOf = async (res: Response) => ((await res.json()) as { workspace: { token: string } }).workspace.token;

// A project with one item, t1, that A holds with a branch and a recorded task
// grant, and the callers the tests use: A and B with agent tokens scoped to
// the project, and the owner.
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
  await L.newItem("Race", [], "owner");
  const hold = holdingLedger();
  const owner = caller(TOKEN, hold.namespace, "owner");
  const agent = async (actor: string) => {
    const res = await owner("POST", "/tokens", { actor, projects: [name] });
    expect(res.status).toBe(201);
    return caller(((await res.json()) as { token: string }).token, hold.namespace);
  };
  const agentA = await agent(A), agentB = await agent(B);
  const claim = `/projects/${name}/items/t1/claim`;
  const first = await agentA("POST", claim);
  expect(first.status, await first.clone().text()).toBe(200);
  const firstToken = await tokenOf(first);
  expect(await L.tokenId("t1")).toBe(recordedFor(firstToken));
  return { L, fa: hold, live: () => liveGrants(name), owner, agentA, agentB, claim, base: `/projects/${name}/items/t1` };
}

it("a claim whose token is minted while its claimer hands off is refused, its token revoked, and only the new owner's token is live", async () => {
  const { L, fa, live, agentA, agentB, claim, base } = await setup("claim-race-handoff-then-claim");
  const hold = fa.holdNextWrite();
  const claimA = agentA("POST", claim);
  // The Ledger allowed A's claim and Artifacts has minted A's token; the route waits for it.
  await hold.reached;
  const handoff = await agentA("POST", `${base}/handoff`, { to: B, note: "yours" });
  const claimB = await agentB("POST", claim);
  hold.release();
  const a = await claimA;
  const aText = await a.text();
  const bToken = recordedFor(await tokenOf(claimB));
  expect({
    claimA: a.status, error: (JSON.parse(aText) as { error?: string }).error,
    handoff: handoff.status, claimB: claimB.status, owner: (await L.item("t1")).owner,
    recorded: await L.tokenId("t1"), live: await live(),
  }).toEqual({ claimA: 409, error: "claim_superseded", handoff: 200, claimB: 200, owner: B, recorded: bToken, live: [bToken] });
  expect(aText).not.toContain("atl_");
  // B's next claim rotates the token B holds, and leaves nothing else live.
  const again = await agentB("POST", claim);
  expect(again.status).toBe(200);
  const bSecond = recordedFor(await tokenOf(again));
  expect({ recorded: await L.tokenId("t1"), live: await live() }).toEqual({ recorded: bSecond, live: [bSecond] });
});

for (const [transfer, done] of [["handoff", "handed off"], ["release", "released"], ["abandon", "abandoned"]] as const) {
  it(`a claim whose token is minted while the item is ${done} records nothing and leaves no write token live`, async () => {
    const { L, fa, live, owner, agentA, agentB, claim, base } = await setup(`claim-race-${transfer}`);
    const hold = fa.holdNextWrite();
    const claimA = agentA("POST", claim);
    await hold.reached;
    const changed = transfer === "abandon"
      ? await owner("POST", `${base}/abandon`, { note: "not needed", quote: "abandon it" })
      : await agentA("POST", `${base}/${transfer}`, transfer === "handoff" ? { to: B } : {});
    hold.release();
    const a = await claimA;
    expect({ claimA: a.status, changed: changed.status, recorded: await L.tokenId("t1"), live: await live() })
      .toEqual({ claimA: 409, changed: 200, recorded: null, live: [] });
    if (transfer === "abandon") return;
    // The next owner's first claim gets the only live token.
    const next = await agentB("POST", claim);
    expect(next.status).toBe(200);
    const bToken = recordedFor(await tokenOf(next));
    expect({ recorded: await L.tokenId("t1"), live: await live() }).toEqual({ recorded: bToken, live: [bToken] });
  });
}

it("of two claims by the same owner in flight together, only the later reservation records its token; the other is revoked", async () => {
  const { L, fa, live, agentA, claim } = await setup("claim-race-rotate");
  const hold = fa.holdNextWrite();
  const earlier = agentA("POST", claim);
  await hold.reached;
  const later = await agentA("POST", claim);
  expect(later.status).toBe(200);
  const laterToken = recordedFor(await tokenOf(later));
  hold.release();
  const e = await earlier;
  expect({ earlier: e.status, recorded: await L.tokenId("t1"), live: await live() })
    .toEqual({ earlier: 409, recorded: laterToken, live: [laterToken] });
});

it("an owner change is refused when a claim recorded a newer token after the change read the old one", async () => {
  const { L, fa, live, agentA, claim } = await setup("claim-race-read");
  // What a handoff, release or abandon reads before it asks the Ledger to change the owner.
  const read = await L.tokenId("t1");
  const again = await agentA("POST", claim);
  expect(again.status).toBe(200);
  const current = recordedFor(await tokenOf(again));
  const refusal = async (p: Promise<unknown>) => parseRuleError(await p.then(() => null, (e: unknown) => e))?.code;
  expect(await refusal(L.handoff("t1", A, B, "", false, read))).toBe("token_changed");
  expect(await refusal(L.release("t1", A, "", false, read))).toBe("token_changed");
  expect(await refusal(L.abandon("t1", "owner", "", read))).toBe("token_changed");
  const item = await L.item("t1");
  expect({ owner: item.owner, state: item.state, recorded: await L.tokenId("t1"), live: await live() })
    .toEqual({ owner: A, state: "claimed", recorded: current, live: [current] });
  // Read again, the change goes through and takes the token with it.
  expect((await L.handoff("t1", A, B, "", false, current)).owner).toBe(B);
  expect(await L.tokenId("t1")).toBeNull();
});
