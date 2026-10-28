// Atelier 2.0, task 4 (design-branches-2026-10-28.md, section 4.2): the Git
// reader over the server's own bare repositories (src/git/reader.mjs,
// artifacts.mjs) and the LARGE file store (src/runtime/large.mjs). A world of
// commits is built with Git's plumbing in a scratch object store, pushed to
// bare repositories at REPOS/KEY.git, and the reader is checked field by
// field against it; then the modules that read through the Artifacts API
// (diff, preview/merge, browse, import, retention, plans/integrate,
// secret-scan) are driven through the local binding.
import "../src/runtime/loader.mjs";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { LocalArtifacts } from "../src/git/artifacts.mjs";
import { LocalLarge } from "../src/runtime/large.mjs";
import { startServer } from "../src/runtime/server.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratchDir = (what) => { const d = mkdtempSync(join(tmpdir(), `atelier-${what}-`)); dirs.push(d); return d; };

// ── a world of commits ─────────────────────────────────────────────────────

const git = (cwd, args, input, extra = {}) => execFileSync("git", args, { cwd, input, encoding: "utf8", env: { ...process.env, ...extra }, stdio: ["pipe", "pipe", "pipe"] }).trim();

function world() {
  const store = scratchDir("store");
  git(store, ["init", "--bare", "--quiet"]);
  const blob = (bytes) => execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: store, input: bytes, encoding: "utf8" }).trim();
  // files: path -> text, Buffer, or { text, mode } / { gitlink }
  const tree = (files) => {
    const here = [], dirsIn = new Map();
    for (const [path, v] of Object.entries(files)) {
      const slash = path.indexOf("/");
      if (slash >= 0) { const d = path.slice(0, slash); dirsIn.set(d, { ...dirsIn.get(d), [path.slice(slash + 1)]: v }); continue; }
      if (v.gitlink) here.push(`160000 commit ${v.gitlink}\t${path}`);
      else here.push(`${v.mode ?? "100644"} blob ${blob(v.text ?? v)}\t${path}`);
    }
    for (const [d, inner] of dirsIn) here.push(`040000 tree ${tree(inner)}\t${d}`);
    return git(store, ["mktree"], here.join("\n") + "\n");
  };
  let clock = 1_700_000_000;
  const commit = (message, files, parents = [], { at = clock += 100, committedAt = at } = {}) => {
    const args = ["commit-tree", tree(files), ...parents.flatMap((p) => ["-p", p]), "-m", message];
    return git(store, args, undefined, {
      GIT_AUTHOR_NAME: "Ada Author", GIT_AUTHOR_EMAIL: "ada@example.test", GIT_AUTHOR_DATE: `${at} +0000`,
      GIT_COMMITTER_NAME: "Cy Committer", GIT_COMMITTER_EMAIL: "cy@example.test", GIT_COMMITTER_DATE: `${committedAt} +0000`,
    });
  };
  // A bare repository REPOS/KEY.git whose branches are `refs` (name -> commit).
  const repo = (reposDir, key, refs) => {
    mkdirSync(reposDir, { recursive: true });
    const dir = join(reposDir, `${key}.git`);
    git(reposDir, ["init", "--bare", "--quiet", "--initial-branch=main", dir]);
    for (const [name, hash] of Object.entries(refs)) git(store, ["push", "--quiet", dir, `${hash}:refs/heads/${name}`]);
    return dir;
  };
  return { commit, repo };
}

