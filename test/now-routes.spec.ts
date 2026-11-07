import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { NO_CRITERIA } from "../src/criteria.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import type { Evidence, Review } from "../src/rules.ts";
import { signIn } from "./signin.ts";

// The Now route, page and Revert link (t525) on a real server and real
// ledgers. Trust checks, per endpoint:
//   GET  /api/now             the developer's token acting as the developer; an agent token or a
//                             runner token has no route to it (403), no token is 401, the owner
//                             token named as another actor is refused (not_project_owner).
//   GET  /now                 a signed-in session (or Access); anyone else is sent to sign in.
//   GET  /p/NAME/tN/revert    the same session; changes nothing.
//   POST /ui/NAME/tN/revert   the same session, from this origin; a task that is not merged is refused.
// No endpoint takes a disclosure level from the request: the one reader sees every project.

const TOKEN = "now-routes-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const OWNER = { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" };
const OPUS = "claude-code/opus-5.5", ASTRA = "codex/gpt-6-astra";
const H0 = "0".repeat(40), H1 = "a".repeat(40), H2 = "b".repeat(40);
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const get = (path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://atelier.test${path}`, { headers, redirect: "manual" }), testEnv);

async function project(name: string) {
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return ledger(name);
}
const evidence = (id: string, head: string): Evidence => ({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
const review = (id: string, by: string, head: string, approve: boolean): Review => ({ itemId: id, by, head, criteria: NO_CRITERIA, approve, note: "", at: new Date().toISOString() });

// t1 merged just now, t2 filed, t3 claimed by a builder.
async function seed(name: string) {
  const L = await project(name);
  await L.newItem("Merged today", ["src/**"], "owner");
  await L.claim("t1", OPUS);
  await L.setWorkspace("t1", `${name}--t1`, H0, OPUS);
  await L.recordPush("t1", OPUS, H1, H1);
  await L.addEvidence(evidence("t1", H1));
  await L.submit("t1", OPUS);
  await L.addReview(review("t1", ASTRA, H1, true), undefined, true);
  await L.accept("t1", "owner");
  await L.merged("t1", "owner", H2, true);
  await L.newItem("Still filed", ["docs/**"], "owner");
  await L.newItem("Being built", ["lib/**"], "owner");
  await L.claim("t3", OPUS);
  return L;
}

async function token(body: Record<string, unknown>) {
  const res = await worker.fetch(new Request("https://atelier.test/api/tokens", {
    method: "POST", headers: { ...OWNER, "x-atelier-acting": OPUS, "content-type": "application/json" }, body: JSON.stringify(body),
  }), testEnv);
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

it("the owner reads every live task once and today's merge, with its reviewer and a Revert link", async () => {
  await seed("now-owner");
  const res = await get("/api/now", OWNER);
  expect(res.status).toBe(200);
  const view = (await res.json()) as { header: Record<string, unknown>; groups: { key: string; rows: { id: string; project: string; stage: string; waitingOn: string; reviewer?: string; revertHref?: string | null }[] }[]; unread: string[] };
  const mine = (key: string) => view.groups.find((g) => g.key === key)!.rows.filter((r) => r.project === "now-owner");
  expect(mine("landed").map((r) => [r.id, r.reviewer, r.revertHref])).toEqual([["t1", ASTRA, "/p/now-owner/t1/revert"]]);
  const live = view.groups.filter((g) => g.key !== "landed").flatMap((g) => g.rows).filter((r) => r.project === "now-owner");
  expect(live.map((r) => r.id).sort()).toEqual(["t2", "t3"]);
  expect(live.find((r) => r.id === "t2")).toMatchObject({ stage: "filed", waitingOn: "a session to review its criteria" });
  expect(live.find((r) => r.id === "t3")).toMatchObject({ stage: "building" });
  expect(view.unread).toEqual([]);
  expect(view.header.mergesToday).toBeGreaterThanOrEqual(1);
});

it("refuses every other caller: no token, an agent token, a runner token, another actor", async () => {
  await seed("now-refused");
  expect((await get("/api/now")).status).toBe(401);
  const agent = await token({ actor: ASTRA, projects: ["now-refused"] });
  expect((await get("/api/now", { authorization: `Bearer ${agent}`, "x-atelier-actor": ASTRA })).status).toBe(403);
  const runner = await token({ runner: "home:build", projects: ["now-refused"] });
  expect((await get("/api/now", { authorization: `Bearer ${runner}` })).status).toBe(403);
  const other = await get("/api/now", { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": ASTRA });
  expect(other.status).toBe(403);
  expect(((await other.json()) as { error: string }).error).toBe("not_project_owner");
});

// Caller by output path: what each may read of the Now view. Only the signed-in developer reads any of it.
it("visibility by caller and output path: JSON, the page, the Revert confirmation and its form", async () => {
  await seed("now-table");
  const cookie = await signIn(TOKEN, testEnv);
  const agent = await token({ actor: ASTRA, projects: ["now-table"] });
  const anyAgent = { authorization: `Bearer ${agent}`, "x-atelier-actor": ASTRA };
  const rows: [string, string, Record<string, string>, number][] = [
    // [caller, path, headers, status]
    ["developer session", "/now", { cookie }, 200],
    ["developer session", "/p/now-table/t1/revert", { cookie }, 200],
    ["no session", "/now", {}, 303],
    ["no session", "/p/now-table/t1/revert", {}, 303],
    ["agent token", "/now", anyAgent, 403],
    ["agent token", "/p/now-table/t1/revert", anyAgent, 403],
  ];
  for (const [caller, path, headers, status] of rows) {
    const res = await get(path, headers);
    expect(res.status, `${caller} ${path}`).toBe(status);
    if (status !== 200) expect(await res.text(), `${caller} ${path}`).not.toContain("Merged today");
  }
  // The session's page carries the title; the redirect and the refusal carry none of it.
  expect(await (await get("/now", { cookie })).text()).toContain("Merged today");
});

it("the page links Now in the bar, follows the device's scheme, and lists each task with its Revert link", async () => {
  await seed("now-page");
  const cookie = await signIn(TOKEN, testEnv);
  const res = await get("/now", { cookie });
  const html = await res.text();
  expect(html).toContain('<a href="/now" aria-current="page">Now</a>');
  const tag = (page: string) => /<html[^>]*>/.exec(page)![0];
  expect(tag(html)).not.toContain("data-scheme");
  expect(html).toContain('<meta name="color-scheme" content="dark light">');
  expect(html).toContain("@media (prefers-color-scheme: light)");
  expect(html).toContain('href="/p/now-page/t1/revert"');
  expect(html).toContain("Still filed");
  // Another page keeps the bar's link to Now and stays in Night, as it was.
  const decisions = await (await get("/decisions", { cookie })).text();
  expect(decisions).toContain('<a href="/now">Now</a>');
  expect(tag(decisions)).toContain('data-scheme="night"');
});

it("opening the Revert link changes nothing; its form makes one revert task that records the merge commit", async () => {
  const L = await seed("now-revert");
  const cookie = await signIn(TOKEN, testEnv);
  const page = await (await get("/p/now-revert/t1/revert", { cookie })).text();
  expect(page).toContain('action="/ui/now-revert/t1/revert"');
  expect((await L.items()).length).toBe(3);
  const post = (headers: Record<string, string>) => worker.fetch(new Request("https://atelier.test/ui/now-revert/t1/revert", { method: "POST", headers, body: new URLSearchParams({}), redirect: "manual" }), testEnv);
  // From another origin, and with no session, nothing is made.
  expect((await post({ cookie, origin: "https://elsewhere.test" })).status).toBe(403);
  expect((await post({ origin: "https://atelier.test" })).status).toBe(303);
  expect((await L.items()).length).toBe(3);
  const made = await post({ cookie, origin: "https://atelier.test" });
  expect(made.status).toBe(303);
  expect(made.headers.get("location")).toBe("https://atelier.test/p/now-revert/t4");
  expect(await L.events("t4")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "item.reverts", data: { itemId: "t1", mergeCommit: H2 } })]));
  expect(((await L.events("t1")) as unknown as LedgerEvent[]).map((e) => e.kind)).toContain("item.revert_requested");
  // The revert is asked for, not yet merged: the Now page says so, offers no second link and does not call it reverted.
  const now = await (await get("/now", { cookie })).text();
  expect(now).not.toContain('href="/p/now-revert/t1/revert"');
  expect(now).toContain("Revert asked for in t4");
  expect(now).not.toContain(">Reverted<");
});

it("a task that is not merged has nothing to revert: the page says so and the form is refused", async () => {
  const L = await seed("now-notmerged");
  const cookie = await signIn(TOKEN, testEnv);
  const page = await (await get("/p/now-notmerged/t2/revert", { cookie })).text();
  expect(page).toContain("not merged");
  expect(page).not.toContain('action="/ui/now-notmerged/t2/revert"');
  const res = await worker.fetch(new Request("https://atelier.test/ui/now-notmerged/t2/revert", { method: "POST", headers: { cookie, origin: "https://atelier.test" }, body: new URLSearchParams({}), redirect: "manual" }), testEnv);
  expect(res.status).toBe(409);
  expect((await L.items()).length).toBe(3);
});
