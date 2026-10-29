// scripts/ship-studio.mjs and scripts/studio/install-server.sh (Atelier 2.0,
// task 9). Ship passes the installer the environment and a commit and
// nothing else; the installer builds the release itself from the Studio's
// repository, as atelierd, checks the commit is on the project's branch,
// fetches the runtime packages against the lock file's integrity, writes
// COMMIT, and recovers from a failure at any point of the swap.
//
// The install script runs for real, not as root: ATELIER_INSTALL_TEST_HOME
// points it at a scratch home holding a bare repository, with stand-in
// launchctl, lsof, curl, sudo and mv on PATH. The stand-in mv fails once for
// the destination FAIL_MV_TO names; launchctl fails one bootstrap when
// FAIL_BOOTSTRAP_ONCE is set. The script reads owners with BSD stat, so
// those tests run on macOS only, as the Studio does.
import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { deployStudio, INSTALLER, parseArgs, sourceHead, verifyStudio } from "../scripts/ship-studio.mjs";

const SCRIPT = resolve("scripts/studio/install-server.sh");
const darwin = process.platform === "darwin" ? false : "the install script reads owners with BSD stat; macOS only";
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (name) => { const d = mkdtempSync(join(tmpdir(), `atelier-ship-studio-${name}-`)); dirs.push(d); return d; };
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const OLD = "1".repeat(40);
const URL_ = "https://next.atelier.zone/api/version";

// A checkout shaped like Atelier's, enough for a release, with no runtime
// packages unless `lock` gives some.
function checkout({ pkg = { name: "atelier" }, lock = { lockfileVersion: 3, packages: { "": {} } } } = {}) {
  const cwd = scratch("checkout");
  const git = (...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const put = (path, text) => { mkdirSync(join(cwd, path, ".."), { recursive: true }); writeFileSync(join(cwd, path), text); };
  put("cli/serve.mjs", "// the server\n");
  put("hooks/pre-receive", "#!/bin/sh\n");
  chmodSync(join(cwd, "hooks/pre-receive"), 0o755);
  put("package.json", JSON.stringify(pkg));
  put("package-lock.json", JSON.stringify(lock));
  git("add", "."); git("commit", "-qm", "first");
  const commit = (path, text) => { put(path, text); git("add", "-A"); git("commit", "-qm", `add ${path}`); return git("rev-parse", "HEAD"); };
  return { cwd, git, put, commit, head: () => git("rev-parse", "HEAD") };
}

// The Studio as the install script sees it in a test: a home holding the
// release that runs (COMMIT OLD), the LaunchDaemon's plist, the project's
// bare repository (repos/staging/atelier.git, a mirror of the checkout's
// main), and the stand-ins. The daemon is loaded while `loaded` exists; its
// /api/version answers home/server/COMMIT unless that release holds BROKEN.
function studio(c) {
  const root = scratch("studio");
  const home = join(root, "home"), bin = join(root, "bin");
  for (const d of [home, join(home, "LaunchDaemons"), join(home, "server", "cli"), join(home, "log"), join(home, "repos", "staging"), bin]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "server", "COMMIT"), `${OLD}\n`);
  writeFileSync(join(home, "server", "cli", "serve.mjs"), "// running\n");
  writeFileSync(join(home, "loaded"), "");
  const repo = join(home, "repos", "staging", "atelier.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", repo], { env: gitEnv });
  const sync = () => execFileSync("git", ["push", "-q", "--force", repo, "main:main"], { cwd: c.cwd, env: gitEnv });
  sync();
  const args = ["node", join(home, "server", "cli", "serve.mjs"), "--env", "staging", "--data", join(home, "data/staging"), "--host", "127.0.0.1", "--port", "4101"];
  writeFileSync(join(home, "LaunchDaemons", "zone.atelier.server.staging.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>zone.atelier.server.staging</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join("")}</array></dict></plist>
`);
  const tool = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\nh="$ATELIER_INSTALL_TEST_HOME"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  tool("launchctl", `echo "launchctl $*" >> "$h/launchctl.log"
case "$1" in
  print) [ -e "$h/loaded" ] ;;
  bootout) rm -f "$h/loaded"; [ "$INTERRUPT_AFTER" != bootout ] || kill -KILL "$PPID" ;;
  bootstrap) if [ -n "$FAIL_BOOTSTRAP_ONCE" ] && [ ! -e "$h/bootstrap-failed" ]; then : > "$h/bootstrap-failed"; exit 5; fi; : > "$h/loaded"; [ "$INTERRUPT_AFTER" != bootstrap ] || kill -KILL "$PPID" ;;
  *) exit 2 ;;