const SECRET = "ghp_" + "x1".repeat(18);
const w = world();
const SUB = "1".repeat(40);
const c1 = w.commit("first", {
  "README.md": "hello\n", "src/a.txt": "one\ntwo\nthree\n", "bin/run.sh": { text: "#!/bin/sh\n", mode: "100755" },
  "logo.bin": Buffer.from([0, 1, 2, 255]), link: { text: "README.md", mode: "120000" }, sub: { gitlink: SUB },
});
const base = { "README.md": "hello\n", "bin/run.sh": { text: "#!/bin/sh\n", mode: "100755" }, "logo.bin": Buffer.from([0, 1, 2, 255]), link: { text: "README.md", mode: "120000" }, sub: { gitlink: SUB } };
const c2 = w.commit("second\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n", { ...base, "src/a.txt": "one\nTWO\nthree\n", "docs/x.md": "x\n" }, [c1], { at: 1_700_000_500, committedAt: 1_700_000_900 });
const { "README.md": _readme, ...noReadme } = base;
const main3 = { ...noReadme, "README.txt": "hello\n", "src/a.txt": "one\nTWO\nthree\n" };
const c3 = w.commit("third", main3, [c2]);
const main4 = { ...main3, "src/a.txt": "one\nTWO\nTHREE\n" };
const c4 = w.commit("fourth", main4, [c3]);
const s1 = w.commit("side", { ...main3, "side.txt": "side\n" }, [c3]);
const c5 = w.commit("Merge side", { ...main4, "side.txt": "side\n" }, [c4, s1]);
const taskFiles = { ...base, "src/a.txt": "ONE\nTWO\nthree\n", "docs/x.md": "x\n", "new.txt": "new\n" };
const t1 = w.commit("task one", taskFiles, [c2]);
const t2 = w.commit("task two", { ...taskFiles, ".env": `GITHUB_TOKEN=${SECRET}\n` }, [t1]);
const u1 = w.commit("task other", { ...base, "src/a.txt": "one\nTWO\nthree\n", "docs/x.md": "x\n", "other.txt": "o\n" }, [c2]);
// The merges of main into an approved head (src/retention.ts).
const n1 = w.commit("Merge main\n\nAgent: atelier/integrator", { ...main4, "src/a.txt": "ONE\nTWO\nTHREE\n", "new.txt": "new\n" }, [t1, c4]);
const n2 = w.commit("Merge main\n\nAgent: atelier/integrator", { ...main4, "other.txt": "o\n" }, [u1, c4]);

const reposDir = join(scratchDir("repos"), "repos");
w.repo(reposDir, "BASE", { main: c5, "t/1": s1 });
w.repo(reposDir, "WORK", { main: t2 });
w.repo(reposDir, "MERGED", { main: n1, other: n2 });
w.repo(reposDir, "Empty", {});
const artifacts = new LocalArtifacts({ reposDir });
after(() => artifacts.close());

const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const rev = (...a) => git(join(reposDir, "BASE.git"), ["rev-list", ...a]).split("\n");
const code = (promise) => promise.then(() => null, (e) => e.code);

// ── the reader ─────────────────────────────────────────────────────────────

test("the reader answers info, commits and logs as Artifacts does", async () => {
  using repo = await artifacts.get("base");
  const info = await repo.info();
  assert.equal(info.name, "base");
  assert.equal(info.defaultBranch, "main");
  assert.equal(info.readOnly, false);

  const head = (await repo.log({ limit: 1 }))[0];
  assert.equal(head.hash, c5);
  assert.equal(head.treeHash, git(join(reposDir, "BASE.git"), ["rev-parse", `${c5}^{tree}`]));
  assert.equal(head.message, "Merge side");
  assert.deepEqual(head.author, { name: "Ada Author", email: "ada@example.test" });
  assert.deepEqual(head.committer, { name: "Cy Committer", email: "cy@example.test" });
  assert.equal(head.authoredAt, head.committedAt);
  assert.equal(typeof head.authoredAt, "number");
  assert.deepEqual(head.parents, [c4, s1], "parents in Git's order");

  const second = await repo.readCommit(c2);
  assert.equal(second.message, "second\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>", "one trailing newline is removed");
  assert.equal(second.authoredAt, 1_700_000_500);
  assert.equal(second.committedAt, 1_700_000_900);
  assert.deepEqual(second.parents, [c1]);
  assert.deepEqual((await repo.readCommit(c1)).parents, []);
  assert.equal(await repo.readCommit("0".repeat(40)), null);
  assert.equal(await code(repo.readCommit("nonsense")), "INVALID_INPUT");
});

