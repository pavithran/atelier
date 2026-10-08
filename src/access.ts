import { createRemoteJWKSet, jwtVerify } from "jose";

// Cloudflare Access in front of the owner's pages. An Access application on
// the zone asks whoever arrives to sign in before the request reaches the
// Worker, and vouches for the signed-in request with a JSON Web Token in the
// Cf-Access-Jwt-Assertion header, signed by the team's keys, which Cloudflare
// publishes at https://TEAM.cloudflareaccess.com/cdn-cgi/access/certs. The
// Worker checks that token itself on every owner route, /login and its token
// form among them (src/index.ts), the pattern cloudflare/cloudflare-os uses,
// so a request that reaches it without Access's vouching — an Access
// application that no longer covers the server, a forged header on a request
// that never passed the edge — is refused even when it carries a session
// cookie. The API routes are left alone: they take bearer tokens, and the
// CLI's requests do not pass Access.

// The Access configuration: CF_ACCESS_ISS is the team's URL as Access itself
// reports it in a token's issuer (https://TEAM.cloudflareaccess.com),
// CF_ACCESS_AUD the Access application's audience tag, both shown on the
// application's page in the Zero Trust dashboard, and CF_ACCESS_OWNER_EMAIL
// the one person the pages are for, as the identity provider reports the
// address. Null when any of the three is unset, or the issuer is not an https
// URL: the server then stands as it always has, and the deploy notes in the
// README say how to set the triple. A value that is set but unusable — an
// http or bare-team-name issuer, a missing piece — is warned of once, so a
// typo cannot quietly leave the pages unguarded.
export type AccessSettings = { issuer: string; audience: string; email: string };

let warnedOff = false;

export function accessSettings(env: Record<string, string | undefined>): AccessSettings | null {
  const issuer = env.CF_ACCESS_ISS?.trim().replace(/\/+$/, "");
  const audience = env.CF_ACCESS_AUD?.trim();
  const email = env.CF_ACCESS_OWNER_EMAIL?.trim().toLowerCase();
  const settings = issuer?.startsWith("https://") && audience && email ? { issuer, audience, email } : null;
  if (!settings && (issuer || audience || email) && !warnedOff) {
    warnedOff = true;
    console.warn("atelier: the Access settings are set but unusable — CF_ACCESS_ISS must be the team's https URL, and CF_ACCESS_ISS, CF_ACCESS_AUD and CF_ACCESS_OWNER_EMAIL are all needed — so the Access check is off and the owner's pages stand without it.");
  }
  return settings;
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
