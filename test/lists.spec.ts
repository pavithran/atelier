import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// The string lists a request body carries (a project's checks, protected
// paths and eligible agents; an item's scope) must be arrays of strings with
// something in each. An entry of another type is refused with 400 bad_list
// naming the field, never coerced: `checks: [true]` would otherwise become
// the required check "true", which /bin/sh passes every time.

const TOKEN = "lists-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

// PUT creates the baseline in Artifacts before the Ledger write; this pool
// does not reach Artifacts, so a stand-in answers those two calls.
const artifacts = {
  create: async () => ({}),
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
    [Symbol.dispose]() {},
  }),
} as unknown as Artifacts;

function call(method: string, path: string, body: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { ...testEnv, ARTIFACTS: artifacts } as typeof env);
}

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`)).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
}

const BAD = [[true], [5], ["ok", true], [""], ["   "], [null], "npm test", null, {}, 7];

it("an item's scope must be a list of non-empty strings", async () => {
  await project("lists-scope");
  for (const scope of BAD) {
    const res = await call("POST", "/projects/lists-scope/items", { title: "Scoped", scope });
    expect(res.status, JSON.stringify(scope)).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("bad_list");
    expect(body.detail).toMatch(/^scope must be a list/);
  }
  const trimmed = await call("POST", "/projects/lists-scope/items", { title: "Scoped", scope: [" src/** ", "test/**"] });
  expect(trimmed.status, await trimmed.clone().text()).toBe(201);
  expect(((await trimmed.json()) as { scope: string[] }).scope).toEqual(["src/**", "test/**"]);
  const open = await call("POST", "/projects/lists-scope/items", { title: "Open" });
  expect(open.status).toBe(201);
  expect(((await open.json()) as { scope: string[] }).scope).toEqual([]);
});

it("a project's checks, protected paths and eligible agents must each be a list of non-empty strings", async () => {
  for (const field of ["checks", "protected", "eligible", "shipRuns", "shipKinds"]) {
    for (const value of BAD) {
      const res = await call("PUT", "/projects/lists-policy", { [field]: value });
      expect(res.status, `${field}: ${JSON.stringify(value)}`).toBe(400);
      const body = (await res.json()) as { error: string; detail: string };
      expect(body.error).toBe("bad_list");
      expect(body.detail.startsWith(`${field} must be a list`), body.detail).toBe(true);
    }
  }
  // A refused init registers nothing.
  const listed = (await env.LEDGER.get(env.LEDGER.idFromName("__index")).projects()) as { name: string }[];
  expect(listed.some((p) => p.name === "lists-policy")).toBe(false);
  const ok = await call("PUT", "/projects/lists-policy", {
    checks: [" npm test "], protected: ["AGENTS.md"], eligible: ["codex"],
    shipRuns: [" bin/deploy.sh "], shipKinds: ["deploy"],
  });
  expect(ok.status, await ok.clone().text()).toBe(200);
  expect(((await ok.json()) as { project: { policy: Record<string, string[]> } }).project.policy)
    .toMatchObject({ checks: ["npm test"], protected: ["AGENTS.md"], eligible: ["codex"], shipRuns: ["bin/deploy.sh"], shipKinds: ["deploy"] });
});
