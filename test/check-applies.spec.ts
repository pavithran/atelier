import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { CheckRunner, RunRequest, RunState } from "../src/sandbox/runner.ts";

// A check can apply only when an item's changed paths match its globs. These
// tests drive init, the evidence route, the sandbox route and the runner, and
// ask that a check is recorded as not applicable only where the paths the
// Worker measures show it, and that the gate then does not wait for it.

const TOKEN = "check-applies-owner";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const A = "claude-code/opus-5.5";
const H0 = "0".repeat(40), H1 = "a".repeat(40), T0 = "1".repeat(40), T1 = "2".repeat(40);

function api(bindings: typeof env = testEnv) {
  return (method: string, path: string, actor: string, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings);
}

// Main holds T0; the fork's head H1 holds T1, which differs from it in `changed`.
function store(name: string, changed: string) {
  const trees: Record<string, Record<string, string>> = {
    [T0]: { "README.md": "b".repeat(40), [changed]: "c".repeat(40) },
    [T1]: { "README.md": "b".repeat(40), [changed]: "d".repeat(40) },
  };
  const logs: Record<string, { hash: string; parents: string[]; treeHash: string }[]> = {
    [name]: [{ hash: H0, parents: [], treeHash: T0 }],
    [`${name}--t1`]: [{ hash: H1, parents: [H0], treeHash: T1 }, { hash: H0, parents: [], treeHash: T0 }],
  };
  return {
    create: async () => ({}),
    get: async (repo: string) => ({
      log: async (opts: { limit?: number } = {}) => (logs[repo] ?? []).slice(0, opts.limit ?? 50),
      readCommit: async (h: string) => (logs[repo] ?? []).find((c) => c.hash === h) ?? null,
      readTree: async (h: string) => trees[h] ? Object.entries(trees[h]).map(([n, hash]) => ({ name: n, mode: "100644", hash, type: "blob" })) : null,
      readBlob: async () => null,
      info: async () => ({ remote: "https://git.test/r.git", defaultBranch: "main" }),
      createToken: async () => ({ plaintext: "t", id: "i", expiresAt: "x" }),
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
}

const POLICY = { checks: ["npm test", "xcodebuild build"], checkPaths: [{ command: "xcodebuild build", paths: ["App/**", "project.yml"] }], protected: [] };

async function pushed(name: string, policy: object = POLICY) {
  const record = { name, repo: name, policy, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  await L.newItem("Work", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  await L.recordPush("t1", A, H1, H1);
  return L;
}

type Detail = { evidence: Record<string, unknown>[]; gate: { ready: boolean; blockers: string[] } };

it("a check is recorded as not applicable only where the measured paths show it, and the gate then does not wait for it", async () => {
  const name = "applies-docs";
  const L = await pushed(name);
  const call = api({ ...testEnv, ARTIFACTS: store(name, "docs/a.md") } as typeof env);
  // The change touches docs/a.md: the build does not apply; npm test applies to every change.
  const everywhere = await call("POST", `/projects/${name}/items/t1/evidence`, A, { kind: "check", claim: "npm test", head: H1, notApplicable: true });
  expect(everywhere.status).toBe(409);
  expect(await everywhere.json()).toEqual({ error: "check_applies", detail: "`npm test` applies to every change; run it" });
  const na = await call("POST", `/projects/${name}/items/t1/evidence`, A, { kind: "check", claim: "xcodebuild build", head: H1, notApplicable: true, passed: true });
  expect(na.status, await na.clone().text()).toBe(200);
  expect(((await L.detail("t1")) as Detail).evidence.at(-1)).toMatchObject({ claim: "xcodebuild build", grade: "observed", passed: null, notApplicable: true, changedPaths: ["docs/a.md"], where: "runner" });
  expect((await call("POST", `/projects/${name}/items/t1/evidence`, A, { kind: "check", claim: "npm test", head: H1, passed: true })).status).toBe(200);
  expect((await call("POST", `/projects/${name}/items/t1/submit`, A, {})).status).toBe(200);
  expect(((await L.detail("t1")) as Detail).gate).toMatchObject({ ready: true, blockers: [] });
  // The record is logged as its own kind, never as a passed check (events are newest first).
  const kinds = ((await L.events("t1")) as unknown as { kind: string }[]).map((e) => e.kind);
  expect(kinds.filter((k) => k.startsWith("evidence."))).toEqual(["evidence.observed", "evidence.not_applicable"]);
  // The item page lists it as not applicable.
  const page = await (await worker.fetch(new Request(`https://atelier.test/p/${name}/t1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" } }), testEnv)).text();
  expect(page).toContain("Not applicable");
  expect(page).toContain("This check applies only when the change touches App/**, project.yml, and this revision touches none of those paths.");
  expect(page).toContain("1 of 1 required checks passed at this revision. 1 more does not apply to it.");
});

it("a check whose paths the change touches cannot be recorded as not applicable, whatever the caller says", async () => {
  const name = "applies-app";
  const L = await pushed(name);
  const call = api({ ...testEnv, ARTIFACTS: store(name, "App/View.swift") } as typeof env);
  const res = await call("POST", `/projects/${name}/items/t1/evidence`, A, { kind: "check", claim: "xcodebuild build", head: H1, notApplicable: true, changedPaths: ["docs/a.md"] });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "check_applies", detail: "`xcodebuild build` applies to this change, which touches App/View.swift; run it" });
  expect(((await L.detail("t1")) as Detail).evidence).toEqual([]);
  expect((await call("POST", `/projects/${name}/items/t1/evidence`, A, { kind: "check", claim: "npm test", head: H1, passed: true })).status).toBe(200);
  expect(((await L.detail("t1")) as Detail).gate.blockers).toContain("`xcodebuild build` not yet observed at this head");
});

it("init records the paths a check applies to, for registered checks only, and the standing shows them", async () => {
  const name = "applies-init";
  const call = api({ ...testEnv, ARTIFACTS: store(name, "docs/a.md") } as typeof env);
  const stray = await call("PUT", `/projects/${name}`, "owner", { checks: ["npm test"], checkPaths: [{ command: "make test", paths: ["src/**"] }] });
  expect(stray.status).toBe(400);
  expect(await stray.json()).toMatchObject({ error: "bad_check_paths" });
  expect((await call("PUT", `/projects/${name}`, "owner", { checks: ["npm test"], checkPaths: [{ command: "npm test", paths: [] }] })).status).toBe(400);
  const ok = await call("PUT", `/projects/${name}`, "owner", { checks: ["npm test", "make test"], checkPaths: [{ command: "make test", paths: ["src/**"] }] });
  expect(ok.status, await ok.clone().text()).toBe(200);
  // An init that names the checks again, without paths, keeps those of the checks still registered.
  expect((await call("PUT", `/projects/${name}`, "owner", { checks: ["make test"] })).status).toBe(200);
  const standing = await (await call("GET", `/projects/${name}/standing`, A)).json() as { checks: { command: string; paths: string[] | null }[] };
  expect(standing.checks).toMatchObject([{ command: "make test", paths: ["src/**"] }]);
  const page = await (await worker.fetch(new Request(`https://atelier.test/p/${name}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" } }), testEnv)).text();
  expect(page).toContain("read-only, a known build or test command; applies only when the change touches src/**");
});

it("the sandbox route sends each check's paths, and the runner records a check that does not apply without running it or starting a container", async () => {
  const name = "applies-sandbox";
  await pushed(name, { ...POLICY, checks: ["xcodebuild build"] });
  const ARTIFACTS = store(name, "docs/a.md");
  const started = await api({ ...testEnv, ARTIFACTS } as typeof env)("POST", `/projects/${name}/items/t1/sandbox`, A, {});
  expect(started.status).toBe(202);
  const { state } = await started.json() as { state: RunState };
  expect(state.request.checkPaths).toEqual(POLICY.checkPaths);

  // The run itself, with the fake Artifacts, in a runner of its own.
  const runId = `${name}:t1:direct`;
  const request: RunRequest = { ...state.request, runId };
  const stub = env.RUNNER.get(env.RUNNER.idFromName(runId));
  const after = await runInDurableObject(stub, async (instance: CheckRunner, s: DurableObjectState) => {
    (instance as unknown as { env: typeof env }).env = { ...env, ARTIFACTS } as typeof env;
    await s.storage.put("state", { status: "queued", request, queuedAt: new Date().toISOString() } satisfies RunState);
    await instance.alarm();
    return s.storage.get<RunState>("state");
  });
  expect(after).toMatchObject({ status: "done", recorded: true, changedPaths: ["docs/a.md"], results: [{ claim: "xcodebuild build", passed: null, notApplicable: true }] });
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  expect(((await L.detail("t1")) as Detail).evidence.at(-1)).toMatchObject({ claim: "xcodebuild build", passed: null, notApplicable: true, where: "sandbox", by: "atelier/sandbox" });
  // A check that applies is run, which needs the container this test has none of.
  const runId2 = `${name}:t1:applies`;
  const stub2 = env.RUNNER.get(env.RUNNER.idFromName(runId2));
  const applied = await runInDurableObject(stub2, async (instance: CheckRunner, s: DurableObjectState) => {
    (instance as unknown as { env: typeof env }).env = { ...env, ARTIFACTS: store(name, "App/View.swift") } as typeof env;
    await s.storage.put("state", { status: "queued", request: { ...request, runId: runId2 }, queuedAt: new Date().toISOString() } satisfies RunState);
    await instance.alarm();
    return s.storage.get<RunState>("state");
  });
  expect(applied).toMatchObject({ status: "failed", error: "no container is configured for CheckRunner", results: [] });
});
