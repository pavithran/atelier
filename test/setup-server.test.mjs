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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const darwin = process.platform === "darwin" ? false : "the setup scripts use BSD stat, otool and plutil; macOS only";
const root = mkdtempSync(join(tmpdir(), "atelier-setup-server-"));
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
  for (const d of ["cli", "hooks", "node_modules/jose"]) mkdirSync(join(rel, d), { recursive: true });
  writeFileSync(join(rel, "cli/serve.mjs"), "");
  writeFileSync(join(rel, "hooks/pre-receive"), "");
  writeFileSync(join(rel, "node_modules/jose/package.json"), "{}");
  const tar = join(root, "rel.tar");
  const made = spawnSync("tar", ["-cf", tar, "-C", rel, "cli", "hooks", "node_modules"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
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
  const r = spawnSync("/bin/bash", [script, ...args], { env: env(), encoding: "utf8" });
  // Each run's scratch directory has its own random name.
  const norm = (text) => text.replace(/\/var\/tmp\/atelier-(setup|tunnel)\.[A-Za-z0-9]+/g, "/var/tmp/atelier-$1.X");
  return { status: r.status, out: norm(r.stdout), err: norm(r.stderr) };
};

test("every Studio script parses", () => {
  for (const name of readdirSync("scripts/studio").filter((n) => n.endsWith(".sh"))) {
    const r = spawnSync("/bin/bash", ["-n", join("scripts/studio", name)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});

test("setup-server.sh --env staging does exactly what setup-staging.sh did on 2026-10-28", { skip: darwin }, () => {
  const i = inputs();
  const old = dry(OLD_SETUP, [i.tar, i.bin, i.token]);
  const now = dry(SETUP, ["--env", "staging", i.tar, i.bin, i.token]);
  assert.equal(old.status, 0, old.err);
  assert.equal(now.status, 0, now.err);
  assert.equal(now.out, old.out);
  assert.equal(now.err, old.err);
  assert.match(now.out, /install -o root -g wheel -m 644 \S+ \/Library\/LaunchDaemons\/zone\.atelier\.server\.staging\.plist/);
});

test("the staging LaunchDaemon's plist is the same bytes as the one setup-staging.sh wrote", { skip: darwin }, () => {
  // The old script's heredoc, filled in as it filled it.
  const text = readFileSync(OLD_SETUP, "utf8");
  const heredoc = /\ncat > "\$WORK\/plist" <<PLIST\n([\s\S]*?)\nPLIST\n/.exec(text)[1];
  const vars = { SVC: "atelierd", HOME_DIR: "/Users/atelierd", LABEL: "zone.atelier.server.staging", BIND: "100.99.0.102", PORT: "4101" };
  const expected = heredoc.replace(/\$([A-Z_]+)/g, (_, name) => vars[name]) + "\n";
  const out = join(root, "staging.plist");
  const r = spawnSync("/bin/bash", ["-c", `SETUP_SERVER_LIB=1 source "$0" --env staging a b c && write_plist "$1"`, SETUP, out], { env: env(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, "utf8"), expected);
});

test("production is set up the same way with port 4100, zone.atelier.server, server-production and its own data, repositories, secrets, token and log", { skip: darwin }, () => {
  const i = inputs();
  const now = dry(SETUP, ["--env", "production", i.tar, i.bin, i.token]);
  assert.equal(now.status, 0, now.err);
  assert.match(now.out, /cp -R \S+ \/Users\/atelierd\/server-production\.new\n/);
  assert.match(now.out, /mv \/Users\/atelierd\/server-production\.new \/Users\/atelierd\/server-production\n/);
  assert.match(now.out, /make \/Users\/atelierd\/secrets\/production\/ATELIER_TOKEN if missing/);
  assert.match(now.out, /launchctl bootstrap system \/Library\/LaunchDaemons\/zone\.atelier\.server\.plist\n$/);
  assert.doesNotMatch(now.out, /zone\.atelier\.server\.staging|\/Users\/atelierd\/server[ .\n]|secrets\/staging\/ATELIER_TOKEN/);
  const out = join(root, "production.plist");
  const r = spawnSync("/bin/bash", ["-c", `SETUP_SERVER_LIB=1 source "$0" --env production a b c && write_plist "$1"`, SETUP, out], { env: env(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const plist = readFileSync(out, "utf8");
  for (const piece of ["<string>zone.atelier.server</string>", "<string>/Users/atelierd/server-production/cli/serve.mjs</string>", "<string>--env</string><string>production</string>",
    "<string>/Users/atelierd/data/production</string>", "<string>/Users/atelierd/repos/production</string>", "<string>/Users/atelierd/secrets/production</string>",
    "<string>--port</string><string>4100</string>", "<string>/Users/atelierd/log/production.log</string>", "<string>http://100.99.0.102:4100</string>"]) assert.ok(plist.includes(piece), piece);
  assert.doesNotMatch(plist, /staging|4101/);
  assert.equal(spawnSync("plutil", ["-lint", out]).status, 0);
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
