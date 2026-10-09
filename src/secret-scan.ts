// The secret scan a push runs: it reads the diff's added lines and reports
// the file and line of each that holds a key pattern, never the value itself.
// The patterns come from Pullboard's pre-commit scan, narrowed to what a task
// can accidentally push: cloud and model-provider API keys, private key
// blocks, bearer tokens, and `.env`-style assignments of long secrets.
//
// The scanner is pure and returns only `{ file, line, fingerprint }`, so
// nothing that matches is ever stored or printed; the Ledger keeps the flag,
// not the key.

import type { ItemDiff } from "./diff.ts";

// What one matched line is reported as: the file it was added to, the 1-based
// line number in the new file, and a fingerprint of the line (below). The
// matched text is never kept.
export interface SecretHit {
  file: string;
  line: number;
  fingerprint: string;
}

// A file whose added lines the scan could not read in full (a text file whose
// diff exceeded the memory budget), with the hash of its content at the head
// as its fingerprint: a clearance of it holds while the file is unchanged.
export interface UnscannedFile {
  file: string;
  fingerprint: string;
}

// The fingerprint of a flagged line: the SHA-256, as hex, of the line's text
// with its leading and trailing whitespace removed. The owner's clearance of
// a flag is recorded against the file and this fingerprint (clearSecret in
// src/ledger.ts), so a later push that keeps the identical line in the same
// file, at the same line number or another, finds the clearance and is not
// blocked again, while a line that changed in any other way, or the same
// line in another file, is a new finding and blocks. The fingerprint is a
// one-way digest, so the flag and the clearance never hold the value; a
// reader who already has a candidate key could confirm it against the
// digest, which is the trade made for a clearance that survives a push.
export async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.trim()));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── patterns ───────────────────────────────────────────────────────────────

// A PEM or OpenSSH private key block, whatever the algorithm ("RSA", "EC",
// "OPENSSH", "DSA", "PGP" or none, encrypted or not).
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

// A bearer token: an Authorization header or a bare `bearer <token>`, the
// token long enough that a short word is not taken for one.
const BEARER = /(?:authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]{16,}/i;

// Cloud and model-provider API keys, matched by the provider's fixed prefix
// and a long body of the charset the provider uses, so a short lookalike or a
// mention of a key's name does not match. One `sk-` pattern covers OpenAI
// ("sk-", "sk-proj-") and Anthropic ("sk-ant-") and every other `sk-` provider.
const KEY_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{35}/,               // Google Cloud API key
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,           // AWS access key id
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}/, // GitHub classic token
  /github_pat_[A-Za-z0-9_]{22,}/,        // GitHub fine-grained token
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,     // OpenAI, Anthropic and other sk- keys
  /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe key
  /xox[baprs]-[A-Za-z0-9-]{10,}/,        // Slack token
];

// A variable name segment that marks a `.env`-style assignment as a secret.
// Compared lower-cased, so OPENAI_API_KEY, ApiKey and api_key all match.
const SECRET_SEGMENTS = new Set([
  "key", "secret", "token", "password", "passwd", "pass",
  "credential", "credentials", "auth", "apikey", "privatekey",
]);

// A long, token-shaped value: at least this many base64-ish characters, with
// no space, colon or other structure, is far more likely a secret than a
// config value such as a URL, a version or a colour.
const LONG_VALUE = 40;

// The shortest value a `.env`-style assignment reports, so a placeholder such
// as `API_KEY=your_key_here` is not taken for a secret.
const SHORT_SECRET = 24;

// A `.env`-style assignment: `NAME=value` on its own line, with optional
// quotes. The value must be token-shaped, so `URL=https://…` (a colon),
// `COLOR=#fff` (too short, a hash) and `PORT=8080` (too short) never match.
// A value shorter than LONG_VALUE counts only when the name is itself a
// secret name, and any value counts once it is at least SHORT_SECRET, so
// `OPENAI_API_KEY=sk-…` matches and `API_KEY=your_key_here` does not.
const ASSIGNMENT = new RegExp(`^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*["']?([A-Za-z0-9+/_-]{${SHORT_SECRET},})["']?\\s*$`);

function secretAssignment(text: string): boolean {
  const m = ASSIGNMENT.exec(text);
  if (!m) return false;
  const value = m[2];
  if (value.length >= LONG_VALUE) return true;
  return m[1].split("_").some((segment) => SECRET_SEGMENTS.has(segment.toLowerCase()));
}

// Whether one added line holds a key pattern. It reports only whether, so no
// value is read out of the line.
export function scanLine(text: string): boolean {
  if (PRIVATE_KEY.test(text)) return true;
  if (BEARER.test(text)) return true;
  if (KEY_PATTERNS.some((re) => re.test(text))) return true;
  return secretAssignment(text);
}

// Every added line of a diff that holds a key pattern, as file, line and
// fingerprint. A line is reported once even when several patterns match it.
export async function scanDiff(diff: ItemDiff): Promise<SecretHit[]> {
  const hits: SecretHit[] = [];
  for (const f of diff.files) {
    for (const h of f.hunks) {
      let line = h.newStart;
      for (const op of h.lines) {
        if (op.op === "-") continue; // a removed line is not in the new file
        if (op.op === "+" && scanLine(op.text)) hits.push({ file: f.path, line, fingerprint: await fingerprint(op.text) });
        line++;
      }
    }
  }
  return hits;
}

// The whole result of scanning a push: every added line that held a key
// pattern, and every file whose added lines could not be read in full (a text
// file whose diff exceeded the memory budget, listed too-large). The caller
// records both as blocking flags, so a push the scan could not fully read is
// never passed silently. The scan takes a diff and only a diff: a diff that
// could not be read is thrown by its reader (fullDiff in src/diff.ts) and
// never reaches here as "nothing found".
export interface PushScan {
  hits: SecretHit[];
  unscanned: UnscannedFile[];
}

export async function scanPush(diff: ItemDiff): Promise<PushScan> {
  return {
    hits: await scanDiff(diff),
    // A too-large file's fingerprint is the hash of its content at the head,
    // which the tree diff carries for it; a file the diff listed without one
    // is fingerprinted as absent, so no clearance of it ever matches.
    unscanned: diff.files.filter((f) => f.status === "too-large").map((f) => ({ file: f.path, fingerprint: f.hash ?? "" })),
  };
}
