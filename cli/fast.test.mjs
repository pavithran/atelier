// Part 1 of 2 of the tests that were in fast.test.mjs, split so no file runs for more than about a minute (t771).
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
import { fastLand, parsePairs, scanBatch } from "./fast.mjs";
import { FAST_CONTRIBUTORS_MAX } from "../src/rules.ts";
import { privateConfig } from "../test/fixtures/private-config.mjs";
import { git, repo, base, GENERATOR, generatedRepo, KEY, inCheckout, MANIFEST, leakBranch } from "./fast-shared.mjs";

// No test reads this Mac's own iCloud folder (t645).
process.env.ATELIER_PRIVATE_ROOT ||= `${process.env.TMPDIR || "/tmp"}/atelier-tests-no-icloud-${process.pid}`;


test("pairs are tN=SHA, each task once", () => {
  assert.deepEqual(parsePairs(["t1=abcdef1"]), [{ id: "t1", sha: "abcdef1" }]);
  assert.throws(() => parsePairs([]), /at least one/);
  assert.throws(() => parsePairs(["t1"]), /not tN=SHA/);
  assert.throws(() => parsePairs(["t1=abcdef1", "t1=abcdef2"]), /twice/);
});


test("a batch whose tests fail leaves main where it started and records nothing", async () => {
  const { dir, one, two } = repo();
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const recorded = [];
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }, { id: "t2", sha: two }], test: "echo failing; exit 3", record: (id) => recorded.push(id) });
    assert.equal(r.ok, false);
    assert.equal(r.failure.step, "tests");
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
    assert.equal(git(dir, "status", "--porcelain"), "");
    assert.deepEqual(recorded, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a batch with a credential in its added lines stops at the secret scan, main untouched", async () => {
  const { dir } = repo();
  try {
    git(dir, "checkout", "-q", "-b", "leak", "main");
    writeFileSync(join(dir, "k.txt"), `AWS_KEY=AKIA${"Q".repeat(16)}\n`);
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "leak\n\nAgent: codex/gpt-6");
    const sha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: { t3: "Leak" }, cwd: dir, pairs: [{ id: "t3", sha }], test: "true", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "secret scan");
    assert.match(r.failure.detail, /k\.txt:1/);
    assert.doesNotMatch(r.failure.detail, /AKIA/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// t645: what fast land lands, the next publish pushes, so a batch that adds
// a private file of the project stops before anything is recorded.
test("a batch whose commits add a private file of the project stops, main untouched", async (t) => {
  const { dir, one } = repo();
  privateConfig(t, { demo: { private: ["ONE.TXT"] } });
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: "true", project: "demo", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "private files");
    assert.match(r.failure.detail, /The batch would carry private files: one\.txt in [0-9a-f]{12}/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a passing batch merges in order with --no-ff and records each receipt with its builder and the tests' sha256", async () => {
  const { dir, one, two } = repo();
  try {
    const recorded = [];
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }, { id: "t2", sha: two }], test: "echo ok", record: (id, receipt) => { recorded.push([id, receipt]); return { ok: true }; } });
    assert.equal(r.ok, true);
    assert.deepEqual(recorded.map(([id, x]) => [id, x.commit, x.builder]), [["t1", one, "claude-code/opus-5.5"], ["t2", two, "codex/gpt-6"]]);
    assert.equal(recorded[0][1].tests.command, "echo ok");
    assert.match(recorded[0][1].tests.sha256, /^[0-9a-f]{64}$/);
    const subjects = git(dir, "log", "--first-parent", "--format=%s", "-2").split("\n");
    assert.deepEqual(subjects, ["Merge t2: Two", "Merge t1: One"]);
    assert.match(git(dir, "log", "-1", "--format=%B"), /Landed fast: forks fail/);
    assert.equal(git(dir, "rev-parse", "HEAD^2"), two);
    assert.equal(recorded[1][1].mergeCommit, r.head);
    // The receipt names the head the tests ran at and its batch (t601).
    for (const [, x] of recorded) assert.deepEqual([x.testedHead, x.batch], [r.head, `${r.start}..${r.head}`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Finding it would have caught (Astra finding 10, 2026-10-16): the receipt
// named only the tip commit's agent, so an earlier commit's model could review.
test("the receipt names every agent of the commits the merge brings, not the tip's alone (t603)", async () => {
  const { dir, one } = repo();
  try {
    git(dir, "checkout", "-q", "-b", "two-agents", "main");
    writeFileSync(join(dir, "x.txt"), "x\n"); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "first\n\nAgent: codex/gpt-6");
    writeFileSync(join(dir, "y.txt"), "y\n"); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "second\n\nAgent: claude-code/opus-5.5");
    const sha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    const recorded = [];
    const r = await fastLand({ ...base, titles: { t5: "Five", t1: "One" }, cwd: dir, pairs: [{ id: "t5", sha }, { id: "t1", sha: one }], test: "echo ok", record: (id, receipt) => { recorded.push([id, receipt]); return { ok: true }; } });
    assert.equal(r.ok, true);
    assert.equal(recorded[0][1].builder, "claude-code/opus-5.5");
    assert.deepEqual([...recorded[0][1].contributors].sort(), ["claude-code/opus-5.5", "codex/gpt-6"]);
    // Only the commits this merge brings: the second task's range is its own.
    assert.deepEqual(recorded[1][1].contributors, ["claude-code/opus-5.5"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a range with more distinct agents than a receipt can carry is refused before the merge (t603)", async () => {
  const { dir } = repo();
  try {
    git(dir, "checkout", "-q", "-b", "crowd", "main");
    for (let i = 0; i <= FAST_CONTRIBUTORS_MAX; i++) {
      writeFileSync(join(dir, `c${i}.txt`), `${i}\n`); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", `c${i}\n\nAgent: codex/model-${i}`);
    }
    const sha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: {}, cwd: dir, pairs: [{ id: "t6", sha }], test: "true", record: () => assert.fail("recorded") });
    assert.equal(r.ok, false);
    assert.match(r.failure.detail, new RegExp(`${FAST_CONTRIBUTORS_MAX + 1} distinct agents, more than the ${FAST_CONTRIBUTORS_MAX}`));
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
    assert.equal(git(dir, "status", "--porcelain"), "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a commit without an Agent line is refused before anything lands", async () => {
  const { dir } = repo();
  try {
    git(dir, "checkout", "-q", "-b", "anon", "main");
    writeFileSync(join(dir, "z.txt"), "z\n");
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "anon");
    const sha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: {}, cwd: dir, pairs: [{ id: "t4", sha }], test: "true", record: () => assert.fail("recorded") });
    assert.match(r.failure.detail, /no Agent: line/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Finding it would have caught (t731, 2026-10-16): 61 builder commits carried
// a private checkout address and the push refused them at the very end.
const POLICY = { name: "Project Owner", email: "owner@users.noreply.github.com", agentEmails: [] };


test("a task whose commits are by an author outside the project's identity is refused before it merges (t731)", async () => {
  const { dir, one, two } = repo();
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }, { id: "t2", sha: two }], test: "true", identity: POLICY, record: () => assert.fail("recorded") });
    assert.equal(r.ok, false);
    assert.equal(r.failure.step, "merge t1");
    assert.ok(r.failure.detail.includes(`commit ${one.slice(0, 12)}`), r.failure.detail);
    assert.match(r.failure.detail, /t@example\.com/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("with the builders' address allowed, the merge commits are by the project whatever the checkout's config says (t731)", async () => {
  const { dir, one, two } = repo();
  try {
    git(dir, "config", "user.name", "Checkout Dev"); git(dir, "config", "user.email", "dev@atelier.zone");
    const identity = { ...POLICY, agentEmails: ["t@example.com"] };
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }, { id: "t2", sha: two }], test: "true", identity, record: () => ({ ok: true }) });
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    for (const c of ["HEAD", "HEAD~1"]) assert.equal(git(dir, "log", "-1", "--format=%an <%ae> %cn <%ce>", c), "Project Owner <owner@users.noreply.github.com> Project Owner <owner@users.noreply.github.com>");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// t587: a project whose command entries live one per file under cmds/ and
// whose declared generator writes out/index.txt from them, as
// test/fixtures/cli/{usage.json,help.txt} are written from cli/ and src/.
test("two commands added on two branches land in one batch: the generated index is regenerated, not merged as text", async () => {
  const { dir, push, land } = generatedRepo();
  try {
    // As plain git merge saw it (t433): each side added a line at one place
    // in the generated index, a text conflict.
    const plain = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", push, land], { cwd: dir, encoding: "utf8" });
    assert.equal(plain.status, 1, "a text merge of the two branches conflicts");
    assert.match(plain.stdout, /out\/index\.txt/);
    const lines = [], recorded = [];
    const r = await fastLand({ ...base, titles: { t1: "Push", t2: "Land" }, cwd: dir, pairs: [{ id: "t1", sha: push }, { id: "t2", sha: land }], test: "echo ok", log: (l) => lines.push(l), record: (id, receipt) => { recorded.push([id, receipt]); return { ok: true }; } });
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.equal(readFileSync(join(dir, "out/index.txt"), "utf8"), "help\nland\npush\n");
    assert.equal(git(dir, "status", "--porcelain"), "");
    assert.deepEqual(git(dir, "log", "--first-parent", "--format=%s", "-2").split("\n"), ["Merge t2: Land", "Merge t1: Push"]);
    assert.equal(git(dir, "rev-parse", "HEAD^2"), land);
    const message = git(dir, "log", "-1", "--format=%B");
    assert.match(message, /Landed fast: forks fail/);
    assert.match(message, /Atelier-Regenerated: index \(.+ gen\.mjs\): out\/index\.txt matches neither side/);
    assert.deepEqual(recorded.map(([id, x]) => [id, x.commit, x.builder]), [["t1", push, "claude-code/opus-5.5"], ["t2", land, "codex/gpt-6"]]);
    assert.equal(recorded[1][1].mergeCommit, r.head);
    assert.ok(lines.some((l) => /^merged t1 \(/.test(l)) && lines.some((l) => /^merged t2 \(/.test(l)));
    assert.ok(lines.some((l) => /^regenerated out\/index\.txt \(matches neither side\)/.test(l)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a source conflict between two SHAs stops the batch and resets main to where it started", async () => {
  const { dir } = repo();
  try {
    const side = (name) => {
      git(dir, "checkout", "-q", "-b", name, "main");
      writeFileSync(join(dir, "a.txt"), `${name}\n`);
      git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", `${name}\n\nAgent: codex/gpt-6`);
      const sha = git(dir, "rev-parse", "HEAD");
      git(dir, "checkout", "-q", "main");
      return sha;
    };
    const x = side("x"), y = side("y");
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: {}, cwd: dir, pairs: [{ id: "t5", sha: x }, { id: "t6", sha: y }], test: "true", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "merge t6");
    assert.match(r.failure.detail, /Source conflicts to resolve:\n {2}a\.txt/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
    assert.equal(git(dir, "status", "--porcelain"), "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a SHA main already holds is refused, not recorded against an unrelated commit", async () => {
  const { dir } = repo();
  try {
    git(dir, "commit", "-q", "--allow-empty", "-m", "held\n\nAgent: codex/gpt-6");
    const held = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: {}, cwd: dir, pairs: [{ id: "t7", sha: held }], test: "true", record: () => assert.fail("recorded") });
    assert.equal(r.ok, false);
    assert.equal(r.failure.step, "merge t7");
    assert.match(r.failure.detail, /main already holds/);
    assert.equal(git(dir, "rev-parse", "HEAD"), held);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// t588: on 2026-10-13 fast land's npm test failed in the owner's checkout
// while the same merged tree passed in a clean clone. The default test run
// is in a temporary clean clone of the batch's head, so a stray untracked
// file in the checkout (here one the test trips over) changes nothing; the
// same command given as --test runs in the checkout and does see it.
test("a stray untracked file in the checkout does not change the result: the default test runs in a clean clone of the batch's head", async () => {
  const { dir, one, two } = repo();
  const where = join(mkdtempSync(join(tmpdir(), "fast-land-where-")), "pwd");
  try {
    writeFileSync(join(dir, "stray.txt"), "left behind\n");
    const pairs = [{ id: "t1", sha: one }, { id: "t2", sha: two }];
    const command = `pwd -P > ${JSON.stringify(where)}; test ! -e stray.txt && test -e one.txt && test -e two.txt && test -e gen.txt && test -e setup.done && echo ok`;
    const opts = { ...base, cwd: dir, pairs, regen: "echo generated > gen.txt", test: command };

    const recorded = [];
    const r = await fastLand({ ...opts, cleanClone: { setup: "touch setup.done" }, record: (id, receipt) => { recorded.push([id, receipt]); return { ok: true }; } });
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.deepEqual(recorded.map(([id, x]) => [id, x.tests.where, x.tests.command]), [["t1", "clean clone", command], ["t2", "clean clone", command]]);
    const ran = readFileSync(where, "utf8").trim();
    assert.notEqual(ran, realpathSync(dir), "the tests ran outside the checkout");
    assert.equal(existsSync(ran), false, "the clone is removed afterwards");
    // The stray file stayed the owner's: untracked, and not in the regeneration's commit.
    assert.equal(git(dir, "status", "--porcelain"), "?? stray.txt");
    assert.equal(git(dir, "log", "-1", "--format=%s"), "Regenerate after fast landing of t1, t2");
    assert.doesNotMatch(git(dir, "ls-tree", "-r", "--name-only", "HEAD"), /stray\.txt|setup\.done/);

    // The same command given as --test runs in the checkout, where the stray file is.
    git(dir, "reset", "-q", "--hard", r.start);
    const inCheckout = await fastLand({ ...opts, record: () => assert.fail("recorded") });
    assert.equal(inCheckout.ok, false);
    assert.equal(inCheckout.failure.step, "tests");
    assert.match(inCheckout.failure.detail, /^in the checkout:/);
    assert.equal(readFileSync(where, "utf8").trim(), realpathSync(dir));
    assert.equal(git(dir, "rev-parse", "HEAD"), r.start);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(dirname(where), { recursive: true, force: true }); }
});


test("a clean clone whose setup fails stops at the test setup, main untouched", async () => {
  const { dir, one } = repo();
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: "true", cleanClone: { setup: "echo no lockfile; exit 1" }, record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "test setup");
    assert.match(r.failure.detail, /in the clean clone:\nno lockfile/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// Astra's audit of 2026-10-13, finding 4: the secret scan read the displayed
// diff of the batch, so a binary blob, a file .gitattributes marks -diff, or
// a credential one commit added and a later one removed showed no added line
// and passed. Fast land now reads every blob each new commit adds or changes
// with the server's scanner (scanTrees in src/secret-scan.ts), and a change it
// cannot read as text stops the batch, as the server's push scan does. A clean
// batch still passes (the passing batch tests above).
async function landLeak(commits) {
  const { dir } = repo();
  try {
    const sha = leakBranch(dir, commits);
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: { t3: "Leak" }, cwd: dir, pairs: [{ id: "t3", sha }], test: "true", record: () => assert.fail("recorded") });
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
    return r;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}


test("a binary file holding a credential stops the batch, naming the path (finding 4)", async () => {
  const r = await landLeak([{ "k.bin": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(KEY)]) }]);
  assert.equal(r.failure?.step, "secret scan");
  assert.match(r.failure.detail, /k\.bin \(binary content\)/);
  assert.doesNotMatch(r.failure.detail, /AKIA/);
});


test("a text file .gitattributes marks -diff still has its credential found (finding 4)", async () => {
  const r = await landLeak([{ ".gitattributes": "k.txt -diff\n", "k.txt": KEY }]);
  assert.equal(r.failure?.step, "secret scan");
  assert.match(r.failure.detail, /k\.txt:1/);
});


// Astra's audit of 2026-10-13, finding 5: regeneration, the typecheck and a
// --test run in the checkout ran with the developer's whole environment
// after agent changes were merged, so a changed project script could read
// their tokens, provider keys and SSH_AUTH_SOCK. Each now gets checkEnv's
// variables, as the clean-clone test run already did.
test("the project commands fast land runs cannot read the developer's secret variables (finding 5)", async () => {
  const { dir, one } = repo();
  const saved = { FAST_LAND_PROBE_TOKEN: process.env.FAST_LAND_PROBE_TOKEN, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
  process.env.FAST_LAND_PROBE_TOKEN = "developer-secret";
  process.env.SSH_AUTH_SOCK = "/tmp/developer-agent.sock";
  const blind = (step) => `if [ -n "$FAST_LAND_PROBE_TOKEN$SSH_AUTH_SOCK" ]; then echo "${step} read the developer's variables"; exit 1; fi; test -n "$PATH"`;
  try {
    // Each command alone, so a pass of one is not hidden behind another's failure.
    for (const step of ["regen", "typecheck", "test"]) {
      const commands = { regen: null, typecheck: "true", test: "true", [step]: blind(step) };
      const r = await fastLand({ ...base, ...commands, cwd: dir, pairs: [{ id: "t1", sha: one }], record: () => ({ ok: true }) });
      assert.equal(r.ok, true, `${step}: ${JSON.stringify(r.failure)}`);
      git(dir, "reset", "-q", "--hard", r.start);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  }
});


test("a credential one batch commit adds and a later one removes is still found in history (finding 4)", async () => {
  const r = await landLeak([{ "k.txt": KEY }, { "k.txt": null }]);
  assert.equal(r.failure?.step, "secret scan");
  assert.match(r.failure.detail, /k\.txt:1/);
});


// Review of t592 (codex/gpt-6-astra): the scan ran before the checkout test,
// and fast land then took whatever HEAD was, so an agent-changed test script
// could commit a binary credential after the scan and exit 0.
test("a commit made after the secret scan, by the test command, stops the batch (finding 4)", async () => {
  const { dir, one } = repo();
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const sneak = `printf 'k\\0AKIA' > late.bin && git -c user.name=t -c user.email=t@example.com add late.bin && git -c user.name=t -c user.email=t@example.com commit -q -m late`;
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], test: sneak, record: () => assert.fail("recorded") });
    assert.equal(r.ok, false);
    assert.equal(r.failure.step, "checkout changed");
    assert.match(r.failure.detail, /after the secret scan/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Review of t592: a blob the scan could not read stopped the batch with only
// the object's hash, not the path the criterion asks it to name. The blob
// here is one a batch commit added and a later one replaced, so the merge
// never needs it and only the scan reads it.
// Second review of t592 (codex/gpt-6-astra): a replacement ref made the scan
// read a harmless blob in place of the credential the history holds. A
// typecheck the batch changed can make one with `git replace`.
function replacedLeak() {
  const { dir } = repo();
  const sha = leakBranch(dir, [{ "k.txt": KEY }, { "k.txt": null }]);
  const leak = git(dir, "rev-parse", `${sha}^:k.txt`);
  writeFileSync(join(dir, "..safe"), "harmless\n");
  const safe = git(dir, "hash-object", "-w", join(dir, "..safe"));
  rmSync(join(dir, "..safe"));
  return { dir, sha, replace: `git replace ${leak} ${safe}` };
}


test("the scan reads the history's own objects, not replacements (finding 4)", async () => {
  const { dir, sha, replace } = replacedLeak();
  try {
    const start = git(dir, "rev-parse", "HEAD");
    git(dir, "merge", "-q", "--no-ff", "-m", "m", sha);
    execFileSync("sh", ["-c", replace], { cwd: dir });
    const { hits } = await scanBatch(dir, start);
    assert.deepEqual(hits, ["k.txt:1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a replacement ref a project command makes stops the batch, main untouched (finding 4)", async () => {
  const { dir, sha, replace } = replacedLeak();
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, titles: { t3: "Replace" }, cwd: dir, pairs: [{ id: "t3", sha }], typecheck: replace, test: "true", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "secret scan", JSON.stringify(r.failure));
    assert.match(r.failure.detail, /replacement refs/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a grafts file a project command writes stops the batch (finding 4)", async () => {
  const { dir, one } = repo();
  try {
    const start = git(dir, "rev-parse", "HEAD");
    const r = await fastLand({ ...base, cwd: dir, pairs: [{ id: "t1", sha: one }], typecheck: `mkdir -p .git/info && git rev-parse HEAD > .git/info/grafts`, test: "true", record: () => assert.fail("recorded") });
    assert.equal(r.failure?.step, "secret scan", JSON.stringify(r.failure));
    assert.match(r.failure.detail, /grafts/);
    assert.equal(git(dir, "rev-parse", "HEAD"), start);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// Finding it would have caught (astra, second review of t603): contributors
// were taken before the merge, so a graft an earlier merge's generator wrote
// (hiding a task's first commit) and a typecheck removed before the history
// checks left a receipt without the hidden commit's agent.
test("a graft written during an earlier merge and removed before validation does not shrink a receipt's contributors (t603)", async () => {
  const gen = GENERATOR + `import { existsSync, appendFileSync } from "node:fs";
if (existsSync("graft.txt")) { mkdirSync([".git", "info"].join("/"), { recursive: true }); appendFileSync([".git", "info", "grafts"].join("/"), readFileSync("graft.txt", "utf8")); }
`;
  const { dir } = generatedRepo(gen);
  try {
    const startSha = git(dir, "rev-parse", "HEAD");
    // t2: two commits by two agents, off the start.
    git(dir, "checkout", "-q", "-b", "x", "main");
    writeFileSync(join(dir, "x1.txt"), "1\n"); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "x1\n\nAgent: codex/gpt-6");
    writeFileSync(join(dir, "x2.txt"), "2\n"); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "x2\n\nAgent: claude-code/opus-5.5");
    const tip = git(dir, "rev-parse", "HEAD");
    // t1 conflicts with main on the generated index, so its merge runs the generator, which writes the graft.
    git(dir, "checkout", "-q", "-b", "p", "main");
    mkdirSync(join(dir, "cmds"), { recursive: true });
    writeFileSync(join(dir, "cmds/p.txt"), "name: p\n"); writeFileSync(join(dir, "graft.txt"), `${tip} ${startSha}\n`);
    execFileSync(process.execPath, ["gen.mjs"], { cwd: dir });
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "p\n\nAgent: gemini/pro-3");
    const p = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "cmds/m.txt"), "name: m\n");
    execFileSync(process.execPath, ["gen.mjs"], { cwd: dir });
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "m");
    const recorded = [];
    const r = await fastLand({ ...base, titles: { t1: "P", t2: "X" }, cwd: dir, pairs: [{ id: "t1", sha: p }, { id: "t2", sha: tip }], typecheck: "rm -f .git/info/grafts", test: "true", record: (id, receipt) => { recorded.push([id, receipt]); return { ok: true }; } });
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.deepEqual([...recorded[1][1].contributors].sort(), ["claude-code/opus-5.5", "codex/gpt-6"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
