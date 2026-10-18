// Part 1 of 3 of the tests that were in pull.test.mjs, split so no file runs for more than about a minute (t771).
// atelier pull (t644), and the refusals of sync, wrap and merge while
// a checkout's main does not hold the baseline's. Two Macs share a project's
// baseline: each test makes their checkouts with atelier clone, each Mac with
// its own Atelier config and cache, against a stand-in server whose
// baseline-token answer names a bare repository, on disk or served over HTTP
// behind a token check (test/helpers/git-http.mjs). All of it lives under
// os.tmpdir().
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPairs, savePairs } from "../cli/fresh.mjs";
import { setup, commitElsewhere, commitIn, mac, run, cloneOn, refusal, cli, serve, TOKEN, IDENTITY } from "./pull-shared.mjs";
// One Mac: its own Atelier config, cache and home, and the projects it registers.
// What a Mac outside Atelier's checkouts does: commits in `other`, a plain
// clone of the baseline, pushed straight to it, as another Mac's sync,
// merge or wrap leaves the baseline.
test("two checkouts of one baseline take turns: A syncs, B is refused and pulls, B syncs, A pulls", async (t) => {
  const f = setup(t, { fresh: true, http: true });
  const a = mac(f, "a"), b = mac(f, "b");
  const dirA = await cloneOn(t, f, a), dirB = await cloneOn(t, f, b);

  commitIn(f, dirA, "a.txt", "made on A\n");
  const syncA = await run(t, f, a, ["sync", "--project", "demo"]);
  assert.equal(syncA.code, 0, syncA.output);
  assert.match(syncA.output, /carried 1 commit to the baseline/);
  const afterA = f.git(f.bare, "rev-parse", "main");

  // B made a commit of its own meanwhile. Its sync is refused before any push.
  const bLocal = commitIn(f, dirB, "b.txt", "made on B\n");
  const refused = await run(t, f, b, ["sync", "--project", "demo"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, refusal(afterA, "atelier sync --project demo"));
  assert.equal(f.git(f.bare, "rev-parse", "main"), afterA, "the baseline is untouched");
  assert.equal(f.git(dirB, "rev-parse", "HEAD"), bLocal);

  // B pulls: A's commit comes in and is merged with B's own, the baseline's side first.
  const pullB = await run(t, f, b, ["pull", "--project", "demo"]);
  assert.equal(pullB.code, 0, pullB.output);
  assert.match(pullB.output, /demo: brought 1 commit from the baseline's main and merged them with 1 local commit; main is at [0-9a-f]{8}\./);
  assert.match(pullB.output, /in checkout-a: a\.txt/);
  assert.match(pullB.output, /atelier sync --project demo carries the local commits/);
  assert.deepEqual(f.git(dirB, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [afterA, bLocal]);
  assert.equal(readFileSync(join(dirB, "a.txt"), "utf8"), "made on A\n");
  assert.equal(readFileSync(join(dirB, "b.txt"), "utf8"), "made on B\n");
  assert.equal(f.git(dirB, "status", "--porcelain"), "");

  const syncB = await run(t, f, b, ["sync", "--project", "demo"]);
  assert.equal(syncB.code, 0, syncB.output);
  assert.match(syncB.output, /carried 1 commit to the baseline/);
  const afterB = f.git(f.bare, "rev-parse", "main");
  assert.equal(f.git(f.bare, "rev-parse", "main^{tree}"), f.git(dirB, "rev-parse", "HEAD^{tree}"));

  // A pulls: a fast-forward to what B carried.
  const pullA = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(pullA.code, 0, pullA.output);
  assert.match(pullA.output, new RegExp(`demo: brought 1 commit from the baseline's main; main moved from [0-9a-f]{8} to ${afterB.slice(0, 8)}\\.`));
  assert.equal(f.git(dirA, "rev-parse", "HEAD"), afterB);
  assert.equal(readFileSync(join(dirA, "b.txt"), "utf8"), "made on B\n");
  assert.equal(loadPairs(f.git(dirA, "rev-parse", "--absolute-git-dir"), "demo")[afterB], afterB);
  const again = await run(t, f, a, ["sync", "--project", "demo"]);
  assert.equal(again.code, 0, again.output);
  assert.match(again.output, /the baseline already matches main/);
  const still = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(still.code, 0, still.output);
  assert.match(still.output, /already holds the baseline's main .*; no commits to bring/);

  // No token kept or printed; every request carried the token its own command minted.
  for (const dir of [dirA, dirB]) assert.ok(!/authorization|base-secret/i.test(f.git(dir, "config", "--list")));
  for (const r of [syncA, refused, pullB, syncB, pullA]) assert.ok(!/base-secret/.test(r.output), r.output);
  for (const tokens of f.http.sent) assert.equal(tokens.length, 1);
  // pull asks for a read token, never a write one.
  for (const r of [pullB, pullA]) assert.deepEqual(r.seen.filter((s) => s.route.endsWith("/baseline-token")).map((s) => s.body), [{ scope: "read" }]);
});


test("pull carries the baseline's new commits into the checkout the fresh baseline was built from, through its baseline map", async (t) => {
  const f = setup(t, { fresh: true });
  const b = mac(f, "b"), owner = mac(f, "owner");
  // The original checkout: its commits differ in id from the baseline's, and the map pairs them.
  const gitDir = f.git(f.source, "rev-parse", "--absolute-git-dir");
  savePairs(gitDir, "demo", f.built.pairs);
  owner.projects = { demo: { path: f.source, branch: "main", protect: [], fresh: true } };
  const start = f.git(f.source, "rev-parse", "HEAD");
  const dirB = await cloneOn(t, f, b);
  commitIn(f, dirB, "b.txt", "made on B\n");
  assert.equal((await run(t, f, b, ["sync", "--project", "demo"])).code, 0);
  const baselineHead = f.git(f.bare, "rev-parse", "main");

  const refused = await run(t, f, owner, ["sync", "--project", "demo"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, refusal(baselineHead, "atelier sync --project demo"));

  const pull = await run(t, f, owner, ["pull", "--project", "demo"]);
  assert.equal(pull.code, 0, pull.output);
  assert.match(pull.output, /brought 1 commit from the baseline's main; main moved from/);
  const head = f.git(f.source, "rev-parse", "HEAD");
  assert.notEqual(head, baselineHead, "the commit is rebuilt onto the checkout's own history");
  assert.equal(f.git(f.source, "rev-parse", "HEAD^"), start);
  assert.equal(f.git(f.source, "rev-parse", "HEAD^{tree}"), f.git(f.bare, "rev-parse", "main^{tree}"));
  assert.equal(loadPairs(gitDir, "demo")[baselineHead], head);
  const sync = await run(t, f, owner, ["sync", "--project", "demo"]);
  assert.equal(sync.code, 0, sync.output);
  assert.match(sync.output, /the baseline already matches main/);
});


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


test("wrap does not update the baseline while main does not hold the baseline's main, and does after a pull", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  commitIn(f, dir, "mine.txt", "mine\n");
  const refused = await run(t, f, a, ["wrap", "Mine", "--no-check", "--project", "demo"], { cwd: dir });
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, refusal(theirs, "atelier wrap"));
  assert.equal(f.git(f.bare, "rev-parse", "main"), theirs);
  assert.equal((await run(t, f, a, ["pull", "--project", "demo"])).code, 0);
  const ok = await run(t, f, a, ["wrap", "Mine", "--no-check", "--project", "demo"], { cwd: dir });
  assert.equal(ok.code, 0, ok.output);
  assert.equal(f.git(f.bare, "rev-parse", "main"), f.git(dir, "rev-parse", "HEAD"));
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
  assert.ok(!r.seen.some((s) => s.route.endsWith("/baseline-token")));
  assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "half done\n");
});
