import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// The landing route's cancel, driven through the Worker's own fetch handler
// against a baseline whose history is served the way Artifacts serves it: a
// first-parent chain from a ref, a thousand commits at most per call. A
// merge already on the baseline cannot be cancelled however deep in that
// history it lies.

const TOKEN = "landing-cancel-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const H0 = "0".repeat(40), H1 = "a".repeat(40);

// A project whose task t1 is accepted at H1 and landing.
async function landing(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const agent = "claude-code/opus-5.5";
  await L.newItem("Land", [], "owner"); await L.claim("t1", agent); await L.setFork("t1", `${name}--t1`, H0, agent);
  await L.recordPush("t1", agent, H1, H1);
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: true, by: agent, at: new Date().toISOString(), changedPaths: ["README.md"] } as never);
  await L.submit("t1", agent); await L.accept("t1", "owner", H1); await L.beginLanding("t1", "owner", H1);
}

// A baseline of `length` commits on one first-parent line, newest first;
// with `mergeAt`, the commit at that depth is the merge of H1.
function baseline(length: number, mergeAt?: number) {
  const hash = (n: number) => `b${n.toString(16).padStart(39, "0")}`;
  const chain = Array.from({ length }, (_, n) => ({ hash: hash(n), parents: [...(n + 1 < length ? [hash(n + 1)] : []), ...(n === mergeAt ? [H1] : [])] }));
  return {
    get: async () => ({
      log: async ({ ref, limit = 50 }: { ref?: string; limit?: number } = {}) => {
        const from = ref === undefined ? 0 : chain.findIndex((c) => c.hash === ref);
        return from < 0 ? [] : chain.slice(from, from + Math.min(limit, 1000));
      },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
}

function cancel(name: string, ARTIFACTS: Artifacts) {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t1/landing`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify({ cancel: true }),
  }), { ...testEnv, ARTIFACTS } as typeof env);
}

it("a merge 1,200 commits deep in the baseline's history cannot be cancelled", async () => {
  await landing("cancel-deep");
  const refused = await cancel("cancel-deep", baseline(1500, 1200));
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("landed");
});

it("a cancel goes through when the whole history holds no merge of the accepted revision", async () => {
  await landing("cancel-absent");
  expect((await cancel("cancel-absent", baseline(1500))).status).toBe(200);
});

// The search stops at its budget of ten thousand commits and cannot tell;
// the lease still ends, so a large baseline never keeps one for good.
it("a history too long to read within the search's budget does not hold the cancel back", async () => {
  await landing("cancel-long");
  expect((await cancel("cancel-long", baseline(12000))).status).toBe(200);
});