test("the log follows the first parent, newest first, by ref, limit and offset", async () => {
  using repo = await artifacts.get("base");
  const hashes = (log) => log.map((c) => c.hash);
  assert.deepEqual(hashes(await repo.log()), [c5, c4, c3, c2, c1], "HEAD is the project branch; the side commit is not listed");
  assert.deepEqual(hashes(await repo.log()), rev("--first-parent", "main"));
  assert.deepEqual(hashes(await repo.log({ ref: "main", limit: 2 })), [c5, c4]);
  assert.deepEqual(hashes(await repo.log({ limit: 2, offset: 2 })), [c3, c2]);
  assert.deepEqual(hashes(await repo.log({ offset: 9 })), []);
  assert.deepEqual(hashes(await repo.log({ ref: "t/1" })), [s1, c3, c2, c1], "a task branch");
  assert.deepEqual(hashes(await repo.log({ ref: c3, limit: 1 })), [c3], "a commit id");
  assert.deepEqual(await repo.log({ ref: "nope" }), []);
  assert.deepEqual(await repo.log({ ref: "--all" }), [], "a ref that looks like an option is no ref");
  assert.deepEqual(await repo.log({ limit: 0 }), []);
});

test("trees list their entries with the mode and the type the mode gives", async () => {
  using repo = await artifacts.get("base");
  const root = await repo.readTree((await repo.readCommit(c1)).treeHash);
  const by = Object.fromEntries(root.map((e) => [e.name, e]));
  assert.deepEqual(root.map((e) => e.name), ["README.md", "bin", "link", "logo.bin", "src", "sub"]);
  assert.deepEqual([by["README.md"].mode, by["README.md"].type], ["100644", "blob"]);
  assert.deepEqual([by.bin.mode, by.bin.type], ["40000", "tree"]);
  assert.deepEqual([by.link.mode, by.link.type], ["120000", "symlink"]);
  assert.deepEqual([by.sub.mode, by.sub.type, by.sub.hash], ["160000", "gitlink", SUB]);
  const bin = await repo.readTree(by.bin.hash);
  assert.deepEqual(bin.map((e) => [e.name, e.mode, e.type]), [["run.sh", "100755", "exec"]]);
  assert.match(by["README.md"].hash, /^[0-9a-f]{40}$/);
  assert.equal(await repo.readTree("0".repeat(40)), null);
  assert.equal(await code(repo.readTree(c1)), "INTERNAL_ERROR", "a commit is no tree");
});

test("blobs and files come back as bytes; a missing or non-blob object is null", async () => {
  using repo = await artifacts.get("base");
  const root = await repo.readTree((await repo.readCommit(c1)).treeHash);
  const logo = root.find((e) => e.name === "logo.bin");
  assert.deepEqual([...await bytes(await repo.readBlob(logo.hash))], [0, 1, 2, 255]);
  assert.equal(await repo.readBlob(root.find((e) => e.name === "bin").hash), null, "a tree is no blob");
  assert.equal(await repo.readBlob("0".repeat(40)), null);
  assert.equal(await code(repo.readBlob("../x")), "INVALID_INPUT");

  const file = await repo.readFile({ ref: "main", path: "src/a.txt" });
  assert.equal(await file.text(), "one\nTWO\nTHREE\n");
  assert.equal(file.type, "text/plain");
  assert.equal(await (await repo.readFile({ ref: "t/1", path: "side.txt" })).text(), "side\n");
  assert.equal((await repo.readFile({ ref: c1, path: "README.md" })).type, "text/markdown");
  assert.equal(await repo.readFile({ ref: "main", path: "nope.txt" }), null);
  assert.equal(await repo.readFile({ ref: "main", path: "src" }), null, "a directory is no file");
  assert.equal(await repo.readFile({ ref: "nope", path: "src/a.txt" }), null);
  // A missing path with spaces, whose echo looks like a header, answers
  // null and leaves the reader answering.
  assert.equal(await repo.readFile({ ref: "main", path: "absent blob 123" }), null);
  assert.equal(await (await repo.readFile({ ref: "main", path: "src/a.txt" })).text(), "one\nTWO\nTHREE\n");
  assert.equal(await code(repo.readFile({ ref: "", path: "x" })), "INVALID_INPUT");
});

test("many reads at once are answered in order, and an empty repository has no history", async () => {
  using repo = await artifacts.get("base");
  const log = await repo.log();
  const commits = await Promise.all([...log, ...log].map((c) => repo.readCommit(c.hash)));
  assert.deepEqual(commits.map((c) => c.hash), [...log, ...log].map((c) => c.hash));
  using empty = await artifacts.get("empty");
  assert.deepEqual(await empty.log(), []);
});

