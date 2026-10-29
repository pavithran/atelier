// scripts/studio/setup-server.sh and setup-tunnel.sh (Atelier 2.0, task 9):
// staging's setup and tunnel, as run on 2026-10-28, are kept exactly, and
// production is the same with its own port, daemon, code and data. The
// scripts that ran are kept in test/fixtures/studio/ to compare with: the
// dry runs (DRYRUN=1, no root) print the same commands, and the staging
// LaunchDaemon's plist is the same bytes. The scripts use BSD stat, otool and
// plutil, so this runs on macOS only, as the Studio does. Every script in
// scripts/studio/ parses (bash -n).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, realpathSync, symlinkSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const darwin = process.platform === "darwin" ? false : "the setup scripts use BSD stat, otool and plutil; macOS only";
const root = realpathSync(mkdtempSync(join(tmpdir(), "atelier-setup-server-")));
after(() => rmSync(root, { recursive: true, force: true }));
const OLD_SETUP = resolve("test/fixtures/studio/setup-staging-2026-10-28.sh");
const OLD_TUNNEL = resolve("test/fixtures/studio/setup-tunnel-2026-10-28.sh");
const SETUP = resolve("scripts/studio/setup-server.sh");
const TUNNEL = resolve("scripts/studio/setup-tunnel.sh");
const PROD_AUD = "ab".repeat(32);

// A release the setup accepts, and a binary that links only system
// libraries to stand for node and cloudflared (a dry run never runs it).
function inputs() {
  const rel = join(root, "rel");
  for (const d of ["cli", "hooks", "node_modules/jose", "scripts/studio"]) mkdirSync(join(rel, d), { recursive: true });
  writeFileSync(join(rel, "cli/serve.mjs"), "");
  writeFileSync(join(rel, "hooks/pre-receive"), "");
  writeFileSync(join(rel, "node_modules/jose/package.json"), "{}");
  writeFileSync(join(rel, "scripts/studio/install-server.sh"), "#!/bin/bash\n");
  const tar = join(root, "rel.tar");
  const made = spawnSync("tar", ["-cf", tar, "-C", rel, "cli", "hooks", "node_modules", "scripts"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  assert.equal(made.status, 0);
  const creds = join(root, "creds.json");
  writeFileSync(creds, JSON.stringify({ AccountTag: "a", TunnelSecret: "s", TunnelID: "2293602a-6d93-433d-827d-f77084d2d9b2" }));
  return { tar, bin: "/bin/ls", token: join(root, "token"), creds };
}

const env = () => {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "SUDO_USER" && k !== "ATELIER_BIND"));
  return { ...e, DRYRUN: "1" };
};
const dry = (script, args) => {
  // Redirect only the dry-run scratch path, including immutable fixtures,
  // so the tests work under a workspace sandbox that excludes /var/tmp.
  const copy = join(root, script === SETUP ? "setup-server.sh" : script.split("/").at(-1));
  writeFileSync(copy, readFileSync(script, "utf8").replaceAll("/var/tmp/atelier-", `${root}/atelier-`));
  const r = spawnSync("/bin/bash", ["-p", copy, ...args], { env: env(), encoding: "utf8" });
  // Each run's scratch directory has its own random name.
  const norm = (text) => text.replace(new RegExp(`${root}/atelier-(setup|tunnel)\\.[A-Za-z0-9]+`, "g"), "/var/tmp/atelier-$1.X");
  return { status: r.status, out: norm(r.stdout), err: norm(r.stderr) };
};

