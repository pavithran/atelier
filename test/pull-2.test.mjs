// Part 2 of 3 of the tests that were in pull.test.mjs, split so no file runs for more than about a minute (t771).
// atelier pull (t644), and the refusals of sync, wrap and merge while
// a checkout's main does not hold the baseline's. Two Macs share a project's
// baseline: each test makes their checkouts with atelier clone, each Mac with
// its own Atelier config and cache, against a stand-in server whose
// baseline-token answer names a bare repository, on disk or served over HTTP
// behind a token check (test/helpers/git-http.mjs). All of it lives under
// os.tmpdir().
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPairs } from "../cli/fresh.mjs";
import { setup, commitElsewhere, commitIn, mac, run, cloneOn, refusal, cli, serve, TOKEN, IDENTITY } from "./pull-shared.mjs";

test("pull pins the checkout's git identity to the project's when it is unset or differs, and prints nothing when it matches (t755)", async (t) => {
  // Finding: llm-basics, 2026-10-17, a commit in the registered checkout took
  // the global address and the baseline push was refused.
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const said = /Set this checkout's git identity to Demo Owner <owner@example\.test>/;
  const matching = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(matching.code, 0, matching.output);
  assert.doesNotMatch(matching.output, /git identity/);
  f.git(dir, "config", "--local", "--unset", "user.email");
  f.git(dir, "config", "--local", "user.name", "Someone Else");
  const pinned = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(pinned.code, 0, pinned.output);
  assert.match(pinned.output, said);
  assert.equal(pinned.output.match(/git identity/g).length, 1);
  assert.equal(f.git(dir, "config", "--local", "user.email"), "owner@example.test");
  assert.equal(f.git(dir, "config", "--local", "user.name"), "Demo Owner");
  const again = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.doesNotMatch(again.output, /git identity/);
});


// As clone does (t643, Astra's review, finding 2): a Mac whose global
// core.hooksPath is the relative .githooks would otherwise run hooks the
// baseline carries, the fetches' with the token in their environment.
test("pull runs no hook the baseline carries, in a fast-forward or a merge, even under a relative global core.hooksPath", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const marker = join(f.root, "hook-ran");
  f.git(f.other, "pull", "-q", "--no-rebase", "origin", "main");
  mkdirSync(join(f.other, ".githooks"));
  for (const hook of ["post-checkout", "post-merge", "reference-transaction", "pre-merge-commit"]) {
    writeFileSync(join(f.other, ".githooks", hook), `#!/bin/sh\necho "${hook} $GIT_CONFIG_VALUE_0" >> "${marker}"\n`, { mode: 0o755 });
  }
  const hooks = { globalConfig: "[core]\n\thooksPath = .githooks\n" };
  // The hooks reach the checkout while this Mac runs no hooks from it.
  commitElsewhere(f, "hooks.txt", "hooks\n");
  assert.equal((await run(t, f, a, ["pull", "--project", "demo"])).code, 0);
  assert.ok(existsSync(join(dir, ".githooks", "post-merge")), "the hooks are in the checkout now");
  // Under core.hooksPath = .githooks they are what Git would run, and pulls
  // that leave them alone run none of them.
  commitElsewhere(f, "theirs.txt", "theirs\n");
  const ff = await run(t, f, a, ["pull", "--project", "demo"], hooks);
  assert.equal(ff.code, 0, ff.output);
  commitIn(f, dir, "mine.txt", "mine\n");
  commitElsewhere(f, "more.txt", "more\n");
  const merge = await run(t, f, a, ["pull", "--project", "demo"], hooks);
  assert.equal(merge.code, 0, merge.output);
  assert.match(merge.output, /merged them with 1 local commit/);
  assert.ok(!existsSync(marker), existsSync(marker) ? readFileSync(marker, "utf8") : "");
});


