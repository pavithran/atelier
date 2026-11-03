import { after, test } from "node:test";
import assert from "node:assert/strict";
import { remoteSuite, studioSuite } from "../scripts/ship-suite-studio.mjs";
import { SHIP_GIT } from "../scripts/ship-studio.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

test("the documented ship configuration matches the shipped configuration", () => {
 const docs = readFileSync("docs/ship.md", "utf8").split("### From `docs/atelier/ship.json`")[1];
 const example = JSON.parse(docs.match(/```json\n([\s\S]*?)\n```/)[1]);
 assert.deepEqual(example, JSON.parse(readFileSync("docs/atelier/ship.json", "utf8")));
});

test("studioSuite transfers the bundle over SSH and cleans up on success and failure", () => {
 const cwd = mkdtempSync(join(tmpdir(), "atelier-studio-suite-unit-"));
 after(() => rmSync(cwd, { recursive: true, force: true }));
 const git = (...args) => {
  const r = spawnSync(SHIP_GIT, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
 };
 git("init", "-q");
 git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "Fixture");
 const head = git("rev-parse", "HEAD");
 const env = { ATELIER_SHIP_HEAD: head, STUB_ENV: "preserved" };
 // Ignore the bundle while sourceHead checks that the fixture is clean.
 git("config", "core.excludesFile", "/dev/null");
 writeFileSync(resolve(cwd, ".git/info/exclude"), ".scratch/\n");
 for (const failure of ["", "bundle", "ssh-status", "ssh-error", "ssh-throw"]) {
  let bundle;
  const calls = [];
  const run = (command, args, options) => {
   calls.push(command);
   if (command === SHIP_GIT) {
    bundle = args[2];
    assert.deepEqual(args, ["bundle", "create", resolve(cwd, ".scratch", `ship-${process.pid}.bundle`), "HEAD"]);
    assert.deepEqual(options, { cwd, stdio: "inherit" });
    writeFileSync(bundle, "snapshot bytes");
    return { status: failure === "bundle" ? 7 : 0 };
   }
   assert.equal(command, "/usr/bin/ssh");
   const quoted = "'" + remoteSuite.replaceAll("'", "'\\''") + "'";
   assert.deepEqual(args, ["-o", "BatchMode=yes", "--", "ai-studio",
    `PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" node -e ${quoted} ${head}`]);
   assert.deepEqual(options, { input: Buffer.from("snapshot bytes"), stdio: ["pipe", "inherit", "inherit"], env, timeout: 59 * 60_000 });
   if (failure === "ssh-throw") throw new Error("stub threw");
   return { status: failure === "ssh-status" ? 7 : 0, error: failure === "ssh-error" ? new Error("offline") : undefined };
  };
  if (failure) assert.throws(() => studioSuite({ cwd, env, run }), /Cannot snapshot|Studio full suite failed|stub threw/);
  else assert.equal(studioSuite({ cwd, env, run }), head);
  assert.deepEqual(calls, failure === "bundle" ? [SHIP_GIT] : [SHIP_GIT, "/usr/bin/ssh"]);
  assert.equal(existsSync(bundle), false, `bundle remains after ${failure || "success"}`);
 }
});

test("Studio snapshot runs checkout, install and the whole suite in order; failures propagate", () => {
 const root = mkdtempSync(join(tmpdir(), "atelier-ship-suite-test-"));
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
 const root = mkdtempSync(join(tmpdir(), "atelier-ship-bundle-test-"));
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
