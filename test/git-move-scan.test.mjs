// Move scans run against local Git repositories without a listening server.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const root = mkdtempSync(join(tmpdir(), "atelier-move-scan-"));
after(() => rmSync(root, { recursive: true, force: true }));
const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tipOf = (dir, ref) => { try { return git(dir, "rev-parse", "--verify", "--quiet", ref); } catch { return null; } };

test("one refusal records every key-shaped line across batches and one clearance lets the move through", async (t) => {
  const { mirrorBranch } = await import("../src/git/move.mjs");
  const { Namespace } = await import("../src/runtime/namespace.mjs");
  const { Ledger } = await import("../src/ledger.ts");
  const source = join(root, "all-hits.git"), into = join(root, "all-hits-into.git");
  for (const dir of [source, into]) git(root, "init", "-q", "--bare", "-b", "main", dir);
  let input = "";
  const expected = [];
  for (let i = 1; i <= 805; i++) {
    let files = "";
    if ([2, 402, 802].includes(i)) {
      const file = `keys-${i}.env`;
      const lines = Array.from({ length: 25 }, (_, n) => `TOKEN_${n}=${["sk", "proj", "TESTONLY", `${i}_${n}_`, "f".repeat(28)].join("-")}`);
      const content = `${lines.join("\n")}\n`;
      files = `M 100644 inline ${file}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
      expected.push(...lines.map((_, n) => [file, n + 1]));
    } else if ([3, 403, 803].includes(i)) files = `D keys-${i - 1}.env\n`;
    input += `commit refs/heads/main\ncommitter Test <t@example.test> ${1700000000 + i} +0000\ndata 1\nx\n${files}\n`;
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: source, env: gitEnv, input });
  const ns = new Namespace({ dir: join(root, "all-hits-ledger"), Class: Ledger, env: {} });
  t.after(() => ns.close());
  const ledger = ns.get(ns.idFromName("project:all-hits"));
  const scan = { root: join(root, "all-hits-scans"), policy: { clearances: [], private: [] } };
  const result = await mirrorBranch({ dir: into, branch: "main", remote: source, scan });
  assert.equal(result.error, "scan_refused", JSON.stringify(result));
  assert.match(result.detail, /the secret scan found 75 key-shaped lines in total\./);
  assert.deepEqual(result.hits.map((h) => [h.file, h.line]), expected);
  assert.equal(tipOf(into, "refs/heads/main"), null);
  await ledger.hostMoveRefused("owner", source, result.remoteHead, result.hits);
  const events = (await ledger.dumpRows("events")).rows.map((r) => ({ kind: r[4], data: JSON.parse(r[5]) }));
  const refusal = events.find((e) => e.kind === "project.host_move_refused");
  assert.deepEqual(refusal.data.flags.map((h) => [h.file, h.line]), expected);
  assert.ok(refusal.data.flags.every((h) => /^[0-9a-f]{40}$/.test(h.commit)));
  assert.doesNotMatch(JSON.stringify(events), /sk-proj-TESTONLY/);
  assert.deepEqual(await ledger.clearHostMove("owner", "synthetic test keys", { quote: "clear the test keys", acting: "codex/gpt-6-astra" }), { cleared: expected.length });
  scan.policy.clearances = (await ledger.hostMoveScan()).clearances;
  const moved = await mirrorBranch({ dir: into, branch: "main", remote: source, scan });
  assert.equal(moved.moved, "created", JSON.stringify(moved));
  assert.equal(tipOf(into, "refs/heads/main"), tipOf(source, "refs/heads/main"));
});

for (const skewed of [false, true]) test(`move scans ${skewed ? "a timestamp-skewed root" : "multiple roots"} without an empty parent`, async () => {
  const { mirrorBranch } = await import("../src/git/move.mjs");
  const source = join(root, `roots-${skewed}.git`), into = join(root, `roots-into-${skewed}.git`);
  for (const dir of [source, into]) git(root, "init", "-q", "--bare", "-b", "main", dir);
  const input = `commit refs/heads/main\nmark :1\ncommitter Test <t@example.test> 1700000300 +0000\ndata 1\na\n\ncommit refs/heads/side\nmark :2\ncommitter Test <t@example.test> 1700000100 +0000\ndata 1\nb\n${skewed ? "from :1\n" : ""}\ncommit refs/heads/main\nmark :3\ncommitter Test <t@example.test> 1700000200 +0000\ndata 1\nc\nmerge :2\n\n`;
  execFileSync("git", ["fast-import", "--quiet"], { cwd: source, env: gitEnv, input });
  const result = await mirrorBranch({ dir: into, branch: "main", remote: source, scan: { root: join(root, "root-scans"), policy: { clearances: [], private: [] } } });
  assert.equal(result.moved, "created", JSON.stringify(result));
  assert.equal(tipOf(into, "refs/heads/main"), tipOf(source, "refs/heads/main"));
});

test("a private path removed in an earlier batch still refuses move-host", async () => {
  const { mirrorBranch } = await import("../src/git/move.mjs");
  const source = join(root, "private-batches.git"), into = join(root, "private-into.git");
  for (const dir of [source, into]) git(root, "init", "-q", "--bare", "-b", "main", dir);
  let input = "";
  for (let i = 1; i <= 405; i++) input += `commit refs/heads/main\ncommitter Test <t@example.test> ${1700000000 + i} +0000\ndata 1\nx\n${i === 2 ? "M 100644 inline private.txt\ndata 6\nlocal\n\n" : i === 3 ? "D private.txt\n" : ""}\n`;
  execFileSync("git", ["fast-import", "--quiet"], { cwd: source, env: gitEnv, input });
  const result = await mirrorBranch({ dir: into, branch: "main", remote: source, scan: { root: join(root, "private-scans"), policy: { clearances: [], private: ["private.txt"] } } });
  assert.equal(result.error, "scan_refused", JSON.stringify(result));
  assert.match(result.detail, /private files:.*private.txt/);
  assert.equal(tipOf(into, "refs/heads/main"), null);
});

for (const state of ["refused", "refused-later", "ahead", "diverged", "created"]) test(`unscanned notes ${state} appear only when moved`, async () => {
  const { mirrorBranch } = await import("../src/git/move.mjs");
  const source = join(root, `notes-${state}`), into = join(root, `notes-into-${state}.git`);
  git(root, "init", "-q", "-b", "main", source);
  git(source, "commit", "-q", "--allow-empty", "-m", "main");
  git(root, "init", "-q", "--bare", "-b", "main", into);
  git(source, "checkout", "-q", "--orphan", "notes-source");
  writeFileSync(join(source, "unread.bin"), Buffer.from([0, 1, 2]));
  if (state === "refused") writeFileSync(join(source, "key.env"), `OPENAI_API_KEY=${["sk", "proj", "TESTONLY", "f".repeat(28)].join("-")}\n`);
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "notes");
  git(source, "update-ref", "refs/notes/atelier", "HEAD");
  if (state === "refused-later") {
    let input = "";
    const secret = `OPENAI_API_KEY=${["sk", "proj", "TESTONLY", "f".repeat(28)].join("-")}\n`;
    for (let i = 1; i <= 400; i++) input += `commit refs/notes/atelier\ncommitter Test <t@example.test> ${1700000000 + i} +0000\ndata 1\nx\n${i === 1 ? `from ${tipOf(source, "refs/notes/atelier")}\n` : ""}${i === 400 ? `M 100644 inline key.env\ndata ${secret.length}\n${secret}\n` : ""}\n`;
    execFileSync("git", ["fast-import", "--quiet"], { cwd: source, env: gitEnv, input });
  }
  if (state === "ahead" || state === "diverged") {
    git(source, "commit", "-q", "--allow-empty", "-m", "local notes");
    if (state === "diverged") {
      git(source, "checkout", "-q", "--orphan", "different");
      git(source, "commit", "-q", "--allow-empty", "-m", "different root");
    }
    git(source, "push", "-q", into, "HEAD:refs/notes/atelier");
  }
  const before = tipOf(into, "refs/notes/atelier");
  const result = await mirrorBranch({ dir: into, branch: "main", remote: source, scan: { root: join(root, "notes-scans"), policy: { clearances: [], private: [] } } });
  assert.equal(result.moved, "created", JSON.stringify(result));
  assert.match(result.notes, state.startsWith("refused") ? /not moved:.*key-shaped/ : new RegExp(`^${state}$`));
  if (state === "created") {
    assert.equal(tipOf(into, "refs/notes/atelier"), tipOf(source, "refs/notes/atelier"));
    assert.deepEqual(result.unscanned.map((u) => u.file), ["unread.bin"]);
  } else {
    assert.equal(tipOf(into, "refs/notes/atelier"), before);
    assert.deepEqual(result.unscanned, []);
  }
});
