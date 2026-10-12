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
      expect(row(html, "Project"), path).toMatch(/>Tasks \(2\)</);
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