esac`);
  tool("lsof", `[ -e "$h/loaded" ]`);
  tool("curl", `[ "$1" = -q ] || { echo "curl config was not disabled" >&2; exit 9; }
[ -e "$h/loaded" ] || exit 7
[ -e "$h/server/BROKEN" ] && exit 22
printf '{"commit":"%s","main":null}' "$(cat "$h/server/COMMIT")"`);
  tool("sudo", `echo "sudo $*" >> "$h/sudo.log"
[ "$1" = "${INSTALLER}" ] || { echo "not the installer: $1" >&2; exit 9; }
shift
exec /bin/bash "$TEST_INSTALLER" "$@"`);
  tool("mv", `last=; for a in "$@"; do last=$a; done
if [ -n "$FAIL_MV_TO" ] && [ "$last" = "$FAIL_MV_TO" ] && [ ! -e "$h/mv-failed" ]; then : > "$h/mv-failed"; echo "mv: stand-in failure to $last" >&2; exit 1; fi
/bin/mv "$@" || exit $?
[ "$INTERRUPT_AFTER" != "$last" ] || kill -KILL "$PPID"`);
  tool("git", `h="${home}"
case " $* " in *" archive "*)
  if [ -e "$h/hold-archive" ]; then
    : > "$h/holding"
    while [ ! -e "$h/release" ]; do /bin/sleep 0.05; done
  fi ;;
