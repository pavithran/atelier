import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { mergeProject } from "../src/ledger.ts";

// The project's commit identity (t451) as the server keeps it: init records
// and checks it, a later init changes only what it names, a reset drops it,
// and every claim answers it, so the CLI writes it into the workspace on
// whatever machine claims.

const TOKEN = "commit-identity-test-token";
const H0 = "0".repeat(40);
const OWNER = { name: "Project Owner", email: "123+owner@users.noreply.github.com" };

const artifacts = {
  create: async () => ({}),
  get: async (repo: string) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: `id-${Math.random()}`, expiresAt: "soon" }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }),
} as unknown as Artifacts;

function call(method: string, path: string, body?: unknown, actor = "owner") {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as typeof env);
}

type Policy = { commitIdentity?: { name: string; email: string; agentEmails: string[]; privateEmails?: string[]; publicMirrors?: string[] } };

it("init records a validated commit identity, keeps it on a re-init, refuses an invalid one and drops it on a reset", async () => {
  const policyOf = async (body: unknown) => {
    const res = await call("PUT", "/projects/identity-init", body);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { project: { policy: Policy } }).project.policy;
  };
  expect(await policyOf({ checks: ["npm test"] })).not.toHaveProperty("commitIdentity");
  expect((await policyOf({ commitName: OWNER.name, commitEmail: OWNER.email, agentEmails: ["agents@atelier.example"] })).commitIdentity)
    .toEqual({ ...OWNER, agentEmails: ["agents@atelier.example"] });
  expect((await policyOf({ title: "Identity" })).commitIdentity?.email).toBe(OWNER.email);
  expect((await policyOf({ privateEmails: ["owner@personal.example"] })).commitIdentity).toEqual({ ...OWNER, agentEmails: ["agents@atelier.example"], privateEmails: ["owner@personal.example"] });
  expect((await policyOf({ publicMirrors: ["github"] })).commitIdentity?.publicMirrors).toEqual(["github"]);
  expect((await policyOf({ publicMirrors: [] })).commitIdentity).not.toHaveProperty("publicMirrors");

  for (const [body, detail] of [
    [{ commitEmail: "pavi@studio.local" }, /commitEmail "pavi@studio\.local" is one Git guesses/],
    [{ agentEmails: ["owner@personal.example"] }, /agentEmails owner@personal\.example is declared private/],
    [{ commitName: "" }, /commitName must be/],
    [{ publicMirrors: ["-x"] }, /publicMirrors "-x" is not a remote name/],
  ] as const) {
    const bad = await call("PUT", "/projects/identity-init", body);
    expect(bad.status).toBe(400);
    const answer = (await bad.json()) as { error: string; detail: string };
    expect(answer.error).toBe("bad_identity");
    expect(answer.detail).toMatch(detail);
  }
  // A refused init changed nothing.
  expect((await policyOf({})).commitIdentity?.email).toBe(OWNER.email);
  expect(await policyOf({ reset: true, checks: ["npm test"] })).not.toHaveProperty("commitIdentity");
  const first = mergeProject(null, { name: "m", repo: "m", reset: false }, "now");
  expect(() => mergeProject(first, { name: "m", repo: "m", reset: false, commitIdentity: { commitEmail: OWNER.email } }, "now")).toThrow(/needs both a name and an address/);
});

it("every claim answers the project's commit identity, or null for a project that names none", async () => {
  const name = "identity-claim";
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  await L.newItem("Edit", [], "owner");
  await L.claim("t1", "owner");
  await L.setFork("t1", `${name}--t1`, H0, "owner");
  const claim = async () => {
    const res = await call("POST", `/projects/${name}/items/t1/claim`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { commitIdentity: unknown }).commitIdentity;
  };
  expect(await claim()).toBeNull();
  const set = await call("PUT", `/projects/${name}`, { commitName: OWNER.name, commitEmail: OWNER.email });
  expect(set.status, await set.clone().text()).toBe(200);
  expect(await claim()).toEqual({ ...OWNER, agentEmails: [] });
});

it("init stores mirror destinations and privacy rules in the same registered identity policy", async () => {
  const fields = { publicMirrors: ["github"], publicMirrorDestinations: { github: "https://example.org/public.git" }, privatePaths: ["private/**"], privatePatterns: ["INTERNAL-[0-9]+"] };
  const res = await call("PUT", "/projects/mirror-policy", { commitName: OWNER.name, commitEmail: OWNER.email, ...fields });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ project: { policy: { commitIdentity: fields } } });
  const keep = await call("PUT", "/projects/mirror-policy", { title: "Kept" });
  expect(await keep.json()).toMatchObject({ project: { policy: { commitIdentity: fields } } });
  const bad = await call("PUT", "/projects/mirror-policy", { privatePatterns: ["("] });
  expect(bad.status).toBe(400);
});
