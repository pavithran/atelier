// scripts/ship-studio.mjs and scripts/studio/install-server.sh (Atelier 2.0,
// task 9): the release built from the captured commit, the install under a
// stand-in sudo, the commit check, the previous release put back when the new
// one does not answer, and rollback. The install script runs for real, not as
// root: ATELIER_INSTALL_TEST_HOME points it at a scratch home, with stand-in
// launchctl, lsof and curl on PATH. It reads owners with BSD stat, so those
// tests run on macOS only, as the Studio does.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { buildRelease, deployStudio, installerOf, parseArgs, sourceHead, verifyStudio } from "../scripts/ship-studio.mjs";

const INSTALLER = resolve("scripts/studio/install-server.sh");
const darwin = process.platform === "darwin" ? false : "the install script reads owners with BSD stat; macOS only";
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (name) => { const d = mkdtempSync(join(tmpdir(), `atelier-ship-studio-${name}-`)); dirs.push(d); return d; };
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };

// A checkout shaped like Atelier's, enough for a release: the server's entry
// point, the hooks, the install script, and jose as its one runtime package.
function checkout({ jose = "6.2.12", installed = jose } = {}) {
  const cwd = scratch("checkout");
  const git = (...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const put = (path, text) => { mkdirSync(join(cwd, path, ".."), { recursive: true }); writeFileSync(join(cwd, path), text); };
  put("cli/serve.mjs", "// the server\n");
  put("hooks/pre-receive", "#!/bin/sh\n");
  chmodSync(join(cwd, "hooks/pre-receive"), 0o755);
  put("scripts/studio/install-server.sh", readFileSync(INSTALLER, "utf8"));
  put("package.json", JSON.stringify({ name: "atelier", dependencies: { jose: `^${jose}` } }));
  put("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/jose": { version: jose } } }));
  put(".gitignore", "node_modules/\n");
  put("node_modules/jose/package.json", JSON.stringify({ name: "jose", version: installed }));
  put("node_modules/jose/dist/index.js", "export {};\n");
  put("node_modules/typescript/package.json", JSON.stringify({ name: "typescript", version: "7.0.0" }));
  git("add", "."); git("commit", "-qm", "first");
  const commit = (path, text) => { put(path, text); git("add", "."); git("commit", "-qm", `add ${path}`); return git("rev-parse", "HEAD"); };
  return { cwd, git, put, commit, head: () => git("rev-parse", "HEAD") };
}

// The Studio as the install script sees it in a test: a home holding the
// release that runs (with COMMIT `running`), the LaunchDaemon's plist, and
// stand-ins for launchctl, lsof, curl and sudo. The daemon is loaded while
// `loaded` exists; its /api/version answers the COMMIT of home/server unless
// that release holds BROKEN.
function studio(running = "1".repeat(40)) {
  const root = scratch("studio");
  const home = join(root, "home"), bin = join(root, "bin"), user = join(root, "pavi");
  for (const d of [home, join(home, "LaunchDaemons"), join(home, "server", "cli"), join(home, "log"), bin, user]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "server", "COMMIT"), `${running}\n`);
  writeFileSync(join(home, "server", "cli", "serve.mjs"), "// running\n");
  writeFileSync(join(home, "loaded"), "");
  const args = ["node", join(home, "server", "cli", "serve.mjs"), "--env", "staging", "--data", join(home, "data/staging"), "--host", "127.0.0.1", "--port", "4101"];
  writeFileSync(join(home, "LaunchDaemons", "zone.atelier.server.staging.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>zone.atelier.server.staging</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join("")}</array></dict></plist>
`);
  const tool = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\nh="$ATELIER_INSTALL_TEST_HOME"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  tool("launchctl", `echo "launchctl $*" >> "$h/launchctl.log"
case "$1" in print) [ -e "$h/loaded" ] ;; bootout) rm -f "$h/loaded" ;; bootstrap) : > "$h/loaded" ;; *) exit 2 ;; esac`);
  tool("lsof", `[ -e "$h/loaded" ]`);
  tool("curl", `[ -e "$h/loaded" ] || exit 7
[ -e "$h/server/BROKEN" ] && exit 22
printf '{"commit":"%s","main":null}' "$(cat "$h/server/COMMIT")"`);
  tool("sudo", `echo "sudo $*" >> "$h/sudo.log"
