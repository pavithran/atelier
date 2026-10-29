import { dirname } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("repository hook wrappers execute Node by absolute path even with no node on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-hooks-"));
  try {
    const repo = ensureRepo({ reposDir: dir, key: "test", hooksDir: resolve("hooks"), branch: "main" });
    const wrappers = execFileSync(gitCommand(), ["-C", repo, "config", "core.hooksPath"], { encoding: "utf8" }).trim();
    const hook = join(wrappers, "post-receive");
    assert.ok(readFileSync(hook, "utf8").includes(process.execPath));
    execFileSync(hook, [], { input: "", env: { PATH: "/nonexistent" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the backup daemon supplies absolute Git configuration for shared snapshot code", () => {
  assert.match(readFileSync("scripts/studio/zone.atelier.backup.plist.template", "utf8"), /<key>ATELIER_GIT<\/key><string>\/Library\/Developer\/CommandLineTools\/usr\/bin\/git<\/string>/);
});
