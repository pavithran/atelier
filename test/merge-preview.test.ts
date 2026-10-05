import { test } from "node:test";
import assert from "node:assert/strict";
import { changedRegions, commitsSince, linesConflict, mergeability, overlaps, previewAgainstMain } from "../src/preview/merge.ts";
import type { Reader } from "../src/diff.ts";

// A content-addressed toy: files are named by their text, trees by a label.
const enc = (s: string) => new TextEncoder().encode(s);
const id = (s: string) => Array.from(s).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(40, "0");
function repo(trees: Record<string, Record<string, string>>): Reader {
  const blobs = new Map<string, Uint8Array>();
  const nodes = new Map<string, { name: string; mode: string; hash: string; type: string }[]>();
  for (const [name, files] of Object.entries(trees)) {
    nodes.set(name, Object.entries(files).map(([path, text]) => {
      blobs.set(id(text), enc(text));
      return { name: path, mode: "100644", hash: id(text), type: "blob" };
    }));
  }
  return { tree: async (h) => nodes.get(h) ?? null, blob: async (h) => blobs.get(h) ?? null };
}

test("a side's changes are regions of the base's lines", () => {
  assert.deepEqual(changedRegions(["a", "b", "c"], ["a", "B", "c"]), [[1, 2, ["B"]]]);
  assert.deepEqual(changedRegions(["a", "b"], ["a", "x", "b"]), [[1, 1, ["x"]]], "an insertion is an empty region at its place");
  assert.deepEqual(changedRegions(["a"], ["a"]), []);
});

test("changes to separate lines merge; changes to the same or touching lines conflict", () => {
  const base = ["1", "2", "3", "4", "5"];
  assert.equal(linesConflict(base, ["ONE", "2", "3", "4", "5"], ["1", "2", "3", "4", "FIVE"]), false);
  assert.equal(linesConflict(base, ["1", "TWO", "3", "4", "5"], ["1", "2b", "3", "4", "5"]), true);
  assert.equal(linesConflict(base, ["1", "TWO", "3", "4", "5"], ["1", "2", "THREE", "4", "5"]), true, "adjacent lines conflict, as in git");
});

test("a task merges cleanly when main changed other files, or other lines", async () => {
  const main = repo({
    base: { "a.ts": "1\n2\n3\n4\n5\n", "b.ts": "b\n" },
    ours: { "a.ts": "ONE\n2\n3\n4\n5\n", "b.ts": "B\n" },
  });
  const task = repo({
    base: { "a.ts": "1\n2\n3\n4\n5\n", "b.ts": "b\n" },
    theirs: { "a.ts": "1\n2\n3\n4\nFIVE\n", "b.ts": "b\n", "c.ts": "new\n" },
  });
  const m = await mergeability(main, task, "base", "ours", "theirs");
  assert.equal(m.clean, true);
  assert.deepEqual(m.both, ["a.ts"]);
  assert.equal(m.ours, 2);
  assert.equal(m.theirs, 2);
});

test("conflicts name the path and why", async () => {
  const main = repo({ base: { "a.ts": "1\n2\n", "d.ts": "d\n" }, ours: { "a.ts": "1\nX\n", "n.ts": "main\n" } });
  const task = repo({ base: { "a.ts": "1\n2\n", "d.ts": "d\n" }, theirs: { "a.ts": "1\nY\n", "d.ts": "D\n", "n.ts": "task\n" } });
  const m = await mergeability(main, task, "base", "ours", "theirs");
  assert.equal(m.clean, false);
  assert.deepEqual(m.conflicts, [
    { path: "a.ts", reason: "both sides changed the same lines" },
    { path: "d.ts", reason: "deleted on main, changed by the task" },
    { path: "n.ts", reason: "added on both sides with different contents" },
  ]);
});

test("the same change on both sides is not a conflict; main unchanged since the fork is clean", async () => {
  const main = repo({ base: { "a.ts": "1\n" }, ours: { "a.ts": "2\n" } });
  const task = repo({ base: { "a.ts": "1\n" }, theirs: { "a.ts": "2\n" } });
  assert.equal((await mergeability(main, task, "base", "ours", "theirs")).clean, true);
  const still = await mergeability(repo({ base: { "a.ts": "1\n" } }), task, "base", "base", "theirs");
  assert.deepEqual([still.clean, still.ours, still.both], [true, 0, []]);
});

test("live tasks touching the same paths are paired, with the paths", () => {
  assert.deepEqual(overlaps([
    { id: "t1", paths: ["src/a.ts", "src/b.ts"] },
    { id: "t2", paths: ["src/c.ts"] },
    { id: "t3", paths: ["src/b.ts", "src/a.ts"] },
  ]), [{ a: "t1", b: "t3", paths: ["src/a.ts", "src/b.ts"] }]);
});

