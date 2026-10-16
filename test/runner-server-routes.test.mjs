import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNNER_ROUTES, agentRoute, runnerRoute } from "../src/tokens.ts";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";
import { AUXILIARY_ROUTES, assertRunnerHandlers, routeKey, serveRunner } from "./helpers/runner-server.mjs";

const concrete = (template) => template.split("/").map((part) => part === ":project" ? "demo" : part === ":id" ? "t1" : part === "*" ? "x" : part);

test("every runner route has an explicit fake-server handler", () => {
  assertRunnerHandlers();
  for (const { method, pattern } of RUNNER_ROUTES) {
    assert.ok(runnerRoute(method, concrete(pattern)), `${method} ${pattern}`);
  }
  for (const { method, pattern } of AUXILIARY_ROUTES.filter(route => route.pattern !== "version")) {
    assert.ok(agentRoute(method, concrete(pattern)), `${method} ${pattern}`);
    assert.equal(runnerRoute(method, concrete(pattern)), false);
  }
});

for (const method of ["GET", "POST", "DELETE"]) {
  test(`the handler guard detects a new ${method} route`, () => {
    const pattern = method === "POST" ? "projects/:project/items/:id/new-call" : "projects/:project/items/:id/plan";
    assert.throws(() => assertRunnerHandlers([...RUNNER_ROUTES, { method, pattern }]),
      { message: `Missing runner handler: ${method} ${pattern}` });
  });
  test(`method matters for ${method} plan`, () => {
    const parts = concrete("projects/:project/items/:id/plan");
    assert.equal(runnerRoute(method, parts), method === "POST");
    if (method === "POST") assert.equal(routeKey(method, parts), "POST projects/:project/items/:id/plan");
    else assert.throws(() => routeKey(method, parts), /Unexpected runner request/);
  });
}

test("runner authorization retains path and write-scope restrictions", () => {
  for (const path of ["projects//items/t1", "projects/demo/items/other", "projects/demo/items/t1/plan/approve"]) {
    assert.equal(runnerRoute("GET", path.split("/")), false, path);
    assert.throws(() => routeKey("GET", path.split("/")), /Unexpected runner request/);
  }
  for (const path of ["projects/demo/baseline-token", "projects/demo/items/t1/read-token", "projects/demo/items/t1/base-token"]) {
    assert.equal(runnerRoute("POST", path.split("/"), { scope: "read" }), true);
    assert.equal(runnerRoute("POST", path.split("/"), { scope: "write" }), false);
  }
});

test("the server answers each listed route", async (t) => {
  const server = await serveRunner();
  t.after(server.close);
  for (const { method, pattern } of [...RUNNER_ROUTES, ...AUXILIARY_ROUTES]) {
    const response = await fetch(`${server.url}/api/${concrete(pattern).join("/")}`, { method });
    assert.equal(response.status, 200, `${method} ${pattern}`);
  }
});

test("answers override a route, by item verb or by template", async (t) => {
  const server = await serveRunner({ answers: { "POST claim": () => [409, { error: "x" }], "GET config": { runner: "r" } } });
  t.after(server.close);
  assert.equal((await fetch(`${server.url}/api/projects/demo/items/t1/claim`, { method: "POST", body: "{}" })).status, 409);
  assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { runner: "r" });
  assert.deepEqual(server.requests, ["POST claim"]);
});

test("the version answer publishes the server's capabilities beside its route level", async (t) => {
  const server = await serveRunner();
  t.after(server.close);
  const version = await (await fetch(`${server.url}/api/version`)).json();
  assert.equal(version.routeLevel, ROUTE_LEVEL);
  assert.deepEqual(version.capabilities, [...SERVER_CAPABILITIES]);
});

for (const [method, path] of [
  ["POST", "projects/demo/items/t1/unknown"],
  ["GET", "projects/demo/items/t1/plan"],
  ["DELETE", "projects/demo/items/t1/plan"],
]) test(`unexpected request fails the fake server: ${method} ${path}`, async () => {
  assert.throws(() => routeKey(method, path.split("/")), /Unexpected runner request/);
  const server = await serveRunner();
  try {
    await assert.rejects(fetch(`${server.url}/api/${path}`, { method }), /fetch failed/);
  } finally {
    // Closing must fail too, even when the runner catches the failed request.
    await assert.rejects(server.close(), (error) => {
      assert.match(error.message, /Unexpected runner request/);
      assert.ok(error.message.includes(`${method} ${path}`));
      return true;
    });
  }
});
