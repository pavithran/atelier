import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { env } from "./support/workers.ts";
import { afterAll, beforeAll, expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { csp } from "../src/live.ts";
import { signIn } from "./signin.ts";
import { withoutDefaultRunner } from "./support/default-runner.ts";
import { UNAVAILABLE_PROJECT, withUnavailable } from "./fixtures/design/seed.ts";

// Rigs at /rigs (t608), entered at worker.fetch. Trust checks, per endpoint:
//   GET /rigs   the owner's page, answered exactly as GET / (Today) is: a signed-in session, else
//               303 to /login with nothing of the page in the answer. No caller names a disclosure
//               level: the one reader sees what Today shows, and the page draws a task only from
//               the projects Today read (a project whose Ledger cannot be read adds none) and a
//               private project's task without its id, title or model.
//   POST /api/queue   unchanged: the runner's poll, which carries the offers and machine readings
//               the page draws from.
// Visibility by output path (the owner is the only audience that reaches the page; the table is what
// each project kind may put in each place):
//   project kind    | train        | track note        | signal          | track tag
//   open project    | id, title, model | title, job, minutes, attempt | id, title, ask, reason | name
//   private project | "private task" | "private project, details hidden" | "private task" | name
//   unreadable      | none         | none              | none            | name only (a runner serves it)
// There is no list API, search, export or generated page for Rigs: the page is the one output.

const TOKEN = "rigs-token";
const ORIGIN = "https://atelier.test";
const OWNER = "owner";
const T = Date.parse("2026-11-09T18:00:00.000Z");
const min = (n: number) => n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const PRIVATE = "tapestries";
const HIDDEN_TITLE = "Cold storage job nobody may see";
const PRIVATE_TITLE = "Private chapter rewrite";

let pages: Env;
let cookie: string;
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const made: Record<string, { id: string; title: string }> = {};

const reading = (change: Record<string, unknown> = {}) => ({ host: "ai-studio-256", cpus: 36, loadavg: [18.3, 16, 15.1], memFreePercent: 34, testSlots: { capacity: 3, inUse: 1 }, ...change });

// A runner's poll on POST /api/queue, as it would send it, at the server's clock `at`.
async function poll(runner: string, extra: Record<string, unknown>, at = T - 30_000): Promise<void> {
  vi.setSystemTime(new Date(at));
  const res = await worker.fetch(new Request(`${ORIGIN}/api/queue`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": OWNER, "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" },
    body: JSON.stringify({ runner, kind: "home", jobs: ["build"], ...extra }),
  }), pages);
  expect(res.status, `${runner} poll`).toBe(200);
}

// A task claimed by `actor` on `runner` whose runner has reported progress.
async function run(key: string, o: { project: string; title: string; actor: string; runner: string; started: number; twice?: boolean }) {
  const l = L(o.project);
  vi.setSystemTime(new Date(T - min(60)));
  const item = await l.newItem(o.title, [], OWNER, {});
  await l.claim(item.id, o.actor, { runner: o.runner, kind: "home" });
  const report = { task: item.id, actor: o.actor, startedAt: iso(T - min(o.started)), at: iso(T - min(o.started)), harness: null, telemetry: true, commands: { started: 5, completed: 4 }, commits: 0, changedFiles: 1, childAlive: true, log: "/var/atelier/runs/x/build.progress.jsonl", current: { name: "Bash", summary: "npm", since: iso(T - 40_000) } };
  if (o.twice) {
    vi.setSystemTime(new Date(T - min(o.started + 30)));
    await l.recordProgress(o.runner, [{ ...report, startedAt: iso(T - min(o.started + 40)), at: iso(T - min(o.started + 40)) }]);
  }
  vi.setSystemTime(new Date(T - 5000));
  await l.recordProgress(o.runner, [report]);
  made[key] = { id: item.id, title: o.title };
}

