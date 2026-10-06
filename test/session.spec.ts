import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { sha256 } from "../src/tokens.ts";
import { signIn } from "./signin.ts";

// Browser sessions through the Worker's own fetch handler: sign-in issues a
// fresh random session each time, the server enforces its expiry, sign-out
// ends it, and the cookie the old code accepted, the hash of the owner token,
// opens nothing.

const TOKEN = "session-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));

const get = (path: string, cookie?: string, bindings = testEnv) =>
  worker.fetch(new Request(`https://atelier.test${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" }), bindings);
const logout = (cookie: string, origin?: string) =>
  worker.fetch(new Request("https://atelier.test/logout", { method: "POST", headers: { cookie, ...(origin ? { origin } : {}) }, redirect: "manual" }), testEnv);

it("each sign-in issues a fresh random session, never the hash of the token", async () => {
  const res = await worker.fetch(new Request("https://atelier.test/login", { method: "POST", body: new URLSearchParams({ token: TOKEN }) }), testEnv);
  expect(res.status).toBe(303);
  expect(res.headers.get("set-cookie")).toMatch(/^atelier=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/);
  const first = await signIn(TOKEN, testEnv), second = await signIn(TOKEN, testEnv);
  expect(first).not.toBe(second);
  const forged = `atelier=${await sha256(TOKEN)}`;
  expect([first, second]).not.toContain(forged);
  // Both sessions open the signed-in pages; the forged cookie and no cookie are sent to sign in.
  expect((await get("/decisions", first)).status).toBe(200);
  expect((await get("/decisions", second)).status).toBe(200);
  for (const cookie of [forged, undefined]) {
    const refused = await get("/projects", cookie);
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe("https://atelier.test/login");
  }
  // The index holds hashes only: the cookie's id is not in storage.
  const id = first.slice("atelier=".length);
  expect(await I().session(id)).toBeNull();
  expect(await I().session(await sha256(id))).toMatchObject({ hash: await sha256(id) });
});

it("a session past its expiry is refused by the server and dropped", async () => {
  const id = "e".repeat(64), hash = await sha256(id);
  const past = new Date(Date.now() - 1000).toISOString();
  await I().startSession({ hash, createdAt: past, expiresAt: past });
  const refused = await get("/projects", `atelier=${id}`);
  expect(refused.status).toBe(303);
  expect(refused.headers.get("location")).toBe("https://atelier.test/login");
  expect(await I().session(hash)).toBeNull();
  // A session still inside its expiry opens the page.
  const live = "f".repeat(64);
  await I().startSession({ hash: await sha256(live), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  expect((await get("/decisions", `atelier=${live}`)).status).toBe(200);
});

it("sign-out ends the session at once, from the same origin only", async () => {
  const cookie = await signIn(TOKEN, testEnv);
  const page = await get("/decisions", cookie);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<form method="post" action="/logout"');
  // Another origin cannot end the session.
  expect((await logout(cookie, "https://evil.test")).status).toBe(403);
  expect((await logout(cookie)).status).toBe(403);
  expect((await get("/decisions", cookie)).status).toBe(200);
  const out = await logout(cookie, "https://atelier.test");
  expect(out.status).toBe(303);
  expect(out.headers.get("location")).toBe("/login");
  expect(out.headers.get("set-cookie")).toBe("atelier=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  const after = await get("/projects", cookie);
  expect(after.status).toBe(303);
  expect(after.headers.get("location")).toBe("https://atelier.test/login");
  // Signing out without a session is harmless, and the sign-in page itself offers no sign-out.
  expect((await logout("", "https://atelier.test")).status).toBe(303);
  expect(await (await get("/login")).text()).not.toContain('action="/logout"');
});

it("a Worker without ATELIER_TOKEN refuses sign-in and every session", async () => {
  const cookie = await signIn(TOKEN, testEnv);
  const bare = { ...env, ATELIER_TOKEN: undefined } as unknown as typeof env;
  const res = await worker.fetch(new Request("https://atelier.test/login", { method: "POST", body: new URLSearchParams({ token: TOKEN }) }), bare);
  expect(res.status).toBe(401);
  expect(res.headers.get("set-cookie")).toBeNull();
  expect((await get("/projects", cookie, bare)).status).toBe(303);
});
