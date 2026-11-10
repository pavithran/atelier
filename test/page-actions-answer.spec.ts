import { env } from "./support/workers.ts";
import { afterAll, beforeAll, expect, it, vi } from "./support/vitest.ts";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sha256Hex } from "../src/criteria.ts";
import { DIRECTION_QUOTE_MAX, OVERRIDE_REASON_MAX } from "../src/rules.ts";
import { seed, type Seeded } from "./fixtures/design/seed.ts";
import { ORIGIN, TOKEN, designEnv, serveKeys, session, assertion } from "./fixtures/design/pages.ts";

// t596: Answer and Override pressed from Today and the task page, entered at
// worker.fetch on the design fixture (test/fixtures/design/seed.ts).
// Trust checks, per endpoint:
//   POST /ui/P/tN/answer    who may call: the owner, in a session on a server with Cloudflare
//                           Access (ownerPageAct, src/page-actions.ts); Access's assertion is
//                           checked first (401 without), the owner bearer token alone is 403, an
//                           assertion with no session goes to /login (303), a foreign or absent
//                           Origin is 403. Membership and edit right: the owner of every project.
//                           The factor and the email hash recorded come from the server's Access
//                           settings, never from a field the caller sent.
//   POST /ui/P/tN/override  its existing guards stay (a session, the Access factor, the Origin,
//                           the project's no-override rule); the form gains the one-use request id.
//   GET / and GET /p/P/tN   draw the Answer and Override forms only for the same guard's answer.
// Visibility by output path (Access session / the same pages without Access / the token alone):
//   Today card, task page verdict block, a refusal page: the forms and kept words are drawn for
//   the Access session only; the other two see the facts and the bare Unblock form, if any.
//   Search snippets, exports and generated pages draw no form; none of them carries one.

let seeded: Seeded;
let pages: Env;
let cookie: string;
const NAME = "ledger-core";
const EMAIL_HASH = sha256Hex("owner@example.com");
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const OWNER = "owner";

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  seeded = await seed(env);
  pages = designEnv(env, seeded);
  serveKeys();
  cookie = await session(pages);
}, { timeout: 600_000 });
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

type Ev = { kind: string; data: Record<string, unknown> };
const events = async (id: string, kind: string) => ((await ledger(NAME).events(id)) as unknown as Ev[]).filter((e) => e.kind === kind);
const bound = async (id: string) => ({ head: ((await ledger(NAME).item(id)).head ?? "") as string, criteria: await ledger(NAME).criteria(id) as string });

// A task the owner blocks for the test, from the fixture's open tasks (the first has the long title).
let nextOpen = 1;
async function blocked(reason = "Which login flow is current?"): Promise<string> {
  const id = seeded.byShape[NAME].open[nextOpen++];
  await ledger(NAME).block(id, OWNER, reason);
  return id;
}
async function factBlocked(): Promise<string> {
  const id = seeded.byShape[NAME].working[nextWorking++];
  const holder = (await ledger(NAME).item(id)).owner as string;
  await ledger(NAME).release(id, holder, "validation_blocked: timed out after 45 minutes, counted from its held test slot");
  return id;
}
let nextWorking = 0;

interface Who { assertion?: boolean; cookie?: boolean; bearer?: string; origin?: string | null }
async function post(project: string, id: string, verb: string, fields: Record<string, string>, who: Who = {}, bindings: Env = pages) {
  const headers: Record<string, string> = {};
  if (who.origin !== null) headers.origin = who.origin ?? ORIGIN;
  if (who.assertion !== false) headers["cf-access-jwt-assertion"] = await assertion();
  if (who.cookie !== false) headers.cookie = cookie;
  if (who.bearer) headers.authorization = `Bearer ${who.bearer}`;
  return worker.fetch(new Request(`${ORIGIN}/ui/${project}/${id}/${verb}`, { method: "POST", headers, body: new URLSearchParams(fields), redirect: "manual" }), bindings);
}
const get = async (path: string, who: Who = {}, bindings: Env = pages) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { ...(who.assertion === false ? {} : { "cf-access-jwt-assertion": await assertion() }), ...(who.cookie === false ? {} : { cookie }), ...(who.bearer ? { authorization: `Bearer ${who.bearer}` } : {}) }, redirect: "manual" }), bindings);
const answer = async (id: string, words = "Use the second login flow", extra: Record<string, string> = {}, who: Who = {}) =>
  post(NAME, id, "answer", { ...(await bound(id)), request: crypto.randomUUID(), note: words, back: "today", ...extra }, who);
