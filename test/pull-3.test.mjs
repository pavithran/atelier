// Part 3 of 3 of the tests that were in pull.test.mjs, split so no file runs for more than about a minute (t771).
// atelier pull (t644), and the refusals of sync, publish and fast land while
// a checkout's main does not hold the baseline's. Two Macs share a project's
// baseline: each test makes their checkouts with atelier clone, each Mac with
// its own Atelier config and cache, against a stand-in server whose
// baseline-token answer names a bare repository, on disk or served over HTTP
// behind a token check (test/helpers/git-http.mjs). All of it lives under
// os.tmpdir().
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, commitElsewhere, commitIn, mac, run, cloneOn, cli, serve, TOKEN, IDENTITY } from "./pull-shared.mjs";

// Astra's fourth review of t644: a configuration file an include.path names
// that does not exist yet is protected too, so a pull cannot add it.
test("pull refuses a baseline that adds the configuration file an include.path names", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  f.git(dir, "config", "--local", "include.path", "../extra.gitconfig");
  const head = f.git(dir, "rev-parse", "HEAD");
  commitElsewhere(f, "extra.gitconfig", "[core]\n\tfsmonitor = ./tools/watch.sh\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /changes files that this checkout's Git configuration runs: extra\.gitconfig, a Git configuration file this checkout includes\./);
  assert.ok(!existsSync(join(dir, "extra.gitconfig")));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), head);
});


// Astra's fifth review of t644: where main tracks a file `docs` and the
// baseline puts a folder there, the check for ignored files read
// docs/readme.md below a file, and the error ended a fast-forward that is
// fine. A file in the way that Git does not track is still refused.
test("pull fast-forwards over a tracked file the baseline replaces with a folder, and refuses an untracked file in the way", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  f.git(f.other, "pull", "-q", "--no-rebase", "origin", "main");
  commitElsewhere(f, "docs", "a file\n");
  const dir = await cloneOn(t, f, a);
  f.git(f.other, "rm", "-q", "docs");
  mkdirSync(join(f.other, "docs"));
  const theirs = commitElsewhere(f, "docs/readme.md", "a folder\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(r.code, 0, r.output);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), theirs);
  assert.equal(readFileSync(join(dir, "docs", "readme.md"), "utf8"), "a folder\n");
  // An ignored file where the baseline puts a folder.
  writeFileSync(join(f.git(dir, "rev-parse", "--absolute-git-dir"), "info", "exclude"), "notes\n");
  writeFileSync(join(dir, "notes"), "my notes\n");
  mkdirSync(join(f.other, "notes"));
  commitElsewhere(f, "notes/a.md", "the baseline's\n");
  const refused = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, /the baseline's main adds notes\/a\.md, which this checkout holds as a file Git does not track/);
  assert.equal(readFileSync(join(dir, "notes"), "utf8"), "my notes\n");
});


// Astra's fifth review of t644: pull's merge commit and its merge of the
// receipts took author and committer from this Mac's Git configuration and
// the caller's environment. They carry the project's commit identity, as
// atelier merge's commits do: atelier is public and commits as its noreply
// address.
test("pull's merge and its merge of the receipts carry the project's identity, whatever this Mac and its environment name", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  f.git(dir, "config", "--local", "user.name", "Personal Name");
  f.git(dir, "config", "--local", "user.email", "personal@me.test");
  commitIn(f, dir, "mine.txt", "mine\n");
  f.git(dir, "notes", "--ref=atelier", "add", "-m", "Local receipt", "HEAD");
  commitElsewhere(f, "theirs.txt", "theirs\n", { note: "Atelier receipt for t2" });
  const personal = { GIT_AUTHOR_NAME: "Personal Name", GIT_AUTHOR_EMAIL: "personal@me.test", GIT_COMMITTER_NAME: "Personal Name", GIT_COMMITTER_EMAIL: "personal@me.test" };
  const r = await run(t, f, a, ["pull", "--project", "demo"], { env: personal });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /merged them with 1 local commit/);
  const who = (ref) => f.git(dir, "log", "-1", "--format=%an <%ae>|%cn <%ce>", ref);
  const project = `${IDENTITY.name} <${IDENTITY.email}>`;
  assert.equal(who("HEAD"), `${project}|${project}`, "the merge commit");
  assert.equal(f.git(dir, "rev-list", "--parents", "-n", "1", "refs/notes/atelier").split(" ").length, 3, "the receipts were merged, not fast-forwarded");
  assert.equal(who("refs/notes/atelier"), `${project}|${project}`, "the receipts' merge commit");
});