esac
exec /usr/bin/git "$@"`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ATELIER_INSTALL_TEST_HOME: home, ATELIER_INSTALL_TEST_WAIT: "2", TEST_INSTALLER: SCRIPT };
  const install = (argv, extra = {}) => new Promise((done) => {
    if (extra.HOLD_ARCHIVE) writeFileSync(join(home, "hold-archive"), "");
    const child = spawn("/bin/bash", [SCRIPT, ...argv], { env: { ...env, ...extra } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  const commitOf = (dir) => (existsSync(join(home, dir, "COMMIT")) ? readFileSync(join(home, dir, "COMMIT"), "utf8").trim() : null);
  return { home, repo, env, sync, install, commitOf, loaded: () => existsSync(join(home, "loaded")), launchctl: () => (existsSync(join(home, "launchctl.log")) ? readFileSync(join(home, "launchctl.log"), "utf8") : "") };
}

// Installs `commit` and checks it answered.
async function installed(s, commit) {
  const r = await s.install(["--env", "staging", commit]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.commitOf("server"), commit);
  return r;
}

test("deploy takes --env, --version-url and an optional --host; verify takes --version-url", () => {
  assert.deepEqual(parseArgs(["deploy", "--env", "staging", "--version-url", URL_]), { action: "deploy", environment: "staging", host: undefined, versionUrl: URL_ });
  assert.deepEqual(parseArgs(["deploy", "--env", "production", "--version-url", URL_, "--host", "ai-studio"]), { action: "deploy", environment: "production", host: "ai-studio", versionUrl: URL_ });
  assert.deepEqual(parseArgs(["verify", "--version-url", URL_]), { action: "verify", versionUrl: URL_ });
  for (const argv of [[], ["deploy", "--env", "staging"], ["deploy", "--env", "test", "--version-url", URL_], ["deploy", "--env", "staging", "--version-url", URL_, "--host", "-oProxyCommand=x"],
    ["deploy", "--env", "staging", "--env", "production", "--version-url", URL_], ["verify"], ["verify", "--version-url", "file:///etc/passwd"], ["verify", "--env", "staging"], ["ship"]]) {
    assert.throws(() => parseArgs(argv), /Usage/, argv.join(" "));
  }
  assert.equal(INSTALLER, "/Library/Atelier/install-server.sh");
});

test("deploy refuses a checkout that is not at the captured commit, or not clean", () => {
  const c = checkout();
  assert.throws(() => sourceHead({ cwd: c.cwd, env: {} }), /ATELIER_SHIP_HEAD/);
  assert.throws(() => sourceHead({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: "a".repeat(40) } }), /moved/);
  c.put("dirty.txt", "x");
  return assert.rejects(deployStudio({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: c.head() }, environment: "staging", versionUrl: URL_, run: () => assert.fail("nothing runs") }), /uncommitted changes/);
});

test("ship runs the fixed installer under sudo through ssh -t with the environment and the commit alone, and only for a commit on the Studio's branch", async () => {
  const c = checkout();
  const head = c.head();
  const calls = [];
  const run = (cmd, args, options) => {
    if (cmd === "git") return spawnSync(cmd, args, options);
    calls.push({ cmd, args, stdio: options.stdio });
    return { status: 0 };
  };
  const live = (main) => async () => Response.json({ commit: OLD, main });
  assert.equal(await deployStudio({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: head }, environment: "production", host: "ai-studio", versionUrl: URL_, run, fetchImpl: live(head) }), head);
  assert.deepEqual(calls, [{ cmd: "ssh", args: ["-t", "ai-studio", `sudo /Library/Atelier/install-server.sh --env production ${head}`], stdio: "inherit" }]);
  // A branch head ahead of the commit holds it too.
  const ahead = c.commit("later.txt", "x");
  c.git("checkout", "-q", "HEAD~1");
  calls.length = 0;
  await deployStudio({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: head }, environment: "staging", versionUrl: URL_, run, fetchImpl: live(ahead) });
  assert.deepEqual(calls, [{ cmd: "sudo", args: ["/Library/Atelier/install-server.sh", "--env", "staging", head], stdio: "inherit" }]);
  // Not on the branch, not known here, or not reported: nothing runs.
  c.git("checkout", "-q", "main");
  calls.length = 0;
  await assert.rejects(deployStudio({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: ahead }, environment: "staging", versionUrl: URL_, run, fetchImpl: live(head) }), /not on the project's branch on the Studio/);
  await assert.rejects(deployStudio({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: ahead }, environment: "staging", versionUrl: URL_, run, fetchImpl: live("e".repeat(40)) }), /not in this checkout; fetch it/);
  await assert.rejects(deployStudio({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: ahead }, environment: "staging", versionUrl: URL_, run, fetchImpl: live(null) }), /names no branch head/);
  assert.deepEqual(calls, []);
});

test("verify passes only when the live commit is the one shipped, and refuses a redirect or a bad status", async () => {
  const c = checkout();
  const head = c.head();
  const env = { ATELIER_SHIP_HEAD: head };
  const answer = (body, status = 200) => async (url, options) => { assert.equal(options.redirect, "error"); return Response.json(body, { status }); };
  assert.equal(await verifyStudio({ cwd: c.cwd, env, versionUrl: URL_, fetchImpl: answer({ commit: head }) }), head);
  await assert.rejects(verifyStudio({ cwd: c.cwd, env, versionUrl: URL_, fetchImpl: answer({ commit: null }), windowMs: 0 }), /live commit null .* does not match/);
  await assert.rejects(verifyStudio({ cwd: c.cwd, env, versionUrl: URL_, fetchImpl: answer({}, 502) }), /HTTP 502/);
  await assert.rejects(verifyStudio({ cwd: c.cwd, env, versionUrl: URL_, fetchImpl: answer([head]) }), /JSON object/);
  let n = 0;
  const later = async () => Response.json({ commit: n++ < 2 ? "b".repeat(40) : head });
  assert.equal(await verifyStudio({ cwd: c.cwd, env, versionUrl: URL_, fetchImpl: later, sleep: async () => {}, windowMs: 60_000 }), head);
});

test("ship's deploy, through a stand-in sudo, has root build the release from the Studio's repository with COMMIT written, keep the old one and restart the daemon", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  const head = c.head();
  c.put("untracked.txt", "not in the commit\n");
  rmSync(join(c.cwd, "untracked.txt"));
  await deployStudio({ cwd: c.cwd, env: { ...s.env, ATELIER_SHIP_HEAD: head }, environment: "staging", versionUrl: URL_, fetchImpl: async () => Response.json({ commit: OLD, main: head }) });
  assert.equal(s.commitOf("server"), head);
  assert.equal(s.commitOf("server.prev"), OLD);
  assert.ok(s.loaded());
  assert.ok(existsSync(join(s.home, "server/cli/serve.mjs")));
  assert.match(s.launchctl(), /launchctl bootout system\/zone\.atelier\.server\.staging\n(?:.*\n)*launchctl bootstrap system .*zone\.atelier\.server\.staging\.plist/);
  assert.equal(readFileSync(join(s.home, "sudo.log"), "utf8"), `sudo /Library/Atelier/install-server.sh --env staging ${head}\n`);
  const mode = (p) => execFileSync("stat", ["-f", "%Lp", join(s.home, p)], { encoding: "utf8" }).trim();
  assert.equal(mode("server/cli/serve.mjs"), "640");
  assert.equal(mode("server/hooks/pre-receive"), "750");
  assert.equal(mode("server/COMMIT"), "640");
});

test("the installer takes --env and a 40-hex commit, or --rollback, and nothing else", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  const head = c.head();
  for (const argv of [["--env", "staging"], ["--env", "staging", head, "--release", "/tmp/x.tar"], ["--env", "test", head], ["--env", "staging", head.slice(1)], ["--env", "staging", head.toUpperCase()],
    ["--env", "staging", `${head}${"0".repeat(24)}`], ["staging", head, "x"], ["--env", "staging", "main"]]) {
    const r = await s.install(argv);
    assert.equal(r.status, 1, argv.join(" "));
  }
  assert.equal(s.commitOf("server"), OLD);
  assert.equal(s.launchctl(), "", "the daemon was never touched");
});

test("the installer refuses a commit that is not on the project's branch, or not in the repository, changing nothing", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  c.git("checkout", "-q", "-b", "side");
  const side = c.commit("side.txt", "unlanded\n");
  execFileSync("git", ["push", "-q", s.repo, "side:side"], { cwd: c.cwd, env: gitEnv });
  const off = await s.install(["--env", "staging", side]);
  assert.equal(off.status, 1);
  assert.match(off.stderr, /is not on main, the project's branch; only landed commits are installed/);
  const unknown = await s.install(["--env", "staging", "e".repeat(40)]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /is not a commit in/);
  assert.equal(s.commitOf("server"), OLD);
  assert.doesNotMatch(s.launchctl(), /bootout|bootstrap/);
});

test("the installer refuses an archive that holds a link", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  symlinkSync("/etc/passwd", join(c.cwd, "passwd"));
  c.git("add", "passwd"); c.git("commit", "-qm", "a link");
  s.sync();
  const r = await s.install(["--env", "staging", c.head()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /holds a link or something else/);
  assert.equal(s.commitOf("server"), OLD);
  assert.doesNotMatch(s.launchctl(), /bootout|bootstrap/);
});

// A stand-in npm registry serving one package, jose, as a tarball.
async function registry(t) {
  const work = scratch("registry");
  mkdirSync(join(work, "package", "dist"), { recursive: true });
  writeFileSync(join(work, "package", "package.json"), JSON.stringify({ name: "jose", version: "6.2.12" }));
  writeFileSync(join(work, "package", "dist", "index.js"), "export {};\n");
  const tgz = join(work, "jose.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", work, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const bytes = readFileSync(tgz);
  const server = createServer((req, res) => { if (req.url === "/jose/-/jose-6.2.12.tgz") { res.writeHead(200); res.end(bytes); } else { res.writeHead(404); res.end(); } });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/`;
  const lock = (over = {}) => ({ lockfileVersion: 3, packages: { "": { dependencies: { jose: "^6.2.12" } },
    "node_modules/jose": { version: "6.2.12", resolved: `${base}jose/-/jose-6.2.12.tgz`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, ...over },
    "node_modules/typescript": { version: "7.0.0", dev: true, resolved: `${base}nowhere.tgz`, integrity: "sha512-x" } } });
  return { base, lock };
}