async function waiting(project: string, title: string, model: string, agent: string): Promise<string> {
  const l = L(project);
  vi.setSystemTime(new Date(T - min(120)));
  const item = await l.newItem(title, [], OWNER, {});
  await l.dispatch(item.id, OWNER, { to: "home", agent, model });
  return item.id;
}

beforeAll(async () => {
  // The fixture's three runners are the only ones offered; the default review runners would add yards.
  withoutDefaultRunner();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T - min(300)));
  for (const name of ["atelier", "miqra", "bible", PRIVATE, UNAVAILABLE_PROJECT]) {
    const record = { name, repo: name, title: name, policy: { checks: ["npm test"], protected: [] }, createdAt: iso(T - min(300)) };
    await I().registerProject(record);
    await L(name).setProject(record, OWNER);
  }
  pages = { ...env, ATELIER_TOKEN: TOKEN, OWNER_NAME: "Owner", TIMEZONE: "UTC", LEDGER: withUnavailable(env.LEDGER, UNAVAILABLE_PROJECT) } as unknown as Env;
  // Work in the project Today cannot read is written before its Ledger is made unreadable for the page.
  await run("hidden", { project: UNAVAILABLE_PROJECT, title: HIDDEN_TITLE, actor: "claude-code/sonnet-5.5", runner: "home:studio-atelier-build", started: 9 });
  made.hiddenWaiting = { id: await waiting(UNAVAILABLE_PROJECT, `${HIDDEN_TITLE} (queued)`, "fable-9", "claude-code"), title: HIDDEN_TITLE };
  // Two machines, three runners: the Studio runs two (the second serves two other projects), the mini one.
  await poll("home:mini-atelier-build", { agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }], machine: reading({ host: "mini-server", cpus: 12, loadavg: [1.57, 1.7, 1.7], memFreePercent: 30, testSlots: null }) });
  await poll("home:studio-miqra-build", { projects: ["miqra", "bible"], agents: [{ agent: "claude-code", models: ["sonnet-5.5", "opus-5.5"] }, { agent: "codex", models: ["gpt-6.1-sol"] }] });
  await poll("home:studio-atelier-build", { agents: [{ agent: "claude-code", models: ["sonnet-5.5", "opus-5.5"] }, { agent: "codex", models: ["gpt-6.1-sol"] }], machine: reading() });
  await run("studio", { project: "atelier", title: "Draw the rig head", actor: "claude-code/sonnet-5.5", runner: "home:studio-atelier-build", started: 12, twice: true });
  await run("miqra", { project: "miqra", title: "Index the verses", actor: "claude-code/opus-5.5", runner: "home:studio-miqra-build", started: 7 });
  await run("bible", { project: "bible", title: "Align the glossary", actor: "codex/gpt-6.1-sol", runner: "home:studio-miqra-build", started: 21 });
  made.queued = { id: await waiting("atelier", "Inventory the state machines", "fable-5.1", "claude-code"), title: "Inventory the state machines" };
  made.served = { id: await waiting("atelier", "Tidy the settings page", "sonnet-5.5", "claude-code"), title: "Tidy the settings page" };
  vi.setSystemTime(new Date(T));
  cookie = await signIn(TOKEN, pages);
}, { timeout: 120_000 });
afterAll(() => { vi.useRealTimers(); });

const get = (path = "/rigs", headers: Record<string, string> = { cookie }) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers, redirect: "manual" }), pages);
const drawn = async () => { const res = await get(); expect(res.status).toBe(200); return res.text(); };
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
// The markup of the element that starts at `open`, to its matching close tag.
function block(html: string, open: string, tag = "div"): string {
  const from = html.indexOf(open);
  if (from < 0) throw new Error(`no ${open}`);
  let depth = 0;
  for (const m of html.slice(from).matchAll(new RegExp(`<${tag}[\\s>]|</${tag}>`, "g"))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (!depth) return html.slice(from, from + m.index! + m[0].length);
  }
  throw new Error(`${open} is not closed`);
}
const yard = (html: string, key: string) => block(html, `<section class="yard" data-yard="${key}"`, "section");