test("a conflicting pull of a fresh baseline says how to merge by hand so that sync can carry the result", async (t) => {
  const f = setup(t, { fresh: true });
  const a = mac(f, "a"), b = mac(f, "b");
  const dirA = await cloneOn(t, f, a), dirB = await cloneOn(t, f, b);
  commitIn(f, dirA, "file.txt", "version A\n");
  assert.equal((await run(t, f, a, ["sync", "--project", "demo"])).code, 0);
  const target = f.git(f.bare, "rev-parse", "main");
  const local = commitIn(f, dirB, "file.txt", "version B\n");
  const r = await run(t, f, b, ["pull", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.ok(r.output.includes(`Merge it by hand: git checkout -B main ${target}, then git merge ${local}, resolve the conflicts and commit (the baseline's side comes first, as atelier sync needs); then run atelier pull --project demo again.`), r.output);
  assert.equal(f.git(dirB, "rev-parse", "HEAD"), local);
  // Main does not hold the baseline's head, so it stays unpaired, and sync
  // still names pull (review of t644, finding 3).
  assert.equal(loadPairs(f.git(dirB, "rev-parse", "--absolute-git-dir"), "demo")[target], undefined);
  const syncRefused = await run(t, f, b, ["sync", "--project", "demo"]);
  assert.notEqual(syncRefused.code, 0);
  assert.match(syncRefused.output, refusal(target, "atelier sync --project demo"));
  // Following it, then pulling and syncing, carries the resolution.
  f.git(dirB, "checkout", "-q", "-B", "main", target);
  try { f.git(dirB, "merge", "-q", local); } catch { /* the conflict */ }
  writeFileSync(join(dirB, "file.txt"), "version A and B\n");
  f.git(dirB, "commit", "-q", "-am", "resolved");
  const pull = await run(t, f, b, ["pull", "--project", "demo"]);
  assert.equal(pull.code, 0, pull.output);
  assert.match(pull.output, /already holds the baseline's main/);
  const sync = await run(t, f, b, ["sync", "--project", "demo"]);
  assert.equal(sync.code, 0, sync.output);
  assert.equal(f.git(f.bare, "show", "main:file.txt"), "version A and B");
});


// Review of t644, finding 2: a full-history project's sync returned before it
// read the baseline, so a checkout another Mac had moved past put its older
// ControlPlane policy back on the server.
test("sync of a full-history project is refused before its policy is sent while main is behind the baseline", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  mkdirSync(join(dir, "docs", "control-plane"), { recursive: true });
  writeFileSync(join(dir, "docs", "control-plane", "execution-policy.v1.json"), JSON.stringify({ protected_path_patterns: ["src/**"] }));
  commitIn(f, dir, "docs/control-plane/execution-policy.v1.json", JSON.stringify({ protected_path_patterns: ["src/**"] }));
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  const refused = await run(t, f, a, ["sync", "--project", "demo"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, refusal(theirs, "atelier sync --project demo"));
  assert.deepEqual(refused.seen.map((s) => s.route), ["POST /api/projects/demo/baseline-token"], "nothing but the read token is asked for");
  assert.equal((await run(t, f, a, ["pull", "--project", "demo"])).code, 0);
  const ok = await run(t, f, a, ["sync", "--project", "demo"]);
  assert.equal(ok.code, 0, ok.output);
  assert.ok(ok.seen.some((s) => s.route === "PUT /api/projects/demo"), "the policy is sent once main holds the baseline");
});


// Review of t644, finding 4: a replacement ref can give a commit a parent it
// does not have. Pull and the guards read the objects themselves.
test("pull and wrap read the real history: a replacement ref does not make main hold the baseline", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const local = commitIn(f, dir, "mine.txt", "mine\n");
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  f.git(dir, "fetch", "-q", f.bare, "main");
  // The local commit claims the baseline's head as its parent.
  f.git(dir, "replace", "--graft", local, theirs);
  assert.equal(f.git(dir, "merge-base", "--is-ancestor", theirs, "HEAD"), "", "Git, with the replacement, says main holds it");
  const wrap = await run(t, f, a, ["wrap", "Mine", "--no-check", "--project", "demo"], { cwd: dir });
  assert.notEqual(wrap.code, 0);
  assert.match(wrap.output, refusal(theirs, "atelier wrap"));
  const pull = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(pull.code, 0, pull.output);
  assert.match(pull.output, /brought 1 commit from the baseline's main and merged them with 1 local commit/);
  assert.deepEqual(f.git(dir, "--no-replace-objects", "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [local, theirs]);
});


test("pull refuses a checkout with a grafts file or a shallow history, and changes nothing", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const head = f.git(dir, "rev-parse", "HEAD");
  commitElsewhere(f, "theirs.txt", "theirs\n");
  const gitDir = f.git(dir, "rev-parse", "--absolute-git-dir");
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "grafts"), `${head}\n`);
  const grafts = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(grafts.code, 0);
  assert.match(grafts.output, /the checkout has a grafts file \(info\/grafts\), which change the history Git shows.*Nothing was pulled\./);
  rmSync(join(gitDir, "info", "grafts"));
  writeFileSync(join(gitDir, "shallow"), `${f.git(dir, "rev-parse", "HEAD~1")}\n`);
  const shallow = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(shallow.code, 0);
  assert.match(shallow.output, /the checkout has a shallow history.*git fetch --unshallow.*Nothing was pulled\./);
  for (const r of [grafts, shallow]) assert.ok(!r.seen.some((s) => s.route.endsWith("/baseline-token")), "no token is asked for");
  assert.equal(f.git(dir, "rev-parse", "HEAD"), head);
});


test("merge names atelier pull while main does not hold the baseline's main", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const head = f.git(dir, "rev-parse", "HEAD");
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  f.accepted = theirs;
  const r = await run(t, f, a, ["merge", "t2", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, new RegExp(`main does not hold the baseline's main \\(${theirs.slice(0, 8)}\\): another checkout has carried commits to the baseline since this one last matched it\\. Nothing was merged\\. Run atelier pull --project demo to bring them into this checkout, then atelier merge t2 again\\.`));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), head);
});


