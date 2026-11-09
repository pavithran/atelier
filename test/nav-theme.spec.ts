import { env } from "./support/workers.ts";
import { afterAll, beforeAll, expect, it, vi } from "./support/vitest.ts";
import { seed, type Seeded } from "./fixtures/design/seed.ts";
import { designEnv, draw, serveKeys, session } from "./fixtures/design/pages.ts";
import { page as ownerPage } from "../src/ui.ts";

// The owner's bar and device theme (t585), entered at worker.fetch on the
// design fixture (test/fixtures/design/seed.ts). Trust checks, per endpoint:
//   GET /projects and every page here   Access's owner assertion where Access is configured
//                                       (401 public page without); no caller names a disclosure
//                                       level, and the one reader sees every project.
//   GET /home                           redirect only; reads nothing.
// Visibility by output path: the owner's pages carry the bar; the public 401 page
// carries none (checked below); no level is chosen by a caller's request.

let seeded: Seeded;
let pages: Env;
let cookie: string;
const keys = () => serveKeys();

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  seeded = await seed(env);
  pages = designEnv(env, seeded);
  keys();
  cookie = await session(pages);
}, { timeout: 600_000 });
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const get = async (path: string) => { const res = await draw(pages, path, "owner", cookie); return { res, body: await res.text() }; };
const barOf = (body: string) => body.slice(body.indexOf('<header class="owner-bar">'), body.indexOf("</header>", body.indexOf('<header class="owner-bar">')));
const rowOne = (body: string) => barOf(body).split('aria-label="Atelier">')[1]?.split("</nav>")[0] ?? "";
const items = (body: string) => [...rowOne(body).matchAll(/<a href="([^"]+)"([^>]*)>([A-Za-z]+)/g)].map((m) => ({ href: m[1], label: m[3], current: m[2].includes('aria-current="page"') }));

const ledger = () => "ledger-core";
const outside = ["/", "/projects", "/studio", "/flow", "/history", "/models", "/usage"];
const inside = () => ["/p/ledger-core", "/p/ledger-core/tasks", "/p/ledger-core/plans", "/p/ledger-core/flow", "/p/ledger-core/process", "/p/ledger-core/settings", "/p/ledger-core/ship", "/p/ledger-core/code", "/p/ledger-core/log", `/p/ledger-core/${seeded.byShape[ledger()].ready![1]}`, "/p/ledger-core/t9999"];

it("criterion 1: the bar lists Today, Projects, History, Process, Models in that order on every owner page", async () => {
  for (const path of [...outside, ...inside()]) {
    const { body } = await get(path);
    expect(items(body).map((i) => i.label), path).toEqual(["Today", "Projects", "History", "Process", "Models"]);
    expect(items(body).map((i) => i.href.replace(/^\/p\/[^/]+\/process$/, "PROCESS")), path).toEqual(["/", "/projects", "/studio", "PROCESS", "/models"]);
  }
});

it("criterion 2: exactly one item is current, by page", async () => {
  const want: Record<string, string | null> = {
    "/": "Today", "/projects": "Projects", "/studio": "History", "/flow": "History", "/history": "History", "/models": "Models", "/usage": null,
    "/p/ledger-core/process": "Process",
  };
  for (const p of inside()) want[p] ??= "Projects";
  for (const path of Object.keys(want).concat(inside())) {
    const label = path in want ? want[path] : "Projects";
    const { body } = await get(path);
    const current = items(body).filter((i) => i.current).map((i) => i.label);
    expect(current, path).toEqual(label ? [label] : []);
  }
});

it("criterion 3: the brand leads to /, /projects answers 200 with the portfolio, /home still 302, Models left the account menu", async () => {
  const { res, body } = await get("/projects");
  expect(res.status).toBe(200);
  expect(body).toContain("Ledger Core");
  expect(body).toContain('class="brand" href="/"');
  const home = await draw(pages, "/home", "owner", cookie);
  expect(home.status).toBe(302);
  expect(home.headers.get("location")).toMatch(/\/$/);
  const account = body.split('class="bar-menu account"')[1].split("</details>")[0];
  expect(account).toContain('href="/usage"');
  expect(account).not.toContain("Models");
});

it("criterion 4: Process links to the project's process inside /p/P/ and to /p/atelier/process elsewhere", async () => {
  const process = (body: string) => items(body).find((i) => i.label === "Process")!.href;
  for (const path of outside) expect(process((await get(path)).body), path).toBe("/p/atelier/process");
  for (const path of inside()) expect(process((await get(path)).body), path).toBe("/p/ledger-core/process");
});

const schemeOf = (body: string) => ({ pinned: /<html[^>]*data-scheme/.test(body), color: /<meta name="color-scheme" content="([^"]*)"/.exec(body)?.[1] });

it("criterion 5: owner pages, the error page and the 401 page write no data-scheme and say 'dark light'", async () => {
  const task = `/p/ledger-core/${seeded.byShape[ledger()].ready![1]}`;
  for (const path of ["/", task, "/studio", "/p/ledger-core/t9999"]) expect(schemeOf((await get(path)).body), path).toEqual({ pinned: false, color: "dark light" });
  const refused = await draw(pages, "/p/ledger-core", "public", "");
  expect(refused.status).toBe(401);
  expect(schemeOf(await refused.text())).toEqual({ pinned: false, color: "dark light" });
  expect(schemeOf(ownerPage("Plain", "<p>x</p>"))).toEqual({ pinned: false, color: "dark light" });
  // The device option no longer exists: a page given it is the same page.
  expect(ownerPage("Plain", "<p>x</p>", "Home", null, 0, true, undefined, { device: true } as never)).toBe(ownerPage("Plain", "<p>x</p>", "Home"));
});

it("the visitor's 401 page draws no owner bar", async () => {
  const body = await (await draw(pages, "/p/ledger-core", "public", "")).text();
  expect(body).not.toContain('class="owner-bar"');
  expect(body).not.toContain("Sign out");
});
