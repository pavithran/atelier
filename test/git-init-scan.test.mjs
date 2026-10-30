// Local receive-pack exercises quarantine and the real hook without an HTTP listener.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const KEY = ["sk", "proj", "TESTONLY", "d".repeat(28)].join("-");

test("owner initialization scans the bounded tip tree and preserves other hook rules", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-init-scan-"));
  const work = join(root, "work");
  mkdirSync(work);
  const policy = join(root, "policy.json"), report = join(root, "report.json");
  const preload = join(root, "live.mjs");
  // The live-grant service alone is replaced; Git and all file checks are real.
  writeFileSync(preload, "globalThis.fetch = async () => Response.json({ live: true });\n");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test",
    ATELIER_KIND: "owner", ATELIER_BRANCH: "main", ATELIER_POLICY: policy, ATELIER_REPORT: report,
    ATELIER_GRANT: "owner", ATELIER_GRANT_CHECK: "https://grant.test", ATELIER_HOOK_SECRET: "test",
    NODE_OPTIONS: `--import=${preload}` };
  const git = (...args) => execFileSync("git", args, { cwd: work, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repository = (name) => {
    const dir = join(root, `${name}.git`);
    git("init", "--bare", "-q", dir);
    git("-C", dir, "config", "core.hooksPath", resolve("hooks"));
    return dir;
  };
  const push = (repo, sha, ref = "main", kind = "owner") => {
    rmSync(report, { force: true });
    return spawnSync("git", ["push", "--porcelain", repo, `${sha}:refs/heads/${ref}`], { cwd: work,
      env: { ...env, ATELIER_KIND: kind, ATELIER_TASK: kind === "task" ? "t1" : "" }, encoding: "utf8" });
  };
  const refused = (r, pattern) => {
    assert.notEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, pattern);
    assert.equal(r.stderr.includes(KEY), false);
  };
  const add = (parent, path, text, mode = "100644") => {
    git("read-tree", parent);
    const hash = mode === "160000" ? "a".repeat(40) : execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: work, env, input: text }).toString().trim();
    git("update-index", "--add", "--cacheinfo", `${mode},${hash},${path}`);
    return git("commit-tree", git("write-tree"), "-p", parent, "-m", "tip");
  };
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(policy, JSON.stringify({ private: ["notes"], clearances: [] }));
    const stream = `blob\nmark :1\ndata ${Buffer.byteLength(KEY) + 1}\n${KEY}\n\nblob\nmark :2\ndata 6\nclean\n\n`
      + Array.from({ length: 1001 }, (_, i) => `commit refs/heads/imported\ncommitter t <t@example.test> ${1700100000 + i} +0000\ndata 1\nx\n${i === 0 ? "deleteall\nM 100644 :1 config.env\n" : i === 1000 ? "M 100644 :2 config.env\n" : ""}\n`).join("");
    execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env, input: stream });
    const clean = git("rev-parse", "imported");
    assert.equal(git("rev-list", "--count", clean), "1001");
    const imported = repository("clean");
    assert.equal(push(imported, clean).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(report)), { ref: "refs/heads/main", head: clean, hits: [], unscanned: [], refused: false });
    refused(push(imported, add(clean, "readme", "hello\n")), /main moves only by a landing/);
    const secret = add(clean, "config.env", `MODE=test\nOPENAI_API_KEY=${KEY}\n`);
    const secretRepo = repository("secret");
    refused(push(secretRepo, secret), /secret scan found a key-shaped line: config\.env:2/);
    const found = JSON.parse(readFileSync(report));
    assert.equal(found.refused, true);
    assert.deepEqual(found.hits.map(({ file, line, commit }) => ({ file, line, commit })), [{ file: "config.env", line: 2, commit: secret }]);
    assert.equal(JSON.stringify(found).includes(KEY), false);
    assert.equal(git("-C", secretRepo, "for-each-ref"), "");
    const privateTip = add(clean, "Notes/plan.md", "private\n", "120000");
    refused(push(repository("private"), privateTip), /would carry private files: Notes\/plan\.md in/);
    const removed = git("commit-tree", git("rev-parse", `${clean}^{tree}`), "-p", privateTip, "-m", "removed");
    assert.equal(push(repository("removed"), removed).status, 0);
    refused(push(repository("agent"), clean, "t/1", "task"), /adds more than 1000 commits/);
    refused(push(repository("dev"), clean, "dev/import"), /adds more than 1000 commits/);
    const nonempty = repository("nonempty");
    const empty = git("commit-tree", git("mktree"), "-m", "empty");
    git("-C", nonempty, "fetch", "-q", work, `${empty}:refs/heads/other`);
    refused(push(nonempty, clean), /adds more than 1000 commits/);
    for (const [path, text, mode, reason] of [
      ["binary", "\0binary", "100644", "binary content"],
      ["large", "a".repeat(8 * 1024 * 1024 + 1), "100644", "bytes, over"],
      ["sub", "", "160000", "a submodule"],
    ]) {
      refused(push(repository(path), add(clean, path, text, mode)), /secret scan could not read/);
      assert.match(JSON.parse(readFileSync(report)).unscanned[0].reason, new RegExp(reason));
    }
    const largeTree = `blob\nmark :1\ndata 2\nx\n\ncommit refs/heads/large-tree\ncommitter t <t@example.test> 1700200000 +0000\ndata 1\nx\ndeleteall\n`
      + Array.from({ length: 20001 }, (_, i) => `M 100644 :1 file-${i}\n`).join("") + "\n";
    execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env, input: largeTree });
    refused(push(repository("too-many"), git("rev-parse", "large-tree")), /tip tree has more than 20000 files/);
    // Repeated objects count once per file read, so deduplication cannot bypass the byte cap.
    const content = "a".repeat(8 * 1024 * 1024);
    const byteTree = `blob\nmark :1\ndata ${content.length}\n${content}\ncommit refs/heads/byte-tree\ncommitter t <t@example.test> 1700200001 +0000\ndata 1\nx\ndeleteall\n`
      + Array.from({ length: 33 }, (_, i) => `M 100644 :1 file-${i}\n`).join("") + "\n";
    execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env, input: byteTree });
    refused(push(repository("too-large"), git("rev-parse", "byte-tree")), /tip tree exceeds the 268435456-byte scan limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
