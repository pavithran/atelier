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
  [h("r3")]: [{ name: "src", mode: "40000", hash: h("s2"), type: "tree" }, { name: "README.md", mode: "100644", hash: h("b4"), type: "blob" }],
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
  assert.deepEqual(root?.kind === "tree" && root.entries.map((e) => e.name), ["src", "README.md"]);
  assert.deepEqual(await walk(source, h("r3"), ["src", "a.ts"]), { kind: "blob", hash: h("b3"), mode: "100644" });
  assert.equal(await walk(source, h("r3"), ["missing"]), null);
  assert.equal(await walk(source, h("r3"), ["README.md", "x"]), null, "a file has no children");
});

test("a file is shown as text, or said to be binary or too large", () => {
  assert.deepEqual(viewFile(text("a\nb\n")), { kind: "text", lines: ["a", "b"], bytes: 4 });
  assert.equal(viewFile(new Uint8Array([1, 0, 2])).kind, "binary");
  assert.equal(viewFile(new Uint8Array(600 * 1024)).kind, "too-large");
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
});

test("a path's history is the commits that changed it, reading each tree once", async () => {
  treeReads = 0;
  const readme = await pathHistory(source, "HEAD", ["README.md"]);
  assert.deepEqual(readme.commits.map((k) => k.message.split("\n")[0]), ["Third", "First"]);
  assert.equal(readme.complete, true);
  const a = await pathHistory(source, "HEAD", ["src", "a.ts"]);
  assert.deepEqual(a.commits.map((k) => k.message.split("\n")[0]), ["Second", "First"]);
  const capped = await pathHistory(source, "HEAD", ["README.md"], 2);
  assert.equal(capped.complete, false);
  assert.deepEqual(capped.commits.map((k) => k.message.split("\n")[0]), ["Third"], "beyond the window, an unchanged path is not counted");
});
