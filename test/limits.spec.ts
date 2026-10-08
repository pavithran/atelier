import { env } from "cloudflare:workers";
import { NO_CRITERIA } from "../src/criteria.ts";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";

// Task t138 (audit t105, gate and data loss, finding F7): what an agent token
// writes into the Ledger had no size limit, or was cut short without a word,
// so one token could grow the Ledger without bound and every task read and
// inbox would carry the bytes. Each kind of text now has a stated limit, and
// text over it is refused whole, with the limit named, before anything is
// written or any token revoked.

const TOKEN = "limits-test-token";
const A = "claude-code/opus-5.5", B = "codex/gpt-6-astra";
const H0 = "0".repeat(40), H1 = "a".repeat(40);

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return ledger(name);
}

// Artifacts holding one fork at H1, whose parent is H0, and noting each token it is asked to revoke.
function artifacts(revoked: string[]) {
  return {
    get: async () => ({
      log: async () => [{ hash: H1, parents: [H0] }],
      revokeToken: async (id: string) => { revoked.push(id); return true; },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
}

function caller(name: string, ARTIFACTS?: Artifacts) {
  const bindings = { ...env, ATELIER_TOKEN: TOKEN, ...(ARTIFACTS ? { ARTIFACTS } : {}) } as typeof env;
  return (bearer: string, actor: string | null) => (method: string, path: string, body?: unknown) =>
    worker.fetch(new Request(`https://atelier.test/api/projects/${name}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), bindings);
}

async function issue(name: string, actor: string): Promise<string> {
  const res = await worker.fetch(new Request("https://atelier.test/api/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: JSON.stringify({ actor, projects: [name] }),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  return ((await res.json()) as { token: string }).token;
}

async function refused(res: Response, detail: RegExp) {
  expect(res.status, await res.clone().text()).toBe(400);
  const body = await res.json() as { error: string; detail: string };
  expect(body.error).toBe("too_long");
  expect(body.detail).toMatch(detail);
}

it("a review, handoff, release or abandonment note over 2000 characters is refused whole, and nothing is recorded or revoked", async () => {
  const name = "limits-notes";
  const L = await project(name);
  await L.newItem("Noted at length", [], "owner");
  const { generation } = await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  await L.recordPush("t1", A, H1, H1);
  expect(await L.recordToken("t1", A, generation, null, "write-token-1")).toBe(true);
  const revoked: string[] = [];
  const as = caller(name, artifacts(revoked));
  const holder = as(await issue(name, A), null), reviewer = as(await issue(name, B), null), owner = as(TOKEN, "owner");
  const long = "x".repeat(2001);

  await refused(await reviewer("POST", "/items/t1/review", { head: H1, criteria: NO_CRITERIA, approve: false, note: long }), /the review note is 2001 characters; the limit is 2000\. Shorten it and send it again/);
  expect(await L.reviewsFor("t1")).toEqual([]);
  await refused(await holder("POST", "/items/t1/handoff", { to: "opencode/glm-5.3", note: long }), /the handoff note is 2001 characters; the limit is 2000/);
  await refused(await holder("POST", "/items/t1/handoff", { to: `opencode/${"g".repeat(300)}`, note: "Over to you" }), /the name of the agent it is handed to is 309 characters; the limit is 200/);
  await refused(await holder("POST", "/items/t1/release", { note: long }), /the release note is 2001 characters; the limit is 2000/);
  await refused(await owner("POST", "/items/t1/abandon", { note: long }), /the abandonment note is 2001 characters; the limit is 2000/);
  // Each refusal came before the holder's write token was revoked, and the task is as it was.
  expect(revoked).toEqual([]);
  expect(await L.item("t1")).toMatchObject({ state: "claimed", owner: A });
  const events = (await L.events("t1")) as unknown as LedgerEvent[];
  expect(events.filter((e) => /^review\.|^item\.(handoff|released|abandoned)$/.test(e.kind))).toEqual([]);

  // At the limit, a note is kept whole.
  const exact = "y".repeat(2000);
  expect((await reviewer("POST", "/items/t1/review", { head: H1, criteria: NO_CRITERIA, approve: false, note: exact })).status).toBe(200);
  expect((await L.reviewsFor("t1"))[0].note).toBe(exact);
  expect((await holder("POST", "/items/t1/release", { note: exact })).status).toBe(200);
  expect(revoked).toEqual(["write-token-1"]);
  const released = ((await L.events("t1")) as unknown as LedgerEvent[]).find((e) => e.kind === "item.released");
  expect(released?.data.note).toBe(exact);
});

it("a report or a check's command over 500 characters, or a check's output over 4000, is refused rather than cut", async () => {
  const name = "limits-evidence";
  const L = await project(name);
  await L.newItem("Checked at length", [], "owner");
  await L.claim("t1", A);
  await L.recordPush("t1", A, H1, H1);
  const agent = caller(name)(await issue(name, A), null);

  await refused(await agent("POST", "/items/t1/evidence", { kind: "check", claim: "c".repeat(501), head: H1, passed: true }), /the check's command is 501 characters; the limit is 500/);
  await refused(await agent("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", head: H1, passed: true, outputTail: "o".repeat(4001) }), /the check's output is 4001 characters; the limit is 4000/);
  await refused(await agent("POST", "/items/t1/evidence", { kind: "report", claim: "r".repeat(501), head: H1 }), /the report is 501 characters; the limit is 500/);
  expect(await L.evidenceFor("t1")).toEqual([]);

  // At their limits, both are stored as sent.
  expect((await agent("POST", "/items/t1/evidence", { kind: "report", claim: "r".repeat(500), head: H1 })).status).toBe(200);
  expect((await agent("POST", "/items/t1/evidence", { kind: "check", claim: "npm test", head: H1, passed: true, outputTail: "o".repeat(4000) })).status).toBe(200);
  const rows = await L.evidenceFor("t1");
  expect(rows.map((e) => [e.grade, e.claim.length, e.outputTail?.length ?? null])).toEqual([["reported", 500, null], ["observed", 8, 4000]]);
});

it("a summary over 600 characters is refused, and a push names its head as a commit hash or not at all", async () => {
  const name = "limits-submit";
  const L = await project(name);
  await L.newItem("Summed up", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  const agent = caller(name, artifacts([]))(await issue(name, A), null);

  // The head a push reports is stored beside the one Atelier reads when they differ, so only a hash is taken.
  for (const head of ["x".repeat(100_000), "HEAD", 7, { sha: H1 }]) {
    const res = await agent("POST", "/items/t1/push", { head });
    expect(res.status, JSON.stringify(head).slice(0, 40)).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_head" });
  }
  expect(((await L.events("t1")) as unknown as LedgerEvent[]).some((e) => e.kind === "push.observed")).toBe(false);
  expect((await agent("POST", "/items/t1/push", { head: H1 })).status).toBe(200);
  expect((await L.item("t1")).head).toBe(H1);

  await refused(await agent("POST", "/items/t1/submit", { summary: "s".repeat(601) }), /the summary is 601 characters; the limit is 600/);
  expect((await L.item("t1")).state).toBe("claimed");
  expect((await agent("POST", "/items/t1/submit", { summary: "s".repeat(600) })).status).toBe(200);
  const submitted = ((await L.events("t1")) as unknown as LedgerEvent[]).find((e) => e.kind === "item.submitted");
  expect(submitted?.data.summary).toBe("s".repeat(600));
});