// Criterion 1: one yard per machine with a live runner, in the order the brief names; Atelier's tracks, then the sidings.
it("criterion 1: /rigs draws one yard per machine, Studio then mini, Atelier's tracks before Project sidings", async () => {
  const html = await drawn();
  expect([...html.matchAll(/<section class="yard" data-yard="([^"]*)"/g)].map((m) => m[1])).toEqual(["studio", "mini"]);
  expect([...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1])).toEqual(["Mac Studio", "Mac mini"]);
  const studio = yard(html, "studio");
  expect([...studio.matchAll(/data-runner="([^"]*)"/g)].map((m) => m[1])).toEqual(["home:studio-atelier-build", "home:studio-miqra-build"]);
  const sidings = studio.indexOf('<details class="sidings"');
  expect(sidings).toBeGreaterThan(studio.indexOf('data-runner="home:studio-atelier-build"'));
  expect(studio.indexOf('data-runner="home:studio-miqra-build"')).toBeGreaterThan(sidings);
  expect(text(studio.slice(sidings))).toMatch(/^Project sidings/);
  expect(yard(html, "mini")).not.toContain("Project sidings");
  expect(text(html)).toContain("2 of 3 tracks busy");
});

// Criterion 2: a train for a current job, at its task's stage, with its task id and model; a runner with no job has a clear lamp and none.
it("criterion 2: a runner's current job is a train at its stage; a runner with none shows a clear lamp and no train", async () => {
  const html = await drawn();
  const busy = block(html.slice(html.indexOf('data-runner="home:studio-atelier-build"') - 40), '<div class="ytrack ');
  const { id, title } = made.studio;
  expect(busy).toContain(`data-lamp="busy"`);
  expect(busy).toContain(`<div class="train" data-task="${id}" data-project="atelier" data-stage="Branch"`);
  expect(busy).toContain(`<b>${id}</b> sonnet-5.5`);
  expect(busy).toMatch(/<span class="st here" style="--i:1"><em>Branch<\/em>/);
  expect([...busy.matchAll(/<span class="st[^"]*" style="--i:\d"><em>([^<]*)/g)].map((m) => m[1])).toEqual(["Claim", "Branch", "Prove", "Review", "Land"]);
  expect(text(busy)).toContain(`${title} atelier build · Branch · 12 min on track · attempt 2`);
  const idle = block(html.slice(html.indexOf('data-runner="home:mini-atelier-build"') - 40), '<div class="ytrack ');
  expect(idle).toContain(`data-lamp="clear"`);
  expect(idle).not.toContain("train");
  expect(idle).not.toContain("data-task");
});

// Criterion 3: every offered model is a chip, the one at work outlined; a runner serving several projects names each task's own project.
it("criterion 3: each track lists every model it offers, the model at work outlined, and each task is under its own project", async () => {
  const html = await drawn();
  const studio = block(html.slice(html.indexOf('data-runner="home:studio-atelier-build"') - 40), '<div class="ytrack ');
  expect([...studio.matchAll(/<span class="liv( on)?"[^>]*title="([^"]*)"/g)].map((m) => [m[2], !!m[1]])).toEqual([["claude-code/sonnet-5.5", true], ["claude-code/opus-5.5", false], ["codex/gpt-6.1-sol", false]]);
  const many = block(html.slice(html.indexOf('data-runner="home:studio-miqra-build"') - 40), '<div class="ytrack ');
  expect([...many.matchAll(/<span class="liv( on)?"[^>]*title="([^"]*)"/g)].map((m) => [m[2], !!m[1]])).toEqual([["claude-code/sonnet-5.5", false], ["claude-code/opus-5.5", true], ["codex/gpt-6.1-sol", true]]);
  expect([...many.matchAll(/<span class="proj[^"]*">([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(expect.arrayContaining(["miqra", "bible"]));
  const notes = [...many.matchAll(/<div class="under">.*?<\/div>/g)].map((m) => text(m[0]));
  expect(notes).toHaveLength(2);
  expect(notes.find((n) => n.includes(made.miqra.title))).toContain("miqra build");
  expect(notes.find((n) => n.includes(made.bible.title))).toContain("bible build");
  expect(many).toContain(`data-task="${made.miqra.id}" data-project="miqra"`);
  expect(many).toContain(`data-task="${made.bible.id}" data-project="bible"`);
});

// Criterion 5: the red signal.
it("criterion 5: a task dispatched to a model no live runner offers waits at a red signal with the reason atelier status gives; an offered one does not", async () => {
  const html = await drawn();
  const signals = [...html.matchAll(/<section class="signal-wait"/g)];
  expect(signals).toHaveLength(1);
  const sig = block(html, '<section class="signal-wait"', "section");
  expect(sig).toContain(`data-task="${made.queued.id}" data-project="atelier"`);
  expect(sig.indexOf("signal-wait")).toBeGreaterThan(html.lastIndexOf("</section>", html.indexOf("signal-wait") - 1) - 1);
  expect(html.indexOf('class="signal-wait"')).toBeGreaterThan(html.lastIndexOf('<section class="yard"'));
  const words = text(sig);
  expect(words).toContain(`${made.queued.id} waits at the signal`);
  expect(words).toContain("asks a home runner, claude-code with fable-5.1");
  expect(words).toContain("No live runner can take it:");
  // The reason is the one the owner's listing carries (queueWhy in src/index.ts, unclaimed in src/dispatch/rules.ts).
  // The line is the one `atelier status` prints for the task: the owner's listing carries it as `why`.
  const listing = await worker.fetch(new Request(`${ORIGIN}/api/queue`, { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": OWNER } }), pages);
  const queued = (await listing.json() as { project: string; item: { id: string; why?: { kind: string; line: string }[] } }[]).find((q) => q.project === "atelier" && q.item.id === made.queued.id);
  const reason = queued?.item.why?.find((r) => r.kind === "unoffered")?.line ?? "";
  expect(reason).toContain("No live runner can take it");
  expect(words).toContain(reason.replace(/&#x27;/g, "'"));
  expect(text(html)).not.toContain("Tidy the settings page");
});

// Criterion 6: the same answer Today gives a visitor, and nothing of a project Today hides.
it("criterion 6: a visitor is answered as Today answers them; no task of an unreadable project and no private detail is drawn", async () => {
  const visitor = { } as Record<string, string>;
  const [rigs, today] = [await get("/rigs", visitor), await get("/", visitor)];
  expect([rigs.status, rigs.headers.get("location")]).toEqual([today.status, today.headers.get("location")]);
  expect(rigs.status).toBe(303);
  expect(await rigs.text()).toBe(await today.text());
  const html = await drawn();
  // Today names the unreadable project as unread and draws none of its tasks; neither does the page.
  const todayHtml = await (await get("/")).text();
  expect(todayHtml).not.toContain(HIDDEN_TITLE);
  expect(html).not.toContain(HIDDEN_TITLE);
  // The bar's project list is the shell's, filled for every owner page; the page itself names no unreadable project.
  expect(block(html, '<div class="rigs">')).not.toContain(UNAVAILABLE_PROJECT);
  expect(html.match(/waits at the signal/g)).toHaveLength(1);
});

it("criterion 6: a private project's task is a train without its id, title or model", async () => {
  await poll("home:macbook-tap-build", { projects: [PRIVATE], agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }] });
  await run("private", { project: PRIVATE, title: PRIVATE_TITLE, actor: "claude-code/sonnet-5.5", runner: "home:macbook-tap-build", started: 3 });
  const privateWaiting = await waiting(PRIVATE, `${PRIVATE_TITLE} (queued)`, "fable-9", "claude-code");
  vi.setSystemTime(new Date(T));
  const html = await drawn();
  const t = block(html.slice(html.indexOf('data-runner="home:macbook-tap-build"') - 40), '<div class="ytrack ');
  expect(t).toContain('class="train private"');
  expect(text(t)).toContain("private task");
  expect(text(t)).toContain("tapestries · private project, details hidden");
  for (const secret of [PRIVATE_TITLE, `href="/p/${PRIVATE}`, "liv on", "t-private"]) expect(t, secret).not.toContain(secret);
  expect(t).toContain('<span class="car">private task</span>');
  expect(html).not.toContain(PRIVATE_TITLE);
  void privateWaiting;
  expect(text(block(html, `<section class="signal-wait" data-task="" data-project="${PRIVATE}"`, "section"))).toContain("private task waits at the signal");
});

// Criterion 7: the bar and what the page may call.
it("criterion 7: the bar gains Rigs after Models, current on /rigs; the page loads nothing but its own script and fonts", async () => {
  const html = await drawn();
  const nav = block(html, '<nav class="bar-nav"', "nav");
  expect([...nav.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)/g)].map((m) => m[2])).toEqual(["Today", "Projects", "History", "Process", "Models", "Rigs"]);
  expect(nav).toContain('<a href="/rigs" aria-current="page">Rigs</a>');
  expect(nav.match(/aria-current/g)).toHaveLength(1);
  expect(await (await get("/")).text()).not.toMatch(/href="\/rigs" aria-current/);
  // Everything the page fetches: scripts, stylesheets, images, forms, frames, and no inline script.
  const loads = [...html.matchAll(/<(?:script|img|iframe|source|link)\b[^>]*\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  expect(loads.filter((u) => !u.startsWith("https://fonts.g") && u !== "/live.js")).toEqual([]);
  expect(html).not.toMatch(/<form\b/);
  expect(html.match(/<script\b/g)).toHaveLength(1);
  // It reads in full without script: the yards, trains and signal are in the markup the server sent.
  const words = text(html.replace(/<script\b[\s\S]*?<\/script>/g, ""));
  for (const needle of ["Mac Studio", "Mac mini", made.studio.title, "waits at the signal", "no reading"]) expect(words, needle).toContain(needle === "no reading" ? "memory" : needle);
  expect(html).toContain('data-live-refresh="10"');
});

// Criterion 8 and 9 are measured in a browser (Chromium from playwright's cache or ATELIER_CAPTURE_CHROMIUM).
const executable = process.env.ATELIER_CAPTURE_CHROMIUM || chromium.executablePath();
const skip = !!(executable && existsSync(executable)) ? false : "no Chromium in playwright's cache and ATELIER_CAPTURE_CHROMIUM names none";
const PAGE_URL = "http://page.test/rigs";
// The wrapper's `it` takes no skip option; a test that needs the browser is skipped by name.
const itBrowser = skip ? it.skip : it;

// Waits in real time for what a faked-clock page does with promises: the page's own timers are the fake clock's, so Playwright's polling cannot be used.
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("the page did not reach the state in 5 s");
}

async function open<T>(opts: { width: number; scheme: "light" | "dark"; reduced?: "reduce" | "no-preference"; fake?: string; html?: string }, fn: (page: import("playwright-core").Page, failed: string[]) => Promise<T>): Promise<T> {
  const res = await get();
  const html = opts.html ?? await res.text();
  // The policy is the one the server sends with the nonce this copy carries (src/live.ts).
  const policy = csp(/<script nonce="([^"]*)"/.exec(html)?.[1]);
  const script = await (await worker.fetch(new Request(`${ORIGIN}/live.js`), pages)).text();
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: opts.width, height: 900 }, colorScheme: opts.scheme, reducedMotion: opts.reduced ?? "no-preference" });
    const page = await context.newPage();
    const failed: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") failed.push(`console: ${m.text()}`); });
    page.on("pageerror", (e) => failed.push(`pageerror: ${e.message}`));
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url === PAGE_URL) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "content-security-policy": policy }, body: html });
      if (url === "http://page.test/live.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: script });
      // The font stylesheet is answered empty: the page names it, the test does not need the faces.
      if (url.startsWith("https://fonts.googleapis.com/")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
      failed.push(`request: ${url}`);
      return route.abort();
    });
    if (opts.fake) await page.addInitScript(opts.fake);
    return await fn(page, failed);
  } finally { await browser.close(); }
}

