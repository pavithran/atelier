import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesOf, changedRegions, commitsSince, linesConflict, linesOf, mergeLines, mergePatch, mergeTrees, mergeability, mergedTreeRefusal, overlaps, previewAgainstMain } from "../src/preview/merge.ts";
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

// Artifacts as the binding presents it: a first-parent log newest first,
// trees and blobs. `merged` names a merge commit's further parents.
function artifactsOf(repos: Record<string, { log: string[]; trees: Record<string, Record<string, string>>; merged?: Record<string, string[]> }>) {
  return {
    get: async (name: string) => {
      const r = repos[name];
      const reader = repo(r.trees);
      return {
        log: async () => r.log.map((h, i) => ({ hash: h, treeHash: h, parents: [...(r.log[i + 1] ? [r.log[i + 1]] : []), ...(r.merged?.[h] ?? [])] })),
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
  const p = await previewAgainstMain(A, "main", "fork");
  assert.equal(p?.ahead, 2);
  assert.equal(p?.aheadCapped, false);
  assert.deepEqual(p?.merge.conflicts, [{ path: "a.ts", reason: "both sides changed the same lines" }]);
  assert.equal(p?.merge.ours, 2);
});

test("the preview says main has not moved when its head is the fork point, and gives none when the fork point is not on main", async () => {
  const trees = { base: { "a.ts": "1\n" }, task: { "a.ts": "2\n" }, m1: { "b.ts": "b\n" } };
  const still = await previewAgainstMain(artifactsOf({ main: { log: ["base"], trees }, fork: { log: ["task", "base"], trees } }), "main", "fork");
  assert.deepEqual([still?.ahead, still?.merge.clean], [0, true]);
  const gone = await previewAgainstMain(artifactsOf({ main: { log: ["m1"], trees }, fork: { log: ["task", "base"], trees } }), "main", "fork");
  assert.equal(gone, null, "a fork point not on a fully read main gives no preview");
});

// t230: a task that merged main holds main's head as the merge's second
// parent, while its first-parent line runs back to where it forked. The
// preview works from the main commit it merged, so main has not moved.
test("the preview of a task that merged main's head says main has not moved since", async () => {
  const trees = { base: { "a.ts": "1\n" }, m1: { "a.ts": "1\n", "b.ts": "b\n" }, task: { "a.ts": "2\n" }, merge: { "a.ts": "2\n", "b.ts": "b\n" } };
  const p = await previewAgainstMain(artifactsOf({ main: { log: ["m1", "base"], trees }, fork: { log: ["merge", "task", "base"], trees, merged: { merge: ["m1"] } } }), "main", "fork");
  assert.deepEqual([p?.ahead, p?.merge.clean, p?.merge.ours], [0, true, 0]);
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
    ["deletions of two adjacent lines", "ABCD", "ACD", "ABD", true],
  ];
  for (const [name, base, ours, theirs, git] of cases) assert.equal(linesConflict(L(base), L(ours), L(theirs)), git, name);
});

test("main's moves are counted along its first-parent line, a merge once, as Artifacts lists it", () => {
  // Artifacts' log is main's first-parent line: M merged a task of five commits into C.
  const log = [{ hash: "M", parents: ["C", "T5"] }, { hash: "C", parents: ["B"] }, { hash: "B", parents: ["A"] }, { hash: "A", parents: [] }];
  assert.deepEqual(commitsSince(log, "B", false), { ahead: 2, capped: false });
  assert.deepEqual(commitsSince(log, "M", false), { ahead: 0, capped: false });
  assert.deepEqual(commitsSince(log.slice(0, 2), "B", true), { ahead: 2, capped: true }, "a cut log without the fork point is a floor");
  assert.deepEqual(commitsSince(log, "Z", false), { ahead: null, capped: false });
});

// Run through git merge on 2026-10-05; the expected answer is git's.
test("a change to the final newline alone is a change to the last line, as in git", () => {
  const b = (t: string) => new TextEncoder().encode(t);
  const conflict = (base: string, ours: string, theirs: string) => linesConflict(linesOf(b(base)), linesOf(b(ours)), linesOf(b(theirs)));
  assert.equal(conflict("a\n", "a", "A\n"), true, "dropping the final newline and editing that line conflict");
  assert.equal(conflict("a\nb\n", "a\nb", "a\nb"), false, "the same change on both sides merges");
  assert.equal(conflict("a\nb\nc\n", "a\nb\nc", "A\nb\nc\n"), false, "an edit away from the end merges");
});

test("a file on one side where the other side has a folder is a conflict, as in git", async () => {
  const blob = (t: string) => ({ hash: id(t), mode: "100644", type: "blob" });
  const trees: Record<string, { name: string; mode: string; hash: string; type: string }[]> = {
    empty: [],
    ours: [{ name: "foo", ...blob("x\n") }],
    dir: [{ name: "bar", ...blob("y\n") }],
    theirs: [{ name: "foo", hash: "dir", mode: "40000", type: "tree" }],
  };
  const r: Reader = { tree: async (h) => trees[h] ?? null, blob: async () => new TextEncoder().encode("x\n") };
  const m = await mergeability(r, r, "empty", "ours", "theirs");
  assert.equal(m.clean, false);
  assert.deepEqual(m.conflicts, [{ path: "foo", reason: "a file on one side and a folder on the other" }]);
  // Main replaces the folder foo/ with a file foo; the task only deletes foo/bar. Git merges this.
  const r2: Reader = { tree: async (h) => ({ base: [{ name: "foo", hash: "dir", mode: "40000", type: "tree" }], dir: trees.dir, ours: trees.ours, gone: [] } as Record<string, typeof trees.ours>)[h] ?? null, blob: async () => new TextEncoder().encode("x\n") };
  const replaced = await mergeability(r2, r2, "base", "ours", "gone");
  assert.equal(replaced.clean, true, "a deleted path leaves nothing to collide with");
});

// The merged tree for a check in the sandbox: git's result where the
// preview's conflict rule finds none, and no tree where it finds one.
test("mergeLines applies both sides' changes to separate lines, a shared change once, and refuses a conflict", () => {
  const L = (s: string) => s.split("");
  assert.deepEqual(mergeLines(L("12345"), L("O2345"), L("1234F")), L("O234F"));
  assert.deepEqual(mergeLines(L("123"), L("1x23"), L("12y3")), L("1x2y3"), "insertions at different places");
  assert.deepEqual(mergeLines(L("123"), L("1x23"), L("1x23")), L("1x23"), "the same change on both sides, taken once");
  assert.deepEqual(mergeLines(L("1234"), L("134"), L("1234x")), L("134x"), "a deletion and an append");
  assert.deepEqual(mergeLines(L("12"), L("12"), L("T2")), L("T2"), "one side unchanged");
  assert.equal(mergeLines(L("12345"), L("O2345"), L("1T345")), null, "adjacent edits conflict, as in git");
  assert.equal(mergeLines(L("1234"), L("134"), L("12T4")), null, "a deletion next to an edit conflicts");
});

test("bytesOf writes linesOf's lines back, keeping a missing final newline", () => {
  for (const text of ["a\nb\n", "a\nb", "", "\n", "a"]) assert.equal(new TextDecoder().decode(bytesOf(linesOf(new TextEncoder().encode(text)))), text);
});

test("mergePatch lays main's changes over the head: main's files where the task left them, merged lines where both changed, nothing where they agree", async () => {
  const base = { "a.ts": "1\n2\n3\n4\n5\n", "b.ts": "b\n", "c.ts": "c\n", "same.ts": "s\n", "gone.ts": "g\n" };
  const main = repo({ base, ours: { "a.ts": "ONE\n2\n3\n4\n5\n", "b.ts": "B\n", "c.ts": "c\n", "same.ts": "S\n", "new.ts": "n\n" } });
  const task = repo({ base, theirs: { "a.ts": "1\n2\n3\n4\nFIVE\n", "b.ts": "b\n", "c.ts": "C\n", "same.ts": "S\n", "gone.ts": "g\n", "t.ts": "t\n" } });
  const { patch, conflicts } = await mergePatch(main, task, "base", "ours", "theirs");
  assert.deepEqual(conflicts, []);
  assert.deepEqual([...patch.keys()].sort(), ["a.ts", "b.ts", "gone.ts", "new.ts"], "c.ts and t.ts are the task's alone, and same.ts changed alike");
  assert.equal(new TextDecoder().decode(patch.get("a.ts")!.data), "ONE\n2\n3\n4\nFIVE\n");
  assert.deepEqual(patch.get("b.ts"), { type: "blob", hash: id("B\n") });
  assert.equal(patch.get("gone.ts"), null, "deleted on main");
  assert.deepEqual(patch.get("new.ts"), { type: "blob", hash: id("n\n") });
  // Main unchanged since the fork point: nothing to lay over.
  assert.equal((await mergePatch(main, task, "base", "base", "theirs")).patch.size, 0);
});

test("mergePatch gives the preview's conflicts and no tree", async () => {
  const main = repo({ base: { "a.ts": "1\n2\n" }, ours: { "a.ts": "1\nX\n", "n.ts": "main\n" } });
  const task = repo({ base: { "a.ts": "1\n2\n" }, theirs: { "a.ts": "1\nY\n" } });
  const { patch, conflicts } = await mergePatch(main, task, "base", "ours", "theirs");
  assert.equal(patch.size, 0);
  assert.deepEqual(conflicts, [{ path: "a.ts", reason: "both sides changed the same lines" }]);
});

test("mergeTrees reads the fork point, main's head and the task's head as the preview does", async () => {
  const trees = { base: { "a.ts": "1\n" }, m1: { "a.ts": "2\n" }, task: { "a.ts": "1\nt\n" }, x: {} };
  const A = artifactsOf({ main: { log: ["m1", "base"], trees }, fork: { log: ["task", "base"], trees }, apart: { log: ["x"], trees } });
  assert.deepEqual(await mergeTrees(await A.get("main"), await A.get("fork")), { base: "base", baseTree: "base", main: "m1", mainTree: "m1", head: "task", headTree: "task" });
  assert.equal(await mergeTrees(await A.get("main"), await A.get("apart")), null, "no fork point");
});

// Trees with folders, for the merge declarations (t463): each label's files
// by path, its folders named LABEL:FOLDER.
function nested(trees: Record<string, Record<string, string>>): Reader {
  const blobs = new Map<string, Uint8Array>();
  const nodes = new Map<string, { name: string; mode: string; hash: string; type: string }[]>();
  for (const [label, files] of Object.entries(trees)) {
    const at = (dir: string) => (dir ? `${label}:${dir}` : label);
    nodes.set(label, []);
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split("/");
      for (let i = 0; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/"), entries = nodes.get(at(dir)) ?? [];
        nodes.set(at(dir), entries);
        if (i === parts.length - 1) { blobs.set(id(text), enc(text)); entries.push({ name: parts[i], mode: "100644", hash: id(text), type: "blob" }); }
        else if (!entries.some((e) => e.name === parts[i])) { entries.push({ name: parts[i], mode: "40000", hash: at(parts.slice(0, i + 1).join("/")), type: "tree" }); nodes.set(at(parts.slice(0, i + 1).join("/")), nodes.get(at(parts.slice(0, i + 1).join("/"))) ?? []); }
      }
    }
  }
  return { tree: async (h) => nodes.get(h) ?? null, blob: async (h) => blobs.get(h) ?? null };
}
const MANIFEST = JSON.stringify({
  version: 1,
  generators: [{ name: "indexes", command: ["node", "gen.mjs"], inputs: ["cmds/**"], outputs: ["out/index.txt"] }],
  records: [{ path: "routes.tsv", key: "^(\\S+)\\t" }],
});
const declaring = (files: Record<string, string>) => ({ "bin/merge-manifest.json": MANIFEST, ...files });

