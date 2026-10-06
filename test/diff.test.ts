import { test } from "node:test";
import assert from "node:assert/strict";
import { againstMain, changedPaths, diffLines, itemDiff, measureWorkspace, mergeBase, pairReader, repoReader, splitLines, toHunks, treeDiff, type Entry, type Reader } from "../src/diff.ts";

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

test("a diff stays within its memory budget, and says so when it cannot", () => {
  const added = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
  const ops = diffLines([], added)!;
  assert.equal(ops.length, 50_000, "an added file needs no search");
  assert.ok(ops.every((o) => o.op === "+"));
  const kept = diffLines(["a", ...added, "z"], ["a", "z"])!;
  assert.equal(kept.filter((o) => o.op === "-").length, 50_000, "common ends are set aside first");
  const left = Array.from({ length: 6_000 }, (_, i) => `l${i}`), right = Array.from({ length: 6_000 }, (_, i) => `r${i}`);
  assert.equal(diffLines(left, right), null, "two unrelated large files exceed the budget");
  assert.ok(diffLines(left.slice(0, 50), right.slice(0, 50)), "small unrelated files are still diffed");
});

test("empty subdirectories never hide a later change, in a diff or in the protected-path list", async () => {
  // 61 added empty directories, then a changed file: the file must still be found.
  const trees: Record<string, { name: string; mode: string; hash: string; type: string }[]> = {
    base: [{ name: "z.txt", mode: "100644", hash: "1".repeat(40), type: "blob" }],
    head: [
      ...Array.from({ length: 61 }, (_, i) => ({ name: `a${String(i).padStart(2, "0")}`, mode: "40000", hash: "e".repeat(40), type: "tree" })),
      { name: "z.txt", mode: "100644", hash: "2".repeat(40), type: "blob" },
    ],
    ["e".repeat(40)]: [],
  };
  const r = { tree: async (h: string) => trees[h] ?? null, blob: async () => new TextEncoder().encode("x\n") };
  const { files } = await treeDiff(r, "base", "head");
  assert.deepEqual(files.map((f) => f.path), ["z.txt"]);
  assert.deepEqual(await changedPaths(r, "base", "head"), ["z.txt"]);
});

// Two repositories as the Artifacts binding presents them: a first-parent log
// newest first, flat trees named by a label, and blobs named by their text.
// Each repository answers only for the objects it holds, as a fork that has
// not taken main's newer commits does not hold their trees.
type Commit = { hash: string; treeHash: string; parents: string[] };
function artifactsOf(repos: Record<string, { log: Commit[]; trees: Record<string, Record<string, string>> }>) {
  return {
    get: async (name: string) => {
      const r = repos[name];
      const texts = new Set(Object.values(r.trees).flatMap((t) => Object.values(t)));
      return {
        log: async (opts?: { limit?: number }) => r.log.slice(0, opts?.limit ?? 50),
        readCommit: async (h: string) => r.log.find((c) => c.hash === h) ?? null,
        readTree: async (h: string) => r.trees[h] ? Object.entries(r.trees[h]).map(([name, text]) => ({ name, mode: "100644", hash: `blob:${text}`, type: "blob" })) : null,
        readBlob: async (h: string) => h.startsWith("blob:") && texts.has(h.slice(5)) ? new Blob([h.slice(5)]) : null,
        [Symbol.dispose]() {},
      };
    },
  } as unknown as Artifacts;
}