test("a name no project owns is NOT_FOUND; the write side refuses", async () => {
  assert.equal(await code(artifacts.get("base--t12")), "NOT_FOUND", "a fork");
  assert.equal(await code(artifacts.get("nothing")), "NOT_FOUND");
  assert.equal(await code(artifacts.get("../base")), "NOT_FOUND");
  for (const call of [() => artifacts.create("x"), () => artifacts.delete("base"), async () => { using r = await artifacts.get("base"); await r.createToken(); }, async () => { using r = await artifacts.get("base"); await r.fork("y"); }]) {
    await assert.rejects(call(), /not_supported/);
  }
});

test("closing the binding ends its readers", async () => {
  const own = new LocalArtifacts({ reposDir });
  const repo = await own.get("base");
  assert.equal((await repo.log({ limit: 1 }))[0].hash, c5);
  own.close();
  await assert.rejects(repo.readCommit(c5), /disposed/);
  assert.equal(await code(own.get("base")), "INTERNAL_ERROR");
});

// ── the modules that read ──────────────────────────────────────────────────

test("diff.ts: itemDiff, measureWorkspace and changedPaths from the repositories", async () => {
  const { itemDiff, measureWorkspace, changedPaths, repoReader, mergedDiff } = await import("../src/diff.ts");
  const diff = await itemDiff(artifacts, "base", "work");
  assert.equal(diff.base, c5);
  assert.equal(diff.head, t2);
  assert.equal(diff.truncated, false);
  const status = Object.fromEntries(diff.files.map((f) => [f.path, f.status]));
  assert.deepEqual(status, {
    ".env": "added", "README.md": "added", "README.txt": "deleted", "new.txt": "added", "side.txt": "deleted", "src/a.txt": "modified",
    "docs/x.md": "added",
  });

  const m = await measureWorkspace(artifacts, "base", "work");
  assert.equal(m.head, t2);
  assert.equal(m.main, c5);
  assert.deepEqual(m.changedPaths, [".env", "README.md", "README.txt", "docs/x.md", "new.txt", "side.txt", "src/a.txt"]);
  assert.deepEqual(await measureWorkspace(artifacts, "base", "empty"), { head: null, main: null, changedPaths: null });
  assert.equal(await itemDiff(artifacts, "base", "empty"), null);

  using repo = await artifacts.get("base");
  const trees = await Promise.all([c1, c2].map(async (h) => (await repo.readCommit(h)).treeHash));
  assert.deepEqual(await changedPaths(repoReader(repo), trees[0], trees[1]), ["docs/x.md", "src/a.txt"]);

  const merged = await mergedDiff(artifacts, "base", null, { commit: c5, head: s1, base: c1, onPlanBranch: false });
  assert.equal(merged.base, c4);
  assert.deepEqual(merged.files.map((f) => f.path), ["side.txt"]);
});

test("preview/merge.ts: previewAgainstMain counts the commits main moved and finds the merge clean", async () => {
  const { previewAgainstMain } = await import("../src/preview/merge.ts");
  const p = await previewAgainstMain(artifacts, "base", "work");
  assert.equal(p.head, c5);
  assert.equal(p.ahead, 3, "c3, c4 and the merge, on main's first-parent line");
  assert.equal(p.aheadCapped, false);
  assert.equal(p.merge.clean, true, JSON.stringify(p.merge.conflicts));
  assert.deepEqual(p.merge.both, ["src/a.txt"]);
  assert.equal(await previewAgainstMain(artifacts, "base", "empty"), null);
});

