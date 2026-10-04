import { test } from "node:test";
import assert from "node:assert/strict";
import { changedPaths, diffLines, mergeBase, splitLines, toHunks, treeDiff, type Entry, type Reader } from "../src/diff.ts";

const replay = (ops: { op: string; text: string }[]) => ({
  a: ops.filter((o) => o.op !== "+").map((o) => o.text),
  b: ops.filter((o) => o.op !== "-").map((o) => o.text),
});

test("an edit script replays to both sides, for random inputs", () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: rand(12) }, () => "abcd"[rand(4)]);
    const b = Array.from({ length: rand(12) }, () => "abcd"[rand(4)]);
    const ops = diffLines(a, b);
    assert.deepEqual(replay(ops), { a, b }, `a=${a} b=${b}`);
  }
});

test("the edit script is minimal on a known case", () => {
  // Myers' own example: ABCABBA → CBABAC needs 5 edits.
  const ops = diffLines([..."ABCABBA"], [..."CBABAC"]);
  assert.equal(ops.filter((o) => o.op !== " ").length, 5);
  assert.deepEqual(diffLines([], []), []);
  assert.deepEqual(diffLines(["x"], ["x"]), [{ op: " ", text: "x" }]);
});

test("hunks carry unified-diff line numbers and three lines of context", () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const b = [...a];
  b[4] = "changed 5";
  b.splice(15, 1);
  const hunks = toHunks(diffLines(a, b));
  assert.equal(hunks.length, 2);
  assert.deepEqual([hunks[0].oldStart, hunks[0].oldLines, hunks[0].newStart, hunks[0].newLines], [2, 7, 2, 7]);
  assert.deepEqual([hunks[1].oldStart, hunks[1].oldLines, hunks[1].newStart, hunks[1].newLines], [13, 7, 13, 6]);
  assert.deepEqual(hunks[0].lines.map((l) => l.op).join(""), "   -+   ");
});

test("changes closer than twice the context share one hunk", () => {
  const a = Array.from({ length: 12 }, (_, i) => `${i}`);
  const b = [...a];
  b[2] = "x";
  b[7] = "y";
  assert.equal(toHunks(diffLines(a, b)).length, 1);
});

test("a new or emptied file numbers its empty side from zero, as git does", () => {
  const [added] = toHunks(diffLines([], ["a", "b"]));
  assert.deepEqual([added.oldStart, added.oldLines, added.newStart, added.newLines], [0, 0, 1, 2]);
  const [emptied] = toHunks(diffLines(["a"], []));
  assert.deepEqual([emptied.oldStart, emptied.oldLines, emptied.newStart, emptied.newLines], [1, 1, 0, 0]);
});

test("splitLines ignores one trailing newline", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
});

test("the merge base is the newest workspace commit the baseline has", () => {
  assert.equal(mergeBase(["w3", "w2", "b2", "b1"], ["b3", "b2", "b1"]), "b2");
  // After `atelier update` the workspace sits on top of the newer baseline.
  assert.equal(mergeBase(["w3", "b3", "b2", "b1"], ["b3", "b2", "b1"]), "b3");
  assert.equal(mergeBase(["w1"], ["b1"]), null);
});

// A tiny content-addressed store standing in for an Artifacts repo.
function store() {
  const trees = new Map<string, Entry[]>();
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  const blob = (text: string | Uint8Array) => {
    const h = `blob${n++}`;
    blobs.set(h, typeof text === "string" ? new TextEncoder().encode(text) : text);
    return h;
  };
  const tree = (entries: Record<string, { blob?: string; tree?: string; mode?: string }>) => {
    const h = `tree${n++}`;
    trees.set(h, Object.entries(entries).map(([name, e]) => ({
      name, mode: e.mode ?? (e.tree ? "40000" : "100644"), hash: (e.tree ?? e.blob)!, type: e.tree ? "tree" : "blob",
    })));
    return h;
  };
  const reader: Reader = { tree: async (h) => trees.get(h) ?? null, blob: async (h) => blobs.get(h) ?? null };
  return { blob, tree, reader };
}

test("tree diff reports added, deleted, modified, mode-only and binary files, descending only into changed trees", async () => {
  const s = store();
  const same = s.blob("unchanged\n");
  const lib = s.tree({ "keep.ts": { blob: same } });
  const base = s.tree({
    "README.md": { blob: s.blob("one\ntwo\nthree\n") },
    "old.txt": { blob: s.blob("bye\n") },
    "run.sh": { blob: same },
    "img.png": { blob: s.blob(new Uint8Array([137, 80, 0, 1])) },
    lib: { tree: lib },
  });
  const head = s.tree({
    "README.md": { blob: s.blob("one\n2\nthree\n") },
    "run.sh": { blob: same, mode: "100755" },
    "img.png": { blob: s.blob(new Uint8Array([137, 80, 0, 2])) },
    lib: { tree: lib },
    src: { tree: s.tree({ "new.ts": { blob: s.blob("export {}\n") } }) },
  });
  let treesRead = 0;
  const reader: Reader = { ...s.reader, tree: async (h) => { treesRead++; return s.reader.tree(h); } };
  const { files, truncated } = await treeDiff(reader, base, head);
  assert.equal(truncated, false);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.added, f.removed]), [
    ["README.md", "modified", 1, 1],
    ["img.png", "binary", 0, 0],
    ["old.txt", "deleted", 0, 1],
    ["run.sh", "mode", 0, 0],
    ["src/new.ts", "added", 1, 0],
  ]);
  assert.equal(treesRead, 3, "the unchanged lib/ tree is never opened");
});

test("tree diff stops at the file limit and says so", async () => {
  const s = store();
  const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, { blob: s.blob(`${i}\n`) }]));
  const { files, truncated } = await treeDiff(s.reader, s.tree({}), s.tree(many), { files: 3, blobBytes: 1e6, diffLines: 1e6, context: 3 });
  assert.equal(files.length, 3);
  assert.equal(truncated, true);
});

test("oversized files are listed but not diffed", async () => {
  const s = store();
  const { files } = await treeDiff(s.reader, s.tree({}), s.tree({ big: { blob: s.blob("x".repeat(100)) } }), { files: 10, blobBytes: 50, diffLines: 1e6, context: 3 });
  assert.deepEqual(files.map((f) => f.status), ["too-large"]);
});

test("changedPaths lists every change, past the display limit", async () => {
  const s = store();
  const many = Object.fromEntries(Array.from({ length: 75 }, (_, i) => [`f${String(i).padStart(2, "0")}`, { blob: s.blob(`${i}\n`) }]));
  const paths = await changedPaths(s.reader, s.tree({}), s.tree({ ...many, deep: { tree: s.tree({ "x.ts": { blob: s.blob("x") } }) } }));
  assert.equal(paths.length, 76);
  assert.ok(paths.includes("deep/x.ts"));
  await assert.rejects(changedPaths(s.reader, s.tree({}), s.tree(many), 10), /more than 10 changed paths/);
});