const override = async (id: string, reason = "No other family qualifies", extra: Record<string, string> = {}, who: Who = {}) =>
  post(NAME, id, "override", { ...(await bound(id)), request: crypto.randomUUID(), note: reason, back: "today", ...extra }, who);
const card = (html: string, id: string) => {
  const from = html.indexOf(`${NAME} · ${id}</span>`);
  if (from < 0) throw new Error(`no card for ${NAME}/${id}`);
  return html.slice(html.lastIndexOf('<div class="today-ask">', from), html.indexOf('<div class="today-ask">', from) < 0 ? html.indexOf("</section>", from) : html.indexOf('<div class="today-ask">', from));
};
const answerForm = (id: string) => `action="/ui/${NAME}/${id}/answer"`;
const overrideForm = (id: string) => `action="/ui/${NAME}/${id}/override"`;
const withoutAccess = (): Env => { const { CF_ACCESS_ISS: _i, CF_ACCESS_AUD: _a, CF_ACCESS_OWNER_EMAIL: _e, ...rest } = pages as unknown as Record<string, unknown>; return rest as unknown as Env; };

// Criterion 1.
it("Answer on a blocked task: 303 back to Today, one item.unblocked { confirmed: 'page', quote, factor: 'access', emailHash } with no acting, and the task leaves blocked", async () => {
  const id = await blocked();
  const res = await answer(id, "  Use the\r\n second login flow ");
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
  const unblocked = await events(id, "item.unblocked");
  expect(unblocked).toHaveLength(1);
  expect(unblocked[0].data).toMatchObject({ confirmed: "page", quote: "Use the second login flow", factor: "access", emailHash: EMAIL_HASH });
  expect(unblocked[0].data).not.toHaveProperty("acting");
  expect((await ledger(NAME).item(id)).state).not.toBe("blocked");
  // From the task page the answer returns to the task.
  const other = await blocked();
  const res2 = await answer(other, "Go on", { back: "task" });
  expect(res2.headers.get("location")).toBe(`${ORIGIN}/p/${NAME}/${other}`);
});

// Criterion 2.
it("words that are blank, whitespace or over 2,000 characters answer 400, record nothing and keep the words; exactly 2,000 acts", async () => {
  const id = await blocked();
  for (const bad of ["", "   \r\n\t ", "x".repeat(DIRECTION_QUOTE_MAX + 1)]) {
    const res = await answer(id, bad);
    expect(res.status, bad.slice(0, 5)).toBe(400);
    const page = await res.text();
    expect(page).toContain('id="error-answer"');
    expect(page).toContain("Nothing was recorded from this attempt");
    if (bad.trim()) expect(page).toContain(bad);
  }
  expect(await events(id, "item.unblocked")).toEqual([]);
  expect((await ledger(NAME).item(id)).state).toBe("blocked");
  expect((await answer(id, "x".repeat(DIRECTION_QUOTE_MAX))).status).toBe(303);
  expect(await events(id, "item.unblocked")).toHaveLength(1);
});
it("an Override reason that is blank or 501 characters answers 400, records nothing and keeps the words", async () => {
  const id = seeded.byShape[NAME].protected[0];
  for (const bad of ["   ", "y".repeat(OVERRIDE_REASON_MAX + 1)]) {
    const res = await override(id, bad);
    expect(res.status, bad.slice(0, 3)).toBe(400);
    const page = await res.text();
    expect(page).toContain('id="error-override"');
    if (bad.trim()) expect(page).toContain(bad);
  }
  expect(await events(id, "review.overridden")).toEqual([]);
  expect(await events(id, "item.accepted")).toEqual([]);
});