test("the runtime packages are fetched as the lock file names them and kept only when their SHA-512 is its integrity; dev packages are left out", { skip: darwin }, async (t) => {
  const reg = await registry(t);
  const pkg = { name: "atelier", dependencies: { jose: "^6.2.12" } };
  const c = checkout({ pkg, lock: reg.lock() }), s = studio(c);
  const extra = { ATELIER_INSTALL_TEST_REGISTRY: reg.base };
  const good = c.head();
  const r = await s.install(["--env", "staging", good], extra);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 runtime package fetched and checked against the lock file/);
  assert.equal(JSON.parse(readFileSync(join(s.home, "server/node_modules/jose/package.json"), "utf8")).version, "6.2.12");
  assert.ok(existsSync(join(s.home, "server/node_modules/jose/dist/index.js")));
  assert.ok(!existsSync(join(s.home, "server/node_modules/typescript")));
  for (const [over, why] of [
    [{ integrity: `sha512-${createHash("sha512").update("other").digest("base64")}` }, /does not match its integrity/],
    [{ integrity: "sha1-abc" }, /has no sha512 integrity/],
    [{ resolved: "https://evil.example/jose.tgz" }, /does not come from/],
    [{ link: true }, /is a link in the lock file/],
  ]) {
    c.put("package-lock.json", JSON.stringify(reg.lock(over)));
    c.git("add", "-A"); c.git("commit", "-qm", "lock");
    s.sync();
    const bad = await s.install(["--env", "staging", c.head()], extra);
    assert.equal(bad.status, 1, JSON.stringify(over));
    assert.match(bad.stderr, why);
    assert.match(bad.stderr, /nothing was changed/);
    assert.equal(s.commitOf("server"), good);
  }
  c.put("package.json", JSON.stringify({ name: "atelier", dependencies: { jose: "^6.2.12", other: "^1" } }));
  c.put("package-lock.json", JSON.stringify(reg.lock()));
  c.git("add", "-A"); c.git("commit", "-qm", "out of step");
  s.sync();
  const stale = await s.install(["--env", "staging", c.head()], extra);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /does not install other, which package\.json needs/);
});

