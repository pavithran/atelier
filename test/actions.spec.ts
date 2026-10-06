import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { parseRuleError } from "../src/rules.ts";
import { signIn } from "./signin.ts";

// Protected-action approvals in the Ledger's own storage, over Durable Object
// RPC, and through the Worker's routes and the project page's forms. The
// Artifacts binding is a stand-in holding one main line, H0 <- H1 <- H2, so
// the check that an approval names a commit on the main line runs for real.
// test/actions.test.ts covers the rules with the clock set by hand.

const TOKEN = "actions-test-token";
const H0 = "0".repeat(40), H1 = "1".repeat(40), H2 = "2".repeat(40), FORK = "f".repeat(40);
const LINE = [{ hash: H2, parents: [H1] }, { hash: H1, parents: [H0] }, { hash: H0, parents: [] }];
const artifacts = {
  async get() {
    return {
      async log(o: { ref?: string; limit?: number } = {}) {
        const from = o.ref ? LINE.findIndex((c) => c.hash === o.ref) : 0;
        return from < 0 ? [] : LINE.slice(from, from + (o.limit ?? 1000));
      },
      [Symbol.dispose]() {},
    };
  },
};
const testEnv = { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as unknown as typeof env;
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return ledger(name);
}

function api(method: string, path: string, actor: string, body?: unknown, token = TOKEN) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

it("the Ledger records approvals, uses each once at its revision only, and records the runs", async () => {
  const L = await project("actions-ledger");
  const a = await L.approveAction({ kind: "deploy", commit: H2, note: "release" }, "owner");
  expect(a).toMatchObject({ id: "a1", kind: "deploy", commit: H2, note: "release", status: "active", by: "owner" });
  await refusal(L.approveAction({ kind: "deploy", commit: H2 }, "owner"), "already_approved", /already approved as a1/);
  await refusal(L.approveAction({ kind: "deploy", commit: H1 }, "codex/gpt-6-astra"), "not_project_owner", /only the project owner/);
  await refusal(L.consumeAction({ kind: "deploy", commit: H1 }, "owner"), "not_approved", /approved only at another revision \(a1 at 22222222\)/);
  expect(await L.consumeAction({ kind: "deploy", commit: H2 }, "owner")).toMatchObject({ id: "a1", status: "consumed" });
  await refusal(L.consumeAction({ kind: "deploy", commit: H2 }, "owner"), "not_approved", /a1 for it is consumed/);
  const run = { step: "deploy", kind: "deploy", approval: "a1", command: "npx wrangler deploy", commit: H2, exitStatus: 0, durationMs: 900, passed: true, outputTail: "done", ship: "s-1" };
  await L.recordActionRun(run, "owner");
  await refusal(L.recordActionRun({ ...run, approval: "a2" }, "owner"), "bad_run", /a2 was not used/);
  await L.approveAction({ kind: "push", commit: H2 }, "owner");
  await refusal(L.withdrawAction("a2", "codex/gpt-6-astra", ""), "not_project_owner", /only the project owner/);
  expect(await L.withdrawAction("a2", "owner", "not today")).toMatchObject({ status: "withdrawn" });
  expect((await L.actionApprovals()).map((x) => [x.id, x.status])).toEqual([["a2", "withdrawn"], ["a1", "consumed"]]);
  expect((await L.actionRuns()).map((r) => [r.step, r.approval, r.passed])).toEqual([["deploy", "a1", true]]);
  const events = (await L.events() as unknown as LedgerEvent[]).filter((e) => e.kind.startsWith("action."));
  expect(events.map((e) => e.kind).reverse()).toEqual(["action.approved", "action.consumed", "action.ran", "action.approved", "action.withdrawn"]);
  expect(events.every((e) => e.itemId === null && e.actor === "owner")).toBe(true);
});

it("the routes are the owner's: an agent token and any other actor are refused", async () => {
  await project("actions-owner");
  const issued = await (await api("POST", "/tokens", "owner", { actor: "codex/gpt-6-astra", label: "agent" })).json() as { token: string };
  for (const [method, path, body] of [
    ["GET", "/projects/actions-owner/actions", undefined],
    ["POST", "/projects/actions-owner/actions", { kind: "deploy", commit: H2 }],
    ["POST", "/projects/actions-owner/actions/consume", { kind: "deploy", commit: H2 }],
    ["POST", "/projects/actions-owner/actions/runs", {}],
    ["POST", "/projects/actions-owner/actions/a1/withdraw", {}],
  ] as const) {
    const byAgent = await api(method, path, "codex/gpt-6-astra", body, issued.token);
    expect(byAgent.status, `${method} ${path}`).toBe(403);
    expect((await byAgent.json() as { error: string }).error).toBe("owner_token_required");
    const asOther = await api(method, path, "codex/gpt-6-astra", body);
    expect(asOther.status, `${method} ${path}`).toBe(403);
    expect((await asOther.json() as { error: string }).error).toBe("not_project_owner");
  }
});

