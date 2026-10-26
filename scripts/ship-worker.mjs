import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION_URL = "https://atelier.zone/api/version";

// Ship supplies this value after checking its registered checkout and baseline.
// Re-reading Git never substitutes a newer commit for that approved source.
export function sourceHead({ cwd = process.cwd(), env = process.env } = {}) {
  const expected = env.ATELIER_SHIP_HEAD;
  if (typeof expected !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected)) {
    throw new Error("ATELIER_SHIP_HEAD must name the source commit captured by atelier ship.");
  }
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== expected) throw new Error("The checkout moved from the source commit captured by atelier ship.");
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("The checkout has uncommitted changes; refusing to use its source binding.");
  return expected;
}

export function deployWorker({ cwd = process.cwd(), env = process.env, run = spawnSync } = {}) {
  const head = sourceHead({ cwd, env });
  // An empty --env names the top-level (production) Worker and takes
  // precedence over a CLOUDFLARE_ENV in the environment.
  const result = run(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "deploy", "--env", "", "--keep-vars", "--var", `DEPLOYED_MAIN:${head}`], { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler deployment failed (${result.signal ?? result.status ?? "no exit status"}).`);
  // A concurrent source change must fail delivery even if Wrangler returned zero.
  sourceHead({ cwd, env });
  return head;
}

export async function verifyWorker({ cwd = process.cwd(), env = process.env, fetchImpl = fetch } = {}) {
  const head = sourceHead({ cwd, env });
  const response = await fetchImpl(VERSION_URL, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200) throw new Error(`Deployment verification returned HTTP ${response.status}; expected 200.`);
  const version = await response.json();
  if (!version || typeof version !== "object" || Array.isArray(version) || version.commit !== head) {
    throw new Error("The live deployed commit does not match the source captured by atelier ship.");
  }
  sourceHead({ cwd, env });
  return head;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2];
    if (!["deploy", "verify"].includes(action) || process.argv.length !== 3) throw new Error("Usage: node scripts/ship-worker.mjs deploy|verify");
    const head = action === "deploy" ? deployWorker() : await verifyWorker();
    console.log(`${action === "deploy" ? "Deployed" : "Verified deployed source"}: ${head}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