// ── recovery from every point of the swap ────────────────────────────────

test("a failed move to SERVER.prev changes nothing and starts the old release again", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  const r = await s.install(["--env", "staging", c.head()], { FAIL_MV_TO: join(s.home, "server.prev") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stand-in failure/);
  assert.match(r.stderr, new RegExp(`answers again at commit ${OLD}.*failed at: stopped`));
  assert.equal(s.commitOf("server"), OLD);
  assert.ok(s.loaded());
});

test("a failed move into place puts SERVER.prev back", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  const r = await s.install(["--env", "staging", c.head()], { FAIL_MV_TO: join(s.home, "server") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`answers again at commit ${OLD}.*failed at: prev`));
  assert.equal(s.commitOf("server"), OLD);
  assert.ok(!existsSync(join(s.home, "server.prev")));
  assert.ok(s.loaded());
});

test("a daemon that does not start moves the new release to SERVER.failed and starts the old one", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  const head = c.head();
  const r = await s.install(["--env", "staging", head], { FAIL_BOOTSTRAP_ONCE: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not start/);
  assert.match(r.stderr, new RegExp(`answers again at commit ${OLD}.*failed at: placed`));
  assert.equal(s.commitOf("server"), OLD);
  assert.equal(s.commitOf("server.failed"), head);
  assert.ok(s.loaded());
});

test("a release that does not report its commit in time is taken out and the old one answers again", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  const broken = c.commit("BROKEN", "this release never answers\n");
  s.sync();
  const r = await s.install(["--env", "staging", broken]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`staging did not report commit ${broken}`));
  assert.match(r.stderr, new RegExp(`answers again at commit ${OLD}.*failed at: started`));
  assert.match(r.stderr, /the release that failed is kept as .*server\.failed/);
  assert.equal(s.commitOf("server"), OLD);
  assert.equal(s.commitOf("server.failed"), broken);
});

test("a run first settles what an interrupted one left: SERVER missing with SERVER.prev present puts SERVER.prev back", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  renameSync(join(s.home, "server"), join(s.home, "server.prev"));
  const head = c.head();
  const r = await installed(s, head);
  assert.match(r.stderr, /server was missing; putting .*server\.prev back/);
  assert.equal(s.commitOf("server.prev"), OLD);
});

test("rollback swaps the two both ways, and recovers from a failure at each of its moves and at the wait", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  const head = c.head();
  await installed(s, head);
  const back = await s.install(["--env", "staging", "--rollback"]);
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stdout, new RegExp(`rolled staging back to commit ${OLD}; the release it replaced \\(${head}\\) is kept`));
  assert.equal(s.commitOf("server.prev"), head);
  assert.equal((await s.install(["--env", "staging", "--rollback"])).status, 0);
  assert.equal(s.commitOf("server"), head);
  for (const [dest, phase] of [["server.swap", "stopped"], ["server", "swap1"], ["server.prev", "swap2"]]) {
    rmSync(join(s.home, "mv-failed"), { force: true });
    const r = await s.install(["--env", "staging", "--rollback"], { FAIL_MV_TO: join(s.home, dest) });
    assert.equal(r.status, 1, dest);
    assert.match(r.stderr, new RegExp(`answers again at commit ${head}.*failed at: ${phase}`), dest);
    assert.equal(s.commitOf("server"), head, dest);
    assert.equal(s.commitOf("server.prev"), OLD, dest);
    assert.ok(!existsSync(join(s.home, "server.swap")), dest);
    assert.ok(s.loaded(), dest);
  }
  // The previous release does not answer: the rollback is undone.
  writeFileSync(join(s.home, "server.prev", "BROKEN"), "");
  const r = await s.install(["--env", "staging", "--rollback"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`answers again at commit ${head}.*failed at: swap3`));
  assert.equal(s.commitOf("server"), head);
  assert.equal(s.commitOf("server.prev"), OLD);
});

