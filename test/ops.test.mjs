import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli/atelier.mjs", import.meta.url));

// A stand-in toolkit that prints the arguments it received and exits 7.
function toolkit(dir) {
  const exe = join(dir, "atelier-ops");
  writeFileSync(exe, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 7\n');
  chmodSync(exe, 0o755);
  return exe;
}

const run = (argv, env) => spawnSync(process.execPath, [cli, ...argv], {
  encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, ATELIER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "atelier-ops-cfg-")), ...env },
});

test("atelier ops hands every argument, --help included, to the toolkit and exits with its status", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ops-"));
  try {
    const exe = toolkit(dir);
    const r = run(["ops", "audit", "record", "--write", "--help", "a b"], { ATELIER_OPS: exe });
    assert.equal(r.status, 7, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"), ["audit", "record", "--write", "--help", "a b"]);
    const onPath = run(["ops", "fleet"], { PATH: `${dir}:/usr/bin:/bin` });
    assert.equal(onPath.status, 7, onPath.stderr);
    assert.equal(onPath.stdout.trim(), "fleet");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("without the toolkit, atelier ops says what is missing and exits 2", () => {
  const r = run(["ops", "fleet"], {});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /atelier-ops, which is not installed on this machine/);
  const named = run(["ops", "fleet"], { ATELIER_OPS: "/nonexistent/atelier-ops" });
  assert.equal(named.status, 2);
});

// t360: --version is answered here first, like every other command, and never
// reaches the toolkit, even with one installed.
test("atelier ops --version prints the version and the toolkit never runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ops-"));
  try {
    const exe = toolkit(dir);
    const r = run(["ops", "--version"], { ATELIER_OPS: exe });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^atelier \d+\.\d+\.\d+ \(route level \d+\)\n$/);
    assert.equal(r.stderr, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("arguments the CLI's own parser would read reach the toolkit untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ops-"));
  try {
    const exe = toolkit(dir);
    for (const argv of [["--_", "fleet"], ["--multi", "x", "--write"], ["fleet", "ops", "--project", "ops"], ["--help"]]) {
      const r = run(["ops", ...argv], { ATELIER_OPS: exe });
      assert.equal(r.status, 7, `${argv.join(" ")}: ${r.stderr}`);
      assert.deepEqual(r.stdout.trim().split("\n"), argv);
    }
    const notFirst = run(["--project", "x", "ops", "fleet"], { ATELIER_OPS: exe });
    assert.equal(notFirst.status, 2);
    assert.match(notFirst.stderr, /put ops first/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only an executable file counts: a directory or a plain file earlier on PATH is passed over", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ops-"));
  try {
    const asDir = join(dir, "a"), plain = join(dir, "b"), good = join(dir, "c");
    mkdirSync(join(asDir, "atelier-ops"), { recursive: true });
    mkdirSync(plain); writeFileSync(join(plain, "atelier-ops"), "#!/bin/sh\nexit 9\n");
    mkdirSync(good); toolkit(good);
    const r = run(["ops", "fleet"], { PATH: `${asDir}:${plain}:${good}:/usr/bin:/bin` });
    assert.equal(r.status, 7, r.stderr);
    // An empty PATH entry is the current directory, found before later entries.
    const here = spawnSync(process.execPath, [cli, "ops", "fleet"], { cwd: good, encoding: "utf8", env: { PATH: `:${plain}:/usr/bin:/bin`, HOME: process.env.HOME } });
    assert.equal(here.status, 7, here.stderr);
    // A relative ATELIER_OPS is the file it names from here, never a PATH lookup.
    const rel = spawnSync(process.execPath, [cli, "ops", "fleet"], { cwd: good, encoding: "utf8", env: { PATH: `${plain}:/usr/bin:/bin`, HOME: process.env.HOME, ATELIER_OPS: "atelier-ops" } });
    assert.equal(rel.status, 7, rel.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a toolkit ended by a signal ends atelier ops the same way", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ops-"));
  try {
    const exe = join(dir, "atelier-ops");
    writeFileSync(exe, "#!/bin/sh\nkill -TERM $$\n");
    chmodSync(exe, 0o755);
    const r = run(["ops", "fleet"], { ATELIER_OPS: exe });
    assert.equal(r.signal, "SIGTERM");
    // Signals Node will not die of come back as the shell's 128 + number.
    for (const [sig, num] of [["PIPE", 13], ["USR1", 30]]) {
      writeFileSync(exe, `#!/bin/sh\nkill -${sig} $$\n`);
      const q = run(["ops", "fleet"], { ATELIER_OPS: exe });
      assert.ok(q.signal === `SIG${sig}` || q.status === 128 + num, `${sig}: status ${q.status}, signal ${q.signal}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