// Criterion 8: live.js refetches /rigs every 10 s with a fake clock and a fake fetch, and redraws the yard.
itBrowser("criterion 8: live.js fetches /rigs once at 10 s and none before, and redraws the yard from the answer", async () => {
  const before = await drawn();
  // A new train on the idle mini runner, as a poll would show it 10 s later.
  await run("new", { project: "atelier", title: "A train that arrives", actor: "claude-code/sonnet-5.5", runner: "home:mini-atelier-build", started: 1 });
  vi.setSystemTime(new Date(T));
  const after = await drawn();
  expect(before).not.toContain(made.new.id + '"');
  expect(after).toContain(`data-task="${made.new.id}"`);
  const fake = `window.__calls = []; window.fetch = (url, init) => { window.__calls.push({ url: String(url), method: (init && init.method) || "GET" }); return Promise.resolve({ ok: true, url: String(url), text: () => Promise.resolve(${JSON.stringify(after)}) }); };`;
  // The page the browser shows is the first answer; the fetch gets the second.
  await open({ width: 1280, scheme: "light", fake, html: before }, async (page, failed) => {
    // page.clock is the browser's fake clock: nothing ticks until it is told to.
    await page.clock.install({ time: T });
    await page.goto(PAGE_URL);
    const trains = () => page.locator('[data-yard="mini"] .train').count();
    expect(await trains()).toBe(0);
    expect(await page.locator("h1").innerText()).toContain("3 of 4");
    await page.clock.runFor(9_900);
    expect(await page.evaluate("window.__calls.length")).toBe(0);
    await page.clock.runFor(200);
    await until(async () => ((await page.evaluate("window.__calls.length")) as number) >= 1);
    expect(await page.evaluate("window.__calls") as unknown).toEqual([{ url: PAGE_URL, method: "GET" }]);
    await until(async () => (await trains()) === 1);
    expect(await trains()).toBe(1);
    expect(await page.locator('[data-yard="mini"] [data-lamp="busy"]').count()).toBe(1);
    expect(await page.locator("h1").innerText()).toContain("4 of 4");
    expect(failed).toEqual([]);
  });
});

