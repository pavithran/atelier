import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// Task t94: any agent whose token reached the project could record an
// observed check on a task it neither held nor worked on, and the gate
// counts the latest one, so another agent could pass or fail a task's
// checks. Only the task's holder records a check through the API; anyone
// may ask the sandbox, which runs the checks and records them itself.

const TOKEN = "check-holder-token";
const A = "claude-code/opus-5.5", B = "codex/gpt-6-astra";
const H1 = "a".repeat(40);
const bindings = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

function call(bearer: string, actor: string | null, method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings);
}

it("only the task's holder records an observed check through the API; another agent's or the owner's is refused, and reports stay open", async () => {
  const name = "check-holder";
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  await L.newItem("Checked by its holder", [], "owner");
  await L.claim("t1", A);
  await L.recordPush("t1", A, H1, H1);
  const token = async (actor: string) => ((await (await call(TOKEN, "owner", "POST", "/tokens", { actor, projects: [name] })).json()) as { token: string }).token;
  const holder = await token(A), other = await token(B);
  const evidence = (bearer: string, actor: string | null, body: Record<string, unknown>) => call(bearer, actor, "POST", `/projects/${name}/items/t1/evidence`, body);
  const check = (passed: boolean) => ({ kind: "check", claim: "npm test", head: H1, passed, changedPaths: [] });

  // Another agent in scope, and the owner token naming any actor but the holder, are refused.
  for (const [bearer, actor] of [[other, null], [TOKEN, "owner"], [TOKEN, B]] as const) {
    const res = await evidence(bearer, actor, check(false));
    expect(res.status, `${actor ?? B}: ${await res.clone().text()}`).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_owner", detail: `${actor ?? B} does not hold t1, so it cannot record t1's checks: only its holder, ${A}, can. To have Atelier run them, use atelier check t1 --sandbox` });
  }
  expect(await L.evidenceFor("t1")).toEqual([]);

  // The holder records the pass; another agent cannot then record a failure over it.
  expect((await evidence(holder, null, check(true))).status).toBe(200);
  expect((await evidence(other, null, check(false))).status).toBe(403);
  const rows = await L.evidenceFor("t1");
  expect(rows.map((e) => [e.grade, e.by, e.passed])).toEqual([["observed", A, true]]);

  // A report is shown, never counted, so any agent in scope may still record one.
  expect((await evidence(other, null, { kind: "report", claim: "Read the change", head: H1 })).status).toBe(200);
  expect((await L.evidenceFor("t1")).map((e) => [e.grade, e.by])).toEqual([["observed", A], ["reported", B]]);

  // With nobody holding the task, nobody records a check on it.
  await L.release("t1", A, "");
  const unheld = await evidence(TOKEN, A, check(true));
  expect(unheld.status).toBe(403);
  expect(((await unheld.json()) as { detail: string }).detail).toContain("only its holder, nobody, can");
});
