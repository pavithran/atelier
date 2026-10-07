import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
  return worker.fetch(new Request(`https://atelier.test${path}`, { method, headers }), env);
};

// One project shown publicly, so /showcase answers a page in this file's own
// storage: on a server that shows nothing it answers 404, as showcase.spec
// tests, and "HEAD answers like GET" means the same answer GET would give.
const time = new Date().toISOString();
const shown = { name: "public-robustness", repo: "public-robustness", policy: { checks: [], protected: [] }, createdAt: time };
await env.LEDGER.get(env.LEDGER.idFromName("project:public-robustness")).setProject(shown, "owner");
await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(shown);
await env.LEDGER.get(env.LEDGER.idFromName("__index")).setShowcase("public-robustness", "named");

it("HEAD on public routes answers like GET, not redirecting", async () => {
  for (const path of ["/showcase", "/how", "/live.js", "/api/version"]) {
    const res = await call("HEAD", path);
    expect(res.status).toBe(200);
    expect(res.status).toBe((await call("GET", path)).status);
  }
});

it("trailing slash on a public page goes to the page", async () => {
  for (const path of ["/showcase/", "/how/", "/live.js/"]) {
    const res = await call("GET", path);
    expect(res.status).toBe(200);
  }
});

it("unknown path answers 404, not a redirect to sign-in", async () => {
  for (const path of ["/unknown", "/api/unknown", "/p/myproject", "/unknown/path"]) {
    const res = await call("GET", path);
    expect(res.status).toBe(404);
  }
});

it("POST /login checks Origin", async () => {
  const req = new Request("https://atelier.test/login", {
    method: "POST",
    headers: { origin: "https://evil.test" }
  });
  const res = await worker.fetch(req, env);
  expect(res.status).toBe(403);
});