// Criterion 9: no sideways scroll at 390 px, and nothing moves under reduced motion.
for (const scheme of ["light", "dark"] as const) {
  itBrowser(`criterion 9: at 390 px in ${scheme} the page does not scroll sideways, and calls nothing else`, async () => {
    await open({ width: 390, scheme }, async (page, failed) => {
      await page.goto(PAGE_URL);
      expect(await page.locator(".yard .train").count(), "the page drew its yards and trains").toBeGreaterThan(0);
      const m = await page.evaluate("({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })") as { client: number; scroll: number };
      expect(m.scroll, `scrollWidth ${m.scroll}, clientWidth ${m.client}`).toBe(m.client);
      expect(failed).toEqual([]);
    });
  });
}

itBrowser("criterion 9: trains and lamps animate with no preference and do not under prefers-reduced-motion", async () => {
  const motion = async (reduced: "reduce" | "no-preference") => open({ width: 1280, scheme: "dark", reduced }, async (page) => {
    await page.goto(PAGE_URL);
    return page.evaluate(`(() => {
      const lamp = getComputedStyle(document.querySelector(".lamp.busy")), train = getComputedStyle(document.querySelector(".train"));
      return { lamp: lamp.animationName, train: train.transitionDuration };
    })()`) as Promise<{ lamp: string; train: string }>;
  });
  expect(await motion("no-preference")).toEqual({ lamp: "rigs-breathe", train: "1.2s" });
  expect(await motion("reduce")).toEqual({ lamp: "none", train: "0s" });
});