exec "$@"`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: user, ATELIER_INSTALL_TEST_HOME: home, ATELIER_INSTALL_TEST_WAIT: "2" };
  const install = (...argv) => spawnSync("/bin/bash", [INSTALLER, ...argv], { env, encoding: "utf8" });
  const commitOf = (dir) => (existsSync(join(home, dir, "COMMIT")) ? readFileSync(join(home, dir, "COMMIT"), "utf8").trim() : null);
  return { home, user, env, install, commitOf, loaded: () => existsSync(join(home, "loaded")) };
}

test("deploy takes --env staging or production and an optional --host; verify takes --version-url", () => {
  assert.deepEqual(parseArgs(["deploy", "--env", "staging"]), { action: "deploy", environment: "staging", host: undefined });
  assert.deepEqual(parseArgs(["deploy", "--env", "production", "--host", "ai-studio"]), { action: "deploy", environment: "production", host: "ai-studio" });
  assert.deepEqual(parseArgs(["verify", "--version-url", "https://atelier.zone/api/version"]), { action: "verify", versionUrl: "https://atelier.zone/api/version" });
  for (const argv of [[], ["deploy"], ["deploy", "--env"], ["deploy", "--env", "test"], ["deploy", "--env", "Staging"], ["deploy", "--env", "staging", "--host", "-oProxyCommand=x"],
    ["deploy", "--env", "staging", "--env", "production"], ["deploy", "--env", "staging", "--version-url", "https://x.test"], ["verify"], ["verify", "--version-url", "not a url"],
    ["verify", "--version-url", "file:///etc/passwd"], ["verify", "--env", "staging"], ["ship"]]) {
    assert.throws(() => parseArgs(argv), /Usage/, argv.join(" "));
  }
  assert.equal(installerOf("staging"), "/Users/atelierd/server/scripts/studio/install-server.sh");
  assert.equal(installerOf("production"), "/Users/atelierd/server-production/scripts/studio/install-server.sh");
});

test("the release is the captured commit's tree with the runtime packages, and nothing the checkout holds besides", () => {
  const c = checkout();
  c.put("untracked.txt", "not in the commit\n");
  const r = buildRelease({ cwd: c.cwd, head: c.head(), tmp: scratch("tmp") });
  dirs.push(r.dir);
  const listed = execFileSync("tar", ["-tf", r.tar], { encoding: "utf8" }).trim().split("\n");
  for (const path of ["cli/serve.mjs", "hooks/pre-receive", "scripts/studio/install-server.sh", "node_modules/jose/package.json", "node_modules/jose/dist/index.js"]) assert.ok(listed.some((p) => p === path || p === `${path}/`), path);
  assert.ok(!listed.some((p) => p.startsWith("untracked") || p.includes("typescript") || p.includes("._")), listed.join("\n"));
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
});

test("a release is refused when node_modules does not hold the version the lock file names, or holds a link", () => {
  const c = checkout({ jose: "6.2.12", installed: "6.0.0" });
  assert.throws(() => buildRelease({ cwd: c.cwd, head: c.head(), tmp: scratch("tmp") }), /node_modules\/jose is 6\.0\.0, not 6\.2\.12/);
  const d = checkout();
  symlinkSync("/etc/passwd", join(d.cwd, "node_modules/jose/dist/link"));
  assert.throws(() => buildRelease({ cwd: d.cwd, head: d.head(), tmp: scratch("tmp") }), /not a plain file/);
});

test("deploy refuses a checkout that is not at the captured commit, or not clean", () => {
  const c = checkout();
  assert.throws(() => sourceHead({ cwd: c.cwd, env: {} }), /ATELIER_SHIP_HEAD/);
  assert.throws(() => sourceHead({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: "a".repeat(40) } }), /moved/);
  c.put("dirty.txt", "x");
  assert.throws(() => deployStudio({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: c.head() }, environment: "staging", run: () => assert.fail("nothing runs") }), /uncommitted changes/);
});

test("with --host the release goes over ssh and sudo gets the terminal through ssh -t; the copy is removed after", (t) => {
  const c = checkout();
  const calls = [];
  const run = (cmd, args, options) => {
    calls.push({ cmd, args, stdio: options.stdio, bytes: options.input?.length ?? 0 });
    if (args.at(-1)?.includes("cat > ")) return { status: 0, stdout: "/Users/pavi/Library/Caches/atelier/releases\n" };
    return { status: 0 };
  };
  const head = c.head();
  assert.equal(deployStudio({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: head }, environment: "production", host: "ai-studio", run, tmp: scratch("tmp") }), head);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args.slice(0, 3), ["-o", "BatchMode=yes", "ai-studio"]);
  assert.ok(calls[0].bytes > 0, "the release goes on ssh's standard input");
  assert.equal(calls[1].cmd, "ssh");
  assert.equal(calls[1].stdio, "inherit", "the install has the terminal");
  assert.deepEqual(calls[1].args.slice(0, 2), ["-t", "ai-studio"]);
  assert.match(calls[1].args[2], new RegExp(`^'sudo' '/bin/bash' '/Users/atelierd/server-production/scripts/studio/install-server.sh' '--env' 'production' '--release' '/Users/pavi/Library/Caches/atelier/releases/production-${head}\\.tar' '--sha256' '[0-9a-f]{64}' '--commit' '${head}'$`));
  assert.equal(calls[2].args.at(-1), `rm -f '/Users/pavi/Library/Caches/atelier/releases/production-${head}.tar'`);
});

test("an installed release with no install script (bash's 127) says how to install by hand once, and keeps the copy for it", () => {
  const c = checkout();
  const calls = [];
  const run = (cmd, args) => { calls.push(args); return args.at(-1)?.includes("cat > ") ? { status: 0, stdout: "/Users/pavi/Library/Caches/atelier/releases\n" } : { status: 127 }; };
  assert.throws(() => deployStudio({ cwd: c.cwd, env: { ATELIER_SHIP_HEAD: c.head() }, environment: "staging", host: "ai-studio", run, tmp: scratch("tmp") }),
    /predate install-server\.sh.*sudo bash scripts\/studio\/install-server\.sh --env staging --release \/Users\/pavi\/Library\/Caches\/atelier\/releases\/staging-[0-9a-f]{40}\.tar --sha256 [0-9a-f]{64} --commit [0-9a-f]{40}/s);
  assert.equal(calls.length, 2, "no rm after a 127");
});

test("verify passes only when the live commit is the one shipped, and refuses a redirect or a bad status", async () => {
  const c = checkout();
  const head = c.head();
  const env = { ATELIER_SHIP_HEAD: head };
  const answer = (body, status = 200) => async (url, options) => { assert.equal(options.redirect, "error"); return Response.json(body, { status }); };
  assert.equal(await verifyStudio({ cwd: c.cwd, env, versionUrl: "https://next.atelier.zone/api/version", fetchImpl: answer({ commit: head }) }), head);
  await assert.rejects(verifyStudio({ cwd: c.cwd, env, versionUrl: "https://next.atelier.zone/api/version", fetchImpl: answer({ commit: null }), windowMs: 0 }), /live commit null .* does not match/);
  await assert.rejects(verifyStudio({ cwd: c.cwd, env, versionUrl: "https://next.atelier.zone/api/version", fetchImpl: answer({}, 502) }), /HTTP 502/);
  await assert.rejects(verifyStudio({ cwd: c.cwd, env, versionUrl: "https://next.atelier.zone/api/version", fetchImpl: answer([head]) }), /JSON object/);
  // A mismatch is retried within the window.
  let n = 0;
  const later = async () => Response.json({ commit: n++ < 2 ? "b".repeat(40) : head });
  assert.equal(await verifyStudio({ cwd: c.cwd, env, versionUrl: "https://x.test/api/version", fetchImpl: later, sleep: async () => {}, windowMs: 60_000 }), head);
});

test("ship's deploy, through a stand-in sudo, installs the release: COMMIT is the shipped commit, the old release is kept for rollback, and the daemon was restarted", { skip: darwin }, () => {
  const c = checkout(), s = studio();
  const head = c.head();
  deployStudio({ cwd: c.cwd, env: { ...s.env, ATELIER_SHIP_HEAD: head }, environment: "staging", installer: INSTALLER, tmp: scratch("tmp") });
  assert.equal(s.commitOf("server"), head);
  assert.equal(s.commitOf("server.prev"), "1".repeat(40));
  assert.ok(s.loaded());
  assert.ok(existsSync(join(s.home, "server/node_modules/jose/package.json")));
  const launchctl = readFileSync(join(s.home, "launchctl.log"), "utf8");
  assert.match(launchctl, /launchctl bootout system\/zone\.atelier\.server\.staging\n(?:.*\n)*launchctl bootstrap system .*zone\.atelier\.server\.staging\.plist/);
  const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(readFileSync(join(s.home, "sudo.log"), "utf8"), new RegExp(`^sudo /bin/bash ${esc(INSTALLER)} --env staging --release ${esc(realpathSync(s.user))}/Library/Caches/atelier/releases/staging-${head}\\.tar --sha256 [0-9a-f]{64} --commit ${head}\\n$`));
  // The copy in the developer's directory is gone.
  assert.ok(!existsSync(join(s.user, `Library/Caches/atelier/releases/staging-${head}.tar`)));
  // The release is read-only to its group and others have nothing.
  const mode = (p) => (execFileSync("stat", ["-f", "%Lp", join(s.home, p)], { encoding: "utf8" }).trim());
  assert.equal(mode("server/cli/serve.mjs"), "640");
  assert.equal(mode("server/hooks/pre-receive"), "750");
  assert.equal(mode("server/COMMIT"), "640");

  // Rollback swaps the two, and can itself be rolled back.
  const back = s.install("--env", "staging", "--rollback");
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stdout, new RegExp(`rolled staging back to commit ${"1".repeat(40)}; the release it replaced \\(${head}\\) is kept`));
  assert.equal(s.commitOf("server"), "1".repeat(40));
  assert.equal(s.commitOf("server.prev"), head);
  const forward = s.install("--env", "staging", "--rollback");
  assert.equal(forward.status, 0, forward.stderr);
  assert.equal(s.commitOf("server"), head);
});

test("a release that does not report its commit is taken out: the previous one is put back, answers, and the ship's deploy fails saying so", { skip: darwin }, () => {
  const c = checkout(), s = studio();
  const good = c.head();
  deployStudio({ cwd: c.cwd, env: { ...s.env, ATELIER_SHIP_HEAD: good }, environment: "staging", installer: INSTALLER, tmp: scratch("tmp") });
  const broken = c.commit("BROKEN", "this release never answers\n");
  assert.throws(() => deployStudio({ cwd: c.cwd, env: { ...s.env, ATELIER_SHIP_HEAD: broken }, environment: "staging", installer: INSTALLER, tmp: scratch("tmp") }), /The install on the Studio failed \(exit 1\)/);
  assert.equal(s.commitOf("server"), good, "the previous release is back");
  assert.equal(s.commitOf("server.failed"), broken, "the failed one is kept to look at");
  assert.ok(s.loaded(), "the daemon runs again");
  // Its words, straight from the script.
  const r = s.install("--env", "staging", "--rollback");
  assert.notEqual(r.status, 0, "after a put-back there is no previous release to roll back to");
  assert.match(r.stderr, /there is no previous release to roll back to/);
});

test("the install script says what it put back when the new release does not answer", { skip: darwin }, () => {
  const c = checkout(), s = studio();
  const broken = c.commit("BROKEN", "x\n");
  const r = buildRelease({ cwd: c.cwd, head: broken, tmp: scratch("tmp") });
  dirs.push(r.dir);
  const out = s.install("--env", "staging", "--release", r.tar, "--sha256", r.sha256, "--commit", broken);
  assert.equal(out.status, 1);
  assert.match(out.stderr, new RegExp(`staging did not report commit ${broken}`));
  assert.match(out.stderr, /putting the previous release back/);
  assert.match(out.stderr, new RegExp(`staging answers again at commit ${"1".repeat(40)}, the release that ran before; the release that failed is kept as .*server\\.failed`));
});

test("the install refuses, changing nothing and leaving the daemon running, a release whose hash is not the one ship built, one with a link, or arguments out of shape", { skip: darwin }, () => {
  const c = checkout(), s = studio();
  const head = c.head();
  const r = buildRelease({ cwd: c.cwd, head, tmp: scratch("tmp") });
  dirs.push(r.dir);
  const wrong = s.install("--env", "staging", "--release", r.tar, "--sha256", "0".repeat(64), "--commit", head);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /SHA-256 is [0-9a-f]{64}, not 0{64} as ship built it; nothing was changed/);
  assert.equal(s.commitOf("server"), "1".repeat(40));
  assert.ok(s.loaded());
  assert.ok(!existsSync(join(s.home, "launchctl.log")), "the daemon was never stopped");

  const linked = scratch("linked");
  mkdirSync(join(linked, "cli"));
  writeFileSync(join(linked, "cli/serve.mjs"), "");
  symlinkSync("/etc/passwd", join(linked, "passwd"));
  const tar = join(linked, "..", `${linked.split("/").pop()}.tar`);
  dirs.push(tar);
  execFileSync("tar", ["-cf", tar, "-C", linked, "cli", "passwd"]);
  const sha = execFileSync("shasum", ["-a", "256", tar], { encoding: "utf8" }).split(" ")[0];
  const link = s.install("--env", "staging", "--release", tar, "--sha256", sha, "--commit", head);
  assert.equal(link.status, 1);
  assert.match(link.stderr, /something other than files and directories/);

  for (const argv of [["--env", "test", "--rollback"], ["--env", "staging"], ["--env", "staging", "--release", r.tar, "--sha256", r.sha256, "--commit", "main"], ["--env", "staging", "--rollback", "--commit", head], ["--env"]]) {
    const bad = s.install(...argv);
    assert.equal(bad.status, 1, argv.join(" "));
  }
  assert.equal(s.commitOf("server"), "1".repeat(40));
});

test("the install script runs only as root, unless a test names its scratch home", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ATELIER_INSTALL_TEST")));
  const r = spawnSync("/bin/bash", [INSTALLER, "--env", "staging", "--rollback"], { env, encoding: "utf8" });
  if (process.getuid?.() === 0) return;
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run as root \(sudo\)/);
});
