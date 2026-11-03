import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("installer library sources with no lsof on PATH under errexit", { skip: process.getuid?.() === 0 ? "library mode requires a non-root caller" : false }, (t) => {
 const bin = mkdtempSync(join(tmpdir(), "atelier-install-server-lib-"));
 t.after(() => rmSync(bin, { recursive: true, force: true }));
 for (const tool of ["node", "git", "launchctl", "curl", "mv"]) {
  writeFileSync(resolve(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
 }
 const r = spawnSync("/bin/bash", ["-euc", 'source "$1" --env staging 1111111111111111111111111111111111111111; printf "library loaded\\n"', "bash", resolve("scripts/studio/install-server.sh")], {
  env: { ...process.env, PATH: bin, INSTALL_SERVER_LIB: "1" }, encoding: "utf8",
 });
 assert.equal(r.status, 0, r.stderr);
 assert.equal(r.stdout, "library loaded\n");
});