// The screenshots in docs/design/rigs/shots, taken of this revision (ATELIER_WRITE_SHOTS=1 writes them).
(skip || !process.env.ATELIER_WRITE_SHOTS ? it.skip : it)("screenshots: 1280 and 390 px, light and dark, with no console error or failed request", async () => {
  const dir = new URL("../docs/design/rigs/shots/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const width of [1280, 390]) {
    for (const scheme of ["light", "dark"] as const) {
      await open({ width, scheme }, async (page, failed) => {
        await page.goto(PAGE_URL);
        await page.screenshot({ path: new URL(`rigs-${width}-${scheme}.png`, dir).pathname, fullPage: true });
        expect(failed).toEqual([]);
      });
    }
  }
});

// A claim names its runner before the runner prepares its workspace and reports progress (fix round for t608).
// These run last: they add claimed tasks to the mini's track.
// They use a runner of their own: earlier tests leave a train on the mini's other track.
const EARLY = "home:mini-atelier-early";
const miniTrack = (html: string) => block(html.slice(html.indexOf(`data-runner="${EARLY}"`) - 40), '<div class="ytrack ');
async function claimed(title: string, runner: string | null) {
  const l = L("atelier");
  vi.setSystemTime(new Date(T - min(3)));
  const item = await l.newItem(title, [], OWNER, {});
  await l.claim(item.id, "claude-code/sonnet-5.5", runner ? { runner, kind: "home" } : undefined);
  vi.setSystemTime(new Date(T));
  return item;
}

