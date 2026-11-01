// Local receive-pack exercises quarantine and the real hook without an HTTP listener.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const KEY = ["sk", "proj", "TESTONLY", "d".repeat(28)].join("-");

test("owner initialization scans history in batches and preserves other hook rules", () => {
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
  const push = (repo, sha, ref = "main", kind = "owner", extra = []) => {
    rmSync(report, { force: true });
    return spawnSync("git", ["push", "--porcelain", repo, `${sha}:refs/heads/${ref}`, ...extra], { cwd: work,
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
    const stream = `blob\nmark :1\ndata 6\nclean\n\nblob\nmark :2\ndata 6\nclean\n\n`
      + Array.from({ length: 1001 }, (_, i) => `commit refs/heads/imported\ncommitter t <t@example.test> ${1700100000 + i} +0000\ndata 1\nx\n${i === 0 ? "deleteall\nM 100644 :1 config.env\n" : i === 1000 ? "M 100644 :2 config.env\n" : ""}\n`).join("");
    execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env, input: stream });
    const history = git("rev-parse", "imported");
    assert.equal(git("rev-list", "--count", history), "1001");
    const clean = git("rev-list", "--max-parents=0", history);
    const imported = repository("clean");
    assert.equal(push(imported, clean).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(report)), { initial: true, ref: "refs/heads/main", head: clean, hits: [], unscanned: [], refused: false });
    refused(push(imported, add(clean, "readme", "hello\n")), /main moves only by a landing/);
    const secret = add(clean, "config.env", `MODE=test\nOPENAI_API_KEY=${KEY}\n`);
    const secretRepo = repository("secret");
    refused(push(secretRepo, secret), /secret scan found a key-shaped line: config\.env:2/);
    const found = JSON.parse(readFileSync(report));
    assert.equal(found.refused, true);
    assert.deepEqual(found.hits.map(({ file, line, commit }) => ({ file, line, commit })), [{ file: "config.env", line: 2, commit: secret }]);
    assert.equal(JSON.stringify(found).includes(KEY), false);
    assert.equal(git("-C", secretRepo, "for-each-ref"), "");
    // The allowance names the older commit that added the retained line.
    const line = `OPENAI_API_KEY=${KEY}`;
    const fixture = git("commit-tree", git("rev-parse", `${secret}^{tree}`), "-m", "fixture root");
    const allowance = JSON.stringify({ allowances: [{ commit: fixture, file: "config.env",
      sha256: createHash("sha256").update(line).digest("hex"), reason: "a dummy fixture" }] });
    const allowed = add(fixture, "docs/atelier/privacy-allow.json", allowance);
    assert.equal(push(repository("allowed"), allowed).status, 0);
    const allowedTask = push(repository("allowed-task"), allowed, "t/1", "task");
    assert.equal(allowedTask.status, 0, allowedTask.stderr);
    const wrongCommit = add(fixture, "docs/atelier/privacy-allow.json", allowance.replace(fixture, clean));
    refused(push(repository("wrong-commit-task"), wrongCommit, "t/1", "task"), /config\.env:2/);
    refused(push(repository("allowed-other-path"), add(allowed, "other.env", `${line}\n`)), /other\.env:1/);
    refused(push(repository("allowed-other-line"), add(allowed, "config.env", `${line}\n${KEY.replace("TESTONLY", "UNLISTED")}\n`)), /config\.env:2/);
    refused(push(repository("landing-empty"), clean, "main", "landing"), /landing merges onto main, which has no tip yet/);
    refused(push(repository("agent-empty"), clean, "main", "read"), /this credential writes nothing here/);
    refused(push(repository("task-main-empty"), clean, "main", "task"), /this credential writes t\/1 only/);
    refused(push(repository("two-refs-empty"), clean, "main", "owner", [`${clean}:refs/heads/dev/other`]), /one ref per push/);
    // '+' has no wire representation when creating a ref. It must still scan
    // the entire history, so a key at that tip refuses the forced creation too.
    refused(push(repository("force-empty"), `+${secret}`), /secret scan found a key-shaped line/);
    refused(push(repository("delete-empty"), ""), /no deletes: main stays/);
    const privateTip = add(clean, "Notes/plan.md", "private\n", "120000");
    refused(push(repository("private"), privateTip), /would carry private files: Notes\/plan\.md in/);
    const removed = git("commit-tree", git("rev-parse", `${clean}^{tree}`), "-p", privateTip, "-m", "removed");
    refused(push(repository("removed"), removed), /would carry private files/);
    refused(push(repository("agent"), history, "t/1", "task"), /adds more than 1000 commits/);
    refused(push(repository("dev"), history, "dev/import"), /adds more than 1000 commits/);
    const nonempty = repository("nonempty");
    const empty = git("commit-tree", git("mktree"), "-m", "empty");
    git("-C", nonempty, "fetch", "-q", work, `${empty}:refs/heads/other`);
    refused(push(nonempty, history), /adds more than 1000 commits/);
    for (const [path, text, mode, reason] of [
      ["binary", "\0binary", "100644", "binary content"],
      ["large", "a".repeat(8 * 1024 * 1024 + 1), "100644", "bytes, over"],
      ["sub", "", "160000", "a submodule"],
    ]) {
      const carried = push(repository(path), add(clean, path, text, mode));
      assert.equal(carried.status, 0, carried.stderr);
      assert.match(JSON.parse(readFileSync(report)).unscanned[0].reason, new RegExp(reason));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
