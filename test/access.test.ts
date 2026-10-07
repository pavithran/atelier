import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { accessSettings, accessVouches, type AccessSettings } from "../src/access.ts";

// Cloudflare Access vouches for a request with a JWT in
// Cf-Access-Jwt-Assertion, signed by the team's published keys. These tests
// pin how the settings are read, and everything the Worker refuses beside a
// token Access did not sign for the configured owner: a foreign or stale
// token, another audience, a teammate's email, keys that cannot be fetched.
// jose fetches the keys itself, so global fetch is stubbed to serve them, and
// each test's issuer is its own, for the module keeps one key set per issuer.

const AUD = "47c6b47feb5b3f0dcbe5f3f7f9e1d2c8";
const OWNER = "owner@example.com";

async function team(n: number) {
  const issuer = `https://t${n}.access-test`;
  const pair = await generateKeyPair("RS256");
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "atelier-test", alg: "RS256" }] };
  return {
    issuer, pair, jwks,
    settings: { issuer, audience: AUD, email: OWNER } as AccessSettings,
  };
}

// Serves `jwks` at the issuer's certs endpoint, recording what was asked.
function serveKeys(jwks: unknown, status = 200) {
  const asked: string[] = [];
  const stub = async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(status === 200 ? JSON.stringify(jwks) : "broken", {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { asked, stub };
}

async function assertion(pair: CryptoKey, issuer: string, audience: string, expires = "5m", email: string = OWNER) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "atelier-test" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(pair.privateKey);
}

test("the Access settings need the issuer, the audience and the owner's email, the issuer an https team URL", () => {
  // A setting that is present but unusable warns once, so a typo cannot
  // quietly turn the check off; nothing set at all stays silent.
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { said.push(args.join(" ")); };
  try {
    const good = { issuer: "https://t.access-test", audience: AUD, email: OWNER };
    assert.equal(accessSettings({ CF_ACCESS_ISS: good.issuer, CF_ACCESS_AUD: good.audience }), null);
    assert.equal(accessSettings({ CF_ACCESS_ISS: good.issuer, CF_ACCESS_OWNER_EMAIL: OWNER }), null);
    assert.equal(accessSettings({ CF_ACCESS_AUD: good.audience, CF_ACCESS_OWNER_EMAIL: OWNER }), null);
    assert.equal(accessSettings({}), null);
    // A plain-word team or an http URL is not an issuer Access reports.
    for (const bad of ["t.access-test", "http://t.access-test", "https://", " "]) {
      assert.equal(accessSettings({ CF_ACCESS_ISS: bad, CF_ACCESS_AUD: good.audience, CF_ACCESS_OWNER_EMAIL: OWNER }), null, bad);
    }
    assert.deepEqual(
      accessSettings({ CF_ACCESS_ISS: ` ${good.issuer}/ `, CF_ACCESS_AUD: ` ${good.audience}`, CF_ACCESS_OWNER_EMAIL: ` ${OWNER.replace("owner", "Owner")} ` }),
      { issuer: good.issuer, audience: good.audience, email: OWNER },
    );
    assert.equal(said.length, 1);
    assert.match(said[0], /the Access check is off/);
  } finally { console.warn = warn; }
});

test("a token Access signed, for this team, application and owner, vouches for the request", async () => {
  const t = await team(1);
  const served = serveKeys(t.jwks);
  const token = await assertion(t.pair, t.issuer, AUD);
  const restore = globalThis.fetch;
  globalThis.fetch = served.stub as typeof fetch;
  try {
    assert.equal(await accessVouches(new Request("https://atelier.test/", { headers: { "cf-access-jwt-assertion": token } }), t.settings), true);
    assert.deepEqual(served.asked, [`${t.issuer}/cdn-cgi/access/certs`]);
  } finally { globalThis.fetch = restore; }
});

test("a request without an assertion is not vouched for, and fetches nothing", async () => {
  const t = await team(2);
  const served = serveKeys(t.jwks);
  const restore = globalThis.fetch;
  globalThis.fetch = served.stub as typeof fetch;
  try {
    assert.equal(await accessVouches(new Request("https://atelier.test/"), t.settings), false);
    assert.equal(await accessVouches(new Request("https://atelier.test/", { headers: { "cf-access-jwt-assertion": "" } }), t.settings), false);
    assert.deepEqual(served.asked, []);
  } finally { globalThis.fetch = restore; }
});

test("a token for another application, team, hour or signer does not vouch", async () => {
  const t = await team(3);
  const foreign = await generateKeyPair("RS256");
  const tokens = {
    audience: await assertion(t.pair, t.issuer, "0000000000000000000000000000000a"),
    issuer: await assertion(t.pair, "https://other.access-test", AUD),
    expired: await assertion(t.pair, t.issuer, AUD, "-1m"),
    foreign: await new SignJWT({ email: OWNER }).setProtectedHeader({ alg: "RS256", kid: "atelier-test" }).setIssuer(t.issuer).setAudience(AUD).setExpirationTime("5m").sign(foreign.privateKey),
    garbage: "not.a.jwt",
  };
  const restore = globalThis.fetch;
  globalThis.fetch = serveKeys(t.jwks).stub as typeof fetch;
  try {
    for (const [name, token] of Object.entries(tokens)) {
      assert.equal(await accessVouches(new Request("https://atelier.test/", { headers: { "cf-access-jwt-assertion": token } }), t.settings), false, name);
    }
  } finally { globalThis.fetch = restore; }
});

test("a token naming anyone but the configured owner does not vouch", async () => {
  const t = await team(5);
  const tokens = {
    teammate: await assertion(t.pair, t.issuer, AUD, "5m", "someone.else@example.com"),
    noEmail: await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "atelier-test" }).setIssuer(t.issuer).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(t.pair.privateKey),
    emptyEmail: await assertion(t.pair, t.issuer, AUD, "5m", ""),
  };
  // The address itself is matched without regard to case or padding space,
  // as email addresses are compared.
  const cased = await assertion(t.pair, t.issuer, AUD, "5m", "Owner@Example.com");
  const restore = globalThis.fetch;
  globalThis.fetch = serveKeys(t.jwks).stub as typeof fetch;
  try {
    for (const [name, token] of Object.entries(tokens)) {
      assert.equal(await accessVouches(new Request("https://atelier.test/", { headers: { "cf-access-jwt-assertion": token } }), t.settings), false, name);
    }
    assert.equal(await accessVouches(new Request("https://atelier.test/", { headers: { "cf-access-jwt-assertion": cased } }), t.settings), true);
  } finally { globalThis.fetch = restore; }
});

test("keys that cannot be fetched leave the request unvouched for", async () => {
  const t = await team(4);
  const token = await assertion(t.pair, t.issuer, AUD);
  for (const status of [404, 500, 503]) {
    const restore = globalThis.fetch;
    globalThis.fetch = serveKeys(t.jwks, status).stub as typeof fetch;
    try {
      assert.equal(await accessVouches(new Request("https://atelier.test/", { headers: { "cf-access-jwt-assertion": token } }), t.settings), false, String(status));
    } finally { globalThis.fetch = restore; }
  }
});
