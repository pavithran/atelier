import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
  return worker.fetch(new Request(`https://atelier.test${path}`, { method, headers }), env);
};

it("HEAD on public routes answers like GET, not redirecting", async () => {
  for (const path of ["/showcase", "/how", "/live.js", "/api/version"]) {
    const res = await call("HEAD", path);
    expect(res.status).toBe(200);
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
