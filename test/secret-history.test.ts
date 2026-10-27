import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry, Reader } from "../src/diff.ts";
import { ALLOW_PATH, parseAllowances, scanHistory, type PrivacyAllowance } from "../src/secret-scan.ts";
import { privacyScan, readAllowances } from "../scripts/privacy-scan.mjs";

// The gate's scan of a task's history and the push scan (scripts/
// privacy-scan.mjs) read the same commits of a real repository and must name
// the same commits and files (t295). The key-shaped lines are built from
// pieces so this file holds no key.
const PUBLIC = "1+owner@users.noreply.github.com";
const KEY = `export const key = "${["sk", "proj", "x".repeat(24)].join("-")}";`;
const MAIN_KEY = `export const placeholder = "${["sk", "proj", "y".repeat(24)].join("-")}";`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function repo(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-secret-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: PUBLIC, GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: PUBLIC };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  git("init", "-q", "-b", "main");
  const commit = (path: string, text: string | null, message: string) => {
    if (text === null) git("rm", "-q", path);
    else { writeFileSync(join(dir, path), `${text}\n`); git("add", path); }
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  // The Artifacts reader over the repository: a tree as its entries, a blob
  // as its bytes, null for what it does not hold.
  const reader: Reader = {
    tree: async (h) => {
      try {
        return git("ls-tree", h).split("\n").filter(Boolean).map((l): Entry => {
          const [meta, name] = l.split("\t");
          const [mode, type, hash] = meta.split(" ");
          return { name, mode, hash, type };
        });
      } catch { return null; }
    },
    blob: async (h) => {
      try { return new Uint8Array(execFileSync("git", ["cat-file", "blob", h], { cwd: dir })); } catch { return null; }
    },
  };
  // The gate's scan of what HEAD adds over `base`, as "commit file" texts.
  const gate = async (base: string, allowances: PrivacyAllowance[] | (() => Promise<PrivacyAllowance[]>)) => {
    const commits = git("log", "--format=%H %T %P", "HEAD", "--not", base).split("\n").map((l) => {
      const [hash, treeHash, ...parents] = l.split(" ");
      return { hash, treeHash, parents };
    });
    const trees = new Map(git("log", "--all", "--format=%H %T").split("\n").map((l) => l.split(" ") as [string, string]));
    const scan = await scanHistory(reader, commits, trees, allowances);
    assert.deepEqual(scan.unscanned, []);
    return [...new Set(scan.hits.map((h) => `${h.commit!.slice(0, 12)} ${h.file}`))].sort();
  };
  // The push scan's leaks over the same range, as "commit file" texts.
  const push = (base: string, allowances: PrivacyAllowance[]) => privacyScan({ cwd: dir, base: [base], project: "test", privates: [], allowances, report: () => {} })
    .map((p: string) => /^leak: commit ([0-9a-f]{12}) adds a line to (\S+) /.exec(p)!.slice(1).join(" ")).sort();
  return { git, commit, gate, push };
}

test("a key a task's commit added and a later one removed is found by both scans, naming that commit", async (t) => {
  const { git, commit, gate, push } = repo(t);
  const base = commit("README.md", "# Keys", "root");
  git("checkout", "-q", "-b", "task");
  const added = commit("keys.ts", KEY, "add the key");
  commit("keys.ts", null, "remove the key");
  const expected = [`${added.slice(0, 12)} keys.ts`];
  assert.deepEqual(push(base, []), expected);
  assert.deepEqual(await gate(base, []), expected);
});

test("a merge of main into the task is flagged for main's key relative to the task's side, as the push scan flags it", async (t) => {
  const { git, commit, gate, push } = repo(t);
  const base = commit("README.md", "# Keys", "root");
  git("checkout", "-q", "-b", "task");
  commit("task.ts", "export const ok = true;", "task work");
  git("checkout", "-q", "main");
  const onMain = commit("main.ts", MAIN_KEY, "main adds a placeholder");
  git("checkout", "-q", "task");
  git("merge", "-q", "--no-edit", "main");
  const merge = git("rev-parse", "HEAD");
  // The task's own commits, as the gate reads them, stop at main: the merge
  // is the task's and adds main.ts relative to the task's side.
  assert.deepEqual(await gate(onMain, []), [`${merge.slice(0, 12)} main.ts`]);
  assert.deepEqual(push(onMain, []), [`${merge.slice(0, 12)} main.ts`]);
  // Over the whole range both scans name main's commit and the merge, and an
  // allowance for main's commit leaves the merge flagged in both.
  assert.deepEqual(await gate(base, []), [`${merge.slice(0, 12)} main.ts`, `${onMain.slice(0, 12)} main.ts`].sort());
  assert.deepEqual(push(base, []), await gate(base, []));
  const forMain = [{ commit: onMain.slice(0, 8), file: "main.ts", sha256: sha(MAIN_KEY), reason: "a fake key" }];
  assert.deepEqual(await gate(base, forMain), [`${merge.slice(0, 12)} main.ts`]);
  assert.deepEqual(push(base, forMain), [`${merge.slice(0, 12)} main.ts`]);
  // With the merge allowed too, neither scan flags anything.
  const both = [...forMain, { commit: merge.slice(0, 8), file: "main.ts", sha256: sha(MAIN_KEY), reason: "a fake key" }];
  assert.deepEqual(await gate(base, both), []);
  assert.deepEqual(push(base, both), []);
});

test("the gate reads the allowance list only once a key-shaped line is found", async (t) => {
  const { git, commit, gate } = repo(t);
  const base = commit("README.md", "# Keys", "root");
  git("checkout", "-q", "-b", "task");
  commit("task.ts", "export const ok = true;", "task work");
  // A history with no key-shaped line never asks for the list, so a reader
  // without one (as the tests' fakes of Artifacts are) scans it clean.
  let reads = 0;
  const list = async () => { reads++; return []; };
  assert.deepEqual(await gate(base, list), []);
  assert.equal(reads, 0);
  // Two commits adding key-shaped lines ask for it once, and a list that
  // cannot be read fails the scan.
  const first = commit("keys.ts", KEY, "add the key");
  const second = commit("main.ts", MAIN_KEY, "add another");
  assert.deepEqual(await gate(base, list), [`${first.slice(0, 12)} keys.ts`, `${second.slice(0, 12)} main.ts`].sort());
  assert.equal(reads, 1);
  await assert.rejects(gate(base, async () => { throw new Error("docs/atelier/privacy-allow.json has no allowances list"); }), /no allowances list/);
});

test("the gate reads the allowance list with the push scan's rules", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-allow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "allow.json");
  const good = { commit: "1acf7deb", file: "a.ts", sha256: "a".repeat(64), reason: "fake" };
  const cases: unknown[] = [
    { allowances: [good] },
    { allowances: [] },
    {},
    { allowances: [{ ...good, commit: "1acf7d" }] },
    { allowances: [{ ...good, file: "" }] },
    { allowances: [{ ...good, sha256: "A".repeat(64) }] },
    { allowances: [{ ...good, reason: "" }] },
    { allowances: [null] },
  ];
  for (const value of cases) {
    const text = JSON.stringify(value);
    writeFileSync(file, text);
    const outcome = (read: () => unknown) => { try { return read(); } catch { return "throws"; } };
    assert.deepEqual(outcome(() => parseAllowances(text, file)), outcome(() => readAllowances(file)), text);
  }
  // The project's own list parses, and the gate reads it from the same path.
  assert.deepEqual(parseAllowances(readFileSync(join(import.meta.dirname, "..", ALLOW_PATH), "utf8")), readAllowances());
});