test("the install script runs only as root, unless a test names its scratch home", () => {
  if (process.getuid?.() === 0) return;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ATELIER_INSTALL_TEST")));
  const r = spawnSync("/bin/bash", [SCRIPT, "--env", "staging", "--rollback"], { env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run as root \(sudo\)/);
});


test("root discards inherited configuration before commands; health curl disables config first", { skip: darwin }, () => {
  const text = readFileSync(SCRIPT, "utf8");
  const prelude = text.slice(text.indexOf('if builtin test "$EUID"'), text.indexOf("set -euo pipefail")).replace('builtin test "$EUID" = 0', 'builtin true');
  const h = scratch("hostile-env");
  writeFileSync(join(h, "id"), `#!/bin/sh\necho hijacked > '${h}/ran'\n`); chmodSync(join(h, "id"), 0o755);
  const r = spawnSync("/bin/bash", ["-c", `${prelude}\n/usr/bin/env`], {
    env: { PATH: h, HOME: h, CURL_HOME: h, XDG_CONFIG_HOME: h, NODE_OPTIONS: "--import=evil", ATELIER_INSTALL_TEST_HOME: h, GIT_CONFIG_COUNT: "1" }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const vars = Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.equal(vars.PATH, "/usr/bin:/bin:/usr/sbin:/sbin"); assert.equal(vars.HOME, "/var/root");
  for (const k of ["CURL_HOME", "XDG_CONFIG_HOME", "NODE_OPTIONS", "ATELIER_INSTALL_TEST_HOME", "GIT_CONFIG_COUNT"]) assert.equal(vars[k], undefined);
  assert.ok(!existsSync(join(h, "ran")));
  assert.match(text, /"\$CURL" -q -fsS/);
  assert.doesNotMatch(text, /\$\(id /);
  assert.match(text, /SUDO=\/usr\/bin\/sudo/);
});

test("every interrupted install or rollback resumes service even when the next commit fails preflight", { skip: darwin }, async () => {
  for (const rollback of [false, true]) {
    for (const step of ["bootout", "first", "second", ...(rollback ? ["third"] : []), "bootstrap"]) {
      const c = checkout(), s = studio(c);
      if (rollback) await installed(s, c.head());
      const dest = { first: rollback ? "server.swap" : "server.prev", second: "server", third: "server.prev" }[step];
      const interrupted = await s.install(["--env", "staging", rollback ? "--rollback" : c.head()], { INTERRUPT_AFTER: dest ? join(s.home, dest) : step });
      assert.equal(interrupted.status, null, `${rollback} ${step}: ${interrupted.stderr}`);
      const r = await s.install(["--env", "staging", "f".repeat(40)]);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /is not a commit/, `${rollback} ${step}: ${r.stderr}`);
      assert.ok(s.loaded(), `${rollback} ${step}: ${r.stderr}`);
      assert.ok(s.commitOf("server"), `${rollback} ${step}`);
      assert.ok(!existsSync(join(s.home, "install.lock")));
    }
  }
});

test("recovery says loudly when the installed service cannot start", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  rmSync(join(s.home, "loaded"));
  writeFileSync(join(s.home, "server/BROKEN"), "broken");
  const r = await s.install(["--env", "staging", "f".repeat(40)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /COULD NOT START staging/);
  assert.ok(!existsSync(join(s.home, "install.lock")));
});

test("a second overlapping installer refuses without changing the first run's lock or service", { skip: darwin }, async () => {
  const c = checkout(), s = studio(c);
  const first = s.install(["--env", "staging", c.head()], { HOLD_ARCHIVE: "1" });
  try {
    for (let i = 0; !existsSync(join(s.home, "holding")); i++) {
      assert.ok(i < 200, "first installer reached archive");
      await new Promise((done) => setTimeout(done, 25));
    }
    const lock = readFileSync(join(s.home, "install.lock"), "utf8");
    const second = await s.install(["--env", "staging", c.head()]);
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, /another installer is running/);
    assert.equal(readFileSync(join(s.home, "install.lock"), "utf8"), lock);
    assert.equal(s.commitOf("server"), OLD);
    assert.ok(s.loaded());
  } finally { writeFileSync(join(s.home, "release"), ""); }
  const r = await first;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(s.home, "install.lock")));
});
