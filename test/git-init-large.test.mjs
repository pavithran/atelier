import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const KEY = ["sk", "proj", "TESTONLY", "f".repeat(28)].join("-");

test("initial registration batches history, records a tip over TIP_BYTES, and refuses clearable historical keys", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-init-large-"));
  const work = join(root, "work"), policy = join(root, "policy.json"), report = join(root, "report.json"), preload = join(root, "live.mjs");
  mkdirSync(work);
  writeFileSync(preload, "globalThis.fetch = async () => Response.json({ live: true });\n");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test",
    ATELIER_KIND: "owner", ATELIER_BRANCH: "main", ATELIER_POLICY: policy, ATELIER_REPORT: report,
    ATELIER_GRANT: "owner", ATELIER_GRANT_CHECK: "https://grant.test", ATELIER_HOOK_SECRET: "test", NODE_OPTIONS: `--import=${preload}` };
  const git = (...args) => execFileSync("git", args, { cwd: work, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repository = (name) => {
    const dir = join(root, `${name}.git`);
    git("init", "--bare", "-q", dir);
    git("-C", dir, "config", "core.hooksPath", resolve("hooks"));
    return dir;
  };
  const push = (repo, sha, ref = "main") => spawnSync("git", ["push", "--porcelain", repo, `${sha}:refs/heads/${ref}`], { cwd: work, env, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(policy, JSON.stringify({ private: [], clearances: [] }));
    const content = "a".repeat(8 * 1024 * 1024 + 1);
    const input = `blob\nmark :1\ndata ${content.length}\n${content}\ncommit refs/heads/main\ncommitter t <t@example.test> 1700200000 +0000\ndata 1\nx\ndeleteall\n`
      + Array.from({ length: 33 }, (_, i) => `M 100644 :1 corpus-${i}.json\n`).join("") + "\n";
    execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env, input });
    const clean = git("rev-parse", "main"), into = repository("large");
    const first = push(into, clean);
    assert.equal(first.status, 0, first.stderr);
    const recorded = JSON.parse(readFileSync(report));
    assert.equal(recorded.unscanned.length, 33);
    assert.ok(recorded.unscanned.every((u) => /bytes, over/.test(u.reason)));
    assert.deepEqual(recorded.hits, []);
    // The exception is only the initial owner push; ordinary dev pushes
    // still refuse unread files and overlarge commit ranges.
    const ordinary = push(repository("ordinary"), clean, "dev/import");
    assert.notEqual(ordinary.status, 0);
    assert.match(ordinary.stderr, /tip tree exceeds the 268435456-byte scan limit/);
    let history = "";
    for (let i = 1; i <= 1005; i++) {
      const text = `TOKEN=${KEY}\n`;
      const file = `key-${i}.env`;
      const files = [2, 402, 802].includes(i) ? `M 100644 inline ${file}\ndata ${text.length}\n${text}\n`
        : [3, 403, 803].includes(i) ? `D key-${i - 1}.env\n` : "";
      history += `commit refs/heads/history\ncommitter t <t@example.test> ${1700300000 + i} +0000\ndata 1\nx\n${files}\n`;
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env, input: history });
    const head = git("rev-parse", "history"), secretRepo = repository("history");
    const denied = push(secretRepo, head);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /key-shaped/);
    assert.match(denied.stderr, /atelier init --clear-secret/);
    const scan = JSON.parse(readFileSync(report));
    assert.deepEqual(scan.hits.map((h) => h.file).sort(), ["key-2.env", "key-402.env", "key-802.env"]);
    assert.equal(JSON.stringify(scan).includes(KEY), false);
    assert.equal(git("-C", secretRepo, "for-each-ref"), "");
    writeFileSync(policy, JSON.stringify({ private: [], initialClearances: scan.hits.map(({ file, fingerprint }) => ({ file, fingerprint })) }));
    const cleared = push(secretRepo, head);
    assert.equal(cleared.status, 0, cleared.stderr);
    const historicalKey = git("rev-list", "--reverse", head).split("\n")[1];
    const ordinarySecret = push(repository("ordinary-secret"), historicalKey, "dev/import");
    assert.notEqual(ordinarySecret.status, 0);
    assert.match(ordinarySecret.stderr, /key-shaped/);
    writeFileSync(policy, JSON.stringify({ private: ["key-2.env"], initialClearances: scan.hits }));
    const privatePush = push(repository("private"), head);
    assert.notEqual(privatePush.status, 0);
    assert.match(privatePush.stderr, /private files:.*key-2.env/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
