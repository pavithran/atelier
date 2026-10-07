import { createRemoteJWKSet, jwtVerify } from "jose";

// Cloudflare Access in front of the owner's pages. An Access application on
// the zone asks whoever arrives to sign in before the request reaches the
// Worker, and vouches for the signed-in request with a JSON Web Token in the
// Cf-Access-Jwt-Assertion header, signed by the team's keys, which Cloudflare
// publishes at https://TEAM.cloudflareaccess.com/cdn-cgi/access/certs. The
// Worker checks that token itself on every owner route (src/index.ts), the
// pattern cloudflare/cloudflare-os uses, so a request that reaches it without
// Access's vouching — an Access application that no longer covers the server,
// a forged header on a request that never passed the edge — is refused even
// when it carries a session cookie. The API routes are left alone: they take
// bearer tokens, and the CLI's requests do not pass Access.

// The Access configuration: CF_ACCESS_ISS is the team's URL as Access itself
// reports it in a token's issuer (https://TEAM.cloudflareaccess.com), and
// CF_ACCESS_AUD the Access application's audience tag, both shown on the
// application's page in the Zero Trust dashboard. Null when either is unset,
// or the issuer is not an https URL: the server then stands as it always has,
// and the deploy notes in the README say how to set the pair.
export type AccessSettings = { issuer: string; audience: string };

export function accessSettings(env: Record<string, string | undefined>): AccessSettings | null {
  const issuer = env.CF_ACCESS_ISS?.trim().replace(/\/+$/, "");
  const audience = env.CF_ACCESS_AUD?.trim();
  if (!issuer || !audience || !issuer.startsWith("https://")) return null;
  return { issuer, audience };
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

// Whether Access vouches for the request: the assertion header holds a token
// that verifies against the team's published keys and names the team as its
// issuer and this server's application as its audience, and has not expired.
// False says only that Access did not vouch — no header, a foreign or stale
// token, keys that could not be fetched — never which, and nothing is logged.
export async function accessVouches(req: Request, access: AccessSettings): Promise<boolean> {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  try {
    await jwtVerify(token, keysFor(access.issuer), { issuer: access.issuer, audience: access.audience });
    return true;
  } catch {
    return false;
  }
}
