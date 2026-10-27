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

// The Wrangler environment a ship order names: none for production, or one
// such as staging given as deploy --env staging.
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]*$/;

// The wrangler environment to deploy (wrangler.jsonc's env block) and the
// version URL to verify against, as the ship file gives them: `deploy --env
// staging`, `verify --version-url https://next.atelier.zone/api/version`.
// Left out, production: the top-level Worker and VERSION_URL.
export function parseArgs(argv) {
  const [action, ...rest] = argv;
  const usage = "Usage: node scripts/ship-worker.mjs deploy [--env NAME] | verify [--version-url URL]";
  const flag = action === "deploy" ? "--env" : action === "verify" ? "--version-url" : null;
  if (!flag || !(rest.length === 0 || (rest.length === 2 && rest[0] === flag))) throw new Error(usage);
  if (action === "deploy") {
    const environment = rest[1] ?? "";
    if (rest.length && !ENVIRONMENT.test(environment)) throw new Error(`${usage}\n--env must name a wrangler environment, such as staging.`);
    return { action, environment };
  }
  const versionUrl = rest[1];
  if (versionUrl !== undefined) {
    let url;
    try { url = new URL(versionUrl); } catch { /* refused below */ }
    if (url?.protocol !== "https:") throw new Error(`${usage}\n--version-url must be an https URL.`);
  }
  return { action, versionUrl };
}

export function deployWorker({ cwd = process.cwd(), env = process.env, run = spawnSync, environment = "" } = {}) {
  if (environment !== "" && !(typeof environment === "string" && ENVIRONMENT.test(environment))) throw new Error(`Not a Wrangler environment name: ${JSON.stringify(environment)}.`);
  const head = sourceHead({ cwd, env });
  // --env is always given: an empty one names the top-level (production)
  // Worker, and either takes precedence over a CLOUDFLARE_ENV in the
  // environment.
  const result = run(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "deploy", "--env", environment, "--keep-vars", "--var", `DEPLOYED_MAIN:${head}`], { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler deployment failed (${result.signal ?? result.status ?? "no exit status"}).`);
  // A concurrent source change must fail delivery even if Wrangler returned zero.
  sourceHead({ cwd, env });
  return head;
}

export async function verifyWorker({ cwd = process.cwd(), env = process.env, fetchImpl = fetch, versionUrl = VERSION_URL } = {}) {
  const head = sourceHead({ cwd, env });
  const response = await fetchImpl(versionUrl, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
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
    const { action, environment, versionUrl } = parseArgs(process.argv.slice(2));
    const head = action === "deploy" ? deployWorker({ environment }) : await verifyWorker({ versionUrl });
    console.log(`${action === "deploy" ? "Deployed" : "Verified deployed source"}: ${head}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
