import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { CheckRunner, RunRequest, RunState } from "../src/sandbox/runner.ts";

// Every registered check must be read-only (src/checks.ts). These tests drive
// init, the evidence route, the sandbox route and the runner through the
// Worker and its Durable Objects, and ask that a check that deploys is never
// registered, run or counted, that an undeclared one needs the owner's
// declaration, and that a project's existing checks keep running.

const TOKEN = "check-classes-owner";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

function artifacts(created: string[]) {
  return {
    create: async (name: string) => { created.push(name); return {}; },
    get: async () => ({ info: async () => ({ remote: "https://example/r.git", defaultBranch: "main" }), createToken: async () => ({ plaintext: "t", id: "i", expiresAt: "x" }), [Symbol.dispose]() {} }),
  } as unknown as Artifacts;
}

function api(bindings: typeof env = testEnv) {
  return (method: string, path: string, actor: string, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings);
}

// A project as one registered before checks had classes: its checks carry none.
async function legacy(name: string, checks: string[]) {
  const record = { name, repo: name, policy: { checks, protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}

type Policy = { checks: string[]; checkClasses?: { command: string; by: string; note?: string }[] };

it("init refuses a check that deploys before it makes the baseline, whatever is declared", async () => {
  const created: string[] = [];
  const call = api({ ...testEnv, ARTIFACTS: artifacts(created) } as typeof env);
  for (const body of [
    { checks: ["npm test", "npx wrangler deploy"] },
    { checks: ["npm --prefix web run deploy"], checkClasses: [{ command: "npm --prefix web run deploy", by: "owner", note: "trust me" }] },
    { checks: ["sh -c 'npm ci && git push'"] },
  ]) {
    const res = await call("PUT", "/projects/classes-refused", "owner", body);
    expect(res.status).toBe(400);
    const error = await res.json() as { error: string; detail: string };
    expect(error.error).toBe("not_read_only");
    expect(error.detail).toMatch(/is not a check: it (deploys|runs a script whose name says it deploys|pushes)/);
  }
  expect(created).toEqual([]);
  expect((await call("GET", "/projects/classes-refused", "owner")).status).toBe(404);
});

it("init records how each check is read-only, needs the owner's declaration for one it cannot read, and keeps it on the next init", async () => {
  const call = api({ ...testEnv, ARTIFACTS: artifacts([]) } as typeof env);
  const policy = async () => ((await (await call("GET", "/projects/classes-declared", "owner")).json()) as { project: { policy: Policy } }).project.policy;
  const undeclared = await call("PUT", "/projects/classes-declared", "owner", { checks: ["npm test", "./check.sh"] });
  expect(undeclared.status).toBe(400);
  expect(await undeclared.json()).toMatchObject({ error: "undeclared_check", detail: expect.stringMatching(/`\.\/check\.sh` is not a command Atelier knows to be read-only.*--declare-read-only/) });
  const note = "PAVI, 2026-10-06: check.sh builds and runs the unit tests";
  const declared = await call("PUT", "/projects/classes-declared", "owner", { checks: ["npm test", "./check.sh"], checkClasses: [{ command: "./check.sh", by: "owner", note }] });
  expect(declared.status, await declared.clone().text()).toBe(200);
  expect((await policy()).checkClasses).toEqual([{ command: "npm test", by: "command" }, { command: "./check.sh", by: "owner", note }]);
  // Naming the same check again keeps the declaration; a request cannot record "command" itself.
  expect((await call("PUT", "/projects/classes-declared", "owner", { checks: ["./check.sh"] })).status).toBe(200);
  expect((await policy()).checkClasses).toEqual([{ command: "./check.sh", by: "owner", note }]);
  expect((await call("PUT", "/projects/classes-declared", "owner", { checkClasses: [{ command: "./check.sh", by: "command" }] })).status).toBe(400);
  // --reset starts the classes over with the checks.
  expect((await call("PUT", "/projects/classes-declared", "owner", { reset: true, checks: ["./check.sh"] })).status).toBe(400);
});

it("a project's existing checks keep running: an init that names no checks keeps them, records the known ones and may declare the rest", async () => {
  const L = await legacy("classes-legacy", ["npm ci && npm test", "./scripts/verify.sh"]);
  const call = api({ ...testEnv, ARTIFACTS: artifacts([]) } as typeof env);
  const retitled = await call("PUT", "/projects/classes-legacy", "owner", { title: "Legacy" });
  expect(retitled.status, await retitled.clone().text()).toBe(200);
  expect((await L.project()).policy).toMatchObject({ checks: ["npm ci && npm test", "./scripts/verify.sh"], checkClasses: [{ command: "npm ci && npm test", by: "command" }] });
  // The standing says which is which.
  const standing = await (await call("GET", "/projects/classes-legacy/standing", "codex/gpt-6-astra")).json() as { checks: { command: string; class: string; text: string; paths: string[] | null }[] };
  expect(standing.checks).toEqual([
    { command: "npm ci && npm test", class: "read-only", text: "read-only, a known build or test command", paths: null },
    { command: "./scripts/verify.sh", class: "undeclared", text: expect.stringMatching(/^undeclared: .*--declare-read-only/), paths: null },
  ]);
  // A declaration for a registered check is recorded; one for a command the project lacks is refused.
  expect((await call("PUT", "/projects/classes-legacy", "owner", { checkClasses: [{ command: "./other.sh", by: "owner", note: "n" }] })).status).toBe(400);
  const note = "PAVI, 2026-10-06: verify.sh reads the docs and runs the tests";
  expect((await call("PUT", "/projects/classes-legacy", "owner", { checkClasses: [{ command: "./scripts/verify.sh", by: "owner", note }] })).status).toBe(200);
  expect((await L.project()).policy.checkClasses).toEqual([{ command: "npm ci && npm test", by: "command" }, { command: "./scripts/verify.sh", by: "owner", note }]);
  const page = await (await worker.fetch(new Request("https://atelier.test/p/classes-legacy/settings", { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" } }), testEnv)).text();
  expect(page).toContain("read-only, declared by the project owner: PAVI, 2026-10-06: verify.sh reads the docs and runs the tests");
});

it("a check that deploys is neither run in the sandbox nor counted from anyone's machine, even when it was registered before the rule", async () => {
  const name = "classes-sandbox", A = "claude-code/opus-5.5", H0 = "0".repeat(40), H1 = "a".repeat(40);
  const L = await legacy(name, ["npm test", "npx wrangler deploy"]);
  await L.newItem("Work", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  await L.recordPush("t1", A, H1, H1);
  const call = api();
  const sandbox = await call("POST", `/projects/${name}/items/t1/sandbox`, A, {});
  expect(sandbox.status).toBe(409);
  expect(await sandbox.json()).toMatchObject({ error: "not_read_only", detail: expect.stringMatching(/`npx wrangler deploy` is not a check: it deploys .*the container runs nothing/) });
  const evidence = await call("POST", `/projects/${name}/items/t1/evidence`, A, { kind: "check", claim: "npx wrangler deploy", passed: true, head: H1 });
  expect(evidence.status).toBe(409);
  expect(await evidence.json()).toMatchObject({ error: "not_read_only" });
  expect(((await L.detail("t1")) as { evidence: unknown[] }).evidence).toEqual([]);
  // A report is words, never run, and is recorded as before.
  expect((await call("POST", `/projects/${name}/items/t1/evidence`, A, { kind: "report", claim: "npx wrangler deploy worked", head: H1 })).status).toBe(200);
});

it("the runner refuses a check that deploys before it reads the workspace or starts a container", async () => {
  const runId = "classes-runner:t1:aaaaaaaaaaaa:1";
  const request: RunRequest = { runId, project: "classes-runner", itemId: "t1", baselineRepo: "base", fork: "base--t1", head: "a".repeat(40), checks: ["npm test", "npx wrangler deploy"], requestedBy: "owner" };
  // The run is stored as start() leaves it and its alarm is called here, so
  // no alarm the runtime fires on its own can race the test.
  const stub = env.RUNNER.get(env.RUNNER.idFromName(runId));
  const state = await runInDurableObject(stub, async (instance: CheckRunner, s: DurableObjectState) => {
    await s.storage.put("state", { status: "queued", request, queuedAt: new Date().toISOString() } satisfies RunState);
    await instance.alarm();
    return s.storage.get<RunState>("state");
  });
  expect(state).toMatchObject({ status: "failed", error: expect.stringMatching(/`npx wrangler deploy` is not a check: it deploys/) });
  expect(state?.results).toBeUndefined();
});