test("the preview reads the merge declarations: a generated output both sides changed is regenerable, not a conflict, and record files unite by key (t463)", async () => {
  const base = declaring({ "out/index.txt": "base\n", "routes.tsv": "/a\tA\n", "cmds/base.txt": "b\n" });
  const both = nested({ base, ours: { ...base, "out/index.txt": "base\nmain\n", "routes.tsv": "/a\tA\n/main\tM\n", "cmds/main.txt": "m\n" }, theirs: { ...base, "out/index.txt": "base\ntask\n", "routes.tsv": "/a\tA\n/task\tT\n", "cmds/task.txt": "t\n" } });
  const m = await mergeability(both, both, "base", "ours", "theirs");
  assert.deepEqual(m.conflicts, []);
  assert.equal(m.clean, true);
  assert.deepEqual(m.regenerable, ["out/index.txt"]);
  assert.deepEqual(m.generators, ["indexes"]);
  // Without the manifest the same changes are two conflicts on the same lines.
  const strip = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([p]) => p !== "bin/merge-manifest.json"));
  const plain = nested({ base: strip(base), ours: strip({ ...base, "out/index.txt": "base\nmain\n", "routes.tsv": "/a\tA\n/main\tM\n" }), theirs: strip({ ...base, "out/index.txt": "base\ntask\n", "routes.tsv": "/a\tA\n/task\tT\n" }) });
  assert.deepEqual((await mergeability(plain, plain, "base", "ours", "theirs")).conflicts.map((c) => c.path), ["out/index.txt", "routes.tsv"]);
  // A generator whose inputs both sides changed regenerates its outputs even where one side alone changed them.
  const inputs = nested({ base, ours: { ...base, "cmds/main.txt": "m\n", "out/index.txt": "base\nmain\n" }, theirs: { ...base, "cmds/task.txt": "t\n" } });
  assert.deepEqual((await mergeability(inputs, inputs, "base", "ours", "theirs")).regenerable, ["out/index.txt"]);
});

