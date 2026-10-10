// The local record of named tokens' expiry days: `atelier ops token-expiry
// NAME --on YYYY-MM-DD` writes it, `atelier status` reads it and warns before
// a token lapses. A token is named, never valued: the file holds only
// NAME -> "YYYY-MM-DD", so no token string is ever written to disk.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { formatTokenExpiryWarnings, parseExpiryDay, TOKEN_EXPIRY_WARN_DAYS } from "../src/token-expiry.ts";
export { formatTokenExpiryWarnings, parseExpiryDay, TOKEN_EXPIRY_WARN_DAYS };

// The file, in the CLI's config directory (ATELIER_CONFIG_DIR, else
// ~/.config/atelier), beside config.json. Not a secret: it holds days, never
// values, so it stays out of the secrets store.
export function tokenExpiriesFile(env = process.env) {
  return join(env.ATELIER_CONFIG_DIR ?? join(homedir(), ".config", "atelier"), "token-expiries.json");
}

export function readTokenExpiries(deps = {}) {
  const file = deps.file ?? tokenExpiriesFile(deps.env ?? process.env);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function recordTokenExpiryDay(name, date, deps = {}) {
  const file = deps.file ?? tokenExpiriesFile(deps.env ?? process.env);
  const all = readTokenExpiries(deps);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...all, [name]: date }, null, 2) + "\n", { mode: 0o600 });
}
