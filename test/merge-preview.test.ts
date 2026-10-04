import { test } from "node:test";
import assert from "node:assert/strict";
import { changedRegions, linesConflict, mergeability, overlaps } from "../src/preview/merge.ts";
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
  assert.deepEqual(changedRegions(["a", "b", "c"], ["a", "B", "c"]), [[1, 2]]);
  assert.deepEqual(changedRegions(["a", "b"], ["a", "x", "b"]), [[1, 1]], "an insertion is an empty region at its place");
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