// Artifacts as the binding presents it: a log newest first, trees and blobs.
function artifactsOf(repos: Record<string, { log: string[]; trees: Record<string, Record<string, string>> }>) {
  return {
    get: async (name: string) => {
      const r = repos[name];
      const reader = repo(r.trees);
      return {
        log: async () => r.log.map((h, i) => ({ hash: h, treeHash: h, parents: r.log[i + 1] ? [r.log[i + 1]] : [] })),
        readTree: (h: string) => reader.tree(h),
        readBlob: async (h: string) => { const b = await reader.blob(h); return b ? new Blob([b]) : null; },
        [Symbol.dispose]() {},
      };
    },
  } as unknown as Artifacts;
}

test("the preview against main counts main's new commits and finds a conflict", async () => {
  const trees = { base: { "a.ts": "1\n2\n3\n" }, m1: { "a.ts": "1\nTWO\n3\n" }, m2: { "a.ts": "1\nTWO\n3\n", "n.ts": "n\n" }, task: { "a.ts": "1\n2b\n3\n" } };
  const A = artifactsOf({ main: { log: ["m2", "m1", "base"], trees }, fork: { log: ["task", "base"], trees } });
  const p = await previewAgainstMain(A, "main", "fork", "base", "base", "task");
  assert.equal(p?.ahead, 2);
  assert.equal(p?.aheadCapped, false);
  assert.deepEqual(p?.merge.conflicts, [{ path: "a.ts", reason: "both sides changed the same lines" }]);
  assert.equal(p?.merge.ours, 2);
});

test("the preview says main has not moved when its head is the fork point, and gives none when the fork point is not on main", async () => {
  const trees = { base: { "a.ts": "1\n" }, task: { "a.ts": "2\n" }, m1: { "b.ts": "b\n" } };
  const still = await previewAgainstMain(artifactsOf({ main: { log: ["base"], trees }, fork: { log: ["task", "base"], trees } }), "main", "fork", "base", "base", "task");
  assert.deepEqual([still?.ahead, still?.merge.clean], [0, true]);
  const gone = await previewAgainstMain(artifactsOf({ main: { log: ["m1"], trees }, fork: { log: ["task", "base"], trees } }), "main", "fork", "base", "base", "task");
  assert.equal(gone, null, "a fork point not on a fully read main gives no preview");
});

// Each case was run through git merge on 2026-10-04 and 2026-10-05; the expected answer is git's.
test("the conflict rule agrees with git's merge on edits, insertions and deletions", () => {
  const L = (s: string) => s.split("");
  const cases: [string, string, string, string, boolean][] = [
    ["adjacent edits", "12345", "O2345", "1T345", true],
    ["edits one line apart", "12345", "O2345", "12T45", false],
    ["different insertions at one place", "123", "1x23", "1y23", true],
    ["the same insertion on both sides", "123", "1x23", "1x23", false],
    ["an insertion next to an edit", "1234", "1x234", "12T4", false],
    ["a deletion next to an edit", "1234", "134", "12T4", true],
    ["different appends", "12", "12x", "12y", true],
    ["edits to the first and last of two lines", "12", "O2", "1T", true],
    ["an insertion right before an edited line", "1234", "12x34", "12T4", true],
    ["an insertion right after an edited line", "1234", "123x4", "12T4", true],
    ["an insertion at the top and an edit of the first line", "123", "x123", "O23", true],
  ];
  for (const [name, base, ours, theirs, git] of cases) assert.equal(linesConflict(L(base), L(ours), L(theirs)), git, name);
});

test("main's new commits are those the fork point cannot reach, merged side branches included", () => {
  // main: M (merge of S into C), S (side, forked from A), C, B (the fork point), A.
  // An older side commit S sits after B in this order; git rev-list B..M counts M, S, C.
  const log = [
    { hash: "M", parents: ["C", "S"] }, { hash: "C", parents: ["B"] }, { hash: "B", parents: ["A"] },
    { hash: "S", parents: ["A"] }, { hash: "A", parents: [] },
  ];
  assert.deepEqual(commitsSince(log, "B", false), { ahead: 3, capped: false });
  assert.deepEqual(commitsSince(log, "M", false), { ahead: 0, capped: false });
  assert.deepEqual(commitsSince(log.slice(0, 2), "B", true), { ahead: 2, capped: true }, "a cut log without the fork point is a floor");
  assert.deepEqual(commitsSince(log, "Z", false), { ahead: null, capped: false });
});
