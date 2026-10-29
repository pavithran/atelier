// Atelier's deploy to its server on the Studio (Atelier 2.0, task 9; design
// section 4.1), the deploy and verify-deploy steps of docs/atelier/ship.json:
//
//   node scripts/ship-studio.mjs deploy --env staging|production [--host HOST]
//   node scripts/ship-studio.mjs verify --version-url URL
//
// deploy builds a release of the source commit atelier ship captured and
// checked (ATELIER_SHIP_HEAD): `git archive` of that commit and the runtime
// packages package.json names, from the checkout's node_modules at the
// versions the lock file gives. It copies the release to a directory of the
// developer's on the Studio (over ssh to --host, or locally without one) and
// runs the install script of the release already installed there under sudo:
// root's code, which only root can change (scripts/studio/install-server.sh).
// sudo asks for the administrator password on the terminal, which ship hands
// it ("terminal": true in the ship file); nothing here reads, holds or pipes a
// password. The script installs the release, restarts the environment's
// LaunchDaemon and waits for /api/version to report the commit, or puts the
// previous release back.
//
// verify reads the live /api/version and passes only when its commit is the
// one shipped.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
export const ENVIRONMENTS = {
  staging: { server: "server" },
  production: { server: "server-production" },
};
// Where the release waits for root, relative to the developer's home on the
// Studio: a directory the developer's user writes and root reads.
export const RELEASES = "Library/Caches/atelier/releases";
export const installerOf = (environment) => `/Users/atelierd/${ENVIRONMENTS[environment].server}/scripts/studio/install-server.sh`;

// Ship supplies this value after checking its registered checkout and baseline.
// Re-reading Git never substitutes a newer commit for that approved source.
export function sourceHead({ cwd = process.cwd(), env = process.env } = {}) {
  const expected = env.ATELIER_SHIP_HEAD;
  if (typeof expected !== "string" || !COMMIT.test(expected)) {
    throw new Error("ATELIER_SHIP_HEAD must name the source commit captured by atelier ship.");
  }
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== expected) throw new Error("The checkout moved from the source commit captured by atelier ship.");
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("The checkout has uncommitted changes; refusing to build a release from it.");
  return expected;
}

export function parseArgs(argv) {
  const [action, ...rest] = argv;
  const usage = "Usage: node scripts/ship-studio.mjs deploy --env staging|production [--host HOST] | verify --version-url URL";
  const opts = {};
  const allowed = action === "deploy" ? ["--env", "--host"] : action === "verify" ? ["--version-url"] : null;
  if (!allowed || rest.length % 2) throw new Error(usage);
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || rest[i] in opts) throw new Error(usage);
    opts[rest[i]] = rest[i + 1];
  }
  if (action === "deploy") {
    const environment = opts["--env"];
    if (!Object.hasOwn(ENVIRONMENTS, environment ?? "")) throw new Error(`${usage}\n--env must be staging or production.`);
    const host = opts["--host"];
    if (host !== undefined && !HOST.test(host)) throw new Error(`${usage}\n--host must be a host name.`);
    return { action, environment, host };
  }
  let url;
  try { url = new URL(opts["--version-url"]); } catch { /* refused below */ }
  if (url?.protocol !== "https:" && url?.protocol !== "http:") throw new Error(`${usage}\n--version-url must be an http or https URL.`);
  return { action, versionUrl: opts["--version-url"] };
}

// No file in the release may be anything but a file or a directory: the
// install script refuses a link.
function plainTree(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), st = lstatSync(path);
    if (st.isDirectory()) plainTree(path);
    else if (!st.isFile()) throw new Error(`${path} is not a plain file; a release holds only files and directories.`);
  }
}