test("browse/repo.ts: the log, a commit's changes, a directory and a path's history", async () => {
  const { repoSource, resolve, logPage, commitChanges, walk, pathHistory, lastChanges } = await import("../src/browse/repo.ts");
  using repo = await artifacts.get("base");
  const s = repoSource(repo);
  const head = await resolve(s, null);
  assert.equal(head.hash, c5);
  assert.equal((await resolve(s, "t/1")).hash, s1);
  assert.equal(await resolve(s, "nope"), null);

  const page = await logPage(s, "main", 0);
  assert.deepEqual(page.commits.map((c) => c.hash), [c5, c4, c3, c2, c1]);
  assert.equal(page.more, false);

  const changes = await commitChanges(s, c2);
  assert.deepEqual(changes.files.map((f) => [f.path, f.status]), [["docs/x.md", "added"], ["src/a.txt", "modified"]]);
  assert.equal(changes.parent, c1);
  const first = await commitChanges(s, c1);
  assert.equal(first.parent, null);
  assert.ok(first.files.every((f) => f.status === "added" || f.status === "submodule" || f.status === "binary"), JSON.stringify(first.files.map((f) => [f.path, f.status])));
  assert.equal(await commitChanges(s, "0".repeat(40)), null);

  const dir = await walk(s, head.treeHash, ["src"]);
  assert.equal(dir.kind, "tree");
  assert.deepEqual(dir.entries.map((e) => e.name), ["a.txt"]);
  const file = await walk(s, head.treeHash, ["src", "a.txt"]);
  assert.equal(file.kind, "blob");

  const history = await pathHistory(s, "main", ["src", "a.txt"]);
  assert.deepEqual(history.commits.map((c) => c.hash), [c4, c2, c1]);
  assert.equal(history.complete, true);
  const touched = await lastChanges(s, "main", []);
  assert.equal(touched.by.get("src").hash, c4);
  assert.equal(touched.by.get("README.txt").hash, c3);
});

test("import/history.ts: readImported reads the log through the reader", async () => {
  const { readImported } = await import("../src/import/history.ts");
  using repo = await artifacts.get("base");
  const h = await readImported(repo, null);
  assert.equal(h.complete, true);
  assert.equal(h.total, 5);
  assert.equal(h.attributed, 1);
  assert.deepEqual(h.lanes.map((l) => [l.names[0] ?? l.label, l.count]), [["Claude Opus 4.7", 1], ["No agent named", 4]]);
  const small = await readImported(repo, null, 2);
  assert.equal(small.complete, false);
});

test("retention.ts: readRetention reads a merge of main into an approved head", async () => {
  const { readRetention } = await import("../src/retention.ts");
  const { retentionVerdict } = await import("../src/rules.ts");
  using fork = await artifacts.get("merged");
  using baseline = await artifacts.get("base");
  const who = { resolver: null, outsiders: false };

  const overlap = await readRetention(fork, baseline, t1, n1);
  assert.ok(!("unread" in overlap), overlap.unread);
  assert.deepEqual(overlap.parents, [t1, c4]);
  assert.equal(overlap.main, c4);
  assert.equal(overlap.base, c2);
  assert.deepEqual(overlap.task, ["new.txt", "src/a.txt"]);
  assert.deepEqual(overlap.incoming, ["README.md", "README.txt", "docs/x.md", "src/a.txt"]);
  const verdict = retentionVerdict(overlap, who);
  assert.equal(verdict.retain, false);
  assert.match(verdict.why, /src\/a\.txt/);

  const disjoint = await readRetention(fork, baseline, u1, n2);
  assert.ok(!("unread" in disjoint), disjoint.unread);
  assert.deepEqual(disjoint.task, ["other.txt"]);
  assert.equal(retentionVerdict(disjoint, who).retain, true, retentionVerdict(disjoint, who).why);

  const wrong = await readRetention(fork, baseline, t1, c5);
  assert.ok("unread" in wrong, "a head the fork does not hold is unread, not guessed");
});

