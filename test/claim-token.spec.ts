import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { parseRuleError } from "../src/rules.ts";

// A claim mints its workspace write token in Artifacts after the Ledger has
// allowed it, and Artifacts can be slow to answer. These tests hold that
// answer open, change the item meanwhile through the Worker's own routes,
// and then count the write tokens still live on the fork: only the one the
// Ledger records may be live, and only its owner may have been given it.
// Artifacts is a local fake that records each token it mints and whether it
// was revoked. Every credential here is a dummy.

const TOKEN = "claim-token-owner";
const H0 = "0".repeat(40);
const A = "claude-code/opus-5.5", B = "codex/gpt-6";

type Tok = { id: string; repo: string; scope: string; revoked: boolean };

function fakeArtifacts() {
  const tokens = new Map<string, Tok>();
  let n = 0;
  let held: { entered: () => void; gate: Promise<void> } | null = null;
  const artifacts = {
    get: async (repo: string) => ({
      info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
      createToken: async (scope: string) => {
        const id = `tok${++n}`;
        tokens.set(id, { id, repo, scope, revoked: false });
        // The token exists in Artifacts from here; the Worker waits for the answer.
        const h = scope === "write" ? held : null;
        if (h) { held = null; h.entered(); await h.gate; }
        return { id, plaintext: `art_secret_${id}`, scope, expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString() };
      },
      revokeToken: async (id: string) => {
        const t = tokens.get(id);
        if (t) t.revoked = true;
        return !!t;
      },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  // Holds the answer for the next write token minted until release() is called.
  function holdNextWrite() {
    let open!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const reached = new Promise<void>((r) => (entered = r));
    held = { entered, gate };
    return { reached, release: () => open() };
  }
  const live = (repo: string) => [...tokens.values()].filter((t) => t.repo === repo && t.scope === "write" && !t.revoked).map((t) => t.id).sort();
  return { artifacts, holdNextWrite, live };
}

function caller(bearer: string, artifacts: Artifacts, actor?: string) {
  const bindings = { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as typeof env;
  return (method: string, path: string, body: unknown = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: JSON.stringify(body),
  }), bindings);
}

const tokenOf = async (res: Response) => ((await res.json()) as { workspace: { token: string } }).workspace.token.replace("art_secret_", "");

// A project with one item, t1, that A holds with a fork and a recorded write
// token, and the callers the tests use: A and B with agent tokens scoped to
// the project, and the owner.
async function setup(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  await L.newItem("Race", [], "owner");
  await L.claim("t1", A);
  const fork = `${name}--t1`;
  await L.setFork("t1", fork, H0, A);
  const fa = fakeArtifacts();
  const owner = caller(TOKEN, fa.artifacts, "owner");
  const agent = async (actor: string) => {
    const res = await owner("POST", "/tokens", { actor, projects: [name] });
    expect(res.status).toBe(201);
    return caller(((await res.json()) as { token: string }).token, fa.artifacts);
  };
  const agentA = await agent(A), agentB = await agent(B);
  const claim = `/projects/${name}/items/t1/claim`;
  const first = await agentA("POST", claim);
  expect(first.status).toBe(200);
  const firstToken = await tokenOf(first);
  expect(await L.tokenId("t1")).toBe(firstToken);
  return { L, fa, fork, owner, agentA, agentB, claim, base: `/projects/${name}/items/t1` };
}

it("a claim whose token is minted while its claimer hands off is refused, its token revoked, and only the new owner's token is live", async () => {
  const { L, fa, fork, agentA, agentB, claim, base } = await setup("claim-race-handoff-then-claim");
  const hold = fa.holdNextWrite();
  const claimA = agentA("POST", claim);
  // The Ledger allowed A's claim and Artifacts has minted A's token; the route waits for it.
  await hold.reached;
  const handoff = await agentA("POST", `${base}/handoff`, { to: B, note: "yours" });
  const claimB = await agentB("POST", claim);
  hold.release();
  const a = await claimA;
  const aText = await a.text();
  const bToken = await tokenOf(claimB);
  expect({
    claimA: a.status, error: (JSON.parse(aText) as { error?: string }).error,
    handoff: handoff.status, claimB: claimB.status, owner: (await L.item("t1")).owner,
    recorded: await L.tokenId("t1"), live: fa.live(fork),
  }).toEqual({ claimA: 409, error: "claim_superseded", handoff: 200, claimB: 200, owner: B, recorded: bToken, live: [bToken] });
  expect(aText).not.toContain("art_secret_");
  // B's next claim rotates the token B holds, and leaves nothing else live.
  const again = await agentB("POST", claim);
  expect(again.status).toBe(200);
  const bSecond = await tokenOf(again);
  expect({ recorded: await L.tokenId("t1"), live: fa.live(fork) }).toEqual({ recorded: bSecond, live: [bSecond] });
});

for (const [transfer, done] of [["handoff", "handed off"], ["release", "released"], ["abandon", "abandoned"]] as const) {
  it(`a claim whose token is minted while the item is ${done} records nothing and leaves no write token live`, async () => {
    const { L, fa, fork, owner, agentA, agentB, claim, base } = await setup(`claim-race-${transfer}`);
    const hold = fa.holdNextWrite();
    const claimA = agentA("POST", claim);
    await hold.reached;
    const changed = transfer === "abandon"
      ? await owner("POST", `${base}/abandon`, { note: "not needed" })
      : await agentA("POST", `${base}/${transfer}`, transfer === "handoff" ? { to: B } : {});
    hold.release();
    const a = await claimA;
    expect({ claimA: a.status, changed: changed.status, recorded: await L.tokenId("t1"), live: fa.live(fork) })
      .toEqual({ claimA: 409, changed: 200, recorded: null, live: [] });
    if (transfer === "abandon") return;
    // The next owner's first claim gets the only live token.
    const next = await agentB("POST", claim);
    expect(next.status).toBe(200);
    const bToken = await tokenOf(next);
    expect({ recorded: await L.tokenId("t1"), live: fa.live(fork) }).toEqual({ recorded: bToken, live: [bToken] });
  });
}

it("of two claims by the same owner in flight together, only the later reservation records its token; the other is revoked", async () => {
  const { L, fa, fork, agentA, claim } = await setup("claim-race-rotate");
  const hold = fa.holdNextWrite();
  const earlier = agentA("POST", claim);
  await hold.reached;
  const later = await agentA("POST", claim);
  expect(later.status).toBe(200);
  const laterToken = await tokenOf(later);
  hold.release();
  const e = await earlier;
  expect({ earlier: e.status, recorded: await L.tokenId("t1"), live: fa.live(fork) })
    .toEqual({ earlier: 409, recorded: laterToken, live: [laterToken] });
});

it("an owner change is refused when a claim recorded a newer token after the change read the old one", async () => {
  const { L, fa, fork, agentA, claim } = await setup("claim-race-read");
  // What a handoff, release or abandon reads before it asks the Ledger to change the owner.
  const read = await L.tokenId("t1");
  const again = await agentA("POST", claim);
  expect(again.status).toBe(200);
  const current = await tokenOf(again);
  const refusal = async (p: Promise<unknown>) => parseRuleError(await p.then(() => null, (e: unknown) => e))?.code;
  expect(await refusal(L.handoff("t1", A, B, "", false, read))).toBe("token_changed");
  expect(await refusal(L.release("t1", A, "", false, read))).toBe("token_changed");
  expect(await refusal(L.abandon("t1", "owner", "", read))).toBe("token_changed");
  const item = await L.item("t1");
  expect({ owner: item.owner, state: item.state, recorded: await L.tokenId("t1"), live: fa.live(fork) })
    .toEqual({ owner: A, state: "claimed", recorded: current, live: [current] });
  // Read again, the change goes through and takes the token with it.
  expect((await L.handoff("t1", A, B, "", false, current)).owner).toBe(B);
  expect(await L.tokenId("t1")).toBeNull();
});
