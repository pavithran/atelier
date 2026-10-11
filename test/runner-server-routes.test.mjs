import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentRoute, runnerRoute } from "../src/tokens.ts";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";
import { RUNNER_ROUTES, serveRunner } from "./helpers/runner-server.mjs";

// The shared fake runner server (test/helpers/runner-server.mjs) must serve
// every route the Worker's runnerRoute allows a runner token. When runnerRoute
// gains a route, this test fails until the helper serves it.
const concrete = (template) => template.split("/").map((part) => part === ":project" ? "demo" : part === ":id" ? "t1" : part === "*" ? "x" : part);

test("every route in the shared helper is one a runner or agent token allows", () => {
  for (const [method, template] of RUNNER_ROUTES) assert.ok(runnerRoute(method, concrete(template), {}) || agentRoute(method, concrete(template), {}), `${method} ${template}`);
});

test("the shared helper serves every segment name runnerRoute accepts", () => {
  const source = readFileSync(new URL("../src/tokens.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function runnerRoute"), source.indexOf("export function runnerDenied"));
  const names = new Set([...body.matchAll(/"([a-z][a-z-]*)"/g)].map((m) => m[1]).filter((name) => !["write", "GET", "POST", "items", "projects"].includes(name)));
  assert.ok(names.size >= 20, "found the route names in runnerRoute");
  const served = new Set(RUNNER_ROUTES.flatMap(([, template]) => template.split("/")));
  const missing = [...names].filter((name) => !served.has(name));
  assert.deepEqual(missing, [], `runnerRoute accepts routes the shared helper (test/helpers/runner-server.mjs) does not serve: ${missing.join(", ")}`);
});

test("the server answers each listed route, and only those", async (t) => {
  const server = await serveRunner();
  t.after(server.close);
  const call = async (method, path) => (await fetch(`${server.url}/api/${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) })).status;
  for (const [method, template] of RUNNER_ROUTES) assert.equal(await call(method, concrete(template).join("/")), 200, `${method} ${template}`);
  assert.equal(await call("POST", "projects/demo/items/t1/unknown"), 404);
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
