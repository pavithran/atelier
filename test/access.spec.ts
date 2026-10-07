import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

// Cloudflare Access in front of the owner's pages (t270), driven through the
// Worker's own fetch handler. With the team and audience named, every owner
// route needs an assertion Access signed — verified against the keys the
// team publishes, which jose fetches, so global fetch serves them — while
// the public pages, the sign-out form and the /api routes, whose bearer
// tokens never pass Access, stand as before.

const ISS = "https://atelier-test.cloudflareaccess.com";
const AUD = "47c6b47feb5b3f0dcbe5f3f7f9e1d2c8";
const TOKEN = "access-test-token";
const bindings = { ...env, ATELIER_TOKEN: TOKEN, CF_ACCESS_ISS: ISS, CF_ACCESS_AUD: AUD } as typeof env;

const pair = await generateKeyPair("RS256");
const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "atelier-test", alg: "RS256" }] };

async function assertion(expires = "5m") {
  return new SignJWT({})
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

it("owner pages are refused without an assertion Access signed, with or without a session", async () => {
  const send = serveKeys();
  try {
    const cookie = await signIn(TOKEN, bindings);
    for (const headers of [{}, { cookie }] as Record<string, string>[]) {
      const page = await get("/", headers);
      expect(page.status).toBe(401);
      expect(await page.text()).toContain("behind Cloudflare Access");
    }
    expect((await get("/", { "cf-access-jwt-assertion": "not-a-jwt", cookie })).status).toBe(401);
    expect((await get("/models", { cookie })).status).toBe(401);
    // An assertion Access did not sign for this hour does not pass either.
    expect((await get("/", { cookie, "cf-access-jwt-assertion": await assertion("-1m") })).status).toBe(401);
  } finally { send.mockRestore(); }
});

it("a signed assertion lets the owner's pages through, and the session still decides what they show", async () => {
  const send = serveKeys();
  try {
    const jwt = await assertion();
    // Behind Access but not signed in: the front door still asks for the token.
    const door = await get("/", { "cf-access-jwt-assertion": jwt });
    expect(door.status).toBe(303);
    expect(door.headers.get("location")).toBe("https://atelier.test/login");
    const cookie = await signIn(TOKEN, bindings);
    const home = await get("/", { cookie, "cf-access-jwt-assertion": jwt });
    expect(home.status).toBe(200);
    const models = await get("/models", { cookie, "cf-access-jwt-assertion": jwt });
    expect(models.status).toBe(200);
  } finally { send.mockRestore(); }
});

it("the public pages, the sign-out form and the API routes stand as before, with no assertion", async () => {
  const send = serveKeys();
  try {
    expect((await get("/how")).status).toBe(200);
    expect((await get("/login")).status).toBe(200);
    expect((await get("/live.js")).status).toBe(200);
    expect((await get("/showcase")).status).toBe(404);
    const out = await worker.fetch(new Request("https://atelier.test/logout", {
      method: "POST", headers: { origin: "https://atelier.test" }, redirect: "manual",
    }), bindings);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/login");
    expect((await get("/api/version")).status).toBe(200);
    // A bearer token reaches the API as the CLI does, never passing Access.
    const projects = await get("/api/projects", { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" });
    expect(projects.status).toBe(200);
    expect(await projects.json()).toEqual([]);
  } finally { send.mockRestore(); }
});

it("an unconfigured server leaves every page as it was", async () => {
  const plain = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
  const res = await worker.fetch(new Request("https://atelier.test/", { redirect: "manual" }), plain);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("https://atelier.test/login");
});
