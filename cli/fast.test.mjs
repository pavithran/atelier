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
import { fastLand, parsePairs } from "./fast.mjs";
import { MANIFEST_PATH } from "./merge-pipeline.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fast-land-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "start");
  const branch = (name, file, agent) => {
    git(dir, "checkout", "-q", "-b", name, "main");
    writeFileSync(join(dir, file), `${name}\n`);
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", `${name}\n\nAgent: ${agent}`);
    const sha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    return sha;
  };
  return { dir, one: branch("one", "one.txt", "claude-code/opus-5.5"), two: branch("two", "two.txt", "codex/gpt-6") };
}

const base = { titles: { t1: "One", t2: "Two" }, reason: "forks fail", typecheck: "true", regen: null };

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

// t587: a project whose command entries live one per file under cmds/ and
// whose declared generator writes out/index.txt from them, as
// test/fixtures/cli/{usage.json,help.txt} are written from cli/ and src/.
const GENERATOR = `import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const names = readdirSync("cmds").sort().map((f) => /^name: (\\S+)/m.exec(readFileSync("cmds/" + f, "utf8"))[1]);
mkdirSync("out", { recursive: true });
writeFileSync("out/index.txt", names.map((n) => n + "\\n").join(""));
`;
const MANIFEST = { version: 1, generators: [{ name: "index", command: [process.execPath, "gen.mjs"], inputs: ["cmds/**", "gen.mjs"], outputs: ["out/index.txt"] }], records: [], registries: [] };

function generatedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "fast-land-gen-"));
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
    execFileSync(process.execPath, ["gen.mjs"], { cwd: dir });
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  git(dir, "init", "-q", "-b", "main");
  commit({ "gen.mjs": GENERATOR, [MANIFEST_PATH]: JSON.stringify(MANIFEST, null, 2), ".gitattributes": "out/index.txt merge=atelier-generated\n", "cmds/help.txt": "name: help\n" }, "start");
  const branch = (name, agent) => {
    git(dir, "checkout", "-q", "-b", name, "main");
    const sha = commit({ [`cmds/${name}.txt`]: `name: ${name}\n` }, `Add the ${name} command\n\nAgent: ${agent}`);
    git(dir, "checkout", "-q", "main");
    return sha;
  };
  return { dir, push: branch("push", "claude-code/opus-5.5"), land: branch("land", "codex/gpt-6") };
}

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
function leakBranch(dir, commits) {
  git(dir, "checkout", "-q", "-b", "leak", "main");
  for (const files of commits) {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) rmSync(join(dir, path));
      else writeFileSync(join(dir, path), content);
    }
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "leak\n\nAgent: codex/gpt-6");
  }
  const sha = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  return sha;
}
const KEY = `AWS_KEY=AKIA${"Q".repeat(16)}\n`;

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

test("a credential one batch commit adds and a later one removes is still found in history (finding 4)", async () => {
  const r = await landLeak([{ "k.txt": KEY }, { "k.txt": null }]);
  assert.equal(r.failure?.step, "secret scan");
  assert.match(r.failure.detail, /k\.txt:1/);
});