// Astra's second review of t644: Git also reads a graft file that
// GIT_GRAFT_FILE names, outside the checkout, and the CLI's Git inherits its
// environment. A graft there giving the local commit the baseline's head as
// its parent made a checkout behind the baseline pass the guard.
test("a graft file GIT_GRAFT_FILE names does not make main hold the baseline, for the guards or for pull", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const local = commitIn(f, dir, "mine.txt", "mine\n");
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  f.git(dir, "fetch", "-q", f.bare, "main");
  const graft = join(f.root, "grafts-elsewhere");
  writeFileSync(graft, `${local} ${theirs}\n`);
  const env = { GIT_GRAFT_FILE: graft };
  assert.equal(execFileSync("git", ["merge-base", "--is-ancestor", theirs, "HEAD"], { cwd: dir, env: { ...f.env, ...env } }).toString(), "", "Git, with the graft, says main holds it");
  const wrap = await run(t, f, a, ["wrap", "Mine", "--no-check", "--project", "demo"], { cwd: dir, env });
  assert.notEqual(wrap.code, 0);
  assert.match(wrap.output, refusal(theirs, "atelier wrap"));
  const sync = await run(t, f, a, ["sync", "--project", "demo"], { env });
  assert.notEqual(sync.code, 0);
  assert.match(sync.output, refusal(theirs, "atelier sync --project demo"));
  f.accepted = theirs;
  const merged = await run(t, f, a, ["merge", "t2", "--project", "demo"], { env });
  assert.notEqual(merged.code, 0);
  assert.match(merged.output, /main does not hold the baseline's main .* Run atelier pull --project demo/);
  const pull = await run(t, f, a, ["pull", "--project", "demo"], { env });
  assert.equal(pull.code, 0, pull.output);
  assert.match(pull.output, /brought 1 commit from the baseline's main and merged them with 1 local commit/);
  assert.deepEqual(f.git(dir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [local, theirs]);
});


// Astra's third review of t644: a pull that changed a file this checkout's
// Git configuration runs (a hook, a filter or merge driver command, an
// included configuration file) would write it, and Git would run it, during
// the checkout or at the next command. pull refuses it as atelier merge does
// (touchedExecutables in cli/landing.mjs), with nothing changed.
test("pull refuses a baseline change to a file this checkout's Git configuration runs, and changes nothing", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const marker = join(f.root, "filter-ran");
  f.git(f.other, "pull", "-q", "--no-rebase", "origin", "main");
  mkdirSync(join(f.other, "tools"));
  commitElsewhere(f, "tools/clean.sh", "#!/bin/sh\ncat\n");
  assert.equal((await run(t, f, a, ["pull", "--project", "demo"])).code, 0);
  f.git(dir, "config", "--local", "filter.demo.clean", "sh tools/clean.sh");
  f.git(dir, "config", "--local", "core.hooksPath", ".githooks");
  const head = f.git(dir, "rev-parse", "HEAD");
  // A filter command and a hooks folder, each changed on the baseline.
  const theirs = commitElsewhere(f, "tools/clean.sh", `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
  const filter = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(filter.code, 0);
  assert.match(filter.output, new RegExp(`the baseline's main changes files that this checkout's Git configuration runs: tools/clean\\.sh, named by filter\\.demo\\.clean\\. Pulling it would run them, during the checkout or at your next Git command\\. Nothing was pulled: main is still at ${head.slice(0, 8)}, and the work tree is as it was\\. Review those files in ${theirs}`));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(dir, "tools", "clean.sh"), "utf8"), "#!/bin/sh\ncat\n");
  assert.equal(f.git(dir, "status", "--porcelain"), "");
  f.git(dir, "config", "--local", "--unset", "filter.demo.clean");
  f.git(f.other, "rm", "-q", "tools/clean.sh");
  f.git(f.other, "commit", "-q", "-m", "drop the script");
  f.git(f.other, "push", "-q", "origin", "main");
  mkdirSync(join(f.other, ".githooks"));
  commitElsewhere(f, ".githooks/post-merge", "#!/bin/sh\necho hook\n");
  commitIn(f, dir, "mine.txt", "mine\n");
  const hook = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(hook.code, 0);
  assert.match(hook.output, /changes files that this checkout's Git configuration runs: \.githooks\/post-merge, which reach \.githooks, the hooks folder named by core\.hooksPath/);
  assert.ok(!existsSync(join(dir, ".githooks")));
  assert.ok(!existsSync(marker));
});
