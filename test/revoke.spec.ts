import { execFileSync } from "node:child_process";
import { env, server } from "./support/workers.ts";
import { afterAll, beforeAll, expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

// No test here may reach the network: global fetch is replaced by one that
// records the call and fails, and the suite checks that none was made.
const outbound: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    outbound.push(String(input instanceof Request ? input.url : input));
    throw new Error("network is not available in revoke.spec");
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

// A handoff, release or abandon must not leave the old holder a working
// write credential it is no longer meant to have. Since task 5 that
// credential is the task grant of the Node server's Git host (kept by hash,
// recorded in the Ledger as git:HASH), so these tests drive the Worker's own
// routes and check who owns the item, which credential the Ledger records,
// and which grants still write. The 1.x failure modes of revoking an
// Artifacts token (revoke_failed, a token Artifacts no longer holds) have no
// grant counterpart: a grant ends in the Ledger and the store, in-process.
// Every credential here is a dummy.

const TOKEN = "revoke-owner";
const git = (server as unknown as { git: { repo(key: string, branch: string): string; grants: { find(token: string): { id: string } | null }; live(id: string): Promise<boolean> } }).git;
// Whether a task grant still writes: the store holds it and its task is still held.
const live = async (token: string) => { const g = git.grants.find(token); return !!g && git.live(g.id); };
const A = "claude-code/opus-5.5", B = "codex/gpt-6";

function caller(bearer: string, actor?: string) {
  const bindings = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
  // A write with the developer token names the acting model (G18).
  const acting = bearer === TOKEN ? { "x-atelier-acting": "claude-code/opus-5.5" } : {};
  return (method: string, path: string, body: unknown = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...acting, ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: JSON.stringify(body),
  }), bindings);
}

