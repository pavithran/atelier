import { env } from "./support/workers.ts";
import { runInDurableObject } from "./support/workers.ts";
import { afterAll, beforeAll, expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { Ledger } from "../src/ledger.ts";
import { seed, type Seeded } from "./fixtures/design/seed.ts";
import { ORIGIN, TOKEN, designEnv, serveKeys, session, assertion } from "./fixtures/design/pages.ts";

// t594: the Land form on Today's cards and the task page's verdict block, and
// POST /ui/P/tN/land, entered at worker.fetch on the design fixture
// (test/fixtures/design/seed.ts). Trust checks, per endpoint:
//   POST /ui/P/tN/land   who may call: the owner, in a session on a server with Cloudflare
//                        Access (ownerPageAct, src/page-actions.ts). Access's assertion is
//                        checked first (401 without); the owner bearer token alone is 403; an
//                        assertion with no session and no token goes to /login (303); an
//                        agent token is 403; a foreign or absent Origin is 403.
//                        Membership and edit right: the owner of every project, as every
//                        owner form; no caller names a project's disclosure level.
//                        What the page may draw (the Land form) comes from the same guard.
//   GET / and GET /p/P/tN   draw the Land form only for that guard's answer: a session behind
//                        Access. The shown head, criteria and request id are the page's.
// Visibility by output path, the table below (see "draws Land only ..."): session behind
// Access sees the form on Today and on the task page; the same pages without Access, or
// signed in with the token alone, draw the facts (Queued to land, Landing queued since) and
// no form. Search snippets, exports and generated pages do not carry the form: the
// pages the form is drawn on are these two.

let seeded: Seeded;
let pages: Env;
let cookie: string;
const NAME = "ledger-core";
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  seeded = await seed(env);
  pages = designEnv(env, seeded);
  serveKeys();
  cookie = await session(pages);
}, { timeout: 600_000 });
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ready = (project = NAME) => seeded.byShape[project].ready;
type Ev = { kind: string; data: Record<string, unknown> };
const events = async (project: string, id: string, kind: string) => ((await ledger(project).events(id)) as unknown as Ev[]).filter((e) => e.kind === kind);
const bound = async (project: string, id: string) => ({ head: (await ledger(project).item(id)).head as string, criteria: await ledger(project).criteria(id) as string });

interface Who { assertion?: boolean; cookie?: boolean; bearer?: string; origin?: string | null }
async function press(project: string, id: string, fields: Record<string, string>, who: Who = {}, bindings: Env = pages) {
  const headers: Record<string, string> = {};
  if (who.origin !== null) headers.origin = who.origin ?? ORIGIN;
  if (who.assertion !== false) headers["cf-access-jwt-assertion"] = await assertion();
  if (who.cookie !== false) headers.cookie = cookie;
  if (who.bearer) headers.authorization = `Bearer ${who.bearer}`;
  return worker.fetch(new Request(`${ORIGIN}/ui/${project}/${id}/land`, { method: "POST", headers, body: new URLSearchParams(fields), redirect: "manual" }), bindings);
}
const land = async (project: string, id: string, extra: Record<string, string> = {}, who: Who = {}) =>
  press(project, id, { ...(await bound(project, id)), request: crypto.randomUUID(), ...extra }, who);
const get = async (path: string, who: Who = {}, bindings: Env = pages) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { ...(who.assertion === false ? {} : { "cf-access-jwt-assertion": await assertion() }), ...(who.cookie === false ? {} : { cookie }), ...(who.bearer ? { authorization: `Bearer ${who.bearer}` } : {}) }, redirect: "manual" }), bindings);
const landForm = (project: string, id: string) => `action="/ui/${project}/${id}/land"`;
const card = (html: string, project: string, id: string) => {
  const from = html.indexOf(`${project} · ${id}</span>`);
  if (from < 0) throw new Error(`no card for ${project}/${id}`);
  return html.slice(html.lastIndexOf('<div class="today-ask">', from), html.indexOf('<div class="today-ask">', from) < 0 ? html.indexOf("</section>", from) : html.indexOf('<div class="today-ask">', from));
};
const eastern = (at: string) => { const ps = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at)); return `${ps.find((p) => p.type === "hour")!.value}:${ps.find((p) => p.type === "minute")!.value}`; };

