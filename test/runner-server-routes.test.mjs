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

// The authoritative inventory: every METHOD + path-shape runnerRoute accepts,
// found by asking runnerRoute itself. Words are every quoted word in its source;
// position 1 is the project and position 3 the item id; a final segment runnerRoute
// accepts for any word is written "*".
function runnerInventory() {
  const source = readFileSync(new URL("../src/tokens.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function runnerRoute"), source.indexOf("export function runnerDenied"));
  const words = [...new Set([...body.matchAll(/"([a-z][a-z-]*)"/g)].map((m) => m[1]).filter((w) => w !== "GET" && w !== "POST"))];
  assert.ok(words.length >= 20, "found the route words in runnerRoute");
  const found = new Set();
  const fixed = [null, "demo", null, "t1", null, null];
  const extend = (parts, length) => {
    if (parts.length === length) return [parts];
    const i = parts.length;
    return (fixed[i] ? [fixed[i]] : i === length - 1 && i >= 2 ? ["x", ...words] : words).flatMap((w) => extend([...parts, w], length));
  };
  for (let length = 1; length <= 6; length++) {
    for (const parts of extend([], length)) {
      for (const method of ["GET", "POST"]) {
        if (!runnerRoute(method, parts, {})) continue;
        const shape = parts.map((p) => p === "demo" ? ":project" : p === "t1" ? ":id" : p);
        if (length >= 3 && parts[length - 1] !== "x" && runnerRoute(method, [...parts.slice(0, -1), "x"], {})) continue;
        found.add(`${method} ${shape.map((p, i) => i === length - 1 && p === "x" && length > 1 ? "*" : p).join("/")}`);
      }
    }
  }
  return [...found].sort();
}
const helperSignatures = (routes) => routes.filter(([method, template]) => runnerRoute(method, concrete(template), {})).map(([method, template]) => `${method} ${template}`).sort();

test("the shared helper serves exactly the METHOD + path shapes runnerRoute accepts", () => {
  const inventory = runnerInventory();
  assert.ok(inventory.length >= 20, "found the routes in runnerRoute");
  assert.deepEqual(helperSignatures(RUNNER_ROUTES), inventory, "test/helpers/runner-server.mjs and runnerRoute (src/tokens.ts) disagree");
});

test("a GET added beside an existing POST of the same path is not served, and the guard sees it", () => {
  const inventory = runnerInventory();
  const plan = "projects/:project/items/:id/plan";
  assert.ok(RUNNER_ROUTES.some(([m, t]) => m === "POST" && t === plan));
  assert.ok(!RUNNER_ROUTES.some(([m, t]) => m === "GET" && t === plan));
  // Mutate: runnerRoute that also accepts GET items/:id/plan yields a signature the helper lacks.
  const mutated = (method, parts, body) => runnerRoute(method, parts, body) || method === "GET" && parts.join("/") === "projects/demo/items/t1/plan";
  assert.ok(mutated("GET", concrete(plan), {}));
  const withMutation = [...inventory, `GET ${plan}`].sort();
  assert.notDeepEqual(helperSignatures(RUNNER_ROUTES), withMutation);
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
