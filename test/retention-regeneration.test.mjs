import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { localGit, mergeThrough } from "../cli/merge-pipeline.mjs";
import { openReader } from "../src/git/reader.mjs";
import { readRetention } from "../src/retention.ts";
import { retentionVerdict } from "../src/rules.ts";

test("replay carries clean generation and refuses hand edits, conflicts, failures and drift", async () => {
  const dir = resolve(".scratch", `retention-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const git = (args, opts = {}) => localGit(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir, ...opts });
  git(["init", "-q", "-b", "main"]);
  mkdirSync(`${dir}/bin`); mkdirSync(`${dir}/in`);
  const write = (path, text) => writeFileSync(`${dir}/${path}`, text);
  const commit = (message) => { git(["add", "."]); git(["commit", "-qm", message]); return git(["rev-parse", "HEAD"]); };
  write("bin/merge-manifest.json", JSON.stringify({ version: 1, generators: [{ name: "gen", command: ["sh", "-c", "if test -f in/fail.txt; then exit 3; fi; cat in/*.txt > gen.txt; if test -f in/drift.txt; then echo $$ >> gen.txt; fi"], inputs: ["in/**"], outputs: ["gen.txt"] }], records: [] }));
  write(".gitattributes", "gen.txt merge=atelier-generated\n");
  write("in/base.txt", "base\n"); write("gen.txt", "base\n");
  const base = commit("Base");
  write("in/task.txt", "task\n"); write("gen.txt", "base\ntask\n");
  const oldHead = commit("Approved task");
  git(["checkout", "-q", "--detach", base]);
  write("in/main.txt", "main\n"); write("gen.txt", "base\nmain\n");
  const main = commit("Main");
  git(["checkout", "-q", "--detach", oldHead]);
  const merged = await mergeThrough(dir, main, { git, message: "Merge main" });
  assert.equal(merged.state, "merged");
  const newHead = git(["rev-parse", "HEAD"]);
  const verdict = async (head) => {
    using work = openReader(dir, { head });
    using baseline = openReader(dir, { head: main });
    return retentionVerdict(await readRetention(work, baseline, oldHead, head), { resolver: null, outsiders: false });
  };
  const clean = await verdict(newHead);
  assert.equal(clean.retain, true, clean.why);
  assert.deepEqual(clean.facts.outputs, ["gen.txt"]);
  for (const [path, text] of [["gen.txt", "hand edit\n"], ["in/task.txt", "hand edit\n"]]) {
    git(["reset", "--hard", newHead]);
    write(path, text); git(["add", path]); git(["commit", "--amend", "--no-edit", "-q"]);
    assert.equal((await verdict(git(["rev-parse", "HEAD"]))).retain, false, path);
  }
  git(["reset", "--hard", newHead]);
  // A crash or a failed replay has no approval marker to leave behind:
  // only a completed comparison returns exemptions to the ledger.
  for (const marker of ["fail", "drift"]) {
    git(["reset", "--hard", oldHead]);
    write(`in/${marker}.txt`, "");
    const changed = commit(`Generator ${marker}`);
    using failed = openReader(dir);
    assert.deepEqual(await failed.verifyRegeneration(changed, main, newHead), [], marker);
  }
  git(["reset", "--hard", base]);
  write("in/base.txt", "main conflict\n");
  const conflictMain = commit("Conflicting main");
  git(["reset", "--hard", oldHead]);
  write("in/base.txt", "task conflict\n");
  const conflictTask = commit("Conflicting task");
  using conflicts = openReader(dir);
  assert.deepEqual(await conflicts.verifyRegeneration(conflictTask, conflictMain, newHead), []);
  using reader = openReader(dir);
  assert.deepEqual(await reader.verifyRegeneration(oldHead, main, "f".repeat(40)), []);
});
