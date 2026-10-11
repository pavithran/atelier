import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lfsPointer, publishMirror } from "./mirror.mjs";

const email = "123+public@users.noreply.github.com";
const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
const pointer = (oid, size, extension) => `version https://git-lfs.github.com/spec/v1\n${extension}oid sha256:${oid}\nsize ${size}\n`;

test("LFS extension values are validated after repeated keys have been replaced", () => {
  const oid = createHash("sha256").update("safe\n").digest("hex");
  const valid = `ext-0-example sha256:${oid}\n`;
  const invalid = "ext-0-example invalid\n";
  assert.deepEqual(lfsPointer(pointer(oid, 5, invalid + valid)), { oid, size: 5 });
  assert.equal(lfsPointer(pointer(oid, 5, valid + invalid)), null);
  assert.equal(lfsPointer(pointer(oid, 5, valid + `ext-0-other sha256:${oid}\n`)), null);
});

test("a replaced LFS extension cannot publish an intermediate secret or a missing object", (t) => {
  mkdirSync(resolve(".cache"), { recursive: true });
  const root = mkdtempSync(resolve(".cache/mirror-lfs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const content of ["safe\n", `key = ${secret}\n`, null]) {
    const dir = mkdtempSync(join(root, "case-"));
    const checkout = join(dir, "checkout"), mirror = join(dir, "mirror.git");
    const git = (args, opts = {}) => {
      const result = spawnSync("git", args, {
        cwd: checkout, encoding: "utf8", input: opts.input,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      });
      if (!opts.allowFail) assert.equal(result.status, 0, result.stderr);
      return result;
    };
    mkdirSync(checkout);
    git(["init", "-q", "-b", "main"]);
    git(["init", "-q", "--bare", "-b", "main", mirror]);
    git(["remote", "add", "public", mirror]);
    git(["config", "user.name", "Public"]);
    git(["config", "user.email", email]);
    const payload = content ?? "missing\n";
    const oid = createHash("sha256").update(payload).digest("hex");
    if (content !== null) {
      const storage = join(checkout, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4));
      mkdirSync(storage, { recursive: true });
      writeFileSync(join(storage, oid), payload);
    }
    writeFileSync(join(checkout, "data.txt"), pointer(oid, Buffer.byteLength(payload), `ext-0-example invalid\next-0-example sha256:${oid}\n`));
    git(["add", "data.txt"]);
    git(["commit", "-qm", "Pointer"]);
    const commit = git(["rev-parse", "HEAD"]).stdout.trim();
    git(["rm", "-q", "data.txt"]);
    git(["commit", "-qm", "Remove pointer"]);
    const lines = [];
    const result = publishMirror({ git, dir: checkout, branch: "main", remote: "public", say: (line) => lines.push(line),
      identity: { name: "Public", email, agentEmails: [], publicMirrors: ["public"], publicMirrorDestinations: { public: mirror } } });
    const output = lines.join("\n");
    assert.equal(result.ok, content === "safe\n", output);
    const refs = git(["--git-dir", mirror, "for-each-ref", "--format=%(refname)"]).stdout.trim();
    if (result.ok) assert.equal(refs, "refs/heads/main");
    else {
      assert.equal(refs, "");
      assert.ok(output.includes(`${commit.slice(0, 12)} data.txt`), output);
      assert.match(output, content === null ? /not in the checkout's LFS storage/ : /:1: secret/);
      assert.ok(!output.includes(secret), output);
    }
  }
});