it("an approval names a commit on the main line, at the full revision, with an expiry in bounds", async () => {
  await project("actions-route");
  const approve = (body: Record<string, unknown>) => api("POST", "/projects/actions-route/actions", "owner", body);
  const made = await approve({ kind: "deploy", commit: H1, note: "an older revision of the main line", expires: "90m" });
  expect(made.status).toBe(201);
  const a = await made.json() as { id: string; expiresAt: string; status: string };
  expect(a.status).toBe("active");
  expect(Date.parse(a.expiresAt) - Date.now()).toBeGreaterThan(89 * 60_000);
  const fork = await approve({ kind: "deploy", commit: FORK });
  expect(fork.status).toBe(409);
  expect(await fork.json()).toMatchObject({ error: "not_on_main_line" });
  for (const [body, code] of [
    [{ kind: "deploy", commit: "2222" }, "bad_revision"],
    [{ kind: "Deploy!", commit: H2 }, "bad_kind"],
    [{ kind: "deploy", commit: H2, expires: "90d" }, "bad_expiry"],
  ] as const) {
    const r = await approve(body);
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toBe(code);
  }
  // The rest of the lifecycle through the routes.
  const list = await (await api("GET", "/projects/actions-route/actions", "owner")).json() as { approvals: { id: string }[]; runs: unknown[] };
  expect(list.approvals.map((x) => x.id)).toEqual(["a1"]);
  expect((await api("POST", "/projects/actions-route/actions/consume", "owner", { kind: "deploy", commit: H2 })).status).toBe(409);
  expect((await api("POST", "/projects/actions-route/actions/consume", "owner", { kind: "deploy", commit: H1 })).status).toBe(200);
  const ran = await api("POST", "/projects/actions-route/actions/runs", "owner", { step: "deploy", kind: "deploy", approval: "a1", command: "x", commit: H1, exitStatus: 1, durationMs: 5, passed: false, outputTail: "boom", ship: "s-2" });
  expect(ran.status).toBe(201);
  expect((await api("POST", "/projects/actions-route/actions/runs", "owner", { step: "deploy", commit: H1 })).status).toBe(400);
  expect((await api("POST", "/projects/actions-route/actions/a1/withdraw", "owner", {})).status).toBe(409);
  const after = await (await api("GET", "/projects/actions-route/actions", "owner")).json() as { runs: { passed: boolean; outputTail: string }[] };
  expect(after.runs).toMatchObject([{ passed: false, outputTail: "boom" }]);
});

it("the project page approves at the head it read, lists approvals and withdraws, from its own origin only", async () => {
  const L = await project("actions-page");
  const cookie = await signIn(TOKEN, testEnv);
  const page = async () => (await worker.fetch(new Request("https://atelier.test/p/actions-page", { headers: { cookie } }), testEnv)).text();
  const before = await page();
  expect(before).toContain('id="actions"');
  expect(before).toContain('action="/ui/actions-page/actions/approve"');
  expect(before).toContain(`<input type="hidden" name="head" value="${H2}">`);
  expect(before).toContain("No action has been approved yet.");
  const post = (verb: string, form: Record<string, string>, origin = "https://atelier.test") => worker.fetch(new Request(`https://atelier.test/ui/actions-page/actions/${verb}`, {
    method: "POST", headers: { cookie, origin }, body: new URLSearchParams(form), redirect: "manual",
  }), testEnv);
  expect((await post("approve", { kind: "deploy", head: H2, expires: "24h" }, "https://evil.test")).status).toBe(403);
  expect(await L.actionApprovals()).toEqual([]);
  const approved = await post("approve", { kind: "deploy", head: H2, expires: "24h", note: "from the page" });
  expect(approved.status).toBe(303);
  expect(approved.headers.get("location")).toBe("https://atelier.test/p/actions-page#actions");
  const refused = await post("approve", { kind: "deploy", head: FORK, expires: "24h" });
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain("is not on the project&#39;s main line");
  const listed = await page();
  expect(listed).toContain("from the page");
  expect(listed).toContain('<input type="hidden" name="id" value="a1">');
  expect((await post("withdraw", { id: "a1" })).status).toBe(303);
  expect((await L.actionApprovals())[0]).toMatchObject({ id: "a1", status: "withdrawn" });
  expect(await page()).not.toContain('<input type="hidden" name="id" value="a1">');
  expect((await post("frobnicate", {})).status).toBe(400);
});

it("the project page still draws, without the form, when the main line cannot be read", async () => {
  await project("actions-dark");
  const dark = { ...testEnv, ARTIFACTS: { async get() { throw new Error("unreachable"); } } } as unknown as typeof env;
  const cookie = await signIn(TOKEN, dark);
  const res = await worker.fetch(new Request("https://atelier.test/p/actions-dark", { headers: { cookie } }), dark);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("The main line's head could not be read");
  expect(html).not.toContain('action="/ui/actions-dark/actions/approve"');
});
