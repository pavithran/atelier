// Part 1 of 3 of the tests that were in pull.test.mjs, split so no file runs for more than about a minute (t771).
// atelier pull (t644), and the refusals of merge while a checkout's main does
// not hold the baseline's. Two Macs share a project's repository: each test
// makes their checkouts with atelier clone, each Mac with its own Atelier
// config and cache, against a stand-in server whose git-token answer names a
// bare repository, on disk or served over HTTP behind a token check
// (test/helpers/git-http.mjs). All of it lives under os.tmpdir().
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, commitElsewhere, commitIn, mac, run, cloneOn } from "./pull-shared.mjs";

test("pull keeps the checkout's own receipts, those not yet pushed and those the baseline also changed", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const first = f.git(dir, "rev-parse", "HEAD");
  // Here: a local commit with a receipt never pushed, and the clone's receipt changed.
  const local = commitIn(f, dir, "mine.txt", "mine\n");
  f.git(dir, "notes", "--ref=atelier", "add", "-m", "Local receipt, not yet pushed", local);
  f.git(dir, "notes", "--ref=atelier", "add", "-f", "-m", "Atelier receipt for t1, edited here", first);
  // Elsewhere: a commit with its own receipt, and the same receipt changed otherwise.
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n", { note: "Atelier receipt for t2" });
  f.git(f.other, "notes", "--ref=atelier", "add", "-f", "-m", "Atelier receipt for t1, edited elsewhere", first);
  f.git(f.other, "push", "-q", "origin", "refs/notes/atelier:refs/notes/atelier");

  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /brought 1 commit from the baseline's main and merged them with 1 local commit/);
  assert.match(r.output, /Receipts: 1 new on refs\/notes\/atelier, merged with this checkout's own\./);
  assert.match(r.output, /atelier wrap --project demo or the next atelier merge/);
  assert.deepEqual(f.git(dir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [local, theirs]);
  const note = (c) => f.git(dir, "notes", "--ref=atelier", "show", c);
  assert.equal(note(local), "Local receipt, not yet pushed");
  assert.equal(note(theirs), "Atelier receipt for t2");
  assert.match(note(first), /edited here/);
  assert.match(note(first), /edited elsewhere/);
});


test("a pull whose merge conflicts stops with main, the index and the work tree as they were", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const local = commitIn(f, dir, "file.txt", "version mine\n");
  const theirs = commitElsewhere(f, "file.txt", "version theirs\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, new RegExp(`main and the baseline's main both change file\\.txt, and the changes conflict\\. Nothing was merged: main is still at ${local.slice(0, 8)} with its 1 local commit, and the work tree is as it was\\. The baseline's main brings 1 commit, fetched as ${theirs}\\. Merge it by hand: git merge ${theirs}, resolve the conflicts and commit; then run atelier pull --project demo again\\.`));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), local);
  assert.equal(f.git(dir, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "version mine\n");
  assert.ok(!existsSync(join(f.git(dir, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD")));
  // The commit named is there to merge by hand.
  assert.equal(f.git(dir, "cat-file", "-t", theirs), "commit");
});

test("pull refuses a checkout with uncommitted changes before it asks for a token", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  commitElsewhere(f, "theirs.txt", "theirs\n");
  writeFileSync(join(dir, "file.txt"), "half done\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /the registered checkout has uncommitted changes; commit or set them aside first, then pull/);
  assert.ok(!r.seen.some((s) => s.route.endsWith("/git-token")));
  assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "half done\n");
});