// Criterion 3 and 8.
it("Override posts the existing verb with a reason of 1 to 500 characters kept as the note; a new id after it acted answers 409 beside its form; the first id replays", async () => {
  const id = seeded.byShape[NAME].protected[0];
  const fields = { ...(await bound(id)), request: crypto.randomUUID(), note: "y".repeat(OVERRIDE_REASON_MAX), back: "today" };
  const first = await post(NAME, id, "override", fields);
  expect(first.status).toBe(303);
  expect(first.headers.get("location")).toBe(`${ORIGIN}/`);
  const overridden = await events(id, "review.overridden");
  expect(overridden).toHaveLength(1);
  expect(overridden[0].data).toMatchObject({ reason: "y".repeat(OVERRIDE_REASON_MAX), confirmed: "page", factor: "access" });
  const second = await override(id);
  expect(second.status).toBe(409);
  expect(await second.text()).toContain('id="error-override"');
  expect((await post(NAME, id, "override", fields)).status).toBe(303);
  // A used id is no way round the guards: the owner bearer token alone, as a fresh id has, is 403.
  expect((await post(NAME, id, "override", fields, { cookie: false, bearer: TOKEN })).status).toBe(403);
  expect(await events(id, "review.overridden")).toHaveLength(1);
  expect(await events(id, "item.accepted")).toHaveLength(1);
});
it("a second Answer with a new id answers 409 beside its form and records nothing; a replay of the first id answers its first 303", async () => {
  const id = await blocked();
  const fields = { ...(await bound(id)), request: crypto.randomUUID(), note: "Go on", back: "today" };
  expect((await post(NAME, id, "answer", fields)).status).toBe(303);
  const second = await answer(id, "Again");
  expect(second.status).toBe(409);
  expect(await second.text()).toContain('id="error-answer"');
  // The first response is dropped: only the id is kept, and sent again.
  const replay = await post(NAME, id, "answer", fields);
  expect(replay.status).toBe(303);
  expect(replay.headers.get("location")).toBe(`${ORIGIN}/`);
  expect(await events(id, "item.unblocked")).toHaveLength(1);
  // An id carried by no form is refused before anything is read.
  const none = await post(NAME, id, "answer", { ...(await bound(id)), note: "x", back: "today" });
  expect(none.status).toBe(400);
});

// Criterion 5.
it("a refused Answer or Override answers with the task page, the refusal beside its form, the words kept, and no confirmation secret", async () => {
  const secret = "s3cret-confirmation-value";
  const withSecret = { ...pages, OVERRIDE_SECRET: secret } as unknown as Env;
  const id = await blocked();
  const stale = await post(NAME, id, "answer", { ...(await bound(id)), criteria: "1. Other criteria", request: crypto.randomUUID(), note: "Keep these words", back: "task" }, {}, withSecret);
  expect(stale.status).toBe(409);
  const page = await stale.text();
  expect(page).toContain("<title>");
  expect(page).toContain("acceptance criteria changed");
  expect(page).toContain('id="error-answer"');
  expect(page).toContain("Keep these words");
  expect(page).not.toContain(secret);
  expect(await events(id, "item.unblocked")).toEqual([]);
  // The form that is refused is the Answer's, and its refusal sits inside it.
  const form = page.slice(page.indexOf(answerForm(id)), page.indexOf("</form>", page.indexOf(answerForm(id))));
  expect(form).toContain('id="error-answer"');
  expect(form).toContain("Keep these words");
});

// Criterion 9.
it("two Answers at once, with one id or two, record one item.unblocked: the other is a replay or a 409", async () => {
  for (const same of [true, false]) {
    const id = await blocked();
    const a = crypto.randomUUID(), b = same ? a : crypto.randomUUID();
    const base = await bound(id);
    const [x, y] = await Promise.all([
      post(NAME, id, "answer", { ...base, request: a, note: "one", back: "today" }),
      post(NAME, id, "answer", { ...base, request: b, note: "two", back: "today" }),
    ]);
    expect(await events(id, "item.unblocked"), `same ${same}`).toHaveLength(1);
    expect([x.status, y.status].sort(), `same ${same}`).toEqual(same ? [303, 303] : [303, 409]);
  }
});

// Criterion 7.
it("Answer and Override from Today without Access answer 401; with the owner bearer token alone 403; from a foreign or absent Origin 403; with no session to /login: each records nothing", async () => {
  const idA = await blocked();
  const idO = seeded.byShape[NAME].protected[1];
  const rows: [string, Who, number][] = [
    ["no Access", { assertion: false }, 401],
    ["token alone", { cookie: false, bearer: TOKEN }, 403],
    ["foreign origin", { origin: "https://evil.example" }, 403],
    ["no origin", { origin: null }, 403],
    ["no session", { cookie: false }, 303],
  ];
  for (const [verb, send] of [["answer", (w: Who) => answer(idA, "x", {}, w)], ["override", (w: Who) => override(idO, "x", {}, w)]] as const) {
    for (const [name, who, status] of rows) {
      const res = await send(who);
      expect(res.status, `${verb} ${name}`).toBe(status);
      if (status === 303) expect(res.headers.get("location"), `${verb} ${name}`).toMatch(/\/login$/);
    }
  }
  expect(await events(idA, "item.unblocked")).toEqual([]);
  expect(await events(idO, "review.overridden")).toEqual([]);
});
it("without Access neither Today nor the task page draws an Answer or Override form, and POST answer answers 403", async () => {
  const id = await blocked();
  const open = withoutAccess();
  const login = await worker.fetch(new Request(`${ORIGIN}/login`, { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams({ token: TOKEN }) }), open);
  const plain = /^(atelier=[a-f0-9]{64})/.exec(login.headers.get("set-cookie") ?? "")![1];
  const read = async (path: string) => (await worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie: plain } }), open)).text();
  const today = await read("/");
  expect(today).toContain(`${NAME} · ${id}`);
  expect(today).not.toContain("/answer\"");
  expect(today).not.toContain(overrideForm(seeded.byShape[NAME].protected[1]));
  const task = await read(`/p/${NAME}/${id}`);
  expect(task).not.toContain(answerForm(id));
  expect(task).toContain(`action="/ui/${NAME}/${id}/unblock"`);
  const res = await worker.fetch(new Request(`${ORIGIN}/ui/${NAME}/${id}/answer`, { method: "POST", headers: { origin: ORIGIN, cookie: plain }, body: new URLSearchParams({ ...(await bound(id)), request: crypto.randomUUID(), note: "x" }), redirect: "manual" }), open);
  expect(res.status).toBe(403);
  expect(await events(id, "item.unblocked")).toEqual([]);
});

