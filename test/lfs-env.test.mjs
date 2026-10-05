import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../cli/atelier.mjs";

test("every push skips LFS uploads, and only a clone skips downloads", () => {
  const env = gitEnv({ PATH: "/bin", GIT_LFS_SKIP_PUSH: "0" }, { GIT_AUTHOR_NAME: "A" }, ["push", "origin", "main"]);
  assert.equal(env.GIT_LFS_SKIP_PUSH, "1", "the CLI's setting wins over the caller's environment");
  assert.equal(env.GIT_LFS_SKIP_SMUDGE, undefined, "a push, a merge or a reset in the owner's checkout writes real LFS files");
  assert.equal(gitEnv({}, {}, ["merge", "--no-ff", "x"]).GIT_LFS_SKIP_SMUDGE, undefined);
  assert.equal(gitEnv({}, {}, ["-c", "http.extraHeader=x", "clone", "--quiet", "url", "dir"]).GIT_LFS_SKIP_SMUDGE, "1", "a clone is a disposable copy and keeps pointers");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_AUTHOR_NAME, "A");
  assert.equal(env.PATH, "/bin");
});

test("a pre-push hook that refuses unless LFS uploads are skipped lets the CLI's push through", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-lfs-"));
  try {
    const remote = join(dir, "remote.git"), work = join(dir, "work");
    spawnSync("git", ["init", "-q", "--bare", remote]);
    spawnSync("git", ["init", "-q", "-b", "main", work]);
    spawnSync("git", ["-C", work, "-c", "user.name=A", "-c", "user.email=a@x", "commit", "-q", "--allow-empty", "-m", "x"]);
    // What git-lfs's own hook does when it cannot upload: fail the push.
    writeFileSync(join(work, ".git", "hooks", "pre-push"), '#!/bin/sh\n[ "$GIT_LFS_SKIP_PUSH" = "1" ] && exit 0\necho "LFS upload failed" >&2\nexit 1\n');
    chmodSync(join(work, ".git", "hooks", "pre-push"), 0o755);
    assert.notEqual(spawnSync("git", ["-C", work, "push", "-q", remote, "main"], { env: { ...process.env, GIT_LFS_SKIP_PUSH: "" } }).status, 0, "the hook does refuse without the setting");
    assert.equal(spawnSync("git", ["-C", work, "push", "-q", remote, "main"], { env: gitEnv() }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
