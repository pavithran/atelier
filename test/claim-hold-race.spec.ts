// t241: on 2026-10-24 at 05:02Z studio-3's claim of t232 was answered 403
// runner_forbidden while t223 won the hold of core file src/ledger.ts in the
// same second; the claim's check passed before t223 claimed, and the refusal
// came after. A runner token's claim refused while a core-file hold blocks
// it is answered 409 held, naming the holding task and the core file, as a
// claim that loses the race at its check is (t540), and no refusal is kept
// on the task. A refusal no hold explains is still runner_forbidden.
//
// The race is played by Ledger.prototype.claim: the Ledgers run in this
// isolate, so for the loser's claim it first makes the winner's claim and
// then refuses the loser's, as the runner token check does.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import worker from "../src/index.ts";
import { Ledger } from "../src/ledger.ts";
import { runnerDenied } from "../src/tokens.ts";
import type { AgentToken } from "../src/tokens.ts";

const A = "codex/gpt-6-astra", OWNER = "claim-hold-race-owner";
const testEnv = { ...env, ATELIER_TOKEN: OWNER } as typeof env;
const agents = [{ agent: "codex", models: ["gpt-6-astra"] }];
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const api = (path: string, method = "GET", body?: unknown, token = OWNER, actor = "owner") => worker.fetch(new Request(`https://atelier.test/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv);

const proto = Ledger.prototype as unknown as Record<string, unknown>;
const saved = Object.getOwnPropertyDescriptor(proto, "claim")!;
afterEach(() => { Object.defineProperty(proto, "claim", saved); });

// t1 (the winner, t223 of the case) and t2 (the loser, t232) are both
// dispatched; `scope` is t1's. Core file src/ledger.ts.
async function setup(name: string, scope: string[]) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const record = { name, repo: name, createdAt: new Date().toISOString(), policy: { checks: [], protected: [], coreFiles: ["src/ledger.ts"] } };
  await L.setProject(record, "owner");
  await index().registerProject(record);
  await L.newItem("Winner", scope, "owner");
  await L.newItem("Loser", ["src/ledger.ts"], "owner");
  await L.dispatch("t1", "owner", {});
  await L.dispatch("t2", "owner", {});
  const runner = `home:${name}-3`;
  const issued = await api("/tokens", "POST", { runner, projects: [name] });
  expect(issued.status, await issued.clone().text()).toBe(201);
  const { token } = await issued.json() as { token: string };
  return {
    L,
    poll: async () => {
      const res = await api("/queue", "POST", { runner, agents, jobs: ["build"] }, token, A);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json() as { project: string; item: { id: string } }[]).filter((q) => q.project === name).map((q) => q.item.id);
    },
    claim: (id: string) => api(`/projects/${name}/items/${id}/claim`, "POST", {}, token, A),
  };
}

// The loser's claim makes the winner's first, under a runner of its own,
// then is refused as the runner token check refuses it.
function race(winner: string) {
  Object.defineProperty(proto, "claim", { ...saved, value(this: Ledger, id: string, actor: string, runner: unknown, proved: boolean, token?: AgentToken) {
    const claim = saved.value as (this: Ledger, ...args: unknown[]) => unknown;
    if (id !== "t2" || !token) return claim.call(this, id, actor, runner, proved, token);
    claim.call(this, "t1", A, { runner: winner, kind: "home" });
    throw runnerDenied(token);
  } });
}

it("the 2026-10-24 case: a claim refused as t1 wins the core-file hold is answered held, naming t1 and the core file, and no refusal is kept", async () => {
  const name = "claim-hold-race";
  const { L, poll, claim } = await setup(name, ["src/ledger.ts"]);
  expect(await poll()).toEqual(expect.arrayContaining(["t1", "t2"]));
  race(`home:${name}-winner`);
  const res = await claim("t2");
  const answer = await res.json() as { error: string; detail: string };
  expect(res.status, JSON.stringify(answer)).toBe(409);
  expect(answer.error).toBe("held");
  expect(answer.detail).toContain(`t1 (claimed by ${A})`);
  expect(answer.detail).toContain("core file src/ledger.ts");
  const t2 = (await L.waiting()).find((i) => i.id === "t2")!;
  expect(t2.held?.id).toBe("t1");
  expect(t2.refusals ?? []).toEqual([]);
});

it("a claim refused with no hold to explain it is still runner_forbidden, and the refusal is kept", async () => {
  const name = "claim-hold-race-free";
  // t1 reaches no core file, so its claim holds nothing.
  const { L, poll, claim } = await setup(name, ["docs/**"]);
  expect(await poll()).toContain("t2");
  race(`home:${name}-winner`);
  const res = await claim("t2");
  const answer = await res.json() as { error: string };
  expect(res.status, JSON.stringify(answer)).toBe(403);
  expect(answer.error).toBe("runner_forbidden");
  const t2 = (await L.waiting()).find((i) => i.id === "t2")!;
  expect(t2.held).toBeUndefined();
  expect(t2.refusals?.map((r) => r.error)).toEqual(["runner_forbidden"]);
});

it("a runner token whose offer never covered the claim is refused runner_forbidden, though a hold stands", async () => {
  const name = "claim-hold-race-unoffered";
  const { L, claim } = await setup(name, ["src/ledger.ts"]);
  await L.claim("t1", A, { runner: `home:${name}-winner`, kind: "home" });
  // This runner never polled the project, so no offer of it is on record.
  const res = await claim("t2");
  const answer = await res.json() as { error: string };
  expect(res.status, JSON.stringify(answer)).toBe(403);
  expect(answer.error).toBe("runner_forbidden");
});
