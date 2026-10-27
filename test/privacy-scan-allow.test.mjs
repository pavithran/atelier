import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privacyScan, readAllowances } from "../scripts/privacy-scan.mjs";

// The key-shaped lines are built from pieces so this file holds no key.
const PUBLIC = "1+owner@users.noreply.github.com";
const LINE = `const HEADER_VALUE = "${["Bearer sk", "secret", "A".repeat(24)].join("-")}";`;
const OTHER = `const HEADER_VALUE = "${["Bearer sk", "secret", "B".repeat(24)].join("-")}";`;
const sha = (text) => createHash("sha256").update(text).digest("hex");

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-privacy-allow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: PUBLIC, GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: PUBLIC };
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  git("init", "-q", "-b", "main");
  const commit = (path, text) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), `${text}\n`);
    git("add", ".");
    git("commit", "-q", "-m", `add ${path}`);
    return git("rev-parse", "HEAD");
  };
  return { dir, commit };
}

const scan = (dir, allowances) => {
  const said = [];
  const problems = privacyScan({ cwd: dir, base: [], project: "x", privates: [], allowances, report: (text) => said.push(text) });
  return { problems, said };
};
const allow = (commit, file, line) => ({ commit: commit.slice(0, 8), file, sha256: sha(line), reason: "a fake test value" });

test("an allowed line passes and the scan says it was allowed", (t) => {
  const { dir, commit } = repo(t);
  const id = commit("cli/a.test.mjs", LINE);
  const { problems, said } = scan(dir, [allow(id, "cli/a.test.mjs", LINE)]);
  assert.deepEqual(problems, []);
  assert.equal(said.length, 1);
  assert.match(said[0], /^allowed: commit /);
  assert.match(said[0], /a fake test value/);
  assert.ok(!said[0].includes("secret-AAAA"));
});

test("the same line in another commit still fails", (t) => {
  const { dir, commit } = repo(t);
  const first = commit("cli/a.test.mjs", LINE);
  commit("cli/b.test.mjs", LINE);
  const { problems } = scan(dir, [allow(first, "cli/a.test.mjs", LINE)]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^leak: .* cli\/b\.test\.mjs /);
});

test("the same line in another file still fails", (t) => {
  const { dir, commit } = repo(t);
  const id = commit("cli/other.mjs", LINE);
  const { problems } = scan(dir, [allow(id, "cli/a.test.mjs", LINE)]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^leak: /);
});

test("any other key in an allowed commit and file still fails", (t) => {
  const { dir, commit } = repo(t);
  const id = commit("cli/a.test.mjs", `${LINE}\n${OTHER}`);
  const { problems, said } = scan(dir, [allow(id, "cli/a.test.mjs", LINE)]);
  assert.equal(problems.length, 1);
  assert.equal(said.length, 1);
});

test("a real key is not allowed by an allowance for another line", (t) => {
  const { dir, commit } = repo(t);
  const key = ["sk", "ant", "api03", "A".repeat(40)].join("-");
  const id = commit("cli/a.test.mjs", `const k = "${key}";`);
  assert.equal(scan(dir, [allow(id, "cli/a.test.mjs", LINE)]).problems.length, 1);
});

// t266's three, then the seven merges that carry the made-up key in
// t323's test, allowed for GitHub by PAVI at the v1.0 cut (t364).
test("the shipped allowance list holds the three t266 commits, the seven t323 ones and no key text", () => {
  const list = readAllowances();
  assert.deepEqual(list.map((a) => a.commit), ["1acf7deb", "ae4368a4", "bcf2c358", ...["7304c123","e0c69f61","cea43fa7","a46f9404","0b092bd9","573fb054","83fade85"]]);
  for (const a of list.slice(0, 3)) {
    assert.equal(a.file, "cli/server-errors.test.mjs");
    assert.match(a.reason, /^PAVI 2026-10-25/);
  }
  for (const a of list.slice(3)) {
    assert.equal(a.file, "test/runner-same-exit.test.mjs");
    assert.match(a.reason, /^PAVI 2026-10-27/);
  }
  assert.ok(!JSON.stringify(list).includes("Bearer"));
});

test("a malformed allowance list fails closed", (t) => {
  const { dir } = repo(t);
  const path = join(dir, "bad.json");
  writeFileSync(path, JSON.stringify({ allowances: [{ commit: "abc", file: "x", sha256: "nope", reason: "r" }] }));
  assert.throws(() => readAllowances(path), /without a commit, file, sha256 and reason/);
});
