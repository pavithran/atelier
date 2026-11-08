import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

// GET /p/NAME/process, the Process tab's production entry point (t558),
// through the Worker's own fetch handler as a signed-in developer.

const TOKEN = "process-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] as string[] }, createdAt: new Date().toISOString() };
  await env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`)).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
}
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/\s+/g, " ");

it("criterion 1: the developer gets 200 and a Process tab beside Flow, and every page of the area links to it", async () => {
  const name = "process-area";
  await project(name);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.newItem("Process work", ["src/**"], "owner");
  await L.claim("t1", "codex/gpt-6");
  const signedIn = await signIn(TOKEN, testEnv);
  const get = (path: string) => worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie: signedIn }, redirect: "manual" }), testEnv);

  const res = await get(`/p/${name}/process`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(`<a href="/p/${name}/flow">Flow</a><a href="/p/${name}/process" aria-current="page">Process</a>`);
  expect(html).toContain(`href="/p/${name}/flow" aria-current="page">Activity`);
  expect(html).toContain("<svg class=\"desk\"");
  expect(html).toContain("var(--observed)");

  for (const path of ["", "/tasks", "/flow", "/plans", "/ship", "/settings", "/showcase"]) {
    const page = await get(`/p/${name}${path}`);
    expect(page.status, path).toBe(200);
    expect(await page.text(), path || "overview").toContain(`href="/p/${name}/process"`);
  }
});

it("criterion 7 and 8: unknown values fall back, and a project with no finished work says 'no tasks'", async () => {
  const name = "process-empty";
  await project(name);
  const signedIn = await signIn(TOKEN, testEnv);
  const get = (path: string) => worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie: signedIn }, redirect: "manual" }), testEnv);
  const fallback = await (await get(`/p/${name}/process?since=90d&stat=mean`)).text();
  const plain = await (await get(`/p/${name}/process`)).text();
  expect(fallback).toBe(plain);
  expect(plain).toContain('<a href="/p/process-empty/process?since=7d&amp;stat=median" aria-current="true">7 days</a>');
  expect(plain).toContain('<a href="/p/process-empty/process?since=7d&amp;stat=median" aria-current="true">Median</a>');
  expect(text(plain)).toContain("no tasks");
  expect(plain).not.toMatch(/NaN|undefined|Infinity/);
  const month = await (await get(`/p/${name}/process?since=30d&stat=p90`)).text();
  expect(month).toContain('aria-current="true">30 days</a>');
  expect(month).toContain('aria-current="true">p90</a>');
  expect(month).not.toContain("<script");
});

it("a page without the developer's session is not served", async () => {
  const name = "process-private";
  await project(name);
  const res = await worker.fetch(new Request(`https://atelier.test/p/${name}/process`, { redirect: "manual" }), testEnv);
  expect(res.status).not.toBe(200);
  expect(await res.text()).not.toContain("Filed to deployed");
});
