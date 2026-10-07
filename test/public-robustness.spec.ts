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
  for (const path of ["/unknown", "/api/unknown", "/p", "/unknown/path"]) {
    const res = await call("GET", path);
    expect(res.status).toBe(404);
  }
});

// Every path under /p/ answers the same whether or not a project is
// registered under the name it holds, so a guessed name learns nothing: the
// registered project above and an unknown name both send the visitor to
// sign-in, as does a page inside a project's area.
it("signed-out /p/<name> answers the same whether or not the project exists", async () => {
  const answers = await Promise.all(["/p/public-robustness", "/p/no-such-project", "/p/public-robustness/tasks", "/p/no-such-project/tasks"].map(async (path) => {
    const res = await call("GET", path);
    return { status: res.status, location: res.headers.get("location") };
  }));
  for (const answer of answers) {
    expect(answer.status).toBe(303);
    expect(answer.location).toBe("https://atelier.test/login");
  }
});

it("signed-out GET /api/runners answers 401, and an unknown /api path 404", async () => {
  expect((await call("GET", "/api/runners")).status).toBe(401);
  expect((await call("GET", "/api/queue")).status).toBe(401);
  expect((await call("GET", "/api/unknown")).status).toBe(404);
});

it("POST /login checks Origin", async () => {
  const req = new Request("https://atelier.test/login", {
    method: "POST",
    headers: { origin: "https://evil.test" }
  });
  const res = await worker.fetch(req, env);
  expect(res.status).toBe(403);
});

// A same-origin post and one without an Origin header both reach the token
// check: the token alone judges them, as it always has. A foreign origin is
// refused above before the token is read.
it("POST /login with a matching or missing Origin still reaches the token check", async () => {
  const tokenEnv = { ...env, ATELIER_TOKEN: "public-robustness-token" } as typeof env;
  const post = (origin: string | null, token: string) =>
    worker.fetch(new Request("https://atelier.test/login", {
      method: "POST",
      headers: origin === null ? {} : { origin },
      body: new URLSearchParams({ token })
    }), tokenEnv);
  for (const origin of ["https://atelier.test", null]) {
    expect((await post(origin, "wrong-token")).status).toBe(401);
    const in_ = await post(origin, "public-robustness-token");
    expect(in_.status).toBe(303);
    expect(in_.headers.get("location")).toBe("/");
    expect(in_.headers.get("set-cookie")).toMatch(/^atelier=[a-f0-9]{64};/);
  }
});
