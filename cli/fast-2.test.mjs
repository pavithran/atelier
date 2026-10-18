// Part 2 of 2 of the tests that were in fast.test.mjs, split so no file runs for more than about a minute (t771).
// Fast mode's batch landing (t585) in a temporary repository, with stand-in
// commands and a stand-in recorder: a batch whose tests fail leaves main
// where it started and records nothing; one that passes records a receipt
// per task with the builder from its Agent line. Each SHA merges through the
// merge pipeline (t587), so a declared generated output both branches changed
// is regenerated instead of stopping the batch on a text conflict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { CLEAN_CLONE_SETUP, fastCommands, fastLand, recordPending, shellQuote, worktreeHolding } from "./fast.mjs";
import { git, repo, base, GENERATOR, generatedRepo, KEY, inCheckout, MANIFEST, leakBranch } from "./fast-shared.mjs";

// No test reads this Mac's own iCloud folder (t645).
process.env.ATELIER_PRIVATE_ROOT ||= `${process.env.TMPDIR || "/tmp"}/atelier-tests-no-icloud-${process.pid}`;


// Second review of t592: a test that left the checkout on another branch
// had that branch reset, and main kept the refused batch.
test("a test that switches branch is refused, and main, not the new branch, goes back to the start (finding 4)", async () => {
  const { dir, one } = repo();
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: "git checkout -q -b temporary", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "checkout changed");
    assert.match(r.failure.detail, /on temporary, not main/);
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(git(dir, "rev-parse", "main"), start);
    assert.equal(r.head, start);
    assert.notEqual(git(dir, "rev-parse", "temporary"), start, "the branch the test made is left as it was");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Third review of t592 (codex/gpt-6-astra): rollback ignored its own
// commands' results. A test that commits, switches branch and checks main
// out in a new worktree left rollback unable to check out main; it reset
// the wrong branch and the answer said main was restored.
test("a rollback that cannot restore main says so, naming main's head and the fix, and resets no other branch (finding 4)", async () => {
  const { dir, one } = repo();
  const holder = join(mkdtempSync(join(tmpdir(), "fast-land-holder-")), "wt");
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const id = "-c user.name=t -c user.email=t@example.com";
    const hijack = `printf 'k\\0AKIA' > late.bin && git ${id} add late.bin && git ${id} commit -q -m late && git checkout -q -b temporary && git worktree add -q ${JSON.stringify(holder)} main`;
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: hijack, record: () => assert.fail("recorded") });
    assert.equal(r.ok, false);
    assert.equal(r.failure.step, "checkout changed");
    const main = git(dir, "rev-parse", "refs/heads/main");
    assert.notEqual(main, start, "the scenario leaves main where rollback cannot reach it");
    assert.equal(r.restored, false);
    assert.equal(r.head, main);
    assert.match(r.restoreProblem, /main was NOT restored/);
    assert.ok(r.restoreProblem.includes(main.slice(0, 12)), "names main's head");
    assert.ok(r.restoreProblem.includes(realpathSync(holder)) || r.restoreProblem.includes(holder), "names the worktree holding main");
    assert.match(r.restoreProblem, new RegExp(`git --git-dir=.+ --work-tree=.+ reset --hard ${start}`));
    assert.equal(git(dir, "rev-parse", "temporary"), main, "the branch the test made was not reset");
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(dirname(holder), { recursive: true, force: true });
  }
});


