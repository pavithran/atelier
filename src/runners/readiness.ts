// What a runner reports about itself with each ask and heartbeat (t234): per
// harness whether it can take a job, and per credential when it expires. The
// runner's self-check (checkReady in cli/runner.mjs) makes the report; the
// server keeps it on the runner's offer, and `atelier status` and `atelier
// unwrap` print it. A credential is named, never valued.

// A report older than this shows stale: the self-check runs every ten
// minutes, so two missed rounds and a margin mean the runner stopped checking.
export const READINESS_STALE_MS = 25 * 60_000;

// A credential expiring within this many days is warned about; it is still
// offered while it is valid.
export const TOKEN_WARN_DAYS = 7;

export type HarnessState = "ready" | "signed-out" | "unknown";
export type TokenState = "ok" | "expiring" | "expired" | "unknown" | "unreadable" | "developers";

export interface HarnessReadiness {
  harness: string;
  state: HarnessState;
  probedAt: string;
  recovery: string | null;
}

export interface TokenReadiness {
  // "reviewer" for a model's agent token (name: the model), "claude" for the
  // Claude token file (name: "claude").
  kind: "reviewer" | "claude";
  name: string;
  state: TokenState;
  expiresAt: string | null;
  daysLeft: number | null;
  // What to do, when the state is not ok.
  recovery: string | null;
}

export interface Readiness {
  harnesses: HarnessReadiness[];
  tokens: TokenReadiness[];
}

const HARNESS_STATES: readonly string[] = ["ready", "signed-out", "unknown"];
const TOKEN_STATES: readonly string[] = ["ok", "expiring", "expired", "unknown", "unreadable", "developers"];
const MAX_ENTRIES = 16;
const text = (value: unknown, max: number): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const instant = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// The report as the server keeps it: only the known fields, each bounded, so
// a runner cannot store more than a status line shows. Returns null when the
// body carries no usable report.
export function parseReadiness(raw: unknown): Readiness | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { harnesses?: unknown; tokens?: unknown };
  const harnesses: HarnessReadiness[] = [];
  for (const h of (Array.isArray(r.harnesses) ? r.harnesses : []).slice(0, MAX_ENTRIES)) {
    const x = (h ?? {}) as Record<string, unknown>;
    const harness = text(x.harness, 64), probedAt = instant(x.probedAt);
    if (!harness || !probedAt || typeof x.state !== "string" || !HARNESS_STATES.includes(x.state)) continue;
    harnesses.push({ harness, state: x.state as HarnessState, probedAt, recovery: text(x.recovery, 300) });
  }
  const tokens: TokenReadiness[] = [];
  for (const t of (Array.isArray(r.tokens) ? r.tokens : []).slice(0, MAX_ENTRIES)) {
    const x = (t ?? {}) as Record<string, unknown>;
    const name = text(x.name, 64);
    if (!name || (x.kind !== "reviewer" && x.kind !== "claude") || typeof x.state !== "string" || !TOKEN_STATES.includes(x.state)) continue;
    tokens.push({ kind: x.kind, name, state: x.state as TokenState, expiresAt: instant(x.expiresAt), daysLeft: typeof x.daysLeft === "number" && Number.isFinite(x.daysLeft) ? Math.trunc(x.daysLeft) : null, recovery: text(x.recovery, 300) });
  }
  return harnesses.length || tokens.length ? { harnesses, tokens } : null;
}

// Whether a probe made at `probedAt` is too old to trust at `now`.
export function isStaleProbe(probedAt: string, now = Date.now()): boolean {
  const at = Date.parse(probedAt);
  return !Number.isFinite(at) || now - at > READINESS_STALE_MS;
}

// A credential's state from its expiry (an ISO instant, or null when the
// credential carries none): unknown without an expiry, expired once past,
// expiring within TOKEN_WARN_DAYS, else ok. `daysLeft` counts whole days
// rounded down and is negative once past.
export function tokenExpiry(expiresAt: string | null, now = Date.now()): { state: "ok" | "expiring" | "expired" | "unknown"; daysLeft: number | null } {
  const at = expiresAt === null ? NaN : Date.parse(expiresAt);
  if (!Number.isFinite(at)) return { state: "unknown", daysLeft: null };
  const daysLeft = Math.floor((at - now) / 86_400_000);
  if (at <= now) return { state: "expired", daysLeft };
  return { state: at - now <= TOKEN_WARN_DAYS * 86_400_000 ? "expiring" : "ok", daysLeft };
}

// The expiry a token's own metadata carries: the `exp` claim (seconds) of a
// token that is a JWT. An opaque token carries none, and gives null.
export function expiryFromToken(token: string): string | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    return typeof claims?.exp === "number" && Number.isFinite(claims.exp) ? new Date(claims.exp * 1000).toISOString() : null;
  } catch { return null; }
}

const minutes = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

// The lines `atelier status` and `atelier unwrap` print for a runner's
// report: machine, harness, state and probe time, stale past 25 minutes, and
// the recovery step when the harness is not ready; then each credential.
export function readinessLines(runner: string, readiness: Readiness | null | undefined, now = Date.now()): string[] {
  if (!readiness) return [];
  const lines: string[] = [];
  for (const h of readiness.harnesses) {
    const stale = isStaleProbe(h.probedAt, now);
    lines.push(`${runner}  ${h.harness}  ${stale ? "stale" : h.state}  probed ${minutes(now - Date.parse(h.probedAt))}${stale ? ` (last ${h.state})` : ""}${h.state !== "ready" && h.recovery ? `  ${h.recovery}` : ""}`);
  }
  for (const t of readiness.tokens) {
    const what = t.kind === "claude" ? "Claude token file" : `reviewer token ${t.name}`;
    const when = t.expiresAt ? `${t.state === "expired" ? "expired" : "expires"} ${t.expiresAt.slice(0, 10)}${t.daysLeft !== null && t.state !== "expired" ? ` (${t.daysLeft} days)` : ""}` : "expiry unknown";
    lines.push(`${runner}  ${what}  ${t.state === "ok" ? when : `${t.state}: ${when}`}${t.recovery && t.state !== "ok" ? `  ${t.recovery}` : ""}`);
  }
  return lines;
}
