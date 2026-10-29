import { dirname } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { gitCommand, HOOK_PATH, SYSTEM_PATH } from "../src/git/command.mjs";
import { backendEnv } from "../src/git/http.mjs";
import { ensureRepo } from "../src/git/repos.mjs";

test("Git configuration is absolute and mandatory for effective root or atelierd", () => {
  assert.equal(gitCommand({ env: {}, uid: 501, username: "pavi" }), "git");
  for (const [uid, username] of [[0, "root"], [450, "atelierd"]]) {
    assert.throws(() => gitCommand({ env: {}, uid, username }), /required/);
    assert.equal(gitCommand({ env: { ATELIER_GIT: "/trusted/git" }, uid, username }), "/trusted/git");
  }
  assert.throws(() => gitCommand({ env: { ATELIER_GIT: "git" }, uid: 501 }), /absolute/);
  const env = backendEnv({ grant: {}, scan: {}, hook: {} });
  assert.equal(env.PATH, HOOK_PATH);
  assert.equal(env.PATH, `${dirname(process.execPath)}:${SYSTEM_PATH}`);
  assert.doesNotMatch(SYSTEM_PATH, /homebrew|\/usr\/local/);
  const previous = process.env.ATELIER_GIT;
  try {
    process.env.ATELIER_GIT = "/trusted/git";
    assert.equal(backendEnv({ grant: {} }).ATELIER_GIT, "/trusted/git");
  } finally {
    if (previous === undefined) delete process.env.ATELIER_GIT; else process.env.ATELIER_GIT = previous;
  }
});

test("repositories name the shared hooks by absolute path and run them with the trusted Node PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-hooks-"));
  try {
    const repo = ensureRepo({ reposDir: dir, key: "test", hooksDir: "hooks", branch: "main" });
    const hooks = execFileSync(gitCommand(), ["-C", repo, "config", "core.hooksPath"], { encoding: "utf8" }).trim();
    assert.equal(hooks, resolve("hooks"));
    assert.equal(existsSync(join(repo, "atelier-hooks")), false);
    execFileSync(gitCommand(), ["-C", repo, "hook", "run", "post-receive"], { input: "", env: { PATH: HOOK_PATH } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Git honors a shared shell hook's interpreter without rewriting its bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-shell-hook-"));
  try {
    const hooksDir = join(dir, "recording-hooks"), dump = join(dir, "env.json");
    mkdirSync(hooksDir);
    const hook = join(hooksDir, "pre-receive");
    const source = `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'const fs = require("fs"); fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env))'\ncat >/dev/null\n`;
    writeFileSync(hook, source); chmodSync(hook, 0o700);
    const repo = ensureRepo({ reposDir: dir, key: "test", hooksDir, branch: "main" });
    execFileSync(gitCommand(), ["-C", repo, "hook", "run", "pre-receive"], { input: "", env: { PATH: HOOK_PATH, ATELIER_TEST_MARKER: "shell hook ran" } });
    assert.equal(JSON.parse(readFileSync(dump, "utf8")).ATELIER_TEST_MARKER, "shell hook ran");
    assert.equal(readFileSync(hook, "utf8"), source);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the backup daemon supplies absolute Git configuration for shared snapshot code", () => {
  assert.match(readFileSync("scripts/studio/zone.atelier.backup.plist.template", "utf8"), /<key>ATELIER_GIT<\/key><string>\/Library\/Developer\/CommandLineTools\/usr\/bin\/git<\/string>/);
});