// t639: atelier's own checkout keeps its repository off iCloud, with .git a
// gitdir file naming it. Git then lists the main worktree under the
// repository's path, so comparing paths with cwd's --show-toplevel took the
// checkout itself for another worktree holding main, and rollback would have
// sent the developer to reset the repository folder.
test("worktreeHolding tells worktrees apart by Git directory when the checkout's .git is a gitdir file (t639)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fast-land-gitdir-")));
  try {
    const checkout = join(root, "checkout"), repository = join(root, "repository.git"), linked = join(root, "linked");
    git(root, "init", "-q", "-b", "main", "--separate-git-dir", repository, checkout);
    assert.ok(readFileSync(join(checkout, ".git"), "utf8").startsWith("gitdir: "), "the checkout's .git is a gitdir file");
    git(checkout, "commit", "-q", "--allow-empty", "-m", "one");
    git(checkout, "branch", "other");
    git(checkout, "worktree", "add", "-q", linked, "other");
    assert.match(git(checkout, "worktree", "list", "--porcelain"), new RegExp(`^worktree ${repository}$`, "m"), "Git lists the main worktree under the repository's path");
    assert.equal(worktreeHolding(checkout, "refs/heads/main"), null, "the checkout's own main is not another worktree's");
    assert.equal(worktreeHolding(checkout, "refs/heads/other")?.path, linked, "finds the linked worktree holding a branch");
    assert.equal(worktreeHolding(linked, "refs/heads/other"), null, "the linked worktree's own branch is not another worktree's");
    assert.equal(worktreeHolding(linked, "refs/heads/main")?.path, repository, "from the linked worktree, the main worktree holds main");
    // The main worktree's folder is unknown in this layout, so no advice may
    // name repository.git as a working tree (t646); a linked one's is known.
    assert.deepEqual(worktreeHolding(linked, "refs/heads/main"), { path: repository, gitDir: repository, workTree: null, midway: null });
    assert.equal(worktreeHolding(checkout, "refs/heads/other")?.workTree, linked);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


// t646 (codex/gpt-6-astra's review of t639): a failing command that adds a
// linked worktree holding main inside the checkout and deletes its .git file
// left rev-parse inside that folder answering with the checkout's own Git
// directory, so rollback took the holder for the checkout itself and moved
// main past the holder's unreset index. The holder is found from Git's
// worktree registry instead.
test("a rollback finds the worktree holding main from Git's registry when its .git file was deleted (t646)", async () => {
  const { dir, one } = repo();
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const id = "-c user.name=t -c user.email=t@example.com";
    const hijack = `printf 'k\\0AKIA' > late.bin && git ${id} add late.bin && git ${id} commit -q -m late && git checkout -q -b temporary && git worktree add -q nested main && rm nested/.git`;
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: hijack, record: () => assert.fail("recorded") });
    assert.equal(r.ok, false);
    assert.equal(r.failure.step, "checkout changed");
    assert.ok(!existsSync(join(dir, "nested", ".git")), "the scenario deleted the holder's .git file");
    const main = git(dir, "rev-parse", "refs/heads/main");
    assert.notEqual(main, start, "main was not moved past the holder's unreset index");
    assert.equal(r.restored, false);
    assert.match(r.restoreProblem, /main was NOT restored/);
    assert.ok(r.restoreProblem.includes(join(realpathSync(dir), "nested")) || r.restoreProblem.includes(join(dir, "nested")), r.restoreProblem);
    assert.equal(worktreeHolding(dir, "refs/heads/main")?.path, r.restoreProblem.match(/checked out in the worktree (.+?), so/)[1]);
    // codex/gpt-6-astra's review of t646: the printed fix, `git -C <holder>
    // reset --hard`, found the checkout's repository from the holder's
    // folder, so following it reset `temporary` and left main where it was.
    // The fix the developer is given must act on the holder's own Git
    // directory: run from the checkout, it restores main and nothing else.
    const fix = r.restoreProblem.match(/Restore it with: (.+)$/)[1];
    assert.doesNotMatch(fix, /git -C /, fix);
    const temporary = git(dir, "rev-parse", "temporary");
    const ran = spawnSync("sh", ["-c", fix], { cwd: dir, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(git(dir, "rev-parse", "refs/heads/main"), start, "following the printed fix restores main");
    assert.equal(git(dir, "rev-parse", "temporary"), temporary, "following the printed fix leaves the checkout's own branch alone");
    assert.ok(existsSync(join(dir, "late.bin")), "following the printed fix leaves the checkout's files alone");
    assert.ok(!existsSync(join(dir, "nested", "late.bin")), "following the printed fix resets the holder's files");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// codex/gpt-6-astra's second review of t646: the fix rollback printed quoted
// paths with JSON.stringify, which a shell does not undo, so a repository at
// /tmp/project-$batch had $batch expanded and the fix aimed at another
// directory. Paths are now quoted for a POSIX shell, and the printed fix,
// run through sh, restores main from a repository whose folder holds $, a
// backtick and a single quote.
test("a rollback's printed fix works through sh when the repository's path holds $, a backtick and a quote (t646)", async () => {
  const { dir, one } = repo("project-$batch-`x`-it's");
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const id = "-c user.name=t -c user.email=t@example.com";
    const hijack = `printf 'k\\0AKIA' > late.bin && git ${id} add late.bin && git ${id} commit -q -m late && git checkout -q -b temporary && git worktree add -q nested main && rm nested/.git`;
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: hijack, record: () => assert.fail("recorded") });
    assert.equal(r.restored, false, JSON.stringify(r.failure));
    const fix = r.restoreProblem.match(/Restore it with: (.+)$/)[1];
    const ran = spawnSync("sh", ["-c", fix], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(ran.status, 0, `${fix}\n${ran.stderr}`);
    assert.equal(git(dir, "rev-parse", "refs/heads/main"), start, "following the printed fix restores main");
    assert.ok(!existsSync(join(dir, "nested", "late.bin")), "following the printed fix resets the holder's files");
  } finally { rmSync(dirname(dir), { recursive: true, force: true }); }
});


// t656: a worktree mid-rebase or mid-bisect on main has HEAD detached, so
// t646's worktreeHolding, which read only each worktree's HEAD, found no
// holder; checkout main failed and rollback moved main with update-ref
// under that worktree. Git itself refuses to check main out there, reading
// rebase-merge/head-name, rebase-apply/head-name and BISECT_START.
const midway = {
  "rebase-merge": (id) => `git ${id} -C nested rebase -q --exec false HEAD^ >/dev/null 2>&1; test -d .git/worktrees/nested/rebase-merge`,
  "rebase-apply": (id) => `printf side > late.bin && git ${id} commit -q -a -m side && printf mine > nested/late.bin && git ${id} -C nested commit -q -a -m mine && git ${id} -C nested rebase -q --apply temporary >/dev/null 2>&1; test -d .git/worktrees/nested/rebase-apply`,
  bisect: (id) => `git -C nested bisect start main HEAD~2 >/dev/null 2>&1 && test -f .git/worktrees/nested/BISECT_START`,
};

for (const [state, enter] of Object.entries(midway)) {
  test(`a rollback refuses to move main under a worktree mid-${state.split("-")[0]} on it (${state}, t656)`, async () => {
    const { dir, one } = repo();
    try {
      const start = git(dir, "rev-parse", "HEAD");
      const id = "-c user.name=t -c user.email=t@example.com";
      const hijack = `printf 'k\\0AKIA' > late.bin && git ${id} add late.bin && git ${id} commit -q -m late && git checkout -q -b temporary && git worktree add -q nested main && ${enter(id)} && false`;
      const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: hijack, record: () => assert.fail("recorded") });
      assert.equal(r.ok, false);
      assert.ok(existsSync(join(dir, ".git", "worktrees", "nested", state === "bisect" ? "BISECT_START" : state)), `the scenario left nested mid-${state}`);
      assert.doesNotMatch(readFileSync(join(dir, ".git", "worktrees", "nested", "HEAD"), "utf8"), /^ref:/, "the holder's HEAD is detached");
      const main = git(dir, "rev-parse", "refs/heads/main");
      assert.notEqual(main, start, "main was not moved under the worktree holding it");
      assert.equal(r.restored, false);
      assert.match(r.restoreProblem, /main was NOT restored/);
      assert.match(r.restoreProblem, new RegExp(`checked out in the worktree .*nested, mid-${state.split("-")[0]}, so fast land could not move it`));
      assert.equal(worktreeHolding(dir, "refs/heads/main")?.gitDir, realpathSync(join(dir, ".git", "worktrees", "nested")));
      // A reset in the detached holder would move its HEAD, not main: the
      // printed fix ends the rebase or bisect first, and run through sh it
      // restores main and leaves the holder's files at the start.
      const fix = r.restoreProblem.match(/Restore it with: (.+)$/)[1];
      const ran = spawnSync("sh", ["-c", fix], { cwd: tmpdir(), encoding: "utf8" });
      assert.equal(ran.status, 0, `${fix}\n${ran.stderr}`);
      assert.equal(git(dir, "rev-parse", "refs/heads/main"), start, "following the printed fix restores main");
      assert.ok(!existsSync(join(dir, "nested", "late.bin")), "following the printed fix resets the holder's files");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
// t672: a project command can leave the checkout itself mid-rebase or
// mid-bisect. Rollback ran only `git merge --abort`, so checkout -f main and
// reset --hard succeeded and left the state behind: main was restored but
// the checkout stayed mid-rebase or mid-bisect.
// The second variant leaves an untracked file that returning to the original
// commit would overwrite, so `rebase --abort` and `bisect reset` fail: both
// reviews of t672 found the rollback still reported success, mid-operation.
for (const [state, { dir: marker, enter }] of Object.entries(inCheckout).flatMap((e) => [[e[0], e[1], ""], [e[0] + " with a conflicting untracked file", { ...e[1], enter: e[1].enterBefore ?? e[1].enter }, " && printf x > late.bin"]]).map(([n, v, tail]) => [n, { ...v, enter: (id) => v.enter(id) + tail }])) {
  test(`a rollback ends a ${state} the project command left in the checkout itself (t672)`, async () => {
    const { dir, one } = repo();
    try {
      const start = git(dir, "rev-parse", "HEAD");
      const id = "-c user.name=t -c user.email=t@example.com";
      const hijack = `printf 'k\\0AKIA' > late.bin && git ${id} add late.bin && git ${id} commit -q -m late && ${enter(id)} && false`;
      const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: hijack, record: () => assert.fail("recorded") });
      assert.equal(r.ok, false);
      assert.equal(r.restored, true, r.restoreProblem);
      assert.equal(git(dir, "rev-parse", "refs/heads/main"), start, "main is back at the start");
      assert.equal(git(dir, "symbolic-ref", "HEAD"), "refs/heads/main", "the checkout is on main");
      assert.ok(!existsSync(join(dir, ".git", marker)), `the ${state} state is gone`);
      assert.ok(!existsSync(join(dir, "late.bin")), "the start commit has no late.bin");
      assert.ok(!existsSync(join(dir, ".git", "rebase-merge")) && !existsSync(join(dir, ".git", "BISECT_START")), "no rebase or bisect state remains");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}


// t656: the main worktree keeps its rebase and bisect state in the common
// Git directory, and Git lists it as detached while it is mid-rebase.
test("worktreeHolding finds the main worktree mid-rebase on main from a linked worktree (t656)", () => {
  const { dir } = repo();
  const linked = join(mkdtempSync(join(tmpdir(), "fast-land-linked-")), "wt");
  try {
    git(dir, "worktree", "add", "-q", linked, "one");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, "add", "b.txt"); git(dir, "commit", "-q", "-m", "b");
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "rebase", "-q", "--exec", "false", "HEAD^"], { cwd: dir, encoding: "utf8" });
    assert.ok(existsSync(join(dir, ".git", "rebase-merge")), "the main worktree is mid-rebase");
    assert.match(git(dir, "worktree", "list", "--porcelain").split("\n\n")[0], /^detached$/m, "Git lists it as detached");
    assert.deepEqual(worktreeHolding(linked, "refs/heads/main"), { path: realpathSync(dir), gitDir: realpathSync(join(dir, ".git")), workTree: realpathSync(dir), midway: "rebase" });
    assert.equal(worktreeHolding(linked, "refs/heads/two"), null, "it holds only the branch it is rebasing");
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(dirname(linked), { recursive: true, force: true });
  }
});


test("shellQuote quotes a path for a POSIX shell (t646)", () => {
  for (const path of ["/tmp/plain", "/tmp/project-$batch", "/tmp/`x`", "/tmp/it's", "/tmp/a b\\c\"d", ""]) {
    assert.equal(spawnSync("sh", ["-c", `printf %s ${shellQuote(path)}`], { encoding: "utf8" }).stdout, path);
  }
});


// Fourth review of t592 (codex/gpt-6-astra): a typecheck or regeneration
// script that moved main back before the scan left the scan an empty range,
// the head checks compared against that moved head, and the receipts named
// merges main no longer held (which may hold a credential).
for (const [step, opts] of [["typecheck", { typecheck: "git reset -q --hard HEAD^1" }], ["regen", { regen: "git reset -q --hard HEAD^1" }]]) {
  test(`a ${step} that moves main back before the scan stops the batch, nothing recorded (finding 4)`, async () => {
    const { dir, one, two } = repo();
    try {
      const start = git(dir, "rev-parse", "HEAD");
      const recorded = [];
      const r = await fastLand({ ...base, ...opts, cwd: dir, pairs: [{ id: "t1", sha: one }, { id: "t2", sha: two }], test: "true", record: (id) => { recorded.push(id); return { ok: true }; } });
      assert.equal(r.ok, false, "the batch is refused");
      assert.equal(r.failure.step, "checkout changed");
      assert.match(r.failure.detail, /main moved/);
      assert.deepEqual(recorded, []);
      assert.equal(git(dir, "rev-parse", "main"), start);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}


// Fifth review of t592 (t606): a subtree the scan could not read lost its
// path, because the path was recovered with a recursive ls-tree that fails
// as a whole when any subtree is missing. The walk now goes level by level
// and names the deepest path it reached.
test("a subtree the scan cannot read stops the batch, naming its path (finding 4)", async () => {
  const { dir } = repo();
  try {
    mkdirSync(join(dir, "nested"));
    const sha = leakBranch(dir, [{ "nested/k.txt": "first\n" }, { "nested/k.txt": null }]);
    const lost = git(dir, "rev-parse", `${sha}^:nested`);
    rmSync(join(dir, ".git", "objects", lost.slice(0, 2), lost.slice(2)));
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: { t3: "Lost" }, cwd: dir, pairs: [{ id: "t3", sha }], test: "true", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "secret scan", JSON.stringify(r.failure));
    assert.match(r.failure.detail, /(^|[ :,])nested\/ \(.*cannot be read/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Sixth review of t592 (codex/gpt-6-astra): a declared generator, run inside
// the merge, could point MERGE_HEAD at HEAD. Its write checks read git
// status, which ignores Git's own files, so the merge commit left out the
// task's commit, and fast land recorded it as landed.
const MERGE_HEAD_GENERATOR = `${GENERATOR}
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
const mergeHead = execFileSync("git", ["rev-parse", "--git-path", "MERGE_HEAD"], { encoding: "utf8" }).trim();
if (existsSync(mergeHead)) writeFileSync(mergeHead, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }));
`;


test("a merge whose commit does not have the task's commit as a parent stops the batch, nothing recorded (finding 4)", async () => {
  const { dir, push, land } = generatedRepo(MERGE_HEAD_GENERATOR);
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const recorded = [];
    const r = await fastLand({ ...base, titles: { t1: "Push", t2: "Land" }, cwd: dir, pairs: [{ id: "t1", sha: push }, { id: "t2", sha: land }], test: "true", record: (id) => { recorded.push(id); return { ok: true }; } });
    assert.equal(r.ok, false, "the batch is refused");
    assert.equal(r.failure.step, "merge t2");
    assert.match(r.failure.detail, /parents/);
    assert.deepEqual(recorded, []);
    assert.equal(git(dir, "rev-parse", "main"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Seventh review of t592 (codex/gpt-6-astra): git cat-file does not check a
// loose object against its id, so a script that rewrote the object's file
// under .git/objects made the scan read other bytes than the ones that land.
test("an object whose bytes do not hash to its id stops the batch, naming its path (finding 4)", async () => {
  const { dir } = repo();
  try {
    const sha = leakBranch(dir, [{ "k.txt": KEY }, { "k.txt": "second\n" }]);
    const leak = git(dir, "rev-parse", `${sha}^:k.txt`);
    const file = join(dir, ".git", "objects", leak.slice(0, 2), leak.slice(2));
    const harmless = Buffer.from("harmless\n");
    rmSync(file);
    writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`blob ${harmless.length}\0`), harmless])));
    assert.equal(git(dir, "cat-file", "blob", leak), "harmless", "git reads the forged bytes");
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: { t3: "Forged" }, cwd: dir, pairs: [{ id: "t3", sha }], test: "true", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "secret scan", JSON.stringify(r.failure));
    assert.match(r.failure.detail, /k\.txt \(.*does not hash to its id/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Eighth review of t592 (codex/gpt-6-astra): the raw tree parser checked no
// separator, NUL, id length or progress, so 21 bytes with no space made it
// loop forever. A malformed tree, stored under its correct id, now stops
// the batch, named by its path.
test("a malformed tree under its correct id stops the batch promptly, naming its path (finding 4)", { timeout: 20_000 }, async () => {
  const { dir } = repo();
  try {
    const plumb = (input, ...a) => execFileSync("git", a, { cwd: dir, input, encoding: "utf8" }).trim();
    const bad = plumb("A".repeat(21), "hash-object", "-t", "tree", "--literally", "-w", "--stdin");
    const mainTree = git(dir, "ls-tree", "main");
    const withNested = plumb(`${mainTree}\n040000 tree ${bad}\tnested\n`, "mktree", "--missing");
    const first = git(dir, "commit-tree", withNested, "-p", "main", "-m", "nested");
    const b = plumb("b\n", "hash-object", "-w", "--stdin");
    const later = plumb(`${mainTree}\n100644 blob ${b}\tb.txt\n`, "mktree");
    const sha = git(dir, "commit-tree", later, "-p", first, "-m", "later\n\nAgent: codex/gpt-6");
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: { t3: "Malformed" }, cwd: dir, pairs: [{ id: "t3", sha }], test: "true", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "secret scan", JSON.stringify(r.failure));
    assert.match(r.failure.detail, /(^|[ :,])nested\/ \(.*malformed/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Eighth review of t592: the objects the scan read were not checked again
// after the tests, so a test command could delete one and the batch landed
// a history main could not show in full.
// Ninth review of t592: the post-test check named a missing object by an
// abbreviated id or a Git error, not by its path. A blob and a directory
// an intermediate commit added are deleted; both are named by path.
test("objects of the batch deleted after the scan stop the batch, named by path (finding 4)", async () => {
  const { dir } = repo();
  try {
    mkdirSync(join(dir, "nested")); mkdirSync(join(dir, "other"));
    const sha = leakBranch(dir, [{ "nested/k.txt": "first\n", "other/x.txt": "x\n" }, { "nested/k.txt": "second\n", "other/x.txt": null }]);
    const objects = [git(dir, "rev-parse", `${sha}^:nested/k.txt`), git(dir, "rev-parse", `${sha}^:other`)];
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: { t3: "Deleted" }, cwd: dir, pairs: [{ id: "t3", sha }], test: objects.map((o) => `rm -f .git/objects/${o.slice(0, 2)}/${o.slice(2)}`).join(" && "), record: () => assert.fail("recorded") });
    assert.equal(r.ok, false, "the batch is refused");
    assert.equal(r.failure.step, "objects changed");
    assert.match(r.failure.detail, /nested\/k\.txt \(/);
    assert.match(r.failure.detail, /other\/ \(/);
    assert.equal(git(dir, "rev-parse", "main"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Tenth review of t592 (t618): the post-test check read only the objects
// new to start..head, so a blob the batch reuses from earlier history (here
// a.txt's first content, which a batch commit puts back) was never checked
// again, and a test that deleted it after the scan had receipts recorded
// for history main could no longer show. Every object the scan read is now
// checked again, reused ones included.
test("a reused blob deleted after the scan stops the batch, named by path (t618)", async () => {
  const { dir } = repo();
  try {
    const reused = git(dir, "rev-parse", "main:a.txt");
    const sha = leakBranch(dir, [{ "a.txt": "changed\n" }, { "a.txt": "a\n", "b.txt": "b\n" }]);
    assert.equal(git(dir, "rev-parse", `${sha}:a.txt`), reused, "the batch's head holds the blob main held before it");
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: { t3: "Reused" }, cwd: dir, pairs: [{ id: "t3", sha }], test: `rm -f .git/objects/${reused.slice(0, 2)}/${reused.slice(2)}`, record: () => assert.fail("recorded") });
    assert.equal(r.ok, false, "the batch is refused");
    assert.equal(r.failure.step, "objects changed", JSON.stringify(r.failure));
    assert.match(r.failure.detail, /(^|[ :,])a\.txt \(/);
    assert.equal(git(dir, "rev-parse", "main"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Review of t618 (gpt-6-astra, gemini-4-argon): checking only the objects
// new to start..head and those the scan read still missed every object the
// batch's trees hold unchanged from main (the scan skips unchanged entries),
// such as a.txt here, which no batch commit touches. The check now covers
// the full tree of every batch commit, and an object no changed entry
// leads to is named by the paths that hold it.
test("an unchanged blob the batch inherits from main, deleted after the scan, stops the batch named by path (t618)", async () => {
  const { dir, one } = repo();
  try {
    const inherited = git(dir, "rev-parse", "main:a.txt");
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: `rm -f .git/objects/${inherited.slice(0, 2)}/${inherited.slice(2)}`, record: () => assert.fail("recorded") });
    assert.equal(r.ok, false, "the batch is refused");
    assert.equal(r.failure.step, "objects changed", JSON.stringify(r.failure));
    assert.match(r.failure.detail, /(^|[ :,])a\.txt \(/);
    assert.equal(git(dir, "rev-parse", "main"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// A mode-only change keeps the blob main holds, and the scan does not read
// it (review of t618, gemini-4-argon).
test("a blob a batch commit only changes the mode of, deleted after the scan, stops the batch (t618)", async () => {
  const { dir } = repo();
  try {
    const kept = git(dir, "rev-parse", "main:a.txt");
    git(dir, "checkout", "-q", "-b", "mode", "main");
    git(dir, "update-index", "--chmod=+x", "a.txt");
    git(dir, "commit", "-q", "-m", "mode\n\nAgent: codex/gpt-6");
    const sha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-f", "main");
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: { t3: "Mode" }, cwd: dir, pairs: [{ id: "t3", sha }], test: `rm -f .git/objects/${kept.slice(0, 2)}/${kept.slice(2)}`, record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "objects changed", JSON.stringify(r.failure));
    assert.match(r.failure.detail, /(^|[ :,])a\.txt \(/);
    // Main at the start needs the deleted blob too, with the other mode, so
    // the rollback's reset cannot write a.txt; fast land says so.
    if (git(dir, "rev-parse", "main") !== start) assert.match(r.restoreProblem, /main was NOT restored/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Ninth review of t592: the history checks (replacement refs, grafts, a
// shallow boundary) ran only before the tests, so a test that wrote
// .git/shallow after the scan cut the post-test object walk short.
test("a shallow boundary a test writes after the scan stops the batch (finding 4)", async () => {
  const { dir, one } = repo();
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: `echo ${one} > .git/shallow`, record: () => assert.fail("recorded") });
    assert.equal(r.ok, false, "the batch is refused");
    assert.equal(r.failure.step, "checkout changed");
    assert.match(r.failure.detail, /shallow boundary/);
    assert.equal(git(dir, "rev-parse", "main"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a blob the scan cannot read stops the batch, naming its path (finding 4)", async () => {
  const { dir } = repo();
  try {
    const sha = leakBranch(dir, [{ "k.txt": "first\n" }, { "k.txt": "second\n" }]);
    const lost = git(dir, "rev-parse", `${sha}^:k.txt`);
    rmSync(join(dir, ".git", "objects", lost.slice(0, 2), lost.slice(2)));
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: { t3: "Lost" }, cwd: dir, pairs: [{ id: "t3", sha }], test: "true", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "secret scan", JSON.stringify(r.failure));
    assert.match(r.failure.detail, /k\.txt \(.*cannot be read/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Astra's audit of 2026-10-13, finding 9 (t602): receipts were posted one by
// one after the merges, and when one failed main already held the batch, so
// running fast land again refused the recorded task and the unrecorded one
// alike (main already holds its commit), and nothing could finish recording.
// The receipts are now written under .git before any is posted, and
// recordPending posts only the ones not yet recorded, without merging.
function failingSecond() {
  const calls = [];
  const record = (id, receipt) => {
    calls.push([id, receipt]);
    if (calls.length === 2) throw new Error("the server did not answer");
    return { ok: true };
  };
  return { calls, record };
}


test("a receipt that fails is kept under .git, and recordPending records the rest without merging (finding 9)", async () => {
  const { dir, one, two } = repo();
  try {
    const { calls, record } = failingSecond();
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }, { id: "t2", sha: two }], test: "true", note: { project: "demo", reviewer: "opencode/glm-5.3" }, record });
    assert.equal(r.ok, false);
    assert.equal(r.failure.step, "record t2");
    assert.equal(r.failure.merged, true);
    assert.deepEqual(r.recorded, ["t1"]);
    assert.deepEqual(r.unrecorded, ["t2"]);
    assert.equal(git(dir, "rev-parse", "main"), r.head, "main keeps the checked batch");
    const file = join(dir, ".git", "atelier-fast-land", `${r.start}..${r.head}.json`);
    assert.equal(realpathSync(r.pending), realpathSync(file));
    const kept = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(kept.project, "demo");
    assert.equal(kept.reviewer, "opencode/glm-5.3");
    assert.deepEqual(kept.receipts.map((x) => [x.task, x.commit, x.builder, x.recorded]), [["t1", one, "claude-code/opus-5.5", true], ["t2", two, "codex/gpt-6", false]]);
    assert.equal(kept.receipts[1].mergeCommit, r.head);
    assert.deepEqual(kept.receipts[1].tests, calls[0][1].tests);

    const head = git(dir, "rev-parse", "HEAD"), count = git(dir, "rev-list", "--count", "HEAD");
    const again = [];
    const resumed = await recordPending({ cwd: dir, record: (id, receipt) => { again.push([id, receipt]); return { ok: true }; } });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.failure));
    assert.deepEqual(again.map(([id]) => id), ["t2"], "only the receipt not yet recorded is posted");
    assert.deepEqual(again[0][1], calls[1][1], "the same receipt fast land tried");
    assert.deepEqual(resumed.already, ["t1"]);
    assert.deepEqual(resumed.landed.map((l) => [l.id, l.mergeCommit]), [["t2", r.head]]);
    assert.equal(git(dir, "rev-parse", "HEAD"), head, "nothing is merged again");
    assert.equal(git(dir, "rev-list", "--count", "HEAD"), count);
    assert.equal(existsSync(file), false, "the file is removed once every receipt is recorded");
    await assert.rejects(recordPending({ cwd: dir, record: () => assert.fail("recorded") }), /no fast landing waits to be recorded/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("recordPending refuses when main no longer holds a receipt's merge commit, recording nothing (finding 9)", async () => {
  const { dir, one, two } = repo();
  try {
    const { record } = failingSecond();
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }, { id: "t2", sha: two }], test: "true", record });
    assert.equal(r.failure?.step, "record t2");
    git(dir, "reset", "-q", "--hard", `${r.head}^1`);
    await assert.rejects(recordPending({ cwd: dir, file: r.pending, record: () => assert.fail("recorded") }), (err) => {
      assert.match(err.message, /main no longer holds t2's merge commit/);
      assert.ok(err.message.includes(r.head.slice(0, 12)));
      return true;
    });
    assert.equal(existsSync(r.pending), true, "the file is kept");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Review of t602 (gpt-6-astra): the resume checked the merges' ancestry,
// parents, subjects and builders but not their objects, so a blob of the
// batch deleted between the failed receipt and the resume still had the
// receipt posted for history main could not show.
test("recordPending refuses when an object of the batch was damaged after the failed receipt, recording nothing (finding 9)", async () => {
  const { dir, one, two } = repo();
  try {
    const { record } = failingSecond();
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }, { id: "t2", sha: two }], test: "true", record });
    assert.equal(r.failure?.step, "record t2");
    const blob = git(dir, "rev-parse", `${two}:two.txt`);
    rmSync(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    await assert.rejects(recordPending({ cwd: dir, file: r.pending, record: () => assert.fail("recorded") }), (err) => {
      assert.match(err.message, /nothing was recorded/);
      assert.match(err.message, /(^|[ :,])two\.txt \(/);
      return true;
    });
    assert.equal(existsSync(r.pending), true, "the file is kept");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Re-review of t602 (gpt-6-astra): the resume compared the shallow boundary
// with itself, so a .git/shallow written after the failed receipt was never
// seen, and the object check then stopped at that boundary. The boundary
// fast land saw is kept in the receipts file and compared at the resume.
test("recordPending refuses when the shallow boundary changed since fast land, recording nothing (finding 9)", async () => {
  const { dir, one, two } = repo();
  try {
    const { record } = failingSecond();
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }, { id: "t2", sha: two }], test: "true", record });
    assert.equal(r.failure?.step, "record t2");
    writeFileSync(join(dir, ".git", "shallow"), `${two}\n`);
    await assert.rejects(recordPending({ cwd: dir, file: r.pending, record: () => assert.fail("recorded") }), (err) => {
      assert.match(err.message, /nothing was recorded/);
      assert.match(err.message, /shallow boundary/);
      return true;
    });
    assert.equal(existsSync(r.pending), true, "the file is kept");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a batch that fails before the receipts leaves no receipts file (finding 9)", async () => {
  const { dir, one } = repo();
  try {
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: "exit 1", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "tests");
    assert.equal(existsSync(join(dir, ".git", "atelier-fast-land")), false);
    const ok = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: "true", record: () => ({ ok: true }) });
    assert.equal(ok.ok, true);
    assert.equal(existsSync(join(dir, ".git", "atelier-fast-land", `${ok.start}..${ok.head}.json`)), false, "a batch fully recorded leaves no file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Review of t593 (codex/gpt-6-astra): fast land's merges ran Git with the
// developer's whole environment and hooks on, so a checkout whose
// core.hooksPath is a tracked directory let an agent-changed hook read the
// developer's secrets before any filtered command ran.
test("Git hooks an agent changes neither run nor see the developer's variables during fast land (finding 5)", async () => {
  const { dir } = repo();
  const probe = join(mkdtempSync(join(tmpdir(), "fast-land-hook-")), "seen");
  const saved = process.env.FAST_LAND_PROBE_TOKEN;
  process.env.FAST_LAND_PROBE_TOKEN = "developer-secret";
  try {
    git(dir, "config", "core.hooksPath", ".githooks");
    git(dir, "checkout", "-q", "-b", "hooks", "main");
    mkdirSync(join(dir, ".githooks"));
    const hook = `#!/bin/sh\necho "$(basename "$0") $FAST_LAND_PROBE_TOKEN" >> ${JSON.stringify(probe)}\nexit 0\n`;
    for (const name of ["pre-commit", "commit-msg", "post-commit", "pre-merge-commit", "post-merge", "post-checkout", "reference-transaction"]) writeFileSync(join(dir, ".githooks", name), hook, { mode: 0o755 });
    git(dir, "add", "-A"); git(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "hooks\n\nAgent: codex/gpt-6");
    const sha = git(dir, "rev-parse", "HEAD");
    git(dir, "-c", "core.hooksPath=/dev/null", "checkout", "-q", "main");
    const r = await fastLand({ ...base, titles: { t8: "Hooks" }, cwd: dir, pairs: [{ id: "t8", sha }], regen: "echo generated > gen.txt", test: "true", record: () => ({ ok: true }) });
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.equal(existsSync(probe) ? readFileSync(probe, "utf8") : "", "", "no hook ran");
  } finally {
    if (saved === undefined) delete process.env.FAST_LAND_PROBE_TOKEN; else process.env.FAST_LAND_PROBE_TOKEN = saved;
    rmSync(dir, { recursive: true, force: true }); rmSync(dirname(probe), { recursive: true, force: true });
  }
});


// t667: the batch's commands come from the checkout's own scripts, and a
// project without them is refused before anything merges, naming the flag.
test("fast land takes its default commands from the checkout's package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-fast-commands-"));
  try {
    const scripts = (s) => writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: s }));
    scripts({ typecheck: "tsc", types: "gen", test: "node --test" });
    assert.deepEqual(fastCommands(dir), { typecheck: "npm run typecheck", test: "npm test", cleanClone: { setup: CLEAN_CLONE_SETUP } });
    // No types script: the clean clone installs and does not run it.
    scripts({ typecheck: "tsc", test: "vitest run" });
    assert.deepEqual(fastCommands(dir).cleanClone, { setup: "npm ci --prefer-offline" });
    // ikon-weblog's shape: check and test, no typecheck.
    scripts({ check: "astro check", test: "vitest run" });
    const refused = fastCommands(dir);
    assert.match(refused.refusal, /--typecheck CMD \(no "typecheck" script in package\.json\)/);
    assert.match(refused.refusal, /nothing was merged/);
    assert.match(refused.refusal, /Its scripts: check, test/);
    assert.doesNotMatch(refused.refusal, /--test/);
    // The flags the owner gives stand in for the missing scripts.
    assert.deepEqual(fastCommands(dir, { typecheck: "npm run check" }), { typecheck: "npm run check", test: "npm test", cleanClone: { setup: "npm ci --prefer-offline" } });
    assert.deepEqual(fastCommands(dir, { typecheck: "npm run check", test: "npm test" }).cleanClone, null);
    // No package.json at all: both flags are named.
    rmSync(join(dir, "package.json"));
    assert.match(fastCommands(dir).refusal, /--typecheck CMD .* and --test CMD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
