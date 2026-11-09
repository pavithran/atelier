import { env } from "./support/workers.ts";
import { expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

// t559: the two Cloudflare Access refusals (401 with no assertion, 503 with
// broken settings) are drawn as signed-out pages, with no owner bar. Every
// other error page keeps the chrome it has on main. All through the Worker's
// own fetch handler.

const TOKEN = "refusal-chrome-token";
const ACCESS = { CF_ACCESS_ISS: "https://atelier-test.cloudflareaccess.com", CF_ACCESS_AUD: "47c6b47feb5b3f0dcbe5f3f7f9e1d2c8", CF_ACCESS_OWNER_EMAIL: "owner@example.com" };
const on = { ...env, ATELIER_TOKEN: TOKEN, ...ACCESS } as typeof env;
const broken = { ...env, ATELIER_TOKEN: TOKEN, CF_ACCESS_ISS: ACCESS.CF_ACCESS_ISS } as typeof env;
const plain = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

// A registered project with one task, so a form can name a task and an unknown verb.
async function project(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}

const get = (b: typeof env, path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://atelier.test${path}`, { redirect: "manual", headers }), b);

const OWNER_CHROME = [/href="\/decisions"/, /href="\/projects/, /class="[^"]*switcher/, /Sign out/, /action="\/logout"/, /<header class="owner-bar"/];
const noOwnerChrome = (html: string) => { for (const re of OWNER_CHROME) expect(html, String(re)).not.toMatch(re); };

const MESSAGE_401 = "This page is behind Cloudflare Access, whose sign-in this request did not carry. Sign in at the Access prompt and retry.";

it("the Access 401 draws no owner bar, keeps its status and message, and has no Go back button", async () => {
  const res = await get(on, "/home");
  expect(res.status).toBe(401);
  const html = await res.text();
  noOwnerChrome(html);
  expect(html).toContain(MESSAGE_401);
  expect(html).not.toContain("Go back");
});

it("the broken-Access 503 draws no owner bar, keeps its status and message, and has no Go back button", async () => {
  const res = await get(broken, "/home");
  expect(res.status).toBe(503);
  const html = await res.text();
  noOwnerChrome(html);
  expect(html).toContain("This server&#39;s Cloudflare Access settings are incomplete or unusable, so the developer&#39;s pages are refused until they are fixed: ");
  expect(html).not.toContain("Go back");
});

async function unknownAction(cookie: string) {
  const L = await project("refusal-chrome");
  const made = await L.newItem("A task", [], "owner", {});
  return worker.fetch(new Request(`https://atelier.test/ui/refusal-chrome/${made.id}/no-such-verb`, {
    method: "POST", headers: { cookie, origin: "https://atelier.test" }, body: new URLSearchParams({}), redirect: "manual",
  }), plain);
}

it("an error page for a signed-in owner still draws the owner bar with Sign out", async () => {
  const res = await unknownAction(await signIn(TOKEN, plain));
  expect(res.status).toBe(400);
  const html = await res.text();
  expect(html).toContain("Unknown action.");
  expect(html).toContain("Sign out");
  expect(html).toContain('href="/projects"');
  expect(html).toContain("Go back");
});

it("/how without an Access assertion still answers 200 with the public page", async () => {
  const res = await get(on, "/how");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('class="public-bar"');
});

async function sha(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// SHA-256 of the pages as main draws them (49973c88, re-taken at t585 for the new bar and device theme), so any change to their
// status, message or chrome shows: a signed-in 404, a signed-out 404 (which
// main answers with a redirect to the sign-in page) and a signed-in 400.
it("other error pages are byte for byte as on main", async () => {
  const cookie = await signIn(TOKEN, plain);
  const seen: Record<string, string> = {};
  const notFoundIn = await get(plain, "/p/nothing-here", { cookie });
  seen["404 in"] = `${notFoundIn.status} ${await sha(await notFoundIn.text())}`;
  const notFoundOut = await get(plain, "/p/nothing-here");
  seen["404 out"] = `${notFoundOut.status} ${notFoundOut.headers.get("location")} ${await sha(await notFoundOut.text())}`;
  const bad = await unknownAction(cookie);
  seen["400 in"] = `${bad.status} ${await sha(await bad.text())}`;
  expect(seen).toEqual({
    "404 in": "404 3e8b28264ad41bdb05b04cc9c1fdd0d1bfa9e08fd1933b6b00d699c681c710c6",
    "404 out": "303 https://atelier.test/login e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "400 in": "400 db6a229150cc29f545a8025a2dc3570f12ab188edfec5abc0bb64e57d1db62ed",
  });
});
