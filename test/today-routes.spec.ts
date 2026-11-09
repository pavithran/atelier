import { readFileSync, writeFileSync } from "node:fs";
import "./today-clock.ts";
import { env } from "./support/workers.ts";
import { afterAll, beforeAll, expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { seed, type Seeded } from "./fixtures/design/seed.ts";
import { ORIGIN, TOKEN, designEnv, serveKeys, session, assertion } from "./fixtures/design/pages.ts";

// Today at / (t562), entered at worker.fetch on the design fixture
// (test/fixtures/design/seed.ts): the same seeded ledgers the design captures
// draw. Trust checks, per endpoint:
//   GET /                     Access's owner assertion where Access is configured (401 without,
//                             no project data in the answer); a signed-in session otherwise
//                             (303 to /login without). No caller names a disclosure level: the
//                             one reader sees every project.
//   GET /home, /now, /decisions   redirects only; they read nothing.
//   GET /api/now              the developer's token (unchanged by this task).

let seeded: Seeded;
let pages: Env;
let cookie: string;
const keys = () => serveKeys();
const SNAPSHOT = new URL("./fixtures/design/api-now.json", import.meta.url);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  seeded = await seed(env);
  pages = designEnv(env, seeded);
  keys();
  cookie = await session(pages);
}, { timeout: 600_000 });
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const owner = async (path: string, extra: Record<string, string> = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { "cf-access-jwt-assertion": await assertion(), cookie, ...extra }, redirect: "manual" }), pages);
const apiNow = async () => worker.fetch(new Request(`${ORIGIN}/api/now`, { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" } }), pages);

// Criterion 3: /api/now on the design fixture equals the snapshot taken on main
// before Today was built (ATELIER_WRITE_SNAPSHOT=1 rewrites it, on main only).
it("/api/now on the design fixture equals the snapshot taken on main", async () => {
  const res = await apiNow();
  expect(res.status).toBe(200);
  const got = await res.json();
  if (process.env.ATELIER_WRITE_SNAPSHOT) writeFileSync(SNAPSHOT, `${JSON.stringify(got, null, 2)}\n`);
  expect(got).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

// Criterion 3: the three old addresses are redirects, each with its status and Location.
it("/home and /now answer 302 to /, /decisions with a task 302 to its page, bare /decisions 302 to /", async () => {
  const table: [string, string][] = [
    ["/home", "/"], ["/now", "/"], ["/decisions", "/"],
    ["/decisions?project=ledger-core&task=t12", "/p/ledger-core/t12"],
    ["/decisions?project=ledger-core", "/"],
    ["/decisions?project=..&task=t12", "/"],
    ["/decisions?project=ledger-core&task=../x", "/"],
  ];
  for (const [path, to] of table) {
    const res = await owner(path);
    expect(res.status, path).toBe(302);
    expect(res.headers.get("location"), path).toBe(to);
    expect(await res.text(), path).not.toContain("Ledger Core");
  }
});

const tile = (html: string, name: string) => {
  const m = new RegExp(`data-tile="${name}"[^>]*>[\\s\\S]*?<span class="n">([^<]*)</span>`).exec(html);
  if (!m) throw new Error(`no ${name} tile`);
  return m[1];
};
const section = (html: string, id: string) => {
  const from = html.indexOf(`id="${id}"`);
  if (from < 0) throw new Error(`no ${id} section`);
  const next = html.indexOf("<section", from);
  return html.slice(from, next < 0 ? undefined : next);
};

// Criteria 1 and 8: the page and its figures against the Now view they come from.
it("a signed-in GET / answers 200 with the headline, four tiles and four sections; each tile equals its buildNow figure", async () => {
  const started = performance.now();
  const res = await owner("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  // Measured on the 310-task fixture, target under 1 s; the bound here only catches a page that has gone slow by an order of magnitude.
  const took = Math.round(performance.now() - started);
  console.log(`Today rendered in ${took} ms on the design fixture (310 tasks)`);
  expect(took).toBeLessThan(5000);
  const view = (await (await apiNow()).json()) as { header: { mergesToday: number }; groups: { key: string; rows: { id: string; href: string; project: string }[] }[]; unread: string[] };
  const rows = (key: string) => view.groups.find((g) => g.key === key)!.rows;
  expect(html).toMatch(/<h1[^>]*>[\s\S]*wait[\s\S]*<\/h1>/);
  for (const label of ["Need you", "Running now", "Merged today", "Deploys today"]) expect(html).toContain(`>${label}<`);
  for (const heading of ["Needs you", "Running", "Merged and deployed today", "Projects"]) expect(html).toMatch(new RegExp(`<h2[^>]*>${heading}[ <]`));
  expect(tile(html, "need")).toBe(String(rows("needs-you").length));
  expect(tile(html, "running")).toBe(String(rows("running").length + rows("waiting").length));
  expect(tile(html, "merged")).toBe(String(view.header.mergesToday));
  // The design fixture records no ship, so no deploy is counted.
  expect(tile(html, "deploys")).toBe("0");
  expect(rows("needs-you").length).toBeGreaterThan(0);
  // Criterion 8: read-only; each Needs you card links to its task page.
  expect(html).not.toMatch(/<form|<button|method="post"|formaction|<input/i);
  expect(html.toLowerCase()).not.toContain("main green");
  const links = [...section(html, "needs-you").matchAll(/<a class="today-title" href="([^"]+)"/g)].map((m) => m[1]);
  expect(links.sort()).toEqual(rows("needs-you").map((r) => r.href).sort());
  for (const l of links) expect(l).toMatch(/^\/p\/[^/]+\/t\d+$/);
});

// Criterion 9, failure path at the real boundary: one ledger throws.
it("a project whose ledger cannot be read is named, its figures read 'not read' and are never 0", async () => {
  const html = await (await owner("/")).text();
  const card = /<div class="today-proj unread"[^>]*>[\s\S]*?<\/div><\/div>/.exec(html)?.[0] ?? "";
  expect(card).toContain("cold-storage");
  expect(card).toContain("not read");
  expect(card).not.toMatch(/\b0\b/);
  expect(html).toMatch(/role="alert"[^>]*>[^<]*Not read: cold-storage/);
  // The others are read: their cards carry figures.
  expect(html).toContain("Ledger Core");
});

// Criterion 5, through the Worker: each project's ledger-wide events are paged once.
it("GET / asks each project's ledger-wide event pages once each", async () => {
  const asked: { project: string; before: number | undefined; id: string | undefined }[] = [];
  const spy = new Proxy(pages.LEDGER, {
    get(target, prop) {
      if (prop !== "get") { const v = Reflect.get(target, prop); return typeof v === "function" ? v.bind(target) : v; }
      return (id: DurableObjectId, opts?: unknown) => {
        const stub = (target.get as (id: DurableObjectId, opts?: unknown) => Record<string, unknown>)(id, opts);
        return new Proxy(stub, {
          get(s, method) {
            const fn = Reflect.get(s, method);
            if (method !== "events" || typeof fn !== "function") return fn;
            return (eventsId?: string, limit?: number, before?: number) => { asked.push({ project: id.name ?? String(id), before, id: eventsId }); return (fn as (...a: unknown[]) => unknown).call(s, eventsId, limit, before); };
          },
        });
      };
    },
  }) as unknown as DurableObjectNamespace;
  const res = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { "cf-access-jwt-assertion": await assertion(), cookie }, redirect: "manual" }), { ...pages, LEDGER: spy } as Env);
  expect(res.status).toBe(200);
  const wide = asked.filter((a) => a.id === undefined);
  expect(wide.length).toBeGreaterThan(0);
  const keys = wide.map((a) => `${a.project}:${a.before}`);
  expect(new Set(keys).size).toBe(keys.length);
});

// Criterion 2: Access configured and not.
it("with Access configured, GET / without an owner assertion answers 401 and shows no project data", async () => {
  for (const method of ["GET", "HEAD"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}/`, { method, redirect: "manual" }), pages);
    expect(res.status, method).toBe(401);
    const body = await res.text();
    for (const secret of ["Ledger Core", "ledger-core", "Field Notes", "data-tile", "Open Tool", "cold-storage"]) expect(body).not.toContain(secret);
  }
  // A session cookie alone is not Access's vouching.
  const res = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { cookie }, redirect: "manual" }), pages);
  expect(res.status).toBe(401);
});

it("on a server without Access, GET / with no session answers 303 to /login, and with a session 200", async () => {
  const { CF_ACCESS_ISS: _a, CF_ACCESS_AUD: _b, CF_ACCESS_OWNER_EMAIL: _c, ...rest } = pages as unknown as Record<string, unknown>;
  const plain = rest as unknown as Env;
  const bare = await worker.fetch(new Request(`${ORIGIN}/`, { redirect: "manual" }), plain);
  expect(bare.status).toBe(303);
  expect(new URL(bare.headers.get("location")!, ORIGIN).pathname).toBe("/login");
  expect(await bare.text()).not.toContain("Ledger Core");
  const signed = await session(plain);
  const res = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { cookie: signed }, redirect: "manual" }), plain);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Ledger Core");
});
