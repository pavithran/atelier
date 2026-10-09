// The secret scan a push runs: it reads the diff's added lines and reports
// the file and line of each that holds a key pattern, never the value itself.
// The patterns come from Pullboard's pre-commit scan, narrowed to what a task
// can accidentally push: cloud and model-provider API keys, private key
// blocks, bearer tokens, and `.env`-style assignments of long secrets.
//
// The scanner is pure and returns only `{ file, line }`, so nothing that
// matches is ever stored or printed; the Ledger keeps the flag, not the key.

import type { ItemDiff } from "./diff.ts";

// What one matched line is reported as: the file it was added to and the
// 1-based line number in the new file. The matched text is never kept.
export interface SecretHit {
  file: string;
  line: number;
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

// Every added line of a diff that holds a key pattern, as file and line. A
// line is reported once even when several patterns match it.
export function scanDiff(diff: ItemDiff): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const f of diff.files) {
    for (const h of f.hunks) {
      let line = h.newStart;
      for (const op of h.lines) {
        if (op.op === "-") continue; // a removed line is not in the new file
        if (op.op === "+" && scanLine(op.text)) hits.push({ file: f.path, line });
        line++;
      }
    }
  }
  return hits;
}
