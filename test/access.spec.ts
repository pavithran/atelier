import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

// Cloudflare Access in front of the owner's pages (t270), driven through the
// Worker's own fetch handler. With the team, audience and owner's email named,
// every owner route needs an assertion Access signed for the owner — verified
// against the keys the team publishes, which jose fetches, so global fetch
// serves them — while the public pages, the sign-out form and the /api routes,
// whose bearer tokens never pass Access, stand as before. /login is behind
// the check with its token form, so the server token can only be tried by
// whoever Access vouches for as the owner.

const ISS = "https://atelier-test.cloudflareaccess.com";
const AUD = "47c6b47feb5b3f0dcbe5f3f7f9e1d2c8";
const OWNER = "owner@example.com";
const TOKEN = "access-test-token";
const bindings = { ...env, ATELIER_TOKEN: TOKEN, CF_ACCESS_ISS: ISS, CF_ACCESS_AUD: AUD, CF_ACCESS_OWNER_EMAIL: OWNER } as typeof env;

const pair = await generateKeyPair("RS256");
const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "atelier-test", alg: "RS256" }] };

async function assertion(expires = "5m", email = OWNER) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "atelier-test" })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(pair.privateKey);
}

// Serves the team's keys wherever jose looks for them.
function serveKeys() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) =>
    new Response(String(input) === `${ISS}/cdn-cgi/access/certs` ? JSON.stringify(jwks) : "{}", {
      status: String(input) === `${ISS}/cdn-cgi/access/certs` ? 200 : 404,
      headers: { "content-type": "application/json" },
    }));
}

const get = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://atelier.test${path}`, { redirect: "manual", headers }), bindings);

it("owner pages are refused without an assertion Access signed for the owner, with or without a session", async () => {
  const send = serveKeys();
  try {
    const cookie = await signIn(TOKEN, bindings, { "cf-access-jwt-assertion": await assertion() });
    for (const headers of [{}, { cookie }] as Record<string, string>[]) {
      const page = await get("/home", headers);
      expect(page.status).toBe(401);
      expect(await page.text()).toContain("behind Cloudflare Access");
    }
    expect((await get("/home", { "cf-access-jwt-assertion": "not-a-jwt", cookie })).status).toBe(401);
    expect((await get("/models", { cookie })).status).toBe(401);
    // /login is behind the check too, form and token form: the server token
    // cannot be tried, let alone guessed, without Access's sign-in first.
    const login = await get("/login");
    expect(login.status).toBe(401);
    const guess = await worker.fetch(new Request("https://atelier.test/login", {
      method: "POST", body: new URLSearchParams({ token: "a-wrong-guess" }), redirect: "manual",
    }), bindings);
    expect(guess.status).toBe(401);
    expect(await guess.text()).toContain("behind Cloudflare Access");
    // A teammate's assertion — a token Access signed, for someone else —
    // vouches for no owner route either.
    const teammate = await assertion("5m", "someone.else@example.com");
    expect((await get("/home", { cookie, "cf-access-jwt-assertion": teammate })).status).toBe(401);
    expect((await get("/login", { "cf-access-jwt-assertion": teammate })).status).toBe(401);
    // An assertion Access did not sign for this hour does not pass either.
    expect((await get("/home", { cookie, "cf-access-jwt-assertion": await assertion("-1m") })).status).toBe(401);
  } finally { send.mockRestore(); }
});

it("a signed assertion lets the owner's pages through, and the session still decides what they show", async () => {
  const send = serveKeys();
  try {
    const jwt = await assertion();
    // Behind Access but not signed in: Home still asks for the token.
    const door = await get("/home", { "cf-access-jwt-assertion": jwt });
    expect(door.status).toBe(303);
    expect(door.headers.get("location")).toBe("https://atelier.test/login");
    // /login serves behind Access: Access first, the server token after.
    const form = await get("/login", { "cf-access-jwt-assertion": jwt });
    expect(form.status).toBe(200);
    const wrong = await worker.fetch(new Request("https://atelier.test/login", {
      method: "POST", body: new URLSearchParams({ token: "no" }), headers: { "cf-access-jwt-assertion": jwt }, redirect: "manual",
    }), bindings);
    expect(wrong.status).toBe(401);
    // The sign-in lands on Home, at /home.
    const right = await worker.fetch(new Request("https://atelier.test/login", {
      method: "POST", body: new URLSearchParams({ token: TOKEN }), headers: { "cf-access-jwt-assertion": jwt }, redirect: "manual",
    }), bindings);
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/home");
    const cookie = await signIn(TOKEN, bindings, { "cf-access-jwt-assertion": jwt });
    const home = await get("/home", { cookie, "cf-access-jwt-assertion": jwt });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("<title>Home · Atelier</title>");
    const models = await get("/models", { cookie, "cf-access-jwt-assertion": jwt });
    expect(models.status).toBe(200);
  } finally { send.mockRestore(); }
});

