import { after, test } from "node:test";
import assert from "node:assert/strict";
import { remoteSuite } from "../scripts/ship-suite-studio.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

test("Studio snapshot runs checkout, install and the whole suite in order; failures propagate", () => {
 const root = resolve(".scratch/ship-suite-test");
 mkdirSync(root, { recursive: true });
 after(() => rmSync(root, { recursive: true, force: true }));
 const log = resolve(root, "calls");
 for (const command of ["git", "npm"]) {
 writeFileSync(resolve(root, command), `#!/bin/sh
echo "$*" >> "$CALL_LOG"
if [ "$1" = clone ]; then mkdir -p "$4"; fi
if [ "$1" = "$FAIL_AT" ]; then exit 7; fi
`, { mode: 0o755 });
 }
 for (const fail of ["ci", "test", "checkout", ""]) {
 writeFileSync(log, "");
 const r = spawnSync(process.execPath, ["-e", remoteSuite, "a".repeat(40)], { cwd: root, input: "bundle", encoding: "utf8",
 env: { ...process.env, PATH: root + ":" + process.env.PATH, CALL_LOG: log, FAIL_AT: fail } });
 assert.equal(r.status === 0, fail === "", r.stderr);
 const calls = readFileSync(log, "utf8");
 assert.match(calls, /checkout --quiet --detach a{40}/);
 if (fail === "checkout") assert.doesNotMatch(calls, /ci/);
 if (fail === "ci") assert.doesNotMatch(calls, /^test$/m);
 if (!fail) assert.match(calls, /ci --no-audit --no-fund\ntest\n$/);
 }
});

test("the transferred bundle checks out the exact source commit", () => {
 const root = resolve(".scratch/ship-bundle-test");
 mkdirSync(root, { recursive: true });
 after(() => rmSync(root, { recursive: true, force: true }));
 const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
 const bundle = resolve(root, "source.bundle");
 assert.equal(spawnSync("git", ["bundle", "create", bundle, "HEAD"]).status, 0);
 writeFileSync(resolve(root, "npm"), `#!/bin/sh
if [ "$1" = test ]; then git rev-parse HEAD; fi
`, { mode: 0o755 });
 const r = spawnSync(process.execPath, ["-e", remoteSuite, head], { cwd: root, input: readFileSync(bundle), encoding: "utf8",
 env: { ...process.env, PATH: root + ":" + process.env.PATH } });
 assert.equal(r.status, 0, r.stderr);
 assert.match(r.stdout, new RegExp("^" + head + "$", "m"));
});