// Many projects have no commit identity yet. A pull that only
// fast-forwards makes no commit and needs none; one that would make a merge
// commit, of main or of the receipts, is refused before anything changes.
test("a project with no commit identity fast-forwards, and a pull that would merge is refused with nothing changed", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  f.noIdentity = true;
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n", { note: "Atelier receipt for t2" });
  const ff = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(ff.code, 0, ff.output);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), theirs);
  assert.equal(f.git(dir, "notes", "--ref=atelier", "show", theirs), "Atelier receipt for t2");
  // Diverged: a local commit with a local receipt, and more on the baseline.
  const local = commitIn(f, dir, "mine.txt", "mine\n");
  f.git(dir, "notes", "--ref=atelier", "add", "-m", "Local receipt", local);
  const notesBefore = f.git(dir, "rev-parse", "refs/notes/atelier");
  commitElsewhere(f, "more.txt", "more\n", { note: "Atelier receipt for t3" });
  const merge = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(merge.code, 0);
  assert.match(merge.output, /demo has no commit identity in its policy; the developer sets one with atelier init --commit-name NAME --commit-email EMAIL.*\. Nothing was pulled: main and the baseline's main each hold commits the other lacks, and this checkout's receipts and the baseline's each hold notes the other lacks, so pull would make a merge commit, and it makes one only under the project's identity\./);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), local);
  assert.equal(f.git(dir, "rev-parse", "refs/notes/atelier"), notesBefore, "the receipts are as they were");
  assert.equal(f.git(dir, "status", "--porcelain"), "");
});


// t651: a name another Mac adds to the project's list of private files in
// iCloud after this checkout was cloned is linked by the next pull that
// succeeds, never by one that is refused or conflicts. Before t651, pull
// linked nothing, and the new file stayed out of the checkout until atelier
// private add ran by hand.
test("pull links a private file the iCloud list named since the clone, and a refused or conflicting pull links nothing", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const icloud = join(f.root, "icloud"), home = join(icloud, "demo");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".atelier-private"), "PROJECT.md\n");
  writeFileSync(join(home, "PROJECT.md"), "my plan\n");
  const env = { ATELIER_PRIVATE_ROOT: icloud };
  const dir = join(f.root, "checkout-a");
  const cloned = await run(t, f, a, ["clone", "demo", dir], { env });
  assert.equal(cloned.code, 0, cloned.output);
  assert.equal(readlinkSync(join(dir, "PROJECT.md")), join(home, "PROJECT.md"));

  // Another Mac names NOTES.md private.
  writeFileSync(join(home, ".atelier-private"), "NOTES.md\nPROJECT.md\n");
  writeFileSync(join(home, "NOTES.md"), "my notes\n");

  // A conflicting pull links nothing.
  const local = commitIn(f, dir, "file.txt", "version mine\n");
  commitElsewhere(f, "file.txt", "version theirs\n");
  const conflict = await run(t, f, a, ["pull", "--project", "demo"], { env });
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.output, /the changes conflict/);
  assert.doesNotMatch(conflict.output, /Private files/);
  assert.ok(!existsSync(join(dir, "NOTES.md")));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), local);

  // A refused pull links nothing.
  f.git(dir, "reset", "-q", "--hard", "HEAD~1");
  writeFileSync(join(dir, "file.txt"), "uncommitted\n");
  const refused = await run(t, f, a, ["pull", "--project", "demo"], { env });
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, /uncommitted changes/);
  assert.ok(!existsSync(join(dir, "NOTES.md")));
  f.git(dir, "checkout", "-q", "--", "file.txt");

  // A fast-forward links it, says so, and Git ignores it.
  const pulled = await run(t, f, a, ["pull", "--project", "demo"], { env });
  assert.equal(pulled.code, 0, pulled.output);
  assert.match(pulled.output, /demo: brought 1 commit from the baseline's main/);
  assert.match(pulled.output, new RegExp(`Private files linked from ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: NOTES\\.md, PROJECT\\.md\\.`));
  assert.equal(readlinkSync(join(dir, "NOTES.md")), join(home, "NOTES.md"));
  assert.equal(f.git(dir, "status", "--porcelain"), "");
  assert.deepEqual(a.projects.demo.privateFromList.sort(), ["NOTES.md", "PROJECT.md"]);

  // A merge with local commits links the next one too, and one that cannot
  // be linked, a file standing where its link would go, is left alone and
  // said.
  writeFileSync(join(home, ".atelier-private"), "NOTES.md\nPLAN.md\nPROJECT.md\nTODO.md\n");
  writeFileSync(join(home, "PLAN.md"), "a plan\n");
  writeFileSync(join(home, "TODO.md"), "to do\n");
  writeFileSync(join(f.git(dir, "rev-parse", "--absolute-git-dir"), "info", "exclude"), "TODO.md\n", { flag: "a" });
  writeFileSync(join(dir, "TODO.md"), "my own\n");
  commitIn(f, dir, "mine.txt", "mine\n");
  commitElsewhere(f, "theirs.txt", "theirs\n");
  const merged = await run(t, f, a, ["pull", "--project", "demo"], { env });
  assert.equal(merged.code, 0, merged.output);
  assert.match(merged.output, /merged them with 1 local commit/);
  assert.equal(readlinkSync(join(dir, "PLAN.md")), join(home, "PLAN.md"));
  assert.match(merged.output, /TODO\.md: a file Atelier did not link is already in the checkout; it was left as it is, not linked\./);
  assert.equal(readFileSync(join(dir, "TODO.md"), "utf8"), "my own\n");
});