// A project whose items t1..tN A holds, each claimed through the claim route
// (a branch t/N and a task grant), and callers for A, B and the owner.
async function setup(name: string, items: number) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  // A claim branches from main, so main needs a commit.
  const dir = git.repo(name, "main");
  const author = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const sha = execFileSync("git", ["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "first"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...author } }).trim();
  execFileSync("git", ["update-ref", "refs/heads/main", sha], { cwd: dir });
  const owner = caller(TOKEN, "owner");
  const agent = async (actor: string) => {
    const res = await owner("POST", "/tokens", { actor, projects: [name] });
    expect(res.status).toBe(201);
    return caller(((await res.json()) as { token: string }).token);
  };
  const agentA = await agent(A), agentB = await agent(B);
  const held: Record<string, string> = {};
  for (let n = 1; n <= items; n++) {
    const id = `t${n}`;
    await L.newItem(`Task ${n}`, [], "owner");
    const res = await agentA("POST", `/projects/${name}/items/${id}/claim`);
    expect(res.status, await res.clone().text()).toBe(200);
    held[id] = ((await res.json()) as { workspace: { token: string } }).workspace.token;
  }
  return { L, owner, agentA, agentB, held, base: `/projects/${name}/items` };
}

const errorOf = async (res: Response) => ((await res.clone().json()) as { error?: string }).error;
// The credential the Ledger records for a held item: git:HASH of its grant.
const recorded = async (L: { tokenId(id: string): Promise<string | null> }, id: string) => L.tokenId(id);

// Posts the owner's form for one item, against the given Ledger namespace.
// The first form signs in through /login with the same bindings, and every
// form sends that session's cookie.
function ownerForm(name: string, ledger: typeof env.LEDGER = env.LEDGER) {
  const bindings = { ...env, ATELIER_TOKEN: TOKEN, LEDGER: ledger } as typeof env;
  let session: Promise<string> | undefined;
  return async (id: string, verb: string, fields: string) => {
    const cookie = await (session ??= signIn(TOKEN, bindings));
    return worker.fetch(new Request(`https://atelier.test/ui/${name}/${id}/${verb}`, {
      method: "POST", headers: { cookie, origin: "https://atelier.test", "content-type": "application/x-www-form-urlencoded" }, body: fields,
    }), bindings);
  };
}

// The Ledger namespace, with stubs that can hold the next tokenId call open
// before it reads anything, so a test can change the item between a
// request's earlier reads and its read of the token id.
function holdingLedger() {
  let held: { entered: () => void; gate: Promise<void> } | null = null;
  const namespace = {
    idFromName: (n: string) => env.LEDGER.idFromName(n),
    get: (id: DurableObjectId) => {
      const stub = env.LEDGER.get(id);
      return new Proxy(stub, {
        get(target, prop) {
          if (prop === "tokenId" && held) {
            const h = held;
            held = null;
            return async (item: string) => { h.entered(); await h.gate; return target.tokenId(item); };
          }
          // Every other method is the stub's own, called on the stub.
          if (typeof prop !== "string" || prop === "then") return Reflect.get(target, prop);
          return (...args: unknown[]) => (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
        },
      });
    },
  } as unknown as typeof env.LEDGER;
  function holdNextTokenId() {
    let open!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const reached = new Promise<void>((r) => (entered = r));
    held = { entered, gate };
    return { reached, release: () => open() };
  }
  return { namespace, holdNextTokenId };
}

it("a handoff or release the Ledger would refuse revokes nothing", async () => {
  const { L, agentA, agentB, held, base } = await setup("revoke-refused", 1);
  // B does not hold t1, and A cannot hand it to the project owner.
  const byB = await agentB("POST", `${base}/t1/handoff`, { to: B });
  const releaseByB = await agentB("POST", `${base}/t1/release`);
  const toOwner = await agentA("POST", `${base}/t1/handoff`, { to: "owner" });
  expect([byB.status, releaseByB.status, toOwner.status].every((s) => s >= 400 && s < 500)).toBe(true);
  expect({ owner: (await L.item("t1")).owner, recorded: (await recorded(L, "t1")) !== null, live: await live(held.t1) })
    .toEqual({ owner: A, recorded: true, live: true });
});

it("a claim the Ledger refuses revokes nothing: the holder keeps the item and its grant", async () => {
  const { L, owner, agentB, held, base } = await setup("revoke-claim-refused", 1);
  const before = await recorded(L, "t1");
  // A holds t1; neither B nor the project owner may claim it.
  const byB = await agentB("POST", `${base}/t1/claim`);
  const byOwner = await owner("POST", `${base}/t1/claim`);
  expect({
    byB: byB.status, byBError: await errorOf(byB), byOwner: byOwner.status, byOwnerError: await errorOf(byOwner),
    owner: (await L.item("t1")).owner, recorded: await recorded(L, "t1"), live: await live(held.t1),
  }).toEqual({
    byB: 409, byBError: "owned", byOwner: 409, byOwnerError: "owned",
    owner: A, recorded: before, live: true,
  });
});

it("the owner's release, handoff and abandon forms revoke the holder's grant and change the owner", async () => {
  const name = "revoke-owner-forms-ok";
  const { L, held } = await setup(name, 3);
  const form = ownerForm(name);
  // The forms name the head the owner saw, which a claim sets to the branch's base.
  const head = async (id: string) => (await L.item(id)).head;
  const released = await form("t1", "release", `note=done&head=${await head("t1")}`);
  const handed = await form("t2", "handoff", `note=yours&head=${await head("t2")}&to=${encodeURIComponent(B)}`);
  const abandoned = await form("t3", "abandon", `note=not+needed&head=${await head("t3")}`);
  expect([released.status, handed.status, abandoned.status]).toEqual([303, 303, 303]);
  const after = async (id: string) => {
    const item = await L.item(id);
    return { state: item.state, owner: item.owner, token: await L.tokenId(id), live: await live(held[id]) };
  };
  expect({ t1: await after("t1"), t2: await after("t2"), t3: await after("t3") }).toEqual({
    t1: { state: "open", owner: null, token: null, live: false },
    t2: { state: "claimed", owner: B, token: null, live: false },
    t3: { state: "abandoned", owner: null, token: null, live: false },
  });
});

// A form reads the item before the token id. If a claim records its grant in
// between, the form must still revoke that grant before it takes the token
// off the record.
for (const verb of ["release", "handoff", "abandon"] as const) {
  it(`the owner's ${verb} form revokes a grant a claim recorded after the form first read the item`, async () => {
    const name = `revoke-form-race-${verb}`;
    const { L, agentA } = await setup(name, 0);
    await L.newItem("Race", [], "owner");
    await L.claim("t1", A);
    const ledger = holdingLedger();
    const hold = ledger.holdNextTokenId();
    const posted = ownerForm(name, ledger.namespace)("t1", verb, `note=x${verb === "handoff" ? `&to=${encodeURIComponent(B)}` : ""}`);
    // The form has read t1, which has no grant yet, and waits for the token id.
    await hold.reached;
    const claimed = await agentA("POST", `/projects/${name}/items/t1/claim`);
    expect(claimed.status, await claimed.clone().text()).toBe(200);
    const token = ((await claimed.json()) as { workspace: { token: string } }).workspace.token;
    expect(await L.tokenId("t1")).not.toBeNull();
    hold.release();
    const res = await posted;
    expect({ form: res.status, recorded: await L.tokenId("t1"), live: await live(token) }).toEqual({ form: 303, recorded: null, live: false });
  });
}

it("made no network call", () => {
  expect(outbound).toEqual([]);
});
