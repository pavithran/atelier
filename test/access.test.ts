import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { accessConfig, accessSettings, accessVouches, type AccessSettings } from "../src/access.ts";

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
  const good = { issuer: "https://t.access-test", audience: AUD, email: OWNER };
  const full = { CF_ACCESS_ISS: good.issuer, CF_ACCESS_AUD: good.audience, CF_ACCESS_OWNER_EMAIL: OWNER };
  assert.deepEqual(
    accessSettings({ CF_ACCESS_ISS: ` ${good.issuer}/ `, CF_ACCESS_AUD: ` ${good.audience}`, CF_ACCESS_OWNER_EMAIL: ` ${OWNER.replace("owner", "Owner")} ` }),
    { issuer: good.issuer, audience: good.audience, email: OWNER },
  );
  assert.deepEqual(accessConfig(full), { state: "on", settings: good });
  // Nothing set at all, or only blanks, is a server without Access, as always.
  assert.deepEqual(accessConfig({}), { state: "off" });
  assert.deepEqual(accessConfig({ CF_ACCESS_ISS: " ", CF_ACCESS_AUD: "", CF_ACCESS_OWNER_EMAIL: undefined }), { state: "off" });
  assert.equal(accessSettings({}), null);
});

test("Access set in part, or with a value it cannot use, is broken, naming what is wrong and never a value", () => {
  // Astra's audit of 2026-10-13, finding 11: a partial or unusable Access
  // configuration read as no Access at all, so the developer's pages fell
  // back to the token and the session without the extra factor. It is now
  // a broken configuration, which the Worker refuses the pages under.
  const iss = "https://t.access-test";
  const cases: [Record<string, string>, RegExp[]][] = [
    [{ CF_ACCESS_ISS: iss, CF_ACCESS_AUD: AUD }, [/CF_ACCESS_OWNER_EMAIL is not set/]],
    [{ CF_ACCESS_ISS: iss, CF_ACCESS_OWNER_EMAIL: OWNER }, [/CF_ACCESS_AUD is not set/]],
    [{ CF_ACCESS_AUD: AUD, CF_ACCESS_OWNER_EMAIL: OWNER }, [/CF_ACCESS_ISS is not set/]],
    [{ CF_ACCESS_AUD: AUD }, [/CF_ACCESS_ISS is not set/, /CF_ACCESS_OWNER_EMAIL is not set/]],
    [{ CF_ACCESS_ISS: " ", CF_ACCESS_AUD: AUD, CF_ACCESS_OWNER_EMAIL: OWNER }, [/CF_ACCESS_ISS is not set/]],
    // A plain-word team, an http URL or a scheme alone is not an issuer Access reports.
    ...["t.access-test", "http://t.access-test", "https://", "https://t.access-test/path"].map((bad) =>
      [{ CF_ACCESS_ISS: bad, CF_ACCESS_AUD: AUD, CF_ACCESS_OWNER_EMAIL: OWNER }, [/CF_ACCESS_ISS is not the team's https URL/]] as [Record<string, string>, RegExp[]]),
    [{ CF_ACCESS_ISS: iss, CF_ACCESS_AUD: AUD, CF_ACCESS_OWNER_EMAIL: "owner" }, [/CF_ACCESS_OWNER_EMAIL is not an email address/]],
  ];
  for (const [env, problems] of cases) {
    const config = accessConfig(env);
    assert.equal(config.state, "broken", JSON.stringify(env));
    assert.equal(accessSettings(env), null);
    if (config.state !== "broken") continue;
    for (const problem of problems) assert.match(config.problem, problem);
    // The message is shown to whoever asks for a page: no value set is in it.
    for (const value of Object.values(env)) if (value.trim().length > 6) assert.ok(!config.problem.includes(value.trim()), value);
    assert.ok(!config.problem.includes(AUD) && !config.problem.includes(OWNER), config.problem);
  }
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