test("the preview keeps a record key both sides changed differently, and a misdeclared manifest, as conflicts (t463)", async () => {
  const base = declaring({ "routes.tsv": "/a\tA\n" });
  const r = nested({ base, ours: { ...base, "routes.tsv": "/a\tA\n/x\tMAIN\n" }, theirs: { ...base, "routes.tsv": "/a\tA\n/x\tTASK\n" } });
  const m = await mergeability(r, r, "base", "ours", "theirs");
  assert.deepEqual(m.conflicts, [{ path: "routes.tsv", reason: "records both sides changed differently: /x: added by both sides with different records" }]);
  const bad = nested({ base, ours: { ...base, "x.txt": "m\n" }, theirs: { ...base, "bin/merge-manifest.json": "{" } });
  assert.match((await mergeability(bad, bad, "base", "ours", "theirs")).conflicts[0]?.reason ?? "", /bin\/merge-manifest\.json is not valid JSON/);
});

test("the sandbox's merged tree unites records by key, and a merge needing a generator gives no tree but names the local merged check (t463)", async () => {
  const base = declaring({ "out/index.txt": "base\n", "routes.tsv": "/a\tA\n", "cmds/base.txt": "b\n" });
  const records = nested({ base, ours: { ...base, "routes.tsv": "/a\tA\n/main\tM\n" }, theirs: { ...base, "routes.tsv": "/a\tA\n/task\tT\n" } });
  const merged = await mergePatch(records, records, "base", "ours", "theirs");
  assert.deepEqual(merged.conflicts, []);
  assert.equal(new TextDecoder().decode(merged.patch.get("routes.tsv")!.data), "/a\tA\n/main\tM\n/task\tT\n");
  assert.equal(mergedTreeRefusal(merged, "f".repeat(40)), null);
  const gen = nested({ base, ours: { ...base, "cmds/main.txt": "m\n", "out/index.txt": "base\nmain\n" }, theirs: { ...base, "cmds/task.txt": "t\n", "out/index.txt": "base\ntask\n" } });
  const refused = await mergePatch(gen, gen, "base", "ours", "theirs");
  assert.equal(refused.patch.size, 0);
  assert.deepEqual(refused.regenerable, ["out/index.txt"]);
  assert.equal(mergedTreeRefusal(refused, "f".repeat(40)), "the merge with main at ffffffff needs indexes to regenerate out/index.txt (declared in bin/merge-manifest.json), and no generator runs in the sandbox; check the merge with atelier check --merged without --sandbox, which merges through the merge pipeline and regenerates them, or bring main into the workspace with atelier update and check its head");
  assert.match(mergedTreeRefusal({ conflicts: [{ path: "a.ts", reason: "both sides changed the same lines" }] }, "f".repeat(40)) ?? "", /stops on conflicts: a\.ts \(both sides changed the same lines\)/);
});

