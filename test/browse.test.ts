import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPath, commitChanges, logPage, pathHistory, resolve, viewFile, walk, type Commit, type Source } from "../src/browse/repo.ts";

// A tiny repository: three commits on one line.
//   c1: README.md "one", src/a.ts "a1"
//   c2: src/a.ts "a2"            (README unchanged)
//   c3: README.md "three"        (src unchanged)
const h = (s: string) => s.padEnd(40, "0");
const text = (s: string) => new TextEncoder().encode(s);
const blobs: Record<string, Uint8Array> = { [h("b1")]: text("one\n"), [h("b2")]: text("a1\n"), [h("b3")]: text("a2\n"), [h("b4")]: text("three\n") };
const trees: Record<string, { name: string; mode: string; hash: string; type: string }[]> = {
  [h("s1")]: [{ name: "a.ts", mode: "100644", hash: h("b2"), type: "blob" }],
  [h("s2")]: [{ name: "a.ts", mode: "100644", hash: h("b3"), type: "blob" }],
  [h("r1")]: [{ name: "README.md", mode: "100644", hash: h("b1"), type: "blob" }, { name: "src", mode: "40000", hash: h("s1"), type: "tree" }],
  [h("r2")]: [{ name: "README.md", mode: "100644", hash: h("b1"), type: "blob" }, { name: "src", mode: "40000", hash: h("s2"), type: "tree" }],
  [h("r3")]: [{ name: "src", mode: "40000", hash: h("s2"), type: "tree" }, { name: "README.md", mode: "100644", hash: h("b4"), type: "blob" },
    { name: "run.sh", mode: "100755", hash: h("b4"), type: "exec" }, { name: "docs", mode: "120000", hash: h("b1"), type: "symlink" }, { name: "vendor", mode: "160000", hash: h("c1"), type: "gitlink" }],
};
const c = (id: string, tree: string, parent: string | null, msg: string, t: number): Commit =>
  ({ hash: h(id), treeHash: h(tree), message: msg, author: { name: "A", email: "a@example.com" }, parents: parent ? [h(parent)] : [], authoredAt: t });
const commits = [c("c3", "r3", "c2", "Third", 3), c("c2", "r2", "c1", "Second\n\nBody", 2), c("c1", "r1", null, "First", 1)];
let treeReads = 0;
const source: Source = {
  tree: async (x) => { treeReads++; return trees[x] ?? null; },
  blob: async (x) => blobs[x] ?? null,
  log: async ({ ref = "HEAD", limit = 50, offset = 0 }) => {
    const start = ref === "HEAD" ? 0 : commits.findIndex((k) => k.hash === ref);
    return start < 0 ? [] : commits.slice(start + offset, start + offset + limit);
  },
  commit: async (x) => commits.find((k) => k.hash === x) ?? null,
  file: async (x, limit) => { const b = blobs[x]; return !b ? null : b.length > limit ? { size: b.length } : b; },
};

test("a path from a URL means exactly one path", () => {
  assert.deepEqual(cleanPath(["src", "", "a.ts"]), ["src", "a.ts"]);
  assert.equal(cleanPath(["..", "etc"]), null);
  assert.equal(cleanPath(["src", "."]), null);
  assert.deepEqual(cleanPath([]), []);
});

test("walking finds directories, sorted dirs first, and files, and nothing else", async () => {
  const root = await walk(source, h("r3"), []);
  assert.equal(root?.kind, "tree");
  assert.deepEqual(root?.kind === "tree" && root.entries.map((e) => e.name), ["src", "docs", "README.md", "run.sh", "vendor"]);
  assert.equal((await walk(source, h("r3"), ["run.sh"]))?.kind, "blob", "an executable file is a file");
  assert.deepEqual(await walk(source, h("r3"), ["docs"]), { kind: "blob", hash: h("b1"), mode: "120000", type: "symlink" });
  assert.equal((await walk(source, h("r3"), ["vendor"]))?.kind, "other", "a submodule has no content here");
  assert.deepEqual(await walk(source, h("r3"), ["src", "a.ts"]), { kind: "blob", hash: h("b3"), mode: "100644", type: "blob" });
  assert.equal(await walk(source, h("r3"), ["missing"]), null);
  assert.equal(await walk(source, h("r3"), ["README.md", "x"]), null, "a file has no children");
});

