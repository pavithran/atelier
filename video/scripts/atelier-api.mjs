// Read-only access to atelier.zone for the video's data and captures. The
// owner token is read from the CLI's own credential store and goes only into
// the Authorization header of GET requests (and the login form of a capture).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSecret } from "../../cli/credentials.mjs";

const CONFIG = JSON.parse(readFileSync(join(homedir(), ".config/atelier/config.json"), "utf8"));
export const SERVER = CONFIG.server.replace(/\/$/, "");
const OWNER = CONFIG.owner ?? "owner";

export function ownerToken() {
  const token = readSecret("API_TOKEN");
  if (!token) throw new Error("no stored Atelier token");
  return token;
}

export async function get(path) {
  const res = await fetch(SERVER + "/api" + path, { headers: { authorization: `Bearer ${ownerToken()}`, "x-atelier-actor": OWNER } });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}