it("the public pages, the sign-out form and the API routes stand as before, with no assertion", async () => {
  const send = serveKeys();
  try {
    expect((await get("/how")).status).toBe(200);
    expect((await get("/live.js")).status).toBe(200);
    expect((await get("/showcase")).status).toBe(404);
    const out = await worker.fetch(new Request("https://atelier.test/logout", {
      method: "POST", headers: { origin: "https://atelier.test" }, redirect: "manual",
    }), bindings);
    expect(out.status).toBe(303);
    // Signed out, the browser goes to the public front.
    expect(out.headers.get("location")).toBe("/");
    expect((await get("/api/version")).status).toBe(200);
    // A bearer token reaches the API as the CLI does, never passing Access.
    const projects = await get("/api/projects", { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" });
    expect(projects.status).toBe(200);
    expect(await projects.json()).toEqual([]);
  } finally { send.mockRestore(); }
});

it("an unconfigured server sends a visitor to sign in for Home, and signing in lands there", async () => {
  const plain = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
  const res = await worker.fetch(new Request("https://atelier.test/home", { redirect: "manual" }), plain);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("https://atelier.test/login");
  const login = await worker.fetch(new Request("https://atelier.test/login", { method: "POST", body: new URLSearchParams({ token: TOKEN }), redirect: "manual" }), plain);
  expect(login.status).toBe(303);
  expect(login.headers.get("location")).toBe("/home");
});

// The front door (t314): the whole domain is public at the edge, so the
// Worker's own check is the guard. / is the showcase for anyone, with no
// assertion and no session; every owner route, each method its forms use,
// is refused without Access's vouching, even with a session cookie.
it("with Access on, / is the public showcase to anyone, and every owner route still needs Access", async () => {
  const send = serveKeys();
  try {
    const record = { name: "front-door", repo: "front-door", title: "Front door secret title", policy: { checks: [], protected: [] }, createdAt: "2026-10-08T00:00:00.000Z" };
    const L = env.LEDGER.get(env.LEDGER.idFromName("project:front-door"));
    await L.setProject(record, "owner");
    await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
    await L.newItem("Front door secret task", [], "owner");
    await L.claim("t1", "codex/gpt-6");
    const shown = { ...bindings, SHOWCASE: "front-door:anonymous", OWNER_NAME: "Front Owner" } as typeof env;
    const at = (path: string, method = "GET", headers: Record<string, string> = {}) =>
      worker.fetch(new Request(`https://atelier.test${path}`, { method, headers, redirect: "manual" }), shown);
    for (const method of ["GET", "HEAD"]) {
      const front = await at("/", method);
      expect(front.status, method).toBe(200);
    }
    const page = await (await at("/")).text();
    expect(page).toContain("<title>Atelier · public showcase</title>");
    expect(page).toContain('<a href="/login">Sign in</a>');
    for (const secret of ["Front door secret title", "Front door secret task", "front-door", 'class="rail"', 'href="/home"']) expect(page).not.toContain(secret);
    expect((await at("/showcase")).status).toBe(200);
    const cookie = await signIn(TOKEN, shown, { "cf-access-jwt-assertion": await assertion() });
    const form = { origin: "https://atelier.test", cookie };
    const owner: [string, string][] = [
      ["GET", "/home"], ["GET", "/login"], ["POST", "/login"], ["GET", "/decisions"], ["GET", "/studio"],
      ["GET", "/flow"], ["GET", "/history"], ["GET", "/models"], ["POST", "/models/add"], ["GET", "/usage"],
      ["GET", "/projects"], ["POST", "/projects/showcase"], ["POST", "/ui/front-door/t1/accept"],
      ["GET", "/p/front-door"], ["GET", "/p/front-door/tasks"], ["GET", "/p/front-door/t1"], ["GET", "/p/front-door/code"], ["POST", "/"],
    ];
    for (const [method, path] of owner) {
      const res = await at(path, method, form);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.text(), `${method} ${path}`).not.toContain("Front door secret");
    }
  } finally { send.mockRestore(); }
});