test("a file is shown as text, or said to be binary or too large", () => {
  assert.deepEqual(viewFile(text("a\nb\n")), { kind: "text", lines: ["a", "b"], bytes: 4 });
  assert.equal(viewFile(new Uint8Array([1, 0, 2])).kind, "binary");
  assert.equal(viewFile(new Uint8Array(600 * 1024)).kind, "too-large");
  assert.deepEqual(viewFile({ size: 9e6 }), { kind: "too-large", bytes: 9e6 }, "a file over the limit is reported from its size alone");
});

test("a ref resolves to its commit, and the log pages", async () => {
  assert.equal((await resolve(source, "HEAD"))?.hash, h("c3"));
  assert.equal(await resolve(source, h("zz")), null);
  const first = await logPage(source, "HEAD", 0);
  assert.equal(first.commits.length, 3);
  assert.equal(first.more, false);
});

test("a commit's changes are against its first parent; the first commit adds everything", async () => {
  const two = await commitChanges(source, h("c2"));
  assert.deepEqual(two?.files.map((f) => [f.path, f.status, f.added, f.removed]), [["src/a.ts", "modified", 1, 1]]);
  const one = await commitChanges(source, h("c1"));
  assert.deepEqual(one?.files.map((f) => [f.path, f.status]).sort(), [["README.md", "added"], ["src/a.ts", "added"]]);
  assert.equal(one?.parent, null);
  assert.equal(await commitChanges(source, h("nope")), null);
  // A parent that cannot be read is reported, not diffed against nothing.
  const orphan = { ...source, commit: async (x: string) => (x === h("c2") ? commits[1] : null) };
  assert.deepEqual(await commitChanges(orphan, h("c2")), { commit: commits[1], parent: h("c1"), files: [], truncated: false, parentMissing: true });
});

test("a change of mode alone is a change in a path's history", async () => {
  const one = (mode: string, type: string) => [{ name: "run", mode, hash: h("b4"), type }];
  const t2: Record<string, ReturnType<typeof one>> = { [h("m1")]: one("100644", "blob"), [h("m2")]: one("100755", "exec"), [h("m3")]: one("120000", "symlink") };
  const line = [c("k3", "m3", "k2", "Linked", 3), c("k2", "m2", "k1", "Made executable", 2), c("k1", "m1", null, "Added", 1)];
  const src: Source = { ...source, tree: async (x) => t2[x] ?? null, log: async ({ limit = 50 }) => line.slice(0, limit) };
  assert.deepEqual((await pathHistory(src, "HEAD", ["run"])).commits.map((k) => k.message), ["Linked", "Made executable", "Added"]);
});

test("a path's history is the commits that changed it, reading each tree once", async () => {
  treeReads = 0;
  const readme = await pathHistory(source, "HEAD", ["README.md"]);
  assert.deepEqual(readme.commits.map((k) => k.message.split("\n")[0]), ["Third", "First"]);
  assert.equal(treeReads, 3, "one read per distinct root tree, and none for the file");
  treeReads = 0;
  await pathHistory(source, "HEAD", ["src", "a.ts"]);
  assert.equal(treeReads, 5, "three roots, and src only where its hash differs (s2 twice, s1 once: two reads)");
  assert.equal(readme.complete, true);
  const a = await pathHistory(source, "HEAD", ["src", "a.ts"]);
  assert.deepEqual(a.commits.map((k) => k.message.split("\n")[0]), ["Second", "First"]);
  const capped = await pathHistory(source, "HEAD", ["README.md"], 2);
  assert.equal(capped.complete, false);
  assert.deepEqual(capped.commits.map((k) => k.message.split("\n")[0]), ["Third"], "beyond the window, an unchanged path is not counted");
  // The oldest commit in the window is decided against the one beyond it.
  assert.deepEqual((await pathHistory(source, "HEAD", ["src", "a.ts"], 2)).commits.map((k) => k.message.split("\n")[0]), ["Second"]);
  assert.deepEqual((await pathHistory(source, "HEAD", ["src", "a.ts"], 1)).commits, []);
});