test("a merge that makes an older main commit the fork point cannot hide a reverted protected file", async () => {
  // Main moved from old (AGENTS.md v1) to new (AGENTS.md v2). The agent's work
  // sits on new, and the head M is a merge whose first parent is old and whose
  // tree is the work's with AGENTS.md put back to v1. M's first-parent log is
  // [M, old], so the first-parent fork point is old, and old to M never
  // touches AGENTS.md; git would merge M into new with new as the base and
  // land v1. Against main's head the revert is a change like any other.
  const v1 = "rules v1\n", v2 = "rules v2\n";
  const old = { "AGENTS.md": v1, "a.ts": "a\n" };
  const A = artifactsOf({
    main: { log: [{ hash: "new", treeHash: "new", parents: ["old"] }, { hash: "old", treeHash: "old", parents: [] }], trees: { old, new: { "AGENTS.md": v2, "a.ts": "a\n" } } },
    fork: { log: [{ hash: "M", treeHash: "M", parents: ["old", "W"] }, { hash: "old", treeHash: "old", parents: [] }], trees: { old, M: { "AGENTS.md": v1, "a.ts": "a2\n" } } },
  });
  const diff = await itemDiff(A, "main", "fork");
  assert.equal(diff?.base, "new", "the diff is against main's head");
  assert.deepEqual(diff?.files.map((f) => [f.path, f.status]), [["AGENTS.md", "modified"], ["a.ts", "modified"]]);
  assert.deepEqual(diff?.files[0].hunks[0].lines, [{ op: "-", text: "rules v2" }, { op: "+", text: "rules v1" }]);
  // What the sandbox runner records: the same list, read across both repositories.
  const fork = await A.get("fork"), main = await A.get("main");
  const m = await againstMain(fork, main);
  assert.deepEqual(m, { main: "new", mainTree: "new", head: "M", headTree: "M" });
  assert.equal(await fork.readTree("new"), null, "the fork never holds main's newer tree");
  assert.deepEqual(await changedPaths(pairReader(fork, main), m!.mainTree, m!.headTree), ["AGENTS.md", "a.ts"]);
  // What the evidence route records, by the same measure.
  assert.deepEqual(await measureWorkspace(A, "main", "fork"), { head: "M", main: "new", changedPaths: ["AGENTS.md", "a.ts"] });
  // The first-parent fork point is the one the agent built, and lists only a.ts.
  const base = mergeBase((await fork.log({ limit: 500 })).map((c) => c.hash), (await main.log({ limit: 1000 })).map((c) => c.hash));
  assert.equal(base, "old");
  assert.deepEqual(await changedPaths(repoReader(fork), "old", "M"), ["a.ts"]);
});

test("a workspace behind main lists main's newer changes until it takes them; one that has them lists its own work", async () => {
  const v1 = "rules v1\n", v2 = "rules v2\n";
  const old = { "AGENTS.md": v1, "a.ts": "a\n" }, fresh = { "AGENTS.md": v2, "a.ts": "a\n" };
  const main = { log: [{ hash: "new", treeHash: "new", parents: ["old"] }, { hash: "old", treeHash: "old", parents: [] }], trees: { old, new: fresh } };
  const behind = artifactsOf({ main, fork: { log: [{ hash: "W", treeHash: "W", parents: ["old"] }, { hash: "old", treeHash: "old", parents: [] }], trees: { old, W: { "AGENTS.md": v1, "a.ts": "a2\n" } } } });
  assert.deepEqual((await itemDiff(behind, "main", "fork"))?.files.map((f) => f.path), ["AGENTS.md", "a.ts"]);
  const updated = artifactsOf({ main, fork: { log: [{ hash: "W", treeHash: "W", parents: ["new"] }, { hash: "new", treeHash: "new", parents: ["old"] }, { hash: "old", treeHash: "old", parents: [] }], trees: { old, new: fresh, W: { "AGENTS.md": v2, "a.ts": "a2\n" } } } });
  assert.deepEqual((await itemDiff(updated, "main", "fork"))?.files.map((f) => f.path), ["a.ts"]);
  // A workspace holding main's tree exactly has no changes, and an empty repository no measure.
  const same = artifactsOf({ main, fork: { log: [{ hash: "new", treeHash: "new", parents: ["old"] }], trees: { new: fresh } } });
  assert.deepEqual(await itemDiff(same, "main", "fork"), { base: "new", head: "new", files: [], truncated: false, baseTree: "new", headTree: "new" });
  assert.equal(await itemDiff(artifactsOf({ main, fork: { log: [], trees: {} } }), "main", "fork"), null);
});