// A project with no private files on this Mac: pull reads nothing from
// iCloud and says nothing of them, though a folder there is named for it.
test("pull of a project with no private files links nothing and reads no iCloud folder", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const icloud = join(f.root, "icloud-later");
  const dir = await cloneOn(t, f, a);
  assert.ok(!a.projects.demo.private && !a.projects.demo.privateFromList && !a.projects.demo.privateHome);
  mkdirSync(join(icloud, "demo"), { recursive: true });
  writeFileSync(join(icloud, "demo", ".atelier-private"), "PROJECT.md\n");
  writeFileSync(join(icloud, "demo", "PROJECT.md"), "my plan\n");
  commitElsewhere(f, "new.txt", "new\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"], { env: { ATELIER_PRIVATE_ROOT: icloud } });
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /[Pp]rivate/);
  assert.ok(!existsSync(join(dir, "PROJECT.md")));
  assert.ok(!a.projects.demo.privateFromList && !a.projects.demo.privateHome);
});


// t731 (astra, round 2): the commands' own lookup of the project's commit
// identity and its hand-off to fast land, run through the real CLI. Finding
// they would have caught: dropping `identity` from the command's fastLand
// call switched the author check off with every fastLand test still passing.
const personal = (f, dir) => {
  f.git(dir, "checkout", "-q", "-b", "task", "main");
  writeFileSync(join(dir, "task.txt"), "task\n");
  f.git(dir, "add", ".");
  execFileSync("git", ["commit", "-q", "-m", "task\n\nAgent: codex/test"], { cwd: dir, env: { ...f.env, GIT_AUTHOR_NAME: "Personal", GIT_AUTHOR_EMAIL: "personal@me.test", GIT_COMMITTER_NAME: "Personal", GIT_COMMITTER_EMAIL: "personal@me.test" } });
  const sha = f.git(dir, "rev-parse", "HEAD");
  f.git(dir, "checkout", "-q", "main");
  return sha;
};

const land = (t, f, a, dir, sha) => run(t, f, a, ["fast", "land", `t5=${sha}`, "--typecheck", "true", "--test", "true", "--project", "demo"], { cwd: dir });