test("a submodule's change is listed, and a log cut short decides nothing at its edge", async () => {
  const sub = (to: string) => [{ name: "vendor", mode: "160000", hash: h(to), type: "gitlink" }];
  const t3: Record<string, ReturnType<typeof sub>> = { [h("g1")]: sub("p1"), [h("g2")]: sub("p2") };
  const line = [c("s2", "g2", "s1", "Bump submodule", 2), c("s1", "g1", null, "Add submodule", 1)];
  const src: Source = { ...source, tree: async (x) => t3[x] ?? null, commit: async (x) => line.find((k) => k.hash === x) ?? null };
  const bump = await commitChanges(src, h("s2"));
  assert.deepEqual(bump?.files.map((f) => [f.path, f.status]), [["vendor", "submodule"]]);
  // Only s2 is readable: its parent s1 is missing from the log, so s2 is not claimed as the change.
  const cut: Source = { ...src, log: async () => [line[0]] };
  const history = await pathHistory(cut, "HEAD", ["vendor"]);
  assert.equal(history.complete, false);
  assert.deepEqual(history.commits, []);
});

test("a path's history stops within its read budget and says it is incomplete", async () => {
  treeReads = 0;
  const capped = await pathHistory(source, "HEAD", ["src", "a.ts"], 100, 2);
  assert.ok(treeReads <= 2, `read ${treeReads} trees`);
  assert.equal(capped.complete, false);
  // Within the two reads, c3's and c2's roots were read; src s2 was not, so nothing can be decided.
  assert.deepEqual(capped.commits, []);
  const full = await pathHistory(source, "HEAD", ["src", "a.ts"], 100, 100);
  assert.deepEqual(full.commits.map((k) => k.message.split("\n")[0]), ["Second", "First"]);
});

test("browsing refuses paths beyond its depth, and diffs stop within their read budget", async () => {
  assert.equal(cleanPath(Array.from({ length: 65 }, (_, i) => `d${i}`)), null);
  assert.equal(cleanPath(Array.from({ length: 64 }, (_, i) => `d${i}`))?.length, 64);
  // A chain of 50 nested directories down to one added file.
  const deep: Record<string, { name: string; mode: string; hash: string; type: string }[]> = {};
  for (let i = 0; i < 50; i++) deep[h(`n${i}`)] = [{ name: `d${i}`, mode: "40000", hash: h(`n${i + 1}`), type: "tree" }];
  deep[h("n50")] = [{ name: "leaf.txt", mode: "100644", hash: h("b1"), type: "blob" }];
  let reads = 0;
  const r = { tree: async (x: string) => { reads++; return x === h("e0") ? [] : deep[x] ?? null; }, blob: async () => text("one\n") };
  const { treeDiff } = await import("../src/diff.ts");
  const capped = await treeDiff(r, h("e0"), h("n0"), { files: 60, blobBytes: 1 << 18, diffLines: 20000, treeReads: 20, context: 3 });
  assert.equal(capped.truncated, true);
  assert.ok(reads <= 21, `read ${reads} trees`);
  const whole = await treeDiff(r, h("e0"), h("n0"));
  assert.equal(whole.files.length, 1);
  // History out of budget at once examines nothing, and says so.
  const none = await pathHistory(source, "HEAD", ["src", "a.ts"], 100, 1);
  assert.deepEqual([none.examined, none.complete, none.commits.length], [0, false, 0]);
});
