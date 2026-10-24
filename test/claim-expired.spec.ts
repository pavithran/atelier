import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { bindingsWith, expectNoStrayArtifactsAccess, fakeLog } from "./support/artifacts-fake.ts";

// t705, seen in ikon-weblog/t112: after a build of about ten hours the
// workspace token had expired, and `atelier claim t112` by the same holder
// answered "internal: The operation could not be completed". A holder asking
// again for the claim it has is renewing its token; an expired token is no
// reason to refuse, and a failure the server cannot name is still said
// plainly, with the command that recovers. Every credential here is a dummy.

const TOKEN = "claim-expired-owner";
afterEach(expectNoStrayArtifactsAccess);

const H0 = "0".repeat(40);
const A = "claude-code/opus-5.5";

function fakeArtifacts(revoke: () => unknown, log: () => Promise<unknown> = fakeLog) {
  let n = 0;
  return {
    get: async (repo: string) => ({
      info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
      createToken: async (scope: string) => ({ id: `tok${++n}`, plaintext: `art_secret_${n}`, scope, expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString() }),
      revokeToken: async () => revoke(),
      log,
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
}

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

async function setup(name: string, revoke: () => unknown, log?: () => Promise<unknown>) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  await L.newItem("T", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  const ledger = failingLedger();
  const bindings = bindingsWith(env, fakeArtifacts(revoke, log), { ATELIER_TOKEN: TOKEN, LEDGER: ledger.namespace });
  const send = (bearer: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), bindings);
  const made = await send(TOKEN, "/tokens", { actor: A, projects: [name] }, { "x-atelier-actor": "owner" });
  const agent = ((await made.json()) as { token: string }).token;
  const claim = () => send(agent, `/projects/${name}/items/t1/claim`);
  expect((await claim()).status).toBe(200);
  return { claim, ledger, L };
}

it("a holder whose write token expired re-claims and is given a new one", async () => {
  let expired = false;
  const { claim, L } = await setup("claim-expired-ok", () => { if (expired) throw new Error("Invalid or expired token"); return true; });
  expired = true;
  const res = await claim();
  const body = (await res.json()) as { workspace?: { token: string } };
  expect(res.status).toBe(200);
  expect(body.workspace?.token).toMatch(/^art_secret_/);
  expect(await L.tokenId("t1")).toBe(`tok${body.workspace!.token.replace("art_secret_", "")}`);
});

it("a holder's re-claim that fails inside the server is answered plainly, never as internal", async () => {
  const { claim, ledger } = await setup("claim-expired-plain", () => true);
  ledger.state.method = "recordToken";
  const res = await claim();
  const body = (await res.json()) as { error: string; detail: string };
  expect({ status: res.status, error: body.error }).toEqual({ status: 503, error: "claim_failed" });
  expect(body.detail).toContain("atelier start t1 --as claude-code/opus-5.5");
  expect(body.detail).not.toContain("art_secret_");
  // The old token may already be revoked, so the message never promises that nothing changed.
  expect(body.detail).not.toContain("nothing was changed");
  expect(body.detail).toContain("may already be revoked");
});

it("a step that fails once is retried with a log line, and the claim goes on", async () => {
  const { setRetryBaseMs } = await import("../src/transient.ts");
  setRetryBaseMs(1);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    let reads = 0;
    const log = async () => {
      if (++reads === 2) throw Object.assign(new Error("service unavailable"), { code: "UNAVAILABLE" });
      return fakeLog();
    };
    const { claim } = await setup("claim-expired-retry", () => true, log);
    reads = 0;
    const res = await claim();
    expect(res.status).toBe(200);
    expect(reads).toBeGreaterThan(1);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /read the head of .*attempt 1, retrying.*UNAVAILABLE/s.test(l))).toBe(true);
  } finally {
    warn.mockRestore();
    setRetryBaseMs();
  }
});
