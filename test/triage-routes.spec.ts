import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";

// Triage before the review (t475), on the server: the project's triage
// model is set with `atelier init --triage` and kept by the policy. The
// landing Workflow that triaged on the server is gone (Atelier 2.0, task 6);
// the CLI half (the triage itself, the stops and the owner's bypass and
// override) is in test/triage.test.mjs.

const TOKEN = "triage-routes-token";
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";

// The Artifacts calls a PUT makes, stubbed so the init route runs to completion here.
const artifacts = {
  create: async () => {},
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
    [Symbol.dispose]() {},
  }),
} as unknown as Repos;
const initEnv = { ...env, ATELIER_TOKEN: TOKEN, REPOS: artifacts } as typeof env;

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

async function registered(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
}

it("init --triage records the project's triage model, keeps it on re-init, clears it on an empty one, and refuses one not harness/model under a shipped harness (t475)", async () => {
  await registered("triage-init");
  const put = (fields: Record<string, unknown>) => worker.fetch(new Request("https://atelier.test/api/projects/triage-init", {
    method: "PUT",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" },
    body: JSON.stringify({ checks: ["npm test"], protected: [], ...fields }),
  }), initEnv);
  const triageOf = async (fields: Record<string, unknown>) =>
    (((await (await put(fields)).json()) as { project: { policy: { triage?: string } } }).project.policy.triage);
  expect(await triageOf({})).toBeUndefined();
  expect(await triageOf({ triage: GPT })).toBe(GPT);
  expect(await triageOf({ title: "Kept" })).toBe(GPT);
  expect((await ledger("triage-init").project()).policy.triage).toBe(GPT);
  expect(await triageOf({ triage: "" })).toBeUndefined();
  expect(await triageOf({ triage: OPUS })).toBe(OPUS);
  expect(await triageOf({ triage: null })).toBeUndefined();
  for (const bad of ["gpt-6-astra", 7, "a/b c", "cursor/composer-2"]) {
    const res = await put({ triage: bad });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_triage");
  }
  // A reset starts the policy over, triage included.
  await put({ triage: GPT });
  expect(await triageOf({ reset: true })).toBeUndefined();
});