it("claim before progress: a claimed task with a recorded runner and no progress record is a train at Claim on that track, and the lamp is busy", async () => {
  await poll(EARLY, { agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }] }, T - 20_000);
  vi.setSystemTime(new Date(T));
  const item = await claimed("Prepare the workspace", EARLY);
  const mini = miniTrack(await drawn());
  expect(mini).toContain(`data-lamp="busy"`);
  expect(mini).toContain(`<div class="train" data-task="${item.id}" data-project="atelier" data-stage="Claim"`);
  expect(mini).toMatch(/<span class="st here" style="--i:0"><em>Claim<\/em>/);
  expect(text(mini)).toContain("Prepare the workspace atelier build · Claim · no progress reported yet");
  made.early = { id: item.id, title: item.title };
});

it("claim before progress: after its first progress record the task is one train, at its stage", async () => {
  const { id } = made.early;
  vi.setSystemTime(new Date(T - 2000));
  await L("atelier").recordProgress(EARLY, [{ task: id, actor: "claude-code/sonnet-5.5", startedAt: iso(T - min(2)), at: iso(T - min(2)), harness: null, telemetry: true, commands: { started: 1, completed: 0 }, commits: 0, changedFiles: 0, childAlive: true, log: "/var/atelier/runs/y/build.progress.jsonl", current: { name: "Bash", summary: "npm", since: iso(T - 5000) } }]);
  vi.setSystemTime(new Date(T));
  const mini = miniTrack(await drawn());
  expect([...mini.matchAll(/<div class="train"/g)]).toHaveLength(1);
  expect(mini).toContain(`data-task="${id}" data-project="atelier" data-stage="Branch"`);
  expect(text(mini)).toContain("2 min on track");
});

it("claim before progress: a claimed task with no recorded runner draws no train", async () => {
  const item = await claimed("Claimed by hand", null);
  const html = await drawn();
  expect(html).not.toContain(`data-task="${item.id}"`);
});
