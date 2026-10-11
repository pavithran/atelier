import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lfsPointer, publishMirror, publishCheckoutRemote } from "./mirror.mjs";

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
        cwd: checkout, encoding: opts.bytes ? null : "utf8", input: opts.input,
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

function repository(t) {
  mkdirSync(resolve(".cache"), { recursive: true });
  const dir = mkdtempSync(resolve(".cache/mirror-regression-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mirror = join(dir, "mirror.git"), checkout = join(dir, "checkout");
  mkdirSync(checkout);
  const git = (args, opts = {}) => {
    const result = spawnSync("git", args, { cwd: checkout, encoding: opts.bytes ? null : "utf8", input: opts.input,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
    if (!opts.allowFail) assert.equal(result.status, 0, String(result.stderr));
    return result;
  };
  git(["init", "-q", "-b", "main"]);
  git(["init", "-q", "--bare", "-b", "main", mirror]);
  git(["config", "user.name", "Public"]);
  git(["config", "user.email", email]);
  git(["remote", "add", "public", mirror]);
  const commit = () => { git(["add", "-A"]); git(["commit", "-qm", "Change"]); return git(["rev-parse", "HEAD"]).stdout.trim(); };
  const lines = [];
  return { git, checkout, mirror, commit, lines, options: { git, dir: checkout, branch: "main", remote: "public", say: (line) => lines.push(line),
    identity: { name: "Public", email, agentEmails: [], publicMirrors: ["public"], publicMirrorDestinations: { public: mirror } } } };
}

test("raw pointer size cannot be inflated by invalid UTF-8 in an inherited extension", (t) => {
  const f = repository(t), oid = createHash("sha256").update("missing\n").digest("hex");
  const bytes = Buffer.concat([Buffer.from("ext-0-example "), Buffer.alloc(400, 255),
    Buffer.from(`\next-0-example sha256:${oid}\nversion https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 8\n`)]);
  assert.ok(bytes.length < 1024);
  assert.ok(Buffer.byteLength(bytes.toString("utf8")) > 1024);
  assert.deepEqual(lfsPointer(bytes), { oid, size: 8 });
  // The invalid extension is already public. Adding only size turns the
  // previously ordinary file into an uploadable pointer; the patch is ASCII.
  writeFileSync(join(f.checkout, "data.txt"), bytes.subarray(0, bytes.length - 7));
  f.commit();
  f.git(["push", "-q", "public", "main"]);
  const before = f.git(["--git-dir", f.mirror, "rev-parse", "main"]).stdout;
  writeFileSync(join(f.checkout, "data.txt"), bytes);
  const commit = f.commit();
  assert.equal(publishMirror(f.options).ok, false);
  assert.match(f.lines.join("\n"), /data.txt: LFS object .*not in the checkout's LFS storage/);
  assert.ok(f.lines.join("\n").includes(commit.slice(0, 12)));
  assert.equal(f.git(["--git-dir", f.mirror, "rev-parse", "main"]).stdout, before);
});

test("wrap scans aliases of declared destinations, including push URLs and fanout", (t) => {
  for (const mode of ["clean", "secret", "pushurl", "fanout", "invalid", "race", "owner"]) {
    const f = repository(t);
    writeFileSync(join(f.checkout, "data.txt"), ["secret", "pushurl"].includes(mode) ? `key = ${secret}\n` : "safe\n");
    f.commit();
    const other = join(f.checkout, "..", "other.git");
    f.git(["init", "-q", "--bare", "-b", "main", other]);
    f.git(["remote", "add", "alias", mode === "owner" || mode === "pushurl" ? other : f.mirror]);
    if (mode === "pushurl") f.git(["config", "remote.alias.pushurl", f.mirror]);
    if (mode === "fanout") {
      f.git(["config", "--add", "remote.alias.pushurl", f.mirror]);
      f.git(["config", "--add", "remote.alias.pushurl", other]);
    }
    if (mode === "invalid") f.options.identity.email = "invalid";
    let changed = false;
    const git = (args, opts) => {
      const result = f.git(args, opts);
      if (mode === "race" && !changed && args.includes("--name-only")) {
        changed = true;
        f.git(["remote", "set-url", "alias", other]);
      }
      return result;
    };
    const result = publishCheckoutRemote({ ...f.options, git, remote: "alias" });
    assert.equal(result.ok, mode === "clean" || mode === "owner", `${mode}: ${f.lines.join("\n")}`);
    assert.ok(!f.lines.join("\n").includes(secret));
    for (const destination of [f.mirror, other]) {
      const refs = f.git(["--git-dir", destination, "for-each-ref", "--format=%(refname)"]).stdout.trim();
      assert.equal(refs, result.ok && destination === (mode === "owner" ? other : f.mirror) ? "refs/heads/main" : "", mode);
    }
  }
});
