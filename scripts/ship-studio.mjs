// Atelier's deploy to its server on the Studio (Atelier 2.0, task 9; design
// section 4.1), the deploy and verify-deploy steps of docs/atelier/ship.json:
//
//   node scripts/ship-studio.mjs deploy --env staging|production --version-url URL [--host HOST]
//   node scripts/ship-studio.mjs verify --version-url URL
//
// deploy checks that the checkout is clean at the commit atelier ship
// captured (ATELIER_SHIP_HEAD), and that the commit is on the project's
// branch on the Studio: the branch head the live server reports at
// /api/version (`main`) must hold it. Then it runs root's installer, at its
// fixed path on the Studio, under sudo, with the environment and the commit
// and nothing else (over ssh -t to --host, or locally without one). The
// installer builds the release itself from the Studio's repository
// (scripts/studio/install-server.sh); nothing built or written by the
// developer's user reaches it. sudo asks for the administrator password on
// the terminal, which ship hands it ("terminal": true in the ship file);
// nothing here reads, holds or pipes a password.
//
// verify reads the live /api/version and passes only when its commit is the
// one shipped.
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = /^[a-f0-9]{40}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
export const ENVIRONMENTS = ["staging", "production"];
// Where setup-server.sh installs the installer, root's, outside any release.
export const INSTALLER = "/Library/Atelier/install-server.sh";

// Ship supplies this value after checking its registered checkout and baseline.
// Re-reading Git never substitutes a newer commit for that approved source.
export function sourceHead({ cwd = process.cwd(), env = process.env } = {}) {
  const expected = env.ATELIER_SHIP_HEAD;
  if (typeof expected !== "string" || !COMMIT.test(expected)) {
    throw new Error("ATELIER_SHIP_HEAD must name the source commit captured by atelier ship.");
  }
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== expected) throw new Error("The checkout moved from the source commit captured by atelier ship.");
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("The checkout has uncommitted changes; refusing to deploy from it.");
  return expected;
}

const httpUrl = (value) => {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" || url.protocol === "http:";
};

export function parseArgs(argv) {
  const [action, ...rest] = argv;
  const usage = "Usage: node scripts/ship-studio.mjs deploy --env staging|production --version-url URL [--host HOST] | verify --version-url URL";
  const opts = {};
  const allowed = action === "deploy" ? ["--env", "--host", "--version-url"] : action === "verify" ? ["--version-url"] : null;
  if (!allowed || rest.length % 2) throw new Error(usage);
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || rest[i] in opts) throw new Error(usage);
    opts[rest[i]] = rest[i + 1];
  }
  if (!httpUrl(opts["--version-url"])) throw new Error(`${usage}\n--version-url must be an http or https URL.`);
  if (action === "verify") return { action, versionUrl: opts["--version-url"] };
  const environment = opts["--env"];
  if (!ENVIRONMENTS.includes(environment)) throw new Error(`${usage}\n--env must be staging or production.`);
  const host = opts["--host"];
  if (host !== undefined && !HOST.test(host)) throw new Error(`${usage}\n--host must be a host name.`);
  return { action, environment, host, versionUrl: opts["--version-url"] };
}

async function liveVersion(versionUrl, fetchImpl) {
  const response = await fetchImpl(versionUrl, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200) throw new Error(`${versionUrl} answered HTTP ${response.status}; expected 200.`);
  const version = await response.json();
  if (!version || typeof version !== "object" || Array.isArray(version)) throw new Error(`${versionUrl} did not answer a JSON object.`);
  return version;
}

// The deploy. `run` is spawnSync; tests give their own.
export async function deployStudio({ cwd = process.cwd(), env = process.env, environment, host, versionUrl, run = spawnSync, fetchImpl = fetch } = {}) {
  if (!ENVIRONMENTS.includes(environment)) throw new Error(`Not an environment: ${JSON.stringify(environment)}.`);
  if (host !== undefined && !HOST.test(host)) throw new Error("--host must be a host name.");
  const head = sourceHead({ cwd, env });
  // The project's branch on the Studio, as its server reports it, must hold
  // the commit: after a landing it does. The installer checks again itself.
  const { main } = await liveVersion(versionUrl, fetchImpl);
  if (typeof main !== "string" || !COMMIT.test(main)) throw new Error(`${versionUrl} names no branch head (main is ${JSON.stringify(main)}); the project's branch on the Studio cannot be checked.`);
  const git = (...args) => run("git", args, { cwd, encoding: "utf8" });
  if (git("cat-file", "-e", `${main}^{commit}`).status !== 0) throw new Error(`The Studio's branch head ${main} is not in this checkout; fetch it, then ship again.`);
  if (git("merge-base", "--is-ancestor", head, main).status !== 0) throw new Error(`${head} is not on the project's branch on the Studio (its head is ${main}); only landed commits are installed.`);
  const install = ["sudo", INSTALLER, "--env", environment, head];
  console.log(`Installing ${head} on ${environment} with ${INSTALLER} under sudo${host ? ` on ${host}` : ""}; sudo asks for the administrator password.`);
  const r = host
    ? run("ssh", ["-t", host, install.join(" ")], { stdio: "inherit", env })
    : run(install[0], install.slice(1), { stdio: "inherit", env });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const missing = r.status === 127 ? ` ${INSTALLER} may not be installed yet: setup-server.sh --env ${environment} installs it.` : "";
    throw new Error(`The install on the Studio failed (${r.signal ?? `exit ${r.status}`}); its output above says what it put back.${missing}`);
  }
  // A concurrent source change must fail delivery even if the install passed.
  sourceHead({ cwd, env });
  return head;
}

// The install waits for the commit itself, so a mismatch here is retried
// only briefly, for a proxy in front of the server.
export const VERIFY_WINDOW_MS = 30_000;
const sleepFor = (ms) => new Promise((done) => setTimeout(done, ms));

export async function verifyStudio({ cwd = process.cwd(), env = process.env, fetchImpl = fetch, versionUrl, sleep = sleepFor, now = Date.now, windowMs = VERIFY_WINDOW_MS } = {}) {
  const head = sourceHead({ cwd, env });
  const deadline = now() + windowMs;
  let delay = 1000;
  for (;;) {
    const version = await liveVersion(versionUrl, fetchImpl);
    if (version.commit === head) break;
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`The live commit ${version.commit} at ${versionUrl} does not match the source ${head} captured by atelier ship, after retrying for ${Math.round(windowMs / 1000)} s.`);
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, 10_000);
  }
  sourceHead({ cwd, env });
  return head;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { action, environment, host, versionUrl } = parseArgs(process.argv.slice(2));
    // SHIP_VERIFY_WINDOW_MS shortens the retry window, for tests that serve a
    // mismatch on purpose.
    const windowMs = process.env.SHIP_VERIFY_WINDOW_MS === undefined ? VERIFY_WINDOW_MS : Number(process.env.SHIP_VERIFY_WINDOW_MS);
    const head = action === "deploy" ? await deployStudio({ environment, host, versionUrl }) : await verifyStudio({ versionUrl, windowMs });
    console.log(`${action === "deploy" ? `Deployed to ${environment}` : "Verified the live commit"}: ${head}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