test("merged registry validation rejects independent duplicate keys in preview and sandbox (t463)", async () => {
  const manifest = JSON.stringify({ version: 1, registries: [{ name: "commands", dir: "cmds", key: "^key: (.+)$", files: "*.txt", exclude: ["index.txt"] }] });
  const base = { "bin/merge-manifest.json": manifest, "cmds/base.txt": "key: base\n" };
  const ours = { ...base, "cmds/main.txt": "key: same\n", "cmds/index.txt": "ignored\n", "cmds/readme.md": "ignored\n" };
  for (const key of ["same", "unique"]) {
    const r = nested({ base, ours, theirs: { ...base, "cmds/task.txt": `key: ${key}\n` } });
    const preview = await mergeability(r, r, "base", "ours", "theirs");
    const merged = await mergePatch(r, r, "base", "ours", "theirs");
    assert.equal(preview.clean, key === "unique");
    assert.deepEqual(merged.conflicts, preview.conflicts);
    if (key === "same") {
      assert.match(preview.conflicts[0].reason, /registry key same is declared by both cmds\/main.txt and cmds\/task.txt/);
      assert.equal(merged.patch.size, 0);
    }
  }
  // A deletion must not leave a phantom duplicate in the combined listing.
  const r = nested({ base, ours: { ...base, "cmds/new.txt": "key: base\n" }, theirs: { "bin/merge-manifest.json": manifest } });
  assert.equal((await mergeability(r, r, "base", "ours", "theirs")).clean, true);
});

test("preview and sandbox both select record declarations introduced only by the task (t463)", async () => {
  const base = { "bin/merge-manifest.json": JSON.stringify({ version: 1 }), "routes.tsv": "/base\tB\n" };
  const r = nested({
    base,
    ours: { ...base, "routes.tsv": "/base\tB\n/main\tM\n" },
    theirs: { ...base, "bin/merge-manifest.json": JSON.stringify({ version: 1, records: [{ path: "routes.tsv", key: "^(\\S+)\\t" }] }), "routes.tsv": "/base\tB\n/task\tT\n" },
  });
  assert.equal((await mergeability(r, r, "base", "ours", "theirs")).clean, true);
  const merged = await mergePatch(r, r, "base", "ours", "theirs");
  assert.deepEqual(merged.conflicts, []);
  assert.equal(new TextDecoder().decode(merged.patch.get("routes.tsv")!.data), "/base\tB\n/main\tM\n/task\tT\n");
});