// Builds the release of `head` in a new temporary directory and returns the
// tar's path, its SHA-256 and the directory, which the caller removes.
export function buildRelease({ cwd, head, tmp = tmpdir() }) {
  const dir = mkdtempSync(join(tmp, "atelier-release-"));
  try {
    const tree = join(dir, "release");
    execFileSync("/bin/mkdir", [tree]);
    const archive = execFileSync("git", ["archive", "--format=tar", head], { cwd, maxBuffer: 1 << 30 });
    execFileSync("tar", ["-xf", "-", "-C", tree], { input: archive, env: { ...process.env, COPYFILE_DISABLE: "1" } });
    // The runtime packages, at the versions the lock file names, each one
    // with no packages of its own.
    const pkg = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(tree, "package-lock.json"), "utf8"));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const locked = lock.packages?.[`node_modules/${name}`];
      if (!locked?.version) throw new Error(`package-lock.json names no version of ${name}.`);
      if (Object.keys(locked.dependencies ?? {}).length) throw new Error(`${name} needs packages of its own, which the release does not carry.`);
      const from = join(cwd, "node_modules", name);
      let installed;
      try { installed = JSON.parse(readFileSync(join(from, "package.json"), "utf8")).version; } catch { /* refused below */ }
      if (installed !== locked.version) throw new Error(`node_modules/${name} is ${installed ?? "missing"}, not ${locked.version} as package-lock.json names; run npm ci.`);
      cpSync(from, join(tree, "node_modules", name), { recursive: true, verbatimSymlinks: true });
    }
    plainTree(tree);
    const tar = join(dir, "release.tar");
    execFileSync("tar", ["-cf", tar, "-C", tree, ...readdirSync(tree).sort()], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const sha256 = createHash("sha256").update(readFileSync(tar)).digest("hex");
    return { dir, tar, sha256 };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const sq = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;

// The deploy. `run` is spawnSync; tests give their own.
export function deployStudio({ cwd = process.cwd(), env = process.env, environment, host, run = spawnSync, installer = installerOf(environment), tmp } = {}) {
  if (!Object.hasOwn(ENVIRONMENTS, environment ?? "")) throw new Error(`Not an environment: ${JSON.stringify(environment)}.`);
  if (host !== undefined && !HOST.test(host)) throw new Error("--host must be a host name.");
  const head = sourceHead({ cwd, env });
  const release = buildRelease({ cwd, head, tmp });
  const name = `${environment}-${head}.tar`;
  let placed = null, keep = false;
  try {
    // 1. The release into the developer's directory on the Studio; the
    //    command answers with that directory's absolute path.
    const place = `umask 077 && mkdir -p ${sq(RELEASES)} && cd ${sq(RELEASES)} && cat > ${sq(name)} && pwd -P`;
    const copied = host
      ? run("ssh", ["-o", "BatchMode=yes", host, place], { input: readFileSync(release.tar), encoding: "utf8", env, maxBuffer: 1 << 20 })
      : run("/bin/sh", ["-c", `cd && ${place}`], { input: readFileSync(release.tar), encoding: "utf8", env, maxBuffer: 1 << 20 });
    if (copied.error) throw copied.error;
    if (copied.status !== 0) throw new Error(`The release could not be copied ${host ? `to ${host}` : "into place"}: ${(copied.stderr || "").trim() || `exit ${copied.status}`}`);
    const where = String(copied.stdout).trim().split("\n").pop();
    if (!where?.startsWith("/") || /[^\w./@-]/.test(where)) throw new Error(`The release directory came back as ${JSON.stringify(where)}, not a plain absolute path.`);
    placed = `${where}/${name}`;
    console.log(`Release of ${head} (sha256 ${release.sha256}) placed at ${host ? `${host}:` : ""}${placed}.`);

    // 2. Root's install script, under sudo, with the terminal: sudo asks for
    //    the password itself.
    const install = ["sudo", "/bin/bash", installer, "--env", environment, "--release", placed, "--sha256", release.sha256, "--commit", head];
    console.log(`Installing it with ${installer} under sudo${host ? ` on ${host}` : ""}; sudo asks for the administrator password.`);
    const r = host
      ? run("ssh", ["-t", host, install.map(sq).join(" ")], { stdio: "inherit", env })
      : run(install[0], install.slice(1), { stdio: "inherit", env });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      // bash's 127: no install script in the release installed, which
      // predates it. The copy is kept for the one install by hand.
      keep = r.status === 127;
      const first = keep ? `\nThe release installed on the Studio may predate install-server.sh. Install this one by hand, once, from a checkout of ${head} on the Studio (the copy is kept): sudo bash scripts/studio/install-server.sh --env ${environment} --release ${placed} --sha256 ${release.sha256} --commit ${head}` : "";
      throw new Error(`The install on the Studio failed (${r.signal ?? `exit ${r.status}`}); its output above says whether the previous release was put back.${first}`);
    }
  } finally {
    rmSync(release.dir, { recursive: true, force: true });
    if (placed && !keep) {
      const rm = host ? run("ssh", ["-o", "BatchMode=yes", host, `rm -f ${sq(placed)}`], { encoding: "utf8", env }) : run("rm", ["-f", placed], { encoding: "utf8", env });
      if (rm.error || rm.status !== 0) console.error(`The release copy ${placed} could not be removed; remove it by hand.`);
    }
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
    const response = await fetchImpl(versionUrl, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200) throw new Error(`${versionUrl} answered HTTP ${response.status}; expected 200.`);
    const version = await response.json();
    if (!version || typeof version !== "object" || Array.isArray(version)) throw new Error(`${versionUrl} did not answer a JSON object.`);
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
    const head = action === "deploy" ? deployStudio({ environment, host }) : await verifyStudio({ versionUrl, windowMs });
    console.log(`${action === "deploy" ? `Deployed to ${environment}` : "Verified the live commit"}: ${head}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