// Criteria 1 and 2.
it("the owner with Access and a session presses Land: 303, one land.requested holding the head; a second press with a new id records nothing and both pages say it waits", async () => {
  const id = ready()[1];
  const { head } = await bound(NAME, id);
  const res = await land(NAME, id);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`${ORIGIN}/p/${NAME}/${id}`);
  const first = await events(NAME, id, "land.requested");
  expect(first).toHaveLength(1);
  expect(first[0].data.head).toBe(head);
  expect((await land(NAME, id)).status).toBe(303);
  expect(await events(NAME, id, "land.requested")).toHaveLength(1);
  const job = (await ledger(NAME).detail(id) as unknown as { landJob: { at: string; head: string } }).landJob;
  expect(job.head).toBe(head);
  const task = await (await get(`/p/${NAME}/${id}`)).text();
  expect(task).toContain(`Landing queued since ${eastern(job.at)}`);
  expect(task).not.toContain(landForm(NAME, id));
  const today = card(await (await get("/")).text(), NAME, id);
  expect(today).toContain("Queued to land");
  expect(today).not.toContain(landForm(NAME, id));
});

// Criterion 3: one test each.
it("Land without an Access assertion answers 401 and records nothing", async () => {
  const id = ready()[3];
  const res = await land(NAME, id, {}, { assertion: false });
  expect(res.status).toBe(401);
  expect(await events(NAME, id, "land.requested")).toEqual([]);
});
it("Land with Access and the owner bearer token but no session answers 403 and records nothing", async () => {
  const id = ready()[3];
  const res = await land(NAME, id, {}, { cookie: false, bearer: TOKEN });
  expect(res.status).toBe(403);
  expect(await events(NAME, id, "land.requested")).toEqual([]);
});
it("Land with Access, no session and no token goes to /login and records nothing", async () => {
  const id = ready()[3];
  const res = await land(NAME, id, {}, { cookie: false });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toMatch(/\/login$/);
  expect(await events(NAME, id, "land.requested")).toEqual([]);
});
it("Land with an agent token answers 403 and records nothing", async () => {
  const id = ready()[3];
  const minted = await worker.fetch(new Request(`${ORIGIN}/api/tokens`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" }, body: JSON.stringify({ actor: "codex/gpt-6-astra", projects: [NAME] }) }), pages);
  const { token } = await minted.json() as { token: string };
  const res = await land(NAME, id, {}, { cookie: false, bearer: token });
  expect(res.status).toBe(403);
  expect(await events(NAME, id, "land.requested")).toEqual([]);
});

// Criterion 4.
it("a foreign Origin, or none, answers 403 and records nothing", async () => {
  const id = ready()[3];
  expect((await land(NAME, id, {}, { origin: "https://evil.example" })).status).toBe(403);
  expect((await land(NAME, id, {}, { origin: null })).status).toBe(403);
  expect(await events(NAME, id, "land.requested")).toEqual([]);
});
it("the session cookie is SameSite=Strict", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/login`, { method: "POST", headers: { origin: ORIGIN, "cf-access-jwt-assertion": await assertion() }, body: new URLSearchParams({ token: TOKEN }) }), pages);
  expect(res.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
});
it("without Access neither Today nor the task page draws Land, and POST land answers 403", async () => {
  const id = ready()[3];
  const { CF_ACCESS_ISS: _i, CF_ACCESS_AUD: _a, CF_ACCESS_OWNER_EMAIL: _e, ...rest } = pages as unknown as Record<string, unknown>;
  const open = rest as unknown as Env;
  const login = await worker.fetch(new Request(`${ORIGIN}/login`, { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams({ token: TOKEN }) }), open);
  const plain = /^(atelier=[a-f0-9]{64})/.exec(login.headers.get("set-cookie") ?? "")![1];
  const read = async (path: string) => (await worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie: plain } }), open)).text();
  expect(await read("/")).toContain(`${NAME} · ${id}`);
  expect(await read("/")).not.toContain("/land\"");
  expect(await read(`/p/${NAME}/${id}`)).not.toContain(landForm(NAME, id));
  const forms = { ...(await bound(NAME, id)), request: crypto.randomUUID() };
  const res = await worker.fetch(new Request(`${ORIGIN}/ui/${NAME}/${id}/land`, { method: "POST", headers: { origin: ORIGIN, cookie: plain }, body: new URLSearchParams(forms) }), open);
  expect(res.status).toBe(403);
  expect(await events(NAME, id, "land.requested")).toEqual([]);
});

// Criterion 5.
it("a page whose head is not the task's answers 409 and one whose criteria changed 409, each drawn beside the Land form, with no event", async () => {
  const id = ready()[3];
  const stale = await land(NAME, id, { head: "e".repeat(40) });
  expect(stale.status).toBe(409);
  const body = await stale.text();
  expect(body).toContain('id="error-land"');
  expect(body).toContain("changed since");
  expect(body).toContain(landForm(NAME, id));
  const criteria = await land(NAME, id, { criteria: "0".repeat(64) });
  expect(criteria.status).toBe(409);
  const text = await criteria.text();
  expect(text).toContain('id="error-land"');
  expect(text).toContain("acceptance criteria changed");
  expect(await events(NAME, id, "land.requested")).toEqual([]);
});

// Criterion 7, through the route.
it("a missing or malformed request id answers 400; one used for another task 409; a replay answers the first 303 and records nothing, even after the landing failed", async () => {
  const [project] = Object.keys(seeded.byShape).filter((p) => p !== NAME);
  const [a, b] = ready(project);
  for (const request of ["", "nope"]) {
    const res = await press(project, a, { ...(await bound(project, a)), request });
    expect([request, res.status]).toEqual([request, 400]);
  }
  expect((await press(project, a, await bound(project, a))).status).toBe(400);
  expect(await events(project, a, "land.requested")).toEqual([]);
  const request = crypto.randomUUID();
  const first = await press(project, a, { ...(await bound(project, a)), request });
  expect(first.status).toBe(303);
  const other = await press(project, b, { ...(await bound(project, b)), request });
  expect(other.status).toBe(409);
  expect(await events(project, b, "land.requested")).toEqual([]);
  // The landing fails at this head; the response was lost and the press is sent again.
  await ledger(project).landEvent(a, "owner", "start", 1, { head: (await bound(project, a)).head, attempt: 1 });
  await ledger(project).landEvent(a, "owner", "regenerate", 5, { failed: true, tail: "generator exited 1", attempt: 1 });
  const replay = await press(project, a, { ...(await bound(project, a)), request });
  expect(replay.status).toBe(303);
  expect(replay.headers.get("location")).toBe(first.headers.get("location"));
  expect(await events(project, a, "land.requested")).toHaveLength(1);
  // Criterion 10: the page names the failed step, and a new id requeues it.
  const page = await (await get(`/p/${project}/${a}`)).text();
  expect(page).toContain("failed at its regenerate step");
  expect(page).toContain(landForm(project, a));
  // The head did not move, so the page does not say it did (finding 3).
  expect(page).not.toContain("The head moved");
  expect(page).not.toContain("was dropped");
  expect((await land(project, a)).status).toBe(303);
  const asked = await events(project, a, "land.requested");
  expect(asked).toHaveLength(2);
  expect(asked.some((e) => e.data.requeued === true && e.data.failedStep === "regenerate")).toBe(true);
});

// Criterion 9, through the pages.
it("a job queued at H whose task moves to H2 is dropped when a runner polls; the task page says the head moved and draws Land again", async () => {
  const name = Object.keys(seeded.byShape).filter((p) => p !== NAME)[1];
  const id = ready(name)[0];
  const before = await bound(name, id);
  expect((await land(name, id)).status).toBe(303);
  // The builder pushes a new revision, which then passes its checks and is reviewed again: ready at a new head.
  const moved = "c".repeat(40);
  const holder = (await ledger(name).item(id)).owner as string;
  await ledger(name).recordPush(id, holder, moved, moved);
  for (const claim of (await ledger(name).project()).policy.checks ?? []) await ledger(name).addEvidence({ itemId: id, claim, grade: "observed", head: moved, passed: true, by: holder, at: new Date().toISOString(), changedPaths: [], where: "runner" } as never);
  await ledger(name).submit(id, holder, "Pushed again.");
  await ledger(name).addReview({ itemId: id, head: moved, criteria: before.criteria, by: "codex/gpt-6-astra", approve: true, note: "Reviewed", at: new Date().toISOString() }, undefined, true);
  const offer = { runner: "home:studio", kind: "home", agents: [], jobs: ["land"], checkouts: [name] };
  expect((await ledger(name).landJobs(offer as never, [name])).map((j) => j.id)).not.toContain(id);
  const stopped = await events(name, id, "land.stopped");
  expect(stopped.map((e) => e.data)).toEqual([expect.objectContaining({ reason: "stale_head", shown: before.head, current: "c".repeat(40) })]);
  // The task page says the head moved, and draws Land again at the new head (finding 6).
  const page = await (await get(`/p/${name}/${id}`)).text();
  expect(page).toContain(`The head moved from ${before.head.slice(0, 8)} to cccccccc`);
  expect(page).not.toContain("Landing queued since");
  expect(page).toContain(landForm(name, id));
  expect(page).toContain(`name="head" value="${"c".repeat(40)}"`);
});

// Criterion 11: the table of owner calls and whether the Land form is drawn.
it("the Land form is drawn only for the owner calls land and accept: ready and ready-to-accept tasks yes; accepted, blocked and protected tasks no; success from Today returns to /", async () => {
  const [project] = Object.keys(seeded.byShape).filter((p) => p !== NAME);
  const todayHtml = await (await get("/")).text();
  const rows: [string, string, string, boolean][] = [
    ["ready (call land)", NAME, ready()[2], true],
    ["accepted", NAME, seeded.byShape[NAME].accepted[0], false],
    ["blocked", NAME, seeded.byShape[NAME].blocked[0], false],
    ["protected", NAME, seeded.byShape[NAME].protected[0], false],
  ];
  // A task whose gate is the developer's: its owner call is accept.
  const acceptId = ready(project)[1];
  await runInDurableObject(ledger(project), async (_i: Ledger, st: DurableObjectState) => st.storage.sql.exec(`UPDATE items SET next_gate = 'developer' WHERE id = ?`, acceptId));
  rows.push(["ready (call accept)", project, acceptId, true]);
  const todayAfter = await (await get("/")).text();
  void todayHtml;
  for (const [label, p, id, drawn] of rows) {
    const page = await (await get(`/p/${p}/${id}`)).text();
    expect([label, "task page", page.includes(landForm(p, id))]).toEqual([label, "task page", drawn]);
    const onToday = todayAfter.includes(`${p} · ${id}</span>`);
    if (drawn) expect([label, "today", onToday && card(todayAfter, p, id).includes(landForm(p, id))]).toEqual([label, "today", true]);
    else if (onToday) expect([label, "today", card(todayAfter, p, id).includes(landForm(p, id))]).toEqual([label, "today", false]);
  }
  const form = card(todayAfter, NAME, ready()[2]);
  expect(form).toMatch(/<form class="land-form"[^>]*data-once>/);
  expect(form).toContain('name="back" value="today"');
  expect(todayAfter).toMatch(/<script nonce="[^"]+">document\.addEventListener\("submit"/);
  const pressed = await land(NAME, ready()[2], { back: "today" });
  expect(pressed.status).toBe(303);
  expect(pressed.headers.get("location")).toBe(`${ORIGIN}/`);
  const viaTask = await land(project, acceptId, { back: "task" });
  expect(viaTask.headers.get("location")).toBe(`${ORIGIN}/p/${project}/${acceptId}`);
});

// Finding 1: the replay of a used id is looked up before the head and the criteria are checked.
it("a replay of a used id answers the first 303 even after the task's head and criteria changed", async () => {
  const id = ready()[3];
  const request = crypto.randomUUID();
  const shown = await bound(NAME, id);
  const first = await press(NAME, id, { ...shown, request });
  expect(first.status).toBe(303);
  const setHead = (head: string) => runInDurableObject(ledger(NAME), async (_i: Ledger, st: DurableObjectState) => st.storage.sql.exec(`UPDATE items SET head = ? WHERE id = ?`, head, id));
  await setHead("d".repeat(40));
  try {
    const replay = await press(NAME, id, { ...shown, request });
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toBe(first.headers.get("location"));
    const other = await press(NAME, id, { head: shown.head, criteria: "0".repeat(64), request });
    expect(other.status).toBe(303);
    expect(await events(NAME, id, "land.requested")).toHaveLength(1);
  } finally { await setHead(shown.head); }
});

// Finding 4: a refusal's page carries the nonce and the submit handler with its Land form.
it("the Land form drawn beside a refusal carries the page's nonce and the handler that disables the button", async () => {
  const id = ready()[3];
  await resetJobs(NAME);
  for (const fields of [{ head: "e".repeat(40) }, { criteria: "0".repeat(64) }, { request: "nope" }] as Record<string, string>[]) {
    const res = await land(NAME, id, fields);
    expect([Object.keys(fields)[0], res.status]).toEqual([Object.keys(fields)[0], Object.keys(fields)[0] === "request" ? 400 : 409]);
    const body = await res.text();
    expect(body).toContain(landForm(NAME, id));
    expect(body).toContain("data-once");
    const nonce = /<script nonce="([^"]+)">document\.addEventListener\("submit"/.exec(body)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
  }
});

// Finding 5: the POST-level evidence for atomic recording.
async function resetJobs(project: string) {
  await runInDurableObject(ledger(project), async (_i: Ledger, st: DurableObjectState) => { st.storage.sql.exec(`DELETE FROM land_jobs`); st.storage.sql.exec(`DELETE FROM page_requests`); });
}
it("a POST that timed out while its Ledger call ran: the retry with its id is the replay, and one land.requested stands", async () => {
  const id = ready()[3];
  await resetJobs(NAME);
  const before = (await events(NAME, id, "land.requested")).length;
  const shown = { ...(await bound(NAME, id)), request: crypto.randomUUID() };
  const slow = press(NAME, id, shown);
  await Promise.race([slow.then(() => "answered"), new Promise((r) => setTimeout(() => r("timed out"), 0))]);
  const retry = await press(NAME, id, shown);
  expect(retry.status).toBe(303);
  expect((await slow).status).toBe(303);
  expect(await events(NAME, id, "land.requested")).toHaveLength(before + 1);
});
it("a POST whose Ledger call failed before completing leaves no id, and the retry is a first request", async () => {
  const id = ready()[3];
  await resetJobs(NAME);
  const before = (await events(NAME, id, "land.requested")).length;
  const shown = { ...(await bound(NAME, id)), request: crypto.randomUUID() };
  await runInDurableObject(ledger(NAME), async (instance: Ledger) => {
    const live = instance as unknown as { log: (...a: unknown[]) => number };
    const real = live.log;
    live.log = (...a: unknown[]) => { if (a[2] === "land.requested") { live.log = real; throw new Error("crash"); } return real.apply(instance, a); };
  });
  expect((await press(NAME, id, shown)).status).toBeGreaterThanOrEqual(500);
  expect(await events(NAME, id, "land.requested")).toHaveLength(before);
  expect((await runInDurableObject(ledger(NAME), async (_i: Ledger, st: DurableObjectState) => st.storage.sql.exec(`SELECT * FROM page_requests`).toArray())).length).toBe(0);
  const retry = await press(NAME, id, shown);
  expect(retry.status).toBe(303);
  expect(await events(NAME, id, "land.requested")).toHaveLength(before + 1);
});
it("concurrent POSTs of one id, and of two ids, at one head record one land.requested", async () => {
  const id = ready()[3];
  await resetJobs(NAME);
  let before = (await events(NAME, id, "land.requested")).length;
  const shown = await bound(NAME, id);
  const one = crypto.randomUUID();
  const same = await Promise.all([1, 2, 3].map(() => press(NAME, id, { ...shown, request: one })));
  expect(same.map((r) => r.status)).toEqual([303, 303, 303]);
  expect(await events(NAME, id, "land.requested")).toHaveLength(before + 1);
  await resetJobs(NAME);
  before = (await events(NAME, id, "land.requested")).length;
  const two = await Promise.all([crypto.randomUUID(), crypto.randomUUID()].map((request) => press(NAME, id, { ...shown, request })));
  expect(two.map((r) => r.status)).toEqual([303, 303]);
  expect(await events(NAME, id, "land.requested")).toHaveLength(before + 1);
});

// Finding 2: a retained job of a failed landing is not "queued" on Today.
it("Today does not call a retained failed job queued: it names the failed step and draws Land again", async () => {
  const name = Object.keys(seeded.byShape).filter((p) => p !== NAME)[1];
  const id = ready(name)[1];
  const shown = await bound(name, id);
  expect((await land(name, id)).status).toBe(303);
  expect(card(await (await get("/")).text(), name, id)).toContain("Queued to land");
  await ledger(name).landEvent(id, "owner", "start", 1, { head: shown.head, attempt: 1 });
  await ledger(name).landEvent(id, "owner", "regenerate", 5, { failed: true, tail: "generator exited 1", attempt: 1 });
  const failed = card(await (await get("/")).text(), name, id);
  expect(failed).not.toContain("Queued to land");
  expect(failed).toContain(landForm(name, id));
  expect(failed).toContain("failed at its regenerate step");
  expect(failed).not.toContain("The head moved");
  expect((await land(name, id)).status).toBe(303);
  expect(card(await (await get("/")).text(), name, id)).toContain("Queued to land");
});
