import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// t631: the reviews each risk class needs (policy.riskReviews), set through the
// init route and read back from the stored project policy.

const TOKEN = "risk-reviews-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

// PUT creates the baseline in Artifacts before the Ledger write; this pool
// does not reach Artifacts, so a stand-in answers those calls.
const artifacts = {
  create: async () => ({}),
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
    [Symbol.dispose]() {},
  }),
} as unknown as Artifacts;

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...testEnv, ARTIFACTS: artifacts } as typeof env);
}

const RISK = { core: ["src/rules.ts"], reviews: { "docs-or-tests": 0, other: 1, core: 2 } };

it("init records riskReviews, keeps them on an unrelated init, clears them with null and refuses an invalid value", async () => {
  const put = (body: unknown) => call("PUT", "/projects/risk-init", body);
  const stored = async () => {
    const res = await call("GET", "/projects/risk-init");
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { project: { policy: { riskReviews?: unknown } } }).project.policy;
  };
  expect((await put({ checks: ["npm test"] })).status).toBe(200);
  expect(await stored()).not.toHaveProperty("riskReviews");
  expect((await put({ riskReviews: { ...RISK, core: [" src/rules.ts "] } })).status).toBe(200);
  expect((await stored()).riskReviews).toEqual(RISK);
  expect((await put({ title: "Risk" })).status).toBe(200);
  expect((await stored()).riskReviews).toEqual(RISK);
  const bad = await put({ riskReviews: { ...RISK, reviews: { ...RISK.reviews, core: 9 } } });
  expect(bad.status).toBe(400);
  expect(await bad.text()).toMatch(/bad_risk_reviews/);
  expect((await stored()).riskReviews).toEqual(RISK);
  expect((await put({ riskReviews: null })).status).toBe(200);
  expect(await stored()).not.toHaveProperty("riskReviews");
});
