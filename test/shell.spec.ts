import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

// The owner's bar (t543; docs/design/reimagined/, plan.md P1) through the
// Worker's own fetch handler: every owner route served today answers with
// the bar, its current item marked, every link in it leads to a page that
// answers, and the Decisions count is the number the Decisions list counts.
// The browsing routes (code, log, commit, path history) need Artifacts; the
// design fixture draws those (test/fixtures/design/fixture.spec.ts).

const TOKEN = "shell-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));

async function project(name: string, title?: string) {
  const record = { name, repo: name, ...(title ? { title } : {}), policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
}

const bar = (html: string) => html.slice(html.indexOf('<header class="owner-bar">'), html.indexOf("</header>", html.indexOf('<header class="owner-bar">')) + 9);
const row = (html: string, label: string) => bar(html).split(`aria-label="${label}">`)[1]?.split("</nav>")[0] ?? "";
const current = (nav: string) => [...nav.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((m) => m[1]);
const badge = (html: string) => /<span class="badge"><span class="visually-hidden">, waiting on you: <\/span>(\d+)\??<\/span>/.exec(bar(html))?.[1];

// Today's owner routes outside the browsing pages, each with the row-1 item
// and the project tab it makes current (null: none), as plan.md §2 maps them.
const NAME = "shell-area";
const ROUTES: [path: string, nav: string | null, tab: string | null][] = [
  ["/home", "/home", null],
  ["/decisions", "/decisions", null],
  ["/studio", "/studio", null],
  ["/flow", "/studio", null],
  ["/history", "/studio", null],
  ["/models", null, null],
  ["/usage", null, null],
  [`/p/${NAME}`, "/home", `/p/${NAME}`],
  [`/p/${NAME}/tasks`, "/home", `/p/${NAME}/tasks`],
  [`/p/${NAME}/flow`, "/home", `/p/${NAME}/flow`],
  [`/p/${NAME}/plans`, "/home", `/p/${NAME}/tasks`],
  [`/p/${NAME}/ship`, "/home", `/p/${NAME}/settings`],
  [`/p/${NAME}/settings`, "/home", `/p/${NAME}/settings`],
  [`/p/${NAME}/t1`, "/home", `/p/${NAME}/tasks`],
];

it("every owner route answers with the bar, its own item current, and every link in the bar answers", async () => {
  await project(NAME, "Shell Area");
  await L(NAME).newItem("Blocked work", ["src/**"], "owner");
  await L(NAME).block("t1", "owner", "waiting on a decision");
  await L(NAME).newItem("Open work", ["docs/**"], "owner");
  const cookie = await signIn(TOKEN, testEnv);
  const get = (path: string) => worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie }, redirect: "manual" }), testEnv);

  const links = new Set<string>();
  for (const [path, nav, tab] of ROUTES) {
    const res = await get(path);
    expect(res.status, path).toBe(200);
    const html = await res.text();
    expect(html, path).toContain('<header class="owner-bar">');
    expect(html, path).not.toContain("<!--shell:");
    expect(html, path).not.toContain('class="rail"');
    expect(current(row(html, "Atelier")), path).toEqual(nav ? [nav] : []);
    if (tab) {
      expect(current(row(html, "Project")), path).toEqual([tab]);
      expect(row(html, "Project"), path).toContain(`href="/p/${NAME}/tasks"`);
      expect(row(html, "Project"), path).toMatch(/>Tasks<span data-shell="tasks"> \(2\)<\/span></);
      expect(bar(html), path).toContain("<summary>Shell Area</summary>");
    } else expect(bar(html), path).not.toContain('aria-label="Project"');
    for (const m of bar(html).matchAll(/<a [^>]*href="([^"]+)"/g)) links.add(m[1]);
  }
  // The bar's destinations, the five tabs and the switcher's projects.
  for (const want of ["/decisions", "/home", "/studio", "/models", "/usage", `/p/${NAME}`, `/p/${NAME}/tasks`, `/p/${NAME}/code`, `/p/${NAME}/flow`, `/p/${NAME}/settings`]) expect([...links]).toContain(want);
  // Each link answers; Code reads Artifacts, which this pool has no repository in, so it is drawn by the design fixture.
  for (const link of links) {
    if (link.endsWith("/code")) continue;
    expect((await get(link)).status, link).toBe(200);
  }
  // The addresses that moved still answer with their redirect.
  expect((await get("/projects")).headers.get("location")).toBe("/home");
  expect((await get(`/flow?project=${NAME}`)).headers.get("location")).toBe(`/p/${NAME}/flow`);
});