test("atelier fast land hands the project's commit identity to the landing: a task commit from outside it is refused, main untouched (t731)", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const sha = personal(f, dir);
  const before = f.git(dir, "rev-parse", "HEAD");
  const r = await land(t, f, a, dir, sha);
  assert.notEqual(r.code, 0);
  assert.ok(r.output.includes(`commit ${sha.slice(0, 12)}`) && r.output.includes("personal@me.test"), r.output);
  assert.match(r.output, /Nothing of t5 was merged/);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), before);
});


test("atelier fast land refuses a project with no commit identity before it reads a task or merges (t731)", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const sha = personal(f, dir);
  f.noIdentity = true;
  const before = f.git(dir, "rev-parse", "HEAD");
  const r = await land(t, f, a, dir, sha);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /demo has no commit identity in its policy.*Nothing was merged\./);
  assert.ok(!r.seen.some((s) => s.route.includes("/items/")), "no task is read");
  assert.equal(f.git(dir, "rev-parse", "HEAD"), before);
});


test("the real atelier identity prints the project's identity as JSON, and fails clearly when it has none (t731)", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  await cloneOn(t, f, a);
  const ok = await run(t, f, a, ["identity", "--json", "--project", "demo"]);
  assert.equal(ok.code, 0, ok.output);
  assert.deepEqual(JSON.parse(ok.output), IDENTITY);
  f.noIdentity = true;
  const none = await run(t, f, a, ["identity", "--json", "--project", "demo"]);
  assert.notEqual(none.code, 0);
  assert.match(none.output, /demo has no commit identity in its policy/);
});


// t600 (astra, round 1): fast land's report of the post-merge review, run
// through the real CLI against a stand-in server. Finding they would have
// caught: removing printLanded's stderr OWED warning, or reading a missing
// `owed` as settled, left every test passing.
const inIdentity = (f, dir) => {
  f.git(dir, "checkout", "-q", "-b", "task", "main");
  writeFileSync(join(dir, "task.txt"), "task\n");
  f.git(dir, "add", ".");
  execFileSync("git", ["commit", "-q", "-m", "task\n\nAgent: codex/test"], { cwd: dir, env: { ...f.env, GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email } });
  const sha = f.git(dir, "rev-parse", "HEAD");
  f.git(dir, "checkout", "-q", "main");
  return sha;
};

async function landAnswering(t, answer) {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const sha = inIdentity(f, dir);
  f.landedFast = (receipt) => ({ item: { id: "t5" }, receipt, ...answer });
  const r = await run(t, f, a, ["fast", "land", `t5=${sha}`, "--typecheck", "true", "--test", "true", "--project", "demo"], { cwd: dir });
  return { r, f };
}

const OWED_LINE = /OWED: the post-merge review of t5 is not asked\. Ask one now: atelier review-request t5 --reviewer H\/M --project demo/;


test("fast land with no review asked says OWED and the command to ask one, and still succeeds (t600)", async (t) => {
  const { r } = await landAnswering(t, { review: null, owed: true });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /t5 landed in fast mode: .*no post-merge review asked/);
  assert.match(r.output, OWED_LINE);
});


test("fast land whose review ask failed names the failure and says OWED, exit 0 (t600)", async (t) => {
  const { r } = await landAnswering(t, { review: { error: "self_review", detail: "x contributed to t5" }, owed: true });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /post-merge review NOT asked \(self_review\): x contributed to t5/);
  assert.match(r.output, OWED_LINE);
});


test("fast land against an older server whose answer has no owed treats the review as owed (t600)", async (t) => {
  const { r } = await landAnswering(t, { review: null });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, OWED_LINE);
});


test("fast land with the review asked and owed false prints no warning (t600)", async (t) => {
  const { r } = await landAnswering(t, { review: { requested: true, request: 7, reviewer: "claude-code/sonnet-5" }, owed: false });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /post-merge review request 7 asked of claude-code\/sonnet-5/);
  assert.doesNotMatch(r.output, /OWED/);
});
