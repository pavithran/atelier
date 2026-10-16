import { createRemoteJWKSet, jwtVerify } from "jose";

// Cloudflare Access in front of the owner's pages. An Access application on
// the zone asks whoever arrives to sign in before the request reaches the
// Worker, and vouches for the signed-in request with a JSON Web Token in the
// Cf-Access-Jwt-Assertion header, signed by the team's keys, which Cloudflare
// publishes at https://TEAM.cloudflareaccess.com/cdn-cgi/access/certs. The
// Worker checks that token itself on every owner route, /login among them
// (src/index.ts), the pattern cloudflare/cloudflare-os uses,
// so a request that reaches it without Access's vouching — an Access
// application that no longer covers the server, a forged header on a request
// that never passed the edge — is refused even when it carries a session
// cookie. A request it vouches for is the owner's sign-in, and starts the
// browser session with no token form (t534). The API routes are left alone:
// they take bearer tokens, and the CLI's requests do not pass Access.

// The Access configuration: CF_ACCESS_ISS is the team's URL as Access itself
// reports it in a token's issuer (https://TEAM.cloudflareaccess.com),
// CF_ACCESS_AUD the Access application's audience tag, both shown on the
// application's page in the Zero Trust dashboard, and CF_ACCESS_OWNER_EMAIL
// the one person the pages are for, as the identity provider reports the
// address. It stands in one of three states:
//   off     none of the three is set (or each is blank): the server stands as
//           it always has, with the token form and the session;
//   on      all three are set and usable: the Worker checks Access's
//           assertion on every developer route;
//   broken  some are set and the rest missing, or one is unusable (an issuer
//           that is not an https URL with a host and nothing after it, an
//           email with no "@"): the Worker refuses every route Access would
//           guard, with `problem`, rather than fall back to the token alone.
// Broken used to read as off, so a typo quietly dropped the extra factor
// (Astra's audit of 2026-10-13, finding 11). `problem` names the settings and
// what is wrong with each, never a value, for it is shown to whoever asks
// for a page.
export type AccessSettings = { issuer: string; audience: string; email: string };
export type AccessConfig =
  | { state: "off" }
  | { state: "on"; settings: AccessSettings }
  | { state: "broken"; problem: string };

// Whether the issuer, as kept (trimmed, trailing slashes removed), is exactly
// https://HOST: the raw string must equal the origin URL parsing gives it, so
// nothing the parser would normalise away (a dot segment, an empty fragment
// or query, a default port, upper case) passes, since the raw string is what
// a token's issuer is compared with. No port, no credentials: Access reports
// its team URL without either.
function teamIssuer(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && url.port === "" && !url.username && !url.password && value === url.origin;
  } catch {
    return false;
  }
}

export function accessConfig(env: Record<string, string | undefined>): AccessConfig {
  const given = env.CF_ACCESS_ISS?.trim() ?? "";
  const issuer = given.replace(/\/+$/, "");
  const audience = env.CF_ACCESS_AUD?.trim() ?? "";
  const email = env.CF_ACCESS_OWNER_EMAIL?.trim().toLowerCase() ?? "";
  if (!given && !audience && !email) return { state: "off" };
  const wrong: string[] = [];
  if (!given) wrong.push("CF_ACCESS_ISS is not set");
  else if (!teamIssuer(issuer)) wrong.push("CF_ACCESS_ISS is not the team's https URL, as Access reports it in a token's issuer");
  if (!audience) wrong.push("CF_ACCESS_AUD is not set");
  if (!email) wrong.push("CF_ACCESS_OWNER_EMAIL is not set");
  else if (!/^[^@\s]+@[^@\s]+$/.test(email)) wrong.push("CF_ACCESS_OWNER_EMAIL is not an email address");
  if (wrong.length) {
    return { state: "broken", problem: `${wrong.join("; ")}. Set all three Access settings (docs/setup.md), or none to run without Access.` };
  }
  return { state: "on", settings: { issuer, audience, email } };
}

// The usable settings, or null when Access is off or broken: what the
// factor an override rests on reads (ownerFactorOf in src/index.ts). The
// entry reads accessConfig itself, so broken refuses rather than turns off.
export function accessSettings(env: Record<string, string | undefined>): AccessSettings | null {
  const config = accessConfig(env);
  return config.state === "on" ? config.settings : null;
}

// The team's published keys, kept per issuer: jose's remote set caches what
// it fetched and asks again only for a token whose key id it does not hold,
// so a page behind Access costs no fetch once the keys are known.
const keysByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keysFor(issuer: string) {
  let keys = keysByIssuer.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keysByIssuer.set(issuer, keys);
  }
  return keys;
}

// Whether Access vouches for the request as the owner's own: the assertion
// header holds a token that verifies against the team's published keys, names
// the team as its issuer and this server's application as its audience, has
// not expired, and carries an email claim naming the configured owner — the
// way cloudflare-os's workshop backend identifies its owner — so a token
// Access gave a teammate, or for another application, does not vouch. False
// says only that Access did not vouch — no header, a foreign, stale or
// someone else's token, keys that could not be fetched — never which, and
// nothing is logged.
export async function accessVouches(req: Request, access: AccessSettings): Promise<boolean> {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, keysFor(access.issuer), { issuer: access.issuer, audience: access.audience });
    return typeof payload.email === "string" && payload.email.trim().toLowerCase() === access.email;
  } catch {
    return false;
  }
}