test("plans/integrate.ts: verifyIntegration and mergeBaseFor on the log the reader gives", async () => {
  const { verifyIntegration, mergeBaseFor } = await import("../src/plans/integrate.ts");
  using repo = await artifacts.get("base");
  const log = await repo.log({ limit: 100 });
  assert.deepEqual(verifyIntegration({ log, integrationHead: c4, partHead: s1, mergeCommit: c5 }), []);
  assert.match(verifyIntegration({ log, integrationHead: c3, partHead: s1, mergeCommit: c5 }).join(), /first parent/);
  assert.match(verifyIntegration({ log, integrationHead: c3, partHead: c2, mergeCommit: c4 }).join(), /parent/);
  assert.match(verifyIntegration({ log, integrationHead: c4, partHead: s1, mergeCommit: "1".repeat(40) }).join(), /not in the plan branch's log/);
  const held = new Set(log.map((c) => c.hash));
  assert.equal(mergeBaseFor(held.has(c1), c4, c2, held.has(c4)), c2, "the top is held, so the part's own fork point");
  assert.equal(mergeBaseFor(false, c4, c2, held.has(c4)), c4);
});

test("secret-scan.ts: scanCommit reads the task's commits from the fork and main's from the baseline", async () => {
  const { scanCommit } = await import("../src/secret-scan.ts");
  const scan = await scanCommit(artifacts, "base", "work", t2, null);
  assert.equal(scan.head, t2);
  assert.equal(scan.base, c5);
  assert.deepEqual(scan.hits.map((h) => h.file ?? h.path), [".env"]);
  assert.deepEqual(scan.unscanned, []);
  assert.ok(!JSON.stringify(scan).includes(SECRET), "the secret itself is never carried");
  const clean = await scanCommit(artifacts, "base", "work", t1, null);
  assert.deepEqual(clean.hits, []);
  await assert.rejects(scanCommit(artifacts, "base", "work", c5, null), /did not show/);
});

// ── the server and LARGE ───────────────────────────────────────────────────

test("the server's ARTIFACTS reads the bare repositories under its repos directory", async () => {
  const root = scratchDir("server");
  const server = await startServer({ env: "test", dataDir: join(root, "data"), reposDir, host: "127.0.0.1" });
  try {
    using repo = await server.settings.ARTIFACTS.get("base");
    assert.equal((await repo.log({ limit: 1 }))[0].hash, c5);
    await assert.rejects(server.settings.ARTIFACTS.create("x"), /not_supported/);
  } finally { await server.close(); }
});

test("LARGE keeps a value in a file of mode 600 and reads it back", async () => {
  const dir = join(scratchDir("large"), "large");
  const large = new LocalLarge(dir);
  const key = "logs/PROJ/t1/" + "a".repeat(64);
  const stored = await large.put(key, "héllo\nworld\n", { customMetadata: { sha256: "x" } });
  assert.equal(stored.size, Buffer.byteLength("héllo\nworld\n"));
  const held = await large.get(key);
  assert.equal(await held.text(), "héllo\nworld\n");
  assert.equal(held.size, stored.size);
  assert.equal(await large.get("logs/PROJ/t1/" + "b".repeat(64)), null);
  const file = join(dir, "logs", "PROJ", "t1", "a".repeat(64));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "logs")).mode & 0o777, 0o700);
  await large.put(key, "again");
  assert.equal(await (await large.get(key)).text(), "again");
  assert.deepEqual(readdirSync(join(dir, "logs", "PROJ", "t1")), ["a".repeat(64)], "no temporary file is left");
  await large.put("logs/../../out", "x");
  assert.equal(await (await large.get("logs/../../out")).text(), "x");
  assert.deepEqual(readdirSync(dirname(dir)), ["large"], "a key cannot name a file outside the store");
  await assert.rejects(large.put("logs//x", "x"), /not a stored key/);
});

test("src/large.ts stores and reads a payload through LARGE", async () => {
  const { putLarge, getLarge } = await import("../src/large.ts");
  const large = new LocalLarge(join(scratchDir("large2"), "large"));
  const ref = await putLarge(large, "diffs", "atl", "t7", "the diff\n");
  assert.equal(ref.bytes, 9);
  assert.equal(await getLarge(large, ref.key), "the diff\n");
  assert.equal(await getLarge(large, ref.key + "0"), null);
});

test("an object over the read limit fails with MEMORY_LIMIT and leaves the reader answering", async () => {
  const { openReader, OBJECT_MAX } = await import("../src/git/reader.mjs");
  const dir = join(scratchDir("big"), "big.git");
  git(tmpdir(), ["init", "--bare", "-q", dir]);
  const big = git(dir, ["hash-object", "-w", "--stdin"], Buffer.alloc(OBJECT_MAX + 1));
  const small = git(dir, ["hash-object", "-w", "--stdin"], "small\n");
  const repo = openReader(dir);
  try {
    await assert.rejects(repo.readBlob(big), (e) => e.code === "MEMORY_LIMIT");
    assert.equal(await (await repo.readBlob(small)).text(), "small\n");
  } finally { repo[Symbol.dispose](); }
});
