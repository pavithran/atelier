import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