test("every Studio script parses", () => {
  for (const name of readdirSync("scripts/studio").filter((n) => n.endsWith(".sh"))) {
    const r = spawnSync("/bin/bash", ["-n", join("scripts/studio", name)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});

test("setup-server.sh --env staging makes the user, directories, token and LaunchDaemon exactly as setup-staging.sh did on 2026-10-28", { skip: darwin }, () => {
  const i = inputs();
  const old = dry(OLD_SETUP, [i.tar, i.bin, i.token]);
  const now = dry(SETUP, ["--env", "staging", i.tar, i.bin, i.token]);
  assert.equal(old.status, 0, old.err);
  assert.equal(now.status, 0, now.err);
  const oldLines = old.out.split("\n"), nowLines = now.out.split("\n");
  // The account and directories, up to the log directory, are the same.
  const upTo = oldLines.indexOf("+ chmod 700 /Users/atelierd/log") + 1;
  assert.ok(upTo > 10);
  assert.deepEqual(nowLines.filter((l) => !l.startsWith("+ (stop every")).slice(0, upTo), oldLines.slice(0, upTo));
  // So are the token and the LaunchDaemon at the end.
  assert.deepEqual(nowLines.slice(-4), oldLines.slice(-4));
});

test("the staging LaunchDaemon keeps its settings and uses the verified Command Line Tools for git", { skip: darwin }, () => {
  // The old script's heredoc, filled in as it filled it.
  const text = readFileSync(OLD_SETUP, "utf8");
  const heredoc = /\ncat > "\$WORK\/plist" <<PLIST\n([\s\S]*?)\nPLIST\n/.exec(text)[1];
  const vars = { SVC: "atelierd", HOME_DIR: "/Users/atelierd", LABEL: "zone.atelier.server.staging", BIND: "100.99.0.102", PORT: "4101" };
  const expected = heredoc.replace(/\$([A-Z_]+)/g, (_, name) => vars[name]) + "\n";
  const out = join(root, "staging.plist");
  const r = spawnSync("/bin/bash", ["-p", "-c", `SETUP_SERVER_LIB=1 source "$0" --env staging a b c && write_plist "$1"`, SETUP, out], { env: env(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, "utf8"), expected.replace("bin:/usr/bin:", "bin:/Library/Developer/CommandLineTools/usr/bin:/usr/bin:"));
});

test("production is set up the same way with port 4100, zone.atelier.server, server-production and its own data, repositories, secrets, token and log", { skip: darwin }, () => {
  const i = inputs();
  const now = dry(SETUP, ["--env", "production", i.tar, i.bin, i.token]);
  assert.equal(now.status, 0, now.err);
  assert.match(now.out, /cp -R \S+ \/Users\/atelierd\/server-production\.new\n/);
  assert.match(now.out, /mv \/Users\/atelierd\/server-production\.new \/Users\/atelierd\/server-production\n/);
  assert.match(now.out, /make \/Users\/atelierd\/secrets\/production\/ATELIER_TOKEN if missing/);
  assert.match(now.out, /launchctl bootstrap system \/Library\/LaunchDaemons\/zone\.atelier\.server\.plist\n$/);
  assert.match(now.out, /\+ \(stop every loaded job of zone\.atelier\.server\.staging zone\.atelier\.server zone\.atelier\.tunnel /);
  assert.doesNotMatch(now.out.split("\n").filter((l) => !l.startsWith("+ (stop every")).join("\n"), /zone\.atelier\.server\.staging|\/Users\/atelierd\/server[ .\n]|secrets\/staging\/ATELIER_TOKEN/);
  const out = join(root, "production.plist");
  const r = spawnSync("/bin/bash", ["-p", "-c", `SETUP_SERVER_LIB=1 source "$0" --env production a b c && write_plist "$1"`, SETUP, out], { env: env(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const plist = readFileSync(out, "utf8");
  for (const piece of ["<string>zone.atelier.server</string>", "<string>/Users/atelierd/server-production/cli/serve.mjs</string>", "<string>--env</string><string>production</string>",
    "<string>/Users/atelierd/data/production</string>", "<string>/Users/atelierd/repos/production</string>", "<string>/Users/atelierd/secrets/production</string>",
    "<string>--port</string><string>4100</string>", "<string>/Users/atelierd/log/production.log</string>", "<string>http://100.99.0.102:4100</string>"]) assert.ok(plist.includes(piece), piece);
  assert.doesNotMatch(plist, /staging|4101/);
  assert.equal(spawnSync("plutil", ["-lint", out]).status, 0);
});

test("setup installs the sibling installer, never the release's installer", { skip: darwin }, () => {
  const i = inputs();
  writeFileSync(join(root, "rel/scripts/studio/install-server.sh"), "malicious archive installer");
  assert.equal(spawnSync("tar", ["-cf", i.tar, "-C", join(root, "rel"), "cli", "hooks", "node_modules", "scripts"], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).status, 0);
  for (const envName of ["staging", "production"]) {
    const now = dry(SETUP, ["--env", envName, i.tar, i.bin, i.token]);
    assert.equal(now.status, 0, now.err);
    assert.ok(now.out.includes(`install -o root -g wheel -m 755 ${root}/install-server.sh /Library/Atelier/install-server.sh.new`));
    assert.doesNotMatch(now.out, /install .*server\/scripts\/studio\/install-server/);
  }
  rmSync(join(root, "rel/scripts"), { recursive: true });
  assert.equal(spawnSync("tar", ["-cf", i.tar, "-C", join(root, "rel"), "cli", "hooks", "node_modules"], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).status, 0);
  const absent = dry(SETUP, ["--env", "staging", i.tar, i.bin, i.token]);
  assert.equal(absent.status, 0, absent.err);
  const text = readFileSync(SETUP, "utf8");
  assert.ok(text.indexOf('trusted_source "$SOURCE"') < text.indexOf('WORK=$(mktemp'));
  assert.doesNotMatch(text, /release lacks scripts\/studio\/install-server/);
});

test("trusted setup source checks every parent, both files, symlinks and ACLs; refusal explains the copy", { skip: darwin }, () => {
  const bin = join(root, "trust-bin"); mkdirSync(bin);
  for (const [name, body] of Object.entries({
    stat: `if [ "$3" = "$BAD_PATH" ]; then
      case "$BAD_KIND:$2" in owner:%Su) echo pavi; exit ;; mode:%Lp) echo 777; exit ;; esac
    fi
    case "$2" in %Su) echo root ;; %Lp) echo 755 ;; esac`,
    ls: `echo listing; [ "$2" != "$BAD_PATH" ] || [ "$BAD_KIND" != acl ] || echo ' 0: user:pavi allow write'`,
  })) { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); }
  const source = join(root, "trusted"); mkdirSync(source);
  for (const f of ["setup-server.sh", "install-server.sh"]) { writeFileSync(join(source, f), "reviewed"); chmodSync(join(source, f), 0o755); }
  const run = (path, extra = {}) => spawnSync("/bin/bash", ["-p", "-c", `SETUP_SERVER_LIB=1 source "$0" --env staging a b c
PATH="$1:$PATH"
trusted_source "$2" || { source_help; exit 1; }
GIT="$2" OTOOL=/bin/ls check_tools`, SETUP, bin, path], { env: { ...env(), ...extra }, encoding: "utf8" });
  assert.equal(run(join(source, "install-server.sh")).status, 0);
  for (const path of ["/", "/private", root, source, join(source, "setup-server.sh"), join(source, "install-server.sh")]) {
    for (const kind of ["owner", "mode", "acl"]) {
      const target = path.endsWith("setup-server.sh") ? path : join(source, "install-server.sh");
      const r = run(target, { BAD_PATH: path, BAD_KIND: kind });
      assert.equal(r.status, 1, `${path} ${kind}: ${r.stderr}`);
      assert.match(r.stderr, /sudo \/usr\/bin\/install -o root -g wheel -m 700 .*setup-server.sh .*install-server.sh \/private\/var\/root\//);
    }
  }
  symlinkSync(source, join(root, "source-link"));
  assert.equal(run(join(root, "source-link/install-server.sh")).status, 1);
  symlinkSync(join(source, "install-server.sh"), join(source, "linked-installer"));
  assert.equal(run(join(source, "linked-installer")).status, 1);
});

// Finding 5: bin/ is shared; node goes in beside cloudflared.
test("setup-server.sh puts node into bin/ beside what is there, and never removes or replaces bin/ itself", { skip: darwin }, () => {
  const i = inputs();
  for (const envName of ["staging", "production"]) {
    const now = dry(SETUP, ["--env", envName, i.tar, i.bin, i.token]);
    assert.equal(now.status, 0, now.err);
    assert.match(now.out, /\+ install -o root -g atelierd -m 750 \S+\/node \/Users\/atelierd\/bin\/node\.new\n/);
    assert.match(now.out, /\+ mv -f \/Users\/atelierd\/bin\/node\.new \/Users\/atelierd\/bin\/node\n/);
    for (const line of now.out.split("\n")) {
      assert.doesNotMatch(line, /^\+ (rm -rf|mv|mv -f) (.* )?\/Users\/atelierd\/bin( |$)/, line);
      assert.doesNotMatch(line, /cloudflared|bin\.new|bin\.old/, line);
    }
  }
});

test("setup-server.sh refuses without --env staging or production", { skip: darwin }, () => {
  const i = inputs();
  for (const args of [[i.tar, i.bin, i.token], ["--env", "test", i.tar, i.bin, i.token], ["--env", "staging", i.tar, i.bin]]) {
    const r = dry(SETUP, args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.err, /usage: setup-server\.sh --env staging\|production/);
  }
});

test("setup-tunnel.sh's staging step does exactly what it did on 2026-10-28", { skip: darwin }, () => {
  const i = inputs();
  const old = dry(OLD_TUNNEL, [i.bin, i.creds]);
  const now = dry(TUNNEL, [i.bin, i.creds]);
  assert.equal(old.status, 0, old.err);
  assert.equal(now.status, 0, now.err);
  assert.equal(now.out, old.out);
  assert.equal(now.err, old.err);
});

test("the production tunnel step adds atelier.zone beside next.atelier.zone, writes production's Access settings and origin, and touches DNS only with --route-dns", { skip: darwin }, () => {
  const i = inputs();
  const now = dry(TUNNEL, ["--production", i.bin, i.creds, PROD_AUD]);
  assert.equal(now.status, 0, now.err);
  assert.match(now.out, /\+ config\.yml:   - hostname: next\.atelier\.zone\n\+ config\.yml:     service: http:\/\/100\.99\.0\.102:4101\n\+ config\.yml:   - hostname: atelier\.zone\n\+ config\.yml:     service: http:\/\/100\.99\.0\.102:4100\n\+ config\.yml:   - service: http_status:404\n/);
  assert.match(now.out, /copy \/Library\/LaunchDaemons\/zone\.atelier\.server\.plist, set PUBLIC_ORIGIN to https:\/\/atelier\.zone/);
  for (const name of ["CF_ACCESS_ISS", "CF_ACCESS_AUD", "CF_ACCESS_OWNER_EMAIL"]) assert.match(now.out, new RegExp(`/Users/atelierd/secrets/production/${name}\\n`));
  assert.doesNotMatch(now.out, /secrets\/staging|zone\.atelier\.server\.staging/);
  assert.match(now.out, /launchctl bootstrap system \/Library\/LaunchDaemons\/zone\.atelier\.server\.plist\n/);
  assert.doesNotMatch(now.out, /route dns/);
  const dns = dry(TUNNEL, ["--production", i.bin, i.creds, PROD_AUD, "--route-dns", i.creds]);
  assert.equal(dns.status, 0, dns.err);
  assert.match(dns.out, /\+ sudo -H -u \S* \/bin\/ls tunnel --origincert \S+ route dns --overwrite-dns 2293602a-6d93-433d-827d-f77084d2d9b2 atelier\.zone\n$/);
});

test("the production tunnel step refuses a missing or malformed audience, staging's audience, and stray arguments", { skip: darwin }, () => {
  const i = inputs();
  for (const [args, why] of [
    [["--production", i.bin, i.creds], /usage/],
    [["--production", i.bin, i.creds, "not-an-aud"], /64-character audience tag/],
    [["--production", i.bin, i.creds, "9c4c4e50f2b98fdbe60e3baf8c3729dd56f6810b7a6d16505edd2606fb4fa6ec"], /staging's; production has its own/],
    [["--production", i.bin, i.creds, PROD_AUD, "--dns"], /usage/],
    [["--production", i.bin, i.creds, PROD_AUD, "--route-dns", join(root, "missing.pem")], /no origin certificate/],
  ]) {
    const r = dry(TUNNEL, args);
    assert.notEqual(r.status, 0, args.join(" "));
    assert.match(r.err, why, args.join(" "));
  }
});

// Finding 6: production's setup keeps "nothing of atelierd running": it
// stops every atelierd job, staging's server and the tunnel included, and
// starts again those that ran, on success and on a failure. Driven through
// the script's own functions (SETUP_SERVER_LIB=1) with a stand-in launchctl
// and pgrep, and the same for the tunnel script's.
function jobsHarness(loadedJobs) {
  const h = mkdtempSync(join(root, "jobs-"));
  const bin = join(h, "bin");
  mkdirSync(bin);
  mkdirSync(join(h, "state"));
  for (const job of loadedJobs) writeFileSync(join(h, "state", job), "");
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh
s="${h}/state"; echo "$*" >> "${h}/launchctl.log"
case "$1" in
  print) [ -e "$s/\${2#system/}" ] ;;
  bootout) rm -f "$s/\${2#system/}" ;;
  bootstrap) j=$(basename "$3" .plist); : > "$s/$j" ;;
esac
`);
  writeFileSync(join(bin, "pgrep"), `#!/bin/sh\n[ -n "$(ls "${h}/state")" ]\n`);
  for (const f of ["launchctl", "pgrep"]) spawnSync("chmod", ["755", join(bin, f)]);
  const log = () => readFileSync(join(h, "launchctl.log"), "utf8");
  const state = () => readdirSync(join(h, "state")).sort();
  return { h, bin, log, state };
}

test("production's setup stops every atelierd job, staging's server and the tunnel included, and starts again those that ran", { skip: darwin }, () => {
  const j = jobsHarness(["zone.atelier.server.staging", "zone.atelier.tunnel", "zone.atelier.backup.staging"]);
  const r = spawnSync("/bin/bash", ["-p", "-c", `SETUP_SERVER_LIB=1 source "$0" --env production a b c
PATH="${j.bin}:$PATH"
loaded=" zone.atelier.server.staging zone.atelier.tunnel zone.atelier.backup.staging"
stop_all || exit 3
ls "${j.h}/state" | wc -l | tr -d ' '
start_others`, SETUP], { env: env(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0", "nothing ran while it worked");
  assert.match(j.log(), /bootout system\/zone\.atelier\.server\.staging/);
  assert.match(j.log(), /bootout system\/zone\.atelier\.tunnel/);
  assert.deepEqual(j.state(), ["zone.atelier.backup.staging", "zone.atelier.server.staging", "zone.atelier.tunnel"]);
});

test("production's setup, failing midway, puts its code back and starts every job that ran", { skip: darwin }, () => {
  const j = jobsHarness(["zone.atelier.server.staging", "zone.atelier.tunnel"]);
  const home = join(j.h, "home");
  mkdirSync(join(home, "server-production.old"), { recursive: true });
  mkdirSync(join(home, "server-production"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "server-production.old", "COMMIT"), "old\n");
  writeFileSync(join(home, "server-production", "COMMIT"), "new\n");
  writeFileSync(join(home, "bin", "node.old"), "old node");
  writeFileSync(join(home, "bin", "node"), "new node");
  writeFileSync(join(home, "bin", "cloudflared"), "staging's tunnel");
  const r = spawnSync("/bin/bash", ["-p", "-c", `SETUP_SERVER_LIB=1 source "$0" --env production a b c
PATH="${j.bin}:$PATH"
HOME_DIR="${home}"
loaded=" zone.atelier.server.staging zone.atelier.tunnel"
stop_all || exit 3
stopped=1 swapped=1
recover`, SETUP], { env: env(), encoding: "utf8" });
  assert.match(r.stderr, /putting back what ran before/);
  assert.equal(readFileSync(join(home, "server-production", "COMMIT"), "utf8"), "old\n");
  assert.equal(readFileSync(join(home, "bin", "node"), "utf8"), "old node");
  assert.equal(readFileSync(join(home, "bin", "cloudflared"), "utf8"), "staging's tunnel", "the tunnel's binary is left as it was");
  assert.deepEqual(j.state(), ["zone.atelier.server.staging", "zone.atelier.tunnel"]);
});

test("the tunnel's production step stops every atelierd job, staging's server included, and starts again those that ran", { skip: darwin }, () => {
  const j = jobsHarness(["zone.atelier.server.staging", "zone.atelier.server", "zone.atelier.tunnel"]);
  const text = readFileSync(TUNNEL, "utf8");
  const fn = (name) => new RegExp(`\n(${name}\\(\\) \\{[\\s\\S]*?\\n\\})\n`).exec(text)[1];
  const jobs = /\n(JOBS="[^"]*")\n/.exec(text)[1];
  const r = spawnSync("/bin/bash", ["-p", "-c", `${jobs}\n${fn("stop_all")}\n${fn("start_loaded")}
SVC=atelierd
PATH="${j.bin}:$PATH"
loaded=" zone.atelier.server.staging zone.atelier.server zone.atelier.tunnel"
stop_all || exit 3
ls "${j.h}/state" | wc -l | tr -d ' '
launchctl bootstrap system /Library/LaunchDaemons/zone.atelier.server.plist
launchctl bootstrap system /Library/LaunchDaemons/zone.atelier.tunnel.plist
start_loaded zone.atelier.server zone.atelier.tunnel`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0");
  assert.match(j.log(), /bootout system\/zone\.atelier\.server\.staging/);
  assert.deepEqual(j.state(), ["zone.atelier.server", "zone.atelier.server.staging", "zone.atelier.tunnel"]);
  assert.equal(j.log().split("\n").filter((l) => l.startsWith("bootstrap")).length, 3, "each started once");
});

test("both privileged entry points ignore BASH_ENV and discard hostile root environment", () => {
  const h = mkdtempSync(join(root, "hostile-"));
  const marker = join(h, "ran");
  const bashEnv = join(h, "bash-env");
  writeFileSync(bashEnv, `echo executed > '${marker}'\n`);
  const hostile = { ...process.env, BASH_ENV: bashEnv, ENV: bashEnv, SHELLOPTS: "xtrace", PS4: `$(echo traced > '${marker}')`, DEVELOPER_DIR: h, HOME: h, PWD: h, NODE_OPTIONS: "--import=evil", DRYRUN: "1", ATELIER_BIND: "evil", SUDO_USER: "pavi" };
  for (const script of [SETUP, resolve("scripts/studio/install-server.sh")]) {
    const text = readFileSync(script, "utf8");
    assert.ok(text.startsWith("#!/bin/bash -p\n"));
    // Exercise the actual shebang before any argument validation.
    const executable = join(h, script === SETUP ? "setup" : "install");
    writeFileSync(executable, text); chmodSync(executable, 0o755);
    const whole = spawnSync(executable, [], { env: hostile, encoding: "utf8" });
    assert.equal(whole.status, 1, whole.stderr);
    const prelude = text.slice(text.indexOf('if builtin test "$EUID"'), text.indexOf("# Atelier 2.0")).replace('builtin test "$EUID" = 0', 'builtin true');
    const r = spawnSync("/bin/bash", ["-p", "-c", `${prelude}\n/usr/bin/env\npwd\numask`], { env: hostile, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    for (const key of ["BASH_ENV", "ENV", "DEVELOPER_DIR", "NODE_OPTIONS", "DRYRUN", "ATELIER_BIND", "SHELLOPTS", "PS4"]) assert.doesNotMatch(r.stdout, new RegExp(`^${key}=`, "m"));
    assert.match(r.stdout, /^HOME=\/var\/root$/m);
    assert.match(r.stdout, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m);
    assert.match(r.stdout, /\n\/\n0*77\n$/);
    assert.equal(spawnSync("test", ["-e", marker]).status, 1, "startup code never ran");
  }
});

test("node validation rejects script shims, empty libraries and otool errors even with exit zero", { skip: darwin }, () => {
  const h = mkdtempSync(join(root, "node-"));
  const shim = join(h, "node");
  writeFileSync(shim, "#!/bin/sh\nexec /opt/homebrew/bin/node \"$@\"\n");
  const tool = join(h, "otool");
  const run = (binary, body) => {
    writeFileSync(tool, `#!/bin/sh\n${body}\n`); chmodSync(tool, 0o755);
    return spawnSync("/bin/bash", ["-p", "-c", `SETUP_SERVER_LIB=1 source "$0" --env staging a b c\nWORK="$1" OTOOL="$2"\ncheck_node "$3"`, SETUP, h, tool, binary], { encoding: "utf8" });
  };
  const shimResult = run(shim, 'echo "$2: is not an object file"');
  assert.equal(shimResult.status, 1); assert.match(shimResult.stderr, /Mach-O executable/);
  for (const [body, why] of [
    ['echo "$2:"', /empty library list/],
    ['echo "$2:"; echo error >&2', /otool reported an error/],
    ['echo "$2: is not an object file"', /invalid node library/],
    ['echo "$2:"; printf "\\t/Users/pavi/lib.dylib (compatibility version 1.0.0)\\n"', /outside the system libraries/],
  ]) {
    const r = run("/bin/ls", body); assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, why);
  }
  const good = run("/bin/ls", 'echo "$2:"; printf "\\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\\n"');
  assert.equal(good.status, 0, good.stderr);
  const actual = spawnSync("/bin/bash", ["-p", "-c", 'SETUP_SERVER_LIB=1 source "$0" --env staging a b c; WORK="$1"; check_node /bin/ls', SETUP, h], { encoding: "utf8" });
  assert.equal(actual.status, 0, actual.stderr);
});

test("missing Command Line Tools fail with the installation command, and service commands use empty environments", () => {
  const r = spawnSync("/bin/bash", ["-p", "-c", 'SETUP_SERVER_LIB=1 source "$0" --env staging a b c; GIT=/absent/git; check_tools', SETUP], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /xcode-select --install/);
  for (const path of [SETUP, resolve("scripts/studio/install-server.sh")]) {
    const text = readFileSync(path, "utf8");
    assert.match(text, /GIT=\/Library\/Developer\/CommandLineTools\/usr\/bin\/git/);
    assert.match(text, /OTOOL=\/Library\/Developer\/CommandLineTools\/usr\/bin\/llvm-otool/);
    assert.match(text, /trusted_source "\$tool"/);
    assert.doesNotMatch(text, /GIT=\/usr\/bin\/git|^otool /m);
    assert.match(text, /-u "\$SVC" \/usr\/bin\/env -i HOME="\$HOME_DIR" PATH=/);
  }
});

test("setup takes the installer's shared lock and refuses unsafe parents or a live owner", { skip: darwin }, () => {
  const h = mkdtempSync(join(root, "lock-"));
  const script = `SETUP_SERVER_LIB=1 source "$0" --env staging a b c
LOCK_DIR="$1"
trusted_entry() { [ "$1" != "\${BAD_PARENT:-}" ]; }
stat() { echo root; }
acquire_lock
cat "$LOCK"
acquire_lock`;
  const r = spawnSync("/bin/bash", ["-p", "-c", script, SETUP, h], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /another installer is running/);
  assert.equal(readFileSync(join(h, "install.lock"), "utf8").trim(), r.stdout.trim());
  rmSync(join(h, "install.lock"));
  const unsafe = spawnSync("/bin/bash", ["-p", "-c", script, SETUP, h], { env: { ...process.env, BAD_PARENT: "/Library/Atelier" }, encoding: "utf8" });
  assert.equal(unsafe.status, 1); assert.match(unsafe.stderr, /unsafe lock directory/);
  assert.equal(spawnSync("test", ["-e", join(h, "install.lock")]).status, 1);
  for (const path of [SETUP, resolve("scripts/studio/install-server.sh")]) {
    const text = readFileSync(path, "utf8");
    assert.match(text, /\/Library\/Atelier\/lock/);
    assert.doesNotMatch(text, /\/private\/var\/run/);
  }
});

test("a shared node.old never causes setup to discard the other environment's current server", () => {
  const h = mkdtempSync(join(root, "saved-code-"));
  mkdirSync(join(h, "bin")); mkdirSync(join(h, "server-production"));
  writeFileSync(join(h, "bin/node.old"), "staging backup");
  writeFileSync(join(h, "server-production/COMMIT"), "working production");
  const r = spawnSync("/bin/bash", ["-p", "-c", 'SETUP_SERVER_LIB=1 source "$0" --env production a b c; HOME_DIR="$1"; backup_code', SETUP, h], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /saved code remains/);
  assert.equal(readFileSync(join(h, "server-production/COMMIT"), "utf8"), "working production");
  assert.equal(readFileSync(join(h, "bin/node.old"), "utf8"), "staging backup");
});

test("setup records recovery before either backup move and restores after a failed move", () => {
  for (const failAt of ["node.old", "server-production.old"]) {
    const h = mkdtempSync(join(root, "move-"));
    mkdirSync(join(h, "bin")); mkdirSync(join(h, "server-production"));
    writeFileSync(join(h, "bin/node"), "working node"); writeFileSync(join(h, "server-production/COMMIT"), "working server");
    const r = spawnSync("/bin/bash", ["-p", "-c", `SETUP_SERVER_LIB=1 source "$0" --env production a b c
HOME_DIR="$1"; DRYRUN=; stopped=1
run() { "$@"; }
# A failed move returns to the same EXIT recovery used by setup.
mv() { case "$2" in *${failAt}) return 1 ;; esac; /bin/mv "$@"; }
stop_all() { return 0; }; start_others() { return 0; }
trap 'recover' EXIT
backup_code`, SETUP, h], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(readFileSync(join(h, "bin/node"), "utf8"), "working node");
    assert.equal(readFileSync(join(h, "server-production/COMMIT"), "utf8"), "working server");
  }
});

test("setup recovery leaves code untouched if bootout fails, and reports a failed health check", () => {
  for (const failStop of [true, false]) {
    const h = mkdtempSync(join(root, "recover-"));
    mkdirSync(join(h, "server-production.old")); mkdirSync(join(h, "server-production"));
    writeFileSync(join(h, "server-production.old/COMMIT"), "old"); writeFileSync(join(h, "server-production/COMMIT"), "new");
    const r = spawnSync("/bin/bash", ["-p", "-c", `SETUP_SERVER_LIB=1 source "$0" --env production a b c
HOME_DIR="$1"; stopped=1; swapped=1; loaded=" $LABEL"
launchctl() { case "$1" in print) return 0 ;; bootout) return ${failStop ? 1 : 0} ;; bootstrap) return 0 ;; esac; }
${failStop ? "" : "stop_all() { return 0; }; health() { return 1; }"}
recover`, SETUP, h], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, failStop ? /bootout failed/ : /did not start or answer \/api\/version/);
    assert.equal(readFileSync(join(h, "server-production/COMMIT"), "utf8"), failStop ? "new" : "old");
  }
});

test("setup health checks /api/version and the restored commit", { skip: darwin }, () => {
  const h = mkdtempSync(join(root, "health-"));
  mkdirSync(join(h, "server"));
  const commit = "a".repeat(40);
  writeFileSync(join(h, "server/COMMIT"), commit);
  for (const [body, expected] of [[`{"commit":"${commit}"}`, 0], ['{"commit":"wrong"}', 1], ["not json", 1]]) {
    const r = spawnSync("/bin/bash", ["-p", "-c", `SETUP_SERVER_LIB=1 source "$0" --env staging a b c
HOME_DIR="$1" WORK="$1" CURL=fake_curl
lsof() { return 0; }; seq() { echo 1; }; sleep() { :; }
fake_curl() { [ "$1" = -q ] && [ "\${@: -1}" = "http://100.99.0.102:4101/api/version" ] || return 9; printf '%s' "$BODY"; }
health`, SETUP, h], { env: { ...process.env, BODY: body }, encoding: "utf8" });
    assert.equal(r.status, expected, r.stderr);
  }
});