// Criterion 10, drawn for the owner with Access.
it("Today and the task page draw Answer for a call of unblock, not for a fact block, which keeps Unblock; Override only where it is allowed", async () => {
  const id = await blocked();
  const fact = await factBlocked();
  const protectedId = seeded.byShape[NAME].protected[1];
  const today = await (await get("/")).text();
  const mine = card(today, id);
  expect(mine).toContain(answerForm(id));
  expect(mine).toMatch(/<textarea name="note" required[^>]*maxlength="2000"/);
  for (const name of ["head", "criteria", "request", "back"]) expect(mine).toContain(`name="${name}"`);
  expect(mine).toContain("Send answer");
  expect(card(today, fact)).not.toContain("/answer\"");
  expect(card(today, protectedId)).toContain(overrideForm(protectedId));
  expect(card(today, protectedId)).toMatch(/<textarea name="note" required[^>]*maxlength="500"/);

  const task = await (await get(`/p/${NAME}/${id}`)).text();
  expect(task).toContain(answerForm(id));
  expect(task).not.toContain(`action="/ui/${NAME}/${id}/unblock"`);
  const factTask = await (await get(`/p/${NAME}/${fact}`)).text();
  expect(factTask).not.toContain(answerForm(fact));
  expect(factTask).toMatch(new RegExp(`action="/ui/${NAME}/${fact}/unblock"[^>]*>(?:(?!</form>)[\\s\\S])*<button class="outline"`));
  expect(factTask).not.toMatch(new RegExp(`action="/ui/${NAME}/${fact}/unblock"[^>]*>(?:(?!</form>)[\\s\\S])*<button class="primary"`));
  // The task page's override form gains the request id.
  const protectedTask = await (await get(`/p/${NAME}/${protectedId}`)).text();
  const form = protectedTask.slice(protectedTask.indexOf(overrideForm(protectedId)));
  expect(form.slice(0, form.indexOf("</form>"))).toMatch(/name="request" value="[0-9a-f-]{36}"/);
});
it("a project that forbids overrides draws no Override on Today; the protected task keeps its facts", async () => {
  const L = ledger(NAME);
  const project = await L.project();
  await L.setProject({ ...project, policy: { ...project.policy, noOverride: true } }, OWNER);
  try {
    const protectedId = seeded.byShape[NAME].protected[1];
    const today = await (await get("/")).text();
    expect(card(today, protectedId)).not.toContain("/override\"");
  } finally {
    await L.setProject(project, OWNER);
  }
});

// Criterion 11.
const css = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
it("Send answer fills with var(--signal-fill) and var(--on-signal-fill) on both pages; a fact block's Unblock is an outline button", () => {
  for (const file of ["today.css", "task-verdict.css"]) {
    const rule = css(file).split("\n").find((l) => /\.answer-form button\.send-answer\s*\{/.test(l));
    expect(rule, file).toBeDefined();
    expect(rule).toContain("background: var(--signal-fill)");
    expect(rule).toContain("color: var(--on-signal-fill)");
  }
  expect(css("task-verdict.css")).toMatch(/button\.outline[^{]*\{[^}]*background:\s*transparent/);
});
it("the open Answer form sits between the verdict sentence and the track", async () => {
  const id = await blocked();
  const task = await (await get(`/p/${NAME}/${id}`)).text();
  const line = task.indexOf('class="verdict-line"'), form = task.indexOf(answerForm(id)), track = task.indexOf('<ol class="track');
  expect(line).toBeGreaterThan(-1);
  expect(form).toBeGreaterThan(line);
  expect(track).toBeGreaterThan(form);
});