it("the Decisions badge is the number the Decisions list says waits on the owner, on every page", async () => {
  const name = "shell-count";
  await project(name);
  for (const t of ["One", "Two", "Three"]) await L(name).newItem(t, ["src/**"], "owner");
  await L(name).block("t1", "owner", "needs the owner");
  await L(name).block("t2", "owner", "needs the owner");
  const cookie = await signIn(TOKEN, testEnv);
  const html = async (path: string) => (await worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie } }), testEnv)).text();

  const decisions = await html("/decisions");
  const listed = Number(/<p class="lead">(\d+) tasks? needs? your attention\.<\/p>/.exec(decisions)?.[1]);
  expect(listed).toBeGreaterThanOrEqual(2);
  expect(badge(decisions)).toBe(String(listed));
  for (const path of ["/home", "/studio", `/p/${name}`, `/p/${name}/settings`, "/models"]) expect(badge(await html(path)), path).toBe(String(listed));
  // The switcher says what waits in this project beside its name.
  expect(bar(decisions)).toContain(`<a href="/p/${name}">${name} <span class="meta">2 waiting</span></a>`);

  // One more waiting, and the count follows on the next page drawn.
  await L(name).block("t3", "owner", "needs the owner");
  expect(badge(await html("/home"))).toBe(String(listed + 1));
});

// The shell's pre-review: the pages a tab holds (Plans, Log, Ship) must stay
// reachable from the bar, linked under their tab while it is current.
it("each tab that holds a page links to it from the bar", async () => {
  await project("shell-held");
  const cookie = await signIn(TOKEN, testEnv);
  for (const [tabPath, held] of [["tasks", "plans"], ["settings", "ship"], ["plans", "plans"], ["ship", "ship"]] as const) {
    const res = await worker.fetch(new Request(`https://atelier.test/p/shell-held/${tabPath}`, { headers: { cookie }, redirect: "manual" }), testEnv);
    expect(res.status, tabPath).toBe(200);
    const html = await res.text();
    expect(bar(html), `/p/shell-held/${tabPath}`).toContain(`href="/p/shell-held/${held}"`);
  }
});

// Gate finding 3: a page in a project's area that fails, or has nothing to
// draw, still has the project row, drawn from the address, with the page it
// names current.
it("an error or empty page under /p/NAME has the project row from its address", async () => {
  const name = "shell-error";
  await project(name, "Shell Error");
  await L(name).newItem("Only task", ["src/**"], "owner");
  const cookie = await signIn(TOKEN, testEnv);
  const get = async (path: string) => {
    const res = await worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie }, redirect: "manual" }), testEnv);
    return { status: res.status, html: await res.text() };
  };
  // An empty repository (no commits) and a commit that is not in it, under Code; a task that does not exist, under Tasks.
  for (const [path, tab, crumb] of [
    [`/p/${name}/code`, `/p/${name}/code`, "Code"],
    [`/p/${name}/log`, `/p/${name}/code`, "Log"],
    [`/p/${name}/commit/${"0".repeat(40)}`, `/p/${name}/code`, "Code"],
    [`/p/${name}/t99`, `/p/${name}/tasks`, "t99"],
  ] as const) {
    const { status, html } = await get(path);
    expect(status, path).not.toBe(200);
    expect(html, path).toContain('<header class="owner-bar">');
    expect(html, path).not.toContain("<!--shell:");
    expect(current(row(html, "Project")), path).toEqual([tab]);
    expect(bar(html), path).toContain(`<p class="crumb"><a href="/p/${name}">Shell Error</a> › <span>${crumb}</span></p>`);
    expect(bar(html), path).toContain("<summary>Shell Error</summary>");
    expect(row(html, "Project"), path).toContain('>Tasks<span data-shell="tasks"> (1)</span>');
  }
  // Outside a project, and under a project that does not exist, an error has no project row.
  for (const path of ["/p/no-such-project", "/p/no-such-project/code"]) {
    const { status, html } = await get(path);
    expect(status, path).not.toBe(200);
    expect(bar(html), path).not.toContain('aria-label="Project"');
    expect(bar(html), path).toContain("<summary>Project</summary>");
    expect(html, path).not.toContain("<!--shell:");
  }
});

// Gate finding 1: the parts of the bar that carry a count are marked for the
// live refresh (src/live.ts refreshShell), so a later copy brings them up to
// date; here the Decisions part a refresh would fetch carries the new count.
it("the bar's counts are marked for the live refresh, and a later copy carries the new count", async () => {
  const name = "shell-live";
  await project(name);
  for (const t of ["One", "Two"]) await L(name).newItem(t, ["src/**"], "owner");
  const cookie = await signIn(TOKEN, testEnv);
  const html = async (path: string) => (await worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie } }), testEnv)).text();
  const part = (page: string, key: string) => new RegExp(`<(span|div) data-shell="${key}">(.*?)</\\1>(?=</a>|</details>)`, "s").exec(bar(page))?.[2];
  const first = await html(`/p/${name}/flow`);
  expect(first).toContain('data-live-refresh="');
  for (const key of ["waiting", "projects", "tasks"]) expect(part(first, key), key).toBeDefined();
  const before = badge(first);
  await L(name).block("t1", "owner", "needs the owner");
  const later = await html(`/p/${name}/flow`);
  expect(Number(badge(later))).toBe(Number(before ?? 0) + 1);
  expect(part(later, "waiting")).not.toBe(part(first, "waiting"));
});
